# File transfer is restricted to launcher-created sessions and fixed filenames.
function Invoke-KoseiDropRoute {
    param($Request, $Response, $Settings, $ServerState)
    $method = $Request.HttpMethod.ToUpperInvariant()
    $path = $Request.Url.AbsolutePath
    if ($path -cnotmatch '^/api/drop/([0-9a-f]{32})/(input/([12])|report)$' -or $Request.RawUrl -match '(?i)%2e|%2f|%5c|\.\.') {
        Send-KoseiJson $Response 400 @{error='Invalid drop route'}; return
    }
    $id = $Matches[1]; $operation = $Matches[2]; $number = $Matches[3]
    if (($operation -eq 'report' -and $method -ne 'POST') -or ($operation -ne 'report' -and $method -ne 'GET')) {
        Send-KoseiJson $Response 405 @{error='Method not allowed'}; return
    }
    # Same-origin GET normally omits Origin; require its same-origin Referer.
    $origin = [string]$Request.Headers['Origin']
    if ($method -eq 'GET' -and [string]::IsNullOrWhiteSpace($origin)) {
        try { $origin = ([uri]$Request.Headers['Referer']).GetLeftPart([UriPartial]::Authority) } catch {}
    }
    $originRequest = [pscustomobject]@{HttpMethod='POST';RemoteEndPoint=$Request.RemoteEndPoint;Headers=@{Origin=$origin}}
    if (-not (Test-KoseiLocalShutdownRequest -Request $originRequest -ServerState $ServerState)) {
        Send-KoseiJson $Response 403 @{error='Origin rejected'}; return
    }
    $dropRoot = Get-KoseiSubDir 'drop'
    $session = Join-Path $dropRoot $id
    if (!(Test-Path -LiteralPath (Join-Path $session 'session.json') -PathType Leaf)) {
        Send-KoseiJson $Response 404 @{error='Session not found'}; return
    }
    foreach ($item in @($dropRoot, $session, (Join-Path $session 'session.json'))) {
        if ((Get-Item -LiteralPath $item).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Send-KoseiJson $Response 403 @{error='Reparse points are not allowed'}; return
        }
    }
    if ($method -eq 'GET') {
        $inputPath = Join-Path $session ('input' + $number + '.pdf')
        if (!(Test-Path -LiteralPath $inputPath -PathType Leaf)) { Send-KoseiJson $Response 404 @{error='Input not found'}; return }
        if ((Get-Item -LiteralPath $inputPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { Send-KoseiJson $Response 403 @{error='Reparse point'}; return }
        $file = [IO.File]::OpenRead($inputPath)
        try {
            $Response.StatusCode = 200
            $Response.ContentType = 'application/pdf'
            $Response.ContentLength64 = $file.Length
            $file.CopyTo($Response.OutputStream)
        } finally { $file.Dispose(); $Response.OutputStream.Close() }
        return
    }
    $limit = 1073741824L
    if ($Settings.drop_report_max_bytes -gt 0) { $limit = [long]$Settings.drop_report_max_bytes }
    if ($Request.ContentLength64 -gt $limit) { Send-KoseiJson $Response 413 @{error='Report too large'}; return }
    $partial = Join-Path $session 'report.zip.partial'
    $final = Join-Path $session 'report.zip'
    if ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $final)) { Send-KoseiJson $Response 409 @{error='Report already exists'}; return }
    $owned = $false; $file = $null; $bytes = 0L
    try {
        $file = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $owned = $true
        $buffer = New-Object byte[] 65536
        while (($count = $Request.InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $bytes += $count
            if ($bytes -gt $limit) { Send-KoseiJson $Response 413 @{error='Report too large'}; return }
            $file.Write($buffer, 0, $count)
        }
        if ($Request.ContentLength64 -ge 0 -and $bytes -ne $Request.ContentLength64) { throw 'Incomplete report body' }
        $file.Dispose(); $file = $null
        [IO.File]::Move($partial, $final)
        Send-KoseiJson $Response 200 @{ok=$true;bytes=$bytes}
    } finally {
        if ($file) { $file.Dispose() }
        if ($owned -and (Test-Path -LiteralPath $partial)) { [IO.File]::Delete($partial) }
    }
}
