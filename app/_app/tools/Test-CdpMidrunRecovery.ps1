$ErrorActionPreference = 'Stop'
# レビュー途中の CDP エラーで止まらないこと（docs/plans/CDP途中停止_改善案_2026-11-02.md）。
# 実際の Edge は起動しない。CDP の境目（ソケット・ターゲット一覧・リクエスト）を差し替えて、
# 製品の CopilotClient.ps1 / ReviewJob.ps1 の関数をそのまま通す。
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'src'
$script:checks = 0
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $script:checks++; Write-Host "PASS $Name"
}
function Get-Kind($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($null -ne $e) { if ($e.Data.Contains('KoseiFailureKind')) { return [string]$e.Data['KoseiFailureKind'] }; $e = $e.InnerException }
    return ''
}

# --- 1. 閉じた／中断したソケットでは受信を重ねず、種別付きで止まる -----------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    function Write-KoseiLog {}
    $script:sends = 0; $script:receives = 0
    $socket = [pscustomobject]@{ State = 'Aborted' }
    $socket | Add-Member -MemberType ScriptMethod -Name SendAsync -Value { $script:sends++; [System.Threading.Tasks.Task]::CompletedTask }
    $kind = ''
    try { $null = Invoke-KoseiCdpOnSocket -WebSocket $socket -Method 'Runtime.evaluate' -TimeoutSeconds 5 } catch { $kind = Get-Kind $_ }
    Assert-Case ($kind -eq 'cdp_transport' -and $script:sends -eq 0) 'aborted socket fails fast as cdp_transport without sending'

    # 受信の時間切れ（$null）の後に同じソケットで受信し直さない（.NET は取り消し後のソケットを Aborted にする）。
    $socket.State = 'Open'
    & {
        function Receive-KoseiWsMessage { param($WebSocket, $TimeoutSeconds) $script:receives++; return $null }
        $kind = ''; $message = ''
        try { $null = Invoke-KoseiCdpOnSocket -WebSocket $socket -Method 'Runtime.evaluate' -TimeoutSeconds 30 } catch { $kind = Get-Kind $_; $message = $_.Exception.Message }
        Assert-Case ($kind -eq 'cdp_transport' -and $script:receives -eq 1 -and $message -like 'CDP応答タイムアウト*') 'receive timeout stops after one cancelled receive with a clear timeout message'
    }

    # Close フレームは「ページが閉じられた」と分かる文で、種別付き。
    $closeSocket = [pscustomobject]@{ State = 'Open' }
    $closeSocket | Add-Member -MemberType ScriptMethod -Name ReceiveAsync -Value {
        param($seg, $token)
        $result = [System.Net.WebSockets.WebSocketReceiveResult]::new(0, [System.Net.WebSockets.WebSocketMessageType]::Close, $true)
        [System.Threading.Tasks.Task]::FromResult($result)
    }
    $kind = ''; $message = ''
    try { $null = Receive-KoseiWsMessage -WebSocket $closeSocket -TimeoutSeconds 5 } catch { $kind = Get-Kind $_; $message = $_.Exception.Message }
    Assert-Case ($kind -eq 'cdp_transport' -and $message -like '*閉じられました*') 'close frame is reported as typed cdp_transport'

    # CDPプロトコルのエラー（ページ遷移で文脈が消えた）は cdp_transport、ページ側JSの例外は対象外。
    function Invoke-KoseiCdpMethod { param($WebSocketUrl, $Method, $Params, $TimeoutSeconds) [pscustomobject]@{ error = [pscustomobject]@{ code = -32000; message = 'Execution context was destroyed.' } } }
    $kind = ''
    try { $null = Invoke-KoseiCdpEval -WebSocketUrl 'ws://test/p' -Expression '1' } catch { $kind = Get-Kind $_ }
    Assert-Case ($kind -eq 'cdp_transport') 'protocol error from Runtime.evaluate is cdp_transport'
}

