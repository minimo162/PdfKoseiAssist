param([string]$SendToFolder=[Environment]::GetFolderPath('SendTo'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'src/Paths.ps1');Set-KoseiRoot $PSScriptRoot
foreach($module in @('Settings','CopilotClient','SendToShortcut','DesktopUi','Setup')){. (Join-Path $PSScriptRoot ('src/'+$module+'.ps1'))}
exit (Invoke-KoseiSetup -SendToFolder $SendToFolder)
