#Requires -Version 5.1
<#
.SYNOPSIS
    配布ZIPを生成する。

.DESCRIPTION
    app\ の内容を「PDF校正ツール」というルートフォルダ名でZIP化し、dist\ へ出力する。
    ファイル名は UTF-8 で書き、ZIPの汎用目的ビット11（言語エンコーディングフラグ）を
    立てるため、日本語Windowsのエクスプローラーで正しく展開できる。

    エクスプローラーの「圧縮フォルダー」や、フラグを立てない自作zip処理を使うと
    「PDF校正アシスト起動.vbs」が文字化けして展開され、起動できなくなる。
    配布ZIPは必ずこのスクリプトで作る。

.PARAMETER Version
    ZIPファイル名に入れるバージョン文字列（例: v95）。既定は v94。

.PARAMETER SkipVerify
    tools\Verify-Repo.ps1 の実行を省略する。通常は指定しない。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\Package-Release.ps1 -Version v95
#>
param(
    [string]$Version = 'v94',
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$RepoRoot    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDir      = Join-Path $RepoRoot 'app'
$DistDir     = Join-Path $RepoRoot 'dist'
$ReleaseName = 'PDF校正ツール'

# 配布物に含めないファイル名（実行時生成物・利用者固有設定）
$ExcludeNames = @(
    'local-app.pid',
    'local-app.url',
    'startup-log.txt',
    'powershell-output.txt',
    'settings.json',
    'Thumbs.db',
    'Desktop.ini',
    '.DS_Store'
)

function Write-Step([string]$Message) { Write-Host ('[package] ' + $Message) -ForegroundColor Cyan }
function Write-Fail([string]$Message) { Write-Host ('[package] ' + $Message) -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) {
    throw ('app ディレクトリが見つかりません: ' + $AppDir)
}

# --- 1. 事前検査 ---
if (-not $SkipVerify) {
    $verify = Join-Path (Join-Path $RepoRoot 'tools') 'Verify-Repo.ps1'
    if (Test-Path -LiteralPath $verify -PathType Leaf) {
        Write-Step '事前検査 (Verify-Repo.ps1) を実行します'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verify
        if ($LASTEXITCODE -ne 0) { throw '事前検査に失敗しました。ZIPは作成していません。' }
    } else {
        Write-Step 'Verify-Repo.ps1 が見つからないため事前検査を省略します'
    }
}

# --- 2. ステージング ---
$stampedName = '{0}_{1}_{2}' -f $ReleaseName, $Version, (Get-Date).ToString('yyyyMMdd-HHmm')
$stageRoot   = Join-Path ([System.IO.Path]::GetTempPath()) ('kosei-pkg-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stageApp    = Join-Path $stageRoot $ReleaseName
New-Item -ItemType Directory -Path $stageApp -Force | Out-Null

try {
    Write-Step ('ステージングへコピーします: ' + $stageApp)
    $sourceFiles = @(Get-ChildItem -LiteralPath $AppDir -Recurse -File)
    $copied = 0
    $skipped = 0
    foreach ($file in $sourceFiles) {
        if ($ExcludeNames -contains $file.Name) { $skipped++; continue }
        $relative = $file.FullName.Substring($AppDir.Length).TrimStart('\', '/')
        $target   = Join-Path $stageApp $relative
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $copied++
    }
    Write-Step ('コピー完了: {0} ファイル（除外 {1} 件）' -f $copied, $skipped)

    # --- 3. 必須ファイルの存在確認 ---
    $required = @(
        'PDF校正アシスト起動.vbs',
        '_app\Start-KoseiAssist.ps1',
        '_app\index.html',
        '_app\config\settings.template.json',
        '_app\src\Paths.ps1',
        '_app\src\Settings.ps1',
        '_app\src\CopilotClient.ps1',
        '_app\src\ReviewJob.ps1',
        '_app\src\Server.ps1',
        '_app\pdfjs\build\pdf.min.mjs',
        '_app\pdfjs\build\pdf.worker.min.mjs',
        '_app\pdflib\pdf-lib.esm.min.js'
    )
    $missing = @()
    foreach ($rel in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $stageApp $rel) -PathType Leaf)) { $missing += $rel }
    }
    if ($missing.Count -gt 0) {
        Write-Fail '必須ファイルが不足しています:'
        $missing | ForEach-Object { Write-Fail ('  - ' + $_) }
        throw 'パッケージングを中止しました。'
    }

    # --- 4. UTF-8ファイル名フラグ付きでZIP化 ---
    if (-not (Test-Path -LiteralPath $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }
    $zipPath = Join-Path $DistDir ($stampedName + '.zip')
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

    Write-Step ('ZIPを作成します: ' + $zipPath)
    # ZipFile.Open の第3引数に UTF8 を渡すことで、エントリ名を UTF-8 で書き、
    # 併せて汎用目的ビット11 を立てる。ここが CP932 誤読による文字化けの分岐点。
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create, [System.Text.Encoding]::UTF8)
    try {
        $entries = 0
        foreach ($file in @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File | Sort-Object FullName)) {
            $entryName = $file.FullName.Substring($stageRoot.Length).TrimStart('\', '/').Replace('\', '/')
            $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entries++
        }
    } finally {
        $zip.Dispose()
    }

    # --- 5. 検証: 再オープンしてエントリ数と日本語名を確認 ---
    $check = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Read, [System.Text.Encoding]::UTF8)
    try {
        $names = @($check.Entries | ForEach-Object { $_.FullName })
        $vbsEntry = @($names | Where-Object { $_ -like '*PDF校正アシスト起動.vbs' })
        if ($vbsEntry.Count -ne 1) { throw '起動VBSのエントリ名を検証できませんでした（文字化けの可能性）。' }
        Write-Step ('検証OK: {0} エントリ / 起動VBS = {1}' -f $names.Count, $vbsEntry[0])
    } finally {
        $check.Dispose()
    }

    $sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
    Write-Host ''
    Write-Host ('完成: {0}  ({1} MB)' -f $zipPath, $sizeMb) -ForegroundColor Green
    Write-Host '展開後、PDF校正アシスト起動.vbs をダブルクリックして起動を確認してください。' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}