# --- 2. 生の例外文の分類 -------------------------------------------------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    $classify = { param($m) try { throw $m } catch { Get-KoseiCdpFailureKind -ErrorRecord $_ } }
    Assert-Case ((& $classify 'CDP WebSocket受信失敗: The WebSocket is in an invalid state') -eq 'cdp_transport') 'legacy receive failure text is transport'
    Assert-Case ((& $classify 'CDPターゲット abc が見つかりません（ウィンドウが閉じられた可能性があります）。') -eq 'cdp_transport') 'missing target text is transport'
    Assert-Case ((& $classify '{"code":-32000,"message":"Inspected target navigated or closed"}') -eq 'cdp_transport') 'navigated-or-closed protocol error is transport'
    Assert-Case ((& $classify 'JavaScript evaluation failed: {"text":"Copilot send origin changed"}') -eq '') 'page-side JS exception is not transport'
    Assert-Case ((& $classify '送信を中止しました。Copilotの送信先が設定と一致しません') -eq '') 'origin guard is not transport'
    $cancel = $null; try { throw [OperationCanceledException]::new('CDP worker lease expired') } catch { $cancel = $_ }
    Assert-Case ((Get-KoseiCdpFailureKind -ErrorRecord $cancel) -eq '') 'cancellation is never retried as transport'
    $typed = $null; try { throw (New-KoseiFailureException -Kind 'needs_user_visibility' -Message 'CDP hidden window') } catch { $typed = $_ }
    Assert-Case ((Get-KoseiCdpFailureKind -ErrorRecord $typed) -eq '') 'other typed failures keep their own kind'
}

# --- 3. 送信前フェーズの CDP 例外は段階・送信有無つきの cdp_transport になる ---------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    function Write-KoseiLog {}
    function Start-Sleep {}
    function Start-KoseiCopilotEdge {}
    function Wait-KoseiCopilotScreenReady { [pscustomobject]@{ ok = $true; cancelled = $false } }
    function Invoke-KoseiFreshChat { throw 'CDPエラー: {"code":-32000,"message":"Execution context was destroyed."}' }
    $page = [pscustomobject]@{ id = 'worker-1'; webSocketDebuggerUrl = 'ws://test/worker-1' }
    $failure = $null
    try { $null = Invoke-KoseiCopilotReviewRequest -Settings $settings -Page $page -ChatMode 'New' -Prompt 'x' } catch { $failure = $_ }
    Assert-Case ($null -ne $failure -and (Get-Kind $failure) -eq 'cdp_transport' -and [string]$failure.Exception.Data['KoseiCdpPhase'] -eq 'new_chat' -and -not [bool]$failure.Exception.Data['KoseiPromptSent']) 'pre-send CDP failure is typed with phase and sent=false'
    Assert-Case ($failure.Exception.Message -like '*Copilot（Edge）との接続*new_chat*') 'pre-send CDP failure message names the stage'
}

# --- 4. ページ復旧: 生きていれば再利用、消えていれば新しい窓へ差し替え ------------------
foreach ($case in @('same-target', 'target-gone')) {
    & {
        . (Join-Path $src 'CopilotClient.ps1')
        . (Join-Path $src 'Settings.ps1')
        $settings = Get-KoseiDefaultSettings
        function Write-KoseiLog {}
        function Start-Sleep {}
        $script:edgeStarts = 0; $script:closed = @(); $script:created = 0; $script:descriptorTarget = ''
        function Start-KoseiCopilotEdge { $script:edgeStarts++ }
        function Get-KoseiCopilotPageById {
            param($Settings, $TargetId)
            if ($TargetId -eq 'old' -and $case -eq 'same-target') { return [pscustomobject]@{ id = 'old'; url = 'https://m365.cloud.microsoft/chat/'; webSocketDebuggerUrl = 'ws://test/old' } }
            if ($TargetId -eq 'new' -and $script:created -gt 0) { return [pscustomobject]@{ id = 'new'; url = 'https://m365.cloud.microsoft/chat/'; webSocketDebuggerUrl = 'ws://test/new' } }
            throw ("CDPターゲット " + $TargetId + " が見つかりません（ウィンドウが閉じられた可能性があります）。")
        }
        function Get-KoseiMainText { param($WsUrl) 'ok' }
        function Invoke-RestMethod {
            param($Uri, $TimeoutSec, [switch]$UseBasicParsing)
            if ([string]$Uri -like '*/json/close/*') { $script:closed += ([string]$Uri).Split('/')[-1]; return 'Target is closing' }
            if ([string]$Uri -like '*/json/version') { return [pscustomobject]@{ webSocketDebuggerUrl = 'ws://test/browser' } }
            throw "unexpected $Uri"
        }
        function Invoke-KoseiCdpMethod {
            param($WebSocketUrl, $Method, $Params, $TimeoutSeconds)
            if ($Method -ne 'Target.createTarget') { throw "unexpected $Method" }
            $script:created++
            [pscustomobject]@{ result = [pscustomobject]@{ targetId = 'new' } }
        }
        function Wait-KoseiCopilotInputReady { $true }
        function Get-KoseiCopilotLaunchContext { [pscustomobject]@{ present = $true; valid = $true; id = ('a' * 32) } }
        function Get-KoseiCopilotSessionDescriptor { [pscustomobject]@{ target_id = 'old'; launch_id = ('a' * 32) } }
        function Write-KoseiCopilotSessionDescriptor { param($Settings, $TargetId, $LaunchId) $script:descriptorTarget = $TargetId }
        $page = [pscustomobject]@{ id = 'old'; url = 'https://m365.cloud.microsoft/chat/'; webSocketDebuggerUrl = 'ws://test/old' }
        $workerPages = @($page)
        $result = Restore-KoseiCopilotPage -Settings $settings -Page $page
        if ($case -eq 'same-target') {
            Assert-Case (-not $result.replaced -and $page.id -eq 'old' -and $script:created -eq 0 -and $script:closed.Count -eq 0 -and $script:edgeStarts -eq 1) 'restore reuses a live, readable target'
        } else {
            Assert-Case ($result.replaced -and $script:created -eq 1 -and $script:closed -contains 'old') 'restore opens one new window and closes the dead target'
            Assert-Case ($workerPages[0].id -eq 'new' -and $workerPages[0].webSocketDebuggerUrl -eq 'ws://test/new') 'restore rewrites the shared page object for later packets and cleanup'
            Assert-Case ($script:descriptorTarget -eq 'new') 'launch-owned descriptor follows the replacement window'
        }
    }
}

