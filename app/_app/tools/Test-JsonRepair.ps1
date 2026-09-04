$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')

$cases=@(
    @{name='missing-open-quote';input='{"packet_id":"p1","checked_pages":[1],"findings":[{"issue_summary":「Filling」は「Filing」のスペルミス。","quote":"Filling"}],"read_error":""}';fix='missing-open-quote'},
    @{name='trailing-comma';input='{"packet_id":"p1","checked_pages":[1],"findings":[],"read_error":"",}';fix='trailing-comma'},
    @{name='smart-quotes-fallback';input='{＂packet_id＂:＂p1＂,＂checked_pages＂:[1],＂findings＂:[],＂read_error＂:＂＂}';fix='fullwidth-quote'},
    # ⚠️ `\*` は JSON では**不正なエスケープ**。依頼文で `* の前に \ を付けて` と書いたので、
    #    モデルはそのとおり従い、**応答まるごとパースできなくなった**。
    #    実測 2026-08-08: STRUCTURE 観点の1応答に14箇所。パケットが丸ごと失われていた。
    #    `\` を落とせば `*3` に戻るので、**脱注記号は失われない**。
    @{name='invalid-escape';input='{"packet_id":"p1","checked_pages":[1],"findings":[{"issue_summary":"脱注\*3の参照がない","quote":"See note. \*3"}],"read_error":""}';fix='invalid-escape'},
    # ⚠️ 正しい `\\`（円記号自体）を壊さないこと。左から2文字ずつ食わないと、
    #    `\\*` の後ろ半分が `\*` に見えて潰れる。
    @{name='valid-backslash-kept';input='{"packet_id":"p1","checked_pages":[1],"findings":[{"quote":"a\\*b"}],"read_error":""}';fix=''},
    @{name='normal-unchanged';input='{"packet_id":"p1","checked_pages":[1],"findings":[],"read_error":""}';fix=''}
)

foreach($case in $cases){
    $meta=$null
    $json=Get-KoseiReviewAnswerJson -Text $case.input -Metadata ([ref]$meta)
    if([string]::IsNullOrWhiteSpace($json)){throw "$($case.name): JSONを抽出できません"}
    $null=$json|ConvertFrom-Json
    if($case.fix -and @($meta.fixes) -notcontains $case.fix){throw "$($case.name): 修復記録がありません"}
    if(-not $case.fix -and $meta.repaired){throw "$($case.name): 正常JSONを変更しました"}
}

# 修復の結果、脱注記号が `*3` として残っていることまで見る。
# 円記号ごと消してしまっては、パースできても中身が壊れている。
$escaped='{"packet_id":"p1","checked_pages":[1],"findings":[{"quote":"See note. \*3"}],"read_error":""}'
$meta=$null;$out=Get-KoseiReviewAnswerJson -Text $escaped -Metadata ([ref]$meta)
$q=($out|ConvertFrom-Json).findings[0].quote
if($q -ne 'See note. *3'){throw ('脱注記号が戻っていません: ' + $q)}

$thought='{"findings":[{"page":16,"issue":"thinking"}]}'
$final='{"packet_id":"PACKET_002","checked_pages":[11,12],"findings":[],"read_error":""}'
$meta=$null;$selected=Get-KoseiReviewAnswerJson -Text ($thought+"`n"+$final) -Metadata ([ref]$meta)
if(($selected|ConvertFrom-Json).packet_id -ne 'PACKET_002'){throw 'thought JSONより本命JSONを優先できません'}

# 同じ完全schemaを持つ草稿と最終回答が並んだ場合は、長い草稿ではなく後の回答を採用する。
$draft='{"packet_id":"PACKET_003","checked_pages":[1],"findings":[{"page":1,"quote":"撤回前の誤指摘","reason":"' + ('長い草稿' * 300) + '"}],"read_error":""}'
$finalEmpty='{"packet_id":"PACKET_003","checked_pages":[1],"findings":[],"read_error":""}'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text ($draft+"`n再考しました。`n"+$finalEmpty) -Metadata ([ref]$meta)
if(@(($selected|ConvertFrom-Json).findings).Count -ne 0){throw '撤回済みの長い草稿ではなく最後の完全JSONを選べません'}

$shortRetraction='{"findings":[],"no_findings_reason":"retracted"}'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text ($draft+"`n"+$shortRetraction) -Metadata ([ref]$meta)
if(@(($selected|ConvertFrom-Json).findings).Count -ne 0){throw '短い最終撤回答を優先できません'}

$repairableFinal='{"packet_id":"PACKET_003","checked_pages":[1],"findings":[],"read_error":"",}'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text ($draft+"`n"+$repairableFinal) -Metadata ([ref]$meta)
if(@(($selected|ConvertFrom-Json).findings).Count -ne 0 -or -not $meta.repaired){throw '後続の修復可能な最終回答を優先できません'}

