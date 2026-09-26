[CmdletBinding(PositionalBinding=$false)]
param(
    [ValidateRange(1,1440)][int]$TimeoutMinutes=180,
    [switch]$NoTray,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths
)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
. (Join-Path $root 'src/Paths.ps1')
Set-KoseiRoot $root
foreach($module in @('Settings','CopilotClient','SendToShortcut','DropFiles','DropReview','DesktopUi')) { . (Join-Path $root ('src/'+$module+'.ps1')) }
$mutex=[Threading.Mutex]::new($false,'Local\PdfKoseiAssistDropReview')
$held=$false
$shared=[hashtable]::Synchronized(@{NoTray=[bool]$NoTray;Status='準備中';ExitCode=1;Finished=$false;CancelRequested=$false;ShowCopilot=$false;Error='';RoleChoice=$null;Answer=$null;Notification='';CompletionTitle='';CompletionNotice='';TargetName='';ShowStatusWindow=$false;NotificationAppId='';Session='';Result='';Url=''})
# 通知の差出人を「PDF校正アシスト」にする。窓を1つも作る前に行う。
if(!$NoTray -and (Set-KoseiNotificationIdentity)){$shared.NotificationAppId=$script:KoseiNotificationAppId}
try {
    try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
    if(!$held){throw '別の校正を実行中です。終わってから、もう一度「送る」を実行してください。'}
    if($NoTray){
        Invoke-KoseiDropReview -Paths $Paths -Shared $shared -TimeoutMinutes $TimeoutMinutes
        if($shared.Error){Write-Error ($shared.Error+' 調査用: '+$shared.Session) -ErrorAction Continue}
    } else {
        $worker={
            param($Root,$Paths,$Shared,$TimeoutMinutes)
            $ErrorActionPreference='Stop'
            . (Join-Path $Root 'src/Paths.ps1');Set-KoseiRoot $Root
            foreach($module in @('Settings','CopilotClient','SendToShortcut','DropFiles','DropReview')){. (Join-Path $Root ('src/'+$module+'.ps1'))}
            Invoke-KoseiDropReview -Paths $Paths -Shared $Shared -TimeoutMinutes $TimeoutMinutes
        }
        # 進み具合の画面は、初めて「送る」を使うときだけ自分から出す。2回目からはトレイのアイコンから出せる（普段は静かに動かす）。
        $firstRun=$false
        try{$marker=Join-Path (Get-KoseiSubDir 'runtime') 'drop-status-shown.txt';if(!(Test-Path -LiteralPath $marker)){$firstRun=$true;[IO.File]::WriteAllText($marker,(Get-Date).ToString('o'))}}catch{}
        Invoke-KoseiDesktopWorker -Shared $shared -Worker $worker -WorkerArguments @($root,$Paths,$shared,$TimeoutMinutes) -StatusWindow -ShowStatusAtStart:$firstRun
    }
} catch {
    Write-KoseiLog ([string]$_.Exception.Message) 'ERROR';$shared.ExitCode=1
    if(!$NoTray){$null=Show-KoseiDesktopDialog $_.Exception.Message 'OK' 'Error'}
}
finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
exit $shared.ExitCode
