param([Parameter(Mandatory=$true)][string]$RepoRoot)
$ErrorActionPreference = 'Stop'
$version = [IO.File]::ReadAllText((Join-Path $RepoRoot 'app/_app/VERSION')).Trim()
if ($version -notmatch '^\d+\.\d+(?:\.\d+)?$') { throw 'Invalid VERSION' }
foreach ($entry in @(@('README.md', '現行バージョン:'), @('app/はじめにお読みください.txt', 'バージョン:'))) {
    $content = [IO.File]::ReadAllText((Join-Path $RepoRoot $entry[0]))
    $pattern = [regex]::Escape($entry[1]) + '\s*v' + [regex]::Escape($version) + '(?=\s|$)'
    if ($content -notmatch $pattern) { throw ('VERSION mismatch: ' + $entry[0]) }
}
