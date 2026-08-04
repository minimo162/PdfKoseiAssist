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
### 統合層① ReviewJob 多パスループ（実装済・オフライン検証済）
- `Start-KoseiReviewJob` に multipass 分岐を追加。pass1(broad)=既存 legacy リクエストそのまま、成功後に
  `Get-KoseiPassSchedule` を回して観点/gap を **Reuse turn** で追撃（`New-KoseiLensFollowupPrompt`/
  `New-KoseiGapFollowupPrompt`+`Get-KoseiPriorFindingsDigest`、turnごと `New-KoseiTurnMarker`）。
  各pass の raw を `per_packet.passes[]` に保持（統合は取り込み側 JS）。pass失敗は記録して継続。
- `review_engine=legacy`（既定）では丸ごとスキップ = 従来挙動と完全一致（K34不変）。
- worker runspace に ReviewJob.ps1 を dot-source（helper 利用のため）。
- **✅ 実機オフライン緑化**: `Syntax-Check.ps1` PASS(12 files)、`Test-ReviewPrimitives.ps1` PASS
  （digest/gap 追加分含む）。
- **✅ ライブ多パスジョブ緑化**: `review_engine=multipass`+quick/gap で実ジョブ実行し、
  `passes=[{0:broad, json-stable, 2件}, {1:gap, marker, 2件}]` を確認。gap が Reuse 追撃として
  同一チャットで走り `completed_by=marker`（緩和 marker境界の高速経路）、既出と別の指摘を検出
  （digest 機能）。多パスループは実機 end-to-end で動作。
- **✅ 実データ2パケット完走**: 実際の IR PDF（P1-10 / P11-18）で multipass 実行。各パケットで
  broad(json-stable) → gap(Reuse, **attach_ms=0/model_ms=0**, **completedBy=marker ~1.3s**) が走り
  `mode=done`。当初 gap raw が broad と byte一致する応答分離バグを検出→ Wait のフォールバックを
  baseline以降に限定して修正（§7.4）。
- **✅ 統合層② index.html 取り込み（最小）**: `pollAutoReviewJob` が `passes[].raw_answer` を順に
  取り込み（`importResponse` が findings を追記・重複除去）。残: `review-merge` グルーピングUI・
  `page-checks` 反映・pass-stats POST・`uncertain_candidates`・UIからの profile 明示。

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

### 分担（整合性レビュー ⇄ 校正パケット）— 2026-08-03 の実測に基づく

合成フィクスチャの実測（`docs/benchmarks/README.md`）で、整合性セクション（約25p・現物添付）は
跨ぎ・数値・会計連動をほぼ取り切る一方、散文の言い回し（訳語の揺れ・日本語の省略の逐語訳・
綴り・文法）を broad では素通りすることが分かった。観点をpassへ切り出して分担させる。

| 担当 | profile | pass列 |
|------|---------|--------|
| 整合性セクション（約25p） | `consistency` | broad → wording → ellipsis※ → gap |
| 校正パケット（約10p） | `thorough` | broad → translation※ → numbers → names → wording → ellipsis※ → spelling → grammar → structure → gap |

※ REF が無いパケットでは translation / ellipsis を skip（原文が無いと判定できない）。

- 追加観点: `wording`（訳語の揺れ）/ `ellipsis`（日本語特有の省略の逐語訳）。
  定義は `src/ReviewJob.ps1` の `$KoseiReviewLenses`、規則は `js/pass-schedule.mjs`。
- 追撃passは **同じ会話へ Reuse turn**（再添付なし）。整合性セクションは添付が大きいので、
  ここで再添付しないことがそのまま所要時間に効く。
- 整合性プロンプトは A(跨ぎ)+B(数値・固有名詞・日付・訳抜け) に集中させ、
  訳語の揺れ・省略は「このあと観点を絞って聞く」と明示して後続passへ引き渡す。
- `kind`(proofread|consistency) と `has_ref` をブラウザ→Server→ReviewJob へ配線し、
  profile 選択と REF 必須観点の判定に使う。**従来 `-HasRef $false` 固定で translation が
  常に skip されていたのを修正**。
- 上限（`review_max_passes`）超過時も **gap は1枠を予約して必ず残す**（歩留まりが高いため）。
- UI: 自動校正カードに観点別の内訳（`観点別: 全体 12 / 訳語の揺れ 3 / …`）を表示。
  どの観点が効いているか見えないと分担の妥当性を判断できないため。
- 検証: `tools/Test-PassSchedule.mjs`（規則）、`tools/Test-PassSplit.mjs`（規則＋配線＋PS/JS一致）、
  `tools/Test-ReviewPrimitives.ps1`（PS実装がJS仕様と一致）。

### 整合性レビューは multipass を強制する

