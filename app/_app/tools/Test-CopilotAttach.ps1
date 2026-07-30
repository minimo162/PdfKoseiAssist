param(
    # 添付テストに使うPDF。省略時は最小構成のテストPDFを自動生成します。
    [string]$PdfPath = '',
    # 添付テストに使うTXT。省略時はテストTXTを自動生成します。
    [string]$TextPath = '',
    # 本ツール専用のEdgeデバッグポート（他ツールと共有しない）
    [int]$CdpPort = 9444,
    [string]$CopilotUrl = 'https://m365.cloud.microsoft/chat/',
    # 添付完了（aria-live「アップロードが完了しました」）の最大待機秒数
    [int]$AttachWaitSeconds = 90,
    # Copilotチャット入力欄の検出待機秒数。初回はこの間にEdgeでサインインしてください。
    [int]$ReadyTimeoutSeconds = 300,
    # 指定するとテスト後に添付チップを削除しません（目視確認したい場合）
    [switch]$KeepAttachments
)

# =====================================================================
# Test-CopilotAttach.ps1 — PDF校正アシスト v94 Phase 0 検証スクリプト
# （自己完結版: 外部ツール・外部スクリプトに依存しません）
#
# 目的: CDP DOM.setFileInputFiles による M365 Copilot へのファイル添付
#       （モードA）が成立するかを判定する。
#
# 判定項目:
#   [1] #upload-file-button（input[type=file]）をDOMで特定できる
#   [2] DOM.setFileInputFiles がエラーなく受理される
#   [3] Copilot側のリスナーが発火し、添付チップ(.fai-Attachment)が出現する
#       ← モードA成立の分水嶺（唯一の未検証点）
#   [4] aria-live が「アップロードが完了しました」に到達する
#
# 実行例:
#   powershell -ExecutionPolicy Bypass -File .\Test-CopilotAttach.ps1
#
# 前提:
#   - Windows PowerShell 5.1 / Microsoft Edge
#   - 専用プロファイル（%USERPROFILE%\.pdf-kosei-ps\edge-profile）を使うため、
#     初回実行時は開いたEdgeウィンドウでM365 Copilotにサインインしてください。
#     スクリプトはサインイン完了（チャット入力欄の出現）まで待機します。
#
# 結果: コンソール要約 + %USERPROFILE%\.pdf-kosei-ps\logs\copilot-attach-test-*.jsonl
# =====================================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ---- セレクタ定義（v94 仕様書 §7 selectors と同一。UI変更時はここだけ直す） ----
$Selectors = @{
    file_input          = '#upload-file-button'
    file_input_fallback = 'input[type="file"][accept*="pdf"]'
    attachment_list_any = @('div[role="toolbar"][aria-label="添付ファイル"]', '[role="toolbar"][aria-label*="attach" i]', '.fai-AttachmentList')
    attachment_item_any = @('.fai-BebopAttachment', '.fai-Attachment', '[class*="Attachment"][data-overflow-item]')
    attachment_name_any = @('.fai-BebopAttachment__content > span:first-child', '.fai-Attachment__content span')
    attachment_list     = 'div[role="toolbar"][aria-label="添付ファイル"], [role="toolbar"][aria-label*="attach" i], .fai-AttachmentList'
    attachment_item     = '.fai-BebopAttachment, .fai-Attachment, [class*="Attachment"][data-overflow-item]'
    attachment_name     = '.fai-BebopAttachment__content > span:first-child, .fai-Attachment__content span'
    upload_done_pattern = '完了しました|upload(ed)?\s*(complete|finished)'
    upload_fail_pattern = '失敗|エラー|failed|error'
    chat_input_any      = @('#m365-chat-editor-target-element', '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]')
}

