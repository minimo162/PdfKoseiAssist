# PDF校正アシスト 網羅性改善 修正計画書 V1

- 対象バージョン: v94（PDF校正ツール.zip / 2026-07-30 時点）
- 作成日: 2026-07-30
- 目的: Copilotが1回の依頼で指摘を網羅できず、「直す→ツールでチェック→直す→チェック」の反復になっている状態を解消する
- 方針の要旨: **ページ軸ではなく観点軸で依頼を分割し、同一チャットのマルチターンで文脈を維持する**。あわせて、プロンプト内の抑止ルールをコード側の決定的フィルタへ移し、検出側の記述量を確保する

---

## 1. 症状と原因分析

### 1.1 症状

1パケット（TARGET_CHECK 最大10ページ）に対し1回の依頼で全観点を確認させているが、返ってくる findings が毎回異なり、修正後に再実行すると前回出なかった指摘が出る。結果として反復回数が収束しない。

### 1.2 原因（現物コードで確認したもの）

| No | 原因 | 該当箇所 |
|----|------|----------|
| A1 | 1リクエストの負荷が過大。観点6種 × TARGET_CHECK最大10ページ × 1件15フィールドのJSONを同時に要求している | `index.html` L1234 `buildPacketPromptText` / L617 `MAX_REVIEW_PAGES = 10` / L618 `DEFAULT_TARGET_CHUNK_SIZE = 10` |
| A2 | 抑止ルールが検出ルールを圧倒している。「確認してほしいこと」は3行、ハイフン・空白系の禁止事項だけで約25行。モデル側に「基本は出すな」という強い事前分布を与えている | `index.html` L1234〜L1420 |
| A3 | **A2の抑止は既にコード側で二重に実装済み**。プロンプトから削っても検出品質は落ちない | `index.html` L3247 `whitespaceOnlyDiff` / L3292 `normalizeHyphenationComparisonText` / L3299 `isLikelyLineEndHyphenFalsePositive` / L3388-3389 で取り込み時に除外 / `tools/Test-WsOnlyFinding.mjs` |
| A4 | 精度フィルタをモデルの内側に置いている（`reading_confidence < 0.75 は入れない` / `evidence_quality unclear は入れない` / `omitted_uncertain_findings に件数だけ`）。捨てられた指摘が観測できず、recall損失が不可視 | 同プロンプト末尾「出力ルール」 |
| A5 | 網羅の証跡が任意。`checked_page_summaries は指摘があるページだけでよい` が抜け道になっており、完了判定は自己申告の `checked_pages` に依存。閾値も coverage ≥ 0.70 と緩い | `CopilotClient.ps1` L1158 `Get-KoseiReviewCompleteness` |
| A6 | **`-SkipFreshChatWait` が宣言のみで本体未使用（dead parameter）**。`Invoke-KoseiFreshChat` は無条件実行のため、現状は同一チャットでの追撃が構造的に不可能。分割再試行も毎回「新規チャット＋全再添付」でコストを二重に払っている | `CopilotClient.ps1` L1430（param）/ L1452（無条件 FreshChat）/ `ReviewJob.ps1` L246, L261 |
| A7 | 出力スキーマが重く、応答が長くなって `incomplete-json` 復旧・分割再試行が常態化している。出力予算をフィールドに食われ findings 件数が削られる | `ReviewJob.ps1` L240-L270 の再試行・分割マージ処理の存在自体が症状 |
| A8 | パケット間で文脈が切れており、文書全体の表記ゆれは原理的に検出不能 | 10ページ単位のチャンク分割 |

### 1.3 活かせる既存資産

- `dedupeFindings`（`index.html` L3314）: パス間の重複除去にそのまま使える
- `correctFindingPagesByUniqueQuote`: quote一意一致によるページ自動補正
- `Get-KoseiReviewCompleteness`: 網羅判定の受け皿として拡張可能
- `Invoke-KoseiSameChatRetry`（`CopilotClient.ps1` L1394）: 同一チャットへの追加入力の実装パターンが既にある
- `applyAutoAnswer` / `autoImportedPackets`（`index.html` L4837付近）: パケット単位の逐次取り込み機構

---

## 2. 改善の4原則

