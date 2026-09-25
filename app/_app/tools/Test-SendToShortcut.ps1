$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/SendToShortcut.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-sendto-'+[guid]::NewGuid().ToString('N'))
$send=Join-Path $temp 'SendTo';$old=Join-Path $temp '旧版 & (1)/_app';$new=Join-Path $temp '新版 % 😀/_app'
# 共有フォルダ配布で手元に写した版の入口（隣に current.txt と versions がある）
$base=Join-Path $temp 'LocalAppData 日本語/PdfKoseiAssist';$baseVersion=Join-Path $base 'versions/95.10-0123456789ab'
foreach($dir in @($send,$old,$new,$baseVersion)){$null=[IO.Directory]::CreateDirectory($dir)}
$oldLauncher=Join-Path $old 'Launch-KoseiAssist.ps1';$newLauncher=Join-Path $new 'Launch-KoseiAssist.ps1';$baseLauncher=Join-Path $base 'Launch-KoseiAssist.ps1'
foreach($file in @($oldLauncher,$newLauncher,$baseLauncher)){[IO.File]::WriteAllText($file,'# fixture')}
[IO.File]::WriteAllText((Join-Path $old 'VERSION'),'95.9');[IO.File]::WriteAllText((Join-Path $new 'VERSION'),'95.10')
[IO.File]::WriteAllText((Join-Path $base 'current.txt'),'95.10-0123456789ab');[IO.File]::WriteAllText((Join-Path $baseVersion 'VERSION'),'95.10')
function Set-TestShortcutArguments([string]$Arguments){
    Initialize-KoseiUnicodeShortcut
    [KoseiUnicodeShortcut]::SetUnicodeProperties((Get-KoseiSendToPath $send),$Arguments,$temp,'PDF校正アシストで校正')
}
try {
    if((Repair-KoseiSendToShortcut $newLauncher $send).action -ne 'unregistered'){throw 'Unregistered shortcut created'}
    $registered=Set-KoseiSendToShortcut $oldLauncher $send
    if(!$registered.ok){throw ('Registration failed: '+$registered.error)}
    $link=Get-KoseiSendToShortcutInfo $send
    if($link.TargetPath -notlike '*powershell.exe' -or $link.Arguments -notlike '*-STA -WindowStyle Hidden -File*' -or !$link.Arguments.EndsWith('" -Entry Drop') -or $link.WindowStyle -ne 7){throw ('Shortcut contract incorrect: '+$link.Arguments)}
    if((Repair-KoseiSendToShortcut $newLauncher $send).action -ne 'repaired'){throw '95.10 did not replace 95.9'}
    if(!(Get-KoseiSendToShortcutInfo $send).Arguments.Contains($newLauncher)){throw 'Unicode launcher path was corrupted'}
    if((Repair-KoseiSendToShortcut $oldLauncher $send).action -ne 'unchanged'){throw 'New version was downgraded'}
    if((Repair-KoseiSendToShortcut $newLauncher $send).action -ne 'unchanged'){throw 'Equal version changed'}
    [IO.File]::Delete($newLauncher)
    if((Repair-KoseiSendToShortcut $oldLauncher $send).action -ne 'repaired'){throw 'Missing launcher not repaired'}
    [IO.File]::WriteAllText($newLauncher,'# fixture');[IO.File]::Delete((Join-Path $old 'VERSION'))
    if((Repair-KoseiSendToShortcut $newLauncher $send).action -ne 'repaired'){throw 'Missing version not treated as old'}
    # 以前の版の登録（Start-DropReview.ps1 を直接指す）は、同じ版の共有フォルダでも入口へ向け直す。
    [IO.File]::WriteAllText((Join-Path $new 'Start-DropReview.ps1'),'# fixture')
    Set-TestShortcutArguments ('-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "'+(Join-Path $new 'Start-DropReview.ps1')+'"')
    if((Repair-KoseiSendToShortcut $newLauncher $send).action -ne 'repaired' -or !(Get-KoseiSendToShortcutInfo $send).Arguments.Contains($newLauncher)){throw 'Legacy direct shortcut was not moved to the launcher'}
    # 手元に写した版の入口が登録先を決める。共有フォルダ上の入口（版が同じでも）からは向け直す。
    if((Get-KoseiLauncherVersion $baseLauncher) -ne [version]'95.10.0'){throw 'Installed launcher version was not read from current.txt'}
    if((Repair-KoseiSendToShortcut $baseLauncher $send).action -ne 'repaired' -or !(Get-KoseiSendToShortcutInfo $send).Arguments.Contains($baseLauncher)){throw 'Installed launcher did not take over the shortcut'}
    if((Repair-KoseiSendToShortcut $baseLauncher $send).action -ne 'unchanged'){throw 'Installed launcher re-registered itself'}
    if((Repair-KoseiSendToShortcut $newLauncher $send).action -ne 'unchanged'){throw 'Working copy of the same version took the shortcut from the installed launcher'}
    $unc='\\localhost\example\日本語 & (1)\_app\Launch-KoseiAssist.ps1'
    if(!(Set-KoseiSendToShortcut $unc $send).ok){throw 'UNC shortcut could not be saved'}
    $uncLink=Get-KoseiSendToShortcutInfo $send
    if(!$uncLink.Arguments.Contains($unc)){throw 'UNC path changed'}
    if(!(Remove-KoseiSendToShortcut $send).ok -or (Test-Path -LiteralPath (Get-KoseiSendToPath $send))){throw 'Remove failed'}
    $blocked=Join-Path $temp 'file';[IO.File]::WriteAllText($blocked,'x')
    if((Set-KoseiSendToShortcut $oldLauncher $blocked).ok){throw 'Failure not returned'}
    Write-Host 'PASS SendToShortcut (real WScript.Shell, isolated SendTo folder)'
}finally{
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-sendto-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
