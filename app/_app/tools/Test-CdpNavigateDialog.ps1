$ErrorActionPreference = 'Stop'
# 「CDP応答タイムアウト（15秒）: Runtime.evaluate」の再発対策（v3）。
#   - 自分の Page.navigate で beforeunload ダイアログが出ても止まらない（同じ接続で Page.enable して受ける）
#   - 画面を CDP で読めないまま準備ゲートが切れたら、cdp_transport で投げて ReviewJob の CDP 復旧に任せる
#     （「Copilot画面が準備できません」＝ジョブを止める致命的失敗にしない）
# 実際の Edge は起動しない。WebSocket の送受信の境目だけを差し替え、製品の CopilotClient.ps1 の関数をそのまま通す。
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'src'
$script:checks = 0
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $script:checks++; Write-Host "PASS $Name"
}

# 偽の WebSocket。送った要求を接続ごとに記録し、$script:onSend が受信待ちの列へ応答・イベントを積む。
# 列が空なら受信の時間切れ（$null）＝本物の Receive-KoseiWsMessage と同じ扱い。
$installFakeSocket = {
    $script:connects = 0
    $script:sent = New-Object System.Collections.Generic.List[object]
    function Connect-KoseiWebSocket {
        param($WebSocketUrl, $TimeoutSeconds)
        $script:connects++
        $ws = [pscustomobject]@{ State = 'Open'; Attempt = $script:connects; Inbox = (New-Object System.Collections.Generic.Queue[string]) }
        $ws | Add-Member -MemberType ScriptMethod -Name SendAsync -Value {
            $seg = $args[0]
            $msg = [System.Text.Encoding]::UTF8.GetString($seg.Array, $seg.Offset, $seg.Count) | ConvertFrom-Json
            $script:sent.Add([pscustomobject]@{ attempt = $this.Attempt; id = [int]$msg.id; method = [string]$msg.method; params = $msg.params })
            foreach ($reply in @(& $script:onSend $this.Attempt $msg)) { if ($null -ne $reply) { $this.Inbox.Enqueue(($reply | ConvertTo-Json -Depth 8 -Compress)) } }
            [System.Threading.Tasks.Task]::CompletedTask
        }
        $ws | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        return $ws
    }
    function Receive-KoseiWsMessage {
        param($WebSocket, $TimeoutSeconds)
        if ($WebSocket.Inbox.Count -eq 0) { return $null }
        return $WebSocket.Inbox.Dequeue()
    }
}
function Get-Sent { param([string]$Method) @($script:sent | Where-Object { $_.method -eq $Method }) }

# --- 1. 遷移中に出たダイアログは、同じ接続で受けて閉じる -----------------------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    . $installFakeSocket
    # Edge の実測と同じ順: Page.navigate を送ると、応答より先に beforeunload のダイアログが通知される。
    # ダイアログを閉じるまで Page.navigate の応答は来ない。
    $script:navigateId = 0
    $script:onSend = { param($attempt, $msg)
        switch ([string]$msg.method) {
            'Page.enable' { @{ id = $msg.id; result = @{} } }
            'Page.navigate' { $script:navigateId = [int]$msg.id; @{ method = 'Page.frameStartedLoading'; params = @{} }; @{ method = 'Page.javascriptDialogOpening'; params = @{ type = 'beforeunload'; message = '' } } }
            'Page.handleJavaScriptDialog' { @{ id = $msg.id; result = @{} }; @{ id = $script:navigateId; result = @{ frameId = 'F1' } } }
        }
    }
    $r = Invoke-KoseiCdpNavigate -WebSocketUrl 'ws://t/p' -Url 'https://m365.cloud.microsoft/chat' -TimeoutSeconds 5
    $order = @($script:sent | ForEach-Object { $_.method }) -join ','
    Assert-Case ($order -eq 'Page.enable,Page.navigate,Page.handleJavaScriptDialog') "Page.enable comes before the navigate and the dialog is handled ($order)"
    Assert-Case ([string]$r.result.frameId -eq 'F1') 'navigate returns its own response after the dialog is closed'
    Assert-Case ($script:connects -eq 1 -and @($script:sent | Where-Object { $_.attempt -ne 1 }).Count -eq 0) 'dialog is handled on the same connection that enabled Page'
    Assert-Case (@(Get-Sent 'Page.handleJavaScriptDialog')[0].params.accept -eq $true) 'dialog is accepted (leave the page, which is the point of navigating)'
    Assert-Case ([string]@(Get-Sent 'Page.navigate')[0].params.url -eq 'https://m365.cloud.microsoft/chat') 'navigate targets the requested URL'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*ダイアログが出たため閉じます*type=beforeunload*' }).Count -eq 1) 'closing the dialog is logged as WARN'

    # ダイアログが出なければ、ふつうに遷移するだけ（閉じる要求は送らない）。
    . $installFakeSocket
    $script:onSend = { param($attempt, $msg) @{ id = $msg.id; result = @{} } }
    $null = Invoke-KoseiCdpNavigate -WebSocketUrl 'ws://t/p' -Url 'https://m365.cloud.microsoft/chat' -TimeoutSeconds 5
    Assert-Case (@(Get-Sent 'Page.handleJavaScriptDialog').Count -eq 0 -and @(Get-Sent 'Page.navigate').Count -eq 1) 'no dialog: a single navigate and no dialog handling'
}

