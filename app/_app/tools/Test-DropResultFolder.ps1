$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DropFiles.ps1')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temp=Join-Path ([IO.Path]::GetTempPath()) ('kosei-result-'+[guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($temp)
function Make-Zip($Name,$EntryName) {
    $path=Join-Path $temp $Name
    $zip=[IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
    try{$entry=$zip.CreateEntry($EntryName);$writer=[IO.StreamWriter]::new($entry.Open());try{$writer.Write('日本語')}finally{$writer.Dispose()}}finally{$zip.Dispose()}
    return $path
}
try {
    $zip=Make-Zip 'good.zip' '_data/指摘.json'
    $target=Join-Path $temp '英文.pdf'
    $first=Expand-KoseiDropReport $zip $target
    if([IO.File]::ReadAllText((Join-Path $first.path '_data/指摘.json')) -ne '日本語'){throw 'UTF-8 entry failed'}
    [IO.File]::WriteAllText((Join-Path $first.path '_data/確認状況.json'),'preserve')
    $second=Expand-KoseiDropReport $zip $target
    if(!$second.path.EndsWith(' (2)')){throw 'Collision suffix failed'}
    if([IO.File]::ReadAllText((Join-Path $first.path '_data/確認状況.json')) -ne 'preserve'){throw 'Existing marks changed'}
    $partial=Expand-KoseiDropReport $zip $target -Incomplete
    if(!$partial.path.EndsWith('_一部未完了')){throw 'Incomplete suffix failed'}
    # 結果フォルダの上の階層は入口の .cmd と _data だけ。レポート本体は _data の中に展開される（#203）。
    $layoutZip=Join-Path $temp 'layout.zip'
    $archive=[IO.Compression.ZipFile]::Open($layoutZip,[IO.Compression.ZipArchiveMode]::Create)
    try{foreach($entryName in @('指摘レポートを開く.cmd','_data/指摘レポート.html','_data/report-server.ps1')){$entry=$archive.CreateEntry($entryName);$writer=[IO.StreamWriter]::new($entry.Open());try{$writer.Write('x')}finally{$writer.Dispose()}}}finally{$archive.Dispose()}
    $layout=Expand-KoseiDropReport $layoutZip (Join-Path $temp 'layout.pdf')
    $top=@(Get-ChildItem -LiteralPath $layout.path -Force | ForEach-Object { $_.Name } | Sort-Object)
    if(($top -join '|') -ne ((@('_data','指摘レポートを開く.cmd') | Sort-Object) -join '|')){throw ('Unexpected top level: '+($top -join ', '))}
    if(!(Test-Path -LiteralPath (Join-Path $layout.path '_data/指摘レポート.html') -PathType Leaf)){throw 'Report HTML is not inside _data'}
    foreach($bad in @('../escape.txt','/absolute.txt','C:/absolute.txt','x/../escape.txt')){
        $path=Make-Zip ([guid]::NewGuid().ToString('N')+'.zip') $bad
        $rejected=$false;try{$null=Expand-KoseiDropReport $path $target}catch{$rejected=$true}
        if(!$rejected){throw 'Unsafe zip accepted'}
        if(@(Get-ChildItem -LiteralPath $temp -Force -Filter '*.partial').Count){throw 'Partial folder remained'}
    }
    $blocked=Join-Path $temp 'not-a-directory';[IO.File]::WriteAllText($blocked,'x')
    $fallback=Expand-KoseiDropReport $zip (Join-Path $blocked 'a.pdf') -FallbackRoot (Join-Path $temp 'documents')
    if(!$fallback.fallback -or !$fallback.path.StartsWith((Join-Path $temp 'documents'))){throw 'Fallback failed'}
    Write-Host 'PASS DropResultFolder'
} finally {
    $resolved=[IO.Path]::GetFullPath($temp)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-result-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
