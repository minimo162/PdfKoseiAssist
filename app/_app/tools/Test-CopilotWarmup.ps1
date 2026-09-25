$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/CopilotClient.ps1')
$script:starts=0;$script:writes=0;$script:waits=0;$script:states=New-Object 'System.Collections.Generic.List[string]'
function Start-KoseiCopilotEdge {param($Settings,[switch]$FreshLaunchTarget) if(!$FreshLaunchTarget){throw 'Ordinary launch must be fresh'};$script:starts++}
function Get-KoseiCopilotPage {param($Settings) return @{webSocketDebuggerUrl='ws://fixture'}}
function Set-KoseiEdgeWindowMinimized {param($Settings,$Page,$Reason)}
function Write-KoseiWarmupStatus {param($State,$Detail) $script:writes++}
function Wait-KoseiCopilotInputReady {
    param($WsUrl,$Settings,$TimeoutSeconds,$OnWaiting,$ShouldCancel)
    $script:waits++;$script:timeout=$TimeoutSeconds
    if($ShouldCancel -and (& $ShouldCancel)){throw 'cancelled'}
    & $OnWaiting 'https://login.microsoftonline.com/'
    return $true
}
$result=Invoke-KoseiCopilotWarmup -Settings @{} -OnState {param($State,$Detail) $script:states.Add($State)}
if($result.state -ne 'ready' -or $script:starts -ne 1 -or $script:timeout -ne 300 -or $script:states -notcontains 'signin_required'){throw 'Normal warmup changed'}
$before=$script:writes
$result=Invoke-KoseiCopilotWarmup -Settings @{} -ReuseExisting -PublishStatus:$false -TimeoutSeconds 600
if($result.state -ne 'ready' -or $script:starts -ne 1 -or $script:writes -ne $before -or $script:timeout -ne 600){throw 'Shared server warmup was replaced or overwritten'}
$result=Invoke-KoseiCopilotWarmup -Settings @{} -ReuseExisting -PublishStatus:$false -ShouldCancel {$true}
if($result.state -ne 'error' -or $result.detail -ne 'cancelled'){throw 'Warmup cancellation not propagated'}
Write-Host 'PASS CopilotWarmup (mocked browser, startup and shared-state contracts)'
