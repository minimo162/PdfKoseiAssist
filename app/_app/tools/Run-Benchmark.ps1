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
    [switch]$HideBrowser,
    # 他の作業が同じ Copilot を使っていても止めずに走る。
    # ⚠️ 測定には使わないこと。取り合うと応答が中断され、数字が下振れする（下の説明を参照）。
    [switch]$AllowSharedCopilot,
    # Copilot が不調でも止めずに走る。⚠️ 測定には使わないこと（未完になるだけ）。
    [switch]$IgnoreCopilotHealth
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

# ⚠️ 同じ Copilot を他の作業が使っていないか見る。
#
#    Copilot は1アカウントで1つしかない。この機械では ManualBuilder や Yakulingo も
#    Copilot を叩くので、測定中に取り合いになる。そうなると応答が途中で切られ
#    （アプリ側は「応答中断を検出しました」と出して新規チャットで再試行する）、
#    落ちたパケットの範囲は「検出できなかった」ではなく「見ていない」になる。
#
#    実測 2026-08-07: ManualBuilder の e2e と Yakulingo の対訳作成が動いている最中に
#    測ったら recall が 85.7% → 78.6% に見え、対照実験では4本とも中断されて0件になった。
#    素材のせいだと**1時間以上追ってしまった**。数字は出るので、気づけない。
#
#    見分け方: Copilot を叩く作業はコマンドラインに copilot を含む（アプリのサーバー
#    プロセス（Start-*.ps1）は含まない）。自分自身と、このリポジトリ配下は除く。
#    ⚠️ この問い合わせを子プロセス（powershell -Command）でやってはいけない。
#       複数行の文字列は引数の途中で切られ、**黙って0件を返す**。実測でそれに嵌った。
#       ここは PowerShell なのだから、そのまま同じプロセスで問い合わせればよい。
#    ⚠️ **一瞬だけ存在するプロセスを拾ってはいけない。** 実測 2026-08-07: `ready.js` という
#       名前の短命な node を拾い、40分の測定バッチが1本目で止まった（調べたときには
#       もう消えていた）。Copilot を実際に叩く作業は数分は生きているので、
#       **少し間を置いて2回見て、両方に居るものだけ**を相手とみなす。
function Get-CopilotDriverSnapshot {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='node.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -match 'copilot' -and
                $_.CommandLine -notmatch 'PdfKoseiAssist' -and   # 自分たちの道具は除く
                $_.ProcessId -ne $PID
            })
    } catch { return @() }
}

function Get-OtherCopilotDrivers {
    $first = @(Get-CopilotDriverSnapshot)
    if (-not $first.Count) { return @() }
    Start-Sleep -Seconds 3
    $secondIds = @(Get-CopilotDriverSnapshot | ForEach-Object { $_.ProcessId })
    $procs = @($first | Where-Object { $secondIds -contains $_.ProcessId })
    $seen = @()
    foreach ($p in $procs) {
        # 見せるのはスクリプト名だけでよい。パスを全部出すと読む気が失せる。
        $name = ''
        foreach ($m in [regex]::Matches([string]$p.CommandLine, '[^\\\s"]+\.(ps1|mjs|js)')) { $name = $m.Value }
        if (-not $name) { $name = '(不明)' }
        $seen += ('PID ' + $p.ProcessId + ' ' + $name)
    }
    return $seen
}

