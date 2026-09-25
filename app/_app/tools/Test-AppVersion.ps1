$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $root)
. (Join-Path $root 'src/Paths.ps1')
. (Join-Path $root 'src/Server.ps1')
Set-KoseiRoot $root
$expected = [IO.File]::ReadAllText((Join-Path $root 'VERSION')).Trim()
if ((Get-KoseiAppVersion) -ne $expected) { throw 'Read version failed' }
function Send-KoseiJson { param($Response, $StatusCode, $Object) $script:reply = $Object }
Invoke-KoseiRoute -Context ([pscustomobject]@{Request=[pscustomobject]@{HttpMethod='GET';Url=[uri]'http://127.0.0.1/__health'};Response=$null})
if (!$script:reply.ok -or $script:reply.version -ne $expected) { throw 'Health version failed' }
& (Join-Path $repo 'tools/Assert-AppVersion.ps1') -RepoRoot $repo
$temp = Join-Path ([IO.Path]::GetTempPath()) ('kosei-version-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temp
function Write-KoseiLog { param($Message, $Level) $script:warning = $Level }
if ((Get-KoseiAppVersion -Root $temp) -ne '0.0' -or $script:warning -ne 'WARN') { throw 'Missing version fallback failed' }
[IO.File]::WriteAllText((Join-Path $temp 'VERSION'), 'v95.5')
if ((Get-KoseiAppVersion -Root $temp) -ne '0.0') { throw 'Invalid version fallback failed' }
[IO.File]::WriteAllText((Join-Path $temp 'VERSION'), "95.10.2`r`n")
if ((Get-KoseiAppVersion -Root $temp) -ne '95.10.2') { throw 'Patch version failed' }
[IO.File]::Delete((Join-Path $temp 'VERSION'))
[IO.Directory]::Delete($temp)
Write-Host 'PASS AppVersion'
