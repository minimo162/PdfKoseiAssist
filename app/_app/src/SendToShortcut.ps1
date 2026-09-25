function Get-KoseiSendToPath {
    param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
    Join-Path $SendToFolder 'PDF校正アシストで校正.lnk'
}
function Initialize-KoseiUnicodeShortcut {
    if('KoseiUnicodeShortcut' -as [type]){return}
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class KoseiUnicodeShortcut {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class ShellLink {}
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr data, uint flags);
        void GetIDList(out IntPtr value); void SetIDList(IntPtr value);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetHotkey(out short value); void SetHotkey(short value);
        void GetShowCmd(out int value); void SetShowCmd(int value);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
    }
    public sealed class Info {
        public bool ok=true; public string Arguments; public string WorkingDirectory; public string TargetPath; public int WindowStyle;
    }
    public static void SetUnicodeProperties(string file, string arguments, string directory, string description) {
        var link=(IShellLinkW)new ShellLink();
        try { var persist=(IPersistFile)link; persist.Load(file,0); link.SetArguments(arguments); link.SetWorkingDirectory(directory); link.SetDescription(description); persist.Save(file,true); }
        finally { Marshal.FinalReleaseComObject(link); }
    }
    public static Info Read(string file) {
        var link=(IShellLinkW)new ShellLink();
        try {
            ((IPersistFile)link).Load(file,0); var args=new StringBuilder(32768); var dir=new StringBuilder(32768); var path=new StringBuilder(32768); int show;
            link.GetArguments(args,args.Capacity);link.GetWorkingDirectory(dir,dir.Capacity);link.GetPath(path,path.Capacity,IntPtr.Zero,0);link.GetShowCmd(out show);
            return new Info{Arguments=args.ToString(),WorkingDirectory=dir.ToString(),TargetPath=path.ToString(),WindowStyle=show};
        } finally {Marshal.FinalReleaseComObject(link);}
    }
}
'@
}
function New-KoseiShortcutStage {
    # WSH uses ANSI filenames/properties on English Windows. Keep creation
    # through WScript.Shell, then persist properties through IShellLinkW.
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
    try{
        Initialize-KoseiUnicodeShortcut
        return [KoseiUnicodeShortcut]::Read((Get-KoseiSendToPath $SendToFolder))
    }catch{return @{ok=$false;error=$_.Exception.Message}}
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
        Initialize-KoseiUnicodeShortcut
        [KoseiUnicodeShortcut]::SetUnicodeProperties($stage,('-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "'+(Join-Path $Root 'Start-DropReview.ps1')+'"'),(Split-Path -Parent $Root),'PDF校正アシストで校正')
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