# ⚠️ 見つけたら即座に落とす、では厳しすぎた。実測 2026-08-07: `ready.js` という
#    正体不明のプロセスが数分おきに現れ（3秒の再確認は通過する）、そのたびに
#    測定バッチの1本が失われた。相手が誰かは分からないが、**すぐ居なくなる**。
#    Yakulingo や ManualBuilder の本物の仕事なら数十分は居座るので、
#    「3分待って居なくなるなら気にしない、居座るなら中止」で両方を捌ける。
function Assert-ExclusiveCopilot {
    $others = @(Get-OtherCopilotDrivers)
    if ($others.Count -and -not $AllowSharedCopilot) {
        Write-Step ('  他の作業が同じ Copilot を使っています: ' + ($others -join ' / ') + '。3分だけ待ちます。')
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Seconds 15
            $others = @(Get-OtherCopilotDrivers)
            if (-not $others.Count) { Write-Step '  居なくなったので続けます。'; return }
        }
    }
    if (-not $others.Count) { return }
    $list = ($others -join ' / ')
    if ($AllowSharedCopilot) {
        Write-Step ('  ⚠ 他の作業が同じ Copilot を使っています: ' + $list)
        Write-Step '    -AllowSharedCopilot が指定されているので続けますが、この run は測定に使わないこと。'
        return
    }
    throw ("同じ Copilot を他の作業が使っています: " + $list + "。" +
        "取り合うと応答が中断され、落ちたパケットの範囲を見ないまま数字が下振れします。" +
        "終わるのを待ってから走らせてください。承知のうえで走らせるなら -AllowSharedCopilot を付けます。")
}

# ⚠️ Copilot が不調なときに測っても意味が無い。1本40分かけて未完になるだけである。
#
#    実測 2026-08-07: 午後から Copilot が不調になり、添付が80秒進まない・生成が180秒
#    止まる、が続発した。1時間あたりの生成停滞は 05〜14時が 0〜2件だったのに対し、
#    16時は16件。**それに気づかないまま3本走らせて3本とも未完**にした。
#    しかも原因が自分たちの側かどうか分からず、素材とコードを1時間以上疑った。
#
#    直前30分の実績で判断する。目安は Show-CopilotHealth.ps1 と同じ:
#      添付タイムアウトが1件でもある（成功は平均12秒で終わるので、失敗は明確な異常）
#      生成停滞が5件を超える（平常は1時間に1〜2件）
function Assert-CopilotHealthy {
    $logPath = Join-Path (Get-KoseiSubDir 'logs') 'pdf-kosei.log'
    if (!(Test-Path -LiteralPath $logPath)) { return }
    $since = (Get-Date).AddMinutes(-30)
    $attachNg = 0; $stall = 0; $nojson = 0; $okAnswer = 0
    try {
        foreach ($l in (Get-Content -LiteralPath $logPath -Tail 4000 -ErrorAction Stop)) {
            if ($l.Length -lt 19) { continue }
            $ts = $null
            try { $ts = [datetime]::ParseExact($l.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null) } catch { continue }
            if ($ts -lt $since) { continue }
            if ($l -match '添付完了待機タイムアウト') { $attachNg++ }
            if ($l -match '生成停滞を検出') { $stall++ }
            # ⚠️ 回答が取れない型を忘れていた。実測 2026-08-08: Copilot が
            #    「問題が発生しました」を返す日は、添付も停滞も正常なので
            #    このゲートが一度も発火せず、**全滅する run を何本も通してしまった**。
            if ($l -match 'incomplete-json|no-json-idle|copilot-refusal') { $nojson++ }
            # ⚠️ **件数ではなく比率で見る。** incomplete-json は取り直しの印であって
            #    失敗とは限らない。実測 2026-08-08: 10時は 取り直し38 / 成功14 で
            #    3本とも完走したが、06時は 取り直し115 / 成功0 で全滅だった。
            if ($l -match 'completedBy=(json-stable|marker)') { $okAnswer++ }
        }
    } catch { return }   # ログが読めないことを理由に測定を止めはしない
    # ⚠️ 停滞だけで止めてはいけない。実測 2026-08-08 08時: 停滞6件の時間帯でも
    #    探りの run は指摘28件を取れていた。停滞は**時間を食うだけ**で、
    #    run が落ちるかどうかとは別である。止めるのは
    #      添付タイムアウト（※16 の窓の問題）と、回答を取れない型（※18）の2つだけ。
    #    停滞は報告には残すが、判定には使わない。
    if ($attachNg -eq 0 -and ($okAnswer -gt 0 -or $nojson -le 5)) {
        if ($stall -gt 5) { Write-Step ("  注意: 直前30分の生成停滞が {0}件です。時間は余分に掛かりますが、run は通る見込みです。" -f $stall) }
        return
    }
    $msg = ("直前30分の Copilot が不調です（添付タイムアウト {0}件 / 生成停滞 {1}件 / 取り直し {2}件 / 成功 {3}件）。" -f $attachNg, $stall, $nojson, $okAnswer)
    if ($IgnoreCopilotHealth) {
        Write-Step ('  ⚠ ' + $msg + ' -IgnoreCopilotHealth が指定されているので続けます。')
        return
    }
    throw ($msg + "この状態で測っても未完になるだけです。" +
        "tools\Show-CopilotHealth.ps1 で様子を見て、落ち着いてから走らせてください。" +
        "承知のうえで走らせるなら -IgnoreCopilotHealth を付けます。")
}

