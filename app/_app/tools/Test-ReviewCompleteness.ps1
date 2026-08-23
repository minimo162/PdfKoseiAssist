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

# 対象外ページはschema段階で拒否される既存保護の維持。
$r=Get-KoseiReviewCompleteness -Json '{"packet_id":"P","checked_pages":[99],"findings":[],"read_error":""}' -ExpectedPages $expected -ExpectedPacketId 'P'
Assert-KoseiTest (-not $r.complete) '対象外pageが通りました'

Write-Host 'Test-ReviewCompleteness: PASS' -ForegroundColor Green
