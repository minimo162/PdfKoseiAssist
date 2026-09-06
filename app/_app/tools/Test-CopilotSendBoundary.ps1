# Issue #137: production request/input/send/reconnect functions, isolated transport.
$ErrorActionPreference = 'Stop'
$src = Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
$script:checks = 0
function Assert-Case([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw $Name }
    $script:checks++; Write-Host "PASS $Name"
}

function Test-RequestCase([string]$Mode, [string]$Case) {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings = Get-KoseiDefaultSettings
    $page = [pscustomobject]@{id='worker-2';webSocketDebuggerUrl='ws://test/worker-2'}
    $script:origin='https://m365.cloud.microsoft'; $script:cancel=$false
    $script:inputLen=0; $script:chunks=0; $script:clicks=0; $script:sendAttempts=0; $script:retryClicks=0; $script:waits=0
    function Write-KoseiLog {}
    function Start-Sleep {}
    function Start-KoseiCopilotEdge {}
    function Get-KoseiCopilotPage { $page }
    function Invoke-KoseiFreshChat {}
    function Set-KoseiCopilotModel {}
    function Wait-KoseiCopilotScreenReady { [pscustomobject]@{ok=$true;cancelled=$false} }
    function Clear-KoseiChatInput { $script:inputLen=0 }
    function Invoke-KoseiFocusChatInput {}
    function Get-KoseiChatInputTextLength { $script:inputLen }
    function Get-KoseiMainText { '' }
    function Write-KoseiWarmupStatus {}
    function Write-KoseiRefusalStat {}
    function Invoke-KoseiCdpMethod {
        param($WebSocketUrl, $Method, $Params, $TimeoutSeconds)
        if ($Method -ne 'Input.insertText') { throw "unexpected method $Method" }
        $script:chunks++; $script:inputLen += $Params.text.Length
        if ($Case -eq 'cancel-chunk') { $script:cancel=$true }
        if ($Case -eq 'origin-chunk') { $script:origin='https://example.invalid' }
        if ($script:chunks -eq 3) {
            if ($Case -eq 'origin-after-input') { $script:origin='https://example.invalid' }
            if ($Case -eq 'cancel-after-input') { $script:cancel=$true }
        }
    }
    function Invoke-KoseiCdpEval {
        param($WebSocketUrl, $Expression, $TimeoutSeconds)
        if ($Expression -eq '(() => location.origin)()') { return $script:origin }
        if ($Expression -like '*clickable.sort*') {
            $script:sendAttempts++
            if ($Case -eq 'cancel-retry') { $script:cancel=$true; return '{"clicked":false,"candidates":[]}' }
            if ($Case -eq 'ambiguous-send') { throw 'CDP reply lost after click' }
            if ($Case -eq 'invalid-send-result') { return '{}' }
            $script:clicks++
            if ($Case -eq 'cancel-after-send') { $script:cancel=$true }
            return '{"clicked":true,"label":"Send"}'
        }
        if ($Expression -like '*buttons.reverse()*') {
            if ($Case -eq 'retry-fallback') { return 'false' }
            if ($Case -eq 'ambiguous-retry') { return $null }
            $script:retryClicks++; return 'true'
        }
        throw 'unexpected eval'
    }
    function Wait-KoseiCopilotReviewResponse {
        $script:waits++
        if ($Case -in @('retry-success','retry-fallback','ambiguous-retry') -and $script:waits -eq 1) {
            return [pscustomobject]@{ok=$false;completedBy='copilot-refusal';salvageText=''}
        }
        if ($Case -eq 'cancel-refusal-retry') {
            $script:cancel=$true
            return [pscustomobject]@{ok=$false;completedBy='copilot-refusal';salvageText=''}
        }
        if ($Case -eq 'origin-refusal-retry') {
            $script:origin='https://example.invalid'
            return [pscustomobject]@{ok=$false;completedBy='copilot-refusal';salvageText=''}
        }
        return [pscustomobject]@{ok=(-not $script:cancel);completedBy=$(if($script:cancel){'cancelled'}else{'marker'});elapsedMs=1}
    }
    $phase = {
        param($value)
        if ($value -eq 'sending') {
            if ($Case -eq 'cancel-before') { $script:cancel=$true }
            if ($Case -eq 'origin-before') { $script:origin='https://example.invalid' }
        }
    }
    $result=$null; $failure=$null
    try {
        $result=Invoke-KoseiCopilotReviewRequest -Settings $settings -Page $page -ChatMode $Mode -Prompt ('x'*6001) -ShouldCancel {$script:cancel} -OnPhase $phase
    } catch { $failure=$_ }
    $name="$Mode/$Case"
    switch ($Case) {
        'success' { Assert-Case ($result.ok -and $result.sent -and $script:chunks -eq 3 -and $script:clicks -eq 1) $name }
        'origin-before' { Assert-Case ($null -ne $failure -and $script:chunks -eq 0 -and $script:clicks -eq 0) $name }
        'origin-chunk' { Assert-Case ($null -ne $failure -and $script:chunks -eq 1 -and $script:clicks -eq 0) $name }
        'origin-after-input' { Assert-Case ($null -ne $failure -and $script:chunks -eq 3 -and $script:clicks -eq 0) $name }
        'cancel-before' { Assert-Case ($result.completedBy -eq 'cancelled' -and -not $result.sent -and $script:chunks -eq 0 -and $script:clicks -eq 0) $name }
        'cancel-chunk' { Assert-Case ($result.completedBy -eq 'cancelled' -and -not $result.sent -and $script:chunks -eq 1 -and $script:clicks -eq 0) $name }
        'cancel-after-input' { Assert-Case ($result.completedBy -eq 'cancelled' -and -not $result.sent -and $script:chunks -eq 3 -and $script:clicks -eq 0) $name }
        'cancel-retry' { Assert-Case ($result.completedBy -eq 'cancelled' -and -not $result.sent -and $script:sendAttempts -eq 1 -and $script:clicks -eq 0) $name }
        'cancel-after-send' { Assert-Case ($result.completedBy -eq 'cancelled' -and $result.sent -and $result.warning -and $script:clicks -eq 1) $name }
        'cancel-refusal-retry' { Assert-Case ($result.completedBy -eq 'cancelled' -and $result.sent -and $script:retryClicks -eq 0 -and $script:clicks -eq 1) $name }
        'origin-refusal-retry' { Assert-Case ($null -ne $failure -and $script:retryClicks -eq 0 -and $script:clicks -eq 1) $name }
        'ambiguous-send' { Assert-Case ($null -ne $failure -and $script:sendAttempts -eq 1) $name }
        'invalid-send-result' { Assert-Case ($null -ne $failure -and $script:sendAttempts -eq 1) $name }
        'retry-success' { Assert-Case ($result.ok -and $script:retryClicks -eq 1 -and $script:clicks -eq 1 -and $script:waits -eq 2) $name }
        'retry-fallback' { Assert-Case ($result.ok -and $script:retryClicks -eq 0 -and $script:clicks -eq 2 -and $script:chunks -eq 4) $name }
        'ambiguous-retry' { Assert-Case ($null -ne $failure -and $script:clicks -eq 1 -and $script:chunks -eq 3) $name }
    }
}
foreach ($mode in @('New','Reuse','RestartWithContext')) {
    foreach ($case in @('success','origin-before','origin-chunk','origin-after-input','cancel-before','cancel-chunk','cancel-after-input','cancel-retry','cancel-after-send','cancel-refusal-retry','origin-refusal-retry','ambiguous-send','invalid-send-result','retry-success','retry-fallback','ambiguous-retry')) {
        Test-RequestCase $mode $case
    }
}

