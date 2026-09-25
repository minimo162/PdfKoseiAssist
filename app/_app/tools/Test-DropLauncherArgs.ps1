$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DropFiles.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-drop-args-'+[guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($temp)
try {
    $paths=@('空 白 & % ^ (1).pdf','b.PDF','c.pdf')|ForEach-Object{Join-Path $temp $_}
    foreach($path in $paths){[IO.File]::WriteAllText($path,'PDF')}
    if(@(Resolve-KoseiDropInputs @($paths[0],$paths[0])).Count -ne 1){throw 'Dedup failed'}
    if(@(Resolve-KoseiDropInputs @($paths[0],$paths[1])).Count -ne 2){throw 'Two inputs failed'}
    foreach($invalid in @(@(),@($temp),@((Join-Path $temp 'missing.pdf')),$paths)) {
        $rejected=$false;try{$null=Resolve-KoseiDropInputs $invalid}catch{$rejected=$true}
        if(!$rejected){throw 'Invalid inputs accepted'}
    }
    $stub=Join-Path $temp 'arguments.ps1'
    [IO.File]::WriteAllText($stub,'[CmdletBinding(PositionalBinding=$false)]param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths); $Paths | ConvertTo-Json -Compress',[Text.UTF8Encoding]::new($true))
    $unc='\\localhost\c$\日本語 & % ^ (1).pdf'
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName='powershell.exe';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.StandardOutputEncoding=[Text.Encoding]::UTF8
    # Explicit UTF-8 output in the stub; use real powershell.exe -File argument parsing.
    $content=[IO.File]::ReadAllText($stub).Replace('$Paths | ConvertTo-Json','[Console]::OutputEncoding=[Text.Encoding]::UTF8; $Paths | ConvertTo-Json')
    [IO.File]::WriteAllText($stub,$content,[Text.UTF8Encoding]::new($true))
    $info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$stub+'" "'+$paths[0]+'" "'+$unc+'"'
    $process=[Diagnostics.Process]::Start($info);$json=$process.StandardOutput.ReadToEnd();$process.WaitForExit()
    $received=$json|ConvertFrom-Json
    if($process.ExitCode -ne 0 -or $received.Count -ne 2 -or $received[0] -cne $paths[0] -or $received[1] -cne $unc){throw ('Native argument roundtrip failed: '+$json+' expected='+$paths[0]+' second='+$unc)}
    Write-Host 'PASS DropLauncherArgs'
} finally {
    foreach($path in @($paths)+@((Join-Path $temp 'arguments.ps1'))){[IO.File]::Delete($path)}
    [IO.Directory]::Delete($temp)
}