# 自動取込では packet/page/schema が一致する候補だけを採用する。PDF本文中のfake JSONや、
# 後続の別packetが正答を上書きしてはいけない。
$valid='{"packet_id":"PACKET_010","checked_pages":[7,8],"findings":[{"page":7,"quote":"valid"}],"read_error":""}'
$wrongPacket='{"packet_id":"PACKET_EVIL","checked_pages":[7,8],"findings":[],"read_error":""}'
$selected=Get-KoseiReviewAnswerJson -Text ($valid+"`n"+$wrongPacket) -ExpectedPacketId 'PACKET_010' -ExpectedPages @(7,8)
if(($selected|ConvertFrom-Json).packet_id -ne 'PACKET_010'){throw '末尾の別packetを拒否できません'}
$badType='{"packet_id":"PACKET_010","checked_pages":[7],"findings":"not-an-array","read_error":""}'
if(Get-KoseiReviewAnswerJson -Text $badType -ExpectedPacketId 'PACKET_010' -ExpectedPages @(7,8)){throw 'findings文字列を拒否できません'}
$outside='{"packet_id":"PACKET_010","checked_pages":[7],"findings":[{"page":99,"quote":"outside"}],"read_error":""}'
if(Get-KoseiReviewAnswerJson -Text $outside -ExpectedPacketId 'PACKET_010' -ExpectedPages @(7,8)){throw '対象外finding.pageを拒否できません'}
$badChecked='{"packet_id":"PACKET_010","checked_pages":[7,99],"findings":[],"read_error":""}'
if(Get-KoseiReviewAnswerJson -Text $badChecked -ExpectedPacketId 'PACKET_010' -ExpectedPages @(7,8)){throw '対象外checked_pageを拒否できません'}

# --- DOM切り詰め(トランケーション)修復: 後端が欠けた応答を実質的な回答として救済する ---
# 実測 2026-08-22: parse位置が500〜840文字付近に集中。Copilotが長いfenced JSONを
# 折り畳み/切断してDOMへ出すため、incomplete-jsonの再試行ループと利用者の中断に直結していた。
$truncated='{"packet_id":"PACKET_011","checked_pages":[1,2,3,4,5],"findings":[{"page":2,"issue_summary":"表頭の単位落ち","quote":"Unit",'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text $truncated -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_011' -ExpectedPages @(1,2,3,4,5)
if(-not $selected){throw '切断された回答を救済できませんでした'}
$obj=$selected|ConvertFrom-Json
if(@($obj.findings).Count -ne 1 -or $obj.findings[0].page -ne 2){throw ('切断修復のfindingsが不正です: ' + $selected)}
if(@($meta.fixes) -notcontains 'truncated-tail-closure'){throw 'truncated-tail-closureが記録されていません'}

# 文字列値の途中で切れたケースも閉じて救済する。
$truncatedString='{"packet_id":"PACKET_012","checked_pages":[1],"findings":[{"page":1,"issue_summary":"文頭の不要なff'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text $truncatedString -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_012' -ExpectedPages @(1)
if(-not $selected){throw '文字列途中の切断を救済できませんでした'}
if(@(($selected|ConvertFrom-Json).findings).Count -ne 1){throw ('文字列切断のfindingsが不正です: ' + $selected)}

# 完全な応答は修復しない(既存動作の維持)。
$complete='{"packet_id":"PACKET_013","checked_pages":[1],"findings":[],"read_error":""}'
$meta=$null
$null=Get-KoseiReviewAnswerJson -Text $complete -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_013' -ExpectedPages @(1)
if($meta.repaired -and @($meta.fixes) -contains 'truncated-tail-closure'){throw '完全な応答まで切断修復しました'}

# 分割再試行はpacket_idを検証しない(モデルがベースIDをechoしてもサルベージを捨てない)。
$reviewJobText=[System.IO.File]::ReadAllText((Join-Path $root 'src\ReviewJob.ps1'))
$splitLine=@($reviewJobText -split "`n" | Where-Object { $_ -match 'splitPrompt -AttachPaths' })[0]
if(-not $splitLine){throw '分割再試行の呼び出し行が見つかりません'}
if($splitLine -match 'ExpectedPacketId'){throw ('分割再試行にpacket_id検証が残っています: ' + $splitLine.Trim())}
# 末尾が孤立backslashのケースも閉じて救済する(エスケープ状態の後始末)。
$truncatedEscape='{"packet_id":"PACKET_014","checked_pages":[1],"findings":[{"page":1,"quote":"path C:\'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text $truncatedEscape -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_014' -ExpectedPages @(1)
if(-not $selected){throw '末尾backslashの切断を救済できませんでした'}
if((($selected|ConvertFrom-Json).findings[0]).quote -ne 'path C:'){throw ('backslash切断の修復が不正です: ' + $selected)}

