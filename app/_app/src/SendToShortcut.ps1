function Get-KoseiSendToPath {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    Join-Path $SendToFolder 'PDF校正アシストで校正.lnk'
}
function New-KoseiShortcutStage {
    # WSH shortcut filenames use ANSI even though properties are Unicode.
    foreach($parent in @([IO.Path]::GetTempPath(),(Join-Path $env:SystemRoot 'Temp'))){
        if($parent -match '[^\x00-\x7F]'){continue}
        $stage=Join-Path $parent ('kosei-shortcut-'+[guid]::NewGuid().ToString('N'))
        try{$null=[IO.Directory]::CreateDirectory($stage);return (Join-Path $stage 'shortcut.lnk')}catch{}
    }
    throw 'ショートカットを作る一時フォルダを用意できません。TEMPの書き込み権限を確認してください。'
}
function Remove-KoseiShortcutStage {
    param([string]$Path)
    if(!$Path){return}
    $full=[IO.Path]::GetFullPath($Path);$parent=[IO.Path]::GetDirectoryName($full)
    if([IO.Path]::GetFileName($full) -ne 'shortcut.lnk' -or [IO.Path]::GetFileName($parent) -notmatch '^kosei-shortcut-[0-9a-f]{32}$'){throw 'Unexpected shortcut staging path'}
    [IO.File]::Delete($full);[IO.Directory]::Delete($parent)
}
function Get-KoseiSendToShortcutInfo {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    $stage=$null;$shell=$null;$link=$null
    try{
        $stage=New-KoseiShortcutStage
        [IO.File]::Copy((Get-KoseiSendToPath $SendToFolder),$stage)
        $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($stage)
        return @{ok=$true;Arguments=[string]$link.Arguments;TargetPath=[string]$link.TargetPath;WorkingDirectory=[string]$link.WorkingDirectory;WindowStyle=[int]$link.WindowStyle}
    }catch{return @{ok=$false;error=$_.Exception.Message}}
    finally{if($link){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)};if($shell){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)};try{Remove-KoseiShortcutStage $stage}catch{}}
}
function Get-KoseiShortcutVersion {
    param([string]$Root)
    try {
        $value=[IO.File]::ReadAllText((Join-Path $Root 'VERSION')).Trim()
        if($value -match '^(\d+)\.(\d+)(?:\.(\d+))?$'){
            return [version]($Matches[1]+'.'+$Matches[2]+'.'+$(if($Matches[3]){$Matches[3]}else{'0'}))
        }
    }catch{}
    return [version]'0.0.0'
}
function Set-KoseiSendToShortcut {
    param([string]$Root=(Get-KoseiRoot),[string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    $shell=$null;$link=$null;$stage=$null
    try {
        $path=Get-KoseiSendToPath $SendToFolder
        $null=[IO.Directory]::CreateDirectory($SendToFolder)
        $stage=New-KoseiShortcutStage
        $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($stage)
        $link.TargetPath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $link.Arguments='-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "'+(Join-Path $Root 'Start-DropReview.ps1')+'"'
        $link.WorkingDirectory=Split-Path -Parent $Root;$link.WindowStyle=7
        $link.Description='PDF校正アシストで校正';$link.Save()
        [IO.File]::Copy($stage,$path,$true)
        return @{ok=$true;action='registered';path=$path;error=''}
    } catch {return @{ok=$false;action='error';error=$_.Exception.Message}}
    finally {if($link){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)};if($shell){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)};try{Remove-KoseiShortcutStage $stage}catch{}}
}
function Remove-KoseiSendToShortcut {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    try {$path=Get-KoseiSendToPath $SendToFolder;[IO.File]::Delete($path);return @{ok=$true;action='removed';path=$path;error=''}}
    catch{return @{ok=$false;action='error';error=$_.Exception.Message}}
}
function Repair-KoseiSendToShortcut {
    param([string]$Root=(Get-KoseiRoot),[string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    try {
        $path=Get-KoseiSendToPath $SendToFolder
        if(![IO.File]::Exists($path)){return @{ok=$true;action='unregistered'}}
        $link=Get-KoseiSendToShortcutInfo $SendToFolder
        if(!$link.ok){return $link}
        if($link.Arguments -notmatch '(?i)-File\s+"([^"]+[\\/]Start-DropReview\.ps1)"'){return @{ok=$false;action='error';error='登録済みショートカットの参照先を確認できません。'}}
        $oldLauncher=$Matches[1];$oldVersion=Get-KoseiShortcutVersion (Split-Path -Parent $oldLauncher);$version=Get-KoseiShortcutVersion $Root
        if([IO.File]::Exists($oldLauncher) -and $oldVersion -ge $version){return @{ok=$true;action='unchanged'}}
        $result=Set-KoseiSendToShortcut -Root $Root -SendToFolder $SendToFolder
        if($result.ok){$result.action='repaired';if(Get-Command Write-KoseiLog -ErrorAction SilentlyContinue){Write-KoseiLog "sendto repaired from=$oldVersion to=$version"}}
        return $result
    }catch{return @{ok=$false;action='error';error=$_.Exception.Message}}
}
