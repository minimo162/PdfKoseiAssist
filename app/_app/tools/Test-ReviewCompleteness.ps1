$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')

function Assert-KoseiTest([bool]$Condition,[string]$Message){ if(-not $Condition){throw $Message} }

$expected=@(1..5)

# フラグ無し: 従来どおり列挙からcoverageを算出する。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3],"findings":[],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P'
Assert-KoseiTest ($r.coverage -eq 0.6) ("フラグ無しのcoverageが不正です: " + $r.coverage)
Assert-KoseiTest (-not $r.complete) 'フラグ無し60%は未完了であるべきです'
Assert-KoseiTest ($r.transport_complete) 'schemaが正しい回答をtransport未完了扱いしました'
Assert-KoseiTest ($r.verification_state -eq 'incomplete') '60%のverification_stateがincompleteではありません'
Assert-KoseiTest (-not [string]::IsNullOrEmpty($r.warning)) 'フラグ無し60%にwarningがありません'

# フラグtrue: 全対象ページを確認済みとして展開する。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[],"checked_pages_all":true,"findings":[],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P'
Assert-KoseiTest ($r.complete) 'フラグ付き回答が未完了扱いです'
Assert-KoseiTest ($r.coverage -eq 1.0) ("フラグ付きcoverageが不正です: " + $r.coverage)
Assert-KoseiTest (@($r.pagesChecked).Count -eq 5) 'フラグ付きでpages_checkedが展開されていません'
Assert-KoseiTest ([string]::IsNullOrEmpty($r.warning)) 'フラグ付き回答へwarningを立てました'

# フラグfalse: 展開せず列挙どおり。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1],"checked_pages_all":false,"findings":[],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P'
Assert-KoseiTest ($r.coverage -eq 0.2) ('falseフラグが展開されています: ' + $r.coverage)

# フラグtrueでもread_error併存時は展開しない。transport受信は成功でもpage completeにはしない。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[],"checked_pages_all":true,"findings":[],"read_error":"スキャンで読めない"}' -ExpectedPages $expected -ExpectedPacketId 'P'
Assert-KoseiTest (-not $r.complete) 'read_error回答を完全確認扱いしました'
Assert-KoseiTest ($r.legacy_complete) 'read_errorのlegacy互換completeを失いました'
Assert-KoseiTest ($r.verification_state -eq 'needs_review') 'read_errorのverification_stateがneeds_reviewではありません'
Assert-KoseiTest ($r.coverage -eq 0) ('read_error併存で展開しています: ' + $r.coverage)
Assert-KoseiTest (-not [string]::IsNullOrEmpty($r.warning)) 'read_error回答へwarningがありません'

# 100% coverageだけを完全確認とする。95%相当の不足は要確認に残す。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5],"findings":[]}' -ExpectedPages @(1..6) -ExpectedPacketId 'P'
Assert-KoseiTest (-not $r.complete) '100%未満coverageを完全確認扱いしました'
Assert-KoseiTest ($r.verification_state -eq 'incomplete') 'coverage不足のverification_stateがincompleteではありません'

# legacy compatibility is measurable at 70%, but the user-facing page
# completion remains strict until every expected page is checked.
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5,6,7],"findings":[]}' -ExpectedPages @(1..10) -ExpectedPacketId 'P'
Assert-KoseiTest ([math]::Abs([double]$r.coverage - 0.7) -lt 0.0001) ('70% coverageが不正です: ' + $r.coverage)
Assert-KoseiTest (-not $r.complete) '70% coverageを完全確認扱いしました'
Assert-KoseiTest ($r.legacy_complete) '70% legacy互換を失いました'
Assert-KoseiTest ($r.verification_state -eq 'incomplete') '70%のverification_stateがincompleteではありません'

$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19],"findings":[]}' -ExpectedPages @(1..20) -ExpectedPacketId 'P'
Assert-KoseiTest ([math]::Abs([double]$r.coverage - 0.95) -lt 0.0001) ('95% coverageが不正です: ' + $r.coverage)
Assert-KoseiTest (-not $r.complete) '95% coverageを完全確認扱いしました'
Assert-KoseiTest ($r.verification_state -eq 'incomplete') '95%のverification_stateがincompleteではありません'

