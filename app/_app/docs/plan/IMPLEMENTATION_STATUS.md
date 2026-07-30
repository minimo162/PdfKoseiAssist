# 実装ステータス（網羅性改善 V3.3）

本ドラフトPRは、修正計画書 V3.3（`docs/plan/修正計画書_V3.3.md`）の **PR 1（Phase 0 基盤）** と
**PR 2 の第一歩（Phase 1 §6.1 フィルタfixtureゲート）** を対象とする。計画書 §17 は全体を
7つの独立したfeature-flag付きPRへ分割することを求めており、本PRはその土台のみを、
**既定挙動を v94 と同一に保ったまま**導入する。

## 本PRに含むもの（実装済み）

| 項目 | 計画書 | ファイル | 検証 |
|------|--------|----------|------|
| feature flag（既定 legacy/v94） | §4.2 | `config/settings.template.json`, `src/Settings.ps1` | JSON妥当性OK。allowlist検証関数 `Get-KoseiValidatedReviewFlags` 追加 |
| pass統計CSV + エンドポイント | §7.1, §13.2 | `src/Server.ps1`（`Write-KoseiPassStat` / `POST /api/review/pass-stats`） | localhost限定・固定schema・allowlist・数値範囲・CSVエスケープ・書込みlock |
| benchmarkスコアラ | §2.1, §5 | `docs/benchmarks/score.mjs`, `README.md`, `example/` | **node実行で確認済み**（strict/assisted recall・findings/candidate/combined precision・review burden・観点別） |
| 決定的フィルタfixture（Phase 1 の前提ゲート） | §6.1 | `tools/Test-DeterministicFilters.mjs` | **node実行でPASS**。index.html から現物関数を抽出し、除外すべき例／除外してはいけない例を両方検証 |
| 計画書本体 | — | `docs/plan/修正計画書_V3.3.md` | — |

### 実行方法

```bash
cd app/_app
node tools/Test-DeterministicFilters.mjs         # Phase 1 §6.1 フィルタ等価性ゲート
node tools/Test-WsOnlyFinding.mjs                # 既存（回帰）
node docs/benchmarks/score.mjs docs/benchmarks/example/gold.json docs/benchmarks/example/run.json
```

## 未検証（このリポジトリ環境で実行できないもの）

- **PowerShell（`.ps1`）はPS 5.1ランタイムが無いため未実行**。`src/Settings.ps1` / `src/Server.ps1`
  の変更は既存パターンに厳密に倣い、括弧・波括弧のバランスのみ機械確認済み。**マージ前に
  `tools/Syntax-Check.ps1` と PS 5.1 実機での動作確認が必須**（K35）。
- `POST /api/review/pass-stats` の実書込み・`Get-KoseiValidatedReviewFlags` の挙動は実機確認前。

## 追加実装（後続コミット）

### アルゴリズム核（ES module・node検証済み）
| 項目 | 計画書 | ファイル | 検証 |
|------|--------|----------|------|
| `page_checks` range parser・100%完了判定 | §10.2 | `js/page-checks.mjs` | **node PASS**（`tools/Test-PageChecks.mjs`）|
| exact dedupe / similar group（別suggestionを失わない, fix #6） | §11 | `js/review-merge.mjs` | **node PASS**（`tools/Test-ReviewMerge.mjs`）|
| turn 完了検知/成功分類（marker独立行＋valid JSON＋後続空白, fix F） | §7.3 | `js/turn-complete.mjs` | **node PASS**（`tools/Test-TurnComplete.mjs`）|
| profile→pass スケジュール（translation skip・max_passes・gap） | §7.2/§9.2 | `js/pass-schedule.mjs` | **node PASS**（`tools/Test-PassSchedule.mjs`）|

これらは純ロジックの ES module。UI/取り込み配線（index.html）と PS ループへの適用は後続。
アルゴリズムの正しさはこの層で確定させ、PS/HTML の統合層は同じ規則を写す。

### Phase 2 turn/session 基盤（PowerShell・未実行）
| 項目 | 計画書 | ファイル |
|------|--------|----------|
| `ChatMode`(New/Reuse/RestartWithContext)。`SkipFreshChatWait` 削除・2呼出側を同時修正 | §7.1, §13 | `src/CopilotClient.ps1`, `src/ReviewJob.ps1` |
| `Get-KoseiAssistantSnapshot`（全selector snapshot, 4状態hint） | §7.3 | `src/CopilotClient.ps1` |
| `Get-KoseiAssistantTailHash`（PS側SHA-256, fix G） | §7.3 | `src/CopilotClient.ps1` |
| turnごとの `-Marker` 受け渡し（前ターン誤ヒット防止, §7.3） | §7.3 | `src/CopilotClient.ps1` |
| `Test-KoseiTurnMarkerBoundary`＋完了検知を独立行照合へ（fix F, incomplete-json維持） | §7.3 | `src/CopilotClient.ps1` |
| `Get-KoseiPassSchedule`／`New-KoseiTurnMarker`／`New-KoseiLensFollowupPrompt`／`$KoseiReviewLenses`（tested JS の写し） | §7.2/§9.2 | `src/ReviewJob.ps1` |
| K15 静的ガード（`SkipFreshChatWait` 再導入禁止） | K15 | `tools/Syntax-Check.ps1` |

