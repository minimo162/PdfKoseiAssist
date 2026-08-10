#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$package = Join-Path $repo 'tools\Package-Release.ps1'
$out = Join-Path ([System.IO.Path]::GetTempPath()) ('kosei-package-test-' + [guid]::NewGuid().ToString('N'))
$marker = 'KOSEI_SECRET_MUST_NOT_SHIP_' + [guid]::NewGuid().ToString('N')
$probeDir = Join-Path $repo 'app\_app\docs\benchmarks\.tmp'
$probe = Join-Path $probeDir 'package-secret-probe.pdf'

try {
    New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    [System.IO.File]::WriteAllText($probe, $marker, [System.Text.Encoding]::UTF8)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $package -Version test -SkipVerify -OutputDirectory $out
    if ($LASTEXITCODE -ne 0) { throw "Package-Release.ps1 failed: $LASTEXITCODE" }
    $zipPath = @(Get-ChildItem -LiteralPath $out -Filter '*.zip' -File)
    if ($zipPath.Count -ne 1) { throw "ZIP count must be 1, actual=$($zipPath.Count)" }

    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath[0].FullName)
    try {
        $names = @($zip.Entries | ForEach-Object { $_.FullName })
        foreach ($need in @(
            '/_app/index.html',
            '/_app/js/finding-quality.mjs',
            '/_app/js/heading-index.mjs',
            '/_app/src/ReviewJob.ps1'
        )) {
            if (-not @($names | Where-Object { $_.EndsWith($need, [System.StringComparison]::Ordinal) }).Count) {
                throw "required entry missing: $need"
            }
        }
        if (@($names | Where-Object { $_ -match '/docs/benchmarks/' -or $_ -match '/tools/' -or $_ -match '\.pdf$' }).Count) {
            throw 'sensitive or development entry was packaged'
        }
        foreach ($entry in $zip.Entries) {
            $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8, $true)
            try { if ($reader.ReadToEnd().Contains($marker)) { throw "secret marker leaked: $($entry.FullName)" } }
            finally { $reader.Dispose() }
        }
    } finally { $zip.Dispose() }
    Write-Host 'Test-PackageRelease: PASS' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
}
