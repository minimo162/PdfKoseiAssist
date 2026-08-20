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
function ConvertTo-TestProcessArgumentString([string[]]$Arguments) {
    $parts = @($Arguments | ForEach-Object {
        $value = [string]$_
        # ProcessStartInfo receives one Windows command line.  Quote every
        # token so checkout paths containing spaces remain a single argument.
        '"' + $value.Replace('"', '\"') + '"'
    })
    return [string]::Join(' ', $parts)
}

$windowsNative = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
if ($windowsNative -and -not ('KoseiTestJobNative' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class KoseiTestJobNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct BasicLimitInformation {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, ref ExtendedLimitInformation info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    private const uint KillOnJobClose = 0x2000;
    private const uint ExtendedLimitInformationClass = 9;

    public static IntPtr CreateKillOnCloseJob() {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = KillOnJobClose;
        if (!SetInformationJobObject(job, ExtendedLimitInformationClass, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }
    public static bool Assign(IntPtr job, Process process) {
        return job != IntPtr.Zero && process != null && AssignProcessToJobObject(job, process.Handle);
    }
    public static void TerminateAndClose(IntPtr job) {
        if (job == IntPtr.Zero) return;
        TerminateJobObject(job, 1);
        CloseHandle(job);
    }
    public static void Close(IntPtr job) {
        if (job != IntPtr.Zero) CloseHandle(job);
    }
}
"@
}

function Stop-TestProcessTree([Diagnostics.Process]$Process, [IntPtr]$JobHandle, [int]$WaitMilliseconds = 5000) {
    if ($null -eq $Process) {
        if ($JobHandle -ne [IntPtr]::Zero -and $windowsNative) { [KoseiTestJobNative]::TerminateAndClose($JobHandle) }
        return
    }
    if ($JobHandle -ne [IntPtr]::Zero -and $windowsNative) {
        [KoseiTestJobNative]::TerminateAndClose($JobHandle)
    } else {
        # Fallback for hosts that reject nested Job Objects.  taskkill is
        # bounded, then the directly-owned process is killed as a last resort.
        $killer = $null
        try {
            $killer = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', [string]$Process.Id, '/T', '/F') -WindowStyle Hidden -PassThru
            if (-not $killer.WaitForExit($WaitMilliseconds)) {
                try { $killer.Kill() } catch { }
                try { $killer.WaitForExit(1000) } catch { }
            }
        } catch { }
        finally {
            if ($null -ne $killer) { try { $killer.Dispose() } catch { } }
        }
        try { if (-not $Process.HasExited) { $Process.Kill() } } catch { }
    }
    try { $Process.WaitForExit($WaitMilliseconds) } catch { }
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
        }
        $process = New-Object Diagnostics.Process
        $processStartInfo = New-Object Diagnostics.ProcessStartInfo
        $processStartInfo.FileName = [string]$jobSpec.program
        $processStartInfo.Arguments = ConvertTo-TestProcessArgumentString ([string[]]$jobSpec.arguments)
        $processStartInfo.WorkingDirectory = [string]$jobSpec.working_directory
        $processStartInfo.UseShellExecute = $false
        $processStartInfo.CreateNoWindow = $true
        $processStartInfo.RedirectStandardOutput = $true
        $processStartInfo.RedirectStandardError = $true
        $process.StartInfo = $processStartInfo
        if (-not $process.Start()) { throw ("Unable to start test process: {0}" -f $jobSpec.program) }
        $jobHandle = [IntPtr]::Zero
        if ($windowsNative -and ('KoseiTestJobNative' -as [type])) {
            $jobHandle = [KoseiTestJobNative]::CreateKillOnCloseJob()
            if ($jobHandle -ne [IntPtr]::Zero -and -not [KoseiTestJobNative]::Assign($jobHandle, $process)) {
                [KoseiTestJobNative]::Close($jobHandle)
                $jobHandle = [IntPtr]::Zero
            }
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timeoutMilliseconds = [Math]::Min([int]::MaxValue, [Math]::Max(1, ([int64]$timeoutSeconds * 1000)))
        $timedOut = -not $process.WaitForExit($timeoutMilliseconds)
        if ($timedOut) {
            Stop-TestProcessTree $process $jobHandle
            $exitCode = -1
        } else {
            if ($jobHandle -ne [IntPtr]::Zero -and $windowsNative) { [KoseiTestJobNative]::Close($jobHandle) }
            $process.WaitForExit()
            $exitCode = [int]$process.ExitCode
        }
        $stdout = if ($stdoutTask.Wait(2000)) { [string]$stdoutTask.Result } else { '' }
        $stderr = if ($stderrTask.Wait(2000)) { [string]$stderrTask.Result } else { '' }
        try { $process.Dispose() } catch { }
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
