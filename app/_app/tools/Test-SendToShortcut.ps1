$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/SendToShortcut.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-sendto-'+[guid]::NewGuid().ToString('N'))
$send=Join-Path $temp 'SendTo';$old=Join-Path $temp '旧版 & (1)/_app';$new=Join-Path $temp '新版 % 😀/_app'
foreach($dir in @($send,$old,$new)){$null=[IO.Directory]::CreateDirectory($dir)}
foreach($dir in @($old,$new)){[IO.File]::WriteAllText((Join-Path $dir 'Start-DropReview.ps1'),'# fixture')}
[IO.File]::WriteAllText((Join-Path $old 'VERSION'),'95.9');[IO.File]::WriteAllText((Join-Path $new 'VERSION'),'95.10')
try {
    if((Repair-KoseiSendToShortcut $new $send).action -ne 'unregistered'){throw 'Unregistered shortcut created'}
    $registered=Set-KoseiSendToShortcut $old $send
    if(!$registered.ok){throw ('Registration failed: '+$registered.error)}
    $link=Get-KoseiSendToShortcutInfo $send
    if($link.TargetPath -notlike '*powershell.exe' -or $link.Arguments -notlike '*-STA -WindowStyle Hidden -File*' -or $link.WindowStyle -ne 7){throw 'Shortcut contract incorrect'}
    if((Repair-KoseiSendToShortcut $new $send).action -ne 'repaired'){throw '95.10 did not replace 95.9'}
    if(!(Get-KoseiSendToShortcutInfo $send).Arguments.Contains($new)){throw 'Unicode launcher path was corrupted'}
    if((Repair-KoseiSendToShortcut $old $send).action -ne 'unchanged'){throw 'New version was downgraded'}
    if((Repair-KoseiSendToShortcut $new $send).action -ne 'unchanged'){throw 'Equal version changed'}
    [IO.File]::Delete((Join-Path $new 'Start-DropReview.ps1'))
    if((Repair-KoseiSendToShortcut $old $send).action -ne 'repaired'){throw 'Missing launcher not repaired'}
    [IO.File]::Delete((Join-Path $old 'VERSION'))
    if((Repair-KoseiSendToShortcut $new $send).action -ne 'repaired'){throw 'Missing version not treated as old'}
    $unc='\\localhost\example\日本語 & (1)\_app'
    if(!(Set-KoseiSendToShortcut $unc $send).ok){throw 'UNC shortcut could not be saved'}
    $uncLink=Get-KoseiSendToShortcutInfo $send
    if(!$uncLink.Arguments.Contains($unc)){throw 'UNC path changed'}
    if(!(Remove-KoseiSendToShortcut $send).ok -or (Test-Path -LiteralPath (Get-KoseiSendToPath $send))){throw 'Remove failed'}
    $blocked=Join-Path $temp 'file';[IO.File]::WriteAllText($blocked,'x')
    if((Set-KoseiSendToShortcut $old $blocked).ok){throw 'Failure not returned'}
    Write-Host 'PASS SendToShortcut (real WScript.Shell, isolated SendTo folder)'
}finally{
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-sendto-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
