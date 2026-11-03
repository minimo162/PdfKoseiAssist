$ErrorActionPreference = 'Stop'
# 「CDP応答タイムアウト：Runtime.evaluate」の再発対策（v2）。
#   - 応答タイムアウトのとき、ダイアログ・凍結をブラウザ側から外して診断をログへ残す
#   - 送信前の段（新規チャット・残留添付の削除・送信クリック・添付入力）でパケットを落とさない
#   - ただしクリック・送信・ファイル設定は二重にしない
# 実際の Edge は起動しない。WebSocket の境目だけを差し替え、製品の CopilotClient.ps1 の関数をそのまま通す。
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'src'
$script:checks = 0
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $script:checks++; Write-Host "PASS $Name"
}

# 偽の CDP 接続。送ったメソッドを接続ごとに記録し、$script:respond で応答を決める
# （$null を返すと応答タイムアウト。本物の Invoke-KoseiCdpOnSocket と同じ文言で投げる）。
# 送受信そのものの経路は Test-CdpEvalTimeout.ps1 の 3. が本物の Invoke-KoseiCdpOnSocket で確かめている。
# 製品の関数を読み込んだのと同じスコープで `. $installFakeCdp` として差し替える。
$installFakeCdp = {
    $script:connects = 0
    $script:sent = New-Object System.Collections.Generic.List[object]
    function Connect-KoseiWebSocket {
        param($WebSocketUrl, $TimeoutSeconds)
        $script:connects++
        $ws = [pscustomobject]@{ Attempt = $script:connects }
        $ws | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        return $ws
    }
    function Invoke-KoseiCdpOnSocket {
        param($WebSocket, [string]$Method, [hashtable]$Params = @{}, [int]$TimeoutSeconds = 30)
        $script:sent.Add([pscustomobject]@{ attempt = $WebSocket.Attempt; method = $Method; params = $Params })
        $body = & $script:respond $WebSocket.Attempt $Method $Params
        if ($null -eq $body) { throw "CDP応答タイムアウト: $Method" }
        return ($body | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json)
    }
}
function Get-SentMethods { param([string]$Method) @($script:sent | Where-Object { $_.method -eq $Method }) }

# --- 1. 解除: ダイアログを閉じ、凍結を解き、応答を確かめて、結果をログへ残す --------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    . $installFakeCdp
    $script:respond = { param($attempt, $method, $params) @{ result = @{ result = @{ value = 1 } } } }
    $r = Invoke-KoseiCdpPageUnblock -WebSocketUrl 'ws://t/p1' -Caller 'Invoke-KoseiFreshChat'
    Assert-Case ($r.dialog -eq 'dismissed' -and $r.lifecycle -eq 'active' -and $r.probe -eq 'responsive') 'unblock reports a dismissed dialog, an active page and a responsive probe'
    $methods = @($script:sent | ForEach-Object { $_.method }) -join ','
    Assert-Case ($methods -eq 'Page.handleJavaScriptDialog,Page.setWebLifecycleState,Runtime.evaluate') "unblock uses browser-side methods before the probe ($methods)"
    $dialogParams = @(Get-SentMethods 'Page.handleJavaScriptDialog')[0].params
    $lifecycleParams = @(Get-SentMethods 'Page.setWebLifecycleState')[0].params
    Assert-Case ($dialogParams.accept -eq $true -and [string]$lifecycleParams.state -eq 'active') 'dialog is accepted and the lifecycle is set to active'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*CDP応答タイムアウトの診断*caller=Invoke-KoseiFreshChat*dialog=dismissed*' }).Count -eq 1) 'diagnosis is logged with the caller'

    # 同じページへは30秒に1回まで（回答待機で毎回払わない）。別のページは別に数える。
    $before = $script:connects
    $again = Invoke-KoseiCdpPageUnblock -WebSocketUrl 'ws://t/p1'
    Assert-Case ($again.skipped -eq $true -and $script:connects -eq $before) 'second unblock of the same page within the interval is skipped'
    $script:respond = { param($attempt, $method, $params)
        if ($method -eq 'Page.handleJavaScriptDialog') { return @{ error = @{ code = -32000; message = 'No dialog is showing' } } }
        if ($method -eq 'Runtime.evaluate') { return $null }
        @{ result = @{} }
    }
    $other = Invoke-KoseiCdpPageUnblock -WebSocketUrl 'ws://t/p2' -StepTimeoutSeconds 1
    Assert-Case ($other.skipped -eq $false -and $other.dialog -eq 'none' -and $other.probe -eq 'busy') 'no dialog and a still-busy page are reported as such'
}

