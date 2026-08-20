$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Write-KoseiLog { param($Message, $Level) }
. (Join-Path $root 'src\ReviewJob.ps1')
. (Join-Path $root 'src\Server.ps1')

$reviewSource = [IO.File]::ReadAllText((Join-Path $root 'src\ReviewJob.ps1'), [Text.Encoding]::UTF8)
$startSource = $reviewSource.Substring($reviewSource.IndexOf('function Start-KoseiReviewJob {'))
if (-not $startSource.Contains('$jobRegistryLock = $script:KoseiJobs.SyncRoot') -or
    -not $startSource.Contains('[System.Threading.Monitor]::Enter($jobRegistryLock)') -or
    $startSource.IndexOf('$script:KoseiJobs[$jobId] = $state') -lt $startSource.IndexOf('Assert-KoseiRecoveryParentCanSpawn -ParentState $registeredParent')) {
    throw 'retry registration boundary does not revalidate parent uniqueness under the job-table lock'
}
if (-not $reviewSource.Contains('function Test-KoseiJobUploadOwnership') -or
    -not $reviewSource.Contains("'.kosei-owner'") -or
    -not $reviewSource.Contains('Test-KoseiJobUploadOwnership -State $State -UploadsRoot $UploadsRoot')) {
    throw 'retained artifact cleanup is missing strict per-job upload ownership validation'
}
if (-not $reviewSource.Contains('function Test-KoseiJournalFileIdentity') -or
    -not $reviewSource.Contains('Test-KoseiJournalFileIdentity -JournalPath $journalPath') -or
    -not $reviewSource.Contains('Test-KoseiRecoveryAnswerPathOwnership') -or
    -not $reviewSource.Contains('Test-KoseiJobUploadOwnership -State $state -UploadsRoot $UploadsRoot')) {
    throw 'startup recovery is missing journal/state/path, answer, or marker identity binding'
}
if (-not $reviewSource.Contains('function Remove-KoseiUnregisteredJobInputs') -or
    -not $startSource.Contains('$isResumeJob = $null -ne $ResumeSnapshot') -or
    -not $startSource.Contains('if ($isResumeJob)') -or
    -not $startSource.Contains('Test-KoseiJobUploadOwnership -State $state -UploadsRoot $uploadsRoot') -or
    $startSource.IndexOf('Write-KoseiJobUploadOwnershipMarker -State $state') -lt $startSource.IndexOf('[System.Threading.Monitor]::Enter($jobRegistryLock)')) {
    throw 'job start does not enforce marker creation/revalidation at the registration boundary'
}
$serverSource = [IO.File]::ReadAllText((Join-Path $root 'src\Server.ps1'), [Text.Encoding]::UTF8)
$saveSource = $serverSource.Substring($serverSource.IndexOf('function Save-KoseiIncomingJob {'))
if (-not $reviewSource.Contains('[IO.FileMode]::CreateNew') -or
    $reviewSource.Contains('[IO.File]::WriteAllText($markerPath') -or
    -not $saveSource.Contains('Remove-KoseiUnregisteredJobInputs -Packets @($cleanupPackets)') -or
    $saveSource.IndexOf('try {') -lt 0 -or $saveSource.IndexOf('Get-KoseiPacketStageMetadata') -lt $saveSource.IndexOf('try {')) {
    throw 'input save/marker paths are not inside atomic create and single cleanup boundaries'
}

# Marker ownership is a one-way safety check for resumed inputs: a scan may
# have accepted the marker, but a later delete or replacement must make the
# resume check fail rather than recreate the marker.  A failed new-job marker
# write removes only the packet files and leaves foreign marker contents.
$markerRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-marker-boundary-' + [guid]::NewGuid().ToString('N'))
try {
    $markerUploads = Join-Path $markerRoot 'uploads'
    New-Item -ItemType Directory -Path $markerUploads -Force | Out-Null
    $markerId = [guid]::NewGuid().ToString('N')
    $markerUpload = Join-Path $markerUploads ('job-' + $markerId)
    New-Item -ItemType Directory -Path $markerUpload -Force | Out-Null
    $markerState = [pscustomobject]@{ id=$markerId; upload_dir=$markerUpload }
    $markerPath = Join-Path $markerUpload '.kosei-owner'
    [IO.File]::WriteAllText($markerPath, $markerId, [Text.Encoding]::UTF8)
    if (-not (Test-KoseiJobUploadOwnership -State $markerState -UploadsRoot $markerUploads)) { throw 'valid upload marker was rejected' }
    Remove-Item -LiteralPath $markerPath -Force
    if (Test-KoseiJobUploadOwnership -State $markerState -UploadsRoot $markerUploads) { throw 'deleted upload marker remained resumable' }
    [IO.File]::WriteAllText($markerPath, ([guid]::NewGuid().ToString('N')), [Text.Encoding]::UTF8)
    if (Test-KoseiJobUploadOwnership -State $markerState -UploadsRoot $markerUploads) { throw 'replaced upload marker remained resumable' }
    $foreignMarkerValue = [IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8)
    if (Write-KoseiJobUploadOwnershipMarker -State $markerState -UploadsRoot $markerUploads) { throw 'CreateNew marker race accepted a foreign marker' }
    if ([IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8) -ne $foreignMarkerValue) { throw 'marker race overwrote a foreign marker' }

    $failedId = [guid]::NewGuid().ToString('N')
    $failedUpload = Join-Path $markerUploads ('job-' + $failedId)
    New-Item -ItemType Directory -Path $failedUpload -Force | Out-Null
    $failedMarkerDir = Join-Path $failedUpload '.kosei-owner'
    New-Item -ItemType Directory -Path $failedMarkerDir -Force | Out-Null
    $failedSentinel = Join-Path $failedMarkerDir 'foreign-sentinel.txt'; [IO.File]::WriteAllText($failedSentinel, 'keep', [Text.Encoding]::UTF8)
    $failedPrompt = Join-Path $failedUpload 'PROMPT_001.txt'; [IO.File]::WriteAllText($failedPrompt, 'new input', [Text.Encoding]::UTF8)
    $failedState = [pscustomobject]@{ id=$failedId; upload_dir=$failedUpload }
    $failedPacket = [pscustomobject]@{ prompt_path=$failedPrompt; text_path=''; pdf_path='' }
    if (Write-KoseiJobUploadOwnershipMarker -State $failedState -UploadsRoot $markerUploads) { throw 'marker creation unexpectedly succeeded over a marker directory' }
    Remove-KoseiUnregisteredJobInputs -Packets @($failedPacket) -State $failedState -UploadsRoot $markerUploads
    if (Test-Path -LiteralPath $failedPrompt) { throw 'failed marker cleanup left new input' }
    if (-not (Test-Path -LiteralPath $failedSentinel)) { throw 'failed marker cleanup deleted foreign marker content' }
} finally {
    if (Test-Path -LiteralPath $markerRoot) { Remove-Item -LiteralPath $markerRoot -Recurse -Force }
}

# Every input write, including stage metadata normalization, belongs to one
# failure boundary.  A mid-packet stage exception must remove only this new
# upload while preserving a pre-existing foreign upload/sentinel.
$saveRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-save-boundary-' + [guid]::NewGuid().ToString('N'))
$previousDataRoot = [Environment]::GetEnvironmentVariable('PDF_KOSEI_DATA_DIR')
try {
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR', $saveRoot)
    $saveUploads = Join-Path $saveRoot 'uploads'
    New-Item -ItemType Directory -Path $saveUploads -Force | Out-Null
    $foreignUpload = Join-Path $saveUploads 'foreign-job'; New-Item -ItemType Directory -Path $foreignUpload -Force | Out-Null
    $foreignUploadSentinel = Join-Path $foreignUpload 'keep.txt'; [IO.File]::WriteAllText($foreignUploadSentinel, 'keep', [Text.Encoding]::UTF8)
    $saveBody = [pscustomobject]@{
        attach_mode='text'
        packets=@([pscustomobject]@{ packet_id='stage-failure'; prompt='saved before stage validation'; text='text'; stage_index=0; stage_total=1 })
    }
    $saveSettings = [pscustomobject]@{ max_prompt_chars=10000 }
    $saveFailed = $false
    try { $null = Save-KoseiIncomingJob -Body $saveBody -Settings $saveSettings } catch { $saveFailed = $true }
    if (-not $saveFailed) { throw 'mid-save stage metadata exception was accepted' }
    if (-not (Test-Path -LiteralPath $foreignUploadSentinel)) { throw 'save failure cleanup deleted foreign upload sentinel' }
    $remainingUploads = @(Get-ChildItem -LiteralPath $saveUploads -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'foreign-job' })
    if ($remainingUploads.Count) { throw 'mid-save stage exception left a new upload directory' }
} finally {
    [Environment]::SetEnvironmentVariable('PDF_KOSEI_DATA_DIR', $previousDataRoot)
    if (Test-Path -LiteralPath $saveRoot) { Remove-Item -LiteralPath $saveRoot -Recurse -Force }
}

# Route-level lifecycle behavior is exercised without opening a listener.  The
# response writer is replaced only in this test so page-close/heartbeat state
# transitions can be observed directly.
$script:lastLifecycleStatus = 0
function Send-KoseiBytes {
    param($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Body)
    $script:lastLifecycleStatus = $StatusCode
}

