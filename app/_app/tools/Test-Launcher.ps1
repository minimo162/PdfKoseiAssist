$ErrorActionPreference='Stop'
# 共有フォルダ配布の入口（Launch-KoseiAssist.ps1）の検証。
# 共有フォルダを模したフォルダから利用者ごとの場所へ写し、更新・更新途中・切断・動作中の版の扱いを確かめる。
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'Launch-KoseiAssist.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-launcher-'+[guid]::NewGuid().ToString('N'))
$share=Join-Path $temp '共有 & (1)/PDF校正アシスト/_app'
$offline=Join-Path $temp '切断中'
$base=Join-Path $temp 'LocalAppData/PdfKoseiAssist'
$previousData=$env:PDF_KOSEI_DATA_DIR;$previousInstall=$env:PDF_KOSEI_INSTALL_DIR;$previousLauncher=$env:PDF_KOSEI_LAUNCHER
$env:PDF_KOSEI_DATA_DIR=Join-Path $temp 'data'
$utf8=New-Object Text.UTF8Encoding($true)
$dropStub='[CmdletBinding(PositionalBinding=$false)]param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths)'+"`n"+'[IO.File]::WriteAllText((Join-Path $env:PDF_KOSEI_DATA_DIR "drop-result.json"),(@{paths=@($Paths);launcher=$env:PDF_KOSEI_LAUNCHER;root=$PSScriptRoot}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))'+"`n"+'exit 7'
function New-TestRelease([string]$Version,[string]$Body){
    foreach($dir in @($share,(Join-Path $share 'js'),(Join-Path $share 'config'))){$null=[IO.Directory]::CreateDirectory($dir)}
    [IO.File]::WriteAllText((Join-Path $share 'VERSION'),$Version)
    [IO.File]::WriteAllText((Join-Path $share 'js/app.mjs'),$Body)
    [IO.File]::WriteAllText((Join-Path $share 'Start-DropReview.ps1'),$dropStub,$utf8)
    foreach($name in @('Start-KoseiAssist.ps1','Setup-KoseiAssist.ps1')){[IO.File]::WriteAllText((Join-Path $share $name),'exit 0',$utf8)}
    # 版ごとに入口の中身も変える（手元の入口が置き換わることを確かめるため）。
    [IO.File]::WriteAllText((Join-Path $share 'Launch-KoseiAssist.ps1'),([IO.File]::ReadAllText((Join-Path $root 'Launch-KoseiAssist.ps1'))+"`n# test release $Version`n"),$utf8)
    $null=New-KoseiReleaseManifest -AppRoot $share
    Start-Sleep -Milliseconds 50
}
function Assert-Version([hashtable]$Resolved,[string]$Version,[string]$Message){
    if(!$Resolved.Installed -or (Get-KoseiInstallVersion $Resolved.Root) -ne $Version -or !(Test-KoseiPathUnder $Resolved.Root (Join-Path $base 'versions'))){throw ($Message+': '+$Resolved.Root)}
}
function Get-TestThrow([scriptblock]$Block){try{& $Block}catch{return $_.Exception.Message};return ''}
# 手元で動いているアプリの版（テストでは差し替える）
$script:running=''
function Get-KoseiRunningServerVersion {param([int[]]$Ports) return $script:running}
try {
    # 開発用の作業コピー（manifest なし）はその場で起動し、何も写さない。
    $dev=Join-Path $temp 'dev/_app';$null=[IO.Directory]::CreateDirectory($dev)
    $resolved=Resolve-KoseiLaunchRoot -Here $dev -Base $base
    if($resolved.Installed -or $resolved.Root -ne $dev -or (Test-Path -LiteralPath $base)){throw 'Working copy was installed'}

    # 初回: 共有フォルダから写して、手元の版で起動する。設定は共有フォルダのものを写す。
    New-TestRelease '95.6' 'one'
    [IO.File]::WriteAllText((Join-Path $share 'config/settings.json'),'{"server_ports":[60001]}')
    $script:progressCalls=@()
    $first=Resolve-KoseiLaunchRoot -Here $share -Base $base -OnProgress {param($Done,$Total) $script:progressCalls+=,@($Done,$Total)}
    $fileCount=@((Get-Content -Raw (Join-Path $share 'release-manifest.json') | ConvertFrom-Json).files).Count
    # 写しているあいだの進み具合を知らせる（起動直後に何も見えない時間をなくすため）。
    if($script:progressCalls.Count -ne $fileCount -or $script:progressCalls[-1][0] -ne $fileCount -or $script:progressCalls[-1][1] -ne $fileCount){throw ('Install progress was not reported per file: '+$script:progressCalls.Count+'/'+$fileCount)}
    Assert-Version $first '95.6' 'First install'
    if([IO.File]::ReadAllText((Join-Path $first.Root 'js/app.mjs')) -ne 'one' -or !(Test-KoseiInstallComplete $first.Root) -or ![IO.File]::Exists((Join-Path $first.Root 'release-manifest.json'))){throw 'Installed files incomplete'}
    if([IO.File]::ReadAllText((Join-Path $base 'source.txt')).Trim() -ne [IO.Path]::GetFullPath($share).TrimEnd('\','/')){throw 'Source folder was not recorded'}
    if([IO.File]::ReadAllText((Join-Path $base 'Launch-KoseiAssist.ps1')) -ne [IO.File]::ReadAllText((Join-Path $share 'Launch-KoseiAssist.ps1'))){throw 'Stable launcher was not placed'}
    if([IO.File]::ReadAllText((Join-Path $first.Root 'config/settings.json')) -ne '{"server_ports":[60001]}'){throw 'Shared settings were not copied'}
    $stamp=[IO.File]::GetLastWriteTimeUtc((Join-Path $first.Root '.complete'))

    # 2回目以降は手元の入口から。版が同じなら写し直さない。
    Start-Sleep -Milliseconds 50
    $script:progressCalls=@()
    $again=Resolve-KoseiLaunchRoot -Here $base -Base $base -OnProgress {param($Done,$Total) $script:progressCalls+=,@($Done,$Total)}
    if($script:progressCalls.Count){throw 'Progress was reported although nothing was copied'}
    if($again.Root -ne $first.Root -or [IO.File]::GetLastWriteTimeUtc((Join-Path $first.Root '.complete')) -ne $stamp){throw 'Same version was copied again'}

    # 管理者が共有フォルダを更新すると、次の起動で新しい版に切り替わる。
    New-TestRelease '95.7' 'two'
    $second=Resolve-KoseiLaunchRoot -Here $base -Base $base
    Assert-Version $second '95.7' 'Update was not picked up'
    if(![IO.File]::ReadAllText((Join-Path $base 'Launch-KoseiAssist.ps1')).Contains('# test release 95.7')){throw 'Stable launcher was not replaced by the new version'}
    if(!(Test-KoseiInstallComplete $first.Root)){throw 'Previous version was removed too early'}

    # 更新の途中（一覧と中身が食い違う）では切り替えず、今の版で起動する。
    New-TestRelease '95.8' 'three'
    [IO.File]::WriteAllText((Join-Path $share 'js/app.mjs'),'half-written')
    $during=Resolve-KoseiLaunchRoot -Here $base -Base $base
    if($during.Root -ne $second.Root){throw 'Half-updated share was used'}
    if(@([IO.Directory]::GetDirectories((Join-Path $base 'versions'))|Where-Object{[IO.Path]::GetFileName($_).StartsWith('.staging-')}).Count){throw 'Staging folder was left behind'}
    # manifest 自体を書いている途中（壊れている）も同じ。
    $manifestPath=Join-Path $share 'release-manifest.json';$manifestText=[IO.File]::ReadAllText($manifestPath)
    [IO.File]::WriteAllText($manifestPath,$manifestText.Substring(0,[int]($manifestText.Length/2)))
    if((Resolve-KoseiLaunchRoot -Here $base -Base $base).Root -ne $second.Root){throw 'Half-written manifest was used'}
    [IO.File]::WriteAllText($manifestPath,$manifestText)

    # 更新が終われば切り替わり、古い版（3つ目以降）は片付ける。
    [IO.File]::WriteAllText((Join-Path $share 'js/app.mjs'),'three')
    $third=Resolve-KoseiLaunchRoot -Here $base -Base $base
    Assert-Version $third '95.8' 'Completed update was not picked up'
    if([IO.Directory]::Exists($first.Root) -or !(Test-KoseiInstallComplete $second.Root)){throw 'Old versions were not trimmed to two'}

    # 手元でアプリが動いている間は、その版を使い続ける（入れ替えは次にアプリを起動したとき）。
    $script:running='95.7'
    New-TestRelease '95.9' 'four'
    $busy=Resolve-KoseiLaunchRoot -Here $base -Base $base
    if($busy.Root -ne $second.Root){throw 'Running version was not kept'}
    if((Get-KoseiInstallVersion (Get-KoseiCurrentInstall $base)) -ne '95.9'){throw 'New version was not prepared while the old one runs'}
    if(!(Test-KoseiInstallComplete $second.Root)){throw 'Running version was removed'}
    $script:running=''
    $fourth=Resolve-KoseiLaunchRoot -Here $base -Base $base
    Assert-Version $fourth '95.9' 'New version was not used after the app stopped'

    # 設定を共有フォルダから消したら、手元の写しも消す（既定値に戻す）。
    [IO.File]::Delete((Join-Path $share 'config/settings.json'))
    $null=Resolve-KoseiLaunchRoot -Here $base -Base $base
    if([IO.File]::Exists((Join-Path $fourth.Root 'config/settings.json'))){throw 'Removed shared settings stayed'}

    # 共有フォルダにつながらないときは、手元の版で起動する。
    [IO.Directory]::Move((Split-Path -Parent $share),$offline)
    if((Resolve-KoseiLaunchRoot -Here $base -Base $base).Root -ne $fourth.Root){throw 'Offline launch did not use the local copy'}
    [IO.Directory]::Move($offline,(Split-Path -Parent $share))

    # 手元に何もなく、共有フォルダにもつながらないときは、分かる言葉で止める。
    $empty=Join-Path $temp 'empty/PdfKoseiAssist';$null=[IO.Directory]::CreateDirectory($empty)
    if((Get-TestThrow {Resolve-KoseiLaunchRoot -Here $empty -Base $empty}) -notmatch '配布元が分かりません'){throw 'Missing source message'}
    [IO.File]::WriteAllText((Join-Path $empty 'source.txt'),$offline)
    if((Get-TestThrow {Resolve-KoseiLaunchRoot -Here $empty -Base $empty}) -notmatch '接続できませんでした'){throw 'Offline message'}

    # 実際の起動: 共有フォルダの入口から「送る」の経路で起動し、引数と終了コードを渡す。
    $env:PDF_KOSEI_INSTALL_DIR=$base
    $pdf=Join-Path $temp '英文 & (1).pdf'
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=(Get-Process -Id $PID).Path;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $share 'Launch-KoseiAssist.ps1')+'" -Entry Drop "'+$pdf+'"'
    $process=[Diagnostics.Process]::Start($info)
    if(!$process.WaitForExit(60000)){$process.Kill();throw 'Launcher timed out'}
    if($process.ExitCode -ne 7){throw ('Exit code was not passed through: '+$process.ExitCode)}
    $result=[IO.File]::ReadAllText((Join-Path $env:PDF_KOSEI_DATA_DIR 'drop-result.json'))|ConvertFrom-Json
    if(@($result.paths).Count -ne 1 -or $result.paths[0] -cne $pdf){throw ('Dropped path changed: '+($result.paths -join '|'))}
    if($result.launcher -ne (Join-Path $base 'Launch-KoseiAssist.ps1')){throw ('Stable launcher was not handed to the app: '+$result.launcher)}
    if(!(Test-KoseiPathUnder $result.root (Join-Path $base 'versions'))){throw ('App did not run from the local copy: '+$result.root)}
    Write-Host 'PASS Launcher (shared-folder install, update, half-update, offline, running version)'
} finally {
    $env:PDF_KOSEI_DATA_DIR=$previousData;$env:PDF_KOSEI_INSTALL_DIR=$previousInstall;$env:PDF_KOSEI_LAUNCHER=$previousLauncher
    $resolvedTemp=[IO.Path]::GetFullPath($temp)
    if($resolvedTemp.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedTemp) -match '^kosei-launcher-[0-9a-f]{32}$'){
        for($i=0;$i -lt 20;$i++){try{Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction Stop;break}catch{if($i -eq 19){Write-Warning ('temp cleanup failed: '+$_.Exception.Message)}else{Start-Sleep -Milliseconds 250}}}
    }
}
