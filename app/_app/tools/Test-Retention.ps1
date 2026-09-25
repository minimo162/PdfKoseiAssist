$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\ReviewJob.ps1')

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('kosei-retention-test-' + [guid]::NewGuid().ToString('N'))
$uploads = Join-Path $base 'uploads'
$answers = Join-Path $base 'answers'
$jobs = Join-Path $base 'jobs'
New-Item -ItemType Directory -Path $uploads,$answers,$jobs -Force | Out-Null
try {
    foreach ($mode in @('done','error','cancelled')) {
        $id = [guid]::NewGuid().ToString('N')
        $jobDir = Join-Path $uploads ('job-' + $id)
        New-Item -ItemType Directory -Path $jobDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $jobDir 'TEXT.txt') -Value 'secret'
        foreach ($ext in @('json','raw.txt','salvage.txt','diagnostics.json')) {
            Set-Content -LiteralPath (Join-Path $answers ($id + '_p1.' + $ext)) -Value 'secret'
        }
        $state = [pscustomobject]@{ id=$id; mode=$mode; upload_dir=$jobDir }
        Remove-KoseiCompletedJobArtifacts -State $state -Settings ([pscustomobject]@{diagnostic_retention_days=0}) -UploadsRoot $uploads -AnswersDir $answers -JobsRoot $jobs
        if (Test-Path -LiteralPath $jobDir) { throw "$mode upload remains" }
        if (@(Get-ChildItem -LiteralPath $answers -Filter ($id + '_*') -File).Count) { throw "$mode diagnostics remain" }
    }

    $active = Join-Path $uploads 'job-active'
    $old = Join-Path $uploads 'job-old'
    New-Item -ItemType Directory -Path $active,$old -Force | Out-Null
    (Get-Item -LiteralPath $active).LastWriteTime = (Get-Date).AddDays(-2)
    (Get-Item -LiteralPath $old).LastWriteTime = (Get-Date).AddDays(-2)
    $oldRaw = Join-Path $answers 'old.raw.txt'; Set-Content $oldRaw 'old'; (Get-Item $oldRaw).LastWriteTime=(Get-Date).AddDays(-3)
    $freshRaw = Join-Path $answers 'fresh.salvage.txt'; Set-Content $freshRaw 'fresh'
    $activeJob = Join-Path $jobs 'active-job'; $oldJob = Join-Path $jobs 'old-job'
    $activeCheckpoint = Join-Path $answers 'active-job_p1.checkpoint.json'
    Set-Content $activeCheckpoint 'checkpoint'; (Get-Item $activeCheckpoint).LastWriteTime=(Get-Date).AddDays(-4)
    New-Item -ItemType Directory -Path $activeJob,$oldJob -Force | Out-Null
    Set-Content (Join-Path $activeJob 'state.json') '{}'; Set-Content (Join-Path $oldJob 'state.json') '{}'
    Set-Content (Join-Path $oldJob 'stale.tmp') 'temporary'; Set-Content (Join-Path $oldJob 'stale.bak') 'backup'
    (Get-Item $activeJob).LastWriteTime=(Get-Date).AddDays(-4); (Get-Item $oldJob).LastWriteTime=(Get-Date).AddDays(-4)
    Get-ChildItem $oldJob -File | ForEach-Object { $_.LastWriteTime=(Get-Date).AddDays(-4) }
    $oldDrop = Join-Path (Join-Path $base 'drop') ('a' * 32)
    $freshDrop = Join-Path (Join-Path $base 'drop') ('b' * 32)
    New-Item -ItemType Directory -Path $oldDrop,$freshDrop -Force | Out-Null
    (Get-Item -LiteralPath $oldDrop).LastWriteTime = (Get-Date).AddDays(-3)
    Invoke-KoseiRetentionSweep -Settings ([pscustomobject]@{diagnostic_retention_days=2}) -ActiveUploadDir $active -ActiveJobId 'active-job' -UploadsRoot $uploads -AnswersDir $answers -JobsRoot $jobs
    if (Test-Path -LiteralPath $oldDrop) { throw 'stale drop remains' }
    if (!(Test-Path -LiteralPath $freshDrop)) { throw 'fresh drop was removed' }
    if (-not (Test-Path $active)) { throw 'active upload was removed' }
    if (Test-Path $old) { throw 'stale upload remains' }
    if (Test-Path $oldRaw) { throw 'stale raw remains' }
    if (-not (Test-Path $freshRaw)) { throw 'fresh diagnostic was removed' }
    if (-not (Test-Path $activeJob)) { throw 'active journal was removed' }
    if (-not (Test-Path $activeCheckpoint)) { throw 'active checkpoint was removed' }
    if (Test-Path $oldJob) { throw 'stale journal remains' }

    $completedCheckpoint = Join-Path $answers 'completed_p1.checkpoint.json'; Set-Content $completedCheckpoint 'checkpoint'
    Remove-KoseiCompletedJobArtifacts -State ([pscustomobject]@{id='completed';upload_dir=''}) -Settings ([pscustomobject]@{diagnostic_retention_days=7}) -UploadsRoot $uploads -AnswersDir $answers -JobsRoot $jobs
    if (Test-Path $completedCheckpoint) { throw 'completed checkpoint remains when diagnostics are retained' }

    # #183: 終了時の入力削除の後、受領(ack)で同じジョブの後始末が再度走っても
    # 所有権の警告を出さない。本当に所有権が不明な入力は従来どおり削除せず警告する。
    $script:retentionLog = New-Object System.Collections.Generic.List[string]
    function Write-KoseiLog { param($Message, $Level) $script:retentionLog.Add(([string]$Level + ' ' + [string]$Message)) }
    $ackId = [guid]::NewGuid().ToString('N')
    $ackDir = Join-Path $uploads ('job-' + $ackId)
    New-Item -ItemType Directory -Path $ackDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $ackDir 'TEXT.txt') -Value 'secret'
    $ackState = [pscustomobject]@{ id=$ackId; mode='done'; upload_dir=$ackDir }
    Remove-KoseiJobInputArtifacts -State $ackState -UploadsRoot $uploads
    if (Test-Path -LiteralPath $ackDir) { throw 'terminal input cleanup did not remove the upload' }
    Remove-KoseiRetainedJobArtifacts -State $ackState -Settings $null -UploadsRoot $uploads -AnswersDir $answers -JobsRoot $jobs
    Remove-KoseiCompletedJobArtifacts -State $ackState -Settings ([pscustomobject]@{diagnostic_retention_days=7}) -UploadsRoot $uploads -AnswersDir $answers -JobsRoot $jobs
    if (@($script:retentionLog | Where-Object { $_ -like '*INFO*ジョブ入力を削除しました*' }).Count -ne 1) { throw 'upload deletion was not logged exactly once' }
    if (@($script:retentionLog | Where-Object { $_ -like 'WARN *' }).Count) { throw ('already-deleted input produced a warning: ' + ($script:retentionLog -join ' | ')) }

    $script:retentionLog.Clear()
    $foreignId = [guid]::NewGuid().ToString('N')
    $foreignDir = Join-Path $uploads ('job-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $foreignDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $foreignDir 'TEXT.txt') -Value 'other job'
    $foreignState = [pscustomobject]@{ id=$foreignId; mode='done'; upload_dir=$foreignDir }
    Remove-KoseiJobInputArtifacts -State $foreignState -UploadsRoot $uploads
    Remove-KoseiCompletedJobArtifacts -State $foreignState -Settings ([pscustomobject]@{diagnostic_retention_days=7}) -UploadsRoot $uploads -AnswersDir $answers -JobsRoot $jobs
    if (-not (Test-Path -LiteralPath (Join-Path $foreignDir 'TEXT.txt'))) { throw 'upload without confirmed ownership was deleted' }
    if (@($script:retentionLog | Where-Object { $_ -like 'WARN *所有権を確認できないため削除しません*' }).Count -ne 2) { throw ('ownership warning missing: ' + ($script:retentionLog -join ' | ')) }
    Remove-Item -Path Function:\Write-KoseiLog
    'Test-Retention: PASS'
} finally {
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
}
