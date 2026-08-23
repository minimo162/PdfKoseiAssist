$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\ReviewJob.ps1')
function Assert-State([string]$Expected, $State) {
    $actual = Get-KoseiProcessingCompletionState -State $State
    if ($actual -ne $Expected) { throw "expected $Expected, got $actual" }
}
Assert-State 'processing' ([pscustomobject]@{ mode = 'running'; per_packet = @([pscustomobject]@{ status = 'running' }) })
Assert-State 'processing_done' ([pscustomobject]@{ mode = 'done'; per_packet = @([pscustomobject]@{ status = 'done'; verification_state = 'page_complete'; coverage = 1 }) })
Assert-State 'processing_done_with_review' ([pscustomobject]@{ mode = 'done'; per_packet = @([pscustomobject]@{ status = 'warning'; verification_state = 'incomplete'; coverage = 0.95 }) })
Assert-State 'error' ([pscustomobject]@{ mode = 'error'; per_packet = @([pscustomobject]@{ status = 'error' }) })
Write-Host 'Test-ProcessingCompletionState: PASS'
