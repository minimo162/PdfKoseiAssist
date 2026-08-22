#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$indexPath = Join-Path $appRoot 'index.html'
$policyScript = Join-Path (Join-Path $appRoot 'src') 'RuntimeHtmlPolicy.ps1'

function Assert-KoseiTest {
    param([Parameter(Mandatory=$true)][bool]$Condition, [Parameter(Mandatory=$true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

. $policyScript

$raw = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
$patched = Convert-KoseiIndexHtmlForRuntime -Html $raw -Silent

Assert-KoseiTest (-not [string]::Equals($patched, $raw, [System.StringComparison]::Ordinal)) 'index.html に実行時ポリシーが適用されませんでした。'
Assert-KoseiTest ($patched.Contains('const PACKET_PAGE_VALIDATION_TIMEOUT_MS = 20000;')) 'ページ読込・テキスト確認の20秒上限が失われました。'
Assert-KoseiTest ($patched.Contains('const PACKET_RENDER_VALIDATION_TIMEOUT_MS = 90000;')) 'PDF描画確認専用の90秒上限がありません。'
Assert-KoseiTest ($patched.Contains('renderTimeoutMs = timeoutMs')) 'ページ読込と描画のtimeout引数が分離されていません。'
Assert-KoseiTest ($patched.Contains('renderTask.promise,' + "`n" + '          renderTimeoutMs')) '描画処理が専用timeoutを使っていません。'
Assert-KoseiTest ($patched.Contains('getViewport({ scale: 0.20 })')) '表示確認の軽量描画縮尺が適用されていません。'
Assert-KoseiTest ($patched.Contains('spec.doc,' + "`n" + '          spec.pageNo,' + "`n" + '          PACKET_PAGE_VALIDATION_TIMEOUT_MS,' + "`n" + '          PACKET_RENDER_VALIDATION_TIMEOUT_MS')) '元PDF検証へページ読込20秒と描画90秒を別々に渡していません。'
Assert-KoseiTest ($patched.Contains('Math.max(timeoutMs, PACKET_RENDER_VALIDATION_TIMEOUT_MS)')) '通常実行で描画専用上限を選ぶ処理がありません。'
Assert-KoseiTest ($patched.Contains('timeoutMs < PACKET_PAGE_VALIDATION_TIMEOUT_MS')) 'テスト等の明示的な短時間上限を維持する処理がありません。'
Assert-KoseiTest ($patched.Contains('spec.packetPageNo, timeoutMs, renderTimeoutMs')) '出力PDF検証へページ読込20秒と描画90秒を別々に渡していません。'

$otherHtml = '<html><body>report</body></html>'
Assert-KoseiTest ([string]::Equals((Convert-KoseiIndexHtmlForRuntime -Html $otherHtml -Silent), $otherHtml, [System.StringComparison]::Ordinal)) 'index.html 以外のHTMLを変更しました。'

$drifted = $raw.Replace('getViewport({ scale: 0.35 })', 'getViewport({ scale: 0.36 })')
$driftResult = Convert-KoseiIndexHtmlForRuntime -Html $drifted -Silent
Assert-KoseiTest ([string]::Equals($driftResult, $drifted, [System.StringComparison]::Ordinal)) '元HTMLとポリシーがずれた際に部分適用しました。'

$stream = New-Object System.IO.MemoryStream
$response = [pscustomobject]@{
    StatusCode = 0
    ContentType = ''
    Headers = @{}
    ContentLength64 = [long]0
    OutputStream = $stream
}
Send-KoseiRuntimeBytes -Response $response -StatusCode 200 -ContentType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($raw))
$served = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
Assert-KoseiTest ($response.StatusCode -eq 200) 'HTML応答のStatusCodeが維持されませんでした。'
Assert-KoseiTest ($response.ContentLength64 -eq [System.Text.Encoding]::UTF8.GetByteCount($served)) 'HTML応答のContent-Lengthが変換後本文と一致しません。'
Assert-KoseiTest ($served.Contains('const PACKET_RENDER_VALIDATION_TIMEOUT_MS = 90000;')) '実際のHTML応答へ描画専用上限が反映されませんでした。'
Assert-KoseiTest ($served.Contains('PACKET_PAGE_VALIDATION_TIMEOUT_MS,' + "`n" + '          PACKET_RENDER_VALIDATION_TIMEOUT_MS')) '実際のHTML応答で元PDF検証のtimeoutが分離されませんでした。'

# Server.ps1 が後から同名Functionを定義しても、Aliasが優先されることを確認する。
Set-Item -Path Function:Send-KoseiBytes -Value { throw '基準送信関数が呼ばれました。' }
$resolved = Get-Command -Name Send-KoseiBytes -ErrorAction Stop
Assert-KoseiTest ($resolved.CommandType -eq [System.Management.Automation.CommandTypes]::Alias) 'Server.ps1読込後に実行時送信Aliasが優先されません。'
Assert-KoseiTest ([string]::Equals([string]$resolved.Definition, 'Send-KoseiRuntimeBytes', [System.StringComparison]::OrdinalIgnoreCase)) 'Send-KoseiBytes Aliasの転送先が不正です。'

Write-Host 'Test-RuntimeHtmlPolicy: PASS' -ForegroundColor Green
