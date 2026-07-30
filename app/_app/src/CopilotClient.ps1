# =====================================================================
# CopilotClient.ps1 — M365 Copilot CDP自動操作（自己完結）
#
# Phase 0（Test-CopilotAttach.ps1、2026-07-03 全判定PASS）で実証したCDPコアを
# 基盤に、依頼文入力・送信・応答待機・JSON抽出を実装する。
#
# PS 5.1 実装規約（仕様書 §8）:
#  1. 非同期の .GetAwaiter().GetResult() は必ず $null = または変数代入で受ける
#     （実行時型 Task<VoidTaskResult> が戻り値をパイプライン汚染するため）
#  2. Invoke-RestMethod のJSON配列応答は必ず平坦化してから使う
#  3. CDPの nodeId はセッションスコープ。DOM操作列は同一WebSocket上で実行する
#  4. サインイン中は login.microsoftonline.com へ遷移するため、ターゲット選択は
#     Copilot URL一致 → 通常http(s)ページ の順でフォールバックする
# =====================================================================

$script:KoseiCdpNextId = 41000
$script:KoseiPageCheckFieldPriority = @('pages_checked','checked_pages','checked_page_summaries')
$script:KoseiWindowStateResetDone = $false

# ---------------------------------------------------------------------
# Edge / DevTools
# ---------------------------------------------------------------------
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

function Set-KoseiEdgeWindowMinimized {
    param([Parameter(Mandatory=$true)]$Settings, [AllowNull()]$Page=$null,[string]$Reason='job-start')
    $display='minimized';try{$display=[string]$Settings.browser_display_mode}catch{}
    if($display -eq 'foreground'){return $false}
    $port=[int]$Settings.cdp_port;$ws=$null
    try{
        if($null -eq $Page){$Page=Get-KoseiCopilotPage -Settings $Settings}
        $version=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
        $browserWs=[string]$version.webSocketDebuggerUrl
        if([string]::IsNullOrWhiteSpace($browserWs)){throw 'browser WebSocket URLなし'}
        $targetId=[string]$Page.id;if([string]::IsNullOrWhiteSpace($targetId)){throw 'targetIdなし'}
        $ws=Connect-KoseiWebSocket -WebSocketUrl $browserWs
        $got=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowForTarget' -Params @{targetId=$targetId} -TimeoutSeconds 10
        if($got.error){throw ($got.error|ConvertTo-Json -Compress)}
        $windowId=[int]$got.result.windowId
        $bounds=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowBounds' -Params @{windowId=$windowId} -TimeoutSeconds 10
        if($bounds.error){throw ($bounds.error|ConvertTo-Json -Compress)}
        $state=[string]$bounds.result.bounds.windowState
        if($state -eq 'minimized'){Write-KoseiLog "Edge最小化スキップ state=minimized reason=$Reason" 'DEBUG';return $true}
        $visibleFlag=Join-Path (Get-KoseiSubDir 'runtime') 'copilot-user-visible.flag'
        if($Reason -ne 'startup' -and (Test-Path -LiteralPath $visibleFlag)){
            Write-KoseiLog "Edge最小化スキップ state=$state reason=user-visible" 'DEBUG';return $false
        }
        # 座標には一切触れず、状態だけを直接最小化する。normal化による画面フラッシュを防ぐ。
        $set=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='minimized'}} -TimeoutSeconds 10
        if($set.error){throw ($set.error|ConvertTo-Json -Compress)}
        Write-KoseiLog "Edgeウィンドウ最小化($state→minimized) windowId=$windowId reason=$Reason" 'INFO';return $true
    }catch{Write-KoseiLog ("Edgeウィンドウ最小化に失敗（処理は継続）: "+$_.Exception.Message) 'WARN';return $false}
    finally{if($ws){try{$ws.Dispose()}catch{}}}
}

function Show-KoseiCopilotEdgeWindow {
    param([Parameter(Mandatory=$true)]$Settings)
    $port=[int]$Settings.cdp_port;$ws=$null
    if(-not (Test-KoseiDevTools -Port $port)){Start-KoseiCopilotEdge -Settings $Settings}
    try{
        $page=Get-KoseiCopilotPage -Settings $Settings
        $version=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
        $ws=Connect-KoseiWebSocket -WebSocketUrl ([string]$version.webSocketDebuggerUrl)
        $got=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowForTarget' -Params @{targetId=[string]$page.id} -TimeoutSeconds 10
        if($got.error){throw ($got.error|ConvertTo-Json -Compress)}
        $windowId=[int]$got.result.windowId
        # 状態変更と座標変更は別呼び出しにし、CDP実装差を回避する。
        $normal=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='normal'}} -TimeoutSeconds 10
        if($normal.error){throw ($normal.error|ConvertTo-Json -Compress)}
        $position=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{left=120;top=120;width=1280;height=900}} -TimeoutSeconds 10
        if($position.error){throw ($position.error|ConvertTo-Json -Compress)}
        [System.IO.File]::WriteAllText((Join-Path (Get-KoseiSubDir 'runtime') 'copilot-user-visible.flag'),(Get-Date).ToString('s'),(New-Object System.Text.UTF8Encoding($false)))
        Write-KoseiLog "Copilot画面を表示 windowId=$windowId bounds=120,120,1280,900" 'INFO'
        return $true
    }finally{if($ws){try{$ws.Dispose()}catch{}}}
}

function Reset-KoseiEdgeWindowStateForDetection {
    param([Parameter(Mandatory=$true)]$Settings)
    if ($script:KoseiWindowStateResetDone) { return $false }
    $script:KoseiWindowStateResetDone = $true
    if ([string]$Settings.browser_display_mode -eq 'foreground') { return $false }
    $ws=$null
    try {
        $page=Get-KoseiCopilotPage -Settings $Settings
        $version=Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f [int]$Settings.cdp_port) -TimeoutSec 5
        $ws=Connect-KoseiWebSocket -WebSocketUrl ([string]$version.webSocketDebuggerUrl)
        $got=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.getWindowForTarget' -Params @{targetId=[string]$page.id} -TimeoutSeconds 10
        if($got.error){throw ($got.error|ConvertTo-Json -Compress)}
        $windowId=[int]$got.result.windowId
        $r=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='normal'}} -TimeoutSeconds 10
        if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
        $r=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{left=120;top=120;width=1280;height=900}} -TimeoutSeconds 10
        if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
        $r=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Browser.setWindowBounds' -Params @{windowId=$windowId;bounds=@{windowState='minimized'}} -TimeoutSeconds 10
        if($r.error){throw ($r.error|ConvertTo-Json -Compress)}
        Write-KoseiLog 'ウィンドウ状態リセット実施' 'INFO'
        return $true
    } catch { Write-KoseiLog ('ウィンドウ状態リセット失敗（処理は継続）: '+$_.Exception.Message) 'WARN'; return $false }
    finally { if($ws){try{$ws.Dispose()}catch{}} }
}

function Get-KoseiEdgeProfileDir {
    return (Get-KoseiSubDir 'edge-profile')
}

function Start-KoseiCopilotEdge {
    param([Parameter(Mandatory=$true)]$Settings)
    $port = [int]$Settings.cdp_port
    $url = [string]$Settings.copilot_url
    if (Test-KoseiDevTools -Port $port) { return }
    $edge = Get-KoseiEdgePath
    $userData = Get-KoseiEdgeProfileDir
    $args = @(
        "--remote-debugging-port=$port",
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        "--user-data-dir=$userData",
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate'
    )
    $display = 'minimized'; try { $display = [string]$Settings.browser_display_mode } catch {}
    if ($display -ne 'foreground') { $display = 'minimized' }
    if ($display -eq 'minimized') { $args += '--window-position=-32000,-32000'; $args += '--window-size=1280,900' }
    $args += $url
    Write-KoseiLog "Edge起動$(if($display -eq 'minimized'){'(画面外)'}else{''}): port=$port profile=$userData display=$display" 'INFO'
    try {
        if ($display -eq 'minimized') { Start-Process -FilePath $edge -ArgumentList $args -WindowStyle Minimized | Out-Null }
        else { Start-Process -FilePath $edge -ArgumentList $args | Out-Null }
    } catch {
        if($display -ne 'minimized'){throw}
        Write-KoseiLog ("Edge画面外起動に失敗。引数なし最小化へフォールバック: "+$_.Exception.Message) 'WARN'
        $fallbackArgs=@($args|Where-Object{$_ -notlike '--window-position=*' -and $_ -notlike '--window-size=*'})
        Start-Process -FilePath $edge -ArgumentList $fallbackArgs -WindowStyle Minimized | Out-Null
    }
    if (!(Wait-KoseiDevTools -Port $port -TimeoutSeconds 30)) {
        throw "Edge DevTools Protocol が起動しませんでした。Port=$port。この専用プロファイルの既存Edgeウィンドウをすべて閉じてから再実行してください。"
    }
    try{$page=Get-KoseiCopilotPage -Settings $Settings;$null=Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'startup'}catch{}
}

# ---------------------------------------------------------------------
# CDPターゲット選択（規約2・4）
# ---------------------------------------------------------------------
function Get-KoseiCdpTargets {
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
    param([Parameter(Mandatory=$true)]$Settings)
    $port = [int]$Settings.cdp_port
    $url = [string]$Settings.copilot_url
    $host1 = ([Uri]$url).Host
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $targets = @(Get-KoseiCdpTargets -Port $port)
        $pages = @($targets | Where-Object {
            $_ -and
            ([string]$_.type) -eq 'page' -and
            (-not [string]::IsNullOrWhiteSpace([string]$_.webSocketDebuggerUrl)) -and
            (([string]$_.url) -like ("*" + $host1 + "*") -or ([string]$_.url) -like '*copilot*')
        })
        if ($pages.Count -eq 0) {
            # サインインリダイレクト中のフォールバック（規約4）
            $pages = @($targets | Where-Object {
                $_ -and
                ([string]$_.type) -eq 'page' -and
                (-not [string]::IsNullOrWhiteSpace([string]$_.webSocketDebuggerUrl)) -and
                (([string]$_.url) -like 'http*')
            })
        }
        if ($pages.Count -gt 0) { return $pages[0] }
        $created = $false
        foreach ($method in @('Put', 'Get')) {
            try {
                $null = Invoke-WebRequest -UseBasicParsing -Method $method -Uri ("http://127.0.0.1:$port/json/new?" + [Uri]::EscapeUriString($url)) -TimeoutSec 5
                $created = $true; break
            } catch {}
        }
        Write-KoseiLog "Copilotタブが無いため作成を試行 attempt=$attempt created=$created" 'WARN'
        Start-Sleep -Seconds 2
    }
    throw 'Copilotページ（CDPターゲット）を取得できませんでした。'
}

# ---------------------------------------------------------------------
# WebSocket / CDPメソッド
# ---------------------------------------------------------------------
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
        return $null
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
    try { $null = $ws.ConnectAsync([Uri]$WebSocketUrl, $cts.Token).GetAwaiter().GetResult() } finally { $cts.Dispose() }
    return $ws
}

function Invoke-KoseiCdpOnSocket {
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
    }
    throw "CDP応答タイムアウト: $Method"
}

function Invoke-KoseiCdpMethod {
    # 単発CDPメソッド（接続使い捨て。DOM操作の連続には使わないこと=規約3）
    param(
        [Parameter(Mandatory=$true)][string]$WebSocketUrl,
        [Parameter(Mandatory=$true)][string]$Method,
        [hashtable]$Params = @{},
        [int]$TimeoutSeconds = 30
    )
    $ws = Connect-KoseiWebSocket -WebSocketUrl $WebSocketUrl
    try {
        return (Invoke-KoseiCdpOnSocket -WebSocket $ws -Method $Method -Params $Params -TimeoutSeconds $TimeoutSeconds)
    } finally {
        try { $ws.Dispose() } catch {}
    }
}

