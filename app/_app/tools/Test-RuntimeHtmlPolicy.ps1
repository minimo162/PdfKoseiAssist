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

# 表示確認はソース直蔵のoperatorList検証に移行したため、現在適用すべき置換はない。
# ポリシー機構とdrift検査の土台は将来のホットパッチ向けに維持する。
$policy = Get-KoseiRuntimeHtmlPolicy
Assert-KoseiTest ((@($policy.replacements).Count) -eq 0) '実行時HTMLポリシーのreplacementsが空ではありません。'
Assert-KoseiTest ([string]$policy.source_marker -eq 'function validatePdfJsRenderablePage') 'source_markerが不正です。'

$raw = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
$patched = Convert-KoseiIndexHtmlForRuntime -Html $raw -Silent
Assert-KoseiTest ([string]::Equals($patched, $raw, [System.StringComparison]::Ordinal)) '適用箇所が空のポリシーでindex.htmlが変更されました。'

Assert-KoseiTest ($patched.Contains('const PACKET_PAGE_VALIDATION_TIMEOUT_MS = 20000;')) 'ページ読込・テキスト確認の20秒上限が失われました。'
Assert-KoseiTest ($patched.Contains('const PACKET_RENDER_VALIDATION_TIMEOUT_MS = 90000;')) '表示確認専用の90秒上限がソースにありません。'
# ビューア等にも page.render は存在するため、表示確認関数のスライスに限定して判定する。
$fnStart = $patched.IndexOf('async function validatePdfJsRenderablePage', [System.StringComparison]::Ordinal)
Assert-KoseiTest ($fnStart -ge 0) '表示確認関数が見つかりません。'
$fnEnd = $patched.IndexOf('function normalizeTextLayerProbe', $fnStart, [System.StringComparison]::Ordinal)
Assert-KoseiTest ($fnEnd -gt $fnStart) '表示確認関数を切り出せません。'
$validateFn = $patched.Substring($fnStart, $fnEnd - $fnStart)
Assert-KoseiTest ($validateFn.Contains('page.getOperatorList()')) '表示確認がoperatorList検証（worker駆動）になっていません。'
Assert-KoseiTest (-not $validateFn.Contains('page.render(')) 'canvas描画による表示確認が残っています。'
Assert-KoseiTest (-not $validateFn.Contains('getViewport(')) '検証用のviewport生成が残っています。'
Assert-KoseiTest ($patched.Contains('for (let attempt = 1; attempt <= 2; attempt += 1)')) 'timeout時の限定再試行がありません。'
Assert-KoseiTest ($patched.Contains('pageLabel = ""')) '表示確認メッセージの役割ラベル引数がありません。'
Assert-KoseiTest ($patched.Contains('${spec.role} P.${spec.pageNo}')) '元PDF検証のエラー文に役割が含まれていません。'
Assert-KoseiTest ($patched.Contains('${spec.role} 出力PDF P.${spec.packetPageNo}')) '出力PDF検証のエラー文に役割が含まれていません。'
Assert-KoseiTest (-not $validateFn.Contains('document.hidden')) 'worker駆動検証に背面タブ依存が残っています。'
Assert-KoseiTest (-not $patched.Contains('表示確認を継続できません')) 'operatorList検証では不要な背面ガードが残っています。'
Assert-KoseiTest ($patched.Contains('error.packetValidationTimeout = true;')) 'timeoutエラーの再試行判定印がありません。'
Assert-KoseiTest ($patched.Contains('spec.doc,' + "`n" + '          spec.pageNo,' + "`n" + '          PACKET_PAGE_VALIDATION_TIMEOUT_MS,' + "`n" + '          PACKET_RENDER_VALIDATION_TIMEOUT_MS,')) '元PDF検証へページ読込20秒と表示確認90秒を別々に渡していません。'
Assert-KoseiTest ($patched.Contains('Math.max(timeoutMs, PACKET_RENDER_VALIDATION_TIMEOUT_MS)')) '通常実行で表示確認専用上限を選ぶ処理がありません。'
Assert-KoseiTest ($patched.Contains('timeoutMs < PACKET_PAGE_VALIDATION_TIMEOUT_MS')) 'テスト等の明示的な短時間上限を維持する処理がありません。'
Assert-KoseiTest ($patched.Contains('spec.packetPageNo, timeoutMs, opListTimeoutMs')) '出力PDF検証へページ読込20秒と表示確認90秒を別々に渡していません。'

$otherHtml = '<html><body>report</body></html>'
Assert-KoseiTest ([string]::Equals((Convert-KoseiIndexHtmlForRuntime -Html $otherHtml -Silent), $otherHtml, [System.StringComparison]::Ordinal)) 'index.html 以外のHTMLを変更しました。'

# 一致数カウンタの基本挙動（将来ポリシーへ置換を戻す際のall-or-nothingの土台）。
Assert-KoseiTest ((Get-KoseiLiteralMatchCount -Text 'aXbXc' -Needle 'X') -eq 2) '一致数カウントが不正です。'
Assert-KoseiTest ((Get-KoseiLiteralMatchCount -Text 'aaa' -Needle 'aa') -eq 1) '重複一致の数え方が不正です。'
Assert-KoseiTest ((Get-KoseiLiteralMatchCount -Text 'abc' -Needle '') -eq 0) '空needleの扱いが不正です。'

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
Assert-KoseiTest ([string]::Equals($served, $raw, [System.StringComparison]::Ordinal)) '空ポリシーの実配信でindex.html本文が変わりました。'
Assert-KoseiTest ($response.ContentLength64 -eq [System.Text.Encoding]::UTF8.GetByteCount($served)) 'HTML応答のContent-Lengthが本文と一致しません。'

# Server.ps1 が後から同名Functionを定義しても、Aliasが優先されることを確認する。
Set-Item -Path Function:Send-KoseiBytes -Value { throw '基準送信関数が呼ばれました。' }
$resolved = Get-Command -Name Send-KoseiBytes -ErrorAction Stop
Assert-KoseiTest ($resolved.CommandType -eq [System.Management.Automation.CommandTypes]::Alias) 'Server.ps1読込後に実行時送信Aliasが優先されません。'
Assert-KoseiTest ([string]::Equals([string]$resolved.Definition, 'Send-KoseiRuntimeBytes', [System.StringComparison]::OrdinalIgnoreCase)) 'Send-KoseiBytes Aliasの転送先が不正です。'

Write-Host 'Test-RuntimeHtmlPolicy: PASS' -ForegroundColor Green
