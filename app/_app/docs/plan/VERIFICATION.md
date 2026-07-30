# 実機検証ランブック（B案）

本ブランチの基盤を、**まずオフラインで決定的に**、次に**ライブ Copilot + CDP** で検証する手順。
緑化してから統合層（ReviewJob 多パスループ／index.html 取り込み）を実機で配線する。

前提: Windows + Edge + Microsoft 365 Copilot（サインイン済）、Windows PowerShell 5.1、Node.js。
実行は `app/_app/` 直下。

---

## ステップ1: オフライン検証（CDP不要・決定的）

```powershell
# 1-a. PowerShell 構文チェック（全 .ps1 パースエラー0 / SkipFreshChatWait 再導入0）  … K35, K15
powershell -ExecutionPolicy Bypass -File tools\Syntax-Check.ps1

# 1-b. PowerShell 純関数ユニットテスト（tail_hash・marker境界・pass schedule・
#      marker書式・flag allowlist・CSV検証）。node spec と SHA-256 まで相互一致。
powershell -ExecutionPolicy Bypass -File tools\Test-ReviewPrimitives.ps1
```

```bash
# 1-c. node ロジックテスト（現物フィルタ等価性・page_checks・finding統合・
#      turn完了検知・pass schedule・既存 ws-only）           … K4, K13, K14, K36
node tools/Test-WsOnlyFinding.mjs
node tools/Test-DeterministicFilters.mjs
node tools/Test-PageChecks.mjs
node tools/Test-ReviewMerge.mjs
node tools/Test-TurnComplete.mjs
node tools/Test-PassSchedule.mjs

# 1-d. benchmark スコアラの疎通
node docs/benchmarks/score.mjs docs/benchmarks/example/gold.json docs/benchmarks/example/run.json
```

**合格条件**: すべて PASS / exit 0。`Test-ReviewPrimitives.ps1` は PS 実装が node spec（埋め込み SHA-256 含む）と一致することを示す。ここが緑なら、未検証だった PS プリミティブが決定的に検証済みへ変わる。

---

## ステップ2: 既定挙動の不変確認（回帰）… K34

`config/settings.json` は既定（`review_engine=legacy` / `review_prompt_version=v94`）のまま:

1. アプリを起動し、代表パケットを1件、通常どおり校正実行する。
2. 期待: v94 と**同一の挙動・所要時間**。`ChatMode='New'` は現行と同一経路（FreshChat→model→attach→送信→待機）。`SkipFreshChatWait` は元々 dead だったため差分なし。
3. `runtime/` のログに従来どおり `completedBy` / findings が出ること。

---

## ステップ3: ライブ CDP プリミティブ確認（統合前の単体確認）

`app/_app/` で対話的 PowerShell を開き、src を dot-source して手動確認する。

```powershell
. .\src\Paths.ps1; . .\src\Settings.ps1; . .\src\CopilotClient.ps1; . .\src\ReviewJob.ps1
$s = Get-KoseiSettings
Start-KoseiCopilotEdge -Settings $s
$ws = (Get-KoseiCopilotPage -Settings $s).webSocketDebuggerUrl
```

- **3-a. 新規チャットの送信前スナップショット** … §7.4 / K5
  ```powershell
  Invoke-KoseiFreshChat -WsUrl $ws -Settings $s | Out-Null
  Get-KoseiAssistantSnapshot -WsUrl $ws   # 期待: state='empty'（送信前 0 件は正常）
  ```
- **3-b. 応答後のスナップショットと tail_hash** … §7.3
  手動で1メッセージ送信 →
  ```powershell
  $snap = Get-KoseiAssistantSnapshot -WsUrl $ws
  $snap.state          # 期待: 'ready'
  $snap.matches | Format-Table selector_index,element_count,tail_hash
  # 期待: いずれかの selector で element_count>=1, latest_text 非空, tail_hash がPS側で算出される
  ```
- **3-c. marker 境界** … §7.3
  応答末尾に一意 marker を出させ、`Test-KoseiTurnMarkerBoundary -Text $snap.matches[k].latest_text -Marker $mk` が `$true`、JSON 内部だけに現れる場合 `$false` を確認。
- **3-d. selector 健全性**: DOM 変更耐性。`Get-KoseiAssistantSnapshot` が `cdp-error` を返さないこと（返す場合は Edge/target を再取得）。

**合格条件**: `empty→ready` 遷移、tail_hash 算出、marker 境界判定が仕様どおり。ここが崩れる場合は `Get-KoseiLatestResponseText` の selector 一覧（§1.2）を実DOMに合わせて更新する。

---

## ステップ4: pass-stats エンドポイント … §7.1 / §13.2

アプリ起動中に:
```powershell
$body = '{"job_id":"j1","packet_id":"P1","pass_id":"0","lens":"numbers","status":"done","findings_new":3,"findings_exact_dup":1,"finding_groups":2,"pages_checked":10,"coverage":1.0,"elapsed_ms":1234}'
Invoke-RestMethod -Uri 'http://127.0.0.1:8098/api/review/pass-stats' -Method Post -Body $body -ContentType 'application/json'
```
- 期待: `runtime/pass-stats.csv` にヘッダ＋1行が追記される（localhost限定・allowlist・CSVエスケープ）。
- 不正 `lens`/`status` は 400 で拒否されること。

---

## ステップ5: 緑化後に着手する統合層（本セッション未実装）

ステップ1〜4 が緑になってから、tested JS 核を写して実機で配線する。

1. **ReviewJob 多パスループ** … §7〜§9
   `Get-KoseiValidatedReviewFlags` が `multipass` のとき、`Get-KoseiPassSchedule` を回す。
   1pass目 `ChatMode='New'`+添付、2pass目以降 `ChatMode='Reuse'`+`New-KoseiLensFollowupPrompt`+
   `New-KoseiTurnMarker`（turnごと一意）。各 pass の raw を `passes[]` に保持（PS で findings 再構築しない）。
   bootstrap／4状態（empty/ready/selector-unmatched/cdp-error）／session喪失分離を配線。
2. **index.html 取り込み** … §7.7/§11/§10
   `passes[].raw_answer` を順に取り込み、`js/turn-complete.mjs`→`js/review-merge.mjs`（exact dedupe＋
   similar group）→`js/page-checks.mjs`（欠落ページ）を適用。`uncertain_candidates` の折りたたみ表示、
   pass別UI、`/api/review/pass-stats` への POST。
3. **split再試行の raw pass 化** … §7.7（PS の findings 結合・再JSON化を撤去）。

各項目の受入は計画書 §15（K5/K9/K10/K11/K13/K14/K16 等）で確認する。