function Invoke-KoseiCdpEval {
    param(
        [Parameter(Mandatory=$true)][string]$WebSocketUrl,
        [Parameter(Mandatory=$true)][string]$Expression,
        [int]$TimeoutSeconds = 30
    )
    $resp = Invoke-KoseiCdpMethod -WebSocketUrl $WebSocketUrl -Method 'Runtime.evaluate' -Params @{
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
}

# ---------------------------------------------------------------------
# ページ側JavaScript
# ---------------------------------------------------------------------
function ConvertTo-KoseiJsString {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    return (ConvertTo-Json ([string]$Value))
}

function Get-KoseiChatInputSelectorsJson {
    param([Parameter(Mandatory=$true)]$Settings)
    $sels = @([string[]](Get-KoseiSelector -Settings $Settings -Name 'chat_input_any'))
    return (ConvertTo-Json $sels -Compress)
}

function Wait-KoseiCopilotInputReady {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [int]$TimeoutSeconds = 120,
        [scriptblock]$OnWaiting = $null
    )
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),cs=el.ownerDocument.defaultView.getComputedStyle(el);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';};
  const docs=[document]; for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument);}catch(e){}}
  for (const d of docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (visible(el)) return JSON.stringify({ ready: true, sel: s, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href, title: document.title });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings))
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
        $state = $null
        try { $state = (Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15) | ConvertFrom-Json } catch {}
        if ($state -and $state.ready -eq $true) { return $true }
        if ($OnWaiting) {
            $u = ''
            if ($state) { $u = [string]$state.url }
            try { & $OnWaiting $u } catch {}
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

$script:KoseiCopilotPacketReadyTimeoutSeconds = 60
$script:KoseiCopilotWarmupWaitTimeoutSeconds = 120

function Get-KoseiCopilotScreenState {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings
    )
    $fileSels=@([string](Get-KoseiSelector -Settings $Settings -Name 'file_input'),[string](Get-KoseiSelector -Settings $Settings -Name 'file_input_fallback'))|Where-Object{$_}
    $fileSelsJson=ConvertTo-Json -InputObject @($fileSels) -Compress
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const fileSels = __FILE_SELS__;
  const visible = el => {if(!el)return false;const r=el.getBoundingClientRect(),cs=el.ownerDocument.defaultView.getComputedStyle(el);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';};
  const docs=[document], frameInfo=[]; for(const f of document.querySelectorAll('iframe')){let same=false;try{if(f.contentDocument){docs.push(f.contentDocument);same=true;}}catch(e){}frameInfo.push({src:String(f.src||'').slice(0,60),sameOrigin:same});}
  let input=null; for(const d of docs){input=sels.map(s=>({s,el:d.querySelector(s)})).find(x=>visible(x.el));if(input)break;}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button,a,[role="button"],[tabindex]'))).filter(visible);
  const sendButton=buttons.find(el=>/^(送信|send)$|送信|send/i.test((el.getAttribute('aria-label')||el.title||el.textContent||'').trim())&&!el.disabled&&el.getAttribute('aria-disabled')!=='true');
  let attachElement=null;for(const d of docs){for(const s of fileSels){const e=d.querySelector(s);if(e){attachElement=e;break;}}if(attachElement)break;}
  let modelSwitcher=null;for(const d of docs){modelSwitcher=d.querySelector('#gptModeSwitcher');if(modelSwitcher)break;}
  const attachButton=buttons.find(el=>/添付|attach|ファイルを追加|add file/i.test((el.getAttribute('aria-label')||el.title||el.textContent||'').trim()));
  const signIn = buttons.find(el => /sign\s*in|log\s*in|サインイン|ログイン/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
  const url = String(location.href || '');
  const title = String(document.title || '');
  const surface=/チャット|chat/i.test(title)?'chat':(/copilot/i.test(title)?'home':'unknown');
  const bodyPreview = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const signinRequired = /(?:login|signin|sign-in|auth)/i.test(url) || (!input && !!signIn);
  const editor=document.querySelector('#m365-chat-editor-target-element'), er=editor?editor.getBoundingClientRect():null;
  let shadowHosts=0; for(const el of Array.from(document.querySelectorAll('*')).slice(0,5000)){if(el.shadowRoot)shadowHosts++;}
  const composerReady=!!input&&!!(sendButton||attachElement||attachButton)&&surface==='chat';
  return JSON.stringify({ ready: composerReady, inputVisible:!!input, sendExists:!!sendButton, attachExists:!!attachElement, attachButtonExists:!!attachButton, modelSwitcherExists:!!modelSwitcher, surface,
    selector: input ? input.s : '', signin_required: signinRequired, url, title, bodyPreview,
    buttons:document.querySelectorAll('button').length, editorExists:!!editor, editorRect:er?{w:Math.round(er.width),h:Math.round(er.height)}:null,
    iframes:frameInfo.length, iframeInfo:frameInfo, shadowHosts:shadowHosts });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings)).Replace('__FILE_SELS__',$fileSelsJson)
    try {
        $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
        return ($raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ ready=$false; selector=''; signin_required=$false; url=''; title=''; bodyPreview=('診断取得失敗: ' + $_.Exception.Message) }
    }
}

function Format-KoseiCopilotScreenDiagnostic {
    param($State)
    if ($null -eq $State) { return 'url= title= bodyPreview=' }
    $preview = ([string]$State.bodyPreview -replace '[\r\n]+',' ')
    if ($preview.Length -gt 200) { $preview = $preview.Substring(0, 200) }
    $frames='';try{$frames=($State.iframeInfo|ConvertTo-Json -Compress -Depth 4)}catch{}
    return ('surface={0} url={1} title={2} bodyPreview={3} buttons={4} inputVisible={5} sendExists={6} attachExists={7} attachButtonExists={8} modelSwitcherExists={9} editorExists={10} editorRect={11} iframes={12} iframeInfo={13} shadowHosts={14}' -f [string]$State.surface,[string]$State.url,[string]$State.title,$preview,[string]$State.buttons,[string]$State.inputVisible,[string]$State.sendExists,[string]$State.attachExists,[string]$State.attachButtonExists,[string]$State.modelSwitcherExists,[string]$State.editorExists,($State.editorRect|ConvertTo-Json -Compress),[string]$State.iframes,$frames,[string]$State.shadowHosts)
}

function Wait-KoseiCopilotScreenReady {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [int]$TimeoutSeconds = 60,
        [scriptblock]$ShouldCancel = $null
    )
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
    $last = $null; $sw=[System.Diagnostics.Stopwatch]::StartNew(); $allDeadCount=0; $homeTransitionAttempted=$false
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) {
            return [pscustomobject]@{ ok=$false; cancelled=$true; signin_required=$false; state=$last; message='処理を中止しました。' }
        }
        $last = Get-KoseiCopilotScreenState -WsUrl $WsUrl -Settings $Settings
        if ($last.ready -eq $true) {
            Write-KoseiLog ("準備ゲート通過 elapsedMs="+[int]$sw.ElapsedMilliseconds) 'INFO'
            return [pscustomobject]@{ ok=$true; cancelled=$false; signin_required=$false; state=$last; message='' }
        }
        if ($last.signin_required -eq $true) {
            $diag = Format-KoseiCopilotScreenDiagnostic -State $last
            Write-KoseiLog ('準備ゲート不通過 reason=signin-required elapsedMs=' + [int]$sw.ElapsedMilliseconds + ' ' + $diag) 'ERROR'
            return [pscustomobject]@{ ok=$false; cancelled=$false; signin_required=$true; state=$last; message='Copilotへのサインインが必要です。[Copilot画面を表示]からサインインして、再実行してください。' }
        }
        if([string]$last.surface -eq 'home' -and -not $homeTransitionAttempted){
            $homeTransitionAttempted=$true
            Write-KoseiLog '準備ゲート: surface=home のため新しいチャットへ遷移' 'INFO'
            try{$null=Invoke-KoseiFreshChat -WsUrl $WsUrl -Settings $Settings}catch{Write-KoseiLog ('ホームからチャットへの遷移に失敗（ゲート内で再待機）: '+$_.Exception.Message) 'WARN'}
        }
        if($last.editorExists -ne $true -and $last.ready -ne $true){$allDeadCount++}else{$allDeadCount=0}
        if($allDeadCount -ge 2){$null=Reset-KoseiEdgeWindowStateForDetection -Settings $Settings;$allDeadCount=0}
        Start-Sleep -Milliseconds 500
    }
    if ($null -eq $last) { $last = Get-KoseiCopilotScreenState -WsUrl $WsUrl -Settings $Settings }
    $diag = Format-KoseiCopilotScreenDiagnostic -State $last
    Write-KoseiLog ('準備ゲート不通過 reason=ui-not-ready elapsedMs=' + [int]$sw.ElapsedMilliseconds + ' ' + $diag) 'ERROR'
    return [pscustomobject]@{ ok=$false; cancelled=$false; signin_required=$false; state=$last; message=('Copilot画面が準備できませんでした（URL={0} Title={1}）。[Copilot画面を表示]で状態を確認して、再実行してください。' -f [string]$last.url, [string]$last.title) }
}

function Get-KoseiMainText {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = "(() => ((document.querySelector('main') || document.body).innerText || ''))()"
    $text = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    if ($null -eq $text) { return '' }
    return [string]$text
}

# ---------------------------------------------------------------------
# 新規チャット
# ---------------------------------------------------------------------
function Invoke-KoseiFreshChat {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=e.ownerDocument.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument);}catch(e){}}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button, [role="button"], a, [tabindex]')));
  const candidates=[];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    let score = 0;
    if (/^(新しいチャット|New chat)$/i.test(label)) score += 1000;
    else if (/新しいチャット|New chat/i.test(label)) score += 400;
    else if (/チャット|chat/i.test(label)) score += 80;
    if (/その他|履歴|検索|ライブラリ|more|history|search|library/i.test(label)) score -= 300;
    if (score <= 0) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!visible(b)) continue;
    const r=b.getBoundingClientRect();candidates.push({el:b,label,score,rect:{x:r.x,y:r.y,w:r.width,h:r.height}});
  }
  candidates.sort((a,b)=>b.score-a.score);const best=candidates[0];
  if (best) { best.el.click(); return JSON.stringify({ clicked: true, label: best.label.slice(0,80), score:best.score, rect:best.rect, candidates:candidates.slice(0,6).map(x=>({label:x.label.slice(0,80),score:x.score,rect:x.rect})) }); }
  return JSON.stringify({ clicked: false, candidates:[] });
})()
'@
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $result = $raw | ConvertFrom-Json
    if (-not $result.clicked) {
        # ボタンが見つからない場合はCopilot URLへ再ナビゲート
        Write-KoseiLog '新規チャットボタン未検出のためPage.navigateで初期化' 'WARN'
        $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Page.navigate' -Params @{ url = [string]$Settings.copilot_url } -TimeoutSeconds 20
    }
    Start-Sleep -Milliseconds 800
    return $result
}

