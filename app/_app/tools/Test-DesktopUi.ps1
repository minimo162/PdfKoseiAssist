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
    # 入口の「起動しています…」の窓は、次の画面（トレイ・進み具合）を出すときに閉じる合図を送る。
    $pendingSplash=@{State=[hashtable]::Synchronized(@{Close=$false})};$global:KoseiLauncherSplash=$pendingSplash
    $probe.Start()
    Invoke-KoseiDesktopWorker $shared {
        param($Shared)
        $Shared.WorkerStarted=[DateTime]::UtcNow
        Start-Sleep -Seconds 3
        if(!$Shared.CancelRequested -or !$Shared.ShowCopilot){throw 'Menu actions not received while worker was blocked'}
        $Shared.ExitCode=0
    } @($shared)
    if($shared.ExitCode -ne 0){throw $shared.Error}
    if(!$pendingSplash.State.Close -or $global:KoseiLauncherSplash){throw 'Launcher splash was not closed when the tray appeared'}
    if($null -eq $script:latency -or $script:latency -ge 2000 -or $script:pulses -lt 5){throw ('UI thread blocked by worker: latency='+$script:latency+' pulses='+$script:pulses)}
    if($script:testUi.Tray.Visible){throw 'Tray left visible'}
    # 中止の確認で、途中の結果が残らないことを押す前に伝える。
    if($script:dialog -ne $script:KoseiCancelConfirm -or $script:dialog -notmatch '保存されません'){throw 'Cancellation confirmation missing'}
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
    # どちらが英文か決められないときは、組み合わせを直接選ぶ画面を出し、選んだ番号を校正側に返す。
    $script:roleNames=$null
    function Show-KoseiDropRoleChoice {param($Names) $script:roleNames=@($Names);return 1}
    $role=[hashtable]::Synchronized(@{Status='role';Error='';ExitCode=1;CancelRequested=$false;ShowCopilot=$false;RoleChoice=$null;Answer=$null})
    Invoke-KoseiDesktopWorker $role {
        param($Shared)
        $Shared.RoleChoice=@('a.pdf','b.pdf')
        $deadline=(Get-Date).AddSeconds(10);while($null -eq $Shared.Answer -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
        $Shared.ExitCode=if($Shared.Answer -eq 1){0}else{1}
    } @($role)
    if($role.ExitCode -ne 0 -or ($script:roleNames -join '|') -ne 'a.pdf|b.pdf'){throw 'Role choice was not asked or not returned'}
    # 進み具合の画面：対象と現在の状況を出し、「画面を閉じて続ける」で隠れ、トレイの「進み具合を表示」でまた出る。
    $status=[hashtable]::Synchronized(@{Status='英文を読み込んでいます';Error='';ExitCode=1;CancelRequested=$false;ShowCopilot=$false;TargetName='report_en.pdf';Seen=$false})
    $script:statusStage=0;$script:statusTexts=''
    $statusProbe=New-Object Windows.Forms.Timer;$statusProbe.Interval=200
    $statusProbe.Add_Tick({
        $form=$script:testUi.StatusForm
        if(!$form){return}
        if($script:statusStage -eq 0 -and $form.Visible){
            $script:statusTexts=(@($form.Controls | ForEach-Object { $_.Text }) -join '|')
            @($form.Controls | Where-Object { $_.Text -eq '画面を閉じて続ける' })[0].PerformClick();$script:statusStage=1
        } elseif($script:statusStage -eq 1 -and !$form.Visible){
            $script:testUi.ProgressItem.PerformClick();$script:statusStage=2
        } elseif($script:statusStage -eq 2 -and $form.Visible){$status.Seen=$true;$script:statusStage=3}
    })
    $statusProbe.Start()
    try {
        Invoke-KoseiDesktopWorker $status {
            param($Shared)
            $deadline=(Get-Date).AddSeconds(15);while(!$Shared.Seen -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 50}
            $Shared.ExitCode=if($Shared.Seen){0}else{1}
        } @($status) -StatusWindow -ShowStatusAtStart
    } finally {$statusProbe.Stop();$statusProbe.Dispose()}
    if($status.ExitCode -ne 0){throw ('Status window was not shown, hidden and shown again: stage='+$script:statusStage)}
    if($script:statusTexts -notmatch '対象：report_en\.pdf' -or $script:statusTexts -notmatch '現在：英文を読み込んでいます' -or $script:statusTexts -notmatch '閉じても校正は続きます'){throw ('Status window text: '+$script:statusTexts)}
    if(!$script:testUi.StatusForm.IsDisposed){throw 'Status window left open'}
    Write-Host ('PASS DesktopUi real WinForms loop; menu latency='+$script:latency+'ms pulses='+$script:pulses)
} finally {$probe.Stop();$probe.Dispose()}
