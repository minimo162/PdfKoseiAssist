$ErrorActionPreference='Stop'
# Launch-KoseiAssist.ps1 は入口のスクリプトを & で入れ子に呼ぶ。そのとき GetNewClosure の Tick・Click から
# DesktopUi の関数が見えないと、初回セットアップや「送る」が何も表示せずに終わる（#195）。
# 入口と同じ形（dot-source したモジュールを、関数の中から使う）の子スクリプトを、& で呼んで確かめる。
$desktopUi=Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DesktopUi.ps1'
$dir=Join-Path ([IO.Path]::GetTempPath()) ('kosei-desktopui-nested-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null
try {
    $child=Join-Path $dir 'Entry.ps1'
    Set-Content -LiteralPath $child -Encoding UTF8 -Value @'
param([string]$DesktopUi,[string]$ProgressTitle)
$ErrorActionPreference='Stop'
foreach($module in @($DesktopUi)){. $module}
function Invoke-TestEntry {
    $shared=[hashtable]::Synchronized(@{Status='確認中';Error='';ExitCode=1;Finished=$false;CancelRequested=$false})
    Invoke-KoseiDesktopWorker -Shared $shared -Worker {param($Shared) Start-Sleep -Milliseconds 800;$Shared.ExitCode=0} -WorkerArguments @($shared) -ProgressTitle $ProgressTitle
    return $shared
}
Invoke-TestEntry
'@
    foreach($title in @('','PDF校正アシスト：テスト')){
        $result=& $child -DesktopUi $desktopUi -ProgressTitle $title
        if($result.ExitCode -ne 0 -or $result.Error){throw ('Nested entry failed (title='+$title+'): '+$result.Error)}
    }
    Write-Host 'PASS DesktopUi works when the entry script is invoked nested (as Launch-KoseiAssist.ps1 does)'
} finally {Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue}
