# Issue #139 / #110: use real lifecycle functions with isolated CDP/process boundaries.
$ErrorActionPreference='Stop'
$src=Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
$script:checks=0
function Assert-Edge([bool]$Value,[string]$Name) {
    if(-not $Value){throw $Name}; $script:checks++; Write-Host "PASS $Name"
}

& {
    . (Join-Path $src 'CopilotClient.ps1')
    $settings=@{cdp_port=1;copilot_url='https://example.invalid/';browser_display_mode='minimized'}
    $script:touched=@(); $script:failNext=$false
    function Write-KoseiLog {}
    function Get-KoseiCopilotPage { throw 'must not substitute primary' }
    function Get-KoseiCdpTargets {
        foreach($id in @('primary','worker-a','worker-b','retry')){
            [pscustomobject]@{id=$id;type='page';url='https://example.invalid/';webSocketDebuggerUrl="ws://fixture/$id"}
        }
    }
    function Invoke-RestMethod { [pscustomobject]@{webSocketDebuggerUrl='ws://fixture/browser'} }
    function Connect-KoseiWebSocket { [IO.MemoryStream]::new() }
    function Invoke-KoseiCdpOnSocket {
        param($WebSocket,$Method,$Params,$TimeoutSeconds)
        if($Method -eq 'Browser.getWindowForTarget'){
            $script:touched += $Params.targetId
            if($script:failNext){$script:failNext=$false;throw 'transient window error'}
            return [pscustomobject]@{result=@{windowId=10}}
        }
        [pscustomobject]@{result=@{}}
    }
    Assert-Edge (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/worker-a') 'reset worker-a'
    Assert-Edge (-not (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/worker-a')) 'successful same target reset suppressed'
    Assert-Edge (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/worker-b') 'different worker reset permitted'
    Assert-Edge (($script:touched -join ',') -eq 'worker-a,worker-b') 'only requested workers touched'
    $script:failNext=$true
    Assert-Edge (-not (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/retry')) 'failed reset reported'
    Assert-Edge (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/retry') 'failed reset can retry'
    $count=$script:touched.Count
    Assert-Edge (-not (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/missing')) 'missing target not replaced'
    $settings.browser_display_mode='foreground'
    Assert-Edge (-not (Reset-KoseiEdgeWindowStateForDetection -Settings $settings -WsUrl 'ws://fixture/primary')) 'foreground left alone'
    Assert-Edge ($script:touched.Count -eq $count) 'missing/foreground perform no window command'
}

foreach($case in @('success','descriptor-failure','discovery-failure','create-failure','cleanup-failure','reuse')) {
    & {
        . (Join-Path $src 'CopilotClient.ps1')
        $settings=@{cdp_port=1;copilot_url='https://example.invalid/';browser_display_mode='foreground'}
        $script:created=0; $script:closed=@()
        function Write-KoseiLog {}
        function Start-Sleep {}
        function Get-KoseiCopilotLaunchContext { [pscustomobject]@{present=($case -eq 'reuse');valid=$true;id='fixture'} }
        function Get-KoseiCopilotSessionDescriptor { [pscustomobject]@{launch_id='fixture';target_id='owned'} }
        function Test-KoseiDevTools { $true }
        function Invoke-RestMethod { [pscustomobject]@{webSocketDebuggerUrl='ws://fixture/browser'} }
        function Invoke-KoseiCdpMethod {
            param($WebSocketUrl,$Method,$Params,$TimeoutSeconds)
            if($Method -eq 'Target.createTarget'){
                if($case -eq 'create-failure'){throw 'create failed'}
                $script:created++; return [pscustomobject]@{result=@{targetId='owned'}}
            }
            if($Method -eq 'Target.closeTarget'){
                $script:closed += $Params.targetId
                if($case -eq 'cleanup-failure'){throw 'cleanup failed'}
                return [pscustomobject]@{result=@{success=$true}}
            }
            throw "unexpected method $Method"
        }
        function Get-KoseiCdpTargets {
            if($case -eq 'discovery-failure'){return @()}
            [pscustomobject]@{id='owned';type='page';url='https://example.invalid/';webSocketDebuggerUrl='ws://fixture/owned'}
        }
        function Write-KoseiCopilotSessionDescriptor {
            if($case -in @('descriptor-failure','cleanup-failure')){throw 'descriptor failed'}
        }
        $errorText=''; $result=$null
        try{$result=New-KoseiCopilotLaunchTarget -Settings $settings}catch{$errorText=$_.Exception.Message}
        switch($case){
            'success' {Assert-Edge ($result.id -eq 'owned' -and $script:closed.Count -eq 0) 'successful launch retains target'}
            'reuse' {Assert-Edge ($result.id -eq 'owned' -and $script:created -eq 0 -and $script:closed.Count -eq 0) 'reuse neither creates nor closes'}
            'create-failure' {Assert-Edge ($errorText -eq 'create failed' -and $script:closed.Count -eq 0) 'failed create closes nothing'}
            'discovery-failure' {Assert-Edge ($errorText -ne '' -and ($script:closed -join ',') -eq 'owned') 'discovery failure rolls back only new target'}
            default {Assert-Edge ($errorText -eq 'descriptor failed' -and ($script:closed -join ',') -eq 'owned') "$case retains original error and rolls back"}
        }
    }
}

# Verify the exact argv Windows creates, including the standalone attach tool.
$tempRoot=Join-Path ([IO.Path]::GetTempPath()) ('kosei-edge139-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $probe=Join-Path $tempRoot 'argv.js'
    [IO.File]::WriteAllText($probe,'console.log(JSON.stringify(process.argv.slice(2)));')
    foreach($case in @('foreground','minimized','fallback','attach-tool')){
        & {
            . (Join-Path $src 'CopilotClient.ps1')
            if($case -eq 'attach-tool'){
                $tokens=$null;$errors=$null
                $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Test-CopilotAttach.ps1'),[ref]$tokens,[ref]$errors)
                $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-KoseiCopilotEdge'},$true)
                Invoke-Expression $fn.Extent.Text
            }
            $profile=Join-Path $tempRoot 'テスト User\edge-profile'
            $settings=@{cdp_port=1;copilot_url='https://example.invalid/';browser_display_mode=$(if($case -eq 'foreground'){'foreground'}else{'minimized'})}
            $script:launches=@()
            function Write-KoseiLog {}
            function Write-TestEvent {}
            function Test-KoseiDevTools { $false }
            function Wait-KoseiDevTools { $true }
            function Get-KoseiEdgePath { 'not-launched.exe' }
            function Get-KoseiEdgeProfileDir { $profile }
            function Register-KoseiExistingCopilotTarget {}
            function Get-KoseiCopilotPage { $null }
            function Set-KoseiEdgeWindowMinimized {}
            function Start-Process {
                param($FilePath,$ArgumentList,$WindowStyle)
                $script:launches += [pscustomobject]@{args=@($ArgumentList)}
                if($case -eq 'fallback' -and $script:launches.Count -eq 1){throw 'synthetic minimized launch failure'}
            }
            if($case -eq 'attach-tool'){Start-KoseiCopilotEdge -Port 1 -Url 'https://example.invalid/' -UserDataDir $profile}
            else{Start-KoseiCopilotEdge -Settings $settings}
            Assert-Edge ($script:launches.Count -eq $(if($case -eq 'fallback'){2}else{1})) "$case launch count"
            foreach($launch in $script:launches){
                $output=Join-Path $tempRoot 'argv.json'
                Microsoft.PowerShell.Management\Start-Process -FilePath (Get-Command node).Source -ArgumentList (@(('"'+$probe+'"')) + $launch.args) -WindowStyle Hidden -RedirectStandardOutput $output -Wait
                $argv=@(Get-Content -Raw -LiteralPath $output -Encoding UTF8 | ConvertFrom-Json)
                Assert-Edge (@($argv | Where-Object {$_ -eq ('--user-data-dir='+$profile)}).Count -eq 1) "$case profile arrives as one exact argument"
                Assert-Edge (-not @($argv | Where-Object {$_ -like '--remote-allow-origins=*'}).Count) "$case does not disable Origin restriction"
            }
        }
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($tempRoot)
    if(-not $resolved.StartsWith((Join-Path ([IO.Path]::GetTempPath()) 'kosei-edge139-'),[StringComparison]::OrdinalIgnoreCase)){throw 'unsafe test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host "Test-EdgeAutomation: PASS ($script:checks checks)"