# One worker may hang permanently; preserve a healthy result and terminate the stale worker.
$healthyPacket = [pscustomobject]@{ packet_id = 'ok'; status = 'done'; error = ''; completed_at = '' }
$hungPacket = [pscustomobject]@{ packet_id = 'hang'; status = 'running'; error = ''; completed_at = '' }
$packets = @($healthyPacket, $hungPacket)
$state = [hashtable]::Synchronized(@{
    id = [guid]::NewGuid().ToString('N')
    cancel_requested = $false
    packets_done = 1
    per_packet = $packets
})
$shared = [pscustomobject]@{
    heartbeats = @{ '0' = (Get-Date).ToString('o'); '1' = (Get-Date).AddSeconds(-10).ToString('o') }
}
$healthyPowerShell = [powershell]::Create()
$null = $healthyPowerShell.AddScript({ 'ok' })
$hungPowerShell = [powershell]::Create()
$null = $hungPowerShell.AddScript({ while ($true) { Start-Sleep -Seconds 5 } })
$handles = @(
    @{ PowerShell = $healthyPowerShell; Async = $healthyPowerShell.BeginInvoke(); Worker = 0; Indices = @(0) },
    @{ PowerShell = $hungPowerShell; Async = $hungPowerShell.BeginInvoke(); Worker = 1; Indices = @(1) }
)
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
Wait-KoseiWorkerHandles -Handles $handles -State $state -Shared $shared -LeaseSeconds 1 -JobTimeoutSeconds 10 -SkipJournal
$stopwatch.Stop()
if ($state.per_packet[0].status -ne 'done') { throw 'healthy worker result lost' }
if ($state.per_packet[1].status -ne 'error') { throw 'hung worker not marked error' }
if ($stopwatch.Elapsed.TotalSeconds -gt 5) { throw 'hung worker cleanup too slow' }

# A non-cooperative blocking call must not block the supervisor's terminal transition.
$blockedPacket = [pscustomobject]@{ packet_id='blocked'; status='running'; error=''; completed_at='' }
$blockedState = [hashtable]::Synchronized(@{ id=[guid]::NewGuid().ToString('N'); cancel_requested=$false; packets_done=0; per_packet=@($blockedPacket) })
$blockedShared = [pscustomobject]@{ heartbeats=@{'0'=(Get-Date).AddSeconds(-10).ToString('o')} }
$blockedPowerShell = [powershell]::Create()
$null = $blockedPowerShell.AddScript({ [Threading.Thread]::Sleep(6000) })
$blockedHandles = @(@{PowerShell=$blockedPowerShell;Async=$blockedPowerShell.BeginInvoke();Worker=0;Indices=@(0)})
$blockedWatch = [Diagnostics.Stopwatch]::StartNew()
Wait-KoseiWorkerHandles -Handles $blockedHandles -State $blockedState -Shared $blockedShared -LeaseSeconds 1 -JobTimeoutSeconds 10 -SkipJournal
$blockedWatch.Stop()
if ($blockedWatch.Elapsed.TotalSeconds -gt 2.5 -or $blockedState.per_packet[0].status -ne 'error') { throw 'non-cooperative worker blocked supervisor' }