> ⚠️ turn/session の PS 変更は **PS 5.1 未実行**。既定 `ChatMode='New'` は現行と同一経路（FreshChat→model→attach→送信）で、`SkipFreshChatWait` は元々 dead parameter だったため**挙動は不変**。`Reuse`/`RestartWithContext` の実際の多ターン運用（bootstrap・marker確定条件・4状態遷移・session喪失分離）は、次PRで `Wait-KoseiCopilotReviewResponse` の応答識別と ReviewJob のパスループへ配線して初めて有効化する。

> **実機検証の手順は `docs/plan/VERIFICATION.md`（B案ランブック）参照。**
> **✅ ステップ1（オフライン）は実機 PS 5.1 で緑化済み**: `Syntax-Check.ps1` PASS（12 files）、`Test-ReviewPrimitives.ps1` 全項目 PASS（`Get-KoseiAssistantTailHash` は node の SHA-256 と一致）。これにより tail_hash・`Test-KoseiTurnMarkerBoundary`・`Get-KoseiPassSchedule`・`New-KoseiTurnMarker`・`Get-KoseiValidatedReviewFlags`・`Write-KoseiPassStat` 検証が決定的に確認された。
> **✅ ステップ3（ライブCDP snapshot）緑化**: 実機 Copilot で `empty→ready` 遷移、selector 1（`[data-testid="markdown-reply"]`）が現行DOMに一致、`latest_text` 取得、`tail_hash` = SHA-256（node と一致）を確認。snapshot/tail_hash/bootstrap-empty がライブで機能。
> **✅ Reuseターン緑化**: 実機で New→Reuse を連続実行し、Reuse で `attach_ms=0`/`model_select_ms=0`（添付・モデル選択スキップ）、turnごと一意markerを検知（誤ヒットなし）、同一チャット多ターン成立を確認。あわせて準備ゲートの surface 判定を URL(`/conversation/`) 対応へ修正（Copilot が会話を自動リネームすると title だけでは 'unknown' になりゲート不通過だった）。
> 観測: 完了は `json-stable` 経路（marker 行の後に Copilot が免責文等を付すため、marker が「最終非空行」条件を満たさず、marker 即時確定でなく安定待ちで確定）。turn latency 改善のため marker 境界の「後続は空白のみ」条件を「免責文等の末尾ボイラープレート許容」へ緩める調整を検討中。
> 残るライブ検証: ステップ2（既定挙動の不変, K34）／ステップ4（pass-stats）。

## 残（後続PR、計画書の分割・ゲートに従う）

| 後続 | 内容 | 前提 |
|------|------|------|
| PR 2 残 | §6.2 プロンプト減量・`uncertain_candidates` の実配線 | フィルタfixtureゲート（実装済） |
| PR 3 残 | §7.4 bootstrap・4状態遷移・session喪失分離を `Wait`/ReviewJob へ配線 | ライブCDP検証 |
| PR 4/5 残 | ReviewJob 多パスループ（`Get-KoseiPassSchedule` を回し Reuse turn で追撃、passes 配列、gap/観点別）と split merge 撤去 | ライブCDP検証・PR3 |
| index.html 配線 | `review-merge.mjs`／`page-checks.mjs`／`turn-complete.mjs` の取り込み側適用、`uncertain_candidates` 表示、pass別UI、pass-stats POST | ブラウザ実機 |
| PR 7 | §12/§13 文書横断候補・収束UI・運用既定値 | 各Phase実測 |

> **統合層（ReviewJob 多パスループ本体 と index.html 取り込み）は本セッションで着手していない。** これらは (1) ライブ Copilot + CDP、(2) 4900行 index.html のブラウザ挙動、でしか検証できず、上記の未検証 PS プリミティブと tested JS 核を配線して初めて機能する。静的検査のみで正しさを担保できないため、PS 5.1 + 実機環境での実装・検証を推奨する（計画書 §18 の着手順とも整合）。アルゴリズム核（filters/page_checks/merge/turn-complete/pass-schedule）は本層で検証済みなので、統合層はそれを写すだけで済む。

### 設計上の不変条件（本PRで担保）

- 既定 `review_engine=legacy` / `review_prompt_version=v94` / `review_gap_pass` 等が設定されても、
  **現行コードはこれらを未参照**のため、v94 と完全に同一の挙動・所要時間を維持する（K34）。
  flag は後続PRが `Get-KoseiValidatedReviewFlags` 経由で参照して初めて効く。
- 追加した settings キーは既存キーと衝突しない（§12）。未知値は allowlist で既定へ戻す。