# ---------------------------------------------------------------------
# モデルセレクター優先度選択
# ---------------------------------------------------------------------
function Set-KoseiCopilotModel {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $rawSetting = ''
    try { $rawSetting = [string]$Settings.copilot_model } catch {}
    $priority = @($rawSetting -split '[,、\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($priority.Count -eq 0) { return $null }
    $switcherSel = [string](Get-KoseiSelector -Settings $Settings -Name 'model_switcher')
    if ([string]::IsNullOrWhiteSpace($switcherSel)) { $switcherSel = '#gptModeSwitcher' }
    $candidatesJson = if ($priority.Count -eq 1) { '[' + (ConvertTo-KoseiJsString $priority[0]) + ']' } else { ConvertTo-Json -InputObject @($priority) -Compress }
    $jsTpl = @'
(async () => {
  const candidates = __CANDIDATES__;
  const switcherSelector = __SWITCHER__;
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const stripTail = s => norm(s).replace(/[…‥]|\.{3}$/g, '');
  const eq = (a,b) => a.toLowerCase() === b.toLowerCase();
  const has = (a,b) => a.toLowerCase().indexOf(b.toLowerCase()) !== -1;
  const matchesModel = (shown,cand,picked) => {
    const a = stripTail(shown); if (!a) return false;
    if (eq(a,cand) || has(a,cand)) return true;
    if (picked && (eq(a,picked) || has(a,picked))) return true;
    return a.length >= 6 && (has(cand,a) || (picked && has(picked,a)));
  };
  const visible = el => { if (!el) return false; const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
  const primaryLabel = el => { const p=el.querySelector('.fai-CapabilityPickerMenuItem__primaryContentWrapper'); if(p)return norm(p.innerText); const c=el.querySelector('.fui-MenuItem__content > span:first-child'); if(c)return norm(c.innerText); return norm((el.innerText||'').split('\n')[0]); };
  const subTextOf = el => { const s=el.querySelector('.fai-CapabilityPickerMenuItem__subText'); return s?norm(s.innerText):''; };
  const itemSelector='[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]';
  const menuRoot=()=>{for(const d of docs){const r=d.querySelector('.fui-MenuPopover')||d.querySelector('[data-portal-node] [role="menu"]');if(r)return r;}return null;};
  const collectItems=()=>{const r=menuRoot();return r?Array.from(r.querySelectorAll(itemSelector)).filter(visible):[];};
  const collectItemsAll=()=>{const roots=docs.flatMap(d=>Array.from(d.querySelectorAll('.fui-MenuPopover, [data-portal-node] [role="menu"]'))).filter(visible);return Array.from(new Set(roots.flatMap(r=>Array.from(r.querySelectorAll(itemSelector)).filter(visible))));};
  const pressEscape=()=>{try{const o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};const t=document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));}catch(e){}};
  const fireEnter=el=>{try{el.focus();const o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keyup',o));return true;}catch(e){return false;}};
  const fireMenuClick=async el=>{try{const r=el.getBoundingClientRect(),cx=r.x+r.width/2,cy=r.y+r.height/2,base={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy};el.dispatchEvent(new PointerEvent('pointerover',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mouseover',base));el.dispatchEvent(new PointerEvent('pointermove',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mousemove',base));try{el.focus();}catch(e){}await sleep(60);el.dispatchEvent(new PointerEvent('pointerdown',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mousedown',{...base,button:0}));el.dispatchEvent(new PointerEvent('pointerup',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mouseup',{...base,button:0}));el.dispatchEvent(new MouseEvent('click',{...base,button:0}));try{el.click();}catch(e){}return true;}catch(e){return false;}};
  const findSwitcher=()=>{for(const d of docs){let b=d.querySelector(switcherSelector);if(b&&visible(b))return b;b=Array.from(d.querySelectorAll('button[aria-haspopup="menu"]')).find(x=>visible(x)&&(/モデル/.test(x.getAttribute('aria-label')||'')||/model/i.test(x.getAttribute('aria-label')||'')));if(b)return b;}return null;};
  const labelItems=xs=>xs.map(el=>({el,label:primaryLabel(el),submenu:el.getAttribute('aria-haspopup')==='menu',testId:el.getAttribute('data-test-id')||'',checked:el.getAttribute('aria-checked')==='true'})).filter(x=>x.label);
  const diagnostics=xs=>xs.slice(0,16).map(x=>({label:x.label,testId:x.testId,submenu:x.submenu,checked:x.checked,raw:norm(x.el.innerText).slice(0,60)}));
  const isGptTrigger=x=>/^gptSubMenuModelTrigger/i.test(x.testId)||(x.submenu&&/^gpt/i.test(x.label))||(x.submenu&&has(subTextOf(x.el),'OpenAI'));
  const findHit=(xs,c)=>xs.find(x=>eq(x.label,c))||xs.find(x=>has(x.label,c))||(/^gpt/i.test(c)?xs.find(isGptTrigger):null);
  const btn=findSwitcher();
  if(!btn)return JSON.stringify({ok:true,changed:false,reason:'switcher_not_found',menuItems:[],subMenuItems:[],skipped:[],clickMethod:null,confirmSamples:[]});
  const current=norm(btn.innerText);
  if(candidates.length&&matchesModel(current,candidates[0],''))return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:candidates[0],priorityIndex:0,menuItems:[],subMenuItems:[],skipped:[],clickMethod:null,confirmSamples:[]});
  await fireMenuClick(btn);
  let items=[];for(let i=0;i<30;i++){items=collectItems();if(items.length)break;await sleep(100);}if(items.length){await sleep(150);const a=collectItems();if(a.length)items=a;}
  if(!items.length){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'menu_not_found',current,menuItems:[],subMenuItems:[],skipped:[],clickMethod:null,confirmSamples:[]});}
  let labeled=labelItems(items),menuItems=diagnostics(labeled),skipped=[],observedSubMenuItems=[];
  const clickAndConfirm=async(hit,cand)=>{
    const before=new Set(collectItemsAll());await fireMenuClick(hit.el);let picked=hit.label,clicked=hit.el,subMenuItems=[],clickMethod='pointer';
    if(hit.submenu){let fresh=[];for(let i=0;i<20;i++){fresh=collectItemsAll().filter(x=>!before.has(x));if(fresh.length)break;await sleep(100);}if(fresh.length){const sub=fresh.map(el=>({el,label:primaryLabel(el)})).filter(x=>x.label);subMenuItems=sub.map(x=>x.label).slice(0,16);const suffix=cand.replace(/^GPT[\s-]*[\d.]*\s*/i,'');const h=sub.find(x=>eq(x.label,cand))||sub.find(x=>has(x.label,cand))||sub.find(x=>eq(x.label,suffix))||sub.find(x=>suffix&&has(x.label,suffix))||sub.find(x=>has(cand,x.label)&&x.label.length>=4);if(!h)return{applied:false,reason:'submenu_no_match',picked,subMenuItems,confirmSamples:[],menuStillOpen:menuRoot()!==null,clickMethod};picked=h.label;clicked=h.el;await fireMenuClick(clicked);}}
    const timeout=hit.submenu?5000:2000,t0=Date.now(),confirmSamples=[];let keyboard=false,menuStillOpen=false,first=true,after='';
    while(Date.now()-t0<timeout){await sleep(first?50:100);first=false;after=norm((findSwitcher()||{innerText:''}).innerText);const t=Date.now()-t0;if(confirmSamples.length<10)confirmSamples.push({t,text:after});if(matchesModel(after,cand,picked))return{applied:true,after,picked,waitedMs:t,subMenuItems,confirmSamples,menuStillOpen:false,clickMethod};menuStillOpen=menuRoot()!==null;if(hit.submenu&&menuStillOpen&&!keyboard&&t>=800){keyboard=true;clickMethod='keyboard';fireEnter(clicked);}}
    return{applied:false,reason:'confirm_failed',after,picked,waitedMs:Date.now()-t0,subMenuItems,confirmSamples,menuStillOpen:menuRoot()!==null,clickMethod};
  };
  for(let pi=0;pi<candidates.length;pi++){const cand=candidates[pi],hit=findHit(labeled,cand);if(!hit){skipped.push({cand,reason:'not_matched'});continue;}if(hit.checked){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:hit.label,priorityIndex:pi,menuItems,subMenuItems:observedSubMenuItems,skipped});}const r=await clickAndConfirm(hit,cand);if(r.subMenuItems&&r.subMenuItems.length)observedSubMenuItems=r.subMenuItems;if(r.applied)return JSON.stringify({ok:true,changed:true,reason:'selected',before:current,after:r.after,picked:r.picked,priorityIndex:pi,waitedMs:r.waitedMs,menuItems,subMenuItems:observedSubMenuItems,skipped,confirmSamples:r.confirmSamples,menuStillOpen:r.menuStillOpen,clickMethod:r.clickMethod});pressEscape();await sleep(150);pressEscape();await sleep(700);const after2=norm((findSwitcher()||{innerText:''}).innerText);if(matchesModel(after2,cand,r.picked||''))return JSON.stringify({ok:true,changed:true,reason:'selected_late',before:current,after:after2,picked:r.picked,priorityIndex:pi,waitedMs:r.waitedMs+700,menuItems,subMenuItems:observedSubMenuItems,skipped,confirmSamples:r.confirmSamples,menuStillOpen:r.menuStillOpen,clickMethod:r.clickMethod});skipped.push({cand,reason:r.reason||'confirm_failed',confirmSamples:r.confirmSamples||[],menuStillOpen:r.menuStillOpen===true,clickMethod:r.clickMethod||'pointer'});const b=findSwitcher();if(!b)break;await fireMenuClick(b);await sleep(300);items=collectItems();if(!items.length)break;labeled=labelItems(items);menuItems=diagnostics(labeled);}
  pressEscape();return JSON.stringify({ok:true,changed:false,reason:'model_not_in_menu',current,tried:candidates,menuItems,subMenuItems:observedSubMenuItems,skipped,clickMethod:null,confirmSamples:[]});
})()
'@
    try {
        $js = $jsTpl.Replace('__CANDIDATES__', $candidatesJson).Replace('__SWITCHER__', (ConvertTo-KoseiJsString $switcherSel))
        $raw = [string](Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20)
        $result = $raw | ConvertFrom-Json
        Write-KoseiLog ("モデル選択結果: " + $raw) 'INFO'
        if ([string]$result.reason -in @('switcher_not_found','menu_not_found','model_not_in_menu')) { Write-KoseiLog ("モデル切替未実施（処理は継続）: " + [string]$result.reason) 'WARN' }
        return $result
    } catch {
        Write-KoseiLog ("モデル切替エラー（処理は継続）: " + $_.Exception.Message) 'WARN'
        return $null
    }
}

# ---------------------------------------------------------------------
# ファイル添付（Phase 0 実証ロジック）
# ---------------------------------------------------------------------
function Get-KoseiAttachmentSnapshot {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings, [switch]$IncludeHtml)
    $selectors = $Settings.selectors
    $itemSels = New-Object System.Collections.Generic.List[string]
    $nameSels = New-Object System.Collections.Generic.List[string]
    $listSels = New-Object System.Collections.Generic.List[string]
    try { if (-not [string]::IsNullOrWhiteSpace([string]$selectors.attachment_item)) { $itemSels.Add([string]$selectors.attachment_item) } } catch {}
    try { foreach ($s in @($selectors.attachment_item_any)) { if ($s -and -not $itemSels.Contains([string]$s)) { $itemSels.Add([string]$s) } } } catch {}
    try { if (-not [string]::IsNullOrWhiteSpace([string]$selectors.attachment_name)) { $nameSels.Add([string]$selectors.attachment_name) } } catch {}
    try { foreach ($s in @($selectors.attachment_name_any)) { if ($s -and -not $nameSels.Contains([string]$s)) { $nameSels.Add([string]$s) } } } catch {}
    try { if (-not [string]::IsNullOrWhiteSpace([string]$selectors.attachment_list)) { $listSels.Add([string]$selectors.attachment_list) } } catch {}
    try { foreach ($s in @($selectors.attachment_list_any)) { if ($s -and -not $listSels.Contains([string]$s)) { $listSels.Add([string]$s) } } } catch {}
    $toJsonArray = { param($list) if ($list.Count -eq 1) { '[' + (ConvertTo-KoseiJsString $list[0]) + ']' } else { ConvertTo-Json -InputObject @($list.ToArray()) -Compress } }
    $tpl = @'
(() => {
  const itemSels = __ITEM_SELS__, nameSels = __NAME_SELS__, listSels = __LIST_SELS__;
  const visible=x=>{if(!x)return false;const r=x.getBoundingClientRect(),s=x.ownerDocument.defaultView.getComputedStyle(x);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  let list = null, usedListSelector = '';
  for (const d of docs) for (const s of listSels) { const found = Array.from(d.querySelectorAll(s)).filter(visible); if (found.length) { list = found[found.length - 1]; usedListSelector = s; break; } }
  const scope = list || document;
  let els = [], usedItemSelector = '';
  for (const s of itemSels) { const found = Array.from(scope.querySelectorAll(s)).filter(visible); if (found.length) { els = found; usedItemSelector = s; break; } }
  const items = [];
  els.forEach(el => {
    let nameEl = null; for (const s of nameSels) { nameEl = el.querySelector(s); if (nameEl) break; }
    const liveEl = el.querySelector('[aria-live]');
    const busy = !!el.querySelector('[role="progressbar"],progress,[aria-busy="true"],[class*="progress" i],[class*="spinner" i]');
    items.push({
      name: nameEl ? nameEl.textContent.trim() : '',
      live: liveEl ? liveEl.textContent.trim() : '', busy: busy
    });
  });
  return JSON.stringify({ count: items.length, items, usedItemSelector, usedListSelector, listHtml: list ? list.outerHTML.slice(0, 4000) : '' });
})()
'@
    $js = $tpl.
        Replace('__ITEM_SELS__', (& $toJsonArray $itemSels)).
        Replace('__NAME_SELS__', (& $toJsonArray $nameSels)).
        Replace('__LIST_SELS__', (& $toJsonArray $listSels))
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $snap = $raw | ConvertFrom-Json
    if (-not $IncludeHtml) { $snap.listHtml = '' }
    return $snap
}