`review_engine` の既定は `legacy` で、その場合 `Start-KoseiReviewJob` の multipass ブロックは
丸ごとスキップされ broad 1passのみになる。整合性レビューは観点passの追撃を前提に設計した
**v94 に存在しない新機能**なので、設定を変え忘れると黙って機能の半分が落ちる
（実際、ベンチマークの1回目・2回目とも観点passが一度も走っていなかった）。

そのため `kind=consistency` のパケットは `review_engine` に関わらず multipass で走らせる。
校正パケット（`kind=proofread`）は従来どおり flag に従うので、既定 legacy = v94 と同一挙動（K34）は保たれる。
それでも観点passが記録されない場合は、UIカードに警告を出して黙って終わらせない。

### 生成停滞（「詳細を収集しています…」）の検知

実測で SEC_002 が「受信 496文字」のまま 351秒進まず、Copilot 側は
「詳細を収集しています…」を表示し続けた（2回連続・同じ文字数で再現）。

原因: この状態では**停止ボタンが出たまま**なので `Test-KoseiCopilotGenerating` が true を返し続ける。
既存の停滞検知 `no-json-idle` は `-not $generating` を条件にしているため永久に発火せず、
本文が1文字も伸びないまま `request_timeout`（既定600秒）まで待ち続けていた。

対策: `$stableSec -ge $stallSec`（既定180秒）で **generating の申告に関わらず**打ち切り、
停止ボタンを押して `completedBy='generation-stalled'` を返す。これを `$recoverable` に加えたので、
新規チャット再試行 → 分割再試行の既存の復旧経路に乗る。途中まで受信した本文は `salvageText` に残す。
閾値は `response_stall_seconds` で調整可能（30未満は既定へ戻す）。

#### 続報: 停滞ではなく「完成した回答の取りこぼし」だった

その後 Copilot は marker 付きの**完全な回答**を返していたのに、アプリは待機中のままだった。
2つの完了経路が同じ原因で塞がれていた。

| 経路 | 条件 | なぜ塞がったか |
|------|------|----------------|
| marker | 応答末尾が marker で終わる | marker の後ろに文字が続くと `EndsWith` が成立しない |
| json-stable | 完成JSON＋**生成停止を2回連続で確認** | 停止ボタンが出たままで `generating=false` にならない |

対策: **完成した回答JSONが `response_stable_accept_seconds`（既定45秒）変化しなければ、
UIが生成中を名乗っていても受理する**。あわせて停滞打ち切り（180秒）の直前にも
完成回答の有無を確認し、あれば成功として返す（せっかくの回答を捨てて取り直さない）。

閾値の関係は `45（受理） < 180（停滞打ち切り） < 600（タイムアウト）` で、
正常な回答は受理が先に効き、本当に何も返らない場合だけ打ち切りへ進む。

#### 続報2: 応答要素が拾えないと停滞検知が丸ごと素通りしていた

実測（2026-08-04 combined50 SEC_002）: **受信46文字のまま300秒以上まったく動かない**のに
180秒の停滞検知が一度も発火せず、`request_timeout` まで無言で待ち続けた。
46文字は `{"packet_id":"SEC_002","checked_pages":[48,49,` ちょうどで、回答は途中で死んでいた。

原因: 打ち切り条件が `$responseSeen`（＝応答要素を一度でも拾えたか）を必須にしていた。
`[data-testid="markdown-reply"]` 等をどれも拾えない間は `$responseSeen` が false のままで、
`generation-stalled` も `no-json-idle` もこの節を丸ごと素通りする。
このとき `$newText` は main-diff／スナップショット経由の代替テキストになるため、
「画面には答えが見えているのに、アプリは何も掴めていない」状態になる。

対策:

- 打ち切り判定を `$responseSeen` から外す。`$stalledSec` を
  「応答要素を拾えているなら `max($stableSec, $responseStableSec)`、拾えていないなら `$stableSec`」とする。
- 応答要素が出る前は長い thinking の可能性があるため、閾値だけ倍（既定360秒）にして誤打ち切りを避ける。
  `360 < 600` なのでタイムアウトより先に発火し、`$recoverable` の新規チャット再試行に乗る。
- `$responseStableSec`（回答要素そのものの停滞時間）を別クロックとして持つ。
  `$newText` は代替経路に切り替わると画面の付随表示に引きずられて `$stableSec` が戻ることがあるため。
  ただし応答要素を拾えなかった周回では**このクロックを進めない**
  （代替経路で本文が伸びている最中に打ち切らないため）。
- 待機ログに `responseSeen` / `responseStableSec` / `source` を出す。
  次に固まったとき「応答要素が拾えていないのか、本当に生成が止まったのか」を切り分けられるようにする。

検証: `tools/Test-StallDetection.mjs`（条件式・戻り値・recoverable 登録・閾値の順序・設定の配線）。
実際の受理／打ち切り挙動は PS 5.1 実機での確認が必要。
