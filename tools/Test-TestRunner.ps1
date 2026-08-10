$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$relativeRoot = 'output\test-runner-selftest-' + [guid]::NewGuid().ToString('N')
$testRoot = Join-Path $repoRoot $relativeRoot
$resultsRoot = Join-Path $testRoot 'results'
New-Item -ItemType Directory -Path $testRoot,$resultsRoot -Force | Out-Null
try {
    $failPath = Join-Path $testRoot 'Test-Fail.ps1'
    $passPath = Join-Path $testRoot 'Test-Pass.ps1'
    [IO.File]::WriteAllText($failPath, "Write-Host 'intentional fail'; exit 1")
    [IO.File]::WriteAllText($passPath, "Write-Host 'pass after fail'; exit 0")
    $manifestPath = Join-Path $testRoot 'manifest.json'
    $relativeFail = ($failPath.Substring($repoRoot.Length + 1) -replace '\\','/')
    $relativePass = ($passPath.Substring($repoRoot.Length + 1) -replace '\\','/')
    $manifest = @{ tests = @(
        @{ path=$relativeFail; suite='fast'; timeout_seconds=5 },
        @{ path=$relativePass; suite='fast'; timeout_seconds=5 }
    ) } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($manifestPath, $manifest)

    $runner = Join-Path $PSScriptRoot 'Run-Tests.ps1'
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -Suite fast -ManifestFile $manifestPath -DiscoveryDirectories $relativeRoot -ResultsDirectory $resultsRoot 2>&1
    $runnerExit = $LASTEXITCODE; $ErrorActionPreference = $savedPreference
    if ($runnerExit -eq 0) { throw 'fail followed by pass was incorrectly reported as success' }
    if (($output -join "`n") -notmatch 'Test-Pass\.ps1[\s\S]*PASS') { throw 'runner stopped before the later passing test' }

    $unclassifiedPath = Join-Path $testRoot 'Test-Unclassified.ps1'
    [IO.File]::WriteAllText($unclassifiedPath, 'exit 0')
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -Suite fast -ManifestFile $manifestPath -DiscoveryDirectories $relativeRoot -ResultsDirectory $resultsRoot -ValidateManifestOnly 2>&1
    $runnerExit = $LASTEXITCODE; $ErrorActionPreference = $savedPreference
    if ($runnerExit -ne 2) { throw 'unclassified test did not fail manifest validation' }

    [IO.File]::Delete($unclassifiedPath)
    [IO.File]::Delete($failPath)
    [IO.File]::Delete($passPath)
    $hangPath = Join-Path $testRoot 'Test-Hang.ps1'
    [IO.File]::WriteAllText($hangPath, 'Start-Sleep -Seconds 30; exit 0')
    $relativeHang = ($hangPath.Substring($repoRoot.Length + 1) -replace '\\','/')
    [IO.File]::WriteAllText($manifestPath, (@{tests=@(@{path=$relativeHang;suite='fast';timeout_seconds=1})} | ConvertTo-Json -Depth 5))
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -Suite fast -ManifestFile $manifestPath -DiscoveryDirectories $relativeRoot -ResultsDirectory $resultsRoot 2>&1
    $runnerExit = $LASTEXITCODE; $ErrorActionPreference = $savedPreference
    $stopwatch.Stop()
    # Process/job teardown can take several seconds on a loaded Windows CI host.
    # The child sleeps for 30s, so a 20s outer bound still proves forced timeout
    # while avoiding a false failure caused by PowerShell startup/cleanup jitter.
    if ($runnerExit -eq 0 -or $stopwatch.Elapsed.TotalSeconds -gt 20) { throw 'hung test was not terminated within its deadline' }

    'Test-TestRunner: PASS'
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