function Test-KoseiAttachmentNameMatch {
    param([AllowNull()][string]$Actual, [AllowNull()][string]$Expected)
    $norm = { param($s) $v=([string]$s).Trim(); try { $v=$v.Normalize([System.Text.NormalizationForm]::FormKC) } catch {}; return $v.ToLowerInvariant() }
    $a=& $norm $Actual; $e=& $norm $Expected
    if ($a -eq $e) { return $true }
    $a2=[regex]::Replace($a,'[…‥]|\.{3}$',''); $e2=[regex]::Replace($e,'[…‥]|\.{3}$','')
    if ([Math]::Min($a2.Length,$e2.Length) -ge 6 -and ($a2.StartsWith($e2) -or $e2.StartsWith($a2))) { return $true }
    return ([System.IO.Path]::GetFileNameWithoutExtension($a2) -eq [System.IO.Path]::GetFileNameWithoutExtension($e2))
}

function Clear-KoseiResidualAttachments {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings, [string]$Reason='start')
    $snap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings
    if ([int]$snap.count -le 0) { return $snap }
    $listSels=@($Settings.selectors.attachment_list_any); try { if ($Settings.selectors.attachment_list) { $listSels=@([string]$Settings.selectors.attachment_list)+$listSels } } catch {}
    $listJson=ConvertTo-Json -InputObject @($listSels) -Compress
    $tpl=@'
(() => { const sels=__LIST_SELS__,visible=x=>{if(!x)return false;const r=x.getBoundingClientRect(),s=x.ownerDocument.defaultView.getComputedStyle(x);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}; let list=null; for(const s of sels){const a=Array.from(document.querySelectorAll(s)).filter(visible);if(a.length){list=a[a.length-1];break;}} if(!list)return JSON.stringify({clicked:0}); const buttons=Array.from(list.querySelectorAll('.fai-BebopAttachment__dismissButton,button[aria-label*="削除"],button[aria-label*="remove" i]')).filter(visible); buttons.forEach(b=>b.click()); return JSON.stringify({clicked:buttons.length}); })()
'@
    $null=Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression ($tpl.Replace('__LIST_SELS__',$listJson)) -TimeoutSeconds 20
    $names=@($snap.items|ForEach-Object{$_.name}) -join ','
    Write-KoseiLog "残留添付を削除 count=$($snap.count) names=$names reason=$Reason" 'WARN'
    Start-Sleep -Seconds 1
    $after=Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings
    if ([int]$after.count -gt 0) { Write-KoseiLog "残留添付が削除後も残っています count=$($after.count)" 'WARN' }
    return $after
}

function Invoke-KoseiCopilotAttachFiles {
    # DOM.setFileInputFiles（同一セッション=規約3）→ チップ出現 → 完了文言待機
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string[]]$Files,
        [scriptblock]$ShouldCancel = $null
    )
    foreach ($f in $Files) {
        if (!(Test-Path -LiteralPath $f -PathType Leaf)) { throw "添付対象ファイルが見つかりません: $f" }
    }
    $null = Clear-KoseiResidualAttachments -WsUrl $WsUrl -Settings $Settings -Reason 'packet-start'
    $expected = @($Files | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    $selector = [string](Get-KoseiSelector -Settings $Settings -Name 'file_input')
    $fallback = [string](Get-KoseiSelector -Settings $Settings -Name 'file_input_fallback')

    $ws = $null
    try {
        $ws = Connect-KoseiWebSocket -WebSocketUrl $WsUrl
        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.enable'
        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.getDocument' -Params @{ depth = 1 }
        if ($r.error) { throw ('DOM.getDocument failed: ' + ($r.error | ConvertTo-Json -Compress)) }
        $rootId = [int]$r.result.root.nodeId
        $nodeId = 0
        foreach ($sel in @($selector, $fallback)) {
            $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.querySelector' -Params @{ nodeId = $rootId; selector = $sel }
            $found = 0
            if (-not $r.error -and $r.result -and $r.result.nodeId) { $found = [int]$r.result.nodeId }
            if ($found -gt 0) { $nodeId = $found; break }
        }
        if ($nodeId -le 0) {
            # same-origin iframe 内へ移動した file input を Runtime から取得する。
            $selsJson=ConvertTo-Json -InputObject @($selector,$fallback) -Compress
            $expr="(() => { const sels=$selsJson,docs=[document]; for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}} for(const d of docs)for(const s of sels){const e=d.querySelector(s);if(e)return e;} return null; })()"
            $ev=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'Runtime.evaluate' -Params @{expression=$expr;returnByValue=$false;userGesture=$true} -TimeoutSeconds 15
            $objectId='';if(-not $ev.error -and $ev.result -and $ev.result.result){$objectId=[string]$ev.result.result.objectId}
            if(-not [string]::IsNullOrWhiteSpace($objectId)){$rq=Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.requestNode' -Params @{objectId=$objectId} -TimeoutSeconds 15;if(-not $rq.error){$nodeId=[int]$rq.result.nodeId}}
        }
        if ($nodeId -le 0) {
            $screen = Get-KoseiCopilotScreenState -WsUrl $WsUrl -Settings $Settings
            $diag = Format-KoseiCopilotScreenDiagnostic -State $screen
            Write-KoseiLog ("添付要素未検出 selector=$selector fallback=$fallback " + $diag) 'ERROR'
            if ($screen.signin_required -eq $true) {
                throw 'Copilotへのサインインが必要です。[Copilot画面を表示]からサインインして、再実行してください。'
            }
            if ($screen.ready -ne $true) {
                throw ("Copilot画面が準備できませんでした（URL=$([string]$screen.url) Title=$([string]$screen.title)）。[Copilot画面を表示]で状態を確認して、再実行してください。")
            }
            throw ("添付欄を検出できませんでした。selector=$selector / fallback=$fallback / " + $diag)
        }
        $r = Invoke-KoseiCdpOnSocket -WebSocket $ws -Method 'DOM.setFileInputFiles' -Params @{ nodeId = $nodeId; files = @($Files) }
        if ($r.error) { throw ('DOM.setFileInputFiles failed: ' + ($r.error | ConvertTo-Json -Compress)) }
    } finally {
        if ($null -ne $ws) { try { $ws.Dispose() } catch {} }
    }

    # チップ出現→完了文言（フォールバックなし。失敗時は例外停止）
    $doneRe = [regex]::new([string](Get-KoseiSelector -Settings $Settings -Name 'upload_done_pattern'), 'IgnoreCase')
    $failRe = [regex]::new([string](Get-KoseiSelector -Settings $Settings -Name 'upload_fail_pattern'), 'IgnoreCase')
    $waitSec = [int]$Settings.attach_wait_seconds
    $deadline = (Get-Date).AddSeconds([Math]::Max(15, $waitSec))
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $stableCounts=@{}; $lastLogSecond=-10; $zeroHtmlLogged=$false; $lastSnap=$null; $lastMatches=@()
    $initialSnap=Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings
    Write-KoseiLog ("添付完了待機開始 files="+($expected-join ',')+" waitSec=$waitSec usedItemSelector='"+[string]$initialSnap.usedItemSelector+"'") 'INFO'
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) { $null=Invoke-KoseiClickStop -WsUrl $WsUrl; return [pscustomobject]@{ok=$false;completedBy='cancelled';elapsedMs=[int]$sw.ElapsedMilliseconds} }
        Start-Sleep -Milliseconds 500
        $snap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings
        $lastSnap=$snap
        $mine = @($snap.items | Where-Object { $actual=[string]$_.name; @($expected|Where-Object{Test-KoseiAttachmentNameMatch -Actual $actual -Expected $_}).Count -gt 0 })
        $lastMatches=$mine
        $failed = @($mine | Where-Object { $_.live -and $failRe.IsMatch([string]$_.live) })
        if ($failed.Count -gt 0) {
            throw ("添付アップロード失敗: " + (($failed | ForEach-Object { $_.name + ' => ' + $_.live }) -join ' | '))
        }
        $doneNames=@(); $doneBy='live-pattern'
        foreach($n in $expected){$m=@($mine|Where-Object{Test-KoseiAttachmentNameMatch -Actual ([string]$_.name) -Expected $n}|Select-Object -First 1);if($m.Count){$x=$m[0];if($x.live -and $doneRe.IsMatch([string]$x.live)){$doneNames+=$n;$stableCounts[$n]=0}elseif(-not $x.busy -and -not ($x.live -and $failRe.IsMatch([string]$x.live))){$stableCounts[$n]=1+[int]$stableCounts[$n];if([int]$stableCounts[$n]-ge 2){$doneNames+=$n;$doneBy='stable-chip'}}else{$stableCounts[$n]=0}}}
        $allDone = $true
        foreach ($n in $expected) { if ($doneNames -notcontains $n) { $allDone = $false } }
        if ($mine.Count -ge $expected.Count -and $allDone) {
            Write-KoseiLog ("添付完了 files=" + ($expected -join ',') + " doneBy="+$doneBy+" usedItemSelector='"+[string]$snap.usedItemSelector+"' elapsedMs=" + $sw.ElapsedMilliseconds) 'INFO'
            # 添付後の追加安定待ち（既定0ms。入力チャンク毎の検証リトライが安全網の
            # ため通常は不要。問題が出る環境のみ settings の attach_settle_ms で調整）
            $settleMs = 0
            try { $settleMs = [int]$Settings.attach_settle_ms } catch {}
            if ($settleMs -gt 0) { Start-Sleep -Milliseconds $settleMs }
            return @{ ok = $true; elapsedMs = [int]$sw.ElapsedMilliseconds }
        }
        $sec=[int][Math]::Floor($sw.Elapsed.TotalSeconds)
        if($sec -eq 0 -or $sec-$lastLogSecond -ge 10){$lastLogSecond=$sec;$names=@($snap.items|ForEach-Object{$_.name})-join '|';$lives=@($snap.items|ForEach-Object{$_.live})-join '|';Write-KoseiLog "添付待機中 elapsedSec=$sec count=$($snap.count) names=$names lives=$lives usedItemSelector='$($snap.usedItemSelector)'" 'INFO'}
        if(-not $zeroHtmlLogged -and $sec -ge 10 -and [int]$snap.count -eq 0){$evidence=Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -IncludeHtml;Write-KoseiLog ("添付チップ未検出10秒 listHtml="+[string]$evidence.listHtml) 'WARN';$zeroHtmlLogged=$true}
    }
    $htmlSnap = Get-KoseiAttachmentSnapshot -WsUrl $WsUrl -Settings $Settings -IncludeHtml
    $names=@($htmlSnap.items|ForEach-Object{$_.name})-join '|';$lives=@($htmlSnap.items|ForEach-Object{$_.live})-join '|'
    Write-KoseiLog ("添付完了待機タイムアウト usedItemSelector='"+[string]$htmlSnap.usedItemSelector+"' names=$names lives=$lives matched=$(@($lastMatches).Count) listHtml=" + [string]$htmlSnap.listHtml) 'ERROR'
    try { $null=Clear-KoseiResidualAttachments -WsUrl $WsUrl -Settings $Settings -Reason 'packet-timeout' } catch { Write-KoseiLog ("タイムアウト後の残留添付削除に失敗: "+$_.Exception.Message) 'WARN' }
    throw ("添付完了を {0} 秒以内に確認できませんでした。" -f $waitSec)
}

# ---------------------------------------------------------------------
# 依頼文入力（Input.insertText 単一経路）
# ---------------------------------------------------------------------
function Invoke-KoseiFocusChatInput {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),cs=e.ownerDocument.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  for (const d of docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (visible(el)) { el.focus(); return JSON.stringify({ ok: true, sel: s }); }
  }
  return JSON.stringify({ ok: false });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings))
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
    $r = $raw | ConvertFrom-Json
    if (-not $r.ok) { throw 'チャット入力欄へフォーカスできませんでした。' }
    return $r
}

function Get-KoseiChatInputTextLength {
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $tpl = @'
(() => {
  const sels = __INPUT_SELS__;
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),cs=e.ownerDocument.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden';};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  for (const d of docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (visible(el)) return JSON.stringify({ len: (el.innerText || el.value || '').length });
  }
  return JSON.stringify({ len: -1 });
})()
'@
    $js = $tpl.Replace('__INPUT_SELS__', (Get-KoseiChatInputSelectorsJson -Settings $Settings))
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
    return ([int](($raw | ConvertFrom-Json).len))
}

