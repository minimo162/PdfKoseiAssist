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
'Test-JsonRepair: PASS'
