# Run-Benchmark.ps1 — 幅の実験を無人で走らせる。
#
#   powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1
#   powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1 -Config consistency25
#   powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1 -CheckOnly
#
# 5通りの構成（整合性 幅25 / 50 / 100 / 200、校正 幅10）を順に実行し、
# 各runの結果を docs\benchmarks\runs\raw\ に保存する。200ページ版では
# 9+4+2+1+20 = 36 ターン。1ターン30〜60秒（review_max_workers=4 なら実時間はその1/3程度）。
# その間クリック操作は要らない。
#
# 仕組み: アプリ画面を CDP の Edge 側で開き、UIのボタンが呼ぶのと同じ関数を
# window.__koseiBenchmark 経由で呼ぶ。UI操作を模倣する別経路を作ると、
# 測っているものが製品の挙動とずれて幅の比較が無意味になる。
#
# 前提:
#   - アプリが起動していること（PDF校正アシスト起動.cmd）
#   - Copilot のウォームアップが済んでいること（画面が「準備完了」）
#   - settings.json が README の4キーどおりであること

param(
    [ValidateSet('all', 'combined25', 'combined50', 'combined100', 'combined200', 'split200', 'parallel200', 'rounds2', 'proofread10', 'consistency25')]
    [string]$Config = 'all',
    [string]$TargetPath = '/docs/benchmarks/fixtures/aoi-long_en_TARGET.pdf',
    [string]$ReferencePath = '/docs/benchmarks/fixtures/aoi-long_ja_REF.pdf',
    # 比較資料なしで回す。実物の開示書類は日本語原文が手に入らないことがある。
    # 整合性レビューはもともとREFを添付しないので、無しでも製品と同じ条件になる。
    # ⚠️ -ReferencePath '' では駄目。powershell -File 経由だと空文字が引数として渡らず
    #    「Missing an argument」で落ちる（実測 2026-08-05）。スイッチで指定すること。
    [switch]$NoReference,
    [int]$TimeoutMinutes = 120,
    [switch]$CheckOnly,
    # 無人で走らせる間、Copilot画面が見えないと何が起きているか分からない。
    # 既定で表示する（アプリ本体の最小化動作は copilot-user-visible.flag で抑止される）。
    [switch]$HideBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
Set-KoseiRoot -Root $Root
. (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
. (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')

function Write-Step { param([string]$Text) Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Text) }

$settings = Get-KoseiSettings
$settingsError = Get-KoseiSettingsError
if ($settingsError) { throw ("settings.json を読めていません: " + $settingsError) }
$port = [int]$settings.cdp_port

# Copilot画面を見えるところに出す。添付やサインインで止まったとき、
# わざわざ[Copilot画面を表示]を押しに行かないと確認できないのは無人実行に向かない。
if (-not $HideBrowser) {
    try { $null = Show-KoseiCopilotEdgeWindow -Settings $settings; Write-Step 'Copilot画面を表示しました（-HideBrowser で抑止できます）' }
    catch { Write-Step ('Copilot画面の表示に失敗（処理は継続）: ' + $_.Exception.Message) }
}

$urlFile = Join-Path $Root 'local-app.url'
if (!(Test-Path -LiteralPath $urlFile -PathType Leaf)) { throw 'local-app.url がありません。先にアプリを起動してください。' }
$appUrl = (Get-Content -LiteralPath $urlFile -TotalCount 1).Trim()
if ([string]::IsNullOrWhiteSpace($appUrl)) { throw 'local-app.url が空です。' }
Write-Step ("アプリURL: " + $appUrl)

# --- CDP: アプリ画面のタブを用意する -----------------------------------
# 起動時の Start-Process は既定ブラウザで開くため、CDP からは見えないことがある。
# その場合は CDP 側の Edge に新しいタブを作る。
function Get-AppPageWs {
    param([string]$Url, [int]$Port)
    $targets = @(Get-KoseiCdpTargets -Port $Port)
    foreach ($t in $targets) {
        if (([string]$t.type) -ne 'page') { continue }
        if (([string]$t.url).StartsWith($Url, [System.StringComparison]::OrdinalIgnoreCase)) { return [string]$t.webSocketDebuggerUrl }
    }
    return ''
}

$pageWs = Get-AppPageWs -Url $appUrl -Port $port
if ([string]::IsNullOrWhiteSpace($pageWs)) {
    Write-Step 'CDP側にアプリのタブが無いので新しく開きます'
    $version = Invoke-RestMethod -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f $port) -TimeoutSec 5
    $browserWs = [string]$version.webSocketDebuggerUrl
    if ([string]::IsNullOrWhiteSpace($browserWs)) { throw 'ブラウザのWebSocketを取得できません。Edgeがデバッグポートで起動しているか確認してください。' }
    # ⚠️ 同じウィンドウに新しいタブとして開いてはいけない。アプリのタブが手前になると
    #    Copilot のタブが非アクティブ（document.visibilityState='hidden'）になり、
    #    レイアウトが更新されなくなる。実測でこの状態では添付一覧の実寸が0になり、
    #    回答本体の innerText も空になって「画面には見えているのに1文字も取れない」に陥る。
    #    別ウィンドウにすれば両方が visible のままでいられる
    #    （占有判定は起動時の --disable-features=CalculateNativeWinOcclusion で無効化済み）。
    $created = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.createTarget' -Params @{ url = $appUrl; newWindow = $true } -TimeoutSeconds 20
    if ($created.error) {
        Write-Step ('  別ウィンドウで開けなかったので同じウィンドウに開きます: ' + ($created.error | ConvertTo-Json -Compress))
        $null = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.createTarget' -Params @{ url = $appUrl } -TimeoutSeconds 20
    }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $pageWs = Get-AppPageWs -Url $appUrl -Port $port
        if (-not [string]::IsNullOrWhiteSpace($pageWs)) { break }
    }
}
if ([string]::IsNullOrWhiteSpace($pageWs)) { throw 'アプリのタブをCDPで見つけられませんでした。' }