$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5],"findings":[]}' -ExpectedPages @(1..5) -ExpectedPacketId 'P'
Assert-KoseiTest ($r.complete -and $r.page_complete -and $r.verification_state -eq 'page_complete') '100% coverageを完全確認扱いしませんでした'

$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5],"findings":[]}' -ExpectedPages @(1..5) -ExpectedPacketId 'P' -Repaired
Assert-KoseiTest ($r.complete -and $r.page_complete) '自動修復済みJSONのページ確認を失いました'
Assert-KoseiTest ($r.verification_state -eq 'needs_review') '自動修復済みJSONを要確認扱いしませんでした'
Assert-KoseiTest ($r.repaired) 'repairedフラグを保持しませんでした'
Assert-KoseiTest (-not [string]::IsNullOrEmpty($r.warning)) '自動修復済みJSONの監査warningがありません'

# #141: lossless quote escaping alone must not prompt for source confirmation.
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5],"findings":[]}' -ExpectedPages @(1..5) -ExpectedPacketId 'P' -Repaired -Fixes @('unescaped-prose-quote')
Assert-KoseiTest ($r.complete -and $r.verification_state -eq 'page_complete' -and $r.warning -eq '') '引用符修復だけで原文確認を求めました'
Assert-KoseiTest ($r.repaired) '引用符修復の内部記録を失いました'
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1],"findings":[]}' -ExpectedPages @(1..5) -ExpectedPacketId 'P' -Repaired -Fixes @('unescaped-prose-quote')
Assert-KoseiTest (-not $r.complete -and $r.verification_state -eq 'incomplete' -and $r.warning) '引用符修復で範囲不足を隠しました'
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5],"findings":[]}' -ExpectedPages @(1..5) -ExpectedPacketId 'P' -Repaired -Fixes @('unescaped-prose-quote','truncated-nested-closure')
Assert-KoseiTest (-not $r.complete -and $r.findings_truncated) '引用符修復で切断findingを隠しました'

# 対象外ページはschema段階で拒否される既存保護の維持。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[99],"findings":[],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P'
Assert-KoseiTest (-not $r.complete) '対象外pageが通りました'

# 修復で findings の要素を捨てた／findings の内側で閉じた応答は、coverage 100% でも complete=false (#131)。
foreach($fix in @('truncated-finding-drop','truncated-nested-closure')){
    $r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[],"checked_pages_all":true,"findings":[{"page":1,"quote":"x"}],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P' -Repaired -Fixes @('trailing-comma',$fix)
    Assert-KoseiTest (-not $r.complete) ("findings切れ({0})をcomplete扱いしました" -f $fix)
    Assert-KoseiTest (-not $r.page_complete) ("findings切れ({0})をpage_complete扱いしました" -f $fix)
    Assert-KoseiTest ($r.verification_state -eq 'incomplete') ("findings切れ({0})のverification_stateが不正です: {1}" -f $fix,$r.verification_state)
    Assert-KoseiTest ($r.transport_complete) ("findings切れ({0})でtransport受信まで否定しました" -f $fix)
    Assert-KoseiTest ($r.findings_truncated) ("findings切れ({0})でfindings_truncatedが立っていません" -f $fix)
    Assert-KoseiTest ([string]$r.warning -match '途中で切れ') ("findings切れ({0})のwarningが不正です: {1}" -f $fix,$r.warning)
}
# findings に触れない修復（末尾カンマ等）は従来どおり complete。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[],"checked_pages_all":true,"findings":[],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P' -Repaired -Fixes @('trailing-comma','truncated-tail-closure')
Assert-KoseiTest ($r.complete) 'findingsに触れない修復をincomplete扱いしました'
Assert-KoseiTest (-not $r.findings_truncated) 'findingsに触れない修復でfindings_truncatedが立ちました'

foreach($fixes in @(@('trailing-comma'), @('trailing-comma','unescaped-prose-quote'))){
    $r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[1,2,3,4,5],"findings":[]}' -ExpectedPages $expected -ExpectedPacketId 'P' -Repaired -Fixes $fixes
    Assert-KoseiTest ($r.verification_state -eq 'page_complete' -and $r.warning -eq '' -and $r.repaired) '形式修復だけで再確認を求めました'
}
Write-Host 'Test-ReviewCompleteness: PASS' -ForegroundColor Green
