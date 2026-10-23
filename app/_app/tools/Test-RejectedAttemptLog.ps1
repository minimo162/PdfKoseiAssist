$ErrorActionPreference = 'Stop'
# やり直しで通ったときも、受け付けなかった回答を runtime\answers に残す。
# 実機（2026-10-23）で packet_id が空の回答を3回受け付けなかったのに、やり直しで通ったため
# Copilot が何を書いたかがどこにも残っていなかった。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Paths.ps1'); Set-KoseiRoot $root
. (Join-Path $root 'src\CopilotClient.ps1')
. (Join-Path $root 'src\ReviewJob.ps1')
function Write-KoseiLog { param($Message, $Level) }
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('kosei-rejected-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($temp)
try {
    $answers = Join-Path $temp 'answers'; $null = [IO.Directory]::CreateDirectory($answers)
    $promptPath = Join-Path $temp 'PROMPT_SEC_001.txt'; [IO.File]::WriteAllText($promptPath, 'prompt')
    $textPath = Join-Path $temp 'TEXT_SEC_001.txt'; [IO.File]::WriteAllText($textPath, 'text')
    $packet = [hashtable]::Synchronized(@{
        packet_id='SEC_001_GAP_R2'; target_pages=@(1,2,3,4); prompt_path=$promptPath; prompt_sha256=(Get-KoseiFileSha256 -Path $promptPath)
        text_path=$textPath; text_sha256=(Get-KoseiFileSha256 -Path $textPath); pdf_path=''; pdf_sha256=''
        status='running'; phase=''; detail=''; raw_answer=''; completed_by=''; elapsed_ms=0; total_elapsed_ms=0; phase_timings=$null; response_wait_ms=0
        findings_count=0; pages_checked=@(); coverage=0.0; warning=''; verification_state=''; error=''
    })
    $state = [hashtable]::Synchronized(@{ id='0123456789abcdef0123456789abcdef'; attach_mode='masked-text'; phase=''; updated_at=''; cancel_requested=$false; packets_done=0 })
    $settings = [pscustomobject]@{ response_end_marker='KOSEI_END' }
    $script:requests = 0
    function Invoke-KoseiCopilotReviewRequest {
        param($Settings, $Prompt, $AttachPaths, $ChatMode, $OnPhase, $ShouldCancel, $OnWaitProgress, $ExpectedPages, $ExpectedPacketId, $Page, $Marker)
        $script:requests++; $script:lastPrompt = [string]$Prompt
        if ($script:requests -eq 1) {
            return [pscustomobject]@{ ok=$false; completedBy='incomplete-json'; json=$null; rawJson='{"packet_id":"","findings":[]} KOSEI_END'; elapsedMs=1; pagesChecked=@(); coverage=0; fixes=@(); warning='有効な回答JSONを復元できませんでした。' }
        }
        $json = '{"packet_id":"SEC_001_GAP_R2","findings":[],"checked_pages":[1,2,3,4],"checked_pages_all":true}'
        return [pscustomobject]@{ ok=$true; completedBy='marker'; json=$json; rawJson=($json + ' KOSEI_END'); elapsedMs=1; pagesChecked=@(1,2,3,4); coverage=1.0; fixes=@(); findingsCount=0; warning='' }
    }
    $null = Invoke-KoseiPacket -Packet $packet -State $state -Settings $settings -ReviewFlags ([pscustomobject]@{}) -AnswersDir $answers -PacketIndex 1
    if ($script:requests -ne 2) { throw "expected one retry, got $($script:requests) requests" }
    # 回答の形はチャット欄にも書く（Copilot が添付内の指示に従わないことがある。実機 2026-10-23）。
    if ($script:lastPrompt -notlike '*"packet_id":"SEC_001_GAP_R2"*' -or $script:lastPrompt -notlike '*"findings":`[{"page":*' -or $script:lastPrompt -notlike '*KOSEI_END*') { throw ('chat message lacks the answer format: ' + $script:lastPrompt) }
    $base = Join-Path $answers ($state.id + '_SEC_001_GAP_R2_try1')
    if (-not (Test-Path -LiteralPath ($base + '.rejected.raw.txt'))) { throw 'rejected raw answer was not saved' }
    if ([IO.File]::ReadAllText($base + '.rejected.raw.txt') -notmatch '"packet_id":""') { throw 'rejected raw answer has wrong content' }
    $meta = [IO.File]::ReadAllText($base + '.rejected.json') | ConvertFrom-Json
    if ($meta.completed_by -ne 'incomplete-json' -or $meta.reason -ne 'incomplete-json') { throw ('rejected metadata: ' + ($meta | ConvertTo-Json -Compress)) }
    if (Test-Path -LiteralPath (Join-Path $answers ($state.id + '_SEC_001_GAP_R2_try2.rejected.raw.txt'))) { throw 'accepted answer was saved as rejected' }
    Write-Host 'Test-RejectedAttemptLog: PASS'
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^kosei-rejected-[0-9a-f]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
