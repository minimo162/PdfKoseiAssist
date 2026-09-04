$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')
. (Join-Path $root 'src\ReviewJob.ps1')

function Assert-SplitRecovery([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$expected = @(11..15)
$full = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
}
$partial = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[11,12,13,14]}'
    pagesChecked = @(11..14)
}
$flagged = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[],"checked_pages_all":true}'
    pagesChecked = $expected
}
$readError = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages_all":true,"read_error":"unreadable"}'
    pagesChecked = @()
}
$notOk = [pscustomobject]@{
    ok = $false
    json = '{"findings":[],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
}

Assert-SplitRecovery (Test-KoseiPacketCoverageComplete -Result $full -ExpectedPages $expected) '全ページ回答を不完全扱いしました'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $partial -ExpectedPages $expected)) '部分coverageを完全扱いしました'
Assert-SplitRecovery (Test-KoseiPacketCoverageComplete -Result $flagged -ExpectedPages $expected) 'checked_pages_allを完全扱いしませんでした'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $readError -ExpectedPages $expected)) 'read_error回答を完全扱いしました'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $notOk -ExpectedPages $expected)) 'ok=false回答を完全扱いしました'

# findings の途中で切れて修復した半分は、ページ列挙が揃っていても不完全 (#131)。
$truncatedHalf = [pscustomobject]@{
    ok = $true
    json = '{"findings":[{"page":11,"quote":"x"}],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
    repaired = $true
    fixes = @('truncated-tail-closure', 'truncated-finding-drop')
}
$closedInsideFindings = [pscustomobject]@{
    ok = $true
    json = '{"findings":[{"page":11,"quote":"x"}],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
    repaired = $true
    fixes = @('truncated-tail-closure', 'truncated-nested-closure')
}
$harmlessRepair = [pscustomobject]@{
    ok = $true
    json = '{"findings":[],"checked_pages":[11,12,13,14,15]}'
    pagesChecked = $expected
    repaired = $true
    fixes = @('trailing-comma')
}
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $truncatedHalf -ExpectedPages $expected)) 'findings要素を捨てた半分を完全扱いしました'
Assert-SplitRecovery (-not (Test-KoseiPacketCoverageComplete -Result $closedInsideFindings -ExpectedPages $expected)) 'findings内側で閉じた半分を完全扱いしました'
Assert-SplitRecovery (Test-KoseiPacketCoverageComplete -Result $harmlessRepair -ExpectedPages $expected) 'findingsに触れない修復を不完全扱いしました'

# 分割マージ結果は、半分どちらかが修復済みなら repaired=true で fixes を引き継ぐ (#131)。
# （マージはワーカー本体の内側にあるため、呼び出し行の契約をソースで確認する。）
$reviewJobText = [System.IO.File]::ReadAllText((Join-Path $root 'src\ReviewJob.ps1'))
$mergeLine = @($reviewJobText -split "`n" | Where-Object { $_ -match 'completedBy=\$\(if\(\$good\.Count -eq 2\)\{''split-merged''\}' })[0]
Assert-SplitRecovery ([bool]$mergeLine) '分割マージの生成行が見つかりません'
Assert-SplitRecovery ($mergeLine -match 'repaired=\$mergedRepaired') ('分割マージがrepaired=$falseに固定されています: ' + $mergeLine.Trim())
Assert-SplitRecovery ($mergeLine -match 'fixes=\$mergedFixes') ('分割マージがfixesを引き継いでいません: ' + $mergeLine.Trim())
Assert-SplitRecovery ($reviewJobText -match 'Get-KoseiReviewCompleteness -Json \$Packet\.raw_answer[^\r\n]*-Fixes @\(\$wait\.fixes\)') '回答保存時の完全性判定にfixesが渡っていません'
Assert-SplitRecovery ($reviewJobText -match 'Test-KoseiFindingsTruncatedFixes -Fixes @\(\$w\.fixes\)') 'testInsufficientAnswerがfindings切れを見ていません'

# maxPasses は gap 予約枠を含めた総pass数の上限（#119 で修正済み。#131 item 7 は同件）。
foreach ($maxPasses in 1, 2, 3, 4, 8) {
    $schedule = Get-KoseiPassSchedule -Profile 'thorough' -HasRef $true -GapPass $true -MaxPasses $maxPasses
    Assert-SplitRecovery (@($schedule.passes).Count -le $maxPasses) ("maxPasses={0} を超過しました: {1}" -f $maxPasses, (@($schedule.passes | ForEach-Object { $_.lens }) -join ','))
}
$two = Get-KoseiPassSchedule -Profile 'standard' -HasRef $false -GapPass $true -MaxPasses 2
Assert-SplitRecovery ((@($two.passes | ForEach-Object { $_.lens }) -join ',') -eq 'broad,gap') ('maxPasses=2のpassが不正です: ' + (@($two.passes | ForEach-Object { $_.lens }) -join ','))
$three = Get-KoseiPassSchedule -Profile 'standard' -HasRef $false -GapPass $true -MaxPasses 3
Assert-SplitRecovery ((@($three.passes | ForEach-Object { $_.lens }) -join ',') -eq 'broad,numbers,gap') ('maxPasses=3のpassが不正です: ' + (@($three.passes | ForEach-Object { $_.lens }) -join ','))

Write-Host 'Test-SplitRecovery: PASS' -ForegroundColor Green