# --- 2. Invoke-KoseiCdpEval: 応答タイムアウトのときだけ解除を試し、元の例外をそのまま投げる -----
& {
    . (Join-Path $src 'CopilotClient.ps1')
    function Write-KoseiLog {}
    $script:unblocks = New-Object System.Collections.Generic.List[string]
    function Invoke-KoseiCdpPageUnblock { param($WebSocketUrl, $Caller) $script:unblocks.Add([string]$Caller) }
    function Invoke-KoseiCdpMethod { param($WebSocketUrl, $Method, $Params, $TimeoutSeconds) throw (New-KoseiFailureException -Kind 'cdp_transport' -Message 'CDP応答タイムアウト: Runtime.evaluate') }
    function Test-Caller { Invoke-KoseiCdpEval -WebSocketUrl 'ws://t/p' -Expression '1' -TimeoutSeconds 1 }
    $kind = ''; $message = ''
    try { $null = Test-Caller } catch { $kind = [string]$_.Exception.Data['KoseiFailureKind']; $message = $_.Exception.Message }
    Assert-Case ($script:unblocks.Count -eq 1 -and $script:unblocks[0] -eq 'Test-Caller') 'response timeout triggers one unblock naming the caller'
    Assert-Case ($message -like 'CDP応答タイムアウト*' -and $kind -eq 'cdp_transport') 'original timeout (and its #233 failure kind) is rethrown'

    $script:unblocks.Clear()
    function Invoke-KoseiCdpMethod { param($WebSocketUrl, $Method, $Params, $TimeoutSeconds) throw 'CDP WebSocket受信失敗: closed' }
    try { $null = Test-Caller } catch {}
    Assert-Case ($script:unblocks.Count -eq 0) 'socket failures do not trigger the unblock'
    function Invoke-KoseiCdpMethod { param($WebSocketUrl, $Method, $Params, $TimeoutSeconds) [pscustomobject]@{ result = [pscustomobject]@{ exceptionDetails = @{ text = 'boom' } } } }
    try { $null = Test-Caller } catch {}
    Assert-Case ($script:unblocks.Count -eq 0) 'page-side JS exceptions do not trigger the unblock'
}

# --- 3. 新規チャット: クリックが応答しなければ Page.navigate で入れ直す（投げない） ---------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    function Start-Sleep {}
    $script:evals = 0
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) $script:evals++; throw 'CDP応答タイムアウト: Runtime.evaluate' }
    $script:navigated = @()
    function Invoke-KoseiCdpMethod { param($WebSocketUrl, $Method, $Params, $TimeoutSeconds) $script:navigated += $Method; [pscustomobject]@{ result = @{} } }
    $result = Invoke-KoseiFreshChat -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($script:evals -eq 1) 'new-chat click is not repeated'
    Assert-Case (($script:navigated -join ',') -eq 'Page.navigate' -and $result.clicked -eq $false) 'click timeout falls back to Page.navigate'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*新規チャットボタンのクリックが応答タイムアウト*' }).Count -eq 1) 'fallback is logged as WARN'

    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) throw 'JavaScript evaluation failed: {}' }
    $message = ''
    try { $null = Invoke-KoseiFreshChat -WsUrl 'ws://t/p' -Settings $settings } catch { $message = $_.Exception.Message }
    Assert-Case ($message -like 'JavaScript evaluation failed*') 'other new-chat failures still throw'
}

# --- 4. 送信クリック: やり直さない。入力欄が空なら送信済みとして進み、残っていれば止める -------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    function Assert-KoseiPromptSendAllowed {}
    $script:clicks = 0
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) $script:clicks++; throw 'CDP応答タイムアウト: Runtime.evaluate' }

    function Get-KoseiChatInputTextLength { 0 }
    $r = Invoke-KoseiClickSend -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($script:clicks -eq 1 -and $r.clicked -eq $true -and [string]$r.confirmedBy -eq 'input-cleared') 'empty input after a click timeout counts as sent, without clicking again'

    $script:clicks = 0
    function Get-KoseiChatInputTextLength { 4200 }
    $message = ''
    try { $null = Invoke-KoseiClickSend -WsUrl 'ws://t/p' -Settings $settings } catch { $message = $_.Exception.Message }
    Assert-Case ($script:clicks -eq 1 -and $message -like 'CDP応答タイムアウト*') 'prompt still in the input: stop with the original timeout and no second click'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'ERROR*送信クリックが応答タイムアウト*inputLen=4200*' }).Count -eq 1) 'unconfirmed send is logged as ERROR'

    $script:clicks = 0
    function Get-KoseiChatInputTextLength { throw 'CDP応答タイムアウト: Runtime.evaluate' }
    $message = ''
    try { $null = Invoke-KoseiClickSend -WsUrl 'ws://t/p' -Settings $settings } catch { $message = $_.Exception.Message }
    Assert-Case ($script:clicks -eq 1 -and $message -like 'CDP応答タイムアウト*') 'unreadable input: stop and do not click again'
}

