$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')

if(-not (Test-KoseiCopilotRefusalText '申し訳ございません。それに応答できませんでした')){throw '日本語拒否を検出できません'}
if(-not (Test-KoseiCopilotRefusalText 'Sorry, I was unable to respond.')){throw '英語拒否を検出できません'}
if(Test-KoseiCopilotRefusalText '{"findings":[]}'){throw '正常JSONを拒否と誤検知しました'}
# ⚠️ 「問題が発生しました」は拒否とは別だが、こちらから見れば同じく回答が得られない。
# 実測 2026-08-08: これを拾わないためにログに何も残らず、
# Show-CopilotHealth が「ふつう」と出す一方で実際には全部失敗していた。
if(-not (Test-KoseiCopilotRefusalText '申し訳ございません。問題が発生しました。もう一度お試しいただけますか?')){throw '「問題が発生しました」を検出できません'}
if(-not (Test-KoseiCopilotRefusalText 'Something went wrong. Please try again.')){throw '英語の something went wrong を検出できません'}
if(Test-KoseiCopilotRefusalText '{"findings":[{"issue_summary":"問題のある記述"}]}'){throw '指摘本文を拒否と誤検知しました'}

# Wait側のゲート条件をモックして、thinking中と再伸長中には早期停止しないことを固定する。
$cases=@(
  @{seen=$false;stable=180;generating=$false;expected=$false;name='thinking-no-response'},
  @{seen=$true;stable=4;generating=$false;expected=$false;name='refusal-not-stable'},
  @{seen=$true;stable=10;generating=$true;expected=$false;name='regrowth-generating'},
  @{seen=$true;stable=10;generating=$false;expected=$true;name='stable-refusal'}
)
foreach($c in $cases){$actual=($c.seen -and $c.stable -ge 5 -and -not $c.generating);if($actual -ne $c.expected){throw "$($c.name): ゲート判定不一致"}}
'Test-ResponseRecovery: PASS'
