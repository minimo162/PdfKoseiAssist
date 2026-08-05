# Measure-Concurrency.ps1 — Copilot を並列に叩けるかを実測する（引き継ぎ書 §6.1）。
#
#   powershell -ExecutionPolicy Bypass -File tools\Measure-Concurrency.ps1
#   powershell -ExecutionPolicy Bypass -File tools\Measure-Concurrency.ps1 -Workers 2 -Packets 4
#   powershell -ExecutionPolicy Bypass -File tools\Measure-Concurrency.ps1 -Workers 1 -Packets 4   # 逐次の対照
#
# 何を答える計測か:
#   同一ユーザーが複数のチャットへ同時に投げたとき、テナント側で直列化されるのか、
#   429 が返るのか、素直に並列で走るのか。**ここが塞がっていたら RunspacePool 化は無意味**
#   なので、実装より先にこれを測る。
#
# 仕組み:
#   ワーカーごとに Target.createTarget(newWindow=$true) で **別ウィンドウ**の Copilot を作り、
#   製品と同じ Invoke-KoseiPacket を -Page 付きで呼ぶ。UI を模した別経路は作らない
#   （作ると測ったものが製品とずれる）。
#
# ⚠️ 同じウィンドウに複数タブを並べてはいけない。裏のタブは visibilityState=hidden になり、
#    実寸が0・innerText が空になって「画面には見えているのに1文字も取れない」に陥る（実測）。
#
# 前提:
#   - パケットの素材（PROMPT_*.txt / TEXT_*.txt）が uploads の下にあること。
#     直近の自動校正を1回流せば作られる。-JobDir で明示もできる。
#   - Copilot にサインイン済みであること。

param(
    [int]$Workers = 2,
    [int]$Packets = 4,
    # 省略時は uploads の最新ジョブ
    [string]$JobDir = '',
    [int]$TimeoutMinutes = 40
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
Set-KoseiRoot -Root $Root
. (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
. (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')
. (Join-Path (Join-Path $Root 'src') 'ReviewJob.ps1')

function Write-Step { param([string]$Text) Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Text) }

$settings = Get-KoseiSettings
$settingsError = Get-KoseiSettingsError
if ($settingsError) { throw ("settings.json を読めていません: " + $settingsError) }
$port = [int]$settings.cdp_port

# --- 素材を集める -------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($JobDir)) {
    $uploads = Get-KoseiSubDir 'uploads'
    $latest = @(Get-ChildItem -LiteralPath $uploads -Directory -Filter 'job-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if (-not $latest.Count) { throw "uploads にジョブがありません。先に自動校正を1回流してください: $uploads" }
    $JobDir = $latest[0].FullName
}
Write-Step ("素材: " + $JobDir)

$prompts = @(Get-ChildItem -LiteralPath $JobDir -Filter 'PROMPT_*.txt' -File | Sort-Object Name)
if (-not $prompts.Count) { throw "PROMPT_*.txt がありません: $JobDir" }
$use = @($prompts | Select-Object -First $Packets)
Write-Step ("パケット: " + $use.Count + "件 / ワーカー: " + $Workers)

# 製品と同じ形のパケット状態を組む（Start-KoseiReviewJob と同じフィールド）。
$perPacket = New-Object System.Collections.ArrayList
foreach ($f in $use) {
    $id = [System.IO.Path]::GetFileNameWithoutExtension($f.Name) -replace '^PROMPT_', ''
    $textPath = ''
    $candidate = Join-Path $JobDir ('TEXT_' + $id + '.txt')
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $textPath = $candidate }
    # 元のページ範囲は名前からは読めないので、ここでは追撃passの対象範囲としてのみ使う。
    $null = $perPacket.Add([hashtable]::Synchronized(@{
        packet_id = $id; prompt_path = $f.FullName; pdf_path = ''; text_path = $textPath
        target_pages = @(); kind = 'proofread'; has_ref = $true; profile = ''
        status = 'queued'; phase = ''; error = ''; raw_answer = ''; completed_by = ''; detail = ''
        elapsed_ms = 0; total_elapsed_ms = 0; response_wait_ms = 0; phase_timings = $null
        started_at = ''; completed_at = ''; findings_count = 0; pages_checked = @(); coverage = 0.0
        warning = ''; passes = @()
        worker = -1
    }))
}

$state = [hashtable]::Synchronized(@{
    id = ('probe' + (Get-Date -Format 'HHmmss')); mode = 'running'; phase = ''
    attach_mode = 'masked-text'; packets_total = $perPacket.Count; packets_done = 0
    current_packet = ''; error = ''; cancel_requested = $false; updated_at = ''
    per_packet = $perPacket
})

# --- ワーカーごとに別ウィンドウの Copilot を用意する --------------------
# ⚠️ 製品（ReviewJob.ps1 の並列実行）と**同じ関数**を使う。ここで別実装を書くと、
#    測っているウィンドウの作り方が製品とずれる。可視性(§6.2)のログもこの中で出る。
$pages = New-KoseiCopilotWorkerPages -Settings $settings -Count $Workers
for ($w = 0; $w -lt @($pages).Count; $w++) {
    Write-Step ("worker$w のページ: " + [string]$pages[$w].id)
}

# --- 実行 ---------------------------------------------------------------
$reviewFlags = Get-KoseiValidatedReviewFlags -Settings $settings
$answersDir = Join-Path (Get-KoseiSubDir 'runtime') 'answers'
$null = New-Item -ItemType Directory -Force -Path $answersDir

# ワーカーへパケットを配る（round-robin）。各ワーカーは自分の分だけを触る。
$assign = @{}
for ($i = 0; $i -lt $perPacket.Count; $i++) {
    $w = $i % $Workers
    if (-not $assign.ContainsKey($w)) { $assign[$w] = New-Object System.Collections.ArrayList }
    $null = $assign[$w].Add($i)
    $perPacket[$i].worker = $w
}

$worker = {
    param($Root, $State, $Settings, $ReviewFlags, $AnswersDir, $Page, $Indices, $WorkerIndex, $Log)
    . (Join-Path (Join-Path $Root 'src') 'Paths.ps1')
    Set-KoseiRoot -Root $Root
    Set-KoseiWorkerIndex -Index $WorkerIndex
    . (Join-Path (Join-Path $Root 'src') 'Settings.ps1')
    . (Join-Path (Join-Path $Root 'src') 'CopilotClient.ps1')
    . (Join-Path (Join-Path $Root 'src') 'ReviewJob.ps1')
    foreach ($i in @($Indices)) {
        $p = $State.per_packet[$i]
        $p.status = 'running'
        $p.started_at = (Get-Date).ToString('s')
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $null = Invoke-KoseiPacket -Packet $p -State $State -Settings $Settings -ReviewFlags $ReviewFlags -AnswersDir $AnswersDir -PacketIndex $i -Page $Page
        } catch {
            $p.status = 'error'; $p.error = $_.Exception.Message
        }
        $sw.Stop()
        $null = $Log.Add([pscustomobject]@{
            worker = $WorkerIndex; packet = [string]$p.packet_id; status = [string]$p.status
            wall_ms = [int]$sw.ElapsedMilliseconds; completed_by = [string]$p.completed_by
            findings = [int]$p.findings_count; error = [string]$p.error
        })
    }
}

