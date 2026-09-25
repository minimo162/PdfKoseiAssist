$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src/Paths.ps1');Set-KoseiRoot $root
. (Join-Path $root 'src/DropFiles.ps1')
. (Join-Path $root 'src/DropReview.ps1')
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
    if($Uri -like '*/__shutdown'){return @{ok=$true}}
    if($Uri -like '*/api/ready-state'){return @{state='ready';job_running=$script:busy}}
    if($Uri -like '*/json/version'){return @{webSocketDebuggerUrl='ws://browser'}}
    if($Uri -like '*/api/review/jobs/*'){return @{mode='cancelled';id='0123456789abcdef0123456789abcdef'}}
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
        return @{running=($script:poll -eq 1);job_id='0123456789abcdef0123456789abcdef';card='review';detail='';last_error=''}
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
    $script:busy=$false;$script:poll=0;$script:shared=New-Shared
    Invoke-KoseiDropReview $paths $script:shared
    if($script:shared.ExitCode -ne 0){throw ('Controller did not complete: '+$script:shared.Error)}
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
    Write-Host 'PASS DropController (mocked HTTP/CDP; real session and ZIP extraction)'
} finally {
    $env:PDF_KOSEI_DATA_DIR=$previous
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-controller-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
