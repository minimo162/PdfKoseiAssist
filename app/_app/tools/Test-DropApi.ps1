$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src/Paths.ps1')
. (Join-Path $root 'src/Server.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-drop-api-' + [guid]::NewGuid().ToString('N'))
$previous = $env:PDF_KOSEI_DATA_DIR
$env:PDF_KOSEI_DATA_DIR = $testRoot
$id = '0123456789abcdef0123456789abcdef'
$session = Join-Path (Get-KoseiSubDir 'drop') $id
$null = New-Item -ItemType Directory -Path $session
function Send-KoseiJson { param($Response, $StatusCode, $Object) $script:status = $StatusCode }
function Invoke-Probe {
    param([string]$Path, [string]$Method='GET', [string]$Origin='http://127.0.0.1:8098', [byte[]]$Bytes=@(), [long]$Limit=1073741824, [string]$Referer='')
    $stream = [IO.MemoryStream]::new($Bytes, $false)
    $output = [IO.MemoryStream]::new()
    $request = [pscustomobject]@{HttpMethod=$Method;Url=[uri]('http://127.0.0.1:8098'+$Path);RawUrl=$Path;Headers=@{Origin=$Origin;Referer=$Referer};RemoteEndPoint=[Net.IPEndPoint]::new([Net.IPAddress]::Loopback,1234);ContentLength64=$Bytes.Length;InputStream=$stream}
    $response = [pscustomobject]@{StatusCode=0;ContentType='';ContentLength64=0;OutputStream=$output}
    $script:status = 0
    try {
        Invoke-KoseiRoute -Context ([pscustomobject]@{Request=$request;Response=$response}) -Settings @{drop_report_max_bytes=$Limit} -ServerState @{Url='http://127.0.0.1:8098/'}
        if ($response.StatusCode) { return $response.StatusCode }
        return $script:status
    } finally { $stream.Dispose(); $output.Dispose() }
}
function Expect($Actual, $Expected) { if ($Actual -ne $Expected) { throw "Expected $Expected, got $Actual" } }
try {
    Expect (Invoke-Probe "/api/drop/$id/input/1") 404
    [IO.File]::WriteAllText((Join-Path $session 'session.json'), '{}')
    [IO.File]::WriteAllBytes((Join-Path $session 'input1.pdf'), [byte[]]@(37,80,68,70))
    Expect (Invoke-Probe "/api/drop/$id/input/1") 200
    Expect (Invoke-Probe "/api/drop/$id/input/1" -Origin '' -Referer 'http://127.0.0.1:8098/?drop=x') 200
    Expect (Invoke-Probe "/api/drop/$id/input/1" -Origin '') 403
    Expect (Invoke-Probe "/api/drop/$id/input/1" -Origin 'https://evil.example') 403
    Expect (Invoke-Probe '/api/drop/UPPERCASE/input/1') 400
    Expect (Invoke-Probe "/api/drop/$id/input/../input/1") 400
    Expect (Invoke-Probe "/api/drop/$id/input/3") 400
    Expect (Invoke-Probe "/api/drop/$id/report" -Method POST -Bytes ([byte[]]@(1,2,3)) -Limit 2) 413
    $large = New-Object byte[] (50MB)
    $large[0]=80; $large[$large.Length-1]=75
    Expect (Invoke-Probe "/api/drop/$id/report" -Method POST -Bytes $large) 200
    $file = Join-Path $session 'report.zip'
    Expect (Get-Item -LiteralPath $file).Length $large.Length
    $saved = [IO.File]::OpenRead($file)
    try { Expect ($saved.ReadByte()) 80; $null=$saved.Seek(-1,[IO.SeekOrigin]::End); Expect ($saved.ReadByte()) 75 } finally { $saved.Dispose() }
    if (Test-Path -LiteralPath (Join-Path $session 'report.zip.partial')) { throw 'partial remained' }
    Expect (Invoke-Probe "/api/drop/$id/report" -Method POST -Bytes $large) 409
    Write-Host 'PASS DropApi (including 50 MB streaming upload)'
} finally {
    $env:PDF_KOSEI_DATA_DIR = $previous
    # Only files created by this test, in its unique temporary directory.
    foreach ($name in @('report.zip','report.zip.partial','session.json','input1.pdf')) { [IO.File]::Delete((Join-Path $session $name)) }
    [IO.Directory]::Delete($session)
    [IO.Directory]::Delete((Join-Path $testRoot 'drop'))
    [IO.Directory]::Delete($testRoot)
}
