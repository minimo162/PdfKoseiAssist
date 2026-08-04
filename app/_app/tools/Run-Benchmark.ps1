# Run-Benchmark.ps1 — 幅の実験を無人で走らせる。
#
#   powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1
#   powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1 -Config consistency25
#   powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1 -CheckOnly
#
# 4通りの構成（整合性 幅25 / 幅60、校正 幅10 / 幅25）を順に実行し、
# 各runの結果を docs\benchmarks\runs\raw\ に保存する。合計で 56 ターン、
# 1ターン30〜60秒なので 40〜60分かかる。その間クリック操作は要らない。
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
    [ValidateSet('all', 'consistency25', 'consistency60', 'proofread10', 'proofread25')]
    [string]$Config = 'all',
    [string]$TargetPath = '/docs/benchmarks/fixtures/aoi-long_en_TARGET.pdf',
    [string]$ReferencePath = '/docs/benchmarks/fixtures/aoi-long_ja_REF.pdf',
    [int]$TimeoutMinutes = 120,
    [switch]$CheckOnly
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
    $null = Invoke-KoseiCdpMethod -WebSocketUrl $browserWs -Method 'Target.createTarget' -Params @{ url = $appUrl } -TimeoutSeconds 20
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $pageWs = Get-AppPageWs -Url $appUrl -Port $port
        if (-not [string]::IsNullOrWhiteSpace($pageWs)) { break }
    }
}
if ([string]::IsNullOrWhiteSpace($pageWs)) { throw 'アプリのタブをCDPで見つけられませんでした。' }

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

function Reset-Page {
    # runごとに読み込み直す。findings は画面に溜まるので、前のrunが混ざらないようにする。
    $null = Invoke-KoseiCdpMethod -WebSocketUrl $pageWs -Method 'Page.navigate' -Params @{ url = $appUrl } -TimeoutSeconds 30
    Start-Sleep -Seconds 3
    Wait-Hook
}

# --- 構成 ---------------------------------------------------------------
$configs = @(
    @{ name = 'consistency25'; kind = 'consistency'; width = 25; overlap = 3; note = '整合性 幅25・重ね3' },
    @{ name = 'consistency60'; kind = 'consistency'; width = 60; overlap = 3; note = '整合性 幅60・重ね3' },
    @{ name = 'proofread10';   kind = 'proofread';   width = 10; overlap = 0; note = '校正 幅10' },
    @{ name = 'proofread25';   kind = 'proofread';   width = 25; overlap = 0; note = '校正 幅25' }
)
if ($Config -ne 'all') { $configs = @($configs | Where-Object { $_.name -eq $Config }) }

$outDir = Join-Path $Root 'docs\benchmarks\runs\raw'
$null = New-Item -ItemType Directory -Force -Path $outDir
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stamp = Get-Date -Format 'yyyy-MM-dd'

Wait-Hook

foreach ($cfg in $configs) {
    Write-Step ("=== " + $cfg.note + " ===")
    Reset-Page

    $t = Invoke-App -Expression ("window.__koseiBenchmark.loadTarget(" + (ConvertTo-Json $TargetPath) + ").then(r => JSON.stringify(r))") -TimeoutSeconds 180
    Write-Step ("  校正対象を読み込み: " + $t)
    $r = Invoke-App -Expression ("window.__koseiBenchmark.loadReference(" + (ConvertTo-Json $ReferencePath) + ").then(r => JSON.stringify(r))") -TimeoutSeconds 180
    Write-Step ("  比較資料を読み込み: " + $r)
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
        $null = Invoke-App -Expression ("window.__koseiBenchmark.startConsistency({ sectionWidth: " + $cfg.width + ", overlap: " + $cfg.overlap + " })")
    } else {
        $null = Invoke-App -Expression 'window.__koseiBenchmark.startProofread()'
    }

    # 開始できたことを先に確かめる（PDF未読込などで即座に戻ると running が立たない）
    $started = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $st = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
        if ($st.running) { $started = $true; break }
        if ($st.last_error) { throw ("開始できませんでした: " + $st.last_error) }
    }
    if (-not $started) { throw '開始を確認できませんでした。画面の状態を確認してください。' }

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $lastCard = ''
    while ($true) {
        Start-Sleep -Seconds 10
        $st = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
        if ([string]$st.card -ne $lastCard) { $lastCard = [string]$st.card; Write-Step ("  " + $lastCard) }
        if (-not $st.running) { break }
        if ((Get-Date) -gt $deadline) { throw ("時間切れ（" + $TimeoutMinutes + "分）。画面の状態を確認してください。") }
    }
    if ($st.last_error) { Write-Step ("  警告: " + $st.last_error) }

    $json = Invoke-App -Expression 'JSON.stringify(window.__koseiBenchmark.report())' -TimeoutSeconds 120
    $dest = Join-Path $outDir ("{0}_{1}.json" -f $stamp, $cfg.name)
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
Write-Host 'Node が無い場合は docs/benchmarks/runs/raw/ の JSON をそのまま渡してください。'
