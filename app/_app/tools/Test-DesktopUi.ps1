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
$script:latency=$null;$script:pulses=0
$probe.Add_Tick({
    if(!$shared.WorkerStarted){return}
    $script:pulses++
    if($script:testUi -and $script:latency -eq $null){
        $script:latency=([DateTime]::UtcNow-[DateTime]$shared.WorkerStarted).TotalMilliseconds
        $script:testUi.ShowItem.PerformClick()
        $script:testUi.CancelItem.PerformClick()
    }
})
try {
    $probe.Start()
    Invoke-KoseiDesktopWorker $shared {
        param($Shared)
        $Shared.WorkerStarted=[DateTime]::UtcNow
        Start-Sleep -Seconds 3
        if(!$Shared.CancelRequested -or !$Shared.ShowCopilot){throw 'Menu actions not received while worker was blocked'}
        $Shared.ExitCode=0
    } @($shared)
    if($shared.ExitCode -ne 0){throw $shared.Error}
    if($null -eq $script:latency -or $script:latency -ge 2000 -or $script:pulses -lt 5){throw ('UI thread blocked by worker: latency='+$script:latency+' pulses='+$script:pulses)}
    if($script:testUi.Tray.Visible){throw 'Tray left visible'}
    if($script:dialog -ne '校正を中止しますか？'){throw 'Cancellation confirmation missing'}
    # 完了の通知は、アイコンを片付ける前に Windows へ届くよう、しばらくアイコンを残してから終わる。
    $done=[hashtable]::Synchronized(@{Status='done';Error='';ExitCode=1;CancelRequested=$false;ShowCopilot=$false})
    $started=[DateTime]::UtcNow
    Invoke-KoseiDesktopWorker $done {param($Shared) $Shared.Notification='校正が終わりました';$Shared.ExitCode=0} @($done)
    $lingered=([DateTime]::UtcNow-$started).TotalSeconds
    if($done.ExitCode -ne 0 -or $lingered -lt 7 -or $lingered -gt 20){throw ('Tray did not linger after the final notification: '+$lingered+'s')}
    if($script:testUi.Tray.Visible){throw 'Tray left visible after the final notification'}
    # 完了の知らせは通知センターに残るトーストで出し、トレイの吹き出しは使わない（待たずに終わる）。
    $script:toasts=@()
    function Show-KoseiToastNotification {param($AppId,$Title,$Message) $script:toasts+=@{AppId=$AppId;Message=$Message};return $true}
    $toasted=[hashtable]::Synchronized(@{Status='done';Error='';ExitCode=1;CancelRequested=$false;ShowCopilot=$false;NotificationAppId='PdfKoseiAssist.Test'})
    $started=[DateTime]::UtcNow
    Invoke-KoseiDesktopWorker $toasted {param($Shared) $Shared.CompletionNotice='校正が終わりました：指摘 3件';$Shared.ExitCode=0} @($toasted)
    $elapsed=([DateTime]::UtcNow-$started).TotalSeconds
    if($script:toasts.Count -ne 1 -or $script:toasts[0].AppId -ne 'PdfKoseiAssist.Test' -or $script:toasts[0].Message -ne '校正が終わりました：指摘 3件'){throw 'Completion was not shown as a toast'}
    if($elapsed -gt 5){throw ('Tray lingered although the toast does not depend on it: '+$elapsed+'s')}
    # トーストを出せなかったら、吹き出しに戻して、しばらくアイコンを残す。
    function Show-KoseiToastNotification {param($AppId,$Title,$Message) return $false}
    $fallback=[hashtable]::Synchronized(@{Status='done';Error='';ExitCode=1;CancelRequested=$false;ShowCopilot=$false;NotificationAppId='PdfKoseiAssist.Test'})
    $started=[DateTime]::UtcNow
    Invoke-KoseiDesktopWorker $fallback {param($Shared) $Shared.CompletionNotice='校正が終わりました';$Shared.ExitCode=0} @($fallback)
    $lingered=([DateTime]::UtcNow-$started).TotalSeconds
    if($lingered -lt 7){throw ('Balloon fallback did not keep the tray: '+$lingered+'s')}
    Write-Host ('PASS DesktopUi real WinForms loop; menu latency='+$script:latency+'ms pulses='+$script:pulses)
} finally {$probe.Stop();$probe.Dispose()}