function Invoke-KoseiKeyEvent {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)][string]$Type,
        [Parameter(Mandatory=$true)][string]$Key,
        [Parameter(Mandatory=$true)][string]$Code,
        [Parameter(Mandatory=$true)][int]$KeyCode,
        [int]$Modifiers = 0
    )
    $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Input.dispatchKeyEvent' -Params @{
        type = $Type; key = $Key; code = $Code
        windowsVirtualKeyCode = $KeyCode; nativeVirtualKeyCode = $KeyCode
        modifiers = $Modifiers
    } -TimeoutSeconds 15
}

function Clear-KoseiChatInput {
    # Ctrl+A → Backspace で入力欄を空にする（クリップボード不使用）
    param([Parameter(Mandatory=$true)][string]$WsUrl, [Parameter(Mandatory=$true)]$Settings)
    $len = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
    if ($len -le 0) { return }
    $null = Invoke-KoseiFocusChatInput -WsUrl $WsUrl -Settings $Settings
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'rawKeyDown' -Key 'a' -Code 'KeyA' -KeyCode 65 -Modifiers 2
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'keyUp' -Key 'a' -Code 'KeyA' -KeyCode 65 -Modifiers 2
    Start-Sleep -Milliseconds 120
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'rawKeyDown' -Key 'Backspace' -Code 'Backspace' -KeyCode 8
    Invoke-KoseiKeyEvent -WsUrl $WsUrl -Type 'keyUp' -Key 'Backspace' -Code 'Backspace' -KeyCode 8
    Start-Sleep -Milliseconds 200
    Write-KoseiLog ("入力欄クリア beforeLen=" + $len + " afterLen=" + (Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings)) 'INFO'
}

function Invoke-KoseiInsertPrompt {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$Prompt
    )
    $maxChars = [int]$Settings.max_prompt_chars
    if ($Prompt.Length -gt $maxChars) {
        throw ("依頼文が上限 {0} 文字を超えています（{1} 文字）。パケットのページ数を減らしてください。" -f $maxChars, $Prompt.Length)
    }
    # 残留テキストがあれば消してから入力する
    Clear-KoseiChatInput -WsUrl $WsUrl -Settings $Settings
    $null = Invoke-KoseiFocusChatInput -WsUrl $WsUrl -Settings $Settings

    # クリップボードは使わない（Input.insertText 単一経路）。
    # 添付後の再レンダリング等でフォーカスが失われチャンクが落ちることがある
    # ため、チャンクごとに「入力欄の文字数が増えたか」を検証し、必要なら
    # 再フォーカスしてリトライする。
    $chunkSize = 3000
    for ($i = 0; $i -lt $Prompt.Length; $i += $chunkSize) {
        $len = [Math]::Min($chunkSize, $Prompt.Length - $i)
        $chunk = $Prompt.Substring($i, $len)
        $expectedGrowth = [int][Math]::Floor($chunk.Length * 0.9)
        $chunkOk = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $before = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
            if ($before -lt 0) { $before = 0 }
            $null = Invoke-KoseiFocusChatInput -WsUrl $WsUrl -Settings $Settings
            $null = Invoke-KoseiCdpMethod -WebSocketUrl $WsUrl -Method 'Input.insertText' -Params @{ text = $chunk } -TimeoutSeconds 30
            Start-Sleep -Milliseconds 300
            $after = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
            if (($after - $before) -ge $expectedGrowth) { $chunkOk = $true; break }
            Write-KoseiLog ("入力チャンク検証NG offset=" + $i + " attempt=" + $attempt + " before=" + $before + " after=" + $after + " expectedGrowth=" + $expectedGrowth) 'WARN'
            Start-Sleep -Milliseconds 500
        }
        if (-not $chunkOk) {
            $curLen = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
            throw ("依頼文の入力がチャンク位置 {0} で反映されませんでした（現在 {1} 文字 / 全体 {2} 文字）。Copilot入力欄の文字数上限、または添付後の画面更新が原因の可能性があります。" -f $i, $curLen, $Prompt.Length)
        }
    }
    Start-Sleep -Milliseconds 300
    $inputLen = Get-KoseiChatInputTextLength -WsUrl $WsUrl -Settings $Settings
    if ($inputLen -lt [int]($Prompt.Length * 0.9)) {
        throw ("依頼文の入力を確認できませんでした（期待 {0} 文字 / 実際 {1} 文字）。" -f $Prompt.Length, $inputLen)
    }
    Write-KoseiLog ("依頼文入力完了 chars=" + $Prompt.Length + " editorLen=" + $inputLen) 'INFO'
}

# ---------------------------------------------------------------------
# 送信（有効な送信ボタンのみクリック）
# ---------------------------------------------------------------------
function Invoke-KoseiClickSend {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=e.ownerDocument.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button, [role="button"]')));
  const candidates = [];
  const clickable = [];
  const exclude = /stop|cancel|停止|キャンセル|regenerate|再生成|attach|添付|microphone|voice|ボイス|音声|マイク|new chat|新しいチャット|clear|クリア|close|閉じる|search|検索|library|ライブラリ|file|ファイル|mail|メール|contact|連絡先|meeting|会議|delete|削除/;
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    let score = 0;
    if (/^(送信|send)$/i.test(label)) score += 1000;
    else if (/送信|send/i.test(lower)) score += 400;
    if (score <= 0) continue;
    const reasons = [];
    if (exclude.test(lower)) reasons.push('non-send-control');
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') reasons.push('disabled');
    if (!visible(b)) reasons.push('hidden');
    candidates.push({ label: label.slice(0, 80), score: score, reasons: reasons });
    if (reasons.length === 0) clickable.push({ el: b, label: label.slice(0, 80), score: score });
  }
  clickable.sort((a, c) => c.score - a.score);
  if (clickable.length > 0) {
    clickable[0].el.click();
    return JSON.stringify({ clicked: true, label: clickable[0].label, candidates: candidates.slice(0, 6) });
  }
  return JSON.stringify({ clicked: false, candidates: candidates.slice(0, 6) });
})()
'@
    $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    $r = $raw | ConvertFrom-Json
    Write-KoseiLog ("送信クリック clicked=" + $r.clicked + " detail=" + ($raw.ToString().Substring(0, [Math]::Min(300, $raw.ToString().Length)))) 'INFO'
    if (-not $r.clicked) { throw ('有効な送信ボタンが見つかりませんでした。candidates=' + ($r.candidates | ConvertTo-Json -Compress)) }
    return $r
}

function Invoke-KoseiClickStop {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=e.ownerDocument.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const buttons = docs.flatMap(d=>Array.from(d.querySelectorAll('button, [role="button"]')));
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    if (!/停止|stop/i.test(label)) continue;
    if (b.disabled || !visible(b)) continue;
    b.click();
    return JSON.stringify({ clicked: true, label: label.slice(0, 80) });
  }
  return JSON.stringify({ clicked: false });
})()
'@
    try {
        $raw = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

# ---------------------------------------------------------------------
# 回答JSON抽出（波括弧スキャン。文字列・エスケープを考慮）
# ---------------------------------------------------------------------
function Get-KoseiJsonObjectCandidates {
    param([AllowNull()][string]$Text)
    $out = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrEmpty($Text)) { return $out.ToArray() }
    $len = $Text.Length
    $i = 0
    while ($i -lt $len) {
        if ($Text[$i] -ne '{') { $i++; continue }
        $depth = 0
        $inStr = $false
        $esc = $false
        $start = $i
        $j = $i
        while ($j -lt $len) {
            $c = $Text[$j]
            if ($inStr) {
                if ($esc) { $esc = $false }
                elseif ($c -eq '\') { $esc = $true }
                elseif ($c -eq '"') { $inStr = $false }
            } else {
                if ($c -eq '"') { $inStr = $true }
                elseif ($c -eq '{') { $depth++ }
                elseif ($c -eq '}') {
                    $depth--
                    if ($depth -eq 0) {
                        $out.Add($Text.Substring($start, $j - $start + 1))
                        break
                    }
                }
            }
            $j++
        }
        if ($depth -eq 0 -and $j -lt $len) { $i = $j + 1 } else { $i = $start + 1 }
    }
    return $out.ToArray()
}

function Repair-KoseiJsonText {
    param([AllowNull()][string]$Text)
    $source = [string]$Text
    $fixed = $source
    $fixes = New-Object System.Collections.Generic.List[string]
    # LLMが日本語括弧で始まる文字列値の開始ダブルクォートだけを落とす既知パターンに限定する。
    $keys = 'issue_summary|reason|note|suggestion|quote|reference_quote|no_findings_reason'
    $missingQuotePattern = '((?:"(?:' + $keys + ')"\s*:\s*))([「｢『【])'
    $next = [regex]::Replace($fixed, $missingQuotePattern, '$1"$2')
    if ($next -ne $fixed) { $fixed=$next; $fixes.Add('missing-open-quote') }
    $next = [regex]::Replace($fixed, ',\s*([}\]])', '$1')
    if ($next -ne $fixed) { $fixed=$next; $fixes.Add('trailing-comma') }
    return [pscustomobject]@{ text=$fixed; changed=($fixed -ne $source); fixes=@($fixes) }
}

function Get-KoseiReviewCandidateScore {
    param([Parameter(Mandatory=$true)][string]$Candidate)
    $score=0
    if($Candidate -match '"findings"'){ $score+=20 }
    if($Candidate -match '"packet_id"'){ $score+=8 }
    if($Candidate -match '"(?:pages_checked|checked_pages|checked_page_summaries)"'){ $score+=8 }
    if($Candidate -match '"read_error"'){ $score+=4 }
    $score += [Math]::Min(10,[Math]::Floor($Candidate.Length/1000))
    return $score
}

function Get-KoseiReviewAnswerJson {
    # テキストから校正回答らしい最後の有効JSON（findings または read_error を持つ）を抽出
    param([AllowNull()][string]$Text, [ref]$Metadata=$null)
    if($Metadata){$Metadata.Value=[pscustomobject]@{repaired=$false;fixes=@();rawText=[string]$Text;parseErrors=@();candidateHeads=@()}}
    $clean = [string]$Text
    $clean = $clean -replace '```json', '' -replace '```', ''
    $parseErrors=New-Object System.Collections.Generic.List[string]
    # 外側応答を直接パースして、破損時の位置・メッセージを診断用に保持する。
    $probe=$clean
    $markerProbe=$probe.LastIndexOf('KOSEI_END')
    if($markerProbe -ge 0){$probe=$probe.Substring(0,$markerProbe)}
    $probe=$probe.Trim()
    if($probe.StartsWith('{')){try{$null=$probe|ConvertFrom-Json}catch{$parseErrors.Add($_.Exception.Message)}}
    $tryTexts=New-Object System.Collections.Generic.List[object]
    $tryTexts.Add([pscustomobject]@{text=$clean;repaired=$false;fixes=@()})
    $repair=Repair-KoseiJsonText -Text $clean
    if($repair.changed){$tryTexts.Add([pscustomobject]@{text=$repair.text;repaired=$true;fixes=$repair.fixes})}
    $wideBase=if($repair.changed){[string]$repair.text}else{$clean}
    $wide=$wideBase -replace '[“”＂]','"'
    if($wide -ne $wideBase){$tryTexts.Add([pscustomobject]@{text=$wide;repaired=$true;fixes=@(@($repair.fixes)+'fullwidth-quote')})}
    foreach($tryText in $tryTexts){
      $ranked=@(Get-KoseiJsonObjectCandidates -Text ([string]$tryText.text) | ForEach-Object {[pscustomobject]@{text=[string]$_;score=(Get-KoseiReviewCandidateScore -Candidate ([string]$_))}} | Sort-Object -Property @{Expression={$_.score};Descending=$true},@{Expression={$_.text.Length};Descending=$true})
      foreach($candidateInfo in $ranked){
        $c=[string]$candidateInfo.text
        if ($c -notmatch '"findings"' -and $c -notmatch '"read_error"') { continue }
        try {
          $obj=$c|ConvertFrom-Json
          if($obj -and (($obj.PSObject.Properties.Name -contains 'findings') -or ($obj.PSObject.Properties.Name -contains 'read_error'))){
            if($Metadata){$Metadata.Value=[pscustomobject]@{repaired=[bool]$tryText.repaired;fixes=@($tryText.fixes);rawText=$clean;parseErrors=@($parseErrors);candidateHeads=@($ranked|Select-Object -First 3|ForEach-Object{$h=$_.text -replace '[\r\n]+',' ';if($h.Length -gt 40){$h=$h.Substring(0,40)};$h})}}
            return $c
          }
        }catch{$parseErrors.Add($_.Exception.Message)}
      }
    }
    # 外側の開き波括弧がDOM切り出しで欠けた場合の保険。最後の主要キーを起点に外側オブジェクトを復元する。
    foreach ($key in @('"findings"', '"read_error"')) {
        $keyPos = $clean.LastIndexOf($key)
        if ($keyPos -lt 0) { continue }
        $searchStart = [Math]::Max(0, $keyPos - 500)
        $openPos = $clean.LastIndexOf('{', $keyPos, $keyPos - $searchStart + 1)
        $keyTexts = New-Object System.Collections.Generic.List[string]
        if ($openPos -ge $searchStart) { $keyTexts.Add($clean.Substring($openPos)) }
        $keyTexts.Add('{' + $clean.Substring($keyPos))
        foreach ($keyText in $keyTexts) {
            foreach ($candidate in @(Get-KoseiJsonObjectCandidates -Text $keyText)) {
                try {
                    $obj = $candidate | ConvertFrom-Json
                    if ($obj -and (($obj.PSObject.Properties.Name -contains 'findings') -or ($obj.PSObject.Properties.Name -contains 'read_error'))) { return $candidate }
                } catch {}
            }
        }
    }
    if($Metadata){$Metadata.Value=[pscustomobject]@{repaired=$false;fixes=@();rawText=$clean;parseErrors=@($parseErrors);candidateHeads=@()}}
    return $null
}

function Get-KoseiReviewJsonDiagnostics {
    param([AllowNull()][string]$Text)
    $clean = ([string]$Text) -replace '```json', '' -replace '```', ''
    $candidates = @(Get-KoseiJsonObjectCandidates -Text $clean)
    $reasons = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $candidates.Count; $i++) {
        $candidate = [string]$candidates[$i]
        $preview = ($candidate -replace '[\r\n]+', ' ')
        if ($preview.Length -gt 40) { $preview = $preview.Substring(0, 40) }
        if ($candidate -notmatch '"findings"' -and $candidate -notmatch '"read_error"') {
            $reasons.Add("candidate[$i]: findings/read_error キー無し head=$preview")
            continue
        }
        try {
            $obj = $candidate | ConvertFrom-Json
            if (-not $obj -or (($obj.PSObject.Properties.Name -notcontains 'findings') -and ($obj.PSObject.Properties.Name -notcontains 'read_error'))) {
                $reasons.Add("candidate[$i]: パース後に findings/read_error キー無し head=$preview")
            }
        } catch {
            $reasons.Add("candidate[$i]: パース例外 head=$preview " + $_.Exception.Message)
        }
    }
    return [pscustomobject]@{ count = $candidates.Count; reasons = @($reasons) }
}

