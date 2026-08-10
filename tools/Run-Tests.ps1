param(
    [ValidateSet('fast','headless-integration','live-M365','all')]
    [string]$Suite = 'fast',
    [string]$ResultsDirectory = '',
    [switch]$DisallowSkips,
    [string]$ManifestFile = '',
    [string[]]$DiscoveryDirectories = @(),
    [switch]$ValidateManifestOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = if ([string]::IsNullOrWhiteSpace($ManifestFile)) { Join-Path $PSScriptRoot 'test-manifest.json' } elseif ([IO.Path]::IsPathRooted($ManifestFile)) { $ManifestFile } else { Join-Path $repoRoot $ManifestFile }
if ([string]::IsNullOrWhiteSpace($ResultsDirectory)) {
    $ResultsDirectory = Join-Path $repoRoot 'output\test-results'
}
New-Item -ItemType Directory -Path $ResultsDirectory -Force | Out-Null

function Normalize-TestPath([string]$Path) { return ($Path -replace '\\','/').TrimStart('./') }
function Limit-TestOutput([string]$Text, [int]$MaxCharacters = 16000) {
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -le $MaxCharacters) { return $Text }
    return "... output truncated ...`n" + $Text.Substring($Text.Length - $MaxCharacters)
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$entries = @($manifest.tests)
$manifestPaths = @{}
foreach ($entry in $entries) {
    $normalized = Normalize-TestPath ([string]$entry.path)
    if ($manifestPaths.ContainsKey($normalized)) { throw "Duplicate test manifest entry: $normalized" }
    $manifestPaths[$normalized] = $true
}

$discoveryRoots = if ($DiscoveryDirectories.Count) { @($DiscoveryDirectories) } else { @('app\_app\tools','tools') }
$discoveredFiles = @()
foreach ($rootEntry in $discoveryRoots) {
    $rootPath = if ([IO.Path]::IsPathRooted($rootEntry)) { $rootEntry } else { Join-Path $repoRoot $rootEntry }
    if (Test-Path -LiteralPath $rootPath -PathType Container) {
        $discoveredFiles += @(Get-ChildItem -LiteralPath $rootPath -File -Recurse | Where-Object { $_.Name -like 'Test-*.mjs' -or $_.Name -like 'Test-*.ps1' })
    }
}
$discovered = @($discoveredFiles | ForEach-Object { Normalize-TestPath ($_.FullName.Substring($repoRoot.Length + 1)) } | Sort-Object -Unique)
$unclassified = @($discovered | Where-Object { -not $manifestPaths.ContainsKey($_) })
$missing = @($entries | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot ([string]$_.path)) -PathType Leaf) } | ForEach-Object { [string]$_.path })
if ($unclassified.Count -or $missing.Count) {
    if ($unclassified.Count) { [Console]::Error.WriteLine("Unclassified tests:`n  " + ($unclassified -join "`n  ")) }
    if ($missing.Count) { [Console]::Error.WriteLine("Manifest paths not found:`n  " + ($missing -join "`n  ")) }
    exit 2
}
if ($ValidateManifestOnly) { Write-Host ("Manifest validation: PASS ({0} tests)" -f $discovered.Count); exit 0 }

