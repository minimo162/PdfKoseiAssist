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
            '/PDF校正アシスト起動.cmd',
            '/PDF校正アシスト_初回セットアップ.cmd',
            '/_app/Launch-KoseiAssist.ps1',
            '/_app/release-manifest.json',
            '/_app/Start-DropReview.ps1',
            '/_app/Setup-KoseiAssist.ps1',
            '/_app/VERSION',
            '/_app/src/DesktopUi.ps1',
            '/_app/src/SendToShortcut.ps1',
            '/_app/config/runtime-html-policy.json',
            '/_app/js/finding-quality.mjs',
            '/_app/js/heading-index.mjs',
            '/_app/src/RuntimeHtmlPolicy.ps1',
            '/_app/src/ReviewJob.ps1'
        )) {
            if (-not @($names | Where-Object { $_.EndsWith($need, [System.StringComparison]::Ordinal) }).Count) {
                throw "required entry missing: $need"
            }
        }
        if (@($names | Where-Object { $_ -match '/docs/benchmarks/' -or $_ -match '/tools/' -or $_ -match '\.(pdf|vbs)$' }).Count) {
            throw 'sensitive or development entry was packaged'
        }
        foreach ($entry in $zip.Entries) {
            $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8, $true)
            try { if ($reader.ReadToEnd().Contains($marker)) { throw "secret marker leaked: $($entry.FullName)" } }
            finally { $reader.Dispose() }
        }
        # release-manifest.json は _app の配布ファイルをすべて、正しいハッシュで載せている（共有フォルダ配布の照合に使う）。
        . (Join-Path $repo 'app\_app\Launch-KoseiAssist.ps1')
        $manifestEntry = @($zip.Entries | Where-Object { $_.FullName.EndsWith('/_app/release-manifest.json', [System.StringComparison]::Ordinal) })[0]
        $reader = New-Object System.IO.StreamReader($manifestEntry.Open(), [System.Text.Encoding]::UTF8, $true)
        try { $manifest = ConvertFrom-KoseiReleaseManifest $reader.ReadToEnd() } finally { $reader.Dispose() }
        $appPrefix = $manifestEntry.FullName.Substring(0, $manifestEntry.FullName.Length - 'release-manifest.json'.Length)
        $appEntries = @($zip.Entries | Where-Object { $_.FullName.StartsWith($appPrefix, [System.StringComparison]::Ordinal) -and $_.FullName -ne $manifestEntry.FullName })
        if (@($manifest.files).Count -ne $appEntries.Count) { throw "manifest file count mismatch: $(@($manifest.files).Count) / $($appEntries.Count)" }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            foreach ($file in @($manifest.files)) {
                $entry = $zip.GetEntry($appPrefix + [string]$file.path)
                if (-not $entry) { throw "manifest lists a missing file: $($file.path)" }
                $stream = $entry.Open()
                try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose() }
                if ($hash -ne [string]$file.sha256) { throw "manifest hash mismatch: $($file.path)" }
            }
        } finally { $sha.Dispose() }
        if ([string]$manifest.version -ne [IO.File]::ReadAllText((Join-Path $repo 'app\_app\VERSION')).Trim()) { throw 'manifest version mismatch' }
    } finally { $zip.Dispose() }

    # -DeployTo: 共有フォルダーへ直接配置する。管理者の config\settings.json はそのまま残す。
    $share = Join-Path $out 'share 共有'
    New-Item -ItemType Directory -Path (Join-Path $share '_app\config') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $share '_app\config\settings.json'), '{"admin":true}')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $package -Version deploy -SkipVerify -OutputDirectory $out -DeployTo $share
    if ($LASTEXITCODE -ne 0) { throw "Package-Release.ps1 -DeployTo failed: $LASTEXITCODE" }
    if ([IO.File]::ReadAllText((Join-Path $share '_app\config\settings.json')) -ne '{"admin":true}') { throw 'DeployTo overwrote the admin settings' }
    foreach ($need in @('PDF校正アシスト_初回セットアップ.cmd', '_app\Launch-KoseiAssist.ps1', '_app\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $share $need) -PathType Leaf)) { throw "DeployTo missing: $need" }
    }
    $null = Read-KoseiReleaseManifest -Source (Join-Path $share '_app')
    $vbsProbe=Join-Path $repo 'app/_app/pdfjs/release-rejection-probe.vbs'
    if(Test-Path -LiteralPath $vbsProbe){throw 'VBS probe path already exists'}
    try {
        [IO.File]::WriteAllText($vbsProbe,'test fixture')
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $package -Version reject-vbs -SkipVerify -OutputDirectory $out
        if($LASTEXITCODE -eq 0){throw 'VBS contamination was not rejected'}
    }finally{[IO.File]::Delete($vbsProbe)}
    Write-Host 'Test-PackageRelease: PASS' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
    if (Test-Path -LiteralPath $out) {
        $resolvedOut=[IO.Path]::GetFullPath($out)
        if($resolvedOut.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedOut) -match '^kosei-package-test-[0-9a-f]{32}$'){Remove-Item -LiteralPath $resolvedOut -Recurse -Force}
    }
}
