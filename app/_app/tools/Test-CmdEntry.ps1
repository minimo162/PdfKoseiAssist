$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$source=Join-Path $repo 'app/PDF校正アシスト起動.cmd'
$bytes=[IO.File]::ReadAllBytes($source);$text=[Text.Encoding]::UTF8.GetString($bytes)
if($bytes[0] -eq 239 -or $text -match '(?<!\r)\n'){throw 'CMD must be UTF-8 without BOM and CRLF'}
$tail=$text.Substring($text.IndexOf('set "PS1='));$sha=[Security.Cryptography.SHA256]::Create()
try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($tail)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if($hash -ne 'e7548c4ac16bcb01996781770efb881252ef9f396334b37b8a6bc1de9e8f5e80'){throw 'Original no-argument behavior changed'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-cmd-'+[guid]::NewGuid().ToString('N'))
$app=Join-Path $temp '日本語 入口';$inner=Join-Path $app '_app'
$null=[IO.Directory]::CreateDirectory($inner)
$entry=Join-Path $app 'start.cmd';[IO.File]::WriteAllBytes($entry,$bytes)
$stub='[CmdletBinding(PositionalBinding=$false)]param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths); [IO.File]::WriteAllText((Join-Path $PSScriptRoot "result.json"),(@{entry=[IO.Path]::GetFileName($PSCommandPath);paths=@($Paths)}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)); exit 0'
foreach($name in @('Start-KoseiAssist.ps1','Start-DropReview.ps1')){[IO.File]::WriteAllText((Join-Path $inner $name),$stub,[Text.UTF8Encoding]::new($true))}
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
    return ([IO.File]::ReadAllText($result)|ConvertFrom-Json)
}
try {
    $normal=Invoke-TestCmd @()
    if($normal.entry -ne 'Start-KoseiAssist.ps1'){throw 'No-argument path was not normal startup'}
    $paths=@((Join-Path $app '英文 (1).pdf'),(Join-Path $app '日本語 原稿.pdf'))
    $drop=Invoke-TestCmd $paths
    if($drop.entry -ne 'Start-DropReview.ps1' -or $drop.paths.Count -ne 2 -or $drop.paths[0] -cne $paths[0] -or $drop.paths[1] -cne $paths[1]){throw 'Dropped paths changed'}
    Write-Host 'PASS CmdEntry (real cmd.exe/powershell.exe; original normal tail bytes preserved)'
}finally{
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-cmd-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