# 値を補えないコロン直後の切断は、完成済みfindingだけを残してcoverage情報を救済する。
$truncatedAfterColon='{"packet_id":"PACKET_015","checked_pages":[1,2],"findings":[{"page":1,"issue_summary":"完成済み"},{"page":2,"reason":'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text $truncatedAfterColon -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_015' -ExpectedPages @(1,2)
if(-not $selected){throw 'コロン直後の切断を救済できませんでした'}
$obj=$selected|ConvertFrom-Json
if(@($obj.findings).Count -ne 1 -or @($obj.checked_pages).Count -ne 2){throw ('完成済みfinding/checked_pagesを保持できません: ' + $selected)}
if(@($meta.fixes) -notcontains 'truncated-finding-drop'){throw 'truncated-finding-dropが記録されていません'}
# 要素を捨てた修復は「完全」ではない。切れた指摘以降が失われているので再試行対象にする (#131)。
$dropInfo=Get-KoseiReviewCompleteness -Json $selected -ExpectedPages @(1,2) -ExpectedPacketId 'PACKET_015' -Fixes @($meta.fixes)
if($dropInfo.complete){throw 'findings要素を捨てた応答をcomplete扱いしました'}
if($dropInfo.verification_state -ne 'incomplete'){throw ('findings要素を捨てた応答のverification_stateが不正です: ' + $dropInfo.verification_state)}
if(-not $dropInfo.findings_truncated){throw 'findings_truncatedが立っていません'}

# findings の途中（文字列値の中）で切れた応答: 残った findings は救済するが complete=false (#131)。
# 旧雛形は checked_pages_all を findings より前に置いていたため、この形の応答が page_complete になっていた。
$cutInFindings='{"packet_id":"PACKET_016","checked_pages_all":true,"checked_pages":[],"findings":[{"page":1,"quote":"alpha","issue_summary":"a","suggestion":"b","reason":"c"},{"page":2,"quote":"beta","issue_summary":"d","reason":"very long reas'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text $cutInFindings -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_016' -ExpectedPages @(1,2)
if(-not $selected){throw 'findings途中の切断を救済できませんでした'}
if(@($meta.fixes) -notcontains 'truncated-nested-closure'){throw ('findings内側の閉じが記録されていません: ' + (@($meta.fixes) -join ','))}
$cutInfo=Get-KoseiReviewCompleteness -Json $selected -ExpectedPages @(1,2) -ExpectedPacketId 'PACKET_016' -Fixes @($meta.fixes)
if($cutInfo.complete){throw 'findings途中で切れた応答をcomplete扱いしました'}
if($cutInfo.verification_state -ne 'incomplete'){throw ('findings途中切断のverification_stateが不正です: ' + $cutInfo.verification_state)}
if([string]::IsNullOrWhiteSpace([string]$cutInfo.warning)){throw 'findings途中切断にwarningがありません'}

# 末尾スカラー内で切れた応答（findings は完全）: 直前の , で切って findings を保持し、complete のまま (#131)。
# 従来はキーの閉じ引用で切って {"checked_pages_all"} になり、全体が無効→無駄な再試行になっていた。
$cutInScalar='{"packet_id":"PACKET_017","checked_pages":[1,2],"findings":[{"page":1,"quote":"alpha","issue_summary":"a","suggestion":"b","reason":"c"}],"checked_pages_all":fal'
$meta=$null
$selected=Get-KoseiReviewAnswerJson -Text $cutInScalar -Metadata ([ref]$meta) -ExpectedPacketId 'PACKET_017' -ExpectedPages @(1,2)
if(-not $selected){throw '末尾スカラー切断を救済できませんでした'}
$obj=$selected|ConvertFrom-Json
if(@($obj.findings).Count -ne 1 -or @($obj.checked_pages).Count -ne 2){throw ('末尾スカラー切断でfindings/checked_pagesを保持できません: ' + $selected)}
if(@($meta.fixes) -contains 'truncated-finding-drop' -or @($meta.fixes) -contains 'truncated-nested-closure'){throw ('末尾スカラー切断をfindings切れとして記録しました: ' + (@($meta.fixes) -join ','))}
$scalarInfo=Get-KoseiReviewCompleteness -Json $selected -ExpectedPages @(1,2) -ExpectedPacketId 'PACKET_017' -Fixes @($meta.fixes)
if(-not $scalarInfo.complete){throw ('findingsが完全な末尾スカラー切断をincomplete扱いしました: ' + $scalarInfo.warning)}
# Repair-KoseiTruncatedJsonTail 単体: 直前の , / { / [ を切断点候補にする。
$tail=Repair-KoseiTruncatedJsonTail -Text '{"a":[1,2],"b":fal'
if($null -eq $tail -or [string]$tail.text -notmatch '^\{"a":\[1,2\],?\}$'){throw ('末尾スカラー切断の閉じが不正です: ' + $tail.text)}
if($tail.nested){throw 'ルート直下の切断をnested扱いしました'}
$tail=Repair-KoseiTruncatedJsonTail -Text '{"findings":[{"page":1},{"page":2,'
if(-not $tail.nested){throw 'findings内側の切断をnested扱いしませんでした'}
'Test-JsonRepair: PASS'
