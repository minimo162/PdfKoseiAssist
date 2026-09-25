param(
    [switch]$NoBrowser,
    [switch]$DropMode,
    [switch]$NoWarmup,
    [switch]$NoAutoShutdown
)

# =====================================================================
# Start-KoseiAssist.ps1 — PDF校正アシスト 起動エントリ
#
# 1. src/ を読み込み、settings.json を解決
# 2. Copilotウォームアップをバックグラウンドrunspaceで開始
#    （Edge起動→チャット入力欄検出。状態は runtime/copilot-warmup.json）
# 3. HTTPサーバーを起動し、既定ブラウザでアプリを開く
# =====================================================================

$ErrorActionPreference = 'Stop'
if ($DropMode) { $env:PDF_KOSEI_DROP_MODE = '1' }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
# 起動ログとURLは利用者ごとの場所に書く（アプリのフォルダは共有フォルダからの写しで、読み取り専用のこともある）。
# モジュールを読む前にも使うので、Paths.ps1 の Get-KoseiDataDir と同じ規則でここでも求める。
$DataDir = [Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pdf-kosei-ps' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
foreach ($dataSubDir in @('logs', 'runtime')) { try { $null = [System.IO.Directory]::CreateDirectory((Join-Path $DataDir $dataSubDir)) } catch {} }
$StartupLog = Join-Path (Join-Path $DataDir 'logs') 'startup-log.txt'
$LaunchStartedAt = Get-Date
$UrlFile = Join-Path (Join-Path $DataDir 'runtime') 'local-app.url'
function Write-KoseiStartupFailure([string]$Message) {
    $line = '[' + (Get-Date).ToString('s') + '] ' + $Message
    try { Add-Content -LiteralPath $StartupLog -Encoding UTF8 -Value $line } catch {}
    try { [Console]::Error.WriteLine($Message) } catch {}
}

# ログ機能自体を読み込む前に、全srcモジュールをPowerShell 5.1標準Parserで検査する。
$parseFailures = New-Object System.Collections.Generic.List[string]
foreach ($sourceFile in @(Get-ChildItem -LiteralPath (Join-Path $Root 'src') -Filter '*.ps1' -File | Sort-Object Name)) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($sourceFile.FullName, [ref]$tokens, [ref]$errors)
    foreach ($parseError in @($errors)) {
        $message = 'parse error: {0}:{1} {2}' -f $sourceFile.Name, $parseError.Extent.StartLineNumber, $parseError.Message
        $parseFailures.Add($message)
        Write-KoseiStartupFailure $message
    }
}
if ($parseFailures.Count -gt 0) {
    $summary = '起動失敗: PowerShell構文エラーを検出しました。' + $StartupLog + ' を確認してください。'
    Write-KoseiStartupFailure $summary
    try { Add-Type -AssemblyName PresentationFramework -ErrorAction Stop; [void][System.Windows.MessageBox]::Show($summary, 'PDF校正アシスト') } catch {}
    exit 1
}
# 前回実行のURLを新しい起動オープナーが誤読しないよう、モジュール読込前に除去する。
try { Remove-Item -LiteralPath $UrlFile -Force -ErrorAction SilentlyContinue } catch { Write-KoseiStartupFailure ('stale url cleanup warning: ' + $_.Exception.Message) }

