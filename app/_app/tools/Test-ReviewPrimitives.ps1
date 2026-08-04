# Test-ReviewPrimitives.ps1
#
# ライブ Copilot / CDP を必要としない PowerShell 純関数のユニットテスト。
# 実機（PS 5.1）で決定的に走り、node 側の spec（tools/Test-*.mjs）と相互検証する。
#
# 実行:
#   Windows PowerShell 5.1:  powershell -ExecutionPolicy Bypass -File tools\Test-ReviewPrimitives.ps1
#   PowerShell 7+:           pwsh -File tools/Test-ReviewPrimitives.ps1
#
# 期待 SHA-256 は node（crypto）で算出した値を埋め込み、PS 実装と突き合わせる。

$ErrorActionPreference = 'Stop'
$srcDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
. (Join-Path $srcDir 'Paths.ps1')
. (Join-Path $srcDir 'Settings.ps1')
. (Join-Path $srcDir 'CopilotClient.ps1')
. (Join-Path $srcDir 'ReviewJob.ps1')
. (Join-Path $srcDir 'Server.ps1')

$script:fail = 0
function Assert-True {
    param([string]$Name, [bool]$Cond)
    if ($Cond) {
        Write-Host "  ok   $Name" -ForegroundColor Green
    } else {
        Write-Host "  FAIL $Name" -ForegroundColor Red
        $script:fail++
    }
}
function Assert-Eq {
    param([string]$Name, $Expected, $Actual)
    Assert-True $Name ([string]$Expected -eq [string]$Actual)
    if ([string]$Expected -ne [string]$Actual) {
        Write-Host "        expected=$Expected actual=$Actual" -ForegroundColor DarkYellow
    }
}
function Assert-Throws {
    param([string]$Name, [scriptblock]$Block)
    $threw = $false
    try { & $Block } catch { $threw = $true }
    Assert-True $Name $threw
}

Write-Host '[Get-KoseiAssistantTailHash] node spec と一致'
Assert-Eq 'sha256("hello world")' 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' (Get-KoseiAssistantTailHash -Text 'hello world')
# 制御文字（NUL）除去後 "ab<TAB>c<LF>d" の sha256
$ctrl = 'ab' + [char]9 + 'c' + [char]0 + [char]10 + 'd'
Assert-Eq 'ctrl除去後の sha256' '3361514ded8e40cf6b870be6ce7ff900eb5580b2d0715661e9020aec749f8afe' (Get-KoseiAssistantTailHash -Text $ctrl)
Assert-Eq '空文字は空hash' '' (Get-KoseiAssistantTailHash -Text '')
Assert-True '決定的（同一入力→同一hash）' ((Get-KoseiAssistantTailHash -Text 'abc') -eq (Get-KoseiAssistantTailHash -Text 'abc'))
Assert-True '差分入力で変化' ((Get-KoseiAssistantTailHash -Text 'abc') -ne (Get-KoseiAssistantTailHash -Text 'abd'))

Write-Host '[Test-KoseiTurnMarkerBoundary] 末尾トークン判定'
$MK = 'KOSEI_END_ab12_3_1_9f8e7d6c'
Assert-True 'valid JSON + marker行 → true' (Test-KoseiTurnMarkerBoundary -Text ('{"findings":[]}' + "`n" + $MK + "`n") -Marker $MK)
Assert-True '同一行 "} MARKER" → true' (Test-KoseiTurnMarkerBoundary -Text ('{"packet_id":"smoke","findings":[]} ' + $MK) -Marker $MK)
Assert-True 'JSON内部の部分一致 → false' (-not (Test-KoseiTurnMarkerBoundary -Text ('{"reason":"末尾に ' + $MK + ' と書く"}') -Marker $MK))
Assert-True 'marker後に非空 → false' (-not (Test-KoseiTurnMarkerBoundary -Text ('{"findings":[]}' + "`n" + $MK + "`n余計な後書き") -Marker $MK))
Assert-True '英字直後のmarker → false' (-not (Test-KoseiTurnMarkerBoundary -Text ('{"findings":[]}' + "`n" + 'X' + $MK) -Marker $MK))
Assert-True '別turnマーカー → false' (-not (Test-KoseiTurnMarkerBoundary -Text ('{"findings":[]}' + "`n" + 'KOSEI_END_ab12_3_2_00112233') -Marker $MK))