# A read succeeds only after both discovery and the actual CDP operations work.
foreach ($case in @('websocket','evaluate','missing-target','transient')) {
    & {
        . (Join-Path $src 'CopilotClient.ps1')
        . (Join-Path $src 'Settings.ps1')
        $settings=Get-KoseiDefaultSettings
        $script:recoveries=0; $script:reads=0; $script:healthy=$false; $script:cancel=$false
        function Write-KoseiLog {}
        function Start-Sleep {}
        function Start-KoseiCopilotEdge {}
        function Get-KoseiCopilotPage { throw 'must never discover another worker' }
        function Get-KoseiCopilotPageById {
            param($Settings, $TargetId)
            Assert-Case ($TargetId -eq 'worker-2') "$case/same-target"
            $script:recoveries++
            if ($case -eq 'missing-target') { throw 'target gone' }
            if ($case -eq 'transient') { $script:healthy=$true }
            [pscustomobject]@{id='worker-2';webSocketDebuggerUrl='ws://test/worker-2'}
        }
        function Invoke-KoseiCdpMethod {
            param($WebSocketUrl, $Method, $Params, $TimeoutSeconds)
            $script:reads++
            if (-not $script:healthy) {
                if ($case -eq 'evaluate') {
                    return [pscustomobject]@{result=[pscustomobject]@{exceptionDetails=@{text='synthetic evaluation failure'}}}
                }
                throw 'synthetic WebSocket failure'
            }
            if ($Params.expression -like '*const e = document.querySelector*') {
                $script:cancel=$true; $value=''
            } else { $value='{"text":"","selectorIndex":0}' }
            [pscustomobject]@{result=[pscustomobject]@{result=[pscustomobject]@{value=$value}}}
        }
        function Get-KoseiMainResponseRegion { '' }
        function Invoke-KoseiClickStop {}
        $result=$null; $kind=''
        try {
            $result=Wait-KoseiCopilotReviewResponse -WsUrl 'ws://test/worker-2' -Settings $settings -BaselineLength 0 -TimeoutSeconds 30 -TargetId 'worker-2' -ShouldCancel {$script:cancel}
        } catch { $kind=[string]$_.Exception.Data['KoseiFailureKind'] }
        if ($case -eq 'transient') {
            Assert-Case ($kind -eq '' -and $script:recoveries -eq 1 -and $result.completedBy -eq 'cancelled') 'transient recovers using actual reads'
        } else {
            Assert-Case ($kind -eq 'cdp_reconnect_required' -and $script:recoveries -eq 2 -and $script:reads -lt 30) "$case bounded recovery failure"
        }
    }
}

