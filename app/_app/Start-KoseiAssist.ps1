param(
    [switch]$NoBrowser,
    [switch]$NoWarmup,
    [switch]$NoAutoShutdown
)

# =====================================================================
# Start-KoseiAssist.ps1 — PDF校正アシスト v94 起動エントリ
#
# 1. src/ を読み込み、settings.json を解決
# 2. Copilotウォームアップをバックグラウンドrunspaceで開始
#    （Edge起動→チャット入力欄検出。状態は runtime/copilot-warmup.json）
# 3. HTTPサーバーを起動し、既定ブラウザでアプリを開く
# =====================================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupLog = Join-Path $Root 'startup-log.txt'
$LaunchStartedAt = Get-Date
$UrlFile = Join-Path $Root 'local-app.url'
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
    $summary = '起動失敗: PowerShell構文エラーを検出しました。startup-log.txt を確認してください。'
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
# 二重起動を避け、既存の正常なサーバーがあればそのURLを開いて終了する。
foreach ($existingPort in @($settings.server_ports)) {
    $existingUrl = 'http://127.0.0.1:' + [int]$existingPort + '/'
    try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri ($existingUrl + '__health') -Method Get -TimeoutSec 1
        if ([int]$health.StatusCode -ge 200 -and [int]$health.StatusCode -lt 500) {
            Write-KoseiStartupFailure ('already running: ' + $existingUrl)
            if (-not $NoBrowser) { Start-Process $existingUrl | Out-Null }
            exit 0
        }
    } catch {}
}
try { Add-Content -LiteralPath $StartupLog -Encoding UTF8 -Value ('[' + (Get-Date).ToString('s') + '] === PDF校正アシスト v94 起動 ===') } catch {}
Write-KoseiLog '=== PDF校正アシスト v94 起動 ===' 'INFO'

# --- Copilotウォームアップ（バックグラウンド） ---
$warmupHandle = $null
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
            $settings = Get-KoseiSettings
            Start-KoseiCopilotEdge -Settings $settings
            $page = Get-KoseiCopilotPage -Settings $settings
            $null=Set-KoseiEdgeWindowMinimized -Settings $settings -Page $page -Reason 'startup'
            $wsUrl = [string]$page.webSocketDebuggerUrl
            Write-KoseiWarmupStatus -State 'preparing' -Detail 'Copilot画面の準備待ち'
            $ok = Wait-KoseiCopilotInputReady -WsUrl $wsUrl -Settings $settings -TimeoutSeconds 300 -OnWaiting {
                param([string]$Url)
                if ($Url -like '*login*') { Write-KoseiWarmupStatus -State 'signin_required' -Detail 'Edgeでサインインしてください' }
            }
            if ($ok) { Write-KoseiWarmupStatus -State 'ready' -Detail '' }
            else { Write-KoseiWarmupStatus -State 'signin_required' -Detail 'チャット入力欄を検出できませんでした。Edgeでサインインしてください。' }
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
        param([string]$Root, [datetime]$LaunchStartedAt)
        $urlFile = Join-Path $Root 'local-app.url'
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
    $null = $ops.AddScript($opener).AddArgument($Root).AddArgument($LaunchStartedAt)
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
    Write-KoseiLog '=== PDF校正アシスト v94 終了 ===' 'INFO'
}
