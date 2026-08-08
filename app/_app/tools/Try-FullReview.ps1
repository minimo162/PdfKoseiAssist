<#
  Try-FullReview.ps1 — 利用者が押す「校正を開始」の道を、そのまま1本流して見る。

  なぜ要るか（2026-08-08）:
    ボタンを1つにまとめた。中では2つ続けて走らせるので、**継ぎ目で落ちていないか**は
    走らせないと分からない。この日だけで、走らせて初めて分かった不具合が3つあった。

    Run-Benchmark.ps1 は素材の採点用で、片方ずつしか回さない。
    こちらは「利用者と同じ道が通るか」だけを見る。採点はしない。

  使い方（既定は20ページ。継ぎ目の確認が目的なので短くてよい）:
    powershell -ExecutionPolicy Bypass -File tools\Try-FullReview.ps1
    powershell -ExecutionPolicy Bypass -File tools\Try-FullReview.ps1 -Pages '1-40'
#>
param(
    [string]$Pages = '1-20',
    [string]$TargetPath = '/docs/benchmarks/fixtures/aoi-long_en_TARGET.pdf',
    [string]$ReferencePath = '/docs/benchmarks/fixtures/aoi-long_ja_REF.pdf',
    [int]$TimeoutMinutes = 40
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\CopilotClient.ps1')

function Write-Step { param([string]$m) Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

$appUrl = (Get-Content (Join-Path $root 'local-app.url') -Raw).Trim()
$page = $null
foreach ($try in 1..15) {
    try {
        $tabs = Invoke-RestMethod 'http://127.0.0.1:9444/json/list'
        $page = $tabs | Where-Object { $_.type -eq 'page' -and $_.url -like ($appUrl.TrimEnd('/') + '*') } | Select-Object -First 1
    } catch { }
    if ($page) { break }
    Start-Sleep -Seconds 2
}
if (-not $page) { throw "アプリのタブが見つかりません: $appUrl（30秒待ちました）" }
$ws = [string]$page.webSocketDebuggerUrl
function App { param([string]$Expression, [int]$TimeoutSeconds = 30)
    Invoke-KoseiCdpEval -WebSocketUrl $ws -Expression $Expression -TimeoutSeconds $TimeoutSeconds
}

# 画面が古いコードで動いていないか。Run-Benchmark と同じ理由の確認。
$loadedAt = [datetime](App -Expression 'window.__koseiBenchmark.loadedAt')
$newest = Get-ChildItem (Join-Path $root 'index.html')
if ($newest.LastWriteTimeUtc -gt $loadedAt.ToUniversalTime()) {
    throw ("画面が古いコードで動いています。index.html は " + $newest.LastWriteTime.ToString('HH:mm:ss') +
           " に更新、画面の読み込みは " + $loadedAt.ToLocalTime().ToString('HH:mm:ss') + " です。読み込み直してください。")
}
foreach ($hook in @('startFull', 'setPageRange')) {
    if (-not [bool](App -Expression ("typeof window.__koseiBenchmark." + $hook + " === 'function'"))) {
        throw ($hook + ' フックがありません。index.html が古い可能性があります。')
    }
}

Write-Step '前の実行の残りを片づけます'
$null = App -Expression 'window.__koseiBenchmark.reset()'

Write-Step '素材を読み込みます'
# ⚠️ Runtime.evaluate に裸の await は書けない（SyntaxError になる）。.then(...) で返す。
$null = App -Expression ("window.__koseiBenchmark.loadTarget(" + (ConvertTo-Json $TargetPath) + ").then(r => JSON.stringify(r))") -TimeoutSeconds 180
$null = App -Expression ("window.__koseiBenchmark.loadReference(" + (ConvertTo-Json $ReferencePath) + ").then(r => JSON.stringify(r))") -TimeoutSeconds 180
$null = App -Expression ("JSON.stringify(window.__koseiBenchmark.setPageRange(" + (ConvertTo-Json $Pages) + "))")
$st = App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
Write-Step ("対象 {0}ページ / 比較資料 {1}ページ" -f $st.target_pages, $st.reference_total_pages)

Write-Step '「校正を開始」と同じ道で始めます'
$null = App -Expression 'window.__koseiBenchmark.startFull()'

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastStage = ''
$lastCard = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $st = App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
    if ([string]$st.stage -and [string]$st.stage -ne $lastStage) {
        $lastStage = [string]$st.stage
        Write-Step ("段階: " + $lastStage)
    }
    $card = ([string]$st.card -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim()
    if ($card -and $card -ne $lastCard) { $lastCard = $card; Write-Step ("  " + $card.Substring(0, [Math]::Min(160, $card.Length))) }
    if (-not $st.running) { break }
}

$st = App -Expression 'JSON.stringify(window.__koseiBenchmark.status())' | ConvertFrom-Json
$err = [string](App -Expression 'String(window.__koseiBenchmark.lastError || "")')
if (-not $err) { $err = [string]$st.last_error }
if ($err) { Write-Step ('画面のヘルプ: ' + [string](App -Expression 'String(document.getElementById("pageRangeHelp")?.textContent || "").slice(0, 240)')) }
Write-Step '----'
Write-Step ("まだ実行中: " + $st.running)
Write-Step ("指摘: " + $st.findings + "件")
# 1つのボタンで2段階を走らせるので、同じ箇所を二重に報告していないかを見る。
Write-Step ("まとめた重複: " + [int]$st.dropped_duplicates + "件")
if ($err) { Write-Step ("エラー: " + $err) }
if ($st.running) { Write-Step '⚠ 時間内に終わりませんでした'; exit 1 }
if ($err) { exit 1 }
if ([int]$st.findings -le 0) { Write-Step '⚠ 指摘が0件です。継ぎ目で落ちていないか確かめてください'; exit 1 }
Write-Step '通しで動きました'