1. **依頼は細かく、文脈は広く** — 添付とチャット履歴を共有したまま、1ターンの観点を1つに絞る
2. **抑止はコードへ、検出はプロンプトへ** — 機械判定できる除外はコード側に置き、プロンプトは「何を探すか」に使う
3. **網羅は生成ではなくフォーム記入で担保** — 自由記述の空配列を許さず、ページ×観点のマトリクスを埋めさせる
4. **効果は推測せず計測する** — 収束パス数を記録し、観点数とページ数を数値で決める

---

## 3. フェーズ計画

| Phase | 内容 | 変更範囲 | リスク | 効果 |
|-------|------|----------|--------|------|
| 0 | 計測の土台（現状の単一パスのばらつきを測る） | ログ追加のみ | 極小 | 判断材料 |
| 1 | プロンプト減量・フィルタ移設 | `index.html` プロンプト部 | 小 | 中〜大（単独で効く） |
| 2 | 同一チャット多ターン基盤（`-ReuseChat`） | `CopilotClient.ps1` / `ReviewJob.ps1` | 中 | 土台 |
| 3 | 観点シャーディング | `index.html` / `ReviewJob.ps1` | 中 | 大 |
| 4 | 見落とし探しパス | `ReviewJob.ps1` | 小 | 大 |
| 5 | 網羅マトリクスと自動追撃 | プロンプト / `Get-KoseiReviewCompleteness` | 中 | 中 |
| 6 | 文書横断コンテキスト（用語基準表・数値突合） | `index.html` 前処理 | 中〜大 | 中 |
| 7 | 計測UIと収束表示 | `index.html` / runtime CSV | 小 | 運用 |

Phase 1 と Phase 4 は費用対効果が高く、Phase 2 の完了前後どちらでも単独で入れられる。Phase 3 と 5 は Phase 2 が前提。

---

## 4. Phase 0: 計測の土台（先行実施）

**目的**: 「1パスでどれだけ落としているか」を数値で押さえ、観点数とページ数を根拠付きで決める。

### 4.1 実施内容

1. 代表パケット2〜3件（ECMのうち文章量の多いもの）を、**現状のまま同じ条件で2回**実行する
2. 2回の findings の和集合を分母に、各回の被覆率を算出する
3. あわせて以下を1行INFOログに追加する（`ReviewJob.ps1` のパケット完了時）
   - `findings_count` / `pages_checked` / `coverage` / `total_elapsed_ms` / `completed_by`

### 4.2 判断基準

- 2回の被覆率がそれぞれ 90% 以上 → 単一パスの recall は十分。原因は A2〜A4（抑止過剰）寄りなので Phase 1 のみで済む可能性がある
- 60〜90% → Phase 1 + Phase 3/4 を実施
- 60% 未満 → Phase 1〜5 を全実施。あわせて `DEFAULT_TARGET_CHUNK_SIZE` の縮小（10→5）も検討

### 4.3 同時に確認する事項（Phase 2 の前提検証）

Copilotのチャットに手動で同じ添付を1回行い、**3ターン目・5ターン目でも添付内容を正しく参照できるか**を確認する。参照が切れる場合は Phase 3 のパス数上限をその範囲に合わせる（`review_max_passes`）。ここが崩れると Phase 2〜5 の設計前提が変わるため、必ず Phase 2 の着手前に確認する。

---

## 5. Phase 1: プロンプト減量とフィルタ移設

### 5.1 プロンプトから削除する内容（`index.html` L1234 `buildPacketPromptText`）

以下はコード側に同等の判定があるため削除する。

| 削除対象 | コード側の代替 |
|----------|----------------|
| 空白のみ差分の禁止（`( (71.6) %)` の例を含む一連） | L3247 `whitespaceOnlyDiff` → `excludedReason='ws-only-diff'` として体裁扱いで既定非表示 |
| 行末ハイフン系の禁止（North Rhine-Westphalia / plan-do-check-act / available-for-sale の3例を含む約15行） | L3299 `isLikelyLineEndHyphenFalsePositive` → L3389 で取り込み時に除外 |
| 「アプリ側で取り込まれない種類の指摘は返さない」 | 同上 |

残す抑止は次の3点のみとする。

- 指摘対象は TARGET_CHECK のページに限る（TARGET_CONTEXT / REF_CANDIDATE は対象外）
- 判読できない文字を推測・補完しない（異体字・旧字体の置換禁止の例1件のみ残す）
- ページ番号・ヘッダー/フッター・目次ナビゲーションは対象外

### 5.2 モデル内フィルタの撤去

