param(
    # サーバーURL。省略時は _app/local-app.url から読む
    [string]$ServerUrl = '',
    # 実パケットで試す場合に指定（省略時はテスト用PDF/TEXTを自動生成）
    [string]$PdfPath = '',
    [string]$TextPath = '',
    [int]$PollTimeoutSeconds = 720
)

# =====================================================================
# Test-ReviewApi.ps1 — Phase 1 エンドツーエンド検証
#
# サーバーAPI経由で1パケットの校正ジョブを投入し、
# 添付 → 依頼文送信 → Copilot回答待機 → JSON取得 までを検証する。
# 依頼文は「決まった形のJSONを返すだけ」の最小プロンプト（校正はしない）。
#
# 実行手順:
#   1) PDF校正アシスト起動.vbs（または Start-KoseiAssist.ps1）でサーバー起動
#   2) powershell -ExecutionPolicy Bypass -File .\tools\Test-ReviewApi.ps1
# =====================================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$here = $PSScriptRoot
$appRoot = Split-Path -Parent $here
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')

if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
    $urlFile = Join-Path $appRoot 'local-app.url'
    if (!(Test-Path -LiteralPath $urlFile -PathType Leaf)) {
        throw 'サーバーURLが不明です。先に Start-KoseiAssist.ps1 でサーバーを起動するか、-ServerUrl を指定してください。'
    }
    $ServerUrl = (Get-Content -LiteralPath $urlFile -TotalCount 1).Trim()
}
$ServerUrl = $ServerUrl.TrimEnd('/')
Write-Host ("サーバー: " + $ServerUrl)

# ---- テスト用PDF（最小構成）とTEXT ----
function New-KoseiTestPdf {
    param([Parameter(Mandatory=$true)][string]$Path)
    $ascii = [System.Text.Encoding]::ASCII
    $content = "BT /F1 24 Tf 72 720 Td (PDF Kosei API Test $Stamp) Tj ET"
    $objs = @(
        "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n",
        "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n",
        "3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`nendobj`n",
        ("4 0 obj`n<< /Length {0} >>`nstream`n{1}`nendstream`nendobj`n" -f $ascii.GetByteCount($content), $content),
        "5 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n"
    )
    $header = "%PDF-1.4`n"
    $offsets = New-Object System.Collections.Generic.List[int]
    $pos = $ascii.GetByteCount($header)
    foreach ($o in $objs) { $offsets.Add($pos); $pos += $ascii.GetByteCount($o) }
    $xrefPos = $pos
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append($header)
    foreach ($o in $objs) { [void]$sb.Append($o) }
    [void]$sb.Append("xref`n0 6`n0000000000 65535 f `n")
    foreach ($off in $offsets) { [void]$sb.Append(('{0:d10} 00000 n ' -f $off) + "`n") }
    [void]$sb.Append("trailer`n<< /Size 6 /Root 1 0 R >>`nstartxref`n$xrefPos`n%%EOF`n")
    [System.IO.File]::WriteAllBytes($Path, $ascii.GetBytes($sb.ToString()))
}

$tempDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pdf-kosei-ps\uploads'
if (!(Test-Path -LiteralPath $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

if ([string]::IsNullOrWhiteSpace($PdfPath)) {
    $PdfPath = Join-Path $tempDir ("APITEST_{0}_PACKET.pdf" -f $Stamp)
    New-KoseiTestPdf -Path $PdfPath
}
$textBody = ''
if ([string]::IsNullOrWhiteSpace($TextPath)) {
    $textBody = "PAGE_MAP: api test`nTARGET_CHECK page 1: PDF Kosei API Test $Stamp`n"
} else {
    $textBody = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
}

$pdfName = [System.IO.Path]::GetFileName($PdfPath)
$pdfBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($PdfPath))
Write-Host ("添付PDF: {0} ({1:n0} bytes)" -f $pdfName, (Get-Item -LiteralPath $PdfPath).Length)

# ---- 最小プロンプト（回答形式と終端マーカーの検証のみ） ----
$prompt = @"
これは校正アプリの接続テストです。添付ファイルの内容確認は最小限で構いません。
次のJSONだけを返し、直後に単独行で KOSEI_END と出力してください。
説明文・Markdownコードフェンスは不要です。

{
  "findings": [],
  "no_findings_reason": "connection test: 添付ファイル名を1つ書く",
  "checked_page_summaries": [ { "page": 1, "status": "checked", "note": "api test" } ]
}
"@

# ---- ジョブ投入 ----
$body = @{ 
    attach_mode = 'pdf'
    packets = @(@{
        packet_id = 'APITEST_001'
        prompt    = $prompt
        text      = $textBody
        text_name = ("APITEST_{0}_TEXT.txt" -f $Stamp)
        pdf_base64 = $pdfBase64
        pdf_name  = $pdfName
    })
} | ConvertTo-Json -Depth 10

Write-Host '--- ジョブ投入 POST /api/review/jobs ---'
$resp = Invoke-RestMethod -UseBasicParsing -Method Post -Uri ($ServerUrl + '/api/review/jobs') -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$jobId = [string]$resp.job_id
if ([string]::IsNullOrWhiteSpace($jobId)) { throw ('job_id を取得できませんでした: ' + ($resp | ConvertTo-Json -Compress)) }
Write-Host ("job_id: " + $jobId)

# ---- ポーリング ----
$deadline = (Get-Date).AddSeconds($PollTimeoutSeconds)
$lastPhase = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $st = Invoke-RestMethod -UseBasicParsing -Uri ($ServerUrl + '/api/review/jobs/' + $jobId)
    $phaseLine = ('mode={0} phase={1} done={2}/{3}' -f $st.mode, $st.phase, $st.packets_done, $st.packets_total)
    if ($phaseLine -ne $lastPhase) { Write-Host ('     ' + (Get-Date).ToString('HH:mm:ss') + ' ' + $phaseLine); $lastPhase = $phaseLine }
    if (@('done','error','cancelled') -contains [string]$st.mode) { break }
}

# ---- 結果取得 ----
Write-Host '--- 結果 GET /api/review/jobs/{id}/result ---'
$result = Invoke-RestMethod -UseBasicParsing -Uri ($ServerUrl + '/api/review/jobs/' + $jobId + '/result')
$pk = @($result.packets)[0]
Write-Host ("packet: {0} status={1} completed_by={2}" -f $pk.packet_id, $pk.status, $pk.completed_by)
if ($pk.error) { Write-Host ("error: " + $pk.error) }
Write-Host '--- raw_answer ---'
Write-Host ([string]$pk.raw_answer)
Write-Host '------------------'

$ok = $false
if ([string]$pk.status -eq 'done') {
    try {
        $ans = ([string]$pk.raw_answer) | ConvertFrom-Json
        if ($ans.PSObject.Properties.Name -contains 'findings') { $ok = $true }
    } catch {}
}
if ($ok) {
    Write-Host ''
    Write-Host '結論: PASS — 添付→送信→回答待機→JSON抽出→取得 の全チェーンが成立しました。'
    exit 0
} else {
    Write-Host ''
    Write-Host '結論: FAIL — %USERPROFILE%\.pdf-kosei-ps\logs\pdf-kosei.log を確認してください。'
    exit 1
}
