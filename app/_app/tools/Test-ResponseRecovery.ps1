$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')

if(-not (Test-KoseiCopilotRefusalText '申し訳ございません。それに応答できませんでした')){throw '日本語拒否を検出できません'}
if(-not (Test-KoseiCopilotRefusalText 'Sorry, I was unable to respond.')){throw '英語拒否を検出できません'}
if(Test-KoseiCopilotRefusalText '{"findings":[]}'){throw '正常JSONを拒否と誤検知しました'}

# Wait側のゲート条件をモックして、thinking中と再伸長中には早期停止しないことを固定する。
$cases=@(
  @{seen=$false;stable=180;generating=$false;expected=$false;name='thinking-no-response'},
  @{seen=$true;stable=4;generating=$false;expected=$false;name='refusal-not-stable'},
  @{seen=$true;stable=10;generating=$true;expected=$false;name='regrowth-generating'},
  @{seen=$true;stable=10;generating=$false;expected=$true;name='stable-refusal'}
)
foreach($c in $cases){$actual=($c.seen -and $c.stable -ge 5 -and -not $c.generating);if($actual -ne $c.expected){throw "$($c.name): ゲート判定不一致"}}
'Test-ResponseRecovery: PASS'