# --- 2. Page.enable が返らない（もう止まっている）ページは、張り直して素の遷移を送る ---------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    . $installFakeSocket
    $script:onSend = { param($attempt, $msg)
        if ([string]$msg.method -eq 'Page.enable') { return $null }
        @{ id = $msg.id; result = @{ frameId = 'F2' } }
    }
    $r = Invoke-KoseiCdpNavigate -WebSocketUrl 'ws://t/p' -Url 'https://m365.cloud.microsoft/chat' -TimeoutSeconds 5 -EnableTimeoutSeconds 1
    $nav = @(Get-Sent 'Page.navigate')
    Assert-Case ($script:connects -eq 2 -and $nav.Count -eq 1 -and $nav[0].attempt -eq 2) 'navigate is sent once on a fresh connection after Page.enable times out'
    Assert-Case ([string]$r.result.frameId -eq 'F2') 'fallback navigate returns its response'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*Page.enable が応答しない*' }).Count -eq 1) 'fallback is logged as WARN'

    # 遷移そのものが返らなければ、これまでどおり種別付きの応答タイムアウトで投げる（呼び出し側の CDP 復旧に渡す）。
    . $installFakeSocket
    $script:onSend = { param($attempt, $msg) if ([string]$msg.method -eq 'Page.enable') { @{ id = $msg.id; result = @{} } } }
    $kind = ''; $message = ''
    try { $null = Invoke-KoseiCdpNavigate -WebSocketUrl 'ws://t/p' -Url 'https://m365.cloud.microsoft/chat' -TimeoutSeconds 1 } catch { $kind = [string]$_.Exception.Data['KoseiFailureKind']; $message = $_.Exception.Message }
    Assert-Case ($message -like 'CDP応答タイムアウト*Page.navigate*' -and $kind -eq 'cdp_transport') 'unanswered navigate still throws a typed response timeout'
}

# --- 3. Copilot の Page.navigate は、すべてダイアログを受ける経路を通る -------------------------
& {
    $text = Get-Content -LiteralPath (Join-Path $src 'CopilotClient.ps1') -Raw -Encoding UTF8
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    $plain = @($ast.FindAll({ param($n)
        $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-KoseiCdpMethod' -and $n.Extent.Text -like "*'Page.navigate'*"
    }, $true))
    Assert-Case ($plain.Count -eq 0) ('no plain Page.navigate through Invoke-KoseiCdpMethod: ' + (@($plain | ForEach-Object { $_.Extent.StartLineNumber }) -join ','))
    $fresh = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-KoseiFreshChat' }, $true)
    $navs = @($fresh.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-KoseiCdpNavigate' }, $true))
    Assert-Case ($navs.Count -eq 2) "new chat uses the dialog-safe navigate for both HardReset and the fallback ($($navs.Count))"
}

# --- 4. 画面の状態取得: 接続の失敗と、ページ側の失敗を見分けて返す -----------------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    function Write-KoseiLog {}
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) throw (New-KoseiFailureException -Kind 'cdp_transport' -Message 'CDP応答タイムアウト（15秒）: Runtime.evaluate') }
    $s = Get-KoseiCopilotScreenState -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($s.ready -eq $false -and [string]$s.cdpFailure -eq 'cdp_transport' -and [string]$s.cdpError -like 'CDP応答タイムアウト（15秒）*') 'response timeout is reported as a CDP failure'
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) throw 'JavaScript evaluation failed: {"text":"boom"}' }
    $s = Get-KoseiCopilotScreenState -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($s.ready -eq $false -and [string]::IsNullOrWhiteSpace([string]$s.cdpFailure)) 'page-side JS failure is not a CDP failure'
}

