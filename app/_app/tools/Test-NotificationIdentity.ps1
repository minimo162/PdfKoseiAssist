$ErrorActionPreference='Stop'
# 完了通知の差出人を「PDF校正アシスト」にする登録（実機では差出人が「Windows PowerShell」になっていた）。
# あわせて、利用者の手元で動くスクリプトが C# をコンパイルしない（csc.exe を起動しない）ことを確かめる（#220）。
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DesktopUi.ps1')
$appId='PdfKoseiAssist.Test.'+[guid]::NewGuid().ToString('N')
$key='HKCU:\Software\Classes\AppUserModelId\'+$appId
try {
    if(!(Set-KoseiNotificationIdentity -AppId $appId -DisplayName 'PDF校正アシスト')){throw 'AppUserModelID was not registered'}
    if((Get-ItemProperty -LiteralPath $key).DisplayName -ne 'PDF校正アシスト'){throw 'Display name was not registered'}
    # 2回目（同じプロセスで再登録）も失敗しない。
    if(!(Set-KoseiNotificationIdentity -AppId $appId -DisplayName 'PDF校正アシスト')){throw 'Second registration failed'}
    $appRoot=Split-Path -Parent $PSScriptRoot
    $source=[IO.File]::ReadAllText((Join-Path $appRoot 'Start-DropReview.ps1'))
    $identityAt=$source.IndexOf('Set-KoseiNotificationIdentity');$trayAt=$source.IndexOf('Invoke-KoseiDesktopWorker')
    if($identityAt -lt 0 -or $trayAt -lt 0 -or $identityAt -gt $trayAt){throw 'Identity must be set before any tray window is created'}
    # Add-Type -TypeDefinition / -MemberDefinition / -Path(.cs) は csc.exe を起動する。csc.exe が禁止された社内PCでは
    # 「プログラムを実行できません」になる。利用者の手元で動くスクリプト（tools 以外）に残さない。
    # （index.html の中で書き出すレポート用のスクリプトも対象にする。）
    $compiled=@()
    $files=@(Get-ChildItem -LiteralPath $appRoot -Recurse -File -Include '*.ps1','*.html' | Where-Object { $_.FullName -notlike (Join-Path $appRoot 'tools\*') -and $_.FullName -notlike (Join-Path $appRoot 'docs\*') })
    foreach($file in $files){
        $text=[IO.File]::ReadAllText($file.FullName)
        if($text -match '(?i)Add-Type\b[^\r\n]*-(TypeDefinition|MemberDefinition)\b' -or $text -match '(?i)CSharpCodeProvider|CompileAssemblyFrom'){$compiled+=$file.FullName.Substring($appRoot.Length+1)}
    }
    if($files.Count -lt 5){throw ('Too few app scripts were scanned: '+$files.Count)}
    if($compiled.Count){throw ('C# compilation (csc.exe) must not be used in app scripts: '+($compiled -join ', '))}
    Write-Host 'PASS NotificationIdentity'
} finally {
    if(Test-Path -LiteralPath $key){Remove-Item -LiteralPath $key -Recurse -Force}
}