function Get-KoseiLatestResponseText {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const selectors = [
    '[data-testid="markdown-reply"]',
    '[data-content="ai-message"]',
    '[class*="ai-message" i]',
    '[role="article"][data-author="assistant"], [role="article"][aria-label*="Copilot" i]',
    '[data-message-author-role="assistant"]'
  ];
  for (let i = 0; i < selectors.length; i++) {
    const nodes = document.querySelectorAll(selectors[i]);
    if (!nodes.length) continue;
    const text = (nodes[nodes.length - 1].innerText || '').trim();
    if (text) return JSON.stringify({ text, selectorIndex: i + 1 });
  }
  return JSON.stringify({ text: '', selectorIndex: 0 });
})()
'@
    $t = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
    if ($null -eq $t) { return [pscustomobject]@{ text=''; selectorIndex=0 } }
    try { return ($t | ConvertFrom-Json) } catch { return [pscustomobject]@{ text=[string]$t; selectorIndex=0 } }
}

function Get-KoseiAssistantTailHash {
    # latest_text を正規化し、末尾256文字の SHA-256 を小文字hexで返す（§7.3 / 計画書 G）。
    # CDP注入JSではなくPS側で計算する（Web Crypto の非同期を避け、決定性を単体テスト可能にする）。
    param([string]$Text)
    $s = [string]$Text
    if ([string]::IsNullOrEmpty($s)) { return '' }
    $s = $s -replace "`r`n", "`n" -replace "`r", "`n"
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $s.ToCharArray()) {
        $c = [int]$ch
        if (($c -lt 32 -and $c -ne 9 -and $c -ne 10) -or $c -eq 127) { continue }
        [void]$sb.Append($ch)
    }
    $clean = $sb.ToString()
    if ($clean.Length -gt 256) { $clean = $clean.Substring($clean.Length - 256) }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($clean)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $out = New-Object System.Text.StringBuilder
    foreach ($b in $hash) { [void]$out.Append($b.ToString('x2')) }
    return $out.ToString()
}

function Get-KoseiAssistantSnapshot {
    # §1.2 の全selectorについて {selector_index, element_count, latest_text, tail_hash, assistant_dom_key}
    # を返す（§7.3）。単一selectorだけを返す Get-KoseiLatestResponseText と異なり、空のstreaming要素や
    # selector重複を観測できる。tail_hash は PS 側で導出する。
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const selectors = [
    '[data-testid="markdown-reply"]',
    '[data-content="ai-message"]',
    '[class*="ai-message" i]',
    '[role="article"][data-author="assistant"], [role="article"][aria-label*="Copilot" i]',
    '[data-message-author-role="assistant"]'
  ];
  const matches = [];
  let anyElement = false, anyText = false;
  for (let i = 0; i < selectors.length; i++) {
    const nodes = document.querySelectorAll(selectors[i]);
    const count = nodes.length;
    let latest = '', domKey = '';
    if (count > 0) {
      anyElement = true;
      const last = nodes[count - 1];
      latest = (last.innerText || '').trim();
      if (latest) anyText = true;
      domKey = last.getAttribute('data-message-id') || last.getAttribute('id') || last.getAttribute('data-testid') || '';
    }
    matches.push({ selector_index: i + 1, element_count: count, latest_text: latest, assistant_dom_key: domKey });
  }
  const state = anyText ? 'ready' : (anyElement ? 'pending' : 'empty');
  return JSON.stringify({ state, matches });
})()
'@
    try {
        $t = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
        if ($null -eq $t) { return [pscustomobject]@{ state='cdp-error'; matches=@() } }
        $obj = $t | ConvertFrom-Json
        $mm = @()
        foreach ($m in @($obj.matches)) {
            $mm += [pscustomobject]@{
                selector_index    = [int]$m.selector_index
                element_count     = [int]$m.element_count
                latest_text       = [string]$m.latest_text
                tail_hash         = Get-KoseiAssistantTailHash -Text ([string]$m.latest_text)
                assistant_dom_key = [string]$m.assistant_dom_key
            }
        }
        return [pscustomobject]@{ state=[string]$obj.state; matches=$mm }
    } catch {
        Write-KoseiLog ("assistant snapshot取得に失敗（cdp-error）: " + $_.Exception.Message) 'WARN'
        return [pscustomobject]@{ state='cdp-error'; matches=@() }
    }
}

function Get-KoseiMainResponseRegion {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $text = Get-KoseiMainText -WsUrl $WsUrl
    # 最後のユーザー依頼の末尾固定句以降に限定し、プロンプトecho内のKOSEI_ENDを除外する。
    $anchor = 'その後には何も出力しないでください。'
    $anchorPos = $text.LastIndexOf($anchor)
    if ($anchorPos -ge 0) { return $text.Substring($anchorPos + $anchor.Length).TrimStart() }
    return ''
}

function Test-KoseiCopilotGenerating {
    param([Parameter(Mandatory=$true)][string]$WsUrl)
    $js = @'
(() => {
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const stop = buttons.some(el => /^(stop|停止|応答を停止|生成を停止)$/i.test((el.innerText || el.getAttribute('aria-label') || el.title || '').trim()));
  const streaming = [...document.querySelectorAll('[aria-busy="true"],[data-state="streaming"],[data-status="streaming"],[class*="streaming" i]')].some(visible);
  return JSON.stringify({ generating: stop || streaming, stop, streaming });
})()
'@
    try {
        $result = Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 20
        if ($null -eq $result) { return $true }
        return [bool](($result | ConvertFrom-Json).generating)
    } catch {
        Write-KoseiLog ("生成状態の取得に失敗。安全側で生成中として扱います: " + $_.Exception.Message) 'WARN'
        return $true
    }
}

function Get-KoseiReviewCompleteness {
    param([Parameter(Mandatory=$true)][string]$Json, [int[]]$ExpectedPages = @())
    $findingsCount = 0; $checked = @(); $hasRequired = $false; $readError = $false
    try {
        $obj = $Json | ConvertFrom-Json
        $names = @($obj.PSObject.Properties.Name)
        $hasRequired = ($names -contains 'findings') -or ($names -contains 'read_error')
        $readError = ($names -contains 'read_error') -and -not [string]::IsNullOrWhiteSpace([string]$obj.read_error)
        if ($names -contains 'findings') { $findingsCount = @($obj.findings).Count }
        # 回答形式の揺れを吸収する優先順位。最初に存在して値を持つ形式を採用する。
        $rawChecked = @()
        foreach($field in $script:KoseiPageCheckFieldPriority){
            if($names -notcontains $field){continue}
            $values=$(if($field -eq 'checked_page_summaries'){@($obj.$field | ForEach-Object{$_.page})}else{@($obj.$field)})
            if(@($values).Count){$rawChecked=@($values);break}
        }
        $checked = @($rawChecked | ForEach-Object { try { [int]$_ } catch {} } | Sort-Object -Unique)
    } catch {}
    $expected = @($ExpectedPages | Sort-Object -Unique)
    $covered = if ($expected.Count) { @($expected | Where-Object { $checked -contains $_ }).Count } else { $checked.Count }
    $coverage = if ($expected.Count) { $covered / [double]$expected.Count } else { 1.0 }
    $complete = $hasRequired -and ($readError -or $coverage -ge 0.70)
    $warning = ''
    if (-not $hasRequired) { $warning = 'findings または read_error がありません。' }
    elseif (-not $readError -and $coverage -lt 0.70) { $warning = ('確認済みページが対象の {0:P0} です（必要: 70%以上）。' -f $coverage) }
    elseif ($findingsCount -eq 0 -and -not $readError) { $warning = '指摘が0件です。必要に応じてパケットを再実行してください。' }
    return [pscustomobject]@{ complete=$complete; findingsCount=$findingsCount; pagesChecked=@($checked); coverage=$coverage; warning=$warning }
}

function Test-KoseiCopilotRefusalText {
    param([AllowNull()][string]$Text)
    return ([string]$Text -match '申し訳ございません.*(?:応答|回答)できません|それに応答できません|(?:sorry|unable|can(?:not|''t))\s+(?:to\s+)?(?:respond|complete|help)')
}