- `reading_confidence < 0.75 は findings に入れない` → **削除**。スコアは付けさせ、閾値による絞り込みはアプリのフィルタUIで行う
- `evidence_quality が unclear のものは入れない` → **削除**。`unclear` のまま返させ、UIで別カテゴリ表示にする
- `omitted_uncertain_findings に件数だけ入れる` → **削除**。実体を返させる

UI側に「確信度で絞り込む」スライダー（既定 0.75）と、`evidence_quality=unclear` の表示切替を追加する。既存の `showFormattingFindings`（L460）と同じ場所・同じ作りで揃える。

### 5.3 検出側の記述を具体化

削減した分を使い、「確認してほしいこと」の3行を観点別のチェック項目へ展開する（Phase 3 の観点定義をそのまま流用）。

### 5.4 受入基準

Phase 0 で使った同じパケットを再実行し、findings 件数が増加し、かつ増加分のうち `excludedReason` 付き（体裁）が半数を超えないこと。

---

## 6. Phase 2: 同一チャット多ターン基盤

### 6.1 `CopilotClient.ps1` の変更

**`Invoke-KoseiCopilotReviewRequest`（L1425）**

- 追加パラメータ
  - `[switch]$ReuseChat` — 指定時、以下をスキップする
    - L1452 `Invoke-KoseiFreshChat` とその直後の2回目 screen-ready ゲート
    - L1461 `Set-KoseiCopilotModel`（同一チャット内でモデルは維持される）
    - L1465 `Invoke-KoseiCopilotAttachFiles`（既に添付済み）
  - `[string]$Marker = ''` — 空なら `$Settings.response_end_marker` を使う
- **削除**: `[switch]$SkipFreshChatWait`（L1430、未使用）
- `Start-KoseiCopilotEdge` / `Get-KoseiCopilotPage` / 1回目の screen-ready ゲートは `-ReuseChat` でもそのまま通す（Edge側の一時的な非活性から復帰できるようにする）
- 戻り値に `wsUrl` を追加する

**`Wait-KoseiCopilotReviewResponse`（L1195）**

- 追加パラメータ `[string]$Marker = ''`。空なら従来どおり `$Settings.response_end_marker`
- 理由: main-diff フォールバックは「マーカー前30,000文字を遡る」方式のため、同一チャット内で同じマーカーを使い回すと**前ターンのマーカーに誤ヒットする**。ターンごとに `KOSEI_END_P{packet}_T{turn}` を使う

**セッション喪失時の扱い**

ターン開始時に `Get-KoseiMainText` の長さが前ターン終了時点より短い場合、チャットが失われたと判断し、そのパケットを**新規チャットから観点1でやり直す**（部分結果は保持し、`pass.status='restarted'` を記録）。

### 6.2 `ReviewJob.ps1` の変更

- `per_packet` に `passes` 配列を追加する
  - 各要素: `pass_id` / `lens` / `status`(queued|running|done|error|skipped|restarted) / `marker` / `raw_answer` / `findings_count` / `pages_checked` / `coverage` / `elapsed_ms` / `error`
- パケットループの内側に**パスループ**を新設する
  - 1パス目のみ添付あり（`-AttachPaths $attach`）
  - 2パス目以降は `-ReuseChat` かつ `-AttachPaths @()`、短い追撃文のみを送信
- **中止応答性**: 現状の cancel チェックはパケット単位（L226付近）のみ。パスループの先頭にも `$State.cancel_requested` の確認を入れる
- 既存の分割再試行（L253-L270）は「応答が壊れた」状況での復旧なので、**従来どおり新規チャット**で行う（`-ReuseChat` を付けない）
- `ConvertTo-KoseiJobStatusObject` / `Get-KoseiJobResultObject` に `passes` を追加。後方互換のため `raw_answer` は残し、1パス目の内容を入れる

### 6.3 取り込み側（`index.html`）

- パス単位のマージは**PowerShell側では行わない**（`ConvertFrom-Json` / `ConvertTo-Json` の型崩れを避ける）。`result.packets[].passes[].raw_answer` をそのまま返し、`pollAutoReviewJob`（L4837付近）が順に `applyAutoAnswer` する
- `autoImportedPackets` のキーを `packet_id` → `${packet_id}#${pass_id}` に変更する
- `dedupeFindings`（L3314）の重複キーを緩める
  - 現状: `page|category|quote|suggestion|reason`
  - 変更後: `page|category|正規化quote`（正規化は `normalizeHyphenationComparisonText` を流用）
  - 理由: パス間で同一箇所が別の言い回しで返るため、reason を含めると重複が残る

