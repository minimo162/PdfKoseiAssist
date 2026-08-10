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
'Test-JsonRepair: PASS'