$selected = if ($Suite -eq 'all') { $entries } else { @($entries | Where-Object { [string]$_.suite -eq $Suite }) }
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-test-run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$results = @()
try {
    $ordinal = 0
    foreach ($entry in $selected) {
        $ordinal++
        $relative = Normalize-TestPath ([string]$entry.path)
        $fullPath = Join-Path $repoRoot ([string]$entry.path)
        $timeoutSeconds = if ($entry.timeout_seconds) { [int]$entry.timeout_seconds } else { 60 }
        $stdoutPath = Join-Path $runRoot ("$ordinal.stdout.txt")
        $stderrPath = Join-Path $runRoot ("$ordinal.stderr.txt")
        $extension = [IO.Path]::GetExtension($fullPath).ToLowerInvariant()
        if ($extension -eq '.mjs') {
            $program = 'node.exe'
            $arguments = @($fullPath)
        } else {
            $program = 'powershell.exe'
            $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$fullPath)
        }
        Write-Host ("[{0}/{1}] {2}" -f $ordinal, $selected.Count, $relative)
        $startedAt = Get-Date
        $jobSpec = [pscustomobject]@{
            program = $program
            arguments = [string[]]$arguments
            working_directory = $repoRoot
            stdout_path = $stdoutPath
            stderr_path = $stderrPath
            host_pid_path = (Join-Path $runRoot ("$ordinal.host.pid"))
        }
        $job = Start-Job -ScriptBlock {
            param($Spec)
            [IO.File]::WriteAllText([string]$Spec.host_pid_path, [string]$PID)
            Set-Location -LiteralPath $Spec.working_directory
            $nativeArgs = @($Spec.arguments | ForEach-Object { [string]$_ })
            & ([string]$Spec.program) @nativeArgs 1> ([string]$Spec.stdout_path) 2> ([string]$Spec.stderr_path)
            return [int]$LASTEXITCODE
        } -ArgumentList (,$jobSpec)
        $completedJob = Wait-Job -Job $job -Timeout $timeoutSeconds
        $timedOut = ($null -eq $completedJob)
        if ($timedOut) {
            if (Test-Path -LiteralPath $jobSpec.host_pid_path) {
                $hostPid = 0
                if ([int]::TryParse((Get-Content -LiteralPath $jobSpec.host_pid_path -Raw), [ref]$hostPid) -and $hostPid -gt 0) {
                    & taskkill.exe /PID $hostPid /T /F 2>$null | Out-Null
                }
            }
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            $exitCode = -1
        } else {
            $exitValues = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
            $exitCode = if ($exitValues.Count) { [int]$exitValues[-1] } else { 1 }
        }
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        $stdout = if (Test-Path $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue } else { '' }
        $stderr = if (Test-Path $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue } else { '' }
        $skipped = ($stdout + "`n" + $stderr) -match '(?m)^\s*SKIP:'
        $allowSkip = [bool]$entry.allow_skip -and -not $DisallowSkips
        $passed = (-not $timedOut) -and ($exitCode -eq 0) -and (-not $skipped -or $allowSkip)
        $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
        $status = if ($timedOut) { 'TIMEOUT' } elseif ($skipped -and -not $allowSkip) { 'UNEXPECTED_SKIP' } elseif ($exitCode -ne 0) { 'FAIL' } elseif ($skipped) { 'EXPECTED_SKIP' } else { 'PASS' }
        if (-not $passed -and -not [string]::IsNullOrWhiteSpace($stdout)) { Write-Host (Limit-TestOutput $stdout).TrimEnd() }
        if (-not $passed -and -not [string]::IsNullOrWhiteSpace($stderr)) { Write-Host (Limit-TestOutput $stderr).TrimEnd() -ForegroundColor DarkYellow }
        Write-Host ("  => {0} ({1} ms)" -f $status, $durationMs)
        $results += [pscustomobject]@{
            path=$relative; suite=[string]$entry.suite; status=$status; passed=$passed
            exit_code=$exitCode; duration_ms=$durationMs; stdout=(Limit-TestOutput $stdout); stderr=(Limit-TestOutput $stderr)
        }
    }
} finally {
    if (Test-Path $runRoot) { Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$jsonPath = Join-Path $ResultsDirectory ("tests-$Suite-$stamp.json")
$junitPath = Join-Path $ResultsDirectory ("tests-$Suite-$stamp.xml")
$summary = [ordered]@{
    suite=$Suite; generated_at=(Get-Date).ToString('o'); total=$results.Count
    passed=@($results | Where-Object passed).Count; failed=@($results | Where-Object { -not $_.passed }).Count
    results=$results
}
[IO.File]::WriteAllText($jsonPath, ($summary | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
$xml = New-Object Text.StringBuilder
$null = $xml.AppendLine(('<?xml version="1.0" encoding="utf-8"?>'))
$null = $xml.AppendLine(('<testsuite name="{0}" tests="{1}" failures="{2}">' -f [Security.SecurityElement]::Escape($Suite), $results.Count, $summary.failed))
foreach ($result in $results) {
    $name = [Security.SecurityElement]::Escape([string]$result.path)
    $seconds = [Math]::Round(([int]$result.duration_ms / 1000), 3)
    $null = $xml.AppendLine(('  <testcase name="{0}" classname="{1}" time="{2}">' -f $name, [Security.SecurityElement]::Escape([string]$result.suite), $seconds))
    if (-not $result.passed) {
        $detail = [Security.SecurityElement]::Escape(("status={0}`n{1}`n{2}" -f $result.status, $result.stdout, $result.stderr))
        $null = $xml.AppendLine(('    <failure message="{0}">{1}</failure>' -f $result.status, $detail))
    }
    $null = $xml.AppendLine('  </testcase>')
}
$null = $xml.AppendLine('</testsuite>')
[IO.File]::WriteAllText($junitPath, $xml.ToString(), (New-Object Text.UTF8Encoding($false)))

Write-Host ("Tests: total={0} passed={1} failed={2}" -f $summary.total, $summary.passed, $summary.failed)
Write-Host "JSON: $jsonPath"
Write-Host "JUnit: $junitPath"
if ($summary.failed -gt 0) { exit 1 }