# --- 5. 準備ゲート: CDP で読めないまま切れたら cdp_transport で投げる（ジョブを止める文言にしない） ----
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    function Start-Sleep {}
    function Reset-KoseiEdgeWindowStateForDetection {}
    # 時計を進める（1回読むごとに15秒＝応答タイムアウト1回分）。
    $script:now = [datetime]'2026-11-04T10:00:00'
    function Get-Date { $script:now }
    $script:reads = 0
    function Get-KoseiCopilotScreenState {
        param($WsUrl, $Settings)
        $script:reads++; $script:now = $script:now.AddSeconds(15)
        [pscustomobject]@{ ready = $false; signin_required = $false; url = ''; title = ''; bodyPreview = '診断取得失敗: CDP応答タイムアウト（15秒）: Runtime.evaluate'; cdpFailure = 'cdp_transport'; cdpError = 'CDP応答タイムアウト（15秒）: Runtime.evaluate' }
    }
    $kind = ''; $message = ''; $returned = $null
    try { $returned = Wait-KoseiCopilotScreenReady -WsUrl 'ws://t/p' -Settings $settings -TimeoutSeconds 60 } catch { $kind = Get-KoseiCdpFailureKind -ErrorRecord $_; $message = $_.Exception.Message }
    Assert-Case ($null -eq $returned -and $kind -eq 'cdp_transport') 'unreadable screen until the deadline throws cdp_transport (recoverable by ReviewJob)'
    Assert-Case ($message -like '*CDP応答タイムアウト（15秒）: Runtime.evaluate*') 'original timeout text is kept for diagnosis'
    # ReviewJob はこの文言の失敗を「画面の致命的失敗」としてジョブごと止める（Invoke-KoseiPacket の catch）。
    Assert-Case ($message -notmatch 'Copilotへのサインインが必要|Copilot画面が準備できません') 'CDP failure does not use the fatal screen-failure wording'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'ERROR*準備ゲート不通過 reason=cdp-unresponsive*' }).Count -eq 1) 'gate failure is logged with reason=cdp-unresponsive'

    # 画面は読めているが準備ができない（ページ側の問題）なら、これまでどおりの結果を返す。
    $script:now = [datetime]'2026-11-04T10:00:00'
    function Get-KoseiCopilotScreenState {
        param($WsUrl, $Settings)
        $script:now = $script:now.AddSeconds(15)
        [pscustomobject]@{ ready = $false; signin_required = $false; url = 'https://m365.cloud.microsoft/chat'; title = 'Copilot'; bodyPreview = ''; editorExists = $true; surface = 'chat' }
    }
    $gate = Wait-KoseiCopilotScreenReady -WsUrl 'ws://t/p' -Settings $settings -TimeoutSeconds 60
    Assert-Case ($gate.ok -eq $false -and [string]$gate.message -like 'Copilot画面が準備できませんでした*') 'readable but not-ready screen keeps the existing gate result'

    # 途中で一度読めなくなっても、最後に読めて準備ができていれば通す。
    $script:now = [datetime]'2026-11-04T10:00:00'
    $script:reads = 0
    function Get-KoseiCopilotScreenState {
        param($WsUrl, $Settings)
        $script:reads++; $script:now = $script:now.AddSeconds(15)
        if ($script:reads -eq 1) { return [pscustomobject]@{ ready = $false; signin_required = $false; cdpFailure = 'cdp_transport'; cdpError = 'CDP応答タイムアウト（15秒）: Runtime.evaluate' } }
        [pscustomobject]@{ ready = $true; signin_required = $false }
    }
    $gate = Wait-KoseiCopilotScreenReady -WsUrl 'ws://t/p' -Settings $settings -TimeoutSeconds 60
    Assert-Case ($gate.ok -eq $true -and $script:reads -eq 2) 'one CDP timeout inside the gate is still waited out'
}

Write-Host "Test-CdpNavigateDialog: $script:checks checks passed"
