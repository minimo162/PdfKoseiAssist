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

### Phase 4/5 ロジック核（node検証済み）
| 項目 | 計画書 | ファイル | 検証 |
|------|--------|----------|------|
| `page_checks` range parser・100%完了判定 | §10.2 | `js/page-checks.mjs` | **node PASS**（`tools/Test-PageChecks.mjs`）|
| exact dedupe / similar group（別suggestionを失わない, fix #6） | §11 | `js/review-merge.mjs` | **node PASS**（`tools/Test-ReviewMerge.mjs`）|

これらは純ロジックの ES module。UI/取り込み配線（index.html）は後続で行う。

### Phase 2 turn/session 基盤（PowerShell・未実行）
| 項目 | 計画書 | ファイル |
|------|--------|----------|
| `ChatMode`(New/Reuse/RestartWithContext)。`SkipFreshChatWait` 削除・2呼出側を同時修正 | §7.1, §13 | `src/CopilotClient.ps1`, `src/ReviewJob.ps1` |
| `Get-KoseiAssistantSnapshot`（全selector snapshot, 4状態hint） | §7.3 | `src/CopilotClient.ps1` |
| `Get-KoseiAssistantTailHash`（PS側SHA-256, fix G） | §7.3 | `src/CopilotClient.ps1` |
| turnごとの `-Marker` 受け渡し（前ターン誤ヒット防止, §7.3） | §7.3 | `src/CopilotClient.ps1` |
| K15 静的ガード（`SkipFreshChatWait` 再導入禁止） | K15 | `tools/Syntax-Check.ps1` |

> ⚠️ turn/session の PS 変更は **PS 5.1 未実行**。既定 `ChatMode='New'` は現行と同一経路（FreshChat→model→attach→送信）で、`SkipFreshChatWait` は元々 dead parameter だったため**挙動は不変**。`Reuse`/`RestartWithContext` の実際の多ターン運用（bootstrap・marker確定条件・4状態遷移・session喪失分離）は、次PRで `Wait-KoseiCopilotReviewResponse` の応答識別と ReviewJob のパスループへ配線して初めて有効化する。

## 残（後続PR、計画書の分割・ゲートに従う）

| 後続 | 内容 | 前提 |
|------|------|------|
| PR 2 残 | §6.2 プロンプト減量・`uncertain_candidates` の実配線 | フィルタfixtureゲート（実装済） |
| PR 3 残 | §7.3/§7.4 marker確定条件・bootstrap・4状態・session喪失分離を Wait/ReviewJob へ配線 | ライブCDP検証 |
| PR 4 残 | §7.7 raw pass pipeline・split merge撤去。`review-merge.mjs` を index.html へ配線 | PR 3 |
| PR 5 | §8/§9 gap pass・観点別pass・profile scheduler | PR 3・Phase 0実測 |
| PR 6 残 | §10.3 限定追撃。`page-checks.mjs` を取り込み側へ配線 | PR 3 |
| PR 7 | §12/§13 文書横断候補・収束UI・運用既定値 | 各Phase実測 |

### 設計上の不変条件（本PRで担保）

- 既定 `review_engine=legacy` / `review_prompt_version=v94` / `review_gap_pass` 等が設定されても、
  **現行コードはこれらを未参照**のため、v94 と完全に同一の挙動・所要時間を維持する（K34）。
  flag は後続PRが `Get-KoseiValidatedReviewFlags` 経由で参照して初めて効く。
- 追加した settings キーは既存キーと衝突しない（§12）。未知値は allowlist で既定へ戻す。