# --- 5. 残留添付の削除: クリックが応答しなくても、削除後の状態確認へ進む ---------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    function Write-KoseiLog {}
    function Start-Sleep {}
    $script:snaps = 0
    function Get-KoseiAttachmentSnapshot { param($WsUrl, $Settings, $ExpectedNames) $script:snaps++; if ($script:snaps -eq 1) { [pscustomobject]@{ count = 1; items = @([pscustomobject]@{ name = 'old.txt' }) } } else { [pscustomobject]@{ count = 0; items = @() } } }
    function Invoke-KoseiCdpEval { param($WebSocketUrl, $Expression, $TimeoutSeconds) throw 'CDP応答タイムアウト: Runtime.evaluate' }
    $after = Clear-KoseiResidualAttachments -WsUrl 'ws://t/p' -Settings $settings
    Assert-Case ($script:snaps -eq 2 -and [int]$after.count -eq 0) 'residual-attachment click timeout continues to the follow-up snapshot'
}

# --- 6. 添付入力: ファイルを設定する前の応答タイムアウトだけ1回やり直す -------------------
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    $script:logs = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:logs.Add("$Level $Message") }
    function Start-Sleep {}
    function Invoke-KoseiCdpPageUnblock { param($WebSocketUrl, $Caller) }
    $origin = ([Uri]$settings.copilot_url).GetLeftPart([UriPartial]::Authority)
    . $installFakeCdp
    # 1本目の接続では DOM.getDocument が返らない。2本目はすべて返る。
    $script:respond = { param($attempt, $method, $params)
        if ($attempt -eq 1 -and $method -eq 'DOM.getDocument') { return $null }
        switch ($method) {
            'DOM.getDocument' { return @{ result = @{ root = @{ nodeId = 1 } } } }
            'DOM.querySelector' { return @{ result = @{ nodeId = 7 } } }
            'Runtime.evaluate' { return @{ result = @{ result = @{ value = $origin } } } }
            default { return @{ result = @{} } }
        }
    }
    $r = Invoke-KoseiSetFileInputFile -WsUrl 'ws://t/p' -Settings $settings -File 'C:\x\packet.txt'
    Assert-Case ($r.ok -eq $true -and $script:connects -eq 2) 'timeout while locating the file input is retried on a fresh connection'
    Assert-Case (@(Get-SentMethods 'DOM.setFileInputFiles').Count -eq 1) 'file is set exactly once'
    Assert-Case (@($script:logs | Where-Object { $_ -like 'WARN*添付入力の準備中にCDP応答タイムアウト*' }).Count -eq 1) 'retry is logged as WARN'

    # DOM.setFileInputFiles を送った後の応答タイムアウトはやり直さない（同じファイルが2つ付く）。
    . $installFakeCdp
    $script:respond = { param($attempt, $method, $params)
        switch ($method) {
            'DOM.getDocument' { return @{ result = @{ root = @{ nodeId = 1 } } } }
            'DOM.querySelector' { return @{ result = @{ nodeId = 7 } } }
            'Runtime.evaluate' { return @{ result = @{ result = @{ value = $origin } } } }
            'DOM.setFileInputFiles' { return $null }
            default { return @{ result = @{} } }
        }
    }
    $message = ''
    try { $null = Invoke-KoseiSetFileInputFile -WsUrl 'ws://t/p' -Settings $settings -File 'C:\x\packet.txt' } catch { $message = $_.Exception.Message }
    Assert-Case ($message -like 'CDP応答タイムアウト*DOM.setFileInputFiles*' -and @(Get-SentMethods 'DOM.setFileInputFiles').Count -eq 1 -and $script:connects -eq 1) 'timeout after setting the file is not retried'
}

Write-Host "Test-CdpPageUnblock: $script:checks checks passed"
