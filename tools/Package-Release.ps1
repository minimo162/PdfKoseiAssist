#Requires -Version 5.1
<#
.SYNOPSIS
    配布ZIPを生成する（-DeployTo を付けると、共有フォルダーへ直接配置する）。

.DESCRIPTION
    app\ の内容を「PDF校正ツール」というルートフォルダ名でZIP化し、dist\ へ出力する。
    _app\release-manifest.json（配布ファイルの一覧とハッシュ）を生成して同梱する。
    利用者の起動時に Launch-KoseiAssist.ps1 がこの一覧と照合してから手元へ写すので、
    共有フォルダーを利用中に上書きしても、写しかけの版で起動することはない。
    ファイル名は UTF-8 で書き、ZIPの汎用目的ビット11（言語エンコーディングフラグ）を
    立てるため、日本語Windowsのエクスプローラーで正しく展開できる。

    エクスプローラーの「圧縮フォルダー」や、フラグを立てない自作zip処理を使うと
    「PDF校正アシスト起動.cmd」が文字化けして展開され、起動できなくなる。
    配布ZIPは必ずこのスクリプトで作る。

.PARAMETER Version
    ZIPファイル名に入れるバージョン文字列（例: v95）。既定は _app/VERSION。

.PARAMETER SkipVerify
    tools\Verify-Repo.ps1 の実行を省略する。通常は指定しない。

.PARAMETER DeployTo
    配布先の共有フォルダー（例: \\fileserver\共有\PDF校正アシスト）。ZIPと同じ中身を上書きで配置する。
    release-manifest.json は最後に書くので、配置の途中で起動した利用者は前の版のまま動く。
    共有フォルダーの config\settings.json（管理者の設定）には触れない。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\Package-Release.ps1 -Version v95

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\Package-Release.ps1 -DeployTo \\fileserver\共有\PDF校正アシスト
#>
param(
    [string]$Version = '',
    [switch]$SkipVerify,
    [string]$OutputDirectory = '',
    [string]$DeployTo = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$RepoRoot    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDir      = Join-Path $RepoRoot 'app'
$DistDir     = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $RepoRoot 'dist' } else { [System.IO.Path]::GetFullPath($OutputDirectory) }
$ReleaseName = 'PDF校正ツール'