# ---- データディレクトリ（本ツール専用。他ツールのフォルダは使わない） ----
$DataDir    = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pdf-kosei-ps'
$LogsDir    = Join-Path $DataDir 'logs'
$UploadsDir = Join-Path $DataDir 'uploads'
$ProfileDir = Join-Path $DataDir 'edge-profile'
foreach ($d in @($DataDir, $LogsDir, $UploadsDir, $ProfileDir)) {
    if (!(Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$LogPath = Join-Path $LogsDir ("copilot-attach-test-{0}.jsonl" -f $Stamp)

function Write-TestEvent {
    param(
        [Parameter(Mandatory=$true)][string]$Event,
        $Data = @{},
        [string]$Level = 'INFO'
    )
    $record = [ordered]@{
        ts    = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fff')
        level = $Level
        event = $Event
    }
    foreach ($k in $Data.Keys) { $record[$k] = $Data[$k] }
    try {
        $json = $record | ConvertTo-Json -Depth 20 -Compress
        Add-Content -LiteralPath $LogPath -Value $json -Encoding UTF8
    } catch {}
    $prefix = switch ($Level) { 'ERROR' { '[NG] ' } 'WARN' { '[!]  ' } default { '     ' } }
    $detail = ''
    if ($Data.Count -gt 0) {
        try { $detail = ' ' + (($Data | ConvertTo-Json -Depth 6 -Compress)) } catch {}
        if ($detail.Length -gt 220) { $detail = $detail.Substring(0, 220) + '...' }
    }
    Write-Host ($prefix + $Event + $detail)
}

# =====================================================================
# 最小CDPクライアント（自己完結）
# =====================================================================
$script:KoseiCdpNextId = 41000

function Get-KoseiEdgePath {
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($root in $roots) {
        $p = Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $cmd = Get-Command 'msedge.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'Microsoft Edge が見つかりません。Edge をインストールするか、PATH に msedge.exe を追加してください。'
}

function Test-KoseiDevTools {
    param([int]$Port)
    try {
        $null = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return $true
    } catch { return $false }
}

function Wait-KoseiDevTools {
    param([int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-KoseiDevTools -Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Start-KoseiCopilotEdge {
    param([int]$Port, [string]$Url, [string]$UserDataDir)
    if (Test-KoseiDevTools -Port $Port) {
        Write-TestEvent 'edge-already-running' @{ port = $Port }
        return
    }
    $edge = Get-KoseiEdgePath
    $args = @(
        "--remote-debugging-port=$Port",
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        "--user-data-dir=$UserDataDir",
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        $Url
    )
    Write-TestEvent 'edge-launch' @{ path = $edge; port = $Port; profile = $UserDataDir }
    Start-Process -FilePath $edge -ArgumentList $args | Out-Null
    if (!(Wait-KoseiDevTools -Port $Port -TimeoutSeconds 30)) {
        throw "Edge DevTools Protocol が起動しませんでした。Port=$Port。この専用プロファイルで開いている既存のEdgeウィンドウをすべて閉じてから再実行してください。"
    }
}

function Get-KoseiCdpTargets {
    # PS 5.1 では Invoke-RestMethod がJSON配列を「1個の入れ子配列」として
    # 返すことがあるため、必ず1件ずつに平坦化してから返す。
    param([int]$Port)
    $raw = $null
    try { $raw = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5 } catch { return @() }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($item in @($raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Array]) {
            foreach ($inner in $item) { if ($null -ne $inner) { $out.Add($inner) } }
        } else {
            $out.Add($item)
        }
    }
    return $out.ToArray()
}

function Get-KoseiCopilotPage {
    param([int]$Port, [string]$Url)
    $host1 = ([Uri]$Url).Host
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $targets = @(Get-KoseiCdpTargets -Port $Port)
        $pages = @($targets | Where-Object {
            $_ -and
            ([string]$_.type) -eq 'page' -and
            (-not [string]::IsNullOrWhiteSpace([string]$_.webSocketDebuggerUrl)) -and
            (([string]$_.url) -like ("*" + $host1 + "*") -or ([string]$_.url) -like '*copilot*')
        })
        Write-TestEvent 'cdp-targets' @{ total = $targets.Count; matched = $pages.Count; urls = @($targets | ForEach-Object { ([string]$_.type) + ':' + ([string]$_.url) } | Select-Object -First 8) }
        if ($pages.Count -eq 0) {
            # 初回サインイン中はタブが login.microsoftonline.com 等へリダイレクト
            # されておりCopilot URLに一致しない。専用プロファイルで開いている
            # 通常のhttp(s)ページを候補として拾う（同一タブはサインイン完了後に
            # Copilotへ戻り、WebSocket URLは維持される）。
            $pages = @($targets | Where-Object {
                $_ -and
                ([string]$_.type) -eq 'page' -and
                (-not [string]::IsNullOrWhiteSpace([string]$_.webSocketDebuggerUrl)) -and
                (([string]$_.url) -like 'http*')
            })
            if ($pages.Count -gt 0) { Write-TestEvent 'cdp-target-fallback' @{ url = [string]$pages[0].url } 'WARN' }
        }
        if ($pages.Count -gt 0) { return $pages[0] }
        # 対象タブが無ければ作成を試みる（新しめのEdgeは PUT、古い版は GET）
        $created = $false
        foreach ($method in @('Put', 'Get')) {
            try {
                $null = Invoke-WebRequest -UseBasicParsing -Method $method -Uri ("http://127.0.0.1:$Port/json/new?" + [Uri]::EscapeUriString($Url)) -TimeoutSec 5
                $created = $true; break
            } catch {}
        }
        Write-TestEvent 'copilot-page-create' @{ attempt = $attempt; created = $created }
        Start-Sleep -Seconds 2
    }
    throw 'Copilotページ（CDPターゲット）を取得できませんでした。'
}

function Receive-KoseiWsMessage {
    param([Parameter(Mandatory=$true)]$WebSocket, [int]$TimeoutSeconds = 30)
    $buffer = New-Object byte[] 65536
    $ms = New-Object System.IO.MemoryStream
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter([TimeSpan]::FromSeconds([Math]::Max(1, $TimeoutSeconds)))
    try {
        do {
            $seg = [ArraySegment[byte]]::new($buffer)
            $res = $WebSocket.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
            if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
            if ($res.Count -gt 0) { $ms.Write($buffer, 0, $res.Count) }
        } while (-not $res.EndOfMessage)
        return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    } catch {
        return $null   # タイムアウト等。呼び出し側でループする
    } finally {
        try { $cts.Dispose() } catch {}
        try { $ms.Dispose() } catch {}
    }
}

function Connect-KoseiWebSocket {
    param([Parameter(Mandatory=$true)][string]$WebSocketUrl, [int]$TimeoutSeconds = 15)
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    # PS 5.1 はメソッドを実行時型で束縛するため、Task<VoidTaskResult> の
    # GetResult() が値をパイプラインへ流し、関数の戻り値を汚染する。
    # 非同期呼び出しの GetResult() は必ず $null = で受けること（v94共通規約）。
    try { $null = $ws.ConnectAsync([Uri]$WebSocketUrl, $cts.Token).GetAwaiter().GetResult() } finally { $cts.Dispose() }
    return $ws
}

function Invoke-KoseiCdpOnSocket {
    # 既存のWebSocket接続上でCDPメソッドを1つ実行し、応答(JSON)を返す。
    # nodeId はセッション（接続）スコープのため、DOM操作の連続実行はこの関数を
    # 同一 $WebSocket に対して繰り返し呼ぶこと。
    param(
        [Parameter(Mandatory=$true)]$WebSocket,
        [Parameter(Mandatory=$true)][string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSeconds = 30
    )
    $reqId = $script:KoseiCdpNextId
    $script:KoseiCdpNextId = $script:KoseiCdpNextId + 1
    $payload = @{ id = $reqId; method = $Method; params = $Params } | ConvertTo-Json -Depth 30 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $seg = [ArraySegment[byte]]::new($bytes)
    $sendCts = [System.Threading.CancellationTokenSource]::new()
    $sendCts.CancelAfter([TimeSpan]::FromSeconds(15))
    try { $null = $WebSocket.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $sendCts.Token).GetAwaiter().GetResult() } finally { $sendCts.Dispose() }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $remaining = [int][Math]::Max(1, [Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
        $message = Receive-KoseiWsMessage -WebSocket $WebSocket -TimeoutSeconds $remaining
        if ([string]::IsNullOrWhiteSpace($message)) { continue }
        $obj = $null
        try { $obj = $message | ConvertFrom-Json } catch { continue }
        if ($obj -and ($obj.PSObject.Properties.Name -contains 'id') -and $obj.id -eq $reqId) { return $obj }
        # id不一致はCDPイベント通知なので読み飛ばす
    }
    throw "CDP応答タイムアウト: $Method"
}

function Invoke-KoseiCdpEval {
    # 単発のJavaScript評価（接続は都度使い捨てで良い）
    param(
        [Parameter(Mandatory=$true)][string]$WebSocketUrl,
        [Parameter(Mandatory=$true)][string]$Expression,
        [int]$TimeoutSeconds = 30
    )
    $ws = Connect-KoseiWebSocket -WebSocketUrl $WebSocketUrl
    try {
        $resp = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Runtime.evaluate' -Params @{
            expression    = $Expression
            awaitPromise  = $true
            returnByValue = $true
            userGesture   = $true
        } -TimeoutSeconds $TimeoutSeconds
        if ($resp.error) { throw ($resp.error | ConvertTo-Json -Compress) }
        if ($resp.result.exceptionDetails) {
            throw ('JavaScript evaluation failed: ' + ($resp.result.exceptionDetails | ConvertTo-Json -Depth 20 -Compress))
        }
        return $resp.result.result.value
    } finally {
        try { $ws.Dispose() } catch {}
    }
}

# =====================================================================
# テスト用ファイルの準備
# =====================================================================
function New-KoseiTestPdf {
    param([Parameter(Mandatory=$true)][string]$Path)
    # 依存ライブラリなしで最小構成の正当なPDF（1ページ・テキスト1行）を生成する。
    $ascii = [System.Text.Encoding]::ASCII
    $content = "BT /F1 24 Tf 72 720 Td (PDF Kosei Attach Test $Stamp) Tj ET"
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
    return $Path
}

if ([string]::IsNullOrWhiteSpace($PdfPath)) {
    $PdfPath = Join-Path $UploadsDir ("ATTACHTEST_{0}_PACKET.pdf" -f $Stamp)
    New-KoseiTestPdf -Path $PdfPath | Out-Null
    Write-TestEvent 'sample-pdf-created' @{ path = $PdfPath; bytes = (Get-Item -LiteralPath $PdfPath).Length }
}
if ([string]::IsNullOrWhiteSpace($TextPath)) {
    $TextPath = Join-Path $UploadsDir ("ATTACHTEST_{0}_TEXT.txt" -f $Stamp)
    $txtBody = "PAGE_MAP: attach test`nこれはPDF校正アシスト v94 の添付検証用テキストです。`nTARGET_CHECK_FAST_REVIEW_INDEX: (test only)`n"
    [System.IO.File]::WriteAllText($TextPath, $txtBody, (New-Object System.Text.UTF8Encoding($true)))
    Write-TestEvent 'sample-text-created' @{ path = $TextPath }
}
foreach ($f in @($PdfPath, $TextPath)) {
    if (!(Test-Path -LiteralPath $f -PathType Leaf)) { throw "添付対象ファイルが見つかりません: $f" }
}
$AttachFiles = @(
    ([System.IO.Path]::GetFullPath($PdfPath)),
    ([System.IO.Path]::GetFullPath($TextPath))
)
$ExpectedNames = @($AttachFiles | ForEach-Object { [System.IO.Path]::GetFileName($_) })
Write-TestEvent 'attach-targets' @{ files = $AttachFiles }

# =====================================================================
# ページ側JavaScript
# =====================================================================
$ReadyJsTemplate = @'
(() => {
  const sels = __INPUT_SELS__;
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null) return JSON.stringify({ ready: true, sel: s, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href, title: document.title });
})()
'@

$SnapshotJsTemplate = @'
(() => {
  const itemSel = __ITEM_SEL__;
  const nameSel = __NAME_SEL__;
  const inputSel = __INPUT_SEL__;
  const listSel = __LIST_SEL__;
  const items = [];
  const lists = Array.from(document.querySelectorAll(listSel)).filter(x => x.offsetParent !== null);
  const list = lists.length ? lists[lists.length - 1] : null;
  const scope = list || document;
  scope.querySelectorAll(itemSel).forEach(el => {
    const nameEl = el.querySelector(nameSel);
    const liveEl = el.querySelector('[aria-live]');
    items.push({
      name: nameEl ? nameEl.textContent.trim() : '',
      live: liveEl ? liveEl.textContent.trim() : ''
    });
  });
  const input = document.querySelector(inputSel);
  return JSON.stringify({
    count: items.length,
    items: items,
    inputExists: !!input,
    listHtml: list ? list.outerHTML.slice(0, 4000) : ''
  });
})()
'@

$RemoveJsTemplate = @'
(() => {
  const names = __NAMES_JSON__;
  const itemSel = __ITEM_SEL__;
  const nameSel = __NAME_SEL__;
  let removed = 0;
  const lists = Array.from(document.querySelectorAll(__LIST_SEL__)).filter(x => x.offsetParent !== null);
  const scope = lists.length ? lists[lists.length - 1] : document;
  scope.querySelectorAll(itemSel).forEach(el => {
    const nameEl = el.querySelector(nameSel);
    const name = nameEl ? nameEl.textContent.trim() : '';
    if (!names.includes(name)) return;
    const btn = el.querySelector('button[aria-label*="削除"], button[aria-label*="remove" i], button[aria-label*="dismiss" i]');
    if (btn) { btn.click(); removed++; }
  });
  return JSON.stringify({ removed: removed });
})()
'@

function Get-KoseiAttachmentSnapshot {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [switch]$IncludeHtml)
    $js = $SnapshotJsTemplate.
        Replace('__ITEM_SEL__',  (ConvertTo-Json ([string]$Selectors.attachment_item))).
        Replace('__NAME_SEL__',  (ConvertTo-Json ([string]$Selectors.attachment_name))).
        Replace('__INPUT_SEL__', (ConvertTo-Json ([string]$Selectors.file_input))).
        Replace('__LIST_SEL__',  (ConvertTo-Json ([string]$Selectors.attachment_list)))
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $snap = $raw | ConvertFrom-Json
    if (-not $IncludeHtml) { $snap.listHtml = '' }
    return $snap
}

function Wait-KoseiCopilotInputReady {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [int]$TimeoutSeconds)
    $selsJson = ConvertTo-Json @([string[]]$Selectors.chat_input_any) -Compress
    $js = $ReadyJsTemplate.Replace('__INPUT_SELS__', $selsJson)
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
    $lastLog = [datetime]'2000-01-01'
    $notified = $false
    while ((Get-Date) -lt $deadline) {
        $state = $null
        $evalError = ''
        try { $state = (Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15) | ConvertFrom-Json } catch { $evalError = $_.Exception.Message }
        if ($state -and $state.ready -eq $true) {
            Write-TestEvent 'copilot-ready' @{ selector = [string]$state.sel; url = [string]$state.url }
            return $true
        }
        if (((Get-Date) - $lastLog).TotalSeconds -ge 10) {
            $lastLog = Get-Date
            $u = ''
            if ($state) { $u = [string]$state.url }
            Write-TestEvent 'copilot-waiting' @{ url = $u; evalError = $evalError }
            if (-not $notified) {
                Write-Host ''
                Write-Host '>>> Copilotのチャット入力欄を待っています。サインイン画面が出ている場合は、開いたEdgeでサインインしてください。'
                Write-Host ''
                $notified = $true
            }
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

# =====================================================================
# 同一CDPセッションでのDOM添付操作
# =====================================================================
function Invoke-KoseiCdpAttachSession {
    param(
        [Parameter(Mandatory=$true)][string]$WebSocketUrl,
        [Parameter(Mandatory=$true)][string]$Selector,
        [Parameter(Mandatory=$true)][string]$FallbackSelector,
        [Parameter(Mandatory=$true)][string[]]$Files
    )
    $result = [ordered]@{ ok = $false; selectorUsed = ''; nodeId = 0; error = ''; steps = @() }
    $ws = $null
    try {
        $ws = Connect-KoseiWebSocket -WebSocketUrl $WebSocketUrl

        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.enable'
        $result.steps += @{ step = 'DOM.enable'; error = [string]$r.error }

        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.getDocument' -Params @{ depth = 1 }
        if ($r.error) { throw ('DOM.getDocument failed: ' + ($r.error | ConvertTo-Json -Compress)) }
        $rootId = [int]$r.result.root.nodeId
        $result.steps += @{ step = 'DOM.getDocument'; rootNodeId = $rootId }

        $nodeId = 0
        foreach ($sel in @($Selector, $FallbackSelector)) {
            $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.querySelector' -Params @{ nodeId = $rootId; selector = $sel }
            $found = 0
            if (-not $r.error -and $r.result -and $r.result.nodeId) { $found = [int]$r.result.nodeId }
            $result.steps += @{ step = 'DOM.querySelector'; selector = $sel; nodeId = $found; error = [string]$r.error }
            if ($found -gt 0) { $nodeId = $found; $result.selectorUsed = $sel; break }
        }
        if ($nodeId -le 0) { throw ("file input が見つかりません。selector=" + $Selector + " / fallback=" + $FallbackSelector) }
        $result.nodeId = $nodeId

        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.setFileInputFiles' -Params @{ nodeId = $nodeId; files = $Files }
        if ($r.error) { throw ('DOM.setFileInputFiles failed: ' + ($r.error | ConvertTo-Json -Compress)) }
        $result.steps += @{ step = 'DOM.setFileInputFiles'; files = $Files }
        $result.ok = $true
    } catch {
        $result.error = $_.Exception.Message
    } finally {
        if ($null -ne $ws) { try { $ws.Dispose() } catch {} }
    }
    return [pscustomobject]$result
}

# =====================================================================
# メイン
# =====================================================================
$verdict = [ordered]@{
    input_found        = $false   # [1]
    set_files_accepted = $false   # [2]
    chips_appeared     = $false   # [3] ← 分水嶺
    upload_completed   = $false   # [4]
    selector_used      = ''
    chips_ms           = -1
    complete_ms        = -1
    per_file           = @()
}
$exitCode = 1
try {
    Write-Host ''
    Write-Host '=== PDF校正アシスト v94 / Copilot添付検証 (Phase 0) ==='
    Write-Host ("ログ: " + $LogPath)
    Write-Host ''

    # 1) 専用プロファイルでEdge起動 → Copilotページ取得
    Start-KoseiCopilotEdge -Port $CdpPort -Url $CopilotUrl -UserDataDir $ProfileDir
    $page = Get-KoseiCopilotPage -Port $CdpPort -Url $CopilotUrl
    $wsUrl = [string]$page.webSocketDebuggerUrl
    Write-TestEvent 'copilot-page' @{ url = [string]$page.url; title = [string]$page.title }

    # 2) チャット入力欄の検出（初回はここでサインイン待ち）
    if (-not (Wait-KoseiCopilotInputReady -WsUrl $wsUrl -TimeoutSeconds $ReadyTimeoutSeconds)) {
        throw ('Copilotのチャット入力欄を {0} 秒以内に検出できませんでした。Edge画面でサインインを完了してから再実行してください。' -f $ReadyTimeoutSeconds)
    }

    # 3) ベースライン取得（既存の添付チップ／同名チップの警告）
    $baseline = Get-KoseiAttachmentSnapshot -WsUrl $wsUrl
    Write-TestEvent 'baseline' @{ count = [int]$baseline.count; inputExists = [bool]$baseline.inputExists }
    foreach ($n in $ExpectedNames) {
        $dup = @($baseline.items | Where-Object { $_.name -eq $n })
        if ($dup.Count -gt 0) { Write-TestEvent 'baseline-name-collision' @{ name = $n } 'WARN' }
    }

    # 4) 同一セッションで setFileInputFiles（判定 [1][2]）
    $swAll = [System.Diagnostics.Stopwatch]::StartNew()
    $attach = Invoke-KoseiCdpAttachSession -WebSocketUrl $wsUrl `
        -Selector ([string]$Selectors.file_input) `
        -FallbackSelector ([string]$Selectors.file_input_fallback) `
        -Files $AttachFiles
    Write-TestEvent 'set-file-input-files' @{ ok = [bool]$attach.ok; selector = [string]$attach.selectorUsed; nodeId = [int]$attach.nodeId; error = [string]$attach.error; steps = $attach.steps }
    if ($attach.nodeId -gt 0) { $verdict.input_found = $true; $verdict.selector_used = [string]$attach.selectorUsed }
    if (-not $attach.ok) { throw ("setFileInputFiles に失敗: " + $attach.error) }
    $verdict.set_files_accepted = $true

    # 5) チップ出現と完了文言の監視（判定 [3][4]）
    $doneRe = [regex]::new([string]$Selectors.upload_done_pattern, 'IgnoreCase')
    $failRe = [regex]::new([string]$Selectors.upload_fail_pattern, 'IgnoreCase')
    $deadline = (Get-Date).AddSeconds([Math]::Max(15, $AttachWaitSeconds))
    $lastSnap = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $snap = Get-KoseiAttachmentSnapshot -WsUrl $wsUrl
        $lastSnap = $snap
        $mine = @($snap.items | Where-Object { $ExpectedNames -contains $_.name })
        if ((-not $verdict.chips_appeared) -and $mine.Count -gt 0) {
            $verdict.chips_appeared = $true
            $verdict.chips_ms = [int]$swAll.ElapsedMilliseconds
            Write-TestEvent 'chips-appeared' @{ elapsedMs = $verdict.chips_ms; found = @($mine | ForEach-Object { $_.name }) }
        }
        $failed = @($mine | Where-Object { $_.live -and $failRe.IsMatch([string]$_.live) })
        if ($failed.Count -gt 0) {
            Write-TestEvent 'upload-failed-text' @{ items = $failed } 'ERROR'
            throw ("アップロード失敗の文言を検出: " + (($failed | ForEach-Object { $_.name + ' => ' + $_.live }) -join ' | '))
        }
        $doneNames = @($mine | Where-Object { $_.live -and $doneRe.IsMatch([string]$_.live) } | ForEach-Object { $_.name })
        $allDone = $true
        foreach ($n in $ExpectedNames) { if ($doneNames -notcontains $n) { $allDone = $false } }
        if ($mine.Count -ge $ExpectedNames.Count -and $allDone) {
            $verdict.upload_completed = $true
            $verdict.complete_ms = [int]$swAll.ElapsedMilliseconds
            $verdict.per_file = @($mine | ForEach-Object { @{ name = $_.name; live = $_.live } })
            Write-TestEvent 'upload-completed' @{ elapsedMs = $verdict.complete_ms; items = $verdict.per_file }
            break
        }
    }
    if (-not $verdict.upload_completed) {
        $htmlSnap = Get-KoseiAttachmentSnapshot -WsUrl $wsUrl -IncludeHtml
        $lastItems = @()
        if ($lastSnap) { $lastItems = $lastSnap.items }
        Write-TestEvent 'upload-timeout' @{ lastItems = $lastItems; listHtml = [string]$htmlSnap.listHtml } 'ERROR'
        throw ("完了文言を {0} 秒以内に検出できませんでした。JSONLログの listHtml を確認してください。" -f $AttachWaitSeconds)
    }

    # 6) 後片付け（既定: 自分が付けたチップのみ削除）
    if (-not $KeepAttachments) {
        $js = $RemoveJsTemplate.
            Replace('__NAMES_JSON__', (ConvertTo-Json $ExpectedNames -Compress)).
            Replace('__ITEM_SEL__',   (ConvertTo-Json ([string]$Selectors.attachment_item))).
            Replace('__NAME_SEL__',   (ConvertTo-Json ([string]$Selectors.attachment_name))).
            Replace('__LIST_SEL__',   (ConvertTo-Json ([string]$Selectors.attachment_list)))
        $removedRaw = Invoke-KoseiCdpEval -WebSocketUrl $wsUrl -Expression $js -TimeoutSeconds 20
        Write-TestEvent 'cleanup' @{ result = $removedRaw }
    } else {
        Write-TestEvent 'cleanup-skipped' @{ reason = 'KeepAttachments' }
    }

    $exitCode = 0
} catch {
    Write-TestEvent 'fatal' @{ message = $_.Exception.Message } 'ERROR'
} finally {
    Write-TestEvent 'verdict' $verdict
    Write-Host ''
    Write-Host '=== 判定結果 ==='
    $fmt = { param($ok) if ($ok) { 'PASS' } else { 'FAIL' } }
    Write-Host ("[1] file input 特定           : {0}  (selector: {1})" -f (& $fmt $verdict.input_found), $verdict.selector_used)
    Write-Host ("[2] setFileInputFiles 受理    : {0}" -f (& $fmt $verdict.set_files_accepted))
    Write-Host ("[3] 添付チップ出現 (分水嶺)    : {0}  ({1} ms)" -f (& $fmt $verdict.chips_appeared), $verdict.chips_ms)
    Write-Host ("[4] アップロード完了文言       : {0}  ({1} ms)" -f (& $fmt $verdict.upload_completed), $verdict.complete_ms)
    Write-Host ''
    if ($exitCode -eq 0) {
        Write-Host '結論: モードA（PDF添付モード）は成立します。v94仕様書 §3.3 のとおり実装へ進めます。'
        Write-Host '次の確認（任意）: 実パケットPDFを -PdfPath に指定して、サイズ上限・所要時間を実測してください。'
    } elseif ($verdict.set_files_accepted -and -not $verdict.chips_appeared) {
        Write-Host '結論: setFileInputFiles は受理されましたが、Copilot側のリスナーが発火していません。'
        Write-Host '対処: JSONLログを添えて報告してください。ドロップ合成（予備経路）またはモードB既定化を判断します。'
    } else {
        Write-Host '結論: 失敗しました。JSONLログ（特に listHtml / steps / fatal）を確認してください。'
    }
    Write-Host ("ログ: " + $LogPath)
}
exit $exitCode