# ---------------------------------------------------------------------
# 応答待機
# ---------------------------------------------------------------------
function Wait-KoseiCopilotReviewResponse {
    param(
        [Parameter(Mandatory=$true)][string]$WsUrl,
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][int]$BaselineLength,
        [string]$Marker = '',
        [int]$TimeoutSeconds = 600,
        [scriptblock]$ShouldCancel = $null,
        [scriptblock]$OnProgress = $null,
        [int[]]$ExpectedPages = @()
    )
    # turnごとの一意マーカーが渡された場合はそれを使い、前ターンのマーカーに誤ヒットしない（§7.3）。
    $marker = if ([string]::IsNullOrWhiteSpace($Marker)) { [string]$Settings.response_end_marker } else { [string]$Marker }
    $deadline = (Get-Date).AddSeconds([Math]::Max(30, $TimeoutSeconds))
    $lastLen = -1
    $stableSince = Get-Date
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastProgressSec = -10
    $fetchErrors = 0
    $fallbackLookbackChars = 30000
    $lastResponseSnapshot = ''
    $lastResponseSource = ''
    $snapshotMissingWarned = $false
    $notGeneratingPolls = 0
    $lastIncompleteAnswer = $null
    $lastIncompleteInfo = $null
    $lastIncompleteRaw = ''
    $lastIncompleteMeta = $null
    $lastIncompleteLogAt = (Get-Date).AddSeconds(-20)
    $lastIncompleteLogLength = -1
    $responseSeen=$false
    $lastObservedText=''
    $longestResponseSnapshot=''
    Write-KoseiLog "回答待機開始 baselineLen=$BaselineLength timeoutSec=$TimeoutSeconds marker=$marker" 'INFO'
    while ((Get-Date) -lt $deadline) {
        if ($ShouldCancel -and (& $ShouldCancel)) {
            $null=Invoke-KoseiClickStop -WsUrl $WsUrl
            Write-KoseiLog "回答待機を中止 elapsedMs=$($sw.ElapsedMilliseconds)" 'INFO'
            return [pscustomobject]@{ok=$false;completedBy='cancelled';json=$null;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=''}
        }
        Start-Sleep -Milliseconds 1000
        $text = ''
        $latestResponse = ''
        try {
            $latest = Get-KoseiLatestResponseText -WsUrl $WsUrl
            $latestResponse = [string]$latest.text
            if (-not [string]::IsNullOrWhiteSpace($latestResponse)) {
                $responseSeen=$true
                $lastResponseSnapshot = $latestResponse
                if($latestResponse.Length -gt $longestResponseSnapshot.Length){$longestResponseSnapshot=$latestResponse}
                $lastResponseSource = 'latest-response:' + [string]$latest.selectorIndex
                $snapshotMissingWarned = $false
            } else {
                $text = Get-KoseiMainResponseRegion -WsUrl $WsUrl
            }
            $fetchErrors=0
        } catch {
            $fetchErrors++
            if($fetchErrors -eq 10){Write-KoseiLog "回答取得CDPエラーが10回連続。ターゲットを再取得します。" 'WARN';try{$page=Get-KoseiCopilotPage -Settings $Settings;$WsUrl=[string]$page.webSocketDebuggerUrl;$fetchErrors=0}catch{} }
            continue
        }
        $newText = ''
        $source = 'latest-response:' + [string]$latest.selectorIndex
        if (-not [string]::IsNullOrWhiteSpace($latestResponse)) {
            $newText = $latestResponse
        } elseif (-not [string]::IsNullOrWhiteSpace($lastResponseSnapshot)) {
            $source = 'snapshot:' + $lastResponseSource
            $newText = $lastResponseSnapshot
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                $newText = $lastResponseSnapshot + "`n" + $text
                $source += '+main-region'
            }
            if (-not $snapshotMissingWarned) {
                Write-KoseiLog "応答要素が消失。スナップショット(len=$($lastResponseSnapshot.Length))を使用" 'WARN'
                $snapshotMissingWarned = $true
            }
        } else {
            $source = 'main-diff'
            # textは最後のユーザー依頼以降に限定済み。プロンプトecho内マーカーを完了判定に使わない。
            $fullMarkerIdx = $text.LastIndexOf($marker)
            if ($fullMarkerIdx -ge 0) {
                $start = [Math]::Max(0, $fullMarkerIdx - $fallbackLookbackChars)
                $newText = $text.Substring($start, $fullMarkerIdx + $marker.Length - $start)
            } elseif ($text.Length -gt 0) {
                # マーカー出現前も固定オフセットは使わず、末尾側の十分な範囲を抽出候補にする。
                $start = [Math]::Max(0, $text.Length - $fallbackLookbackChars)
                $newText = $text.Substring($start)
            }
        }
        # 同じ文字数で拒否文へ置換された場合も変化として扱う。再伸長時はstable判定が必ずリセットされる。
        if ($newText -ne $lastObservedText) { $lastObservedText=$newText;$lastLen = $newText.Length; $stableSince = Get-Date }
        $stableSec = ((Get-Date) - $stableSince).TotalSeconds
        $elapsedSec=[int][Math]::Floor($sw.Elapsed.TotalSeconds)
        $markerIdx = $newText.LastIndexOf($marker)
        $markerFound = ($markerIdx -ge 0)
        $jsonCandidates = -1
        if ($markerFound) { $jsonCandidates = @(Get-KoseiJsonObjectCandidates -Text $newText).Count }
        if($elapsedSec-$lastProgressSec -ge 10){$lastProgressSec=$elapsedSec;Write-KoseiLog "回答待機中 elapsedSec=$elapsedSec newTextLen=$($newText.Length) stableSec=$([Math]::Round($stableSec,1)) markerFound=$($markerFound.ToString().ToLower()) jsonCandidates=$jsonCandidates source=$source fetchErrors=$fetchErrors" 'INFO';if($OnProgress){try{& $OnProgress ([pscustomobject]@{elapsedSec=$elapsedSec;newTextLen=$newText.Length;stableSec=$stableSec;fetchErrors=$fetchErrors})}catch{}}}

        $generating=$true
        if($responseSeen -and $stableSec -ge 5){$generating=Test-KoseiCopilotGenerating -WsUrl $WsUrl}
        if($responseSeen -and $stableSec -ge 5 -and -not $generating -and (Test-KoseiCopilotRefusalText -Text $newText)){
            Write-KoseiLog "Copilot拒否応答を検出 completedBy=copilot-refusal stableSec=$([Math]::Round($stableSec,1)) len=$($newText.Length)" 'WARN'
            return [pscustomobject]@{ok=$false;completedBy='copilot-refusal';json=$null;rawJson=$newText;salvageText=$longestResponseSnapshot;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=($newText.Substring(0,[Math]::Min(200,$newText.Length)))}
        }
        # 応答要素が一度出現した後だけ適用し、長いthinking中は打ち切らない。
        if($responseSeen -and $stableSec -ge 90 -and -not $generating){
            $idleMeta=$null;$idleAnswer=Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$idleMeta)
            if(-not $idleAnswer){
                Write-KoseiLog "JSONなし停滞を検出 completedBy=no-json-idle stableSec=$([Math]::Round($stableSec,1)) len=$($newText.Length)" 'WARN'
                return [pscustomobject]@{ok=$false;completedBy='no-json-idle';json=$null;rawJson=$newText;salvageText=$longestResponseSnapshot;elapsedMs=[int]$sw.ElapsedMilliseconds;tail=($newText.Substring([Math]::Max(0,$newText.Length-200)))}
            }
        }

        if ($markerIdx -ge 0) {
            $answerMeta=$null
            $answer = Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$answerMeta)
            if ($answer) {
                $info = Get-KoseiReviewCompleteness -Json $answer -ExpectedPages $ExpectedPages
                if ($info.complete) {
                    if (Test-KoseiCopilotGenerating -WsUrl $WsUrl) { $null = Invoke-KoseiClickStop -WsUrl $WsUrl }
                    $parseSummary=@($answerMeta.parseErrors)-join ' | ';if($parseSummary.Length -gt 200){$parseSummary=$parseSummary.Substring(0,200)+'…'}
                    Write-KoseiLog ("回答取得 completedBy=marker source=$source elapsedMs=$($sw.ElapsedMilliseconds) jsonLen=$($answer.Length) repaired=$($answerMeta.repaired) fixes=$(@($answerMeta.fixes)-join ',') parseErrors=$parseSummary candidateHeads=$(@($answerMeta.candidateHeads)-join ' | ') findings=$($info.findingsCount) pagesChecked=$(@($info.pagesChecked) -join ',') coverage=$([Math]::Round($info.coverage,3))") 'INFO'
                    return [pscustomobject]@{ ok=$true; completedBy='marker'; json=$answer; rawJson=$newText; diagnostics=$answerMeta; repaired=[bool]$answerMeta.repaired; fixes=@($answerMeta.fixes); elapsedMs=[int]$sw.ElapsedMilliseconds; findingsCount=$info.findingsCount; pagesChecked=$info.pagesChecked; coverage=$info.coverage; warning=$info.warning }
                }
                $lastIncompleteAnswer=$answer; $lastIncompleteInfo=$info; $lastIncompleteRaw=$newText; $lastIncompleteMeta=$answerMeta
                if($answer.Length -ne $lastIncompleteLogLength -or ((Get-Date)-$lastIncompleteLogAt).TotalSeconds -ge 10){
                    $lastIncompleteLogLength=$answer.Length;$lastIncompleteLogAt=Get-Date
                    Write-KoseiLog ("不完全回答を保留 source=marker jsonLen=$($answer.Length) repaired=$($answerMeta.repaired) fixes=$(@($answerMeta.fixes)-join ',') findings=$($info.findingsCount) pagesChecked=$(@($info.pagesChecked) -join ',') coverage=$([Math]::Round($info.coverage,3)) reason=$($info.warning)") 'WARN'
                }
            }
            # マーカー後に30秒変化せず生成も停止したら、最終修復結果を返して上位層の自動再試行へ渡す。
            if ($stableSec -ge 30 -and -not (Test-KoseiCopilotGenerating -WsUrl $WsUrl)) {
                $finalMeta=$null;$finalAnswer=Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$finalMeta)
                $finalInfo=if($finalAnswer){Get-KoseiReviewCompleteness -Json $finalAnswer -ExpectedPages $ExpectedPages}else{$null}
                if($finalAnswer -and $finalInfo.complete){
                    return [pscustomobject]@{ok=$true;completedBy='marker';json=$finalAnswer;rawJson=$newText;repaired=[bool]$finalMeta.repaired;fixes=@($finalMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$finalInfo.findingsCount;pagesChecked=$finalInfo.pagesChecked;coverage=$finalInfo.coverage;warning=$finalInfo.warning}
                }
                $diag=Get-KoseiReviewJsonDiagnostics -Text $newText
                $parseSummary=@($finalMeta.parseErrors)-join ' | ';if($parseSummary.Length -gt 200){$parseSummary=$parseSummary.Substring(0,200)+'…'}
                Write-KoseiLog ("不完全JSONから脱出 completedBy=incomplete-json stableSec=$([Math]::Round($stableSec,1)) repaired=$($finalMeta.repaired) fixes=$(@($finalMeta.fixes)-join ',') candidates=$($diag.count) parseErrors=$parseSummary candidateHeads=$(@($finalMeta.candidateHeads)-join ' | ')") 'WARN'
                return [pscustomobject]@{ok=$false;completedBy='incomplete-json';json=$finalAnswer;rawJson=$newText;repaired=[bool]$finalMeta.repaired;fixes=@($finalMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$(if($finalInfo){$finalInfo.findingsCount}else{0});pagesChecked=$(if($finalInfo){$finalInfo.pagesChecked}else{@()});coverage=$(if($finalInfo){$finalInfo.coverage}else{0});warning=$(if($finalInfo){$finalInfo.warning}else{'有効な回答JSONを復元できませんでした。'})}
            }
        }
        # マーカーが出ない場合の保険: 20秒安定し、生成停止を2回連続で確認する。
        if ($stableSec -ge 20) {
            $answerMeta=$null;$answer = Get-KoseiReviewAnswerJson -Text $newText -Metadata ([ref]$answerMeta)
            if ($answer) {
                if (Test-KoseiCopilotGenerating -WsUrl $WsUrl) { $notGeneratingPolls=0 } else { $notGeneratingPolls++ }
                $info = Get-KoseiReviewCompleteness -Json $answer -ExpectedPages $ExpectedPages
                if ($info.complete -and $notGeneratingPolls -ge 2) {
                    Write-KoseiLog ("回答取得 completedBy=json-stable elapsedMs=$($sw.ElapsedMilliseconds) jsonLen=$($answer.Length) findings=$($info.findingsCount) pagesChecked=$(@($info.pagesChecked) -join ',') coverage=$([Math]::Round($info.coverage,3))") 'WARN'
                    return [pscustomobject]@{ok=$true;completedBy='json-stable';json=$answer;rawJson=$newText;repaired=[bool]$answerMeta.repaired;fixes=@($answerMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$info.findingsCount;pagesChecked=$info.pagesChecked;coverage=$info.coverage;warning=$info.warning}
                }
                if (-not $info.complete) { $lastIncompleteAnswer=$answer; $lastIncompleteInfo=$info;$lastIncompleteRaw=$newText;$lastIncompleteMeta=$answerMeta }
            }
        } else { $notGeneratingPolls=0 }
    }
    $tail = ''
    try {
        $text = Get-KoseiMainText -WsUrl $WsUrl
        if ($text.Length -gt $BaselineLength) { $tail = $text.Substring($BaselineLength) }
        if ($tail.Length -gt 200) { $tail = $tail.Substring($tail.Length - 200) }
    } catch {}
    $null = Invoke-KoseiClickStop -WsUrl $WsUrl
    if ($lastIncompleteAnswer) {
        Write-KoseiLog ("回答待機タイムアウト。不完全JSONを返却 jsonLen=$($lastIncompleteAnswer.Length) findings=$($lastIncompleteInfo.findingsCount) pagesChecked=$(@($lastIncompleteInfo.pagesChecked) -join ',') coverage=$([Math]::Round($lastIncompleteInfo.coverage,3))") 'WARN'
        return [pscustomobject]@{ok=$false;completedBy='incomplete-json';json=$lastIncompleteAnswer;rawJson=$lastIncompleteRaw;repaired=[bool]$lastIncompleteMeta.repaired;fixes=@($lastIncompleteMeta.fixes);elapsedMs=[int]$sw.ElapsedMilliseconds;findingsCount=$lastIncompleteInfo.findingsCount;pagesChecked=$lastIncompleteInfo.pagesChecked;coverage=$lastIncompleteInfo.coverage;warning=('応答が不完全なままタイムアウトしました。'+$lastIncompleteInfo.warning)}
    }
    Write-KoseiLog ("回答待機タイムアウト elapsedMs=$($sw.ElapsedMilliseconds) lastLen=$lastLen stableSec=$([Math]::Round(((Get-Date)-$stableSince).TotalSeconds,1)) fetchErrors=$fetchErrors tail=" + $tail) 'ERROR'
    return [pscustomobject]@{ ok = $false; completedBy = 'timeout'; json = $null; elapsedMs = [int]$sw.ElapsedMilliseconds; tail = $tail }
}

