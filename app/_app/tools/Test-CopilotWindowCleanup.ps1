$ErrorActionPreference='Stop'
# 起動のたびに作る Copilot の窓のうち、前の起動が残したものを閉じる（実機で専用 Edge の窓が3つ重なっていた）。
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src/Paths.ps1');Set-KoseiRoot $root
. (Join-Path $root 'src/Settings.ps1');. (Join-Path $root 'src/CopilotClient.ps1')
$settings=Get-KoseiDefaultSettings;$settings.cdp_port=60999;$settings.copilot_url='https://m365.cloud.microsoft/chat/'
function Write-KoseiLog {param($Message,$Level)}
$script:targets=@(
    [pscustomobject]@{id='new';type='page';url='https://m365.cloud.microsoft/chat/';webSocketDebuggerUrl='ws://x/new'},
    [pscustomobject]@{id='old-setup';type='page';url='https://m365.cloud.microsoft/chat/?auth=2';webSocketDebuggerUrl='ws://x/a'},
    [pscustomobject]@{id='old-signin';type='page';url='https://login.microsoftonline.com/common/oauth2';webSocketDebuggerUrl='ws://x/b'},
    [pscustomobject]@{id='app';type='page';url='http://127.0.0.1:8098/?drop=1';webSocketDebuggerUrl='ws://x/c'},
    [pscustomobject]@{id='other';type='page';url='https://example.com/';webSocketDebuggerUrl='ws://x/d'},
    [pscustomobject]@{id='sw';type='service_worker';url='https://m365.cloud.microsoft/sw.js';webSocketDebuggerUrl='ws://x/e'}
)
function Get-KoseiCdpTargets {param([int]$Port) return $script:targets}
$script:closedIds=@()
function Invoke-RestMethod {param($Uri,$TimeoutSec,[switch]$UseBasicParsing) if($Uri -notmatch '^http://127\.0\.0\.1:60999/json/close/(.+)$'){throw ('unexpected '+$Uri)};$script:closedIds+=$Matches[1]}
$count=Close-KoseiStaleCopilotWindows -Settings $settings -KeepTargetId 'new'
$closed=@($script:closedIds|Sort-Object)
if($count -ne 2 -or ($closed -join ',') -ne 'old-setup,old-signin'){throw ('Wrong windows closed: '+($closed -join ','))}
$script:closedIds=@()
if((Close-KoseiStaleCopilotWindows -Settings $settings -KeepTargetId '') -ne 0 -or $script:closedIds.Count){throw 'Closed windows without a window to keep'}
# 起動の2つの経路（Edge が動いていた／冷間起動）の両方で、新しい窓を用意したあとに閉じる。
$text=[IO.File]::ReadAllText((Join-Path $root 'src/CopilotClient.ps1'))
$start=[regex]::Match($text,'(?s)function Start-KoseiCopilotEdge \{(.*?)\n\}').Value
$calls=[regex]::Matches($start,'New-KoseiCopilotLaunchTarget -Settings \$Settings -Force\s*\}?\s*\r?\n\s*try \{ \$null = Close-KoseiStaleCopilotWindows')
if($calls.Count -ne 2){throw ('Stale windows are not closed on both fresh launch paths: '+$calls.Count)}
Write-Host 'PASS CopilotWindowCleanup'
