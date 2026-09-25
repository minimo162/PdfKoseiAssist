function Resolve-KoseiDropInputs {
    param([string[]]$Paths)
    $result = New-Object 'System.Collections.Generic.List[string]'
    foreach ($path in $Paths) {
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        $full = [IO.Path]::GetFullPath($path)
        if (![IO.File]::Exists($full) -or [IO.Path]::GetExtension($full) -ine '.pdf') { throw ('「' + [IO.Path]::GetFileName($path) + '」はPDFではないか、見つかりません。右クリックの「送る」から実行してください。') }
        if (-not ($result -contains $full)) { $result.Add($full) }
    }
    if ($result.Count -eq 0) { throw 'PDFを選んで、右クリックの「送る」→「PDF校正アシストで校正」から実行してください。' }
    if ($result.Count -gt 2) { throw '1回に選べるのは2ファイル（英文と日本語原稿）までです。' }
    if ($result.Count -eq 2 -and [IO.Path]::GetDirectoryName($result[0]) -ine [IO.Path]::GetDirectoryName($result[1])) { throw '英文PDFと日本語原稿PDFを同じフォルダに置いてから、もう一度実行してください。' }
    return $result.ToArray()
}

function Get-KoseiDropAssignment {
    param([string[]]$Names, [string[]]$Languages)
    if ($Names.Count -eq 1) { return @{target=0;reference=-1;needs_prompt=$false} }
    if ($Names.Count -ne 2) { throw 'Expected one or two inputs' }
    $target = -1
    if ($Languages.Count -eq 2) {
        if ($Languages[0] -eq '英語' -and $Languages[1] -eq '日本語') { $target=0 }
        if ($Languages[1] -eq '英語' -and $Languages[0] -eq '日本語') { $target=1 }
    }
    if ($target -lt 0) {
        $en = @($Names | ForEach-Object { $_ -match '(?i)_en|-en|英文|English' })
        $ja = @($Names | ForEach-Object { $_ -match '(?i)_ja|_jp|-ja|日本語|和文' })
        $votes = @()
        if ($en[0] -and !$en[1]) { $votes += 0 }; if ($en[1] -and !$en[0]) { $votes += 1 }
        if ($ja[0] -and !$ja[1]) { $votes += 1 }; if ($ja[1] -and !$ja[0]) { $votes += 0 }
        $unique = @($votes | Select-Object -Unique)
        if ($unique.Count -eq 1) { $target = $unique[0] }
    }
    return @{target=$target;reference=(1-$target);needs_prompt=($target -lt 0)}
}

function Expand-KoseiDropReport {
    param([string]$ZipPath, [string]$TargetPath, [switch]$Incomplete,
        [string]$FallbackRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PDF校正アシスト結果'))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $name = [IO.Path]::GetFileNameWithoutExtension($TargetPath) + '_校正結果'
    if ($Incomplete) { $name += '_一部未完了' }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($TargetPath))
    $fallback = $false; $partial = $null
    foreach ($candidate in @($parent, $FallbackRoot)) {
        try {
            $candidate = [IO.Path]::GetFullPath($candidate)
            $null = [IO.Directory]::CreateDirectory($candidate)
            $partial = Join-Path $candidate ('.' + [guid]::NewGuid().ToString('N') + '.partial')
            $null = [IO.Directory]::CreateDirectory($partial)
            # Check actual write access before choosing this destination.
            $probe = Join-Path $partial '.write-probe'
            [IO.File]::WriteAllBytes($probe, [byte[]]@()); [IO.File]::Delete($probe)
            $parent = $candidate; break
        } catch {
            if ($partial -and [IO.Directory]::Exists($partial)) { [IO.Directory]::Delete($partial) }
            $partial = $null; $fallback = $true
        }
    }
    if (-not $partial) { throw '結果を保存できません。元のフォルダとドキュメントの書き込み権限を確認してください。' }
    $archive = $null
    try {
        $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName.Replace('\','/')
            if ($entryName.StartsWith('/') -or $entryName.Contains(':') -or @($entryName.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) { throw 'レポートZIP内に不正なパスがあります。' }
            $dest = [IO.Path]::GetFullPath((Join-Path $partial $entryName))
            if (-not $dest.StartsWith($partial + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'レポートZIP内に不正なパスがあります。' }
            if ($entryName.EndsWith('/')) { $null=[IO.Directory]::CreateDirectory($dest); continue }
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
            $source = $entry.Open(); $output = $null
            try { $output=[IO.File]::Open($dest,[IO.FileMode]::CreateNew); $source.CopyTo($output) }
            finally { $source.Dispose(); if ($output) { $output.Dispose() } }
        }
        $archive.Dispose(); $archive = $null
        for ($number=1; ; $number++) {
            $leaf = if ($number -eq 1) { $name } else { $name + ' (' + $number + ')' }
            $destination = Join-Path $parent $leaf
            if (Test-Path -LiteralPath $destination) { continue }
            try { [IO.Directory]::Move($partial,$destination); $partial=$null; break }
            catch { if (Test-Path -LiteralPath $destination) { continue }; throw }
        }
        return @{path=$destination;fallback=$fallback}
    } finally {
        if ($archive) { $archive.Dispose() }
        if ($partial -and [IO.Directory]::Exists($partial)) {
            $resolved = [IO.Path]::GetFullPath($partial)
            if ($resolved.StartsWith($parent + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^\.[0-9a-f]{32}\.partial$') {
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
    }
}
