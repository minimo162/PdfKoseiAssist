$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$source=Join-Path $repo 'app/PDF校正アシスト起動.cmd'
$bytes=[IO.File]::ReadAllBytes($source);$text=[Text.Encoding]::UTF8.GetString($bytes)
if($bytes[0] -eq 239 -or $text -match '(?<!\r)\n'){throw 'CMD must be UTF-8 without BOM and CRLF'}
$tail=$text.Substring($text.IndexOf('set "PS1='));$sha=[Security.Cryptography.SHA256]::Create()
try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($tail)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if($hash -ne '97b9bd307aaf3c2acab9485564c31db24e16cb53d82af91d20adf023aad19d87'){throw 'Original no-argument behavior changed'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-cmd-'+[guid]::NewGuid().ToString('N'))
$app=Join-Path $temp '日本語 入口';$inner=Join-Path $app '_app'
$null=[IO.Directory]::CreateDirectory($inner)
$entry=Join-Path $app 'start.cmd';[IO.File]::WriteAllBytes($entry,$bytes)
# どちらの経路も共有フォルダ配布の入口 Launch-KoseiAssist.ps1 を通り、-Entry で起動先を分ける。
$stub='[CmdletBinding(PositionalBinding=$false)]param([string]$Entry,[Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths); [IO.File]::WriteAllText((Join-Path $PSScriptRoot "result.json"),(@{entry=$Entry;paths=@($Paths)}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)); exit 0'
[IO.File]::WriteAllText((Join-Path $inner 'Launch-KoseiAssist.ps1'),$stub,[Text.UTF8Encoding]::new($true))
function Wait-TestChildren{
    $deadline=(Get-Date).AddSeconds(15)
    while((Get-Date)-lt $deadline){
        $alive=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine -and $_.CommandLine.Contains($temp)})
        if(!$alive.Count){return}
        Start-Sleep -Milliseconds 100
    }
    throw 'Child PowerShell did not exit'
}
function Invoke-TestCmd([string[]]$Paths){
    $result=Join-Path $inner 'result.json';[IO.File]::Delete($result)
    $info=[Diagnostics.ProcessStartInfo]::new('cmd.exe');$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.Arguments='/d /c ""'+$entry+'"'+$(if($Paths){' '+(($Paths|ForEach-Object{'"'+$_+'"'}) -join ' ')}else{''})+'"'
    $process=[Diagnostics.Process]::Start($info)
    if(!$process.WaitForExit(10000)){$process.Kill();throw 'CMD timed out'}
    if($process.ExitCode -ne 0){throw ('CMD failed: '+$process.StandardOutput.ReadToEnd()+$process.StandardError.ReadToEnd())}
    $deadline=(Get-Date).AddSeconds(10)
    while(!(Test-Path -LiteralPath $result) -and (Get-Date)-lt $deadline){Start-Sleep -Milliseconds 50}
    # ドロップ経路は start で PowerShell を切り離して起動するため、cmd.exe の終了後も子が作業フォルダを使っている。
    # 子が終わるまで待たないと、後片付けで「使用中」になり削除に失敗する（CI で断続的に失敗した）。
    Wait-TestChildren
    return ([IO.File]::ReadAllText($result)|ConvertFrom-Json)
}
try {
    $normal=Invoke-TestCmd @()
    if($normal.entry -ne 'App'){throw 'No-argument path was not normal startup'}
    $paths=@((Join-Path $app '英文 (1).pdf'),(Join-Path $app '日本語 原稿.pdf'))
    $drop=Invoke-TestCmd $paths
    if($drop.entry -ne 'Drop' -or $drop.paths.Count -ne 2 -or $drop.paths[0] -cne $paths[0] -or $drop.paths[1] -cne $paths[1]){throw 'Dropped paths changed'}
    Write-Host 'PASS CmdEntry (real cmd.exe/powershell.exe; original normal tail bytes preserved)'
}finally{
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-cmd-[0-9a-f]{32}$'){
        # 片付けの一時的なロック（ウイルス対策の走査など）で合否を変えない。判定はここまでで済んでいる。
        for($i=0;$i -lt 20;$i++){try{Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop;break}catch{if($i -eq 19){Write-Warning ('temp cleanup failed: '+$_.Exception.Message)}else{Start-Sleep -Milliseconds 250}}}
    }
}
