$ErrorActionPreference='Stop'
# 完了通知の差出人を「PDF校正アシスト」にする登録（実機では差出人が「Windows PowerShell」になっていた）。
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DesktopUi.ps1')
$appId='PdfKoseiAssist.Test.'+[guid]::NewGuid().ToString('N')
$key='HKCU:\Software\Classes\AppUserModelId\'+$appId
try {
    if(!(Set-KoseiNotificationIdentity -AppId $appId -DisplayName 'PDF校正アシスト')){throw 'AppUserModelID was not applied'}
    if((Get-ItemProperty -LiteralPath $key).DisplayName -ne 'PDF校正アシスト'){throw 'Display name was not registered'}
    Add-Type -Namespace KoseiTest -Name AppIdReader -MemberDefinition '[DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int GetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] out string appID);'
    $current=$null
    if([KoseiTest.AppIdReader]::GetCurrentProcessExplicitAppUserModelID([ref]$current) -ne 0 -or $current -ne $appId){throw ('Process AppUserModelID was not set: '+$current)}
    # 2回目（同じプロセスで再登録）も失敗しない。
    if(!(Set-KoseiNotificationIdentity -AppId $appId -DisplayName 'PDF校正アシスト')){throw 'Second registration failed'}
    $source=[IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'Start-DropReview.ps1'))
    $identityAt=$source.IndexOf('Set-KoseiNotificationIdentity');$trayAt=$source.IndexOf('Invoke-KoseiDesktopWorker')
    if($identityAt -lt 0 -or $trayAt -lt 0 -or $identityAt -gt $trayAt){throw 'Identity must be set before any tray window is created'}
    Write-Host 'PASS NotificationIdentity'
} finally {
    if(Test-Path -LiteralPath $key){Remove-Item -LiteralPath $key -Recurse -Force}
}