$log = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
$handles = @()
$overall = [System.Diagnostics.Stopwatch]::StartNew()
Write-Step ("開始: " + $Workers + "ワーカー × " + $perPacket.Count + "パケット")
foreach ($w in 0..($Workers - 1)) {
    if (-not $assign.ContainsKey($w)) { continue }
    $ps = [powershell]::Create()
    $null = $ps.AddScript($worker).
        AddArgument($Root).AddArgument($state).AddArgument($settings).AddArgument($reviewFlags).
        AddArgument($answersDir).AddArgument($pages[$w]).AddArgument(@($assign[$w])).AddArgument($w).AddArgument($log)
    $handles += @{ PowerShell = $ps; Async = $ps.BeginInvoke(); Worker = $w }
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ($handles | Where-Object { -not $_.Async.IsCompleted }) {
    Start-Sleep -Seconds 10
    $done = @($log).Count
    Write-Step ("  進捗 " + $done + "/" + $perPacket.Count + " 完了 / 経過 " + [int]$overall.Elapsed.TotalSeconds + "秒")
    if ((Get-Date) -gt $deadline) { Write-Step '時間切れ。打ち切ります。'; break }
}
foreach ($h in $handles) { try { $null = $h.PowerShell.EndInvoke($h.Async) } catch { Write-Step ("worker" + $h.Worker + " が例外で終了: " + $_.Exception.Message) }; $h.PowerShell.Dispose() }
$overall.Stop()

# --- 結果 ---------------------------------------------------------------
Write-Host ''
Write-Step ("=== 結果: " + $Workers + "ワーカー ===")
foreach ($r in @($log) | Sort-Object worker, packet) {
    Write-Host ("  worker{0} {1,-34} {2,-8} {3,6:N1}秒 completedBy={4} findings={5} {6}" -f `
        $r.worker, $r.packet, $r.status, ($r.wall_ms / 1000), $r.completed_by, $r.findings, $r.error)
}
$wall = $overall.Elapsed.TotalSeconds
$sum = (@($log) | Measure-Object -Property wall_ms -Sum).Sum / 1000.0
$okCount = @(@($log) | Where-Object { $_.status -eq 'done' -or $_.status -eq 'warning' }).Count
Write-Host ''
Write-Host ("  実時間        : {0:N1}秒" -f $wall)
Write-Host ("  各パケットの和: {0:N1}秒" -f $sum)
Write-Host ("  重なり倍率    : {0:N2}x （1.0 なら直列化されている＝並列化しても縮まない）" -f $(if ($wall -gt 0) { $sum / $wall } else { 0 }))
Write-Host ("  成功          : {0}/{1}" -f $okCount, $perPacket.Count)

# 同時実行制限は「エラー」ではなく画面の文言で来ることがある。取りこぼさないよう出す。
$suspect = @(@($log) | Where-Object { $_.status -ne 'done' -and $_.status -ne 'warning' })
if ($suspect.Count) {
    Write-Host ''
    Write-Step '⚠️ 失敗したパケットがあります。テナント側の同時実行制限かもしれません。'
    Write-Step '   Copilot画面に「少し時間をおいてから」「リクエストが多すぎます」が出ていないか確認してください。'
    foreach ($s in $suspect) { Write-Host ("   worker{0} {1}: {2} / {3}" -f $s.worker, $s.packet, $s.status, $s.error) }
}
Write-Host ''
Write-Step '判定のしかた: 重なり倍率がワーカー数に近ければ並列は有効。1.0 に近ければテナント側で直列化されている。'
