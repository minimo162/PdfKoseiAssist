# Launch the production Edge client using a fresh, unsigned-in temporary
# profile and about:blank only. Never connect this test to a user's CDP port.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$originalData=[Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')
$originalLaunch=[Environment]::GetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID')
$tempRoot=Join-Path ([IO.Path]::GetTempPath()) ('kosei-edge-isolated-'+[guid]::NewGuid().ToString('N')+' テスト User')
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$version=$null;$settings=$null
try {
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR',$tempRoot)
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID',[guid]::NewGuid().ToString('N'))
    . (Join-Path $root 'src/Paths.ps1')
    Set-KoseiRoot -Root $root
    . (Join-Path $root 'src/Settings.ps1')
    . (Join-Path $root 'src/CopilotClient.ps1')
    $settings=Get-KoseiDefaultSettings
    $settings.cdp_port=$port; $settings.copilot_url='about:blank'; $settings.browser_display_mode='minimized'
    Start-KoseiCopilotEdge -Settings $settings -FreshLaunchTarget
    $version=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
    $reply=Invoke-KoseiCdpMethod -WebSocketUrl $version.webSocketDebuggerUrl -Method 'Browser.getVersion'
    if($reply.error -or -not $reply.result.product){throw 'production CDP failed'}
    Write-Host 'PASS fresh Edge with spaced Unicode profile; production originless CDP works'

    # There are no accounts, documents, or network pages in this browser.
    $ws=[Net.WebSockets.ClientWebSocket]::new()
    $cts=[Threading.CancellationTokenSource]::new(5000)
    $ws.Options.SetRequestHeader('Origin','https://example.invalid')
    $rejected=$false
    try { $null=$ws.ConnectAsync([uri]$version.webSocketDebuggerUrl,$cts.Token).GetAwaiter().GetResult() }
    catch { $rejected=($_.Exception.ToString() -match '403') }
    finally { $ws.Dispose();$cts.Dispose() }
    if(-not $rejected){throw 'foreign Origin was not rejected with HTTP 403'}
    $reply=Invoke-KoseiCdpMethod -WebSocketUrl $version.webSocketDebuggerUrl -Method 'Browser.getVersion'
    if($reply.error -or -not $reply.result.product){throw 'browser became unavailable after rejection'}
    Write-Host 'PASS isolated browser rejects foreign Origin with 403 and still accepts product CDP'
} finally {
    # Close only the browser on the ephemeral port reserved by this test.
    if($settings -and (Test-KoseiDevTools -Port $port)){
        try {
            $owned=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
            $null=Invoke-KoseiCdpMethod -WebSocketUrl $owned.webSocketDebuggerUrl -Method 'Browser.close' -TimeoutSeconds 5
        } catch {}
        for($i=0;$i -lt 20 -and (Test-KoseiDevTools -Port $port);$i++){Start-Sleep -Milliseconds 500}
    }
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR',$originalData)
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_LAUNCH_ID',$originalLaunch)
    $resolved=[IO.Path]::GetFullPath($tempRoot)
    if(-not $resolved.StartsWith((Join-Path ([IO.Path]::GetTempPath()) 'kosei-edge-isolated-'),[StringComparison]::OrdinalIgnoreCase)){throw 'unsafe test cleanup path'}
    if(Test-Path -LiteralPath $resolved){
        $removed=$false
        for($i=0;$i -lt 10;$i++){
            try {Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop;$removed=$true;break}
            catch {Start-Sleep -Milliseconds 500}
        }
        if(-not $removed){throw 'temporary Edge profile could not be removed'}
    }
}
Write-Host 'Test-EdgeLaunchIntegration: PASS'
