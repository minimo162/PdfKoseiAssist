$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\ReviewJob.ps1')

function Assert-SplitRecovery([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$expected = @(11..15)
$full = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
}
$partial = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[11,12,13,14]}'
    pagesChecked = @(11..14)
}
$flagged = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[],"checked_pages_all":true}'
    pagesChecked = $expected
}
$readError = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages_all":true,"read_error":"unreadable"}'
    pagesChecked = @()
}
$notOk = [pscustomobject]@{
    ok = $false
    json = '{"findings":[],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
}

Assert-SplitRecovery (Test-KoseiPacketCoverageComplete -Result $full -ExpectedPages $expected) '全ページ回答を不完全扱いしました'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $partial -ExpectedPages $expected)) '部分coverageを完全扱いしました'
Assert-SplitRecovery (Test-KoseiPacketCoverageComplete -Result $flagged -ExpectedPages $expected) 'checked_pages_allを完全扱いしませんでした'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $readError -ExpectedPages $expected)) 'read_error回答を完全扱いしました'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $notOk -ExpectedPages $expected)) 'ok=false回答を完全扱いしました'

Write-Host 'Test-SplitRecovery: PASS' -ForegroundColor Green