### 6.4 受入基準

添付は1回のみで、2ターン目以降が同一チャットで実行され、`attach_ms=0` が `phase_timings` に記録されること。

---

## 7. Phase 3: 観点シャーディング

### 7.1 観点定義（`index.html` に `REVIEW_LENSES` として定義）

| lens | ラベル | 内容 |
|------|--------|------|
| `spelling` | 綴り・タイポ | 綴り誤り、大文字小文字、重複語、欠落語、記号の誤用 |
| `grammar` | 文法 | 冠詞、時制、単複、前置詞、主述一致、句読点 |
| `numbers` | 数値・日付 | 金額、単位、通貨、％、桁区切り、符号、年月日、年度表記 |
| `names` | 固有名詞 | 社名、製品名、部門名、人名、略語、役職名の不整合 |
| `translation` | 訳抜け・誤訳 | REF照合による意味ズレ、否定/条件/範囲のズレ（REFがある場合のみ有効） |
| `structure` | 表・注記・構造 | 表、注記、見出し、脚注、図表ラベル、相互参照、目次整合 |

### 7.2 パス構成

- **1パス目**: 減量版のフル指示書（`PROMPT_*.txt`）＋ 添付。観点は `spelling` + `grammar` を含む全体走査（従来相当）
- **2パス目以降**: 観点1つに絞った追撃文のみ（添付なし）。雛形:

```
同じ添付資料のまま、観点「{lens_label}」だけに絞って TARGET_CHECK 全ページ（P.{range}）を
もう一度、先頭ページから順に走査してください。

この観点で見るもの:
{lens_detail}

- 既出の指摘と重複して構いません。重複はアプリ側で除去します。
- 対象ページは全ページです。1ページも飛ばさないでください。
- 回答は指示書と同じJSON形式で、issue_scope に "{lens}" を入れてください。
- 回答JSONの直後の行に {marker} とだけ出力してください。
```

- **観点を絞る分、ページ数は増やせる**。Phase 0 の結果に応じて `DEFAULT_TARGET_CHUNK_SIZE` を10のまま維持、または増やす

### 7.3 プロファイル設定

`settings.json` の `review_pass_profile` で切り替える。

| プロファイル | パス構成 | 想定所要（1パケット） |
|--------------|----------|----------------------|
| `quick` | 1パス（従来相当） | 現状どおり |
| `standard` | 1パス目 + `numbers` + `names` + `structure` | 現状の約3〜4倍 |
| `thorough` | standard + `spelling` + `grammar` + `translation` + 見落とし探し | 現状の約6〜8倍 |

既定は `standard`。UIの自動校正カードにプロファイル選択を置く。

### 7.4 注意点

- 応答待機がパスごとに発生するため、1パケットの総所要が数十分に達しうる。**全17件の一括実行では `quick` を既定にし、重要パケットのみ `thorough` を選ぶ**運用を想定する
- `issue_scope` に lens を入れることで、Phase 7 の「どの観点が何パス目で拾ったか」の集計が可能になる

---

## 8. Phase 4: 見落とし探しパス

### 8.1 設計

全観点パスの完了後、同一チャットで最後に1ターンだけ実行する。モデルは「ゼロから網羅的に生成する」より「与えた一覧に無いものを探す」方が強いため、単独でも効果が大きい。

`ReviewJob.ps1` 側で、それまでの `passes[].raw_answer` を `ConvertFrom-Json` し、`page` / `quote` / `category` を抽出して一覧テキストを生成する。

- 上限: 50件。quote は40文字で切る
- 50件を超える場合は page 昇順で先頭50件のみ渡し、追撃文に「一覧は先頭50件のみです」と明記する

```
これまでに挙がった指摘は次の {n} 件です。

{page / category / quote の一覧}

この一覧に含まれていない指摘だけを挙げてください。
- 同じ箇所の言い換えや、表現を変えただけのものは不要です。
- 一覧が薄いページ（指摘0件のページ）を特に丁寧に見てください。
- 該当がなければ findings を空配列にし、no_findings_reason に確認範囲を書いてください。
- 回答JSONの直後の行に {marker} とだけ出力してください。
```

### 8.2 設定