# ⚠️ 走り出す前に「アプリが暇である」ことを確かめる。
#    Wait-Idle は running が true になったのを見て「自分の run が始まった」と判断する。
#    前の run が画面側でまだ動いていると、それを自分のものと取り違える。アプリは
#    PowerShell を殺しても自力でパケットを送り続けるので、これは実際に起きる。
#    実測 2026-08-07: 前の run を途中で止めた直後に走らせたら、ラウンド1が前の run 由来に
#    なり、取り込めたのはラウンド2だけの **15件**（通常60件超）だった。しかも exit=0 で
#    「成功」に見え、採点すれば普通の数字が出てしまう。**静かに壊れた測定**である。
function Assert-NotRunning {
    $s = $null
    try { $s = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' -TimeoutSeconds 20 | ConvertFrom-Json } catch { }
    if (-not $s) { return }          # 状態が取れないのは別の失敗として後段で出る
    if (-not $s.running) { return }
    throw ("アプリが既に実行中です（card=" + [string]$s.card + "）。前の run が画面側で続いています。" +
        "終わるのを待つか、アプリを再読み込みしてから走らせてください。" +
        "このまま走らせると前の run の結果が混ざり、しかも成功したように見えます。")
}

function Reset-App {
    # runごとに状態を戻す。findings は画面に溜まるので、前のrunが混ざらないようにする。
    #
    # ⚠️ Page.navigate で読み込み直してはいけない。beforeunload が /__page-closed を送り、
    #    サーバーが2秒後に停止する。実測では2本目の loadTarget が "Failed to fetch" で落ちた。
    #    比較資料を消すだけでよい（findings は loadTarget() が空にする）。
    $null = Invoke-App -Expression 'window.__koseiBenchmark.reset()'
}

# ⚠️ PowerShell 5.1 の ConvertFrom-Json は、**配列をパイプで1個のまま流す**。
#    `@(... | ConvertFrom-Json)` と書くと、4要素の配列が **要素数1** になる。
#    一度変数に受けてから `@()` で包めば4になる。
#
#    実測 2026-08-07: これでリトライ経路が**丸ごと壊れていた**。4本落ちても
#    「失敗 1件をリトライします」と出て、retry() には配列がそのまま渡り
#    「SEC_001_BROAD,SEC_001_TERMS,… のパケットが残っていません」で必ず失敗していた。
#    つまり中断からの回復は一度も効いていない。落ちたら落ちたままだった。
function Get-AppPackets {
    $raw = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.packets())' -TimeoutSeconds 30
    $parsed = $null
    try { $parsed = ConvertFrom-Json ([string]$raw) } catch { return @() }
    return @($parsed)
}

