#Requires -Version 5.1
<#
.SYNOPSIS
    リポジトリの状態を検査する。コミット前・パッケージング前に実行する。

.DESCRIPTION
    1. app\ 配下の全 .ps1 を PowerShell 標準Parserで構文検査
    2. .ps1 が UTF-8 BOM 付きであることを確認（PS5.1 の日本語処理のため）
    3. 必須ファイルの存在確認
    4. 実行時生成物・利用者固有設定が混入していないことを確認
    5. 既存の静的チェック（CopilotClient.ps1 の offsetParent 再導入禁止）
    6. Node.js があれば Test-WsOnlyFinding.mjs を実行

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\Verify-Repo.ps1
#>
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDir   = Join-Path $RepoRoot 'app'
$InnerApp = Join-Path $AppDir '_app'

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Add-Failure([string]$Message) { $failures.Add($Message) }
function Add-Warning([string]$Message) { $warnings.Add($Message) }
function Write-Section([string]$Name) { Write-Host ('== ' + $Name) -ForegroundColor Cyan }

& (Join-Path $PSScriptRoot 'Assert-AppVersion.ps1') -RepoRoot $RepoRoot

# --- 1. PowerShell 構文検査 ---
Write-Section 'PowerShell 構文検査'
$ps1Files = @(Get-ChildItem -LiteralPath $AppDir -Filter '*.ps1' -File -Recurse | Sort-Object FullName)
foreach ($file in $ps1Files) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    foreach ($parseError in @($errors)) {
        Add-Failure ('構文エラー {0}:{1} {2}' -f $file.Name, $parseError.Extent.StartLineNumber, $parseError.Message)
    }
}
Write-Host ('  検査対象: {0} ファイル' -f $ps1Files.Count)

# --- 2. UTF-8 BOM 検査 ---
Write-Section 'UTF-8 BOM 検査（.ps1）'
$noBom = @()
foreach ($file in $ps1Files) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
        $noBom += $file.FullName.Substring($RepoRoot.Length).TrimStart('\')
    }
}
if ($noBom.Count -gt 0) {
    foreach ($item in $noBom) { Add-Failure ('UTF-8 BOM がありません: ' + $item) }
} else {
    Write-Host ('  全 {0} ファイルに BOM あり' -f $ps1Files.Count)
}

# --- 3. 必須ファイル ---
Write-Section '必須ファイルの存在確認'
$required = @(
    'app\PDF校正アシスト起動.cmd',
    'app\PDF校正アシスト起動.vbs',
    'app\_app\Start-KoseiAssist.ps1',
    'app\_app\VERSION',
    'app\_app\index.html',
    'app\_app\README.txt',
    'app\_app\config\settings.template.json',
    'app\_app\src\Paths.ps1',
    'app\_app\src\Settings.ps1',
    'app\_app\src\CopilotClient.ps1',
    'app\_app\src\ReviewJob.ps1',
    'app\_app\src\Server.ps1',
    'app\_app\tools\Syntax-Check.ps1',
    'app\_app\pdfjs\build\pdf.min.mjs',
    'app\_app\pdfjs\build\pdf.worker.min.mjs',
    'app\_app\pdflib\pdf-lib.esm.min.js',
    '.gitignore',
    '.gitattributes'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rel))) { Add-Failure ('必須ファイルがありません: ' + $rel) }
}
Write-Host ('  確認: {0} 項目' -f $required.Count)

# --- 4. 混入禁止ファイル ---
Write-Section '混入禁止ファイルの確認'
$forbidden = @(
    'app\_app\local-app.pid',
    'app\_app\local-app.url',
    'app\_app\startup-log.txt',
    'app\_app\powershell-output.txt',
    'app\_app\config\settings.json',
    'app\_app\server.ps1',
    'app\_app\server.js'
)
foreach ($rel in $forbidden) {
    if (Test-Path -LiteralPath (Join-Path $RepoRoot $rel)) {
        Add-Failure ('配布物に含めてはいけないファイルがあります: ' + $rel + '（.gitignore を確認）')
    }
}
$strayChangelog = @(Get-ChildItem -LiteralPath $InnerApp -Filter 'CHANGELOG_*' -File -ErrorAction SilentlyContinue)
if ($strayChangelog.Count -gt 0) {
    Add-Warning ('_app 直下に CHANGELOG_* が {0} 件あります。docs\changelog\ へ移動してください。' -f $strayChangelog.Count)
}
Write-Host ('  確認: {0} 項目' -f $forbidden.Count)

# --- 5. 既存の静的チェック ---
Write-Section '静的チェック'
$copilotClientPath = Join-Path (Join-Path $InnerApp 'src') 'CopilotClient.ps1'
if (Test-Path -LiteralPath $copilotClientPath) {
    $copilotClient = [System.IO.File]::ReadAllText($copilotClientPath, [System.Text.Encoding]::UTF8)
    if ($copilotClient -match 'offsetParent') {
        Add-Failure 'CopilotClient.ps1: offsetParent の再導入を検出しました。rect + computedStyle 判定を使用してください。'
    } else {
        Write-Host '  offsetParent の再導入なし'
    }
}

# --- 6. Node.js 単体テスト（あれば） ---
Write-Section 'JavaScript 単体テスト'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$wsTest = Join-Path (Join-Path $InnerApp 'tools') 'Test-WsOnlyFinding.mjs'
if ($nodeCmd -and (Test-Path -LiteralPath $wsTest -PathType Leaf)) {
    & node $wsTest
    if ($LASTEXITCODE -ne 0) { Add-Failure 'Test-WsOnlyFinding.mjs が失敗しました。' }
} else {
    Write-Host '  Node.js が無いため省略しました'
}

# --- 結果 ---
Write-Host ''
foreach ($item in $warnings) { Write-Host ('WARN: ' + $item) -ForegroundColor Yellow }
if ($failures.Count -gt 0) {
    Write-Host ('Verify-Repo: FAIL ({0} 件)' -f $failures.Count) -ForegroundColor Red
    $failures | ForEach-Object { Write-Host ('  - ' + $_) -ForegroundColor Red }
    exit 1
}
Write-Host 'Verify-Repo: PASS' -ForegroundColor Green
exit 0