`review_gap_pass`（bool、既定 `true`）。`review_pass_profile=quick` の場合も、このパスだけは有効にできるようにする（1パス＋見落とし探しの2ターン構成が費用対効果の最良点になる可能性があるため）。

---

## 9. Phase 5: 網羅マトリクスと自動追撃

### 9.1 出力スキーマの変更

`checked_page_summaries`（指摘のあるページのみ可）を、必須の `page_checks` に置き換える。

```json
"page_checks": [
  { "page": 7, "lens": "numbers", "verdict": "ok" },
  { "page": 8, "lens": "numbers", "verdict": "finding" },
  { "page": 9, "lens": "numbers", "verdict": "unreadable" }
]
```

- 各パスで「対象ページ数 × そのパスの観点1つ」の行数が**必ず**必要
- 自由記述の要約を廃止し、フォーム記入に変える

### 9.2 `Get-KoseiReviewCompleteness`（`CopilotClient.ps1` L1158）の拡張

- 追加パラメータ `[string]$Lens = ''`
- `$script:KoseiPageCheckFieldPriority` の先頭に `page_checks` を追加（既存の `checked_pages` / `checked_page_summaries` も後方互換で受ける）
- `page_checks` がある場合の完了判定を、行数ベースの網羅率に変更する
- `coverage` 閾値を設定化する: `coverage_threshold`（既定 0.95。従来の 0.70 は `page_checks` 非対応回答へのフォールバック時のみ使用）

### 9.3 未記入セルの自動追撃

`page_checks` に欠落ページがある場合、**そのページだけに絞った追撃を同一チャットで1回**実行する。

- 既存の分割再試行ロジック（`ReviewJob.ps1` L253-L270）を流用するが、新規チャットではなく `-ReuseChat` を使う
- 追撃は1パスにつき1回まで。それでも埋まらないページは `pass.warning` に記録し、UIに「未確認ページ」として表示する
- これにより、細粒度の依頼が**自動的に、必要な箇所だけ**発生する

---

## 10. Phase 6: 文書横断コンテキスト

「文脈を広く」のもう一つの解。ページ単位の依頼に、**文書全体から機械抽出した統計**を注入する。LLMを「探索」から「判定」に降格させるのが狙い。

### 10.1 用語・表記の基準表（6-1）

- `index.html` の既存テキスト抽出（`buildPacketTextSidecar`、L2549）を全ページに適用し、以下を決定的に抽出する
  - 大文字始まりの連続語（固有名詞候補）
  - 略語（全大文字2〜6文字）
  - 年度表記（`FY2026` / `FY26` / `2026年度` など）
  - 全角/半角、ハイフン有無、大文字小文字だけが違う表記のペア
- **変異が2種類以上ある語だけ**を表にする（統一されている語は載せない）
- 上限: 100行 / 4,000文字。超過分は出現頻度上位で打ち切る
- 各パケットのプロンプトに「文書全体の表記変異一覧（機械抽出）」として埋め込み、「この一覧に該当する箇所を優先的に確認してください」と指示する
- **これによりパケット横断の表記ゆれが初めて検出可能になる**（A8 の解決）

### 10.2 未突合数値の候補表（6-2、REFがある場合）

- TARGET / REF 両方のテキストから数値トークン（金額・％・年月日）を抽出し、桁区切り・全角半角・符号表記を正規化して集合比較する
- 片側にしか存在しない値を「未突合数値」として最大60件、プロンプトに渡す
- Copilotの役割は「探す」から「この未突合が実際に問題か判定する」に変わる

### 10.3 辞書外語リスト（6-3、**保留**）

- 簡易英単語リストで TARGET_CHECK の辞書外トークンを抽出する案
- ただし会計・IR用語が大量に辞書外となるため、ホワイトリスト整備の運用コストが読めない
- 6-1 / 6-2 の効果検証後に着手可否を判断する。同梱する単語リストのサイズとライセンスも要確認

---

## 11. Phase 7: 計測と収束表示

### 11.1 ログ

`runtime/pass-stats.csv` を追加する。

```
timestamp,job_id,packet_id,pass_id,lens,findings_total,findings_new,findings_dup,pages_checked,coverage,elapsed_ms,completed_by
```

`findings_new` / `findings_dup` は取り込み側（`index.html`）でしか判定できないため、`applyAutoAnswer` の結果を `POST /api/review/pass-stats` で書き戻す新規エンドポイントを `Server.ps1` に追加する。

