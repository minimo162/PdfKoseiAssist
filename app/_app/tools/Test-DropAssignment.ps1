$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DropFiles.ps1')
function Check($Names,$Languages,$Expected) {
    $actual=Get-KoseiDropAssignment -Names $Names -Languages $Languages
    if($actual.target -ne $Expected){throw ('Assignment failed: '+($Names -join ',')+' expected='+$Expected+' actual='+$actual.target)}
}
Check @('single.pdf') @() 0
Check @('a.pdf','b.pdf') @('英語','日本語') 0
Check @('b.pdf','a.pdf') @('日本語','英語') 1
Check @('x_ja.pdf','x_en.pdf') @('その他','その他') 1
Check @('x_en.pdf','x_ja.pdf') @('英語','英語') 0
Check @('日本語.pdf','English.pdf') @() 1
Check @('和文.pdf','英文.pdf') @() 1
Check @('a.pdf','b.pdf') @('英語','英語') -1
Check @('a_en.pdf','b_en.pdf') @() -1
Check @('a_en_ja.pdf','b.pdf') @() -1
Check @('a_ja.pdf','b_en.pdf') @('英語','日本語') 0
Write-Host 'PASS DropAssignment'
