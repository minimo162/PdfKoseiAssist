$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Write-KoseiLog { param($Message, $Level) }
. (Join-Path $root 'src\ReviewJob.ps1')

# One worker may hang permanently; preserve a healthy result and terminate the stale worker.
$healthyPacket = [pscustomobject]@{ packet_id = 'ok'; status = 'done'; error = ''; completed_at = '' }
$hungPacket = [pscustomobject]@{ packet_id = 'hang'; status = 'running'; error = ''; completed_at = '' }
$packets = @($healthyPacket, $hungPacket)
$state = [pscustomobject]@{
    id = [guid]::NewGuid().ToString('N')
    cancel_requested = $false
    per_packet = $packets
}
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
$blockedState = [pscustomobject]@{ id=[guid]::NewGuid().ToString('N'); cancel_requested=$false; per_packet=@($blockedPacket) }
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
    $fencedState = [pscustomobject]@{id=[guid]::NewGuid().ToString('N');cancel_requested=$false;per_packet=@([pscustomobject]@{packet_id='late';status='running';error='';completed_at=''})}
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

    # Startup recovery preserves completed packets and queues only unfinished work.
    $uploadsRoot = Join-Path $jobsRoot 'uploads'
    $answersRoot = Join-Path $jobsRoot 'answers'
    $uploadDir = Join-Path $uploadsRoot ('job-' + $journalState.id)
    New-Item -ItemType Directory -Path $uploadDir,$answersRoot -Force | Out-Null
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
