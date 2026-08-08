<#
  Show-CopilotHealth.ps1 — Copilot が今まともに動いているかを、ログから数える。

      powershell -ExecutionPolicy Bypass -File tools\Show-CopilotHealth.ps1
      powershell -ExecutionPolicy Bypass -File tools\Show-CopilotHealth.ps1 -Hours 6
      powershell -ExecutionPolicy Bypass -File tools\Show-CopilotHealth.ps1 -Days 3

  なぜ要るか（実測 2026-08-07）:
    午後から測定が壊れ始めた。添付が80秒進まない・生成が180秒止まる、が続発し、
    1本40分の測定が3本続けて未完になった。そのとき **原因が自分たちの側にあるのか
    Copilot 側なのかを判断する材料が無かった**ので、素材やコードを1時間以上疑った。

    ログには材料が全部あった。数えれば一目で分かる:

      生成停滞（1時間あたり）   08-05 と 08-06 は終日 1〜2件
                                08-07 は 05〜13時 1〜2件 → 15時 4件 → 16時 16件
      添付タイムアウト           08-05 は2件（終日）
                                08-07 は 15時以降に9件（それ以前は0件）

    「前の日と比べて桁が違う」ことが分かれば、コードを疑う時間を使わずに済む。

  読み方:
    - 添付は成功時 平均12秒・最大23秒で終わる。失敗は80秒まったく進まない二極化。
      つまり「失敗が1件でもある時間帯」は不調とみてよい。
    - 生成停滞は平常でも1時間に1〜2件ある。**5件を超えたら不調**の目安。
#>
[CmdletBinding()]
param(
    [int]$Hours = 0,       # 直近N時間だけを見る（0なら日別に全部）
    [int]$Days = 3         # 日別表示のときに遡る日数
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path (Join-Path $root 'src') 'Paths.ps1')
Set-KoseiRoot -Root $root

$logPath = Join-Path (Get-KoseiSubDir 'logs') 'pdf-kosei.log'
if (!(Test-Path -LiteralPath $logPath)) { Write-Host "ログがありません: $logPath"; exit 1 }

$lines = Get-Content -LiteralPath $logPath -ErrorAction Stop

# 集計の単位を決める。時間指定なら「日 時」、それ以外は日別。
$now = Get-Date
$since = if ($Hours -gt 0) { $now.AddHours(-$Hours) } else { $now.Date.AddDays(-($Days - 1)) }

$stat = [ordered]@{}
function Add-Stat { param([string]$key, [string]$kind, [string]$hourKey)
    if (-not $stat.Contains($key)) { $stat[$key] = [ordered]@{ attachOk = 0; attachNg = 0; stall = 0; refusal = 0; nojson = 0; okAnswer = 0; hours = (New-Object 'System.Collections.Generic.HashSet[string]') } }
    $stat[$key][$kind]++
    if ($hourKey) { $null = $stat[$key].hours.Add($hourKey) }
}

foreach ($l in $lines) {
    if ($l.Length -lt 19) { continue }
    $ts = $null
    try { $ts = [datetime]::ParseExact($l.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null) } catch { continue }
    if ($ts -lt $since) { continue }
    $key = if ($Hours -gt 0) { $ts.ToString('MM-dd HH') + '時' } else { $ts.ToString('yyyy-MM-dd') }

    $hk = $ts.ToString('yyyy-MM-dd HH')
    if ($l -match '添付完了 ') { Add-Stat $key 'attachOk' $hk }
    elseif ($l -match '添付完了待機タイムアウト') { Add-Stat $key 'attachNg' $hk }
    if ($l -match '生成停滞を検出') { Add-Stat $key 'stall' $hk }
    # 拒否はログ上 'Copilot拒否応答を検出 completedBy=copilot-refusal' として残る。
    # 画面の文言（問題が発生しました）はログには出ないので、**completedBy で拾う**。
    if ($l -match 'copilot-refusal|応答中断|問題が発生しました') { Add-Stat $key 'refusal' $hk }
    # 回答を取れずに終わったパケット。拒否と別に数えると、不調の形が見える。
    # 回答を取れずに終わったパケット。
    # ⚠️ incomplete-json を忘れないこと。画面に「問題が発生しました」が出たときの
    #    ログ上の姿はこれである（candidates=0 ＝ JSON が1つも無い）。
    #    実測: 08-05 は 0件、08-06 は 4件、08-07 は 255件、08-08 は 66件。
    if ($l -match 'no-json-idle|incomplete-json') { Add-Stat $key 'nojson' $hk }
    # ⚠️ **件数ではなく比率で見る。** incomplete-json は「取り直した」印であって
    #    失敗とは限らない。実測 2026-08-08:
    #      06時 成功0 / incomplete 115 → **全滅**
    #      09時 成功16 / incomplete 22 → 3本とも完走
    #      10時 成功14 / incomplete 38 → 同上
    #    件数だけで判定すると、通っている時間帯を不調と呼ぶ。
    if ($l -match 'completedBy=(json-stable|marker)') { Add-Stat $key 'okAnswer' $hk }
}

if (-not $stat.Count) { Write-Host '対象期間にログがありません。'; exit 0 }

Write-Host ''
Write-Host ('{0,-12} {1,7} {2,7} {3,7} {4,9} {5,8}   {6}' -f '期間', '添付OK', '添付NG', '停滞', '停滞/時', '取直し', '判定')
Write-Host ('-' * 78)
$bad = 0
foreach ($k in $stat.Keys) {
    $s = $stat[$k]
    # ⚠️ 日でまとめるときに件数で判定してはいけない。稼働が長い日ほど不調に見える。
    #    **1稼働時間あたりの停滞数**で見る（平常は 1〜2 件/時）。
    $h = [Math]::Max(1, $s.hours.Count)
    $rate = [Math]::Round($s.stall / $h, 1)
    # 回答が1件も取れていないのに取り直しが多いなら不調。
    $answerDead = ($s.okAnswer -eq 0 -and ($s.refusal + $s.nojson) -gt 2)
    $verdict = if ($s.attachNg -gt 0 -or $rate -gt 5 -or $answerDead) { $bad++; '不調' }
               elseif ($rate -gt 2.5) { 'やや不安定' }
               else { 'ふつう' }
    Write-Host ('{0,-12} {1,7} {2,7} {3,7} {4,9} {5,8}   {6}' -f $k, $s.attachOk, $s.attachNg, $s.stall, $rate, ("{0}/{1}" -f ($s.refusal + $s.nojson), $s.okAnswer), $verdict)
}

Write-Host ''
if ($bad) {
    Write-Host '不調の期間があります。測定するなら落ち着いてからにしてください。'
    Write-Host '  添付NGが1件でもあれば不調です（成功時は平均12秒・最大23秒で終わり、失敗は80秒まったく進みません）。'
    Write-Host '  生成停滞は平常でも1時間に1〜2件あります。**1稼働時間あたり5件**を超えたら不調の目安です。'
} else {
    Write-Host 'この期間は落ち着いています。'
}
