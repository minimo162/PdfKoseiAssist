$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src/Paths.ps1');Set-KoseiRoot $root
. (Join-Path $root 'src/SendToShortcut.ps1');. (Join-Path $root 'src/Setup.ps1')
$send=Join-Path ([IO.Path]::GetTempPath()) ('kosei-setup-'+[guid]::NewGuid().ToString('N'))
function Get-KoseiSettings {return @{server_ports=@(60001)}}
function Invoke-RestMethod {param($Uri,$TimeoutSec,[switch]$UseBasicParsing) if($script:mismatch){return @{ok=$true;version='1.0'}};throw 'offline'}
function Write-KoseiLog {param($Message,$Level)}
function Show-KoseiDesktopDialog {param($Message,$Buttons,$Icon) $script:message=$Message;return 'OK'}
function Show-KoseiSetupChoice {return $script:choice}
function Invoke-KoseiDesktopWorker {param($Shared,$Worker,$WorkerArguments,$ProgressTitle) $script:warmups++;$Shared.ExitCode=if($script:failWarmup){1}else{0};$Shared.Error=if($script:failWarmup){'test failure'}else{''}}
try {
    $script:warmups=0;$script:mismatch=$true
    if((Invoke-KoseiSetup $send) -ne 1 -or (Test-Path -LiteralPath $send)){throw 'Version mismatch did not stop before registering'}
    $script:mismatch=$false
    if((Invoke-KoseiSetup $send) -ne 0 -or !(Test-Path -LiteralPath (Get-KoseiSendToPath $send))){throw 'Initial registration failed'}
    $script:choice='Cancel';$before=$script:warmups
    if((Invoke-KoseiSetup $send) -ne 0 -or $script:warmups -ne $before){throw 'Cancel started warmup'}
    $script:choice='Register';$script:failWarmup=$true
    if((Invoke-KoseiSetup $send) -ne 1 -or !(Test-Path -LiteralPath (Get-KoseiSendToPath $send))){throw 'Warmup error removed registration'}
    $script:choice='Remove';$before=$script:warmups
    if((Invoke-KoseiSetup $send) -ne 0 -or $script:warmups -ne $before -or (Test-Path -LiteralPath (Get-KoseiSendToPath $send))){throw 'Removal started warmup or retained shortcut'}
    Write-Host 'PASS Setup (real isolated shortcuts; mocked dialogs/warmup)'
}finally{if(Test-Path -LiteralPath $send){$null=Remove-KoseiSendToShortcut $send;[IO.Directory]::Delete($send)}}
