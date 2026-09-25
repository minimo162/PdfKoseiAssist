$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DesktopUi.ps1')
Initialize-KoseiDesktopUi
if((ConvertTo-KoseiTrayText ('長い状況'*100)).Length -gt 63){throw 'Tooltip exceeds WinForms limit'}
$script:originalTray=${function:New-KoseiTrayContext}
function New-KoseiTrayContext {param($Shared) $script:testUi=& $script:originalTray $Shared;return $script:testUi}
function Show-KoseiDesktopDialog {param($Message,$Buttons,$Icon) $script:dialog=$Message;return 'Yes'}
$shared=[hashtable]::Synchronized(@{Status='testing';Error='';ExitCode=1;CancelRequested=$false;ShowCopilot=$false})
$probe=New-Object Windows.Forms.Timer
$probe.Interval=200
$script:latency=$null;$script:pulses=0;$script:clock=[Diagnostics.Stopwatch]::StartNew()
$probe.Add_Tick({
    $script:pulses++
    if($script:testUi -and $script:latency -eq $null){
        $script:latency=$script:clock.ElapsedMilliseconds
        $script:testUi.ShowItem.PerformClick()
        $script:testUi.CancelItem.PerformClick()
    }
})
try {
    $probe.Start()
    Invoke-KoseiDesktopWorker $shared {
        param($Shared)
        Start-Sleep -Seconds 3
        if(!$Shared.CancelRequested -or !$Shared.ShowCopilot){throw 'Menu actions not received while worker was blocked'}
        $Shared.ExitCode=0
    } @($shared)
    if($shared.ExitCode -ne 0){throw $shared.Error}
    if($script:latency -ge 2000 -or $script:pulses -lt 5){throw 'UI thread blocked by worker'}
    if($script:testUi.Tray.Visible){throw 'Tray left visible'}
    if($script:dialog -ne '校正を中止しますか？'){throw 'Cancellation confirmation missing'}
    Write-Host ('PASS DesktopUi real WinForms loop; menu latency='+$script:latency+'ms pulses='+$script:pulses)
} finally {$probe.Stop();$probe.Dispose()}