Write-Host '[Get-KoseiPassSchedule] node spec と一致'
$q = Get-KoseiPassSchedule -Profile 'quick' -GapPass $false
Assert-Eq 'quick(gap off)' 'broad' (@($q.passes | ForEach-Object { $_.lens }) -join ',')
$qg = Get-KoseiPassSchedule -Profile 'quick' -GapPass $true
Assert-Eq 'quick(gap on)' 'broad,gap' (@($qg.passes | ForEach-Object { $_.lens }) -join ',')
$s = Get-KoseiPassSchedule -Profile 'standard' -GapPass $true
Assert-Eq 'standard' 'broad,numbers,names,gap' (@($s.passes | ForEach-Object { $_.lens }) -join ',')
Assert-Eq '1pass目 New+attach' 'New/True' ("$($s.passes[0].chat_mode)/$($s.passes[0].attach)")
Assert-Eq '2pass目 Reuse+no attach' 'Reuse/False' ("$($s.passes[1].chat_mode)/$($s.passes[1].attach)")
$tn = Get-KoseiPassSchedule -Profile 'thorough' -HasRef $false -GapPass $true -MaxPasses 20
Assert-True 'thorough(no REF)は translation 無し' (-not (@($tn.passes | ForEach-Object { $_.lens }) -contains 'translation'))
Assert-True 'skipped に translation:no-ref' (@($tn.skipped | Where-Object { $_.lens -eq 'translation' -and $_.reason -eq 'no-ref' }).Count -ge 1)
$cap = Get-KoseiPassSchedule -Profile 'thorough' -HasRef $true -GapPass $true -MaxPasses 4
Assert-Eq 'max=4で4pass' 4 $cap.passes.Count
Assert-True '超過分 skipped' (@($cap.skipped | Where-Object { $_.reason -eq 'max-passes-exceeded' }).Count -ge 1)
$unk = Get-KoseiPassSchedule -Profile 'bogus' -GapPass $false
Assert-Eq '未知profileは quick' 'broad' (@($unk.passes | ForEach-Object { $_.lens }) -join ',')
# 期待値は js/pass-schedule.mjs（Test-PassSchedule.mjs で検証済み）から写したもの。PS/JS の乖離検知用。
$cons = Get-KoseiPassSchedule -Profile 'consistency' -HasRef $true -GapPass $true -MaxPasses 8
Assert-Eq 'consistency(REF)' 'broad,wording,ellipsis,gap' (@($cons.passes | ForEach-Object { $_.lens }) -join ',')
$consNoRef = Get-KoseiPassSchedule -Profile 'consistency' -HasRef $false -GapPass $true -MaxPasses 8
Assert-Eq 'consistency(REFなし)' 'broad,wording,gap' (@($consNoRef.passes | ForEach-Object { $_.lens }) -join ',')
Assert-True 'skipped に ellipsis:no-ref' (@($consNoRef.skipped | Where-Object { $_.lens -eq 'ellipsis' -and $_.reason -eq 'no-ref' }).Count -ge 1)
$tho = Get-KoseiPassSchedule -Profile 'thorough' -HasRef $true -GapPass $true -MaxPasses 99
Assert-Eq 'thorough(REF)' 'broad,translation,numbers,names,wording,ellipsis,spelling,grammar,structure,gap' (@($tho.passes | ForEach-Object { $_.lens }) -join ',')
Assert-Eq '上限超過でも gap を残す' 'broad,translation,numbers,gap' (@($cap.passes | ForEach-Object { $_.lens }) -join ',')
Assert-True '新観点の定義がある' (($script:KoseiReviewLenses.ContainsKey('wording')) -and ($script:KoseiReviewLenses.ContainsKey('ellipsis')))

Write-Host '[New-KoseiLensFollowupPrompt] 観点追撃文'
$fpNoRef = New-KoseiLensFollowupPrompt -Lens 'wording' -PageRange '1,2,3' -Marker 'KOSEI_END_x' -HasRef $false
Assert-True '観点ラベルが入る' ($fpNoRef -like '*訳語の揺れ*')
Assert-True 'マーカーが入る' ($fpNoRef -like '*KOSEI_END_x*')
Assert-True 'REFなしでREF行を出さない' (-not ($fpNoRef -like '*REFERENCE（日本語原文）*'))
$fpRef = New-KoseiLensFollowupPrompt -Lens 'ellipsis' -PageRange '1,2,3' -Marker 'KOSEI_END_x' -HasRef $true
Assert-True 'REFありでREF行を出す' ($fpRef -like '*REFERENCE（日本語原文）*')

Write-Host '[New-KoseiTurnMarker] 書式'
$m = New-KoseiTurnMarker -JobId ([guid]::NewGuid().ToString('N')) -PacketIndex 3 -TurnIndex 2
Assert-True 'KOSEI_END_<job8>_3_2_<rand8> 形式' ($m -match '^KOSEI_END_[0-9a-f]{8}_3_2_[0-9a-f]{8}$')

Write-Host '[Get-KoseiValidatedReviewFlags] allowlist'
$bad = [pscustomobject]@{ review_engine='bogus'; review_prompt_version='v94'; review_profile_batch='quick'; review_profile_single='standard'; review_gap_pass=$true; review_page_checks=$true; review_cross_document_context=$false }
Assert-Eq '未知 review_engine → legacy' 'legacy' (Get-KoseiValidatedReviewFlags -Settings $bad).review_engine
$good = [pscustomobject]@{ review_engine='multipass'; review_prompt_version='v94'; review_profile_batch='quick'; review_profile_single='standard'; review_gap_pass='true'; review_page_checks=$false; review_cross_document_context=$false }
Assert-Eq '既知 review_engine → multipass' 'multipass' (Get-KoseiValidatedReviewFlags -Settings $good).review_engine
Assert-Eq 'bool文字列 "true" → $true' 'True' (Get-KoseiValidatedReviewFlags -Settings $good).review_gap_pass

