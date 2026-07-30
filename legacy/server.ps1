param()
# PDF Kosei Assist local-only static server.
# Static local server only. HTML issue viewer ZIP generation is done in the browser; no server-side POST API is required.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupLog = Join-Path $Root 'startup-log.txt'
$UrlFile = Join-Path $Root 'local-app.url'
$PidFile = Join-Path $Root 'local-app.pid'
$HostAddress = '127.0.0.1'
$HeartbeatTimeoutSeconds = 3600
$NoBrowserTimeoutSeconds = 600

function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $StartupLog -Encoding UTF8 -Value ('[' + (Get-Date).ToUniversalTime().ToString('s') + 'Z] ' + $Message) } catch {}
}
function Get-ContentType([string]$Path) {
  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  switch ($ext) {
    '.html' { 'text/html; charset=utf-8'; break }
    '.htm'  { 'text/html; charset=utf-8'; break }
    '.js'   { 'text/javascript; charset=utf-8'; break }
    '.mjs'  { 'text/javascript; charset=utf-8'; break }
    '.json' { 'application/json; charset=utf-8'; break }
    '.css'  { 'text/css; charset=utf-8'; break }
    '.txt'  { 'text/plain; charset=utf-8'; break }
    '.md'   { 'text/markdown; charset=utf-8'; break }
    '.wasm' { 'application/wasm'; break }
    '.bcmap' { 'application/octet-stream'; break }
    '.png'  { 'image/png'; break }
    '.jpg'  { 'image/jpeg'; break }
    '.jpeg' { 'image/jpeg'; break }
    '.svg'  { 'image/svg+xml'; break }
    default { 'application/octet-stream'; break }
  }
}
function Write-ResponseBytes($Stream, [int]$StatusCode, [string]$StatusText, [string]$ContentType, [byte[]]$Body) {
  if ($null -eq $Body) { $Body = New-Object byte[] 0 }
  $header = "HTTP/1.1 $StatusCode $StatusText`r`n" +
            "Content-Type: $ContentType`r`n" +
            "Content-Length: $($Body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "X-Content-Type-Options: nosniff`r`n" +
            "Connection: close`r`n" +
            "`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}
function Write-TextResponse($Stream, [int]$StatusCode, [string]$StatusText, [string]$Text, [string]$ContentType) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Write-ResponseBytes $Stream $StatusCode $StatusText $ContentType $bytes
}
function Resolve-SafeFilePath([string]$UrlPath) {
  try {
    $pathOnly = $UrlPath.Split('?')[0]
    $decoded = [System.Uri]::UnescapeDataString($pathOnly)
  } catch { return $null }
  if ([string]::IsNullOrWhiteSpace($decoded) -or $decoded -eq '/') { $decoded = '/index.html' }
  $relative = $decoded.TrimStart('/','\')
  if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $relative))
  $rootFull = [System.IO.Path]::GetFullPath($Root)
  if (-not $rootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $rootFull += [System.IO.Path]::DirectorySeparatorChar }
  if ($candidate.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or $candidate.Equals($rootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) { return $candidate }
  return $null
}
function Handle-Client($Client) {
  $stream = $null; $reader = $null
  try {
    $stream = $Client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) { return }
    $parts = $requestLine.Split(' ')
    if ($parts.Length -lt 2) { Write-TextResponse $stream 400 'Bad Request' 'Bad Request' 'text/plain; charset=utf-8'; return }
    $method = $parts[0].ToUpperInvariant()
    $target = $parts[1]
    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line -or $line -eq '') { break }
    }
    $pathOnly = $target.Split('?')[0]
    if ($pathOnly -eq '/__health') { Write-TextResponse $stream 200 'OK' '{"ok":true}' 'application/json; charset=utf-8'; return }
    if ($pathOnly -eq '/__heartbeat') { $script:HasBrowserHeartbeat = $true; $script:LastHeartbeat = Get-Date; $script:CloseAt = $null; Write-ResponseBytes $stream 204 'No Content' 'text/plain; charset=utf-8' (New-Object byte[] 0); return }
    if ($pathOnly -eq '/__page-closed') { $script:CloseAt = (Get-Date).AddSeconds(2); Write-ResponseBytes $stream 204 'No Content' 'text/plain; charset=utf-8' (New-Object byte[] 0); return }
    if ($pathOnly -eq '/__shutdown') { Write-TextResponse $stream 200 'OK' 'Local app server is stopping. You can close this tab.' 'text/plain; charset=utf-8'; $script:ShouldStop = $true; return }
    if ($method -ne 'GET' -and $method -ne 'HEAD') { Write-TextResponse $stream 405 'Method Not Allowed' 'Method Not Allowed' 'text/plain; charset=utf-8'; return }
    $filePath = Resolve-SafeFilePath $target
    if ($null -eq $filePath) { Write-TextResponse $stream 403 'Forbidden' 'Forbidden' 'text/plain; charset=utf-8'; return }
    if (Test-Path -LiteralPath $filePath -PathType Container) { $filePath = Join-Path $filePath 'index.html' }
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { Write-TextResponse $stream 404 'Not Found' 'Not found' 'text/plain; charset=utf-8'; return }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    if ($method -eq 'HEAD') { $bytes = New-Object byte[] 0 }
    Write-ResponseBytes $stream 200 'OK' (Get-ContentType $filePath) $bytes
  } catch {
    try { if ($null -ne $stream) { Write-TextResponse $stream 500 'Internal Server Error' $_.Exception.Message 'text/plain; charset=utf-8' } } catch {}
    Write-Log ('client error: ' + $_.Exception.ToString())
  } finally {
    try { $reader.Dispose() } catch {}
    try { $Client.Close() } catch {}
  }
}

try {
  Set-Content -LiteralPath $StartupLog -Encoding UTF8 -Value ('[' + (Get-Date).ToUniversalTime().ToString('s') + 'Z] starting PowerShell local server')
  Set-Content -LiteralPath $PidFile -Encoding ASCII -Value $PID
  try { Remove-Item -LiteralPath $UrlFile -Force -ErrorAction SilentlyContinue } catch {}
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($HostAddress), 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $url = 'http://' + $HostAddress + ':' + $port + '/'
  Set-Content -LiteralPath $UrlFile -Encoding ASCII -Value $url
  Write-Log ('server listening: ' + $url)
  $script:HasBrowserHeartbeat = $false
  $script:LastHeartbeat = Get-Date
  $script:CloseAt = $null
  $script:ShouldStop = $false
  $startedAt = Get-Date
  while (-not $script:ShouldStop) {
    if ($listener.Pending()) { $client = $listener.AcceptTcpClient(); Handle-Client $client }
    else { Start-Sleep -Milliseconds 80 }
    $now = Get-Date
    if (-not $script:HasBrowserHeartbeat -and (($now - $startedAt).TotalSeconds -gt $NoBrowserTimeoutSeconds)) { Write-Log 'shutdown: browser did not connect after startup'; break }
    if ($script:HasBrowserHeartbeat -and (($now - $script:LastHeartbeat).TotalSeconds -gt $HeartbeatTimeoutSeconds)) { Write-Log 'shutdown: browser heartbeat stopped'; break }
    if ($null -ne $script:CloseAt -and $now -ge $script:CloseAt) { Write-Log 'shutdown: browser tab closed'; break }
  }
} catch {
  Write-Log ('fatal: ' + $_.Exception.ToString())
  throw
} finally {
  try { if ($listener) { $listener.Stop() } } catch {}
  try { Remove-Item -LiteralPath $UrlFile -Force -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue } catch {}
}