# 配布対象は実行に必要な相対パスだけを許可する。deny-list では、新しく置かれた
# 顧客PDF・実測raw・診断ログが名前違いでZIPへ入るため、必ずallow-listで判定する。
function Test-KoseiReleasePath {
    param([Parameter(Mandatory=$true)][string]$RelativePath)
    $p = $RelativePath.Replace('\', '/').TrimStart('/')
    if (@('PDF校正アシスト起動.cmd','PDF校正アシスト_初回セットアップ.cmd','はじめにお読みください.txt') -contains $p) { return $true }
    if (@('_app/VERSION','_app/Launch-KoseiAssist.ps1','_app/release-manifest.json','_app/Start-KoseiAssist.ps1','_app/Start-DropReview.ps1','_app/Setup-KoseiAssist.ps1','_app/index.html','_app/README.txt') -contains $p) { return $true }
    if (@('_app/config/settings.template.json','_app/config/runtime-html-policy.json') -contains $p) { return $true }
    if ($p -match '^_app/js/[^/]+\.mjs$') { return $true }
    if ($p -match '^_app/src/[^/]+\.ps1$') { return $true }
    if ($p -match '^_app/(?:pdfjs|pdflib)/.+$') { return $true }
    return $false
}

function Write-Step([string]$Message) { Write-Host ('[package] ' + $Message) -ForegroundColor Cyan }
function Write-Fail([string]$Message) { Write-Host ('[package] ' + $Message) -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) {
    throw ('app ディレクトリが見つかりません: ' + $AppDir)
}

& (Join-Path $PSScriptRoot 'Assert-AppVersion.ps1') -RepoRoot $RepoRoot
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = 'v' + [IO.File]::ReadAllText((Join-Path $AppDir '_app/VERSION')).Trim() }

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
        $relative = $file.FullName.Substring($AppDir.Length).TrimStart('\', '/')
        if (-not (Test-KoseiReleasePath -RelativePath $relative)) { $skipped++; continue }
        $target   = Join-Path $stageApp $relative
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $copied++
    }
    Write-Step ('コピー完了: {0} ファイル（除外 {1} 件）' -f $copied, $skipped)

    # 配布ファイルの一覧とハッシュ。作業コピーに古い release-manifest.json があっても、必ずここで作り直す。
    . (Join-Path $AppDir '_app\Launch-KoseiAssist.ps1')
    $manifest = New-KoseiReleaseManifest -AppRoot (Join-Path $stageApp '_app')
    Write-Step ('release-manifest.json: v{0} build {1}（{2} ファイル）' -f $manifest.version, $manifest.build.Substring(0, 12), @($manifest.files).Count)

    # --- 3. 必須ファイルの存在確認 ---
    $required = @(
        'PDF校正アシスト起動.cmd',
        'PDF校正アシスト_初回セットアップ.cmd',
        '_app\Launch-KoseiAssist.ps1',
        '_app\release-manifest.json',
        '_app\Start-KoseiAssist.ps1',
        '_app\Start-DropReview.ps1',
        '_app\Setup-KoseiAssist.ps1',
        '_app\src\DropApi.ps1',
        '_app\src\DropFiles.ps1',
        '_app\src\DropReview.ps1',
        '_app\src\DesktopUi.ps1',
        '_app\src\SendToShortcut.ps1',
        '_app\src\Setup.ps1',
        '_app\VERSION',
        '_app\index.html',
        '_app\config\settings.template.json',
        '_app\config\runtime-html-policy.json',
        '_app\js\finding-quality.mjs',
        '_app\js\heading-index.mjs',
        '_app\js\number-mask.mjs',
        '_app\js\pdf-text-reconstruct.mjs',
        '_app\js\review-merge.mjs',
        '_app\src\Paths.ps1',
        '_app\src\RuntimeHtmlPolicy.ps1',
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
        $unexpected = @()
        foreach ($name in $names) {
            $prefix = $ReleaseName + '/'
            if (-not $name.StartsWith($prefix, [System.StringComparison]::Ordinal)) { $unexpected += $name; continue }
            $relative = $name.Substring($prefix.Length)
            if (-not (Test-KoseiReleasePath -RelativePath $relative)) { $unexpected += $name }
        }
        if ($unexpected.Count -gt 0) {
            throw ('許可されていないZIPエントリを検出しました: ' + (@($unexpected) -join ', '))
        }
        $sensitive = @($names | Where-Object {
            $_ -match '/(?:docs/benchmarks/(?:real|\.tmp|runs/raw)|output|tmp)/' -or
            $_ -match '\.(?:pdf|raw\.txt|salvage\.txt)$'
        })
        if ($sensitive.Count -gt 0) {
            throw ('機密になり得る実文書・生応答を検出しました: ' + (@($sensitive) -join ', '))
        }
        $cmdEntry = @($names | Where-Object { $_ -like '*PDF校正アシスト起動.cmd' })
        if ($cmdEntry.Count -ne 1) { throw '起動CMDのエントリ名を検証できませんでした（文字化けの可能性）。' }
        $setupEntry = @($names | Where-Object { $_ -like '*PDF校正アシスト_初回セットアップ.cmd' })
        if ($setupEntry.Count -ne 1) { throw '初回セットアップCMDのエントリ名を検証できませんでした。' }
        if (@($names | Where-Object { $_ -match '(?i)\.vbs$' }).Count) { throw '配布ZIPにVBSが含まれています。' }
        Write-Step ('検証OK: {0} エントリ / 起動CMD = {1}' -f $names.Count, $cmdEntry[0])
    } finally {
        $check.Dispose()
    }

    # Check the central-directory flags, not only decoded entry names.
    $zipBytes=[IO.File]::ReadAllBytes($zipPath)
    $end=$zipBytes.Length-22
    while($end -ge 0 -and [BitConverter]::ToUInt32($zipBytes,$end) -ne 0x06054b50){$end--}
    if($end -lt 0){throw 'ZIPの中央ディレクトリを確認できません。'}
    $offset=[int][BitConverter]::ToUInt32($zipBytes,$end+16)
    $entryCount=[int][BitConverter]::ToUInt16($zipBytes,$end+10)
    for($index=0;$index -lt $entryCount;$index++){
        if([BitConverter]::ToUInt32($zipBytes,$offset) -ne 0x02014b50){throw 'ZIPの中央ディレクトリが不正です。'}
        $flags=[BitConverter]::ToUInt16($zipBytes,$offset+8)
        $nameLength=[BitConverter]::ToUInt16($zipBytes,$offset+28)
        $extraLength=[BitConverter]::ToUInt16($zipBytes,$offset+30)
        $commentLength=[BitConverter]::ToUInt16($zipBytes,$offset+32)
        $entryName=[Text.Encoding]::UTF8.GetString($zipBytes,$offset+46,$nameLength)
        if($entryName -match '[^\x00-\x7F]' -and ($flags -band 0x800) -eq 0){throw ('ZIP名のUTF-8フラグがありません: '+$entryName)}
        $offset+=46+$nameLength+$extraLength+$commentLength
    }

    $sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
    Write-Host ''
    Write-Host ('完成: {0}  ({1} MB)' -f $zipPath, $sizeMb) -ForegroundColor Green

    # --- 6. 共有フォルダーへの配置（-DeployTo） ---
    if (-not [string]::IsNullOrWhiteSpace($DeployTo)) {
        Write-Step ('共有フォルダーへ配置します: ' + $DeployTo)
        $manifestRelative = '_app\release-manifest.json'
        $deployFiles = @(Get-ChildItem -LiteralPath $stageApp -Recurse -File | ForEach-Object { $_.FullName.Substring($stageApp.Length).TrimStart('\', '/') } | Where-Object { $_.Replace('/', '\') -ne $manifestRelative })
        foreach ($relative in @($deployFiles) + @($manifestRelative)) {
            $target = Join-Path $DeployTo $relative
            $targetDir = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
            Copy-Item -LiteralPath (Join-Path $stageApp $relative) -Destination $target -Force
        }
        Write-Host ('配置しました: {0}（{1} ファイル。config\settings.json はそのまま）' -f $DeployTo, (@($deployFiles).Count + 1)) -ForegroundColor Green
        Write-Host '利用者は、次に「送る」やアプリを起動したときに新しい版へ切り替わります。' -ForegroundColor Green
    } else {
        Write-Host 'ZIPの中身（PDF校正ツール フォルダーの中）を、共有フォルダーへ上書きで展開してください。' -ForegroundColor Green
        Write-Host '初めて使う人は、共有フォルダーの PDF校正アシスト_初回セットアップ.cmd を1回ダブルクリックします。' -ForegroundColor Green
    }
} catch {
    if($zipPath -and [IO.File]::Exists($zipPath)){[IO.File]::Delete($zipPath)}
    throw
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        $resolvedStage=[IO.Path]::GetFullPath($stageRoot)
        if($resolvedStage.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedStage) -match '^kosei-pkg-[0-9a-f]{8}$'){
            try { Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}