# 失敗したパケットを取り直す。1セクション落ちたまま進むと、その範囲の誤りが
# 「検出できなかった」のか「そもそも見ていない」のか区別できなくなる。
function Invoke-RetryFailedPackets {
    param([int]$MaxRounds = 2)
    for ($round = 1; $round -le $MaxRounds; $round++) {
        $packets = Get-AppPackets
        $failed = @($packets | Where-Object { $_.status -eq 'error' })
        if (-not $failed.Count) { return }
        Write-Step ("  失敗 " + $failed.Count + "件をリトライします（" + $round + "回目）: " + (($failed | ForEach-Object { $_.packet_id }) -join ', '))
        foreach ($f in $failed) {
            $ok = Invoke-App -Expression ("window.__koseiBenchmark.retry(" + (ConvertTo-Json $f.packet_id) + ")")
            if (-not $ok) { Write-Step ("  " + $f.packet_id + " はリトライできません: " + (Invoke-App -Expression 'window.__koseiBenchmark.status().last_error')); continue }
            Wait-Idle -Label ("リトライ " + $f.packet_id)
        }
    }
    $packets = Get-AppPackets
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
Assert-CopilotHealthy
Assert-NotRunning
Assert-ExclusiveCopilot

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

    # ⚠️ 完走しなかった run を、完走した run と同じ名前で置いてはいけない。
    #    Copilot 側が応答を中断すると（他の作業と同時に叩いているとき等）パケットが
    #    落ちたまま終わる。そのまま保存すると、採点では**性能が落ちた**ようにしか見えない。
    #    実測 2026-08-07: 別のアプリが同じ Copilot を使っている最中に走らせたら4本とも
    #    中断され、指摘0件の run が普通の名前で保存された。
    #    → 完了していないパケットが1つでもあれば名前に _INCOMPLETE を付ける。
    #    ⚠️ ここで `@(... | ConvertFrom-Json)` と書くと配列が1個のままになり、
    #       **完走した run まで _INCOMPLETE になる**（上の Get-AppPackets の注記を参照）。
    $incomplete = @()
    try {
        # アプリ側が「取り込み済み」と扱うのは done と warning（index.html の donePackets と同じ判定）
        $incomplete = @(Get-AppPackets | Where-Object { @('done', 'warning') -notcontains [string]$_.status })
    } catch { }

    # ⚠️ 同じ日に同じ構成をもう一度走らせると、以前は**黙って上書き**していた。
    #    実測で、長尺フィクスチャの測定結果を、別のフィクスチャで回したスモークが潰した。
    #    測定結果は文書から名指しで参照されるので、消えると裏が取れなくなる。
    #    既にあるときは時刻を足して別ファイルにする。
    $suffix = if ($incomplete.Count) { '_INCOMPLETE' } else { '' }
    $dest = Join-Path $outDir ("{0}_{1}{2}.json" -f $stamp, $cfg.name, $suffix)
    if (Test-Path -LiteralPath $dest -PathType Leaf) {
        $dest = Join-Path $outDir ("{0}-{1}_{2}{3}.json" -f $stamp, (Get-Date -Format 'HHmm'), $cfg.name, $suffix)
        Write-Step ("  同名の結果があるので別名で保存します: " + [System.IO.Path]::GetFileName($dest))
    }
    [System.IO.File]::WriteAllText($dest, $json, $utf8)
    # .count はPSの組み込みメンバと紛らわしいので findings 配列の長さを数える
    $count = @(($json | ConvertFrom-Json).findings).Count
    Write-Step ("  保存: " + $dest + "（指摘 " + $count + "件）")
    if ($incomplete.Count) {
        Write-Step ("  ⚠ 完走していません。落ちたパケット: " +
            (($incomplete | ForEach-Object { [string]$_.packet_id + '(' + [string]$_.status + ')' }) -join ', '))
        Write-Step '    この run は採点に使わないこと。落ちた範囲は「検出できなかった」ではなく「見ていない」です。'
        # 落ちた理由の第一候補はCopilotの取り合い。走り出した後に始まったものは事前検査では拾えない。
        $late = @(Get-OtherCopilotDrivers)
        if ($late.Count) {
            Write-Step ('    途中から他の作業が同じ Copilot を使っています: ' + ($late -join ' / '))
            Write-Step '    これが原因である可能性が高いです。終わってから取り直してください。'
        } else {
            Write-Step '    Copilot の応答が中断されるときは、他の作業が同じ Copilot を使っていないか確かめてください。'
        }
    }
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