### 11.2 UI

- 自動校正カードにパス別の進捗と新規指摘件数を表示する（`パス3/5 数値・日付 — 新規4件`）
- **最終パスで新規0件なら「収束」バッジ**を表示する。反復が必要かどうかがその場で判断できる
- 観点別の「何パス目で出たか」の集計を指摘一覧のヘッダーに置き、次回のプロファイル選択に使う

---

## 12. 設定項目一覧（`config/settings.template.json` 追加分）

```json
{
  "review_pass_profile": "standard",
  "review_lenses": "spelling,grammar,numbers,names,translation,structure",
  "review_max_passes": 8,
  "review_gap_pass": true,
  "coverage_threshold": 0.95,
  "coverage_threshold_legacy": 0.70,
  "reading_confidence_display_threshold": 0.75,
  "glossary_context_enabled": true,
  "glossary_context_max_chars": 4000,
  "number_reconciliation_enabled": true,
  "number_reconciliation_max_items": 60
}
```

既存キーは変更しない。未設定時は上記の既定値で動作させ、`review_pass_profile="quick"` かつ `review_gap_pass=false` のとき v94 と同一挙動になること（＝安全なロールバック経路）を保証する。

---

## 13. 後方互換とロールバック

| 項目 | 方針 |
|------|------|
| 単一パス動作 | `review_pass_profile="quick"` + `review_gap_pass=false` で v94 相当。Phase 1 のプロンプト減量のみ残る |
| 旧形式の回答 | `checked_pages` / `checked_page_summaries` のみの回答も引き続き受理（`coverage_threshold_legacy` を適用） |
| `raw_answer` | `passes` 追加後も1パス目の内容を保持し、既存の手動貼り戻しUI（`?advanced=1`）を壊さない |
| `-SkipFreshChatWait` 削除 | `ReviewJob.ps1` L246 / L261 の呼び出しを同時に修正する。**片方だけの変更は禁止** |
| 混在バージョン | サーバーと `index.html` は同一ZIPで配布する前提を維持 |

---

## 14. 受入テスト

### Phase 0

- K1: 同一パケットを2回実行し、findings の和集合に対する各回の被覆率が算出できる
- K2: 手動で同じ添付を行い、3ターン目・5ターン目でも添付内容を参照した回答が返る
- K3: パケット完了時に `findings_count` / `coverage` / `total_elapsed_ms` が1行INFOログに残る

### Phase 1

- K4: プロンプト文字数が減量前より 25% 以上減っている
- K5: 空白のみ差分の指摘が返ってきた場合、`excludedReason='ws-only-diff'` として体裁扱いになり既定で非表示になる
- K6: 行末ハイフン誤認識の指摘が返ってきた場合、取り込み時に除外され件数が報告される
- K7: `reading_confidence` 0.75 未満の指摘が返り、UIのスライダーで表示/非表示が切り替わる
- K8: 同一パケットで findings 件数が減量前より増加し、増加分の体裁指摘比率が50%以下

### Phase 2

- K9: 2ターン目以降の `phase_timings.attach_ms` が 0
- K10: 2ターン目以降の `phase_timings.model_select_ms` が 0
- K11: ターンごとに異なるマーカーが使われ、前ターンのマーカーに誤ヒットしない
- K12: パスループ中の中止要求が5秒以内に反映される
- K13: チャット喪失を検知した場合、新規チャットから観点1でやり直し、`pass.status='restarted'` が記録される
- K14: `dedupeFindings` のキー変更後、パス間の同一箇所（言い回し違い）が1件にまとまる
- K15: `-SkipFreshChatWait` の参照が全ファイルから消えている（`Syntax-Check.ps1` に静的チェックを追加）
- K16: 分割再試行は新規チャットで実行され、`-ReuseChat` が付いていない

### Phase 3

- K17: `review_pass_profile="standard"` で4パスが順に実行される
- K18: 各 finding の `issue_scope` にそのパスの lens が入る
- K19: REFなしのパケットで `translation` パスがスキップされる
- K20: `review_max_passes` を超えるパス構成を指定した場合、超過分がスキップされ警告が残る

### Phase 4

- K21: 見落とし探しパスで、既出一覧に含まれない指摘のみが返る
- K22: 既出が50件を超える場合、先頭50件のみ渡され追撃文に明記される
- K23: `review_pass_profile="quick"` + `review_gap_pass=true` の2ターン構成が動作する