Write-Host '[Format-KoseiCsvField / Write-KoseiPassStat] エスケープ・検証'
Assert-Eq 'カンマ含みは quote' '"a,b"' (Format-KoseiCsvField -Value 'a,b')
Assert-Eq '引用符は二重化+quote' '"a""b"' (Format-KoseiCsvField -Value 'a"b')
Assert-Eq '通常は素通し' 'abc' (Format-KoseiCsvField -Value 'abc')
Assert-Throws '不正 lens で throw' { Write-KoseiPassStat -Record ([pscustomobject]@{ job_id='j'; packet_id='p'; pass_id='1'; lens='bogus'; status='done'; findings_new=0; findings_exact_dup=0; finding_groups=0; pages_checked=0; coverage=0; elapsed_ms=0 }) }
Assert-Throws '不正 status で throw' { Write-KoseiPassStat -Record ([pscustomobject]@{ job_id='j'; packet_id='p'; pass_id='1'; lens='numbers'; status='bogus'; findings_new=0; findings_exact_dup=0; finding_groups=0; pages_checked=0; coverage=0; elapsed_ms=0 }) }

Write-Host '[Get-KoseiPriorFindingsDigest / New-KoseiGapFollowupPrompt] §8'
$passesSample = @([pscustomobject]@{ raw_answer = '{"findings":[{"page":7,"category":"numbers","quote":"12,345"},{"page":8,"category":"typo","quote":"recieve"}]}' })
$dig = Get-KoseiPriorFindingsDigest -Passes $passesSample -Max 50
Assert-Eq 'digest 2件抽出' 2 $dig.Count
Assert-True 'digest に page' ($dig[0].Contains('P.7'))
Assert-True 'digest に category' ($dig[0].Contains('[numbers]'))
Assert-True 'digest に quote' ($dig[0].Contains('12,345'))
Assert-Eq 'Max=1 で打ち切り' 1 (Get-KoseiPriorFindingsDigest -Passes $passesSample -Max 1).Count
Assert-Eq 'parse失敗は空(skip)' 0 (Get-KoseiPriorFindingsDigest -Passes @([pscustomobject]@{ raw_answer = '{壊れ' }) -Max 50).Count
$gp = New-KoseiGapFollowupPrompt -Digest @('P.1 [x] a') -PageRange '7,8' -Marker 'MK123'
Assert-True 'gap prompt に marker' ($gp.Contains('MK123'))
Assert-True 'gap prompt に digest' ($gp.Contains('P.1 [x] a'))

Write-Host '[Read-KoseiWarmupStatus] 前回起動の状態を引き継がない'
# ⚠️ 実測: -NoWarmup で起動したセッションが、前セッションの
#    {"state":"ready"} をそのまま返し、Edgeも無いのに ready を報告した。
#    /api/review/jobs のゲートは preparing の間しか待たないので、古い ready は素通りする。
Set-KoseiRoot -Root (Split-Path -Parent $PSScriptRoot)
$warmPath = Get-KoseiWarmupStatusPath
$warmBackup = $null
if (Test-Path -LiteralPath $warmPath -PathType Leaf) { $warmBackup = [System.IO.File]::ReadAllText($warmPath) }
try {
    $foreign = @{ state = 'ready'; detail = ''; updated_at = (Get-Date).ToString('s'); pid = ($PID + 1) } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($warmPath, $foreign, (New-Object System.Text.UTF8Encoding($false)))
    Assert-Eq '別プロセスが書いた ready は unknown 扱い' 'unknown' ([string](Read-KoseiWarmupStatus).state)

    Write-KoseiWarmupStatus -State 'ready' -Detail ''
    Assert-Eq '自分が書いた ready はそのまま読める' 'ready' ([string](Read-KoseiWarmupStatus).state)

    # pid を持たない旧形式のファイルも、前回起動の残骸として扱う
    [System.IO.File]::WriteAllText($warmPath, '{"state":"ready","detail":"","updated_at":"2026-08-05T06:55:27"}', (New-Object System.Text.UTF8Encoding($false)))
    Assert-Eq 'pid の無い旧形式も unknown 扱い' 'unknown' ([string](Read-KoseiWarmupStatus).state)
} finally {
    if ($null -ne $warmBackup) { [System.IO.File]::WriteAllText($warmPath, $warmBackup, (New-Object System.Text.UTF8Encoding($false))) }
    else { Remove-Item -LiteralPath $warmPath -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($script:fail -gt 0) { Write-Host "Test-ReviewPrimitives: FAIL ($script:fail)" -ForegroundColor Red; exit 1 }
Write-Host 'Test-ReviewPrimitives: PASS' -ForegroundColor Green
exit 0