# ---------------------------------------------------------------------
# ウォームアップ状態
# ---------------------------------------------------------------------
function Get-KoseiWarmupStatusPath {
    return (Join-Path (Get-KoseiSubDir 'runtime') 'copilot-warmup.json')
}

function Write-KoseiWarmupStatus {
    param([Parameter(Mandatory=$true)][string]$State, [string]$Detail = '')
    $obj = @{ state = $State; detail = $Detail; updated_at = (Get-Date).ToString('s') }
    try {
        $json = $obj | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText((Get-KoseiWarmupStatusPath), $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

function Read-KoseiWarmupStatus {
    $path = Get-KoseiWarmupStatusPath
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ state = 'unknown'; detail = ''; updated_at = '' }
    }
    try {
        return ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ state = 'unknown'; detail = ''; updated_at = '' }
    }
}

function Invoke-KoseiSameChatRetry {
    param([Parameter(Mandatory=$true)][string]$WsUrl,[Parameter(Mandatory=$true)]$Settings)
    $js=@'
(() => {
  const visible=e=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const b=buttons.reverse().find(e=>/(再試行|再生成|retry|regenerate|try again)/i.test((e.innerText||e.getAttribute('aria-label')||e.title||'').trim()));
  if(!b)return false;b.click();return true;
})()
'@
    try{$retryRaw=Invoke-KoseiCdpEval -WebSocketUrl $WsUrl -Expression $js -TimeoutSeconds 15;$clicked=([string]$retryRaw).ToLowerInvariant() -eq 'true'}catch{$clicked=$false}
    if($clicked){Write-KoseiLog '同一チャットの再試行ボタンをクリック' 'WARN';return $true}
    try{
        Invoke-KoseiInsertPrompt -WsUrl $WsUrl -Settings $Settings -Prompt '直前の処理を再試行し、添付指示書どおりの厳密なJSONだけを最後まで出力してください。'
        $null=Invoke-KoseiClickSend -WsUrl $WsUrl
        Write-KoseiLog '同一チャットへ再依頼文を送信' 'WARN';return $true
    }catch{Write-KoseiLog ("同一チャット再試行に失敗: "+$_.Exception.Message) 'WARN';return $false}
}

function Write-KoseiRefusalStat {
    param([string]$CompletedBy,[int]$ElapsedMs)
    try{
        $path=Join-Path (Get-KoseiSubDir 'runtime') 'refusal-stats.csv'
        if(-not (Test-Path -LiteralPath $path)){Add-Content -LiteralPath $path -Value 'timestamp,completed_by,elapsed_ms' -Encoding UTF8}
        Add-Content -LiteralPath $path -Value ((Get-Date).ToString('s')+','+$CompletedBy+','+$ElapsedMs) -Encoding UTF8
    }catch{}
}

# ---------------------------------------------------------------------
# オーケストレーション: 1パケットの校正依頼
# ---------------------------------------------------------------------
function Invoke-KoseiCopilotReviewRequest {
    param(
        [Parameter(Mandatory=$true)]$Settings,
        [Parameter(Mandatory=$true)][string]$Prompt,
        [string[]]$AttachPaths = @(),
        # ChatMode（計画書 §7.1）: New=新規チャット+モデル選択+添付 /
        #   Reuse=現チャット維持（添付・モデル選択を省略） / RestartWithContext=新規+再添付
        [ValidateSet('New','Reuse','RestartWithContext')][string]$ChatMode = 'New',
        # 空なら $Settings.response_end_marker。turnごとに一意のマーカーを渡す（§7.3）
        [string]$Marker = '',
        [scriptblock]$OnPhase = $null,
        [scriptblock]$ShouldCancel = $null,
        [scriptblock]$OnWaitProgress = $null,
        [int[]]$ExpectedPages = @()
    )
    $report = {
        param([string]$Phase)
        if ($OnPhase) { try { & $OnPhase $Phase } catch {} }
    }

    $totalWatch=[System.Diagnostics.Stopwatch]::StartNew();$phaseTimes=[ordered]@{model_select_ms=0;attach_ms=0;input_send_ms=0;response_wait_ms=0};$phaseWatch=[System.Diagnostics.Stopwatch]::StartNew()
    if ($ChatMode -eq 'Reuse' -and $AttachPaths.Count -gt 0) { throw 'ChatMode=Reuse では新規添付を渡せません（§7.1）。' }
    & $report 'preparing'
    Start-KoseiCopilotEdge -Settings $Settings
    $page = Get-KoseiCopilotPage -Settings $Settings
    $wsUrl = [string]$page.webSocketDebuggerUrl
    $null=Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'job-start'

    $readyTimeout = [int]$script:KoseiCopilotPacketReadyTimeoutSeconds
    $gate = Wait-KoseiCopilotScreenReady -WsUrl $WsUrl -Settings $Settings -TimeoutSeconds $readyTimeout -ShouldCancel $ShouldCancel
    if ($gate.cancelled) { return [pscustomobject]@{ ok=$false; completedBy='cancelled'; elapsedMs=0 } }
    if (-not $gate.ok) { throw ([string]$gate.message) }

    # Reuse は現在のチャットを維持し、新規チャット遷移・2回目ゲート・モデル選択・添付を省略する（§7.1）。
    # New / RestartWithContext は従来どおり全て実行する（既定 New は v94 と同一挙動）。
    if ($ChatMode -ne 'Reuse') {
        $fresh = Invoke-KoseiFreshChat -WsUrl $wsUrl -Settings $Settings
        # 新規チャットボタンのクリック時も、Page.navigateによる初期化時も、
        # 読み込み完了を推測せず同じ60秒ゲートを必ず通す。
        $gate = Wait-KoseiCopilotScreenReady -WsUrl $wsUrl -Settings $Settings -TimeoutSeconds ([int]$script:KoseiCopilotPacketReadyTimeoutSeconds) -ShouldCancel $ShouldCancel
        if ($gate.cancelled) { return [pscustomobject]@{ ok=$false; completedBy='cancelled'; elapsedMs=0 } }
        if (-not $gate.ok) { throw ([string]$gate.message) }

        # モデルセレクターを優先度リスト（既定: GPT 5.6 Think deeper → Opus → Think Deeper）へ切替。全滅時は変更せず続行。
        $phaseWatch.Restart();$null = Set-KoseiCopilotModel -WsUrl $wsUrl -Settings $Settings;$phaseTimes.model_select_ms=[int]$phaseWatch.ElapsedMilliseconds

        if ($AttachPaths.Count -gt 0) {
            & $report 'attaching'
            $phaseWatch.Restart();$attachResult = Invoke-KoseiCopilotAttachFiles -WsUrl $wsUrl -Settings $Settings -Files $AttachPaths -ShouldCancel $ShouldCancel;$phaseTimes.attach_ms=[int]$phaseWatch.ElapsedMilliseconds
            if ($attachResult.completedBy -eq 'cancelled') { return $attachResult }
        }
    }

    & $report 'sending'
    $phaseWatch.Restart()
    $baseline = (Get-KoseiMainText -WsUrl $wsUrl).Length
    Invoke-KoseiInsertPrompt -WsUrl $wsUrl -Settings $Settings -Prompt $Prompt
    # 添付の後処理中は送信ボタンが一時的に無効なことがあるためリトライする
    $sendDeadline = (Get-Date).AddSeconds(20)
    $sent = $false
    $lastSendError = ''
    while ((Get-Date) -lt $sendDeadline) {
        try { $null = Invoke-KoseiClickSend -WsUrl $wsUrl; $sent = $true; break }
        catch { $lastSendError = $_.Exception.Message; Start-Sleep -Milliseconds 1000 }
    }
    if (-not $sent) { throw ("送信ボタンをクリックできませんでした: " + $lastSendError) }
    $phaseTimes.input_send_ms=[int]$phaseWatch.ElapsedMilliseconds

    & $report 'waiting'
    $phaseWatch.Restart();$wait = Wait-KoseiCopilotReviewResponse -WsUrl $wsUrl -Settings $Settings -BaselineLength $baseline -Marker $Marker -TimeoutSeconds ([int]$Settings.request_timeout) -ShouldCancel $ShouldCancel -OnProgress $OnWaitProgress -ExpectedPages $ExpectedPages;$phaseTimes.response_wait_ms=[int]$phaseWatch.ElapsedMilliseconds
    if(@('copilot-refusal','no-json-idle') -contains [string]$wait.completedBy){
        Write-KoseiRefusalStat -CompletedBy ([string]$wait.completedBy) -ElapsedMs ([int]$wait.elapsedMs)
        $salvage=[string]$wait.salvageText
        if(Invoke-KoseiSameChatRetry -WsUrl $wsUrl -Settings $Settings){
            $retryBaseline=(Get-KoseiMainText -WsUrl $wsUrl).Length
            $retry=Wait-KoseiCopilotReviewResponse -WsUrl $wsUrl -Settings $Settings -BaselineLength $retryBaseline -Marker $Marker -TimeoutSeconds ([Math]::Min(300,[int]$Settings.request_timeout)) -ShouldCancel $ShouldCancel -OnProgress $OnWaitProgress -ExpectedPages $ExpectedPages
            if([string]::IsNullOrWhiteSpace([string]$retry.salvageText) -and -not [string]::IsNullOrWhiteSpace($salvage)){$retry|Add-Member -NotePropertyName salvageText -NotePropertyValue $salvage -Force}
            $wait=$retry
        }
    }
    if ($wait.completedBy -eq 'cancelled') { return $wait }
    if (-not $wait.ok -and @('incomplete-json','copilot-refusal','no-json-idle') -notcontains [string]$wait.completedBy) {
        throw ("Copilot回答を取得できませんでした（timeout）。末尾: " + [string]$wait.tail)
    }
    $wait | Add-Member -NotePropertyName phaseTimings -NotePropertyValue ([pscustomobject]$phaseTimes) -Force
    $wait | Add-Member -NotePropertyName totalElapsedMs -NotePropertyValue ([int]$totalWatch.ElapsedMilliseconds) -Force
    Write-KoseiLog ("パケット所要時間 totalMs=$($wait.totalElapsedMs) modelMs=$($phaseTimes.model_select_ms) attachMs=$($phaseTimes.attach_ms) sendMs=$($phaseTimes.input_send_ms) responseMs=$($phaseTimes.response_wait_ms)") 'INFO'
    return $wait
}
