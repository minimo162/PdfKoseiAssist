$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')

$cases=@(
    @{name='missing-open-quote';input='{"packet_id":"p1","checked_pages":[1],"findings":[{"issue_summary":「Filling」は「Filing」のスペルミス。","quote":"Filling"}],"read_error":""}';fix='missing-open-quote'},
    @{name='trailing-comma';input='{"packet_id":"p1","checked_pages":[1],"findings":[],"read_error":"",}';fix='trailing-comma'},
    @{name='smart-quotes-fallback';input='{＂packet_id＂:＂p1＂,＂checked_pages＂:[1],＂findings＂:[],＂read_error＂:＂＂}';fix='fullwidth-quote'},
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

$thought='{"findings":[{"page":16,"issue":"thinking"}]}'
$final='{"packet_id":"PACKET_002","checked_pages":[11,12],"findings":[],"read_error":""}'
$meta=$null;$selected=Get-KoseiReviewAnswerJson -Text ($thought+"`n"+$final) -Metadata ([ref]$meta)
if(($selected|ConvertFrom-Json).packet_id -ne 'PACKET_002'){throw 'thought JSONより本命JSONを優先できません'}
'Test-JsonRepair: PASS'
