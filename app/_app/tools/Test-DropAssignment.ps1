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
Check @('x_en.pdf','x_ja.pdf') @('英語','英語') -1
Check @('日本語.pdf','English.pdf') @() 1
Check @('和文.pdf','英文.pdf') @() 1
Check @('a.pdf','b.pdf') @('英語','英語') -1
Check @('a_en.pdf','b_en.pdf') @() -1
Check @('a_en_ja.pdf','b.pdf') @() -1
Check @('a_ja.pdf','b_en.pdf') @('英語','日本語') 0
# 区切りの無い「_en」は目印にしない（quarter_end の _end）。本文と食い違うファイル名では決めない。
Check @('quarter_end.pdf','translation.pdf') @('日本語','その他') -1
Check @('quarter_end.pdf','translation.pdf') @() -1
Check @('report_ja.pdf','report_en.pdf') @('日本語','その他') 1
Check @('report_en.pdf','report_ja.pdf') @('日本語','その他') -1
Check @('report-EN (1).pdf','report.pdf') @() 0
Check @('Q3 English.pdf','Q3.pdf') @() 0
Check @('open_entry.pdf','japanese_notes.pdf') @() 0
Check @('agenda.pdf','jpeg_list.pdf') @() -1
Write-Host 'PASS DropAssignment'
