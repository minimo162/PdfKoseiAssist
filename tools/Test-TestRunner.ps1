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
    $hangScript = @'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'hang.pid'), [string]$PID)
$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -PassThru
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'hang-child.pid'), [string]$child.Id)
Start-Sleep -Seconds 30
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'hang.completed'), 'completed')
'@
    [IO.File]::WriteAllText($hangPath, $hangScript)
    $hangPidPath = Join-Path $testRoot 'hang.pid'
    $hangChildPidPath = Join-Path $testRoot 'hang-child.pid'
    $hangCompletedPath = Join-Path $testRoot 'hang.completed'
    $relativeHang = ($hangPath.Substring($repoRoot.Length + 1) -replace '\\','/')
    [IO.File]::WriteAllText($manifestPath, (@{tests=@(@{path=$relativeHang;suite='fast';timeout_seconds=1})} | ConvertTo-Json -Depth 5))
    Get-ChildItem -LiteralPath $resultsRoot -Filter 'tests-fast-*' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction Stop
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $hangOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -Suite fast -ManifestFile $manifestPath -DiscoveryDirectories $relativeRoot -ResultsDirectory $resultsRoot 2>&1)
    $runnerExit = $LASTEXITCODE; $ErrorActionPreference = $savedPreference
    $stopwatch.Stop()
    # The child sleeps for 30s.  The outer bound is deliberately separate from
    # the 1s product deadline so startup/CI scheduling jitter cannot turn a
    # valid timeout into a false failure, while a leaked process still fails
    # deterministically below.
    if ($runnerExit -eq 0 -or $stopwatch.Elapsed.TotalSeconds -gt 20) {
        throw ('hung test was not terminated within its deadline. elapsed=' + $stopwatch.Elapsed.TotalSeconds + ' exit=' + $runnerExit + ' output=' + ($hangOutput -join "`n"))
    }
    $hangResultFiles = @(Get-ChildItem -LiteralPath $resultsRoot -Filter 'tests-fast-*.json' -File -ErrorAction SilentlyContinue)
    if ($hangResultFiles.Count -ne 1) {
        throw ('hung test did not produce exactly one result JSON. count=' + $hangResultFiles.Count + ' output=' + ($hangOutput -join "`n"))
    }
    try { $hangSummary = Get-Content -LiteralPath $hangResultFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
        throw ('hung test result JSON could not be parsed: ' + $_.Exception.Message)
    }
    $hangRecords = @($hangSummary.results | Where-Object { [string]$_.path -eq $relativeHang })
    if ($hangRecords.Count -ne 1 -or [string]$hangRecords[0].status -ne 'TIMEOUT') {
        $observed = if ($hangRecords.Count) { [string]$hangRecords[0].status } else { '<missing>' }
        throw ('hung test did not receive an explicit TIMEOUT result. observed=' + $observed + ' output=' + ($hangOutput -join "`n"))
    }
    if (($hangOutput -join "`n") -notmatch 'Test-Hang\.ps1[\s\S]*=> TIMEOUT') {
        throw ('hung test output did not report TIMEOUT. output=' + ($hangOutput -join "`n"))
    }
    $hangPidValues = @{}
    foreach ($pidPath in @($hangPidPath, $hangChildPidPath)) {
        if (-not (Test-Path -LiteralPath $pidPath)) {
            throw ('hung test did not write required PID marker: ' + $pidPath)
        }
        $pidValue = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw), [ref]$pidValue) -or $pidValue -le 0) {
            throw ('hung test wrote an invalid PID marker: ' + $pidPath)
        }
        $hangPidValues[$pidPath] = $pidValue
    }
    Start-Sleep -Milliseconds 250
    $leakedPids = @()
    foreach ($pidValue in $hangPidValues.Values) {
        try {
            $live = Get-Process -Id $pidValue -ErrorAction Stop
            if ($live) { $leakedPids += $pidValue }
        } catch {
        }
    }
    if ($leakedPids.Count -or (Test-Path -LiteralPath $hangCompletedPath)) {
        throw ('hung test left a process or completion marker. leaked=' + ($leakedPids -join ',') + ' output=' + ($hangOutput -join "`n"))
    }

    'Test-TestRunner: PASS'
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
