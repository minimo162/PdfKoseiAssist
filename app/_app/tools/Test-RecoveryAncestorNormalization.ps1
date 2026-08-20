$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
function Write-KoseiLog { param($Message, $Level) }
. (Join-Path $root "src\ReviewJob.ps1")

$id = "0123456789abcdef0123456789abcdef"
$cases = @(
    @{ value = $null; expected = 0 },
    @{ value = @(); expected = 0 },
    @{ value = @($null, "", "  "); expected = 0 },
    @{ value = @(@($id)); expected = 1 },
    @{ value = @($id, $id); expected = 1 }
)
foreach ($case in $cases) {
    $request = Get-KoseiRecoveryChainRequest -AncestorJobIds $case.value
    if (@($request.ancestor_job_ids).Count -ne $case.expected) {
        throw "ancestor normalization count mismatch: expected=$($case.expected) actual=$(@($request.ancestor_job_ids).Count)"
    }
}

$jsonCases = @(
    @{ json = '{"recovery_ancestor_job_ids":null}'; expected = 0 },
    @{ json = '{"recovery_ancestor_job_ids":[]}'; expected = 0 },
    @{ json = '{"recovery_ancestor_job_ids":[""]}'; expected = 0 },
    @{ json = '{"recovery_ancestor_job_ids":[["0123456789abcdef0123456789abcdef"]]}'; expected = 1 }
)
foreach ($case in $jsonCases) {
    $body = $case.json | ConvertFrom-Json
    $request = Get-KoseiRecoveryChainRequest -AncestorJobIds $body.recovery_ancestor_job_ids
    if (@($request.ancestor_job_ids).Count -ne $case.expected) {
        throw "ConvertFrom-Json boundary mismatch: json=$($case.json) expected=$($case.expected) actual=$(@($request.ancestor_job_ids).Count)"
    }
}

$invalid = $false
try { Get-KoseiRecoveryChainRequest -AncestorJobIds @("not-a-job-id") | Out-Null } catch { $invalid = $true }
if (-not $invalid) { throw "invalid ancestor ID was accepted" }

"Test-RecoveryAncestorNormalization: PASS"