try {
    . (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
    Set-KoseiRoot -Root $Root
    . (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
    . (Join-Path (Join-Path $Root 'src') 'SendToShortcut.ps1')
    . (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')
    . (Join-Path (Join-Path $Root 'src') 'ReviewJob.ps1')
    . (Join-Path (Join-Path $Root 'src') 'Server.ps1')
} catch {
    Write-KoseiStartupFailure ('module load error: ' + $_.Exception.Message)
    Write-KoseiStartupFailure ('stack: ' + $_.ScriptStackTrace)
    try { Add-Type -AssemblyName PresentationFramework -ErrorAction Stop; [void][System.Windows.MessageBox]::Show(('起動失敗: モジュールを読み込めませんでした。' + [Environment]::NewLine + $_.Exception.Message), 'PDF校正アシスト') } catch {}
    exit 1
}

$settings = Get-KoseiSettings
$sendToRepair=Repair-KoseiSendToShortcut
if(!$sendToRepair.ok){Write-KoseiLog ('sendto repair warning: '+$sendToRepair.error) 'WARN'}
$null = Invoke-KoseiRetentionSweep -Settings $settings
$null = Initialize-KoseiJobRecovery -Settings $settings
# 二重起動を避け、既存の正常なサーバーがあればそのURLを開いて終了する。
foreach ($existingPort in @($settings.server_ports)) {
    $existingUrl = 'http://127.0.0.1:' + [int]$existingPort + '/'
    try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri ($existingUrl + '__health') -Method Get -TimeoutSec 1
        if ([int]$health.StatusCode -ge 200 -and [int]$health.StatusCode -lt 500) {
            $runningVersion = '不明'
            try { $runningVersion = [string](($health.Content | ConvertFrom-Json).version) } catch {}
            if ([string]::IsNullOrWhiteSpace($runningVersion)) { $runningVersion = '不明' }
            $localVersion = Get-KoseiAppVersion
            if ($runningVersion -ne $localVersion) {
                Write-KoseiStartupFailure ('別の版のアプリが起動中です（起動中: v' + $runningVersion + ' / この起動: v' + $localVersion + '）')
            }
            Write-KoseiStartupFailure ('already running: ' + $existingUrl)
            if (-not $NoBrowser) { Start-Process $existingUrl | Out-Null }
            exit 0
        }
    } catch {}
}
# This process owns a fresh, nonsecret launch identity.  Set it only after the
# existing-server early exit so a second launcher cannot authorize a new
# Copilot target against the already-running app's session.
$env:PDF_KOSEI_LAUNCH_ID = [guid]::NewGuid().ToString('N')
$startHeading = Get-KoseiLifecycleLogHeading -Phase '起動'
try { Add-Content -LiteralPath $StartupLog -Encoding UTF8 -Value ('[' + (Get-Date).ToString('s') + '] ' + $startHeading) } catch {}
Write-KoseiLog $startHeading 'INFO'

# --- Copilotウォームアップ（バックグラウンド） ---
# ⚠️ 起動したら **必ず** 状態を書き直す。runtime\copilot-warmup.json は残り続けるので、
#    -NoWarmup のときに何も書かないと、前回起動の ready をそのまま名乗ることになる
#    （実測: Edgeを起動していないセッションが /api/ready-state で ready を返した）。
$warmupHandle = $null
if ($NoWarmup) {
    Write-KoseiWarmupStatus -State 'unknown' -Detail '-NoWarmup で起動したためウォームアップしていません'
}
if (-not $NoWarmup) {
    try { Remove-Item -LiteralPath (Join-Path (Get-KoseiSubDir 'runtime') 'copilot-user-visible.flag') -Force -ErrorAction SilentlyContinue } catch {}
    Write-KoseiWarmupStatus -State 'preparing' -Detail 'Edge起動中'
    $warmupWorker = {
        param([string]$Root)
        $ErrorActionPreference = 'Stop'
        try {
            . (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
            Set-KoseiRoot -Root $Root
            . (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
            . (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')
            $null = Invoke-KoseiCopilotWarmup
        } catch {
            try { Write-KoseiWarmupStatus -State 'error' -Detail $_.Exception.Message } catch {}
        }
    }
    $wps = [powershell]::Create()
    $null = $wps.AddScript($warmupWorker).AddArgument($Root)
    $wasync = $wps.BeginInvoke()
    $warmupHandle = @{ PowerShell = $wps; Async = $wasync }
}

# --- ブラウザ起動（サーバーがURLファイルを書いた後に開く） ---
if (-not $NoBrowser) {
    $opener = {
        param([string]$UrlFile, [datetime]$LaunchStartedAt)
        $urlFile = $UrlFile
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            if ((Test-Path -LiteralPath $urlFile -PathType Leaf) -and (Get-Item -LiteralPath $urlFile).LastWriteTime -ge $LaunchStartedAt) {
                $url = (Get-Content -LiteralPath $urlFile -TotalCount 1).Trim()
                if (-not [string]::IsNullOrWhiteSpace($url)) {
                    Start-Process $url | Out-Null
                    return
                }
            }
            Start-Sleep -Milliseconds 300
        }
    }
    $ops = [powershell]::Create()
    $null = $ops.AddScript($opener).AddArgument($UrlFile).AddArgument($LaunchStartedAt)
    $null = $ops.BeginInvoke()
}

# --- サーバー（フォアグラウンド。Ctrl+Cで停止） ---
try {
    Start-KoseiServer -Settings $settings -NoAutoShutdown:$NoAutoShutdown
} finally {
    if ($warmupHandle) {
        try { $warmupHandle.PowerShell.Stop() } catch {}
        try { $warmupHandle.PowerShell.Dispose() } catch {}
    }
    Write-KoseiLog (Get-KoseiLifecycleLogHeading -Phase '終了') 'INFO'
}