### Phase 5

- K24: `page_checks` が対象ページ数分返り、行数ベースで完了判定される
- K25: 欠落ページがある場合、そのページだけの追撃が同一チャットで1回実行される
- K26: 追撃後も埋まらないページが `pass.warning` とUIに「未確認ページ」として出る
- K27: `page_checks` を返さない旧形式回答が `coverage_threshold_legacy` で判定される

### Phase 6

- K28: 表記変異一覧が生成され、統一されている語が含まれない
- K29: 変異一覧が 4,000 文字上限で打ち切られ、`max_prompt_chars`（60,000）を超えない
- K30: 未突合数値の候補表が生成され、桁区切り・全角半角の差で誤検知しない

### Phase 7

- K31: `runtime/pass-stats.csv` にパス単位の行が追記される
- K32: 最終パスで新規0件のとき「収束」バッジが表示される
- K33: 観点別の初出パス集計が指摘一覧ヘッダーに表示される

### 全体

- K34: `review_pass_profile="quick"` + `review_gap_pass=false` で v94 と同じ挙動・同じ所要時間になる
- K35: `tools\Syntax-Check.ps1` が全 `.ps1` でエラー0
- K36: `tools\Test-WsOnlyFinding.mjs` が引き続き PASS
- K37: ZIP再パッケージ後、日本語ファイル名が文字化けせず展開される

---

## 15. リスクと未決事項

### リスク

| リスク | 内容 | 対策 |
|--------|------|------|
| R1 | 総所要時間の増大。5パス構成で1パケット数十分、17件一括では非現実的になりうる | プロファイル制。一括は `quick`、重要パケットのみ `thorough`。Phase 0 で1パスの実測を取ってから決める |
| R2 | Copilot側のチャット履歴長制限で、後半パスが添付を参照しなくなる | Phase 0 の K2 で事前検証。`review_max_passes` で上限を設ける。参照喪失時は再添付にフォールバック |
| R3 | 抑止ルール削除により体裁指摘が急増し、レビュー負荷が上がる | 既存の `showFormattingFindings` で既定非表示。K8 で増加分の比率を監視 |
| R4 | 同一チャットの多ターンでモデルが「もう見た」として手を抜く | 追撃文に「先頭ページから順に」「重複可」を明記。Phase 7 の新規件数でパスごとの実効を監視 |
| R5 | パス間の重複除去が過剰に効き、別の指摘を落とす | dedupe キーに `category` を残す。除去件数をUIに表示し、必要なら重複表示に切り替えられるようにする |
| R6 | PowerShell 5.1 固有の型/エンコーディング問題（過去に複数回発生） | `passes` 配列の要素は `[pscustomobject][ordered]@{}` で型を統一。JSON化前の `Sort-Object` のソートキーを型キャストする |

### 未決事項

1. **観点数と1パケットのページ数の最適点** — Phase 0 の計測結果で決める。現時点では観点4・ページ10を仮置き
2. **辞書外語リスト（Phase 6-3）の実施可否** — 会計/IR用語のホワイトリスト整備コストが読めないため保留
3. **一括実行時の既定プロファイル** — 実務の締切に依存するため運用判断。技術的には `quick` を既定とし、UIで昇格させる形を想定
4. **`page_checks` の粒度** — ページ×観点で行数が「10ページ×1観点=10行/パス」になる。表・注記まで細分化するとさらに増えるため、初版はページ単位に留める

---

## 16. 着手順の推奨

```
Phase 0（計測・前提検証）
  ↓  ここで判断: 1パスのrecallが十分なら Phase 1 のみで完了する可能性がある
Phase 1（プロンプト減量・フィルタ移設）        ← 単独で効く。リスク最小
  ↓
Phase 2（-ReuseChat 基盤）                     ← 土台。ここが通れば以降は積み上げ
  ↓
Phase 4（見落とし探しパス）                    ← Phase 2 直後に入れると費用対効果が最良
  ↓
Phase 3（観点シャーディング）
  ↓
Phase 5（網羅マトリクス）
  ↓
Phase 7（計測UI） → Phase 6（文書横断コンテキスト）
```

Phase 4 を Phase 3 より先に置いているのは、追加ターン1回だけで効果が大きく、Phase 3 の観点設計の妥当性を判断する材料にもなるため。