# The journal is atomically replaced and always remains valid JSON.
$jobsRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-journal-test-' + [guid]::NewGuid().ToString('N'))
try {
    # Lease invalidation fences a non-cooperative worker from writing after terminal cleanup.
    $lateMarker = Join-Path $jobsRoot 'late-worker.txt'
    $fencedState = [hashtable]::Synchronized(@{id=[guid]::NewGuid().ToString('N');cancel_requested=$false;packets_done=0;per_packet=@([pscustomobject]@{packet_id='late';status='running';error='';completed_at=''})})
    $fencedShared = [hashtable]::Synchronized(@{heartbeats=@{'0'=(Get-Date).AddSeconds(-10).ToString('o')};active=[hashtable]::Synchronized(@{'0'=$true})})
    $fencedPowerShell = [powershell]::Create()
    $null = $fencedPowerShell.AddScript({param($Shared,$Marker);[Threading.Thread]::Sleep(2500);if([bool]$Shared.active['0']){[IO.File]::WriteAllText($Marker,'late')}}).AddArgument($fencedShared).AddArgument($lateMarker)
    Wait-KoseiWorkerHandles -Handles @(@{PowerShell=$fencedPowerShell;Async=$fencedPowerShell.BeginInvoke();Worker=0;Indices=@(0)}) -State $fencedState -Shared $fencedShared -LeaseSeconds 1 -JobTimeoutSeconds 10 -SkipJournal
    Start-Sleep -Seconds 3
    Clear-KoseiDeferredWorkerHandles
    if (Test-Path $lateMarker) { throw 'expired worker wrote after terminal transition' }

    $journalState = [hashtable]::Synchronized(@{
        id = [guid]::NewGuid().ToString('N')
        mode = 'running'
        attach_mode = 'text'
        upload_dir = 'x'
        per_packet = @()
    })
    1..5 | ForEach-Object {
        $journalState.mode = "running$_"
        Write-KoseiJobJournal -State $journalState -JobsRoot $jobsRoot
    }
    $journalPath = Get-KoseiJobJournalPath -JobId $journalState.id -JobsRoot $jobsRoot
    $journal = [IO.File]::ReadAllText($journalPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($journal.schema -ne 'kosei-job-journal-v1' -or $journal.state.mode -ne 'running5') {
        throw ("journal atomic replacement failed schema={0} mode={1}" -f $journal.schema, $journal.state.mode)
    }
    if (@(Get-ChildItem (Split-Path $journalPath) -Filter '*.tmp').Count) {
        throw 'journal temp remains'
    }

    # Round 2 is built eagerly in the browser, but its server-owned stage
    # barrier injects round-1 findings only after round 1 is terminal.
    $stageDigestPrompt = Join-Path $jobsRoot 'stage2-prompt.txt'
    [IO.File]::WriteAllText($stageDigestPrompt, 'round2 prompt', [Text.Encoding]::UTF8)
    $stageDigestState = [hashtable]::Synchronized(@{
        per_packet = @(
            [pscustomobject]@{
                stage_index=1; stage_order=1; raw_answer='{"findings":[{"page":5,"category":"number_mismatch","quote":"Already reported"}]}'
                passes=@()
            },
            [pscustomobject]@{ stage_index=2; stage_order=2; raw_answer=''; passes=@() }
        )
    })
    $stageDigestPacket = [pscustomobject]@{ stage_index=2; stage_order=2; prompt_path=$stageDigestPrompt; prompt_sha256='' }
    $stageDigestBefore = Get-KoseiFileSha256 -Path $stageDigestPrompt
    Add-KoseiStagePriorFindingsDigest -State $stageDigestState -StagePackets @($stageDigestPacket) -StageIndex 2
    $stageDigestText = [IO.File]::ReadAllText($stageDigestPrompt, [Text.Encoding]::UTF8)
    if ((-not $stageDigestText.Contains('SERVER_GENERATED_PRIOR_FINDINGS_DIGEST')) -or
        (-not $stageDigestText.Contains('Already reported')) -or
        ((Get-KoseiFileSha256 -Path $stageDigestPrompt) -eq $stageDigestBefore)) {
        throw 'server stage barrier did not inject round-1 digest and refresh prompt hash'
    }

    # Startup recovery preserves completed packets and queues only unfinished work.
    $uploadsRoot = Join-Path $jobsRoot 'uploads'
    $answersRoot = Join-Path $jobsRoot 'answers'
    $uploadDir = Join-Path $uploadsRoot ('job-' + $journalState.id)
    New-Item -ItemType Directory -Path $uploadDir,$answersRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $uploadDir '.kosei-owner'), [string]$journalState.id, [Text.Encoding]::UTF8)
    $junctionTarget = Join-Path $jobsRoot 'outside-junction-target'
    $junctionUpload = Join-Path $uploadsRoot 'linked'
    $junctionJob = Join-Path $junctionTarget 'job-through-link'
    New-Item -ItemType Directory -Path $junctionJob -Force | Out-Null
    $outsideMarker = Join-Path $junctionJob 'outside-marker.txt'; Set-Content -LiteralPath $outsideMarker -Value 'keep'
    try {
        $null = New-Item -ItemType Junction -Path $junctionUpload -Target $junctionTarget -ErrorAction Stop
        $linkedJob = Join-Path $junctionUpload 'job-through-link'
        if (Test-KoseiPathTreeNoReparse -Root $uploadsRoot -Path $linkedJob) { throw 'ancestor junction was accepted' }
        if (Remove-KoseiPathUnderRoot -Path $linkedJob -Root $uploadsRoot -Recurse) { throw 'cleanup crossed an ancestor junction' }
        if (-not (Test-Path -LiteralPath $outsideMarker)) { throw 'junction cleanup deleted external target' }
    } finally {
        if (Test-Path -LiteralPath $junctionUpload) { [IO.Directory]::Delete($junctionUpload, $false) }
    }
    $promptPath = Join-Path $uploadDir 'PROMPT_002.txt'
    $textPath = Join-Path $uploadDir 'TEXT_002.txt'
    [IO.File]::WriteAllText($promptPath, 'resume', [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($textPath, 'resume text', [Text.Encoding]::UTF8)
    $resultPath = Join-Path $answersRoot ($journalState.id + '_done.checkpoint.json')
    [IO.File]::WriteAllText($resultPath, '{"raw_answer":"secret-answer","passes":[]}', [Text.Encoding]::UTF8)
    $promptSha = Get-KoseiFileSha256 $promptPath
    $textSha = Get-KoseiFileSha256 $textPath
    $resultSha = Get-KoseiFileSha256 $resultPath
    $journalState.mode = 'running'
    $journalState.upload_dir = $uploadDir
    $journalState.per_packet = @(
        [pscustomobject]@{ packet_id='done'; status='done'; prompt_path=$promptPath; prompt_sha256=$promptSha; text_path=$textPath; text_sha256=$textSha; pdf_path=''; pdf_sha256=''; result_path=$resultPath; result_sha256=$resultSha; findings_count=3; raw_answer='secret-answer'; passes=@() },
        [pscustomobject]@{ packet_id='todo'; status='running'; prompt_path=$promptPath; prompt_sha256=$promptSha; text_path=$textPath; text_sha256=$textSha; pdf_path=''; pdf_sha256=''; findings_count=0 }
    )
    Write-KoseiJobJournal -State $journalState -JobsRoot $jobsRoot
    $journalProbe = [IO.File]::ReadAllText((Get-KoseiJobJournalPath -JobId $journalState.id -JobsRoot $jobsRoot), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $journalText = [IO.File]::ReadAllText((Get-KoseiJobJournalPath -JobId $journalState.id -JobsRoot $jobsRoot), [Text.Encoding]::UTF8)
    if ($journalText.Contains('secret-answer')) { throw 'journal contains response plaintext' }
    if (-not (Test-KoseiRecoveryFilePath -Path $promptPath -UploadDir $uploadDir -Extension '.txt' -Required)) { throw 'prompt recovery path validation failed' }
    if (-not (Test-KoseiRecoveryFilePath -Path $textPath -UploadDir $uploadDir -Extension '.txt' -Required)) { throw 'text recovery path validation failed' }
    $outsidePrompt = Join-Path $jobsRoot 'outside.txt'; [IO.File]::WriteAllText($outsidePrompt, 'outside')
    if (Test-KoseiRecoveryFilePath -Path $outsidePrompt -UploadDir $uploadDir -Extension '.txt' -Required) { throw 'outside recovery path was accepted' }
    $recovered = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $jobsRoot -UploadsRoot $uploadsRoot -AnswersDir $answersRoot
    if ($null -eq $recovered -or $recovered.per_packet[0].status -ne 'done' -or $recovered.per_packet[1].status -ne 'running') {
        throw 'startup recovery did not preserve checkpoint state'
    }
    $pendingDescriptor = Get-KoseiRecoverableJobState
    if ($null -eq $pendingDescriptor -or [string]$pendingDescriptor.id -ne [string]$journalState.id -or [string]$pendingDescriptor.mode -ne 'running') {
        throw 'startup running job was not exposed for reconnect polling'
    }
    [IO.File]::WriteAllText($textPath, 'TAMPERED SIDE-CAR', [Text.Encoding]::UTF8)
    $script:KoseiPendingRecovery = $null
    $tampered = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $jobsRoot -UploadsRoot $uploadsRoot -AnswersDir $answersRoot
    if ($null -ne $tampered -and [string]$tampered.id -eq [string]$journalState.id) { throw 'tampered sidecar was accepted for recovery' }
    [IO.File]::WriteAllText($textPath, 'resume text', [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($resultPath, '{"raw_answer":"TAMPERED RESULT","passes":[]}', [Text.Encoding]::UTF8)
    $script:KoseiPendingRecovery = $null
    $tamperedResult = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $jobsRoot -UploadsRoot $uploadsRoot -AnswersDir $answersRoot
    if ($null -eq $tamperedResult -or [string]$tamperedResult.id -ne [string]$journalState.id -or
        [string]$tamperedResult.per_packet[0].status -ne 'running' -or [string]$tamperedResult.per_packet[0].raw_answer -eq 'TAMPERED RESULT') {
        throw 'tampered checkpoint was not safely downgraded'
    }

    # Recovery must reject a journal whose upload_dir is valid but a packet path escapes it.
    $maliciousState = [hashtable]::Synchronized(@{
        id=[guid]::NewGuid().ToString('N'); mode='running'; attach_mode='text'; upload_dir=$uploadDir
        cancel_requested=$false; journal_revision=0; per_packet=@(
            [pscustomobject]@{packet_id='escape';status='running';prompt_path=$outsidePrompt;text_path=$textPath;pdf_path='';result_path=''}
        )
    })
    Write-KoseiJobJournal -State $maliciousState -JobsRoot $jobsRoot
    $script:KoseiPendingRecovery = $null
    $afterMalicious = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $jobsRoot -UploadsRoot $uploadsRoot -AnswersDir $answersRoot
    if ($null -ne $afterMalicious -and [string]$afterMalicious.id -eq [string]$maliciousState.id) {
        throw 'journal with escaped prompt path was accepted for recovery'
    }
    if (Test-KoseiRecoveryFilePath -Path $promptPath -UploadDir $uploadDir -Extension '.pdf' -Required) {
        throw 'recovery accepted a path with the wrong extension'
    }

    # Journal identity is the direct JobsRoot/<id>/state.json path, not the
    # state.id field alone.  Both an id swap and an upload_dir/marker swap must
    # leave the foreign job's upload, answer, and journal sentinels intact.
    $identityRoot = Join-Path $jobsRoot 'identity-spoof'
    $identityJobs = Join-Path $identityRoot 'jobs'; $identityUploads = Join-Path $identityRoot 'uploads'; $identityAnswers = Join-Path $identityRoot 'answers'
    New-Item -ItemType Directory -Path $identityJobs,$identityUploads,$identityAnswers -Force | Out-Null
    $identityA = [guid]::NewGuid().ToString('N'); $identityB = [guid]::NewGuid().ToString('N')
    $identityADir = Join-Path $identityJobs $identityA; $identityBDir = Join-Path $identityJobs $identityB
    $identityUploadB = Join-Path $identityUploads ('job-' + $identityB)
    New-Item -ItemType Directory -Path $identityADir,$identityBDir,$identityUploadB -Force | Out-Null
    $identityUploadSentinel = Join-Path $identityUploadB 'foreign-upload-sentinel.txt'; [IO.File]::WriteAllText($identityUploadSentinel, 'keep', [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $identityUploadB '.kosei-owner'), $identityB, [Text.Encoding]::UTF8)
    $identityAnswerSentinel = Join-Path $identityAnswers ($identityB + '_foreign.checkpoint.json'); [IO.File]::WriteAllText($identityAnswerSentinel, '{}', [Text.Encoding]::UTF8)
    $identityJournalSentinel = Join-Path $identityBDir 'foreign-journal-sentinel.txt'; [IO.File]::WriteAllText($identityJournalSentinel, 'keep', [Text.Encoding]::UTF8)
    $identityState = [ordered]@{ id=$identityB; mode='cancelled'; upload_dir=$identityUploadB; per_packet=@(); cancel_requested=$true; result_retained=$false }
    $identityPayload = [ordered]@{ schema='kosei-job-journal-v1'; written_at=(Get-Date).ToString('o'); state=$identityState } | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText((Join-Path $identityADir 'state.json'), $identityPayload, [Text.Encoding]::UTF8)
    $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $identityJobs -UploadsRoot $identityUploads -AnswersDir $identityAnswers
    if ((Test-Path (Join-Path $identityADir 'state.json')) -or -not (Test-Path $identityUploadSentinel) -or -not (Test-Path $identityAnswerSentinel) -or -not (Test-Path $identityJournalSentinel)) {
        throw 'state.id spoof cleanup touched a foreign upload/answer/journal sentinel'
    }
    $identityState.id = $identityA
    $identityState.upload_dir = $identityUploadB
    $identityPayload = [ordered]@{ schema='kosei-job-journal-v1'; written_at=(Get-Date).ToString('o'); state=$identityState } | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText((Join-Path $identityADir 'state.json'), $identityPayload, [Text.Encoding]::UTF8)
    $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $identityJobs -UploadsRoot $identityUploads -AnswersDir $identityAnswers
    if ((Test-Path (Join-Path $identityADir 'state.json')) -or -not (Test-Path $identityUploadSentinel) -or -not (Test-Path $identityAnswerSentinel) -or -not (Test-Path $identityJournalSentinel)) {
        throw 'upload marker/path spoof cleanup touched a foreign upload/answer/journal sentinel'
    }

    # A tab may close after the worker has reached terminal state.  The
    # checkpoint/journal must remain discoverable after a fresh server load,
    # while the explicit client acknowledgement removes retained artifacts.
    $terminalRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-terminal-recovery-' + [guid]::NewGuid().ToString('N'))
    $terminalUploads = Join-Path $terminalRoot 'uploads'
    $terminalAnswers = Join-Path $terminalRoot 'answers'
    $terminalJobs = Join-Path $terminalRoot 'jobs'
    try {
        $terminalId = [guid]::NewGuid().ToString('N')
        $terminalUploadDir = Join-Path $terminalUploads ('job-' + $terminalId)
        New-Item -ItemType Directory -Path $terminalUploadDir,$terminalAnswers,$terminalJobs -Force | Out-Null
        $terminalInput = Join-Path $terminalUploadDir 'input.txt'
        [IO.File]::WriteAllText($terminalInput, 'sensitive input', [Text.Encoding]::UTF8)
        $terminalResult = Join-Path $terminalAnswers ($terminalId + '_terminal.checkpoint.json')
        [IO.File]::WriteAllText($terminalResult, '{"raw_answer":"recoverable-answer","passes":[]}', [Text.Encoding]::UTF8)
        $terminalPacket = [pscustomobject]@{
            packet_id='terminal'; status='done'; prompt_path=''; prompt_sha256=''; text_path=''; text_sha256=''; pdf_path=''; pdf_sha256=''
            result_path=$terminalResult; result_sha256=(Get-KoseiFileSha256 $terminalResult); kind='proofread'; has_ref=$false; profile=''
            target_pages=@(1); stage_metadata_present=$false; stage_index=1; stage_order=1; stage_total=1; stage_id=''; stage_label=''
            phase=''; error=''; completed_by='terminal'; detail=''; elapsed_ms=1; total_elapsed_ms=1; response_wait_ms=0; phase_timings=$null
            started_at=''; completed_at=(Get-Date).ToString('o'); findings_count=0; pages_checked=@(1); coverage=1.0; warning=''; passes=@()
        }
        $terminalState = [hashtable]::Synchronized(@{
            id=$terminalId; mode='done'; phase=''; attach_mode='text'; packets_total=1; packets_done=1; current_packet=''; current_packets=@()
            current_stage_index=1; current_stage_total=1; current_stage_id=''; current_stage_label=''; stage_statuses=@()
            needs_user_visibility=$false; error=''; cancel_requested=$false; journal_revision=0; created_at=(Get-Date).ToString('o'); updated_at=(Get-Date).ToString('o')
            upload_dir=$terminalUploadDir; target_file_name='target.pdf'; target_page_count=1; declared_stage_total=1; terminal_at=(Get-Date).ToString('o')
            recovery_expires_at=(Get-Date).AddMinutes(30).ToString('o'); recovery_acknowledged=$false; result_retained=$true; per_packet=@($terminalPacket)
        })
        $script:KoseiJobs.Clear()
        Write-KoseiJobJournal -State $terminalState -JobsRoot $terminalJobs
        # Simulate Start-KoseiAssist's current sequence: the generic diagnostic
        # sweep runs before journal recovery, with the default retention=0.
        $null = Invoke-KoseiRetentionSweep -Settings @{ diagnostic_retention_days = 0 } -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers -JobsRoot $terminalJobs
        if (-not (Test-Path -LiteralPath $terminalResult) -or -not (Test-Path -LiteralPath (Get-KoseiJobJournalPath -JobId $terminalId -JobsRoot $terminalJobs))) {
            throw 'startup retention sweep deleted an unexpired terminal result before recovery'
        }
        # Simulate the next server process: reload the retained journal and
        # discover the completed result without the original tab's memory.
        $script:KoseiJobs.Clear()
        $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $terminalJobs -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers
        $loadedTerminal = $script:KoseiJobs[$terminalId]
        if ($null -eq $loadedTerminal -or [string]$loadedTerminal.mode -ne 'done') { throw 'terminal checkpoint was not recovered after app close' }
        $recoverable = Get-KoseiRecoverableJobState
        if ($null -eq $recoverable -or [string]$recoverable.id -ne $terminalId) { throw 'terminal result was not discoverable through recovery state' }
        if (-not (Acknowledge-KoseiJobResult -JobId $terminalId -JobsRoot $terminalJobs -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers)) {
            throw 'terminal result acknowledgement failed'
        }
        if ((Test-Path -LiteralPath $terminalResult) -or
            (Test-Path -LiteralPath $terminalUploadDir) -or
            (Test-Path -LiteralPath (Get-KoseiJobJournalPath -JobId $terminalId -JobsRoot $terminalJobs))) {
            throw 'acknowledgement did not clean retained terminal artifacts'
        }

        # Expired terminal records are removed by the same startup sweep.
        $expiredId = [guid]::NewGuid().ToString('N')
        $expiredUploadDir = Join-Path $terminalUploads ('job-' + $expiredId)
        New-Item -ItemType Directory -Path $expiredUploadDir -Force | Out-Null
        $expiredResult = Join-Path $terminalAnswers ($expiredId + '_terminal.checkpoint.json')
        [IO.File]::WriteAllText($expiredResult, '{"raw_answer":"expired","passes":[]}', [Text.Encoding]::UTF8)
        $expiredPacket = $terminalPacket.PSObject.Copy()
        $expiredPacket.packet_id = 'expired'; $expiredPacket.result_path = $expiredResult; $expiredPacket.result_sha256 = Get-KoseiFileSha256 $expiredResult
        $expiredState = $terminalState.Clone()
        $expiredState.id = $expiredId; $expiredState.upload_dir = $expiredUploadDir; $expiredState.per_packet = @($expiredPacket)
        $expiredState.terminal_at = (Get-Date).AddHours(-2).ToString('o'); $expiredState.recovery_expires_at = (Get-Date).AddSeconds(-1).ToString('o'); $expiredState.result_retained = $true
        Write-KoseiJobJournal -State $expiredState -JobsRoot $terminalJobs
        $null = Invoke-KoseiRetentionSweep -Settings @{ diagnostic_retention_days = 0 } -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers -JobsRoot $terminalJobs
        $script:KoseiJobs.Clear()
        $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $terminalJobs -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers
        if ((Test-Path -LiteralPath $expiredResult) -or (Test-Path -LiteralPath (Get-KoseiJobJournalPath -JobId $expiredId -JobsRoot $terminalJobs))) {
            throw 'expired terminal recovery artifacts were not cleaned'
        }

        # An unexpired but tampered checkpoint is protected from the generic
        # pre-recovery sweep, then fail-closed and cleaned by journal recovery.
        $tamperedTerminalId = [guid]::NewGuid().ToString('N')
        $tamperedUploadDir = Join-Path $terminalUploads ('job-' + $tamperedTerminalId)
        New-Item -ItemType Directory -Path $tamperedUploadDir -Force | Out-Null
        $tamperedTerminalResult = Join-Path $terminalAnswers ($tamperedTerminalId + '_terminal.checkpoint.json')
        [IO.File]::WriteAllText($tamperedTerminalResult, '{"raw_answer":"tampered","passes":[]}', [Text.Encoding]::UTF8)
        $tamperedPacket = $terminalPacket.PSObject.Copy()
        $tamperedPacket.packet_id = 'tampered'; $tamperedPacket.result_path = $tamperedTerminalResult; $tamperedPacket.result_sha256 = ('0' * 64)
        $tamperedState = $terminalState.Clone()
        $tamperedState.id = $tamperedTerminalId; $tamperedState.upload_dir = $tamperedUploadDir; $tamperedState.per_packet = @($tamperedPacket)
        $tamperedState.terminal_at = (Get-Date).ToString('o'); $tamperedState.recovery_expires_at = (Get-Date).AddMinutes(30).ToString('o'); $tamperedState.result_retained = $true
        Write-KoseiJobJournal -State $tamperedState -JobsRoot $terminalJobs
        $null = Invoke-KoseiRetentionSweep -Settings @{ diagnostic_retention_days = 0 } -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers -JobsRoot $terminalJobs
        $script:KoseiJobs.Clear()
        $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $terminalJobs -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers
        if (($null -ne $script:KoseiJobs[$tamperedTerminalId]) -or
            (Test-Path -LiteralPath $tamperedTerminalResult) -or
            (Test-Path -LiteralPath (Get-KoseiJobJournalPath -JobId $tamperedTerminalId -JobsRoot $terminalJobs))) {
            throw 'tampered terminal checkpoint was not rejected and cleaned'
        }

        # Missing or malformed recovery_expires_at must fail closed.  In
        # particular, a fresh updated_at must not resurrect an invalid lease.
        $invalidExpiryId = [guid]::NewGuid().ToString('N')
        $invalidExpiryUploadDir = Join-Path $terminalUploads ('job-' + $invalidExpiryId)
        New-Item -ItemType Directory -Path $invalidExpiryUploadDir -Force | Out-Null
        $invalidExpiryResult = Join-Path $terminalAnswers ($invalidExpiryId + '_terminal.checkpoint.json')
        [IO.File]::WriteAllText($invalidExpiryResult, '{"raw_answer":"invalid-expiry","passes":[]}', [Text.Encoding]::UTF8)
        $invalidExpiryPacket = $terminalPacket.PSObject.Copy()
        $invalidExpiryPacket.packet_id = 'invalid-expiry'
        $invalidExpiryPacket.result_path = $invalidExpiryResult
        $invalidExpiryPacket.result_sha256 = Get-KoseiFileSha256 $invalidExpiryResult
        $invalidExpiryState = $terminalState.Clone()
        $invalidExpiryState.id = $invalidExpiryId
        $invalidExpiryState.upload_dir = $invalidExpiryUploadDir
        $invalidExpiryState.per_packet = @($invalidExpiryPacket)
        $invalidExpiryState.updated_at = (Get-Date).AddMinutes(5).ToString('o')
        $invalidExpiryState.recovery_expires_at = 'not-a-date'
        $invalidExpiryState.result_retained = $true
        Write-KoseiJobJournal -State $invalidExpiryState -JobsRoot $terminalJobs
        if (-not (Test-KoseiRecoveryExpired -State $invalidExpiryState)) {
            throw 'malformed recovery expiry was treated as unexpired'
        }
        $null = Invoke-KoseiRetentionSweep -Settings @{ diagnostic_retention_days = 0 } -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers -JobsRoot $terminalJobs
        $script:KoseiJobs.Clear()
        $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $terminalJobs -UploadsRoot $terminalUploads -AnswersDir $terminalAnswers
        if (($null -ne $script:KoseiJobs[$invalidExpiryId]) -or
            (Test-Path -LiteralPath $invalidExpiryResult) -or
            (Test-Path -LiteralPath (Get-KoseiJobJournalPath -JobId $invalidExpiryId -JobsRoot $terminalJobs))) {
            throw 'malformed recovery expiry was not rejected and cleaned'
        }
    } finally {
        if (Test-Path -LiteralPath $terminalRoot) { Remove-Item -LiteralPath $terminalRoot -Recurse -Force }
    }

    # Visibility retries are separate jobs, but recovery must expose one
    # logical chain.  A tab may disappear while the child is still running;
    # the parent packet must remain available and a later successful retry must
    # acknowledge/remove both jobs together.
    $chainRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-recovery-chain-' + [guid]::NewGuid().ToString('N'))
    $chainUploads = Join-Path $chainRoot 'uploads'; $chainAnswers = Join-Path $chainRoot 'answers'; $chainJobs = Join-Path $chainRoot 'jobs'
    try {
        New-Item -ItemType Directory -Path $chainUploads,$chainAnswers,$chainJobs -Force | Out-Null
        $invalidChainRejected = $false
        try { $null = Get-KoseiRecoveryChainRequest -ChainId 'bad-chain' -AncestorJobIds @('bad-ancestor') } catch { $invalidChainRejected = $true }
        if (-not $invalidChainRejected) { throw 'unsafe recovery chain metadata was accepted' }
        $chainId = [guid]::NewGuid().ToString('N'); $parentId = [guid]::NewGuid().ToString('N'); $childId = [guid]::NewGuid().ToString('N')
        $chainTargetHash = 'a' * 64
        $parentResult = Join-Path $chainAnswers ($parentId + '_keep.checkpoint.json')
        $childResult = Join-Path $chainAnswers ($childId + '_retry.checkpoint.json')
        [IO.File]::WriteAllText($parentResult, '{"raw_answer":"parent-answer","passes":[]}', [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText($childResult, '{"raw_answer":"child-answer","passes":[]}', [Text.Encoding]::UTF8)
        $makeChainPacket = {
            param($Id,$Status,$ResultPath,$ResultSha)
            [pscustomobject]@{
                packet_id=$Id; status=$Status; error=''; prompt_path=''; prompt_sha256=''; text_path=''; text_sha256=''; pdf_path=''; pdf_sha256=''
                result_path=$ResultPath; result_sha256=$ResultSha; kind='proofread'; has_ref=$false; profile=''; target_pages=@(1)
                stage_metadata_present=$false; stage_index=1; stage_order=1; stage_total=1; stage_id=''; stage_label=''; phase=''; completed_by='test'; detail=''
                elapsed_ms=1; total_elapsed_ms=1; response_wait_ms=0; phase_timings=$null; started_at=''; completed_at=(Get-Date).ToString('o'); findings_count=0; pages_checked=@(1); coverage=1.0; warning=''; passes=@(); raw_answer=''
            }
        }
        $parentPacket = & $makeChainPacket 'keep' 'done' $parentResult (Get-KoseiFileSha256 $parentResult)
        $failedPacket = & $makeChainPacket 'retry' 'paused' '' ''
        $childPacket = & $makeChainPacket 'retry' 'done' $childResult (Get-KoseiFileSha256 $childResult)
        $parentPacket.raw_answer = 'parent-answer'; $childPacket.raw_answer = 'child-answer'
        $makeChainState = {
            param($Id,$Mode,$Packets,$Created,$Retained,$Parent)
            [hashtable]::Synchronized(@{
                id=$Id; mode=$Mode; phase=''; attach_mode='text'; packets_total=@($Packets).Count; packets_done=@($Packets | Where-Object { @('done','warning') -contains [string]$_.status }).Count; current_packet=''; current_packets=@()
                current_stage_index=1; current_stage_total=1; current_stage_id=''; current_stage_label=''; stage_statuses=@(); needs_user_visibility=($Mode -eq 'needs_user_visibility'); error=''; cancel_requested=$false; journal_revision=0
                created_at=$Created; updated_at=$Created; upload_dir=(Join-Path $chainUploads ('job-' + $Id)); target_file_name='target.pdf'; target_page_count=1; target_pdf_sha256=$chainTargetHash
                recovery_metadata=[ordered]@{ schema='kosei-recovery-v1'; target_pdf_sha256=$chainTargetHash; mask_seed=0; packets=@() }; mask_seed=0
                recovery_chain_id=$chainId; recovery_parent_job_id=$Parent; recovery_ancestor_job_ids=$(if ($Parent) { @($Parent) } else { @() }); declared_stage_total=1
                terminal_at=$Created; recovery_expires_at=(Get-Date).AddMinutes(30).ToString('o'); recovery_acknowledged=$false; result_retained=$Retained; recovery_checkpoint_ready=$Retained; per_packet=@($Packets)
            })
        }
        $parentState = & $makeChainState $parentId 'error' @($parentPacket,$failedPacket) (Get-Date).AddMinutes(-2).ToString('o') $true ''
        $childState = & $makeChainState $childId 'running' @($childPacket) (Get-Date).AddMinutes(-1).ToString('o') $false $parentId
        $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $childId; $script:KoseiRecoverableJobId = $parentId
        $script:KoseiJobs[$parentId] = $parentState; $script:KoseiJobs[$childId] = $childState
        Write-KoseiJobJournal -State $parentState -JobsRoot $chainJobs; Write-KoseiJobJournal -State $childState -JobsRoot $chainJobs
        $duringRetry = Get-KoseiRecoverableJobState
        if ($null -eq $duringRetry -or [string]$duringRetry.id -ne $childId) { throw 'retry abandonment did not select the newest chain job' }
        $duringResult = Get-KoseiRecoveryChainResultObject -State $duringRetry
        if (@($duringResult.packets | Where-Object { [string]$_.packet_id -eq 'keep' }).Count -ne 1) { throw 'retry abandonment lost the completed parent packet' }
        if (@($duringResult.recovery_chain_jobs).Count -ne 2) { throw 'recoverable descriptor did not represent one logical chain' }

        # A retained parent is a unique leaf.  Existing children block a new
        # retry regardless of whether the child is running or terminal, and
        # the shared-table topology check must reject a sibling branch even
        # when journals were inserted in reverse order.
        $singleChildRejected = $false
        try { $null = Assert-KoseiRecoveryParentCanSpawn -ParentState $parentState -ParentJobId $parentId -ChainId $chainId } catch { $singleChildRejected = $true }
        if (-not $singleChildRejected) { throw 'retry parent with an existing child was accepted' }
        $branchAId = [guid]::NewGuid().ToString('N'); $branchBId = [guid]::NewGuid().ToString('N')
        $branchA = & $makeChainState $branchAId 'running' @($childPacket) (Get-Date).ToString('o') $false $parentId
        $branchB = & $makeChainState $branchBId 'done' @($childPacket) (Get-Date).ToString('o') $true $parentId
        $script:KoseiJobs.Clear()
        $script:KoseiJobs[$branchBId] = $branchB
        $script:KoseiJobs[$branchAId] = $branchA
        $script:KoseiJobs[$parentId] = $parentState
        $branchRejected = $false
        try { $null = Assert-KoseiRecoveryParentCanSpawn -ParentState $parentState -ParentJobId $parentId -ChainId $chainId } catch { $branchRejected = $true }
        if (-not $branchRejected) { throw 'retry parent with a reverse-inserted sibling branch was accepted' }
        $branchSummary = Get-KoseiRecoveryChainSummary -State $branchA -IncludeActive
        if ($null -ne $branchSummary) { throw 'branched recovery chain was merged instead of failing closed' }
        $script:KoseiJobs.Clear()
        $script:KoseiJobs[$parentId] = $parentState
        $script:KoseiJobs[$childId] = $childState
        $childState.mode = 'done'; $childState.result_retained = $true; $childState.recovery_checkpoint_ready = $true; $childState.updated_at = (Get-Date).ToString('o')
        Write-KoseiJobJournal -State $childState -JobsRoot $chainJobs
        $afterRetry = Get-KoseiRecoverableJobState
        $afterResult = Get-KoseiRecoveryChainResultObject -State $afterRetry
        if ([string]$afterResult.mode -ne 'done' -or @($afterResult.packets | Where-Object { [string]$_.packet_id -eq 'keep' }).Count -ne 1 -or [string](@($afterResult.packets | Where-Object { [string]$_.packet_id -eq 'retry' })[0].raw_answer) -ne 'child-answer') {
            throw 'successful retry revisit did not merge parent and child packets'
        }
        if (-not (Acknowledge-KoseiJobResult -JobId $childId -ChainId $chainId -JobsRoot $chainJobs -UploadsRoot $chainUploads -AnswersDir $chainAnswers)) { throw 'logical recovery chain acknowledgement failed' }
        if ($script:KoseiJobs.ContainsKey($parentId) -or $script:KoseiJobs.ContainsKey($childId) -or (Test-Path (Get-KoseiJobJournalPath -JobId $parentId -JobsRoot $chainJobs)) -or (Test-Path (Get-KoseiJobJournalPath -JobId $childId -JobsRoot $chainJobs))) { throw 'old retry source job resurfaced after chain acknowledgement' }

        # First terminal observation may race the worker's final journal write.
        # The readiness marker must reject ACK until the retained checkpoint is
        # complete, and a subsequent ACK must not allow a journal resurrection.
        $raceId = [guid]::NewGuid().ToString('N'); $raceResult = Join-Path $chainAnswers ($raceId + '_race.checkpoint.json')
        [IO.File]::WriteAllText($raceResult, '{"raw_answer":"race","passes":[]}', [Text.Encoding]::UTF8)
        $racePacket = & $makeChainPacket 'race' 'done' $raceResult (Get-KoseiFileSha256 $raceResult)
        $raceState = & $makeChainState $raceId 'done' @($racePacket) (Get-Date).ToString('o') $true ''
        $raceState.recovery_checkpoint_ready = $false; $script:KoseiJobs[$raceId] = $raceState; Write-KoseiJobJournal -State $raceState -JobsRoot $chainJobs
        $raceRejected = $false
        try { $null = Acknowledge-KoseiJobResult -JobId $raceId -JobsRoot $chainJobs -UploadsRoot $chainUploads -AnswersDir $chainAnswers } catch { $raceRejected = $true }
        if (-not $raceRejected -or -not (Test-Path (Get-KoseiJobJournalPath -JobId $raceId -JobsRoot $chainJobs))) { throw 'terminal observation raced checkpoint retention and was acknowledged' }
        $raceState.recovery_checkpoint_ready = $true; Write-KoseiJobJournal -State $raceState -JobsRoot $chainJobs
        if (-not (Acknowledge-KoseiJobResult -JobId $raceId -JobsRoot $chainJobs -UploadsRoot $chainUploads -AnswersDir $chainAnswers)) { throw 'ready terminal result acknowledgement failed' }
        if (Test-Path (Get-KoseiJobJournalPath -JobId $raceId -JobsRoot $chainJobs)) { throw 'terminal ACK race recreated the journal' }

        # Chain summaries must follow validated parent -> child topology even
        # when the retry ID sorts before its parent and its clock moved
        # backwards.  An invalid lineage member must not become the latest
        # state merely because it is present in the shared table.
        $topologyChainId = [guid]::NewGuid().ToString('N')
        $topologyParentId = 'f' * 32
        $topologyChildId = '0' * 32
        $topologyClock = (Get-Date).AddMinutes(-3).ToString('o')
        $topologyParent = & $makeChainState $topologyParentId 'error' @($parentPacket) $topologyClock $true ''
        $topologyChild = & $makeChainState $topologyChildId 'done' @($childPacket) $topologyClock $true $topologyParentId
        foreach ($topologyState in @($topologyParent,$topologyChild)) {
            $topologyState.recovery_chain_id = $topologyChainId
            $topologyState.created_at = $topologyClock
            $topologyState.updated_at = $topologyClock
        }
        $topologyChild.updated_at = (Get-Date).AddHours(-2).ToString('o')
        $topologyMalformed = & $makeChainState ('1' * 32) 'done' @() $topologyClock $true $topologyChildId
        $topologyMalformed.recovery_chain_id = $topologyChainId
        $topologyMalformed.recovery_ancestor_job_ids = @($topologyParentId)
        $script:KoseiJobs.Clear()
        # Insert the child first to ensure table/insertion order cannot select
        # the latest member; only graph topology may decide it.
        $script:KoseiJobs[$topologyChildId] = $topologyChild
        $script:KoseiJobs[$topologyParentId] = $topologyParent
        $script:KoseiJobs[$topologyMalformed.id] = $topologyMalformed
        $topologySummary = Get-KoseiRecoveryChainSummary -State $topologyChild -IncludeActive
        if ($null -eq $topologySummary -or [string]$topologySummary.latest.id -ne $topologyChildId) {
            throw 'recovery chain latest state followed timestamps/IDs instead of validated topology'
        }
        $topologyStateIds = @($topologySummary.states | ForEach-Object { [string]$_.id })
        if ($topologyStateIds.Count -ne 2 -or $topologyStateIds[0] -ne $topologyParentId -or $topologyStateIds[1] -ne $topologyChildId -or $topologyStateIds -contains $topologyMalformed.id) {
            throw 'recovery chain summary included an invalid lineage member or wrong topology order'
        }
        $script:KoseiActiveJobId = $topologyChildId
        $topologyDescriptor = Get-KoseiRecoverableJobState
        if ($null -eq $topologyDescriptor -or [string]$topologyDescriptor.id -ne $topologyChildId) {
            throw 'recoverable descriptor selected a timestamp/ID predecessor instead of the validated leaf'
        }
        $script:KoseiActiveJobId = $null
    } finally {
        $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $null; $script:KoseiRecoverableJobId = $null
        if (Test-Path $chainRoot) { Remove-Item -LiteralPath $chainRoot -Recurse -Force }
    }

    # A returning tab must discover an ordinary queued/running job as well as
    # a retained terminal chain.  Retry source binding is rooted in the first
    # job's canonical PDF identity and masking seed.
    $activeReconnectId = [guid]::NewGuid().ToString('N')
    $activeReconnect = [hashtable]::Synchronized(@{
        id=$activeReconnectId; mode='running'; created_at=(Get-Date).ToString('o'); updated_at=(Get-Date).ToString('o')
        recovery_chain_id=''; recovery_parent_job_id=''; recovery_ancestor_job_ids=@(); result_retained=$false; per_packet=@()
    })
    $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $activeReconnectId; $script:KoseiJobs[$activeReconnectId] = $activeReconnect
    $activeDescriptor = Get-KoseiRecoverableJobState
    if ($null -eq $activeDescriptor -or [string]$activeDescriptor.id -ne $activeReconnectId -or [string]$activeDescriptor.mode -ne 'running') { throw 'running job was not reconnectable after tab revisit' }
    $bindingRootId = [guid]::NewGuid().ToString('N'); $bindingChildId = [guid]::NewGuid().ToString('N')
    $bindingRoot = & $makeChainState $bindingRootId 'error' @() (Get-Date).AddMinutes(-1).ToString('o') $true ''
    $bindingRoot.mask_seed = 7; $bindingRoot.recovery_metadata.mask_seed = 7
    $bindingRoot.recovery_expires_at = (Get-Date).AddMinutes(30).ToString('o')
    $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $null; $script:KoseiJobs[$bindingRootId] = $bindingRoot
    $mismatchChecks = @(
        @{ name='hash'; file='target.pdf'; pages=1; hash=('b' * 64); metadataHash=('a' * 64); seed=7 },
        @{ name='filename'; file='other.pdf'; pages=1; hash=('a' * 64); metadataHash=('a' * 64); seed=7 },
        @{ name='page-count'; file='target.pdf'; pages=2; hash=('a' * 64); metadataHash=('a' * 64); seed=7 },
        @{ name='mask-seed'; file='target.pdf'; pages=1; hash=('a' * 64); metadataHash=('a' * 64); seed=8 }
    )
    foreach ($check in $mismatchChecks) {
        $rejected = $false
        try {
            $null = Resolve-KoseiRecoverySourceBinding -TargetFileName $check.file -TargetPageCount $check.pages -TargetPdfSha256 $check.hash -RecoveryMetadata ([pscustomobject]@{ target_pdf_sha256=$check.metadataHash; mask_seed=$check.seed }) -ParentState $bindingRoot
        } catch { $rejected = $true }
        if (-not $rejected) { throw ("retry source binding mismatch was accepted: " + $check.name) }
    }
    # A child that is still running keeps an expired ancestor lease alive; once
    # it publishes a terminal checkpoint the ancestor gets one finite 30-minute
    # grace, and a later expired sweep removes the chain.
    $bindingChild = & $makeChainState $bindingChildId 'running' @() (Get-Date).ToString('o') $false $bindingRootId
    $bindingChild.mask_seed = 7; $bindingChild.recovery_metadata.mask_seed = 7
    $bindingRoot.recovery_expires_at = (Get-Date).AddMinutes(-1).ToString('o')
    $script:KoseiActiveJobId = $bindingChildId; $script:KoseiJobs[$bindingChildId] = $bindingChild
    if (-not (Test-KoseiRecoveryChainHasActiveDescendant -State $bindingRoot)) { throw 'fully validated active retry child was not recognized' }
    $bindingOriginal = @{
        chain=$bindingChild.recovery_chain_id; parent=$bindingChild.recovery_parent_job_id; ancestors=@($bindingChild.recovery_ancestor_job_ids)
        hash=$bindingChild.target_pdf_sha256; file=$bindingChild.target_file_name; pages=$bindingChild.target_page_count; seed=$bindingChild.mask_seed; metadataHash=$bindingChild.recovery_metadata.target_pdf_sha256; metadataSeed=$bindingChild.recovery_metadata.mask_seed
    }
    $lineageNegatives = @(
        @{ name='different-chain'; change={ $bindingChild.recovery_chain_id = [guid]::NewGuid().ToString('N') } },
        @{ name='extra-ancestor'; change={ $bindingChild.recovery_ancestor_job_ids = @($bindingRootId,[guid]::NewGuid().ToString('N')) } },
        @{ name='wrong-parent'; change={ $bindingChild.recovery_parent_job_id = [guid]::NewGuid().ToString('N') } },
        @{ name='hash-mismatch'; change={ $bindingChild.target_pdf_sha256 = ('b' * 64); $bindingChild.recovery_metadata.target_pdf_sha256 = ('b' * 64) } },
        @{ name='page-mismatch'; change={ $bindingChild.target_page_count = 2 } },
        @{ name='filename-mismatch'; change={ $bindingChild.target_file_name = 'other.pdf' } },
        @{ name='seed-mismatch'; change={ $bindingChild.mask_seed = 8; $bindingChild.recovery_metadata.mask_seed = 8 } }
    )
    foreach ($negative in $lineageNegatives) {
        & $negative.change
        if (Test-KoseiRecoveryChainHasActiveDescendant -State $bindingRoot) { throw ("invalid active descendant lineage was trusted: " + $negative.name) }
        $bindingChild.recovery_chain_id=$bindingOriginal.chain; $bindingChild.recovery_parent_job_id=$bindingOriginal.parent; $bindingChild.recovery_ancestor_job_ids=@($bindingOriginal.ancestors); $bindingChild.target_pdf_sha256=$bindingOriginal.hash; $bindingChild.target_file_name=$bindingOriginal.file; $bindingChild.target_page_count=$bindingOriginal.pages; $bindingChild.mask_seed=$bindingOriginal.seed; $bindingChild.recovery_metadata.target_pdf_sha256=$bindingOriginal.metadataHash; $bindingChild.recovery_metadata.mask_seed=$bindingOriginal.metadataSeed
    }
    Invoke-KoseiRetainedRecoverySweep -Settings @{} -JobsRoot $jobsRoot -UploadsRoot $chainUploads -AnswersDir $chainAnswers
    if (-not $script:KoseiJobs.ContainsKey($bindingRootId)) { throw 'active retry child did not protect expired ancestor' }
    $bindingChild.mode = 'done'; $bindingChild.result_retained = $true; $bindingChild.recovery_checkpoint_ready = $true; $bindingChild.terminal_at = (Get-Date).ToString('o'); $bindingChild.recovery_expires_at = (Get-Date).AddMinutes(30).ToString('o')
    Write-KoseiJobJournal -State $bindingChild -JobsRoot $chainJobs
    Invoke-KoseiRetainedRecoverySweep -Settings @{} -JobsRoot $chainJobs -UploadsRoot $chainUploads -AnswersDir $chainAnswers
    if ((Get-KoseiRecoveryExpiry -State $bindingRoot) -le (Get-Date)) { throw 'child terminal did not establish finite ancestor grace' }
    $bindingRoot.terminal_at = (Get-Date).AddMinutes(-31).ToString('o'); $bindingChild.terminal_at = (Get-Date).AddMinutes(-31).ToString('o')
    $bindingRoot.recovery_expires_at = (Get-Date).AddMinutes(-1).ToString('o'); $bindingChild.recovery_expires_at = (Get-Date).AddMinutes(-1).ToString('o')
    Invoke-KoseiRetainedRecoverySweep -Settings @{} -JobsRoot $chainJobs -UploadsRoot $chainUploads -AnswersDir $chainAnswers
    if ($script:KoseiJobs.ContainsKey($bindingRootId) -or $script:KoseiJobs.ContainsKey($bindingChildId)) { throw 'expired recovery chain was retained beyond descendant grace' }
    $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $null; $script:KoseiRecoverableJobId = $null
    $script:KoseiPendingRecovery = $null

    # Disk-backed startup regression: the newer running child is encountered
    # before its older retained parent, but Initialize must load the parent
    # first logically, expose the child snapshot, merge the retained result,
    # and permit one chain acknowledgement after the child reaches terminal.
    $diskRoot = Join-Path ([IO.Path]::GetTempPath()) ('kosei-disk-chain-' + [guid]::NewGuid().ToString('N'))
    $diskUploads = Join-Path $diskRoot 'uploads'; $diskAnswers = Join-Path $diskRoot 'answers'; $diskJobs = Join-Path $diskRoot 'jobs'
    try {
        New-Item -ItemType Directory -Path $diskUploads,$diskAnswers,$diskJobs -Force | Out-Null
        $diskChainId = [guid]::NewGuid().ToString('N'); $diskParentId = [guid]::NewGuid().ToString('N'); $diskChildId = [guid]::NewGuid().ToString('N')
        $diskHash = 'c' * 64; $diskParentUpload = Join-Path $diskUploads ('job-' + $diskParentId); $diskChildUpload = Join-Path $diskUploads ('job-' + $diskChildId)
        New-Item -ItemType Directory -Path $diskParentUpload,$diskChildUpload -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $diskChildUpload '.kosei-owner'), [string]$diskChildId, [Text.Encoding]::UTF8)
        $diskParentResult = Join-Path $diskAnswers ($diskParentId + '_done.checkpoint.json'); [IO.File]::WriteAllText($diskParentResult, '{"raw_answer":"parent-disk","passes":[]}', [Text.Encoding]::UTF8)
        $diskChildPrompt = Join-Path $diskChildUpload 'PROMPT_retry.txt'; $diskChildText = Join-Path $diskChildUpload 'TEXT_retry.txt'
        [IO.File]::WriteAllText($diskChildPrompt, 'retry prompt', [Text.Encoding]::UTF8); [IO.File]::WriteAllText($diskChildText, 'retry text', [Text.Encoding]::UTF8)
        $diskPacket = {
            param($Id,$Status,$ResultPath,$ResultSha,$PromptPath,$PromptSha,$TextPath,$TextSha)
            [pscustomobject]@{
                packet_id=$Id; status=$Status; error=''; prompt_path=$PromptPath; prompt_sha256=$PromptSha; text_path=$TextPath; text_sha256=$TextSha; pdf_path=''; pdf_sha256=''; result_path=$ResultPath; result_sha256=$ResultSha; kind='proofread'; has_ref=$false; profile=''; target_pages=@(1); stage_metadata_present=$false; stage_index=1; stage_order=1; stage_total=1; stage_id=''; stage_label=''; phase=''; completed_by='test'; detail=''; elapsed_ms=1; total_elapsed_ms=1; response_wait_ms=0; phase_timings=$null; started_at=''; completed_at=(Get-Date).ToString('o'); findings_count=0; pages_checked=@(1); coverage=1.0; warning=''; passes=@(); raw_answer=''
            }
        }
        $parentDiskPacket = & $diskPacket 'parent-packet' 'done' $diskParentResult (Get-KoseiFileSha256 $diskParentResult) '' '' '' ''
        $parentDiskPacket.raw_answer = 'parent-disk'
        $childDiskPacket = & $diskPacket 'child-packet' 'running' '' '' $diskChildPrompt (Get-KoseiFileSha256 $diskChildPrompt) $diskChildText (Get-KoseiFileSha256 $diskChildText)
        $makeDiskState = {
            param($Id,$Mode,$Packets,$Upload,$Parent)
            [hashtable]::Synchronized(@{
                id=$Id; mode=$Mode; phase=''; attach_mode='text'; packets_total=@($Packets).Count; packets_done=@($Packets | Where-Object { @('done','warning') -contains [string]$_.status }).Count; current_packet=''; current_packets=@(); current_stage_index=1; current_stage_total=1; current_stage_id=''; current_stage_label=''; stage_statuses=@(); needs_user_visibility=$false; error=''; cancel_requested=$false; journal_revision=0; created_at=(Get-Date).AddMinutes(-2).ToString('o'); updated_at=(Get-Date).ToString('o'); upload_dir=$Upload; target_file_name='target.pdf'; target_page_count=1; target_pdf_sha256=$diskHash; mask_seed=7; recovery_metadata=[ordered]@{schema='kosei-recovery-v1';target_pdf_sha256=$diskHash;mask_seed=7;packets=@()}; recovery_chain_id=$diskChainId; recovery_parent_job_id=$Parent; recovery_ancestor_job_ids=$(if($Parent){@($Parent)}else{@()}); declared_stage_total=1; terminal_at=(Get-Date).ToString('o'); recovery_expires_at=(Get-Date).AddMinutes(30).ToString('o'); recovery_acknowledged=$false; result_retained=($Mode -eq 'done'); recovery_checkpoint_ready=($Mode -eq 'done'); per_packet=@($Packets)
            })
        }
        $diskParent = & $makeDiskState $diskParentId 'done' @($parentDiskPacket) $diskParentUpload ''
        $diskChild = & $makeDiskState $diskChildId 'running' @($childDiskPacket) $diskChildUpload $diskParentId
        Write-KoseiJobJournal -State $diskParent -JobsRoot $diskJobs
        Start-Sleep -Milliseconds 20
        Write-KoseiJobJournal -State $diskChild -JobsRoot $diskJobs
        $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $null; $script:KoseiRecoverableJobId = $null; $script:KoseiPendingRecovery = $null
        $diskPending = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $diskJobs -UploadsRoot $diskUploads -AnswersDir $diskAnswers
        if ($null -eq $diskPending -or [string]$diskPending.id -ne $diskChildId -or -not $script:KoseiJobs.ContainsKey($diskParentId)) { throw 'disk startup did not load parent before retry child resume' }
        $diskMerged = Get-KoseiRecoveryChainResultObject -State $diskPending
        if (@($diskMerged.packets | Where-Object { [string]$_.packet_id -eq 'parent-packet' }).Count -ne 1) { throw 'disk startup merged result lost retained parent packet' }
        $diskChildResult = Join-Path $diskAnswers ($diskChildId + '_done.checkpoint.json'); [IO.File]::WriteAllText($diskChildResult, '{"raw_answer":"child-disk","passes":[]}', [Text.Encoding]::UTF8)
        $diskPending.per_packet[0].status='done'; $diskPending.per_packet[0].result_path=$diskChildResult; $diskPending.per_packet[0].result_sha256=Get-KoseiFileSha256 $diskChildResult; $diskPending.per_packet[0] | Add-Member -NotePropertyName raw_answer -NotePropertyValue 'child-disk' -Force; $diskPending.per_packet[0].completed_at=(Get-Date).ToString('o')
        $diskPending.mode='done'; $diskPending.result_retained=$true; $diskPending.recovery_checkpoint_ready=$true; $diskPending.terminal_at=(Get-Date).ToString('o'); $diskPending.recovery_expires_at=(Get-Date).AddMinutes(30).ToString('o'); $script:KoseiJobs[$diskChildId]=$diskPending; $script:KoseiPendingRecovery=$null
        $diskMergedDone = Get-KoseiRecoveryChainResultObject -State $diskPending
        if (@($diskMergedDone.packets | Where-Object { [string]$_.packet_id -eq 'parent-packet' }).Count -ne 1 -or @($diskMergedDone.packets | Where-Object { [string]$_.packet_id -eq 'child-packet' }).Count -ne 1) { throw 'disk startup terminal merge lost parent or child result' }
        if (-not (Acknowledge-KoseiJobResult -JobId $diskChildId -ChainId $diskChainId -JobsRoot $diskJobs -UploadsRoot $diskUploads -AnswersDir $diskAnswers)) { throw 'disk startup chain ACK failed' }
        if ((Test-Path (Get-KoseiJobJournalPath -JobId $diskParentId -JobsRoot $diskJobs)) -or (Test-Path (Get-KoseiJobJournalPath -JobId $diskChildId -JobsRoot $diskJobs))) { throw 'disk startup chain ACK left old journals' }
        $badDiskId = [guid]::NewGuid().ToString('N'); $badParentId = [guid]::NewGuid().ToString('N')
        New-Item -ItemType Directory -Path $diskChildUpload -Force | Out-Null
        [IO.File]::WriteAllText($diskChildPrompt, 'bad retry prompt', [Text.Encoding]::UTF8); [IO.File]::WriteAllText($diskChildText, 'bad retry text', [Text.Encoding]::UTF8)
        $badPacket = & $diskPacket 'bad-packet' 'running' '' '' $diskChildPrompt (Get-KoseiFileSha256 $diskChildPrompt) $diskChildText (Get-KoseiFileSha256 $diskChildText)
        $badDisk = & $makeDiskState $badDiskId 'running' @($badPacket) $diskChildUpload $badParentId
        [IO.File]::WriteAllText((Join-Path $diskChildUpload '.kosei-owner'), [string]$badDiskId, [Text.Encoding]::UTF8)
        $badDisk.recovery_ancestor_job_ids=@($badParentId); Write-KoseiJobJournal -State $badDisk -JobsRoot $diskJobs
        $script:KoseiJobs.Clear(); $script:KoseiPendingRecovery = $null
        $null = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $diskJobs -UploadsRoot $diskUploads -AnswersDir $diskAnswers
        if (Test-Path (Get-KoseiJobJournalPath -JobId $badDiskId -JobsRoot $diskJobs)) { throw 'malformed disk chain journal was retained' }

        # Both running children are on disk while the shared job table starts
        # empty.  Startup must validate the complete pending+retained topology
        # before selecting one child; an active-active sibling branch is not a
        # resumable chain and every bounded journal/input is removed.
        $diskChainId = [guid]::NewGuid().ToString('N')
        $branchParentId = [guid]::NewGuid().ToString('N'); $branchChildAId = [guid]::NewGuid().ToString('N'); $branchChildBId = [guid]::NewGuid().ToString('N')
        $branchParentUpload = Join-Path $diskUploads ('job-' + $branchParentId); $branchUploadA = Join-Path $diskUploads ('job-' + $branchChildAId); $branchUploadB = Join-Path $diskUploads ('job-' + $branchChildBId)
        # A tampered terminal parent points at another chain's valid upload
        # directory.  Branch cleanup must remove only the bounded journals and
        # checkpoints; the foreign sentinel must survive.
        $foreignUploadId = [guid]::NewGuid().ToString('N')
        $foreignUpload = Join-Path $diskUploads ('job-' + $foreignUploadId)
        New-Item -ItemType Directory -Path $branchUploadA,$branchUploadB,$foreignUpload -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $branchUploadA '.kosei-owner'), [string]$branchChildAId, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText((Join-Path $branchUploadB '.kosei-owner'), [string]$branchChildBId, [Text.Encoding]::UTF8)
        $foreignSentinel = Join-Path $foreignUpload 'foreign-chain-sentinel.txt'
        [IO.File]::WriteAllText($foreignSentinel, 'must-survive', [Text.Encoding]::UTF8)
        $branchParentResult = Join-Path $diskAnswers ($branchParentId + '_done.checkpoint.json'); [IO.File]::WriteAllText($branchParentResult, '{"raw_answer":"branch-parent","passes":[]}', [Text.Encoding]::UTF8)
        $branchPromptA = Join-Path $branchUploadA 'PROMPT_A.txt'; $branchTextA = Join-Path $branchUploadA 'TEXT_A.txt'
        $branchPromptB = Join-Path $branchUploadB 'PROMPT_B.txt'; $branchTextB = Join-Path $branchUploadB 'TEXT_B.txt'
        [IO.File]::WriteAllText($branchPromptA, 'branch A prompt', [Text.Encoding]::UTF8); [IO.File]::WriteAllText($branchTextA, 'branch A text', [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText($branchPromptB, 'branch B prompt', [Text.Encoding]::UTF8); [IO.File]::WriteAllText($branchTextB, 'branch B text', [Text.Encoding]::UTF8)
        $branchParentPacket = & $diskPacket 'branch-parent-packet' 'done' $branchParentResult (Get-KoseiFileSha256 $branchParentResult) '' '' '' ''
        $branchParentPacket.raw_answer = 'branch-parent'
        $branchPacketA = & $diskPacket 'branch-child-a' 'running' '' '' $branchPromptA (Get-KoseiFileSha256 $branchPromptA) $branchTextA (Get-KoseiFileSha256 $branchTextA)
        $branchPacketB = & $diskPacket 'branch-child-b' 'running' '' '' $branchPromptB (Get-KoseiFileSha256 $branchPromptB) $branchTextB (Get-KoseiFileSha256 $branchTextB)
        $branchParent = & $makeDiskState $branchParentId 'done' @($branchParentPacket) $foreignUpload ''
        $branchChildA = & $makeDiskState $branchChildAId 'running' @($branchPacketA) $branchUploadA $branchParentId
        $branchChildB = & $makeDiskState $branchChildBId 'running' @($branchPacketB) $branchUploadB $branchParentId
        # Reverse sibling write order to ensure journal age/filename ordering
        # cannot accidentally select the first child as the recovery anchor.
        Write-KoseiJobJournal -State $branchParent -JobsRoot $diskJobs
        Start-Sleep -Milliseconds 20
        Write-KoseiJobJournal -State $branchChildB -JobsRoot $diskJobs
        Start-Sleep -Milliseconds 20
        Write-KoseiJobJournal -State $branchChildA -JobsRoot $diskJobs
        $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $null; $script:KoseiRecoverableJobId = $null; $script:KoseiPendingRecovery = $null
        $branchPending = Initialize-KoseiJobRecovery -Settings @{} -JobsRoot $diskJobs -UploadsRoot $diskUploads -AnswersDir $diskAnswers
        if ($null -ne $branchPending -or $script:KoseiPendingRecovery) { throw 'startup resumed one child from a disk-backed sibling branch' }
        foreach ($branchId in @($branchParentId,$branchChildAId,$branchChildBId)) {
            if (Test-Path (Get-KoseiJobJournalPath -JobId $branchId -JobsRoot $diskJobs)) { throw "disk branch journal survived fail-closed cleanup: $branchId" }
        }
        foreach ($branchUpload in @($branchUploadA,$branchUploadB)) {
            if (Test-Path $branchUpload) { throw 'disk branch input survived fail-closed cleanup' }
        }
        if (-not (Test-Path $foreignSentinel -PathType Leaf)) { throw 'branch cleanup deleted a foreign-chain upload sentinel' }
    } finally {
        $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $null; $script:KoseiRecoverableJobId = $null; $script:KoseiPendingRecovery = $null
        if (Test-Path $diskRoot) { Remove-Item -LiteralPath $diskRoot -Recurse -Force }
    }

    # A close while a job is active, and then while its terminal result is
    # retained after import failure, must use the recovery lease.  Once the
    # result is acknowledged, the ordinary ten-second close grace returns.
    $lifecycleId = [guid]::NewGuid().ToString('N')
    $lifecycleState = [hashtable]::Synchronized(@{
        id=$lifecycleId; mode='running'; result_retained=$false; recovery_acknowledged=$false
        recovery_expires_at=(Get-Date).AddMinutes(30).ToString('o'); terminal_at=''; updated_at=(Get-Date).ToString('o')
        cancel_requested=$false; per_packet=@()
    })
    $script:KoseiJobs.Clear(); $script:KoseiActiveJobId = $lifecycleId; $script:KoseiJobs[$lifecycleId] = $lifecycleState
    $lifecycleServerState = @{
        HasBrowserHeartbeat=$false; LastHeartbeat=(Get-Date); CloseAt=$null; CloseRequested=$false
        DeferredClose=$false; DeferredCloseAt=$null; ShouldStop=$false; StartedAt=(Get-Date)
    }
    $pageClosedContext = [pscustomobject]@{
        Request=[pscustomobject]@{ HttpMethod='POST'; Url=[uri]'http://127.0.0.1/__page-closed' }
        Response=[pscustomobject]@{}
    }
    Invoke-KoseiRoute -Context $pageClosedContext -Settings @{} -ServerState $lifecycleServerState
    if (-not $lifecycleServerState.DeferredClose -or $null -ne $lifecycleServerState.CloseAt) {
        throw 'active job close did not defer shutdown'
    }
    $lifecycleState.mode = 'done'; $lifecycleState.result_retained = $true
    $lifecycleServerState.CloseRequested = $false; $lifecycleServerState.DeferredClose = $false; $lifecycleServerState.DeferredCloseAt = $null
    Invoke-KoseiRoute -Context $pageClosedContext -Settings @{} -ServerState $lifecycleServerState
    if (-not $lifecycleServerState.DeferredClose -or $null -ne $lifecycleServerState.CloseAt) {
        throw 'terminal import-failure close did not retain the recovery lease'
    }
    # A later heartbeat is the explicit signal that another tab remains alive;
    # it clears the deferred close request before the finite lease is used.
    $heartbeatContext = [pscustomobject]@{
        Request=[pscustomobject]@{ HttpMethod='GET'; Url=[uri]'http://127.0.0.1/__heartbeat' }
        Response=[pscustomobject]@{}
    }
    Invoke-KoseiRoute -Context $heartbeatContext -Settings @{} -ServerState $lifecycleServerState
    if ($lifecycleServerState.DeferredClose -or $lifecycleServerState.CloseRequested) {
        throw 'heartbeat did not clear deferred close'
    }
    $lifecycleState.result_retained = $false; $lifecycleServerState.CloseRequested = $false
    Invoke-KoseiRoute -Context $pageClosedContext -Settings @{} -ServerState $lifecycleServerState
    if ($lifecycleServerState.DeferredClose -or $null -eq $lifecycleServerState.CloseAt) {
        throw 'acknowledged result did not return to the finite close grace'
    }

    # Cancellation is synchronously journaled so a crash cannot resurrect the job.
    $cancelState = [hashtable]::Synchronized(@{id=[guid]::NewGuid().ToString('N');mode='running';cancel_requested=$false;updated_at='';per_packet=@();journal_revision=0})
    $script:KoseiJobs[$cancelState.id] = $cancelState
    Stop-KoseiJob -JobId $cancelState.id -JobsRoot $jobsRoot | Out-Null
    $cancelJournal = [IO.File]::ReadAllText((Get-KoseiJobJournalPath -JobId $cancelState.id -JobsRoot $jobsRoot), [Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not [bool]$cancelJournal.state.cancel_requested) { throw 'cancel request was not persisted' }
} finally {
    if (Test-Path $jobsRoot) { Remove-Item -LiteralPath $jobsRoot -Recurse -Force }
}

'Test-JobRecovery: PASS'
