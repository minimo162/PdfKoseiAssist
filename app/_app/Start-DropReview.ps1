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
foreach($module in @('Settings','CopilotClient','DropFiles','DropReview')) { . (Join-Path $root ('src/'+$module+'.ps1')) }
$mutex=[Threading.Mutex]::new($false,'Local\PdfKoseiAssistDropReview')
$held=$false
$shared=[hashtable]::Synchronized(@{NoTray=$true;Status='準備中';ExitCode=1;Finished=$false;CancelRequested=$false;ShowCopilot=$false;Error='';Prompt='';Answer=$null;Notification='';Session='';Result='';Url=''})
try {
    try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
    if(!$held){throw '別の校正を実行中です。終わってから、もう一度「送る」を実行してください。'}
    Invoke-KoseiDropReview -Paths $Paths -Shared $shared -TimeoutMinutes $TimeoutMinutes
    if($shared.Error){Write-Error ($shared.Error+' 調査用: '+$shared.Session) -ErrorAction Continue}
} catch { Write-KoseiLog ([string]$_.Exception.Message) 'ERROR';$shared.ExitCode=1 }
finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
exit $shared.ExitCode