# --- Copilotのタブが見えているか確認する -------------------------------
# 非アクティブなタブはレイアウトが更新されない。この状態では添付一覧の実寸が0になり、
# 回答本体の innerText も空になる（＝画面には見えているのにアプリは何も読めない）。
# 静かに壊れて40分が無駄になるので、走らせる前に必ず確かめる。
function Get-CopilotVisibility {
    try {
        $page = Get-KoseiCopilotPage -Settings $settings
        $js = "(() => JSON.stringify({ state: document.visibilityState, w: innerWidth, h: innerHeight }))()"
        return [string](Invoke-KoseiCdpEval -WebSocketUrl ([string]$page.webSocketDebuggerUrl) -Expression $js -TimeoutSeconds 15)
    } catch { return '' }
}
$vis = Get-CopilotVisibility
if ($vis -like '*hidden*' -or $vis -like '*"w":0*') {
    Write-Step ('Copilotのタブが非表示です（' + $vis + '）。前面に出し直します。')
    try {
        $page = Get-KoseiCopilotPage -Settings $settings
        $null = Invoke-KoseiCdpMethod -WebSocketUrl ([string]$page.webSocketDebuggerUrl) -Method 'Page.bringToFront' -TimeoutSeconds 15
    } catch { Write-Step ('  前面化に失敗（処理は継続）: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 1
    $vis = Get-CopilotVisibility
}
Write-Step ('Copilotタブの表示状態: ' + $vis)
if ($vis -like '*hidden*') {
    Write-Step '  警告: Copilotのタブが非表示のままです。添付一覧も回答本体も読めない可能性があります。'
    Write-Step '        Edge で Copilot のタブをクリックして手前にしてから実行し直してください。'
}

# パケット作成は pdf.js の page.render() を待つ。**Chromium は背面タブの描画を止めるので、
# アプリのタブが背面だとこの Promise が返らず、そこで永久に止まる。**
#
# ⚠️ 実測（2026-08-07）: 上の「Copilotのタブを前面に出す」処理でアプリのタブが背面へ落ち、
#    「SEC_001: TARGET_CHECK P.12 の表示とテキストレイヤーを検証中です。」から5分以上動かなくなった。
#    Page.bringToFront をアプリのタブへ投げた瞬間に P.12 → P.206 まで一気に進んだ。
#    ログはページ番号を指すので抽出やそのページを疑うが、原因はどのページでも起きる可視性である。
#    切り分けるときは **document.hidden を最初に見ること**。
function Show-AppTab {
    try {
        $null = Invoke-KoseiCdpMethod -WebSocketUrl $pageWs -Method 'Page.bringToFront' -TimeoutSeconds 15
        Start-Sleep -Milliseconds 300
        $h = [string](Invoke-KoseiCdpEval -WebSocketUrl $pageWs -Expression '(() => String(document.hidden))()' -TimeoutSeconds 15)
        if ($h -like '*true*') { Write-Step '  警告: アプリのタブが背面のままです。パケット作成が止まる可能性があります。' }
    } catch { Write-Step ('  アプリタブの前面化に失敗（処理は継続）: ' + $_.Exception.Message) }
}

function Invoke-App {
    param([string]$Expression, [int]$TimeoutSeconds = 120)
    return (Invoke-KoseiCdpEval -WebSocketUrl $pageWs -Expression $Expression -TimeoutSeconds $TimeoutSeconds)
}

function Wait-Hook {
    for ($i = 0; $i -lt 60; $i++) {
        $ok = $false
        try { $ok = [bool](Invoke-App -Expression 'Boolean(window.__koseiBenchmark)' -TimeoutSeconds 10) } catch { $ok = $false }
        if ($ok) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'window.__koseiBenchmark が現れません。index.html が古い可能性があります（git pull を確認）。'
}

# 開いている画面が、直したコードより古くないか。
#
# ⚠️ Reset-App は画面を読み込み直さない（読み込み直すとサーバーが止まるため）。
#    つまりコードを直しても、開いたままの画面は**古い JS のまま**走る。
#    実測（2026-08-05）: マスカーを直した直後に回した run が直す前の挙動のままで、
#    5分ぶんの測定を捨てた。しかも出力は一見まともなので、気づくのは採点した後になる。
function Assert-FreshPage {
    $loadedAt = $null
    try { $loadedAt = [datetime](Invoke-App -Expression 'window.__koseiBenchmark.loadedAt' -TimeoutSeconds 10) } catch { }
    if (-not $loadedAt) {
        Write-Step '  注意: 画面の読み込み時刻が取れません（index.html が古い可能性があります）'
        return
    }
    $newest = Get-ChildItem -Path (Join-Path $Root 'js'), (Join-Path $Root 'index.html') -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newest -and $newest.LastWriteTimeUtc -gt $loadedAt.ToUniversalTime()) {
        throw ("画面が古いコードで動いています。" + $newest.Name + " は " +
            $newest.LastWriteTime.ToString('HH:mm:ss') + " に更新されましたが、画面の読み込みは " +
            $loadedAt.ToLocalTime().ToString('HH:mm:ss') + " です。アプリを再起動してから走らせてください。")
    }
}

function Reset-App {
    # runごとに状態を戻す。findings は画面に溜まるので、前のrunが混ざらないようにする。
    #
    # ⚠️ Page.navigate で読み込み直してはいけない。beforeunload が /__page-closed を送り、
    #    サーバーが2秒後に停止する。実測では2本目の loadTarget が "Failed to fetch" で落ちた。
    #    比較資料を消すだけでよい（findings は loadTarget() が空にする）。
    $null = Invoke-App -Expression 'window.__koseiBenchmark.reset()'
}

# 失敗したパケットを取り直す。1セクション落ちたまま進むと、その範囲の誤りが
# 「検出できなかった」のか「そもそも見ていない」のか区別できなくなる。
function Invoke-RetryFailedPackets {
    param([int]$MaxRounds = 2)
    for ($round = 1; $round -le $MaxRounds; $round++) {
        $packets = @(Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.packets())' | ConvertFrom-Json)
        $failed = @($packets | Where-Object { $_.status -eq 'error' })
        if (-not $failed.Count) { return }
        Write-Step ("  失敗 " + $failed.Count + "件をリトライします（" + $round + "回目）: " + (($failed | ForEach-Object { $_.packet_id }) -join ', '))
        foreach ($f in $failed) {
            $ok = Invoke-App -Expression ("window.__koseiBenchmark.retry(" + (ConvertTo-Json $f.packet_id) + ")")
            if (-not $ok) { Write-Step ("  " + $f.packet_id + " はリトライできません: " + (Invoke-App -Expression 'window.__koseiBenchmark.status().last_error')); continue }
            Wait-Idle -Label ("リトライ " + $f.packet_id)
        }
    }
    $packets = @(Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.packets())' | ConvertFrom-Json)
    $still = @($packets | Where-Object { $_.status -eq 'error' })
    if ($still.Count) {
        Write-Step ("  警告: リトライしても失敗が残りました: " + (($still | ForEach-Object { $_.packet_id }) -join ', '))
        Write-Step '  そのセクションの範囲は未測定として扱ってください（0件ではありません）。'
    }
}

# 実行が終わるまで待つ。開始が確認できないときは例外にする。
function Wait-Idle {
    param([string]$Label = '')
    $started = $false
    $s = $null
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $s = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
        if ($s.running) { $started = $true; break }
        if ($s.last_error) { throw ("開始できませんでした: " + $s.last_error) }
    }
    # 開始に失敗しても、理由はアプリ側のカードに出ている。それを持ってこないと
    # 「画面の状態を確認してください」だけが残り、実測で原因を追えなかった。
    if (-not $started) {
        $why = @()
        if ([string]$s.last_error) { $why += ('last_error=' + [string]$s.last_error) }
        if ([string]$s.card)       { $why += ('card=' + [string]$s.card) }
        if ([string]$s.detail)     { $why += ('detail=' + [string]$s.detail) }
        $why += ("pages=" + [string]$s.target_pages + " ref=" + [string]$s.reference_total_pages + " chunk=" + [string]$s.chunk)
        throw ($Label + ': 開始を確認できませんでした。 ' + ($why -join ' / '))
    }

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $lastCard = ''
    $lastChangeAt = Get-Date
    $lastBeatAt = Get-Date
    while ($true) {
        Start-Sleep -Seconds 10
        $s = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
        if ([string]$s.card -ne $lastCard) {
            $lastCard = [string]$s.card; $lastChangeAt = Get-Date; $lastBeatAt = Get-Date
            Write-Step ("  " + $lastCard)
        } elseif (((Get-Date) - $lastBeatAt).TotalSeconds -ge 60) {
            # 表示が変わらない間も生きていることを見せる。無音だと「止まった」と区別できない。
            # 添付は60秒で、回答待ちは response_stall_seconds で打ち切られるので、
            # 数分の無音は異常。そのときはパケット別の状態も出す。
            $lastBeatAt = Get-Date
            $quietSec = [int]((Get-Date) - $lastChangeAt).TotalSeconds
            # パケット作成中はカードが動かないので、細かい進捗（detail）を添える。
            $detail = [string]$s.detail
            if ($detail.Length -gt 90) { $detail = $detail.Substring(0, 90) + '…' }
            Write-Step ("  …表示に変化なし " + $quietSec + "秒（実行中）" + $(if ($detail) { " / " + $detail } else { "" }))
            if ($quietSec -ge 300) {
                Write-Step ("  パケット状態: " + (Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.packets())'))
                Write-Step "  5分以上動きがありません。Copilot画面（CDP側のEdge）に確認ダイアログやサインイン要求が出ていないか見てください。"
            }
        }
        if (-not $s.running) { break }
        if ((Get-Date) -gt $deadline) { throw ("時間切れ（" + $TimeoutMinutes + "分）。画面の状態を確認してください。") }
    }
    if ($s.last_error) { Write-Step ("  警告: " + $s.last_error) }
}

# --- 構成 ---------------------------------------------------------------
# 校正パケットは10ページ固定と決めた（英語単体の綴り・文法まで見るため）。
# したがって測るのは「整合性は何ページ幅か」と「校正10pがA1〜A4をどこまで取れるか」の2つ。
#
# 整合性の幅は、広げるほど**安くなり、しかも遠くまで届く**（200p を幅25で切ると9ターン、
# 幅100なら2ターン。同一セクションに入る跨ぎ数値ペアも 6→17 に増える）。
# つまり争点は「どこまで広げると品質が落ちるか」だけ。25 / 50 / 100 を比べる。
# 幅40・60 は境界の落ち方の都合で幅25と到達範囲がほぼ同じになり、比べても何も分からない。
#
# combined200 は文書全体を1セクションにする天井の測定。距離110/130 の帯は幅100では
# 原理的に届かないので、これを走らせないと「幅100で足りる」のか「素材が届いていないだけ」かを
# 分けられない。ターン数は1なので安い。
$configs = @(
    @{ name = 'combined25';    kind = 'consistency'; width = 25;  overlap = 3; combined = $true;  profile = 'consistency1'; inAll = $true;  note = '統合1ターン 幅25・重ね3（9セクション）' },
    @{ name = 'combined50';    kind = 'consistency'; width = 50;  overlap = 3; combined = $true;  profile = 'consistency1'; inAll = $true;  note = '統合1ターン 幅50・重ね3（4セクション）' },
    @{ name = 'combined100';   kind = 'consistency'; width = 100; overlap = 3; combined = $true;  profile = 'consistency1'; inAll = $true;  note = '統合1ターン 幅100・重ね3（2セクション）' },
    @{ name = 'combined200';   kind = 'consistency'; width = 200; overlap = 3; combined = $true;  profile = 'consistency1'; inAll = $true;  note = '統合1ターン 幅200（全文1セクション。距離110/130 の天井）' },
    @{ name = 'split200';      kind = 'consistency'; width = 200; overlap = 3; combined = $false; profile = 'consistency2';  inAll = $false; note = '観点分割 幅200（直列の追撃3ターン。-Config で明示したときだけ）' },
    @{ name = 'parallel200';   kind = 'consistency'; width = 200; overlap = 3; combined = $true;  profile = 'consistency1'; lenses = @('broad','terms','numbers','structure'); inAll = $false; note = '観点分割 幅200・1ラウンド（-Config で明示したときだけ。rounds2 との比較用）' },
    @{ name = 'rounds2';       kind = 'consistency'; width = 200; overlap = 3; combined = $true;  profile = 'consistency1'; lenses = @('broad','terms','numbers','structure'); round2Lenses = @('gap','terms','numbers','structure'); rounds = 2; inAll = $true; note = '観点分割 幅200・2ラウンド（ラウンド内は並列4、ラウンド間は直列）' },
    @{ name = 'proofread10';   kind = 'proofread';   width = 10;  overlap = 0; combined = $false; profile = '';             inAll = $true;  note = '校正 幅10（20パケット）' },
    @{ name = 'consistency25'; kind = 'consistency'; width = 25;  overlap = 3; combined = $false; profile = '';             inAll = $false; note = '整合性4pass 幅25（追撃passの比較用。-Config で明示したときだけ走る）' }
)
if ($Config -eq 'all') { $configs = @($configs | Where-Object { $_.inAll }) }
else { $configs = @($configs | Where-Object { $_.name -eq $Config }) }

$outDir = Join-Path $Root 'docs\benchmarks\runs\raw'
$null = New-Item -ItemType Directory -Force -Path $outDir
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stamp = Get-Date -Format 'yyyy-MM-dd'

Wait-Hook
Assert-FreshPage

foreach ($cfg in $configs) {
    Write-Step ("=== " + $cfg.note + " ===")
    Reset-App

    # 読み込みもページを描くので、背面タブだと handlePdfFile が返らない。
    # startConsistency の直前だけでは足りない（実測 2026-08-07）。
    Show-AppTab

    $t = Invoke-App -Expression ("window.__koseiBenchmark.loadTarget(" + (ConvertTo-Json $TargetPath) + ").then(r => JSON.stringify(r))") -TimeoutSeconds 180
    Write-Step ("  校正対象を読み込み: " + $t)
    # -NoReference で比較資料なし。整合性レビューはもともとREFを添付しないので条件は変わらない。
    # 校正パケットは比較照合の分だけ落ちるので、その旨を出しておく。
    if ($NoReference -or [string]::IsNullOrWhiteSpace($ReferencePath)) {
        Write-Step ("  比較資料: なし（-NoReference）" + $(if ($cfg.kind -eq 'proofread') { ' ※校正パケットは翻訳整合を見られません' } else { '' }))
    } else {
        $r = Invoke-App -Expression ("window.__koseiBenchmark.loadReference(" + (ConvertTo-Json $ReferencePath) + ").then(r => JSON.stringify(r))") -TimeoutSeconds 180
        Write-Step ("  比較資料を読み込み: " + $r)
    }
    $a = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.selectAllPages())'
    Write-Step ("  ページ範囲: " + $a)

    if ($cfg.kind -eq 'proofread') {
        $c = Invoke-App -Expression ("JSON.stringify(window.__koseiBenchmark.setChunkSize(" + $cfg.width + "))")
        Write-Step ("  1回あたりの校正対象: " + $c)
    }

    if ($CheckOnly) {
        Write-Step ("  状態: " + (Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.status())'))
        Write-Step '  -CheckOnly なので実行はしません'
        continue
    }

    if ($cfg.kind -eq 'consistency') {
        # lenses を指定した構成は、観点ごとに別パケットへ展開して**並列**に流す。
        # 追撃（Reuse）は前のターンに依存するので直列にしかできないが、
        # 既出一覧を渡さない観点は独立に投げられる。
        $lensJson = if ($cfg.ContainsKey('lenses') -and @($cfg.lenses).Count) {
            ", lenses: " + (ConvertTo-Json @($cfg.lenses) -Compress)
        } else { '' }
        # ラウンド2は既出一覧（報告禁止リスト）を渡すので、ラウンド1の結果が要る。
        # ラウンド内は並列、ラウンド間だけ直列になる。
        if ($cfg.ContainsKey('rounds') -and [int]$cfg.rounds -gt 1) {
            $lensJson += ", rounds: " + [int]$cfg.rounds
            if ($cfg.ContainsKey('round2Lenses') -and @($cfg.round2Lenses).Count) {
                $lensJson += ", round2Lenses: " + (ConvertTo-Json @($cfg.round2Lenses) -Compress)
            }
        }
        $opts = "{ sectionWidth: " + $cfg.width + ", overlap: " + $cfg.overlap +
                ", combined: " + $(if ($cfg.combined) { 'true' } else { 'false' }) +
                ", profile: " + (ConvertTo-Json ([string]$cfg.profile)) + $lensJson + " }"
        Show-AppTab   # パケット作成の描画待ちで止まらないよう、アプリのタブを前面へ
        $null = Invoke-App -Expression ("window.__koseiBenchmark.startConsistency(" + $opts + ")")
    } else {
        Show-AppTab
        $null = Invoke-App -Expression 'window.__koseiBenchmark.startProofread()'
    }

    Wait-Idle -Label $cfg.name
    Invoke-RetryFailedPackets

    $json = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.report())' -TimeoutSeconds 120
    # ⚠️ 同じ日に同じ構成をもう一度走らせると、以前は**黙って上書き**していた。
    #    実測で、長尺フィクスチャの測定結果を、別のフィクスチャで回したスモークが潰した。
    #    測定結果は文書から名指しで参照されるので、消えると裏が取れなくなる。
    #    既にあるときは時刻を足して別ファイルにする。
    $dest = Join-Path $outDir ("{0}_{1}.json" -f $stamp, $cfg.name)
    if (Test-Path -LiteralPath $dest -PathType Leaf) {
        $dest = Join-Path $outDir ("{0}-{1}_{2}.json" -f $stamp, (Get-Date -Format 'HHmm'), $cfg.name)
        Write-Step ("  同名の結果があるので別名で保存します: " + [System.IO.Path]::GetFileName($dest))
    }
    [System.IO.File]::WriteAllText($dest, $json, $utf8)
    # .count はPSの組み込みメンバと紛らわしいので findings 配列の長さを数える
    $count = @(($json | ConvertFrom-Json).findings).Count
    Write-Step ("  保存: " + $dest + "（指摘 " + $count + "件）")
}

Write-Step '完了。次に採点します:'
Write-Host ''
Write-Host '  node docs/benchmarks/report-to-run.mjs docs/benchmarks/runs/raw/<file>.json --out docs/benchmarks/runs/<name>.json'
Write-Host '  node docs/benchmarks/score.mjs docs/benchmarks/fixtures/gold-long.json docs/benchmarks/runs/<name>.json --reachable 25 --by kind,distance'
Write-Host ''
Write-Host '  ※ --reachable は run の幅に合わせる（combined100 なら --reachable 100）。'
Write-Host '    整合性の run は REF を添付していないので --no-ref も付ける。'
Write-Host '    さらに --scope consistency を必ず付ける。付け忘れると、整合性モードが担当しない'
Write-Host '    局所誤り（綴り・文法）まで分母に入り、recall を大きく低く見誤る。'
Write-Host '    実測 2026-08-07: 付け忘れで 62%、正しくは 86%。'
Write-Host ''
Write-Host 'Node が無い場合は docs/benchmarks/runs/raw/ の JSON をそのまま渡してください。'
