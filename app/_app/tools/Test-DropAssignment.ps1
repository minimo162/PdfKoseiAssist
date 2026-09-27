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
# #211: 読めなかった方だけを名指しし、パスワード付きなら送り直しでは直らないと伝える。
$m=Get-KoseiDropLoadFailureMessage -Role reference -Name 'genko.pdf' -Detail 'genko.pdf を比較資料として読み込めませんでした: No password given'
if($m -notmatch '^日本語の原稿「genko\.pdf」' -or $m -match 'report\.pdf' -or $m -notmatch 'パスワード付きのPDFには対応していません'){throw "reference password message: $m"}
$m=Get-KoseiDropLoadFailureMessage -Role target -Name 'report.pdf' -Detail 'Invalid PDF structure'
if($m -notmatch '^英文PDF「report\.pdf」' -or $m -match 'genko\.pdf' -or $m -notmatch '可能性' -or $m -notmatch '作り直'){throw "target generic message: $m"}
# #213: 開始通知は利用者向けの用語にそろえる。
if((Get-KoseiDropStartNotification -TargetName 'a_en.pdf' -ReferenceName 'a_ja.pdf') -ne '校正を始めました：a_en.pdf（日本語の原稿：a_ja.pdf）'){throw 'notification with reference'}
if((Get-KoseiDropStartNotification -TargetName 'a_en.pdf' -ReferenceName '') -ne '校正を始めました：a_en.pdf（英文のみ）'){throw 'notification without reference'}
$src=Get-Content -Raw -Encoding UTF8 (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/DropReview.ps1')
if($src -match '比較資料なし|（比較資料：'){throw 'DropReview.ps1 still shows 比較資料 in the notification'}
Write-Host 'PASS DropAssignment'
