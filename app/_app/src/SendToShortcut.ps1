function Get-KoseiSendToPath {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    Join-Path $SendToFolder 'PDF校正アシストで校正.lnk'
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
    $shell=$null;$link=$null
    try {
        $path=Get-KoseiSendToPath $SendToFolder
        $null=[IO.Directory]::CreateDirectory($SendToFolder)
        $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($path)
        $link.TargetPath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $link.Arguments='-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "'+(Join-Path $Root 'Start-DropReview.ps1')+'"'
        $link.WorkingDirectory=Split-Path -Parent $Root;$link.WindowStyle=7
        $link.Description='PDF校正アシストで校正';$link.Save()
        return @{ok=$true;action='registered';path=$path;error=''}
    } catch {return @{ok=$false;action='error';error=$_.Exception.Message}}
    finally {if($link){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)};if($shell){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}}
}
function Remove-KoseiSendToShortcut {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    try {$path=Get-KoseiSendToPath $SendToFolder;[IO.File]::Delete($path);return @{ok=$true;action='removed';path=$path;error=''}}
    catch{return @{ok=$false;action='error';error=$_.Exception.Message}}
}
function Repair-KoseiSendToShortcut {
    param([string]$Root=(Get-KoseiRoot),[string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    $shell=$null;$link=$null
    try {
        $path=Get-KoseiSendToPath $SendToFolder
        if(![IO.File]::Exists($path)){return @{ok=$true;action='unregistered'}}
        $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($path)
        if($link.Arguments -notmatch '(?i)-File\s+"([^"]+[\\/]Start-DropReview\.ps1)"'){return @{ok=$false;action='error';error='登録済みショートカットの参照先を確認できません。'}}
        $oldLauncher=$Matches[1];$oldVersion=Get-KoseiShortcutVersion (Split-Path -Parent $oldLauncher);$version=Get-KoseiShortcutVersion $Root
        if([IO.File]::Exists($oldLauncher) -and $oldVersion -ge $version){return @{ok=$true;action='unchanged'}}
        $result=Set-KoseiSendToShortcut -Root $Root -SendToFolder $SendToFolder
        if($result.ok){$result.action='repaired';if(Get-Command Write-KoseiLog -ErrorAction SilentlyContinue){Write-KoseiLog "sendto repaired from=$oldVersion to=$version"}}
        return $result
    }catch{return @{ok=$false;action='error';error=$_.Exception.Message}}
    finally{if($link){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)};if($shell){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}}
}
