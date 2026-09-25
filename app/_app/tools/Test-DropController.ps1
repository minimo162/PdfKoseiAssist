$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src/Paths.ps1');Set-KoseiRoot $root
. (Join-Path $root 'src/DropFiles.ps1')
. (Join-Path $root 'src/DropReview.ps1')
. (Join-Path $root 'src/DesktopUi.ps1')
# issue #182: トレイの短い文は status().progress から作り、63文字のツールチップに収める。
function New-Progress([string]$Phase,[string]$Label='',[int]$Done=0,[int]$Total=0,[string]$Remaining=''){
    [pscustomobject]@{phase=$Phase;stage_label=$Label;stage_index=3;stage_total=3;done=$Done;total=$Total;remaining_ms=$null;remaining_label=$Remaining}
}
$statusCases=@(
    @{Progress=(New-Progress 'running' '原稿との突き合わせ' 8 12 '約1分');Want='原稿との突き合わせ 8/12・残り約1分'},
    @{Progress=(New-Progress 'running' '原稿との突き合わせ' 1 12 '');Want='原稿との突き合わせ 1/12'},
    @{Progress=(New-Progress 'running' '文書全体の整合性' 5 9 '1分未満');Want='文書全体の整合性 5/9・残り1分未満'},
    @{Progress=(New-Progress 'running' '' 0 0 '');Want='校正中'},
    @{Progress=(New-Progress 'preparing' 'Copilot準備中…');Want='準備中'},
    @{Progress=(New-Progress 'idle');Want='準備中'},
    @{Progress=$null;Want='準備中'},
    @{Progress=(New-Progress 'needs_user_visibility');Want='Copilot画面の確認待ち'},
    @{Progress=(New-Progress 'importing' '原稿との突き合わせ' 12 12);Want='結果を取り込んでいます'},
    @{Progress=(New-Progress 'done' '' 12 12);Want='結果をまとめています'}
)
foreach($case in $statusCases){
    $got=ConvertTo-KoseiDropStatusText $case.Progress
    if($got -ne $case.Want){throw ('Drop status text: want '+$case.Want+' got '+$got)}
    $tray=ConvertTo-KoseiTrayText $got
    if($tray.Length -gt 63 -or $tray.EndsWith('…')){throw ('Drop status does not fit tooltip: '+$tray)}
}
$long=ConvertTo-KoseiDropStatusText (New-Progress 'running' ('とても長い段階名'*20) 123 456 '約2時間30分')
$longTray=ConvertTo-KoseiTrayText $long
if($longTray.Length -gt 63 -or $longTray.EndsWith('…') -or !$long.EndsWith(' 123/456・残り約2時間30分')){throw ('Long stage label must be shortened before the counts: '+$longTray)}
foreach($fixed in @('準備中','Copilotの準備を待っています','レポートを作成しています','中止しています')){
    if((ConvertTo-KoseiTrayText $fixed).EndsWith('…')){throw ('Fixed status truncated: '+$fixed)}
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-controller-'+[guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($temp)
$previous=$env:PDF_KOSEI_DATA_DIR;$env:PDF_KOSEI_DATA_DIR=$temp
$paths=@((Join-Path $temp '原稿_ja.pdf'),(Join-Path $temp '対象_en.pdf'))
foreach($path in $paths){[IO.File]::WriteAllText($path,'test')}
$script:calls=New-Object 'System.Collections.Generic.List[string]'
function Get-KoseiSettings { return [pscustomobject]@{server_ports=@(60001);cdp_port=60002;drop_open_report=$false} }
function Get-KoseiAppVersion { return '95.5' }
function Write-KoseiLog { param($Message,$Level) }
function Invoke-RestMethod {
    param($Uri,$Method,$TimeoutSec,$Body,$Headers,$ContentType,[switch]$UseBasicParsing)
    $script:calls.Add([string]$Uri)
    if($Uri -like '*/__health'){if($script:noServer -and !$script:serverLaunched){throw 'offline'};return @{ok=$true;version=$script:serverVersion}}
    if($Uri -like '*/__shutdown'){$script:shutdownBody=$Body;return @{ok=$true}}
    if($Uri -like '*/api/ready-state'){if($script:transientSignin){$script:transientSignin=$false;return @{state='signin_required';job_running=$false}};return @{state='ready';job_running=$script:busy}}
    if($Uri -like '*/json/version'){return @{webSocketDebuggerUrl='ws://browser'}}
    if($Uri -like '*/api/review/jobs/*'){
        $script:checkpointPoll++
        return @{mode='cancelled';id='0123456789abcdef0123456789abcdef';result_retained=$true;recovery_checkpoint_ready=($script:checkpointPoll -gt 1)}
    }
    throw ('Unexpected request: '+$Uri)
}
function Get-KoseiCdpTargets { param($Port) return @{id='target';webSocketDebuggerUrl='ws://page'} }
function Invoke-KoseiCdpMethod {
    param($WebSocketUrl,$Method,$Params,$TimeoutSeconds)
    $script:calls.Add($Method)
    if($Method -eq 'Target.createTarget'){return @{result=@{targetId='target'}}}
    return @{result=@{windowId=1}}
}
function Invoke-KoseiCdpEval {
    param($WebSocketUrl,$Expression,$TimeoutSeconds)
    $script:calls.Add($Expression)
    if($Expression -eq 'window.__koseiAutomation && window.__koseiAutomation.version'){return '95.5'}
    if($Expression -eq 'document.visibilityState'){return 'visible'}
    if($Expression -like '*detectLanguage*'){return @{language='その他'}}
    if($Expression -like '*startFull*'){$script:started=$true;return $true}
    if($Expression -eq 'window.__koseiAutomation.status()'){
        $script:poll++
        if($script:poll -eq 2){$script:statusAfterPoll=$script:shared.Status}
        if($script:cancelRun){$script:shared.CancelRequested=$true}
        $progress=[pscustomobject]@{phase='running';stage_label='原稿との突き合わせ';stage_index=3;stage_total=3;done=8;total=12;remaining_ms=60000;remaining_label='約1分'}
        return @{running=($script:poll -eq 1);job_id='0123456789abcdef0123456789abcdef';card='原稿との突き合わせ（3/3） — 完了 8/12・残り 4 中止現在の段階:';detail='依頼別の詳細';last_error='';progress=$progress}
    }
    if($Expression -like '*acknowledgeCancelled*'){
        if($script:checkpointPoll -lt 2){throw 'Acknowledged before durable checkpoint'}
        return @{job_id='0123456789abcdef0123456789abcdef';chain_id=''}
    }
    if($Expression -like '*packets()*'){return @(@{status='done'})}
    if($Expression -like '*exportReportZip*'){
        $zip=[IO.Compression.ZipFile]::Open((Join-Path $script:shared.Session 'report.zip'),[IO.Compression.ZipArchiveMode]::Create)
        try{$entry=$zip.CreateEntry('_data/指摘.json');$writer=[IO.StreamWriter]::new($entry.Open());try{$writer.Write('{"findings":[]}')}finally{$writer.Dispose()}}finally{$zip.Dispose()}
        return @{ok=$true;findings=0;excluded=0}
    }
    return $true
}
function Start-Process {
    param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
    $script:calls.Add('open:'+([string]$FilePath))
    if($PassThru){
        $script:serverLaunched=$true
        $path=Join-Path (Get-KoseiRoot) 'local-app.url'
        [IO.File]::WriteAllText($path,'http://127.0.0.1:60001/')
        (Get-Item -LiteralPath $path).LastWriteTime=(Get-Date).AddSeconds(1)
        return [pscustomobject]@{HasExited=$false;Id=0}
    }
    return $null
}
function New-Shared { return [hashtable]::Synchronized(@{NoTray=$true;CancelRequested=$false;ShowCopilot=$false;Finished=$false;ExitCode=1;Error=''}) }
try {
    $script:serverVersion='old';$script:busy=$false;$script:shared=New-Shared
    Invoke-KoseiDropReview $paths $script:shared
    if($script:shared.ExitCode -ne 1 -or $script:shared.Error -notmatch '別の版'){throw 'Version mismatch was not rejected'}
    if($script:calls -contains 'Target.createTarget'){throw 'Browser opened against wrong version'}
    $script:serverVersion='95.5';$script:busy=$true;$script:shared=New-Shared
    Invoke-KoseiDropReview $paths $script:shared
    if($script:shared.Error -notmatch '別の校正'){throw 'Busy server was not rejected'}
    $script:transientSignin=$true;$script:busy=$false;$script:poll=0;$script:shared=New-Shared
    Invoke-KoseiDropReview $paths $script:shared
    if($script:shared.ExitCode -ne 0){throw ('Controller did not complete: '+$script:shared.Error)}
    if($script:statusAfterPoll -ne '原稿との突き合わせ 8/12・残り約1分'){throw ('Tray status was not built from status().progress: '+$script:statusAfterPoll)}
    if($script:shared.Status -ne 'レポートを作成しています'){throw ('Report phase status missing: '+$script:shared.Status)}
    if(Test-Path -LiteralPath $script:shared.Session){throw 'Successful session was not cleaned'}
    if(!(Test-Path -LiteralPath (Join-Path $script:shared.Result '_data/指摘.json'))){throw 'Result not saved'}
    if(@($script:calls|Where-Object{$_ -like '*/__shutdown'}).Count){throw 'Shared server was stopped'}
    if($script:calls -notcontains 'Target.closeTarget'){throw 'Owned app target was not closed'}
    $load=@($script:calls|Where-Object{$_ -like '*loadTarget*'})[0]
    if($load -notlike '*input/2*'){throw 'Reversed Japanese/English assignment failed'}
    Set-KoseiRoot $temp
    $script:noServer=$true;$script:serverLaunched=$false;$script:poll=0;$script:shared=New-Shared
    Invoke-KoseiDropReview $paths $script:shared
    if($script:shared.ExitCode -ne 0){throw ('Owned server run failed: '+$script:shared.Error)}
    if(!@($script:calls|Where-Object{$_ -like '*/__shutdown'}).Count){throw 'Owned server was not stopped'}
    $script:serverLaunched=$false;$script:poll=0;$script:cancelRun=$true;$script:checkpointPoll=0;$script:shared=New-Shared
    Invoke-KoseiDropReview $paths $script:shared
    if($script:shared.Error -notmatch '中止' -or $script:checkpointPoll -lt 2){throw 'Cancellation did not await checkpoint'}
    if(($script:shutdownBody|ConvertFrom-Json).shutdown_intent_job_id -ne '0123456789abcdef0123456789abcdef'){throw 'Cancellation acknowledgement missing from shutdown'}
    Write-Host 'PASS DropController (mocked HTTP/CDP; real session and ZIP extraction)'
} finally {
    $env:PDF_KOSEI_DATA_DIR=$previous
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-controller-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
