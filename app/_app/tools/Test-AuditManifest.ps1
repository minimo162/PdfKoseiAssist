$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\ReviewJob.ps1')

$base = Join-Path ([IO.Path]::GetTempPath()) ('kosei-audit-test-' + [guid]::NewGuid().ToString('N'))
$answers = Join-Path $base 'answers'
$audit = Join-Path $base 'audit'
New-Item -ItemType Directory -Path $answers,$audit -Force | Out-Null
try {
    $jobId = [guid]::NewGuid().ToString('N')
    $packetId = 'P-046'
    $safePacket = $packetId -replace '[^A-Za-z0-9_.-]', '_'
    foreach ($suffix in @('.json','.raw.txt','.diagnostics.json','.pass1.json')) {
        Set-Content -LiteralPath (Join-Path $answers ($jobId + '_' + $safePacket + $suffix)) -Value ('audit-' + $suffix) -Encoding UTF8
    }
    $state = [hashtable]@{
        id=$jobId; created_at=(Get-Date).ToString('o'); target_file_name='target.pdf'; target_page_count=10
        target_pdf_sha256=('a' * 64); audit_manifest_path=''; audit_manifest_sha256=''; audit_retained=$false
    }
    $packet = [hashtable]@{
        packet_id=$packetId; target_pages=@(7,8,9,10); prompt_sha256=('b' * 64); text_sha256=('c' * 64); pdf_sha256=('d' * 64)
        verification_state='needs_review'; coverage=0.75; pages_checked=@(7,8,9); completed_by='marker'; warning='JSONを自動修復しました'
    }
    $manifestPath = Write-KoseiAuditManifest -State $state -Packet $packet -Settings ([pscustomobject]@{review_prompt_version='v96'}) -AnswersDir $answers -AuditRoot $audit
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'audit manifest was not written' }
    if (-not $state.audit_retained -or $state.audit_manifest_sha256 -notmatch '^[0-9a-f]{64}$') { throw 'audit state metadata was not populated' }
    $manifest = Get-KoseiAuditManifest -JobId $jobId -AuditRoot $audit
    if ($manifest.schema_version -ne 'kosei-audit-v2' -or @($manifest.packets).Count -ne 1) { throw 'audit manifest schema/packet is invalid' }
    if ($manifest.packets[0].verification_state -ne 'needs_review' -or @($manifest.packets[0].files).Count -lt 4) { throw 'audit packet evidence is incomplete' }
    $auditPacket = $manifest.packets[0]
    if ([string]::IsNullOrWhiteSpace([string]$auditPacket.attempt_id)) { throw 'attempt_id is missing' }
    if ([int]$auditPacket.stage.total -lt 1) { throw 'stage metadata is missing' }
    if ([string]$auditPacket.input.target_pdf_sha256 -ne ('d' * 64)) { throw 'target input hash is missing' }
    if ([string]$auditPacket.input.prompt_version -ne 'v96') { throw 'input prompt version is missing' }
    if ([double]$auditPacket.coverage_detail.page_coverage -ne 0.75 -or [string]$auditPacket.coverage_detail.semantic_coverage -ne 'unknown') { throw 'coverage contract is incomplete' }
    if (-not ($auditPacket.response.PSObject.Properties.Name -contains 'raw_sha256')) { throw 'raw hash is missing' }
    if (-not ($auditPacket.response.PSObject.Properties.Name -contains 'marker_seen')) { throw 'marker state is missing' }
    # A worker appends packets by replacing the shared manifest. Keep this
    # second write in the regression test so a Windows File.Replace overload
    # or lost-update bug cannot hide behind a one-packet smoke test.
    $packet2 = [hashtable]$packet.Clone()
    $packet2.packet_id = 'P-047'
    $packet2.target_pages = @(1,2)
    $packet2.pages_checked = @(1,2)
    $packet2.coverage = 1.0
    $packet2.verification_state = 'done'
    $safePacket2 = 'P-047'
    foreach ($suffix in @('.json','.raw.txt','.diagnostics.json','.pass1.json')) {
        Set-Content -LiteralPath (Join-Path $answers ($jobId + '_' + $safePacket2 + $suffix)) -Value ('audit-' + $suffix) -Encoding UTF8
    }
    $null = Write-KoseiAuditManifest -State $state -Packet $packet2 -Settings ([pscustomobject]@{review_prompt_version='v96'}) -AnswersDir $answers -AuditRoot $audit
    $manifest = Get-KoseiAuditManifest -JobId $jobId -AuditRoot $audit
    if (@($manifest.packets).Count -ne 2 -or @($manifest.packets | Where-Object { $_.packet_id -eq 'P-047' }).Count -ne 1) { throw 'multi-packet audit manifest merge is invalid' }
    if (-not (Update-KoseiAuditAck -State $state -Status imported -AuditRoot $audit)) { throw 'audit ACK update failed' }
    $manifest = Get-KoseiAuditManifest -JobId $jobId -AuditRoot $audit
    if ($manifest.ack.status -ne 'imported' -or [string]::IsNullOrWhiteSpace([string]$manifest.ack.imported_at)) { throw 'audit ACK status was not retained' }

    # ACK failure must not discard the raw response. Once the durable
    # checkpoint is ready, ACK removes only the recovery lease and leaves the
    # audit manifest available after a fresh process load.
    $checkpoint = Join-Path $answers ($jobId + '_' + $safePacket + '.checkpoint.json')
    Set-Content -LiteralPath $checkpoint -Value '{"raw_answer":"checkpoint","passes":[]}' -Encoding UTF8
    $state.result_retained = $true
    $state.recovery_acknowledged = $false
    $state.recovery_checkpoint_ready = $false
    $state.mode = 'done'
    $state.audit_manifest_path = $manifestPath
    $script:KoseiJobs.Clear()
    $script:KoseiJobs[$jobId] = $state
    $ackFailed = $false
    try { $null = Acknowledge-KoseiJobResult -JobId $jobId -JobsRoot (Join-Path $base 'jobs') -UploadsRoot (Join-Path $base 'uploads') -AnswersDir $answers } catch { $ackFailed = $true }
    if (-not $ackFailed -or -not (Test-Path -LiteralPath $checkpoint) -or -not (Test-Path -LiteralPath $manifestPath)) { throw 'ACK failure discarded retained artifacts' }

    $state.recovery_checkpoint_ready = $true
    $script:KoseiJobs[$jobId] = $state
    if (-not (Acknowledge-KoseiJobResult -JobId $jobId -JobsRoot (Join-Path $base 'jobs') -UploadsRoot (Join-Path $base 'uploads') -AnswersDir $answers)) { throw 'ACK success failed' }
    if (Test-Path -LiteralPath $checkpoint) { throw 'ACK success left the recovery checkpoint' }
    $script:KoseiJobs.Clear()
    $manifest = Get-KoseiAuditManifest -JobId $jobId -AuditRoot $audit
    if ($null -eq $manifest -or $manifest.ack.status -ne 'imported') { throw 'audit manifest was not retained after ACK/reload' }

    if (-not (Remove-KoseiJobAuditArtifacts -JobId $jobId -AuditRoot $audit)) { throw 'explicit audit purge failed' }
    if (Test-Path -LiteralPath (Join-Path $audit $jobId)) { throw 'audit directory remains after purge' }
    'Test-AuditManifest: PASS'
} finally {
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
}