# --- 5. パケット: CDP エラーは復旧して続行、使い切ったら入力保持・ワーカー停止 ----------
. (Join-Path $src 'Paths.ps1'); Set-KoseiRoot $root
. (Join-Path $src 'CopilotClient.ps1')
. (Join-Path $src 'ReviewJob.ps1')
function Write-KoseiLog { param($Message, $Level) }
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('kosei-cdpmidrun-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($temp)
try {
    $answers = Join-Path $temp 'answers'; $null = [IO.Directory]::CreateDirectory($answers)
    $promptPath = Join-Path $temp 'PROMPT_SEC_001.txt'; [IO.File]::WriteAllText($promptPath, 'prompt')
    $textPath = Join-Path $temp 'TEXT_SEC_001.txt'; [IO.File]::WriteAllText($textPath, 'text')
    $newPacket = {
        [hashtable]::Synchronized(@{
            packet_id='SEC_001'; target_pages=@(1,2); prompt_path=$promptPath; prompt_sha256=(Get-KoseiFileSha256 -Path $promptPath)
            text_path=$textPath; text_sha256=(Get-KoseiFileSha256 -Path $textPath); pdf_path=''; pdf_sha256=''
            status='running'; phase=''; detail=''; raw_answer=''; completed_by=''; elapsed_ms=0; total_elapsed_ms=0; phase_timings=$null; response_wait_ms=0
            findings_count=0; pages_checked=@(); coverage=0.0; warning=''; verification_state=''; error=''
        })
    }
    $newState = { [hashtable]::Synchronized(@{ id='0123456789abcdef0123456789abcdef'; attach_mode='masked-text'; phase=''; updated_at=''; cancel_requested=$false; packets_done=0; input_retained_for_resume=$false }) }
    $settings = [pscustomobject]@{ response_end_marker='KOSEI_END' }
    $okJson = '{"packet_id":"SEC_001","findings":[],"checked_pages":[1,2],"checked_pages_all":true}'
    function Invoke-KoseiCopilotReviewRequest {
        param($Settings, $Prompt, $AttachPaths, $ChatMode, $OnPhase, $ShouldCancel, $OnWaitProgress, $ExpectedPages, $ExpectedPacketId, $Page, $Marker)
        $script:requests++
        $script:pagesSeen += [string]$Page.id
        if ($script:requests -le $script:failFirst) {
            $inner = New-Object System.Exception('CDP WebSocket受信失敗: The remote party closed the WebSocket connection without completing the close handshake.')
            $e = New-KoseiFailureException -Kind 'cdp_transport' -InnerException $inner -Message 'Copilot（Edge）との接続でエラーが発生しました（段階: waiting）'
            throw $e
        }
        return [pscustomobject]@{ ok=$true; completedBy='marker'; json=$okJson; rawJson=($okJson + ' KOSEI_END'); elapsedMs=1; pagesChecked=@(1,2); coverage=1.0; fixes=@(); findingsCount=0; warning='' }
    }
    function Restore-KoseiCopilotPage {
        param($Settings, $Page, $ReadyTimeoutSeconds)
        $script:restores++
        if ($null -ne $Page) { $Page.id = 'replacement-' + $script:restores }
        [pscustomobject]@{ page=$Page; replaced=$true; reason='new-target' }
    }

    # 5a. 1回切れても、ページを復旧して同じパケットを完了する。
    $script:requests = 0; $script:restores = 0; $script:failFirst = 1; $script:pagesSeen = @()
    $packet = & $newPacket; $state = & $newState
    $page = [pscustomobject]@{ id='worker-1'; webSocketDebuggerUrl='ws://test/worker-1'; url='https://m365.cloud.microsoft/chat/' }
    $fatal = Invoke-KoseiPacket -Packet $packet -State $state -Settings $settings -ReviewFlags ([pscustomobject]@{ review_engine='legacy' }) -AnswersDir $answers -PacketIndex 1 -Page $page
    Assert-Case ($script:requests -eq 2 -and $script:restores -eq 1) 'packet retries once after restoring the page'
    Assert-Case ($script:pagesSeen[1] -eq 'replacement-1') 'retry uses the restored page'
    Assert-Case (@('done','warning') -contains [string]$packet.status -and -not $fatal -and -not [bool]$state.input_retained_for_resume) 'recovered packet completes without stopping the worker'

    # 5b. 復旧を使い切ったら cdp_reconnect_required 相当: 入力保持・ワーカー停止・分かる文言。
    $script:requests = 0; $script:restores = 0; $script:failFirst = 99; $script:pagesSeen = @()
    $packet = & $newPacket; $state = & $newState
    $page = [pscustomobject]@{ id='worker-1'; webSocketDebuggerUrl='ws://test/worker-1'; url='https://m365.cloud.microsoft/chat/' }
    $fatal = Invoke-KoseiPacket -Packet $packet -State $state -Settings $settings -ReviewFlags ([pscustomobject]@{ review_engine='legacy' }) -AnswersDir $answers -PacketIndex 1 -Page $page
    Assert-Case ($script:requests -eq 3 -and $script:restores -eq 2) 'recovery is bounded (initial + 2 restores)'
    Assert-Case ([string]$packet.status -eq 'error' -and $fatal -and [bool]$state.input_retained_for_resume) 'exhausted recovery retains input and stops the worker'
    Assert-Case ([string]$packet.error -like '*接続が切れ*再起動*' -and [string]$packet.error -like '*remote party closed*') 'packet error explains the CDP loss, next step and cause'

    # 5c. 中止要求中は再接続を試みない。
    $script:requests = 0; $script:restores = 0; $script:failFirst = 99
    $packet = & $newPacket; $state = & $newState; $state.cancel_requested = $true
    $null = Invoke-KoseiPacket -Packet $packet -State $state -Settings $settings -ReviewFlags ([pscustomobject]@{ review_engine='legacy' }) -AnswersDir $answers -PacketIndex 1 -Page $page
    Assert-Case ($script:requests -eq 1 -and $script:restores -eq 0) 'cancel request suppresses reconnect attempts'

    # 5d. 打ち切ったワーカーの残りパケットは「CDP を復旧できなかった」と分かる文言になる。
    $shared = [hashtable]::Synchronized(@{ worker_stop=[hashtable]::Synchronized(@{}); stop_reasons=[hashtable]::Synchronized(@{ '0'='cdp_unrecoverable' }); heartbeats=[hashtable]::Synchronized(@{ '0'=(Get-Date).ToString('o') }); active=[hashtable]::Synchronized(@{ '0'=$true }) })
    $leftState = [hashtable]::Synchronized(@{ id='0123456789abcdef0123456789abcdef'; cancel_requested=$false; packets_done=0; per_packet=@([pscustomobject]@{ packet_id='SEC_002'; status='queued'; error='' }) })
    $ps = [powershell]::Create(); $null = $ps.AddScript({ 1 })
    $handle = @{ PowerShell=$ps; Async=$ps.BeginInvoke(); Worker=0; Indices=@(0) }
    while (-not $handle.Async.IsCompleted) { [System.Threading.Thread]::Sleep(10) }
    function Copy-KoseiPacketTerminalSnapshot { param($Packet, $Status, $Error) [pscustomobject]@{ packet_id=$Packet.packet_id; status=$Status; error=$Error } }
    Wait-KoseiWorkerHandles -Handles @($handle) -State $leftState -Shared $shared -SkipJournal
    Assert-Case ([string]$leftState.per_packet[0].status -eq 'error' -and [string]$leftState.per_packet[0].error -like '*接続を復旧できなかった*再起動*') 'leftover packets of a CDP-stopped worker get an actionable message'
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-cdpmidrun-[0-9a-f]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

# --- 6. 多パス追撃中の切断は残りを打ち切り、パケットは警告で終える ----------------------
& {
    $script:requests = 0; $script:restores = 0
    $temp2 = Join-Path ([IO.Path]::GetTempPath()) ('kosei-cdpmidrun-' + [guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($temp2)
    try {
        $answers2 = Join-Path $temp2 'answers'; $null = [IO.Directory]::CreateDirectory($answers2)
        $p2 = Join-Path $temp2 'PROMPT.txt'; [IO.File]::WriteAllText($p2, 'prompt')
        $t2 = Join-Path $temp2 'TEXT.txt'; [IO.File]::WriteAllText($t2, 'text')
        $packet = [hashtable]::Synchronized(@{
            packet_id='SEC_001'; kind='proofread'; profile=''; has_ref=$false; target_pages=@(1,2); prompt_path=$p2; prompt_sha256=(Get-KoseiFileSha256 -Path $p2)
            text_path=$t2; text_sha256=(Get-KoseiFileSha256 -Path $t2); pdf_path=''; pdf_sha256=''
            status='running'; phase=''; detail=''; raw_answer=''; completed_by=''; elapsed_ms=0; total_elapsed_ms=0; phase_timings=$null; response_wait_ms=0
            findings_count=0; pages_checked=@(); coverage=0.0; warning=''; verification_state=''; error=''; passes=@()
        })
        $state = [hashtable]::Synchronized(@{ id='0123456789abcdef0123456789abcdef'; attach_mode='masked-text'; phase=''; updated_at=''; cancel_requested=$false; packets_done=0; input_retained_for_resume=$false; per_packet=@($packet) })
        $okJson = '{"packet_id":"SEC_001","findings":[],"checked_pages":[1,2],"checked_pages_all":true}'
        function Invoke-KoseiCopilotReviewRequest {
            param($Settings, $Prompt, $AttachPaths, $ChatMode, $OnPhase, $ShouldCancel, $OnWaitProgress, $ExpectedPages, $ExpectedPacketId, $Page, $Marker)
            $script:requests++
            if ($ChatMode -eq 'Reuse') { throw (New-KoseiFailureException -Kind 'cdp_transport' -Message 'Copilot（Edge）との接続でエラーが発生しました（段階: waiting）') }
            return [pscustomobject]@{ ok=$true; completedBy='marker'; json=$okJson; rawJson=($okJson + ' KOSEI_END'); elapsedMs=1; pagesChecked=@(1,2); coverage=1.0; fixes=@(); findingsCount=0; warning='' }
        }
        function Get-KoseiPassSchedule { [pscustomobject]@{ passes=@([pscustomobject]@{pass_index=0;kind='broad';lens='broad'},[pscustomobject]@{pass_index=1;kind='lens';lens='a'},[pscustomobject]@{pass_index=2;kind='lens';lens='b'},[pscustomobject]@{pass_index=3;kind='gap';lens='gap'}); skipped=@() } }
        $settings = [pscustomobject]@{ response_end_marker='KOSEI_END'; review_max_passes=4 }
        $flags = [pscustomobject]@{ review_engine='multipass'; review_profile_single='x'; review_gap_pass=$true }
        $page = [pscustomobject]@{ id='worker-1'; webSocketDebuggerUrl='ws://test/worker-1'; url='https://m365.cloud.microsoft/chat/' }
        $fatal = Invoke-KoseiPacket -Packet $packet -State $state -Settings $settings -ReviewFlags $flags -AnswersDir $answers2 -PacketIndex 1 -Page $page
        Assert-Case ($script:requests -eq 2 -and $script:restores -eq 1) 'multipass stops follow-ups after a CDP loss and restores the page once'
        Assert-Case ([string]$packet.status -eq 'warning' -and -not $fatal -and [string]$packet.warning -like '*接続が切れた*') 'packet ends as warning (not a dead job) with a clear reason'
    } finally {
        $resolved = [IO.Path]::GetFullPath($temp2)
        if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-cdpmidrun-[0-9a-f]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
Write-Host "Test-CdpMidrunRecovery: PASS ($script:checks checks)"