# Sign-in discovery remains possible, but transmission resumes only on trusted origin.
& {
    . (Join-Path $src 'CopilotClient.ps1')
    . (Join-Path $src 'Settings.ps1')
    $settings=Get-KoseiDefaultSettings
    function Write-KoseiLog {}
    $script:origin='https://login.microsoftonline.com'
    function Get-KoseiCopilotScreenState { [pscustomobject]@{ready=$false;signin_required=$true} }
    function Invoke-KoseiCdpEval { $script:origin }
    $gate=Wait-KoseiCopilotScreenReady -WsUrl 'ws://test/worker-2' -Settings $settings
    Assert-Case ($gate.signin_required -and -not $gate.ok) 'sign-in remains an actionable state'
    $blocked=$false
    try { Assert-KoseiPromptSendAllowed -WsUrl 'ws://test/worker-2' -Settings $settings } catch { $blocked=$true }
    Assert-Case $blocked 'authentication origin cannot receive a prompt'
    $script:origin='https://m365.cloud.microsoft'
    Assert-KoseiPromptSendAllowed -WsUrl 'ws://test/worker-2' -Settings $settings
    Assert-Case $true 'trusted sign-in return permits prompt'
}
Write-Host "Test-CopilotSendBoundary: PASS ($script:checks checks)"
