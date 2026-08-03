# ベンチマークとスコアリング（Phase 0）

修正計画書 §5 / §2.1 に対応する計測基盤。「指摘件数が増えた」ではなく、gold set
（埋め込んだ既知誤り）に対する recall / precision / review burden で効果を判定する。

## ファイル

| パス | 役割 |
|------|------|
| `score.mjs` | gold set と run 出力を突き合わせ、§2.1 の指標を算出（Node.js、依存なし） |
| `example/gold.json` | gold set スキーマの合成例（架空データ） |
| `example/run.json` | run 出力スキーマの合成例 |
| `runs/*.json` | 実測した run 出力（`fixtures/gold.json` と突き合わせる） |

## gold set の作り方（§5.1）

代表6パケット以上（文章中心／表中心／数値・日付／固有名詞／日本語REFあり／REFなし／
OCR低品質を含む）を用意し、実務上あり得る既知誤りを合計60件以上、6観点へ各8件以上、
ページ先頭・中央・末尾へ分散して埋め込む。実データを置けない場合は架空の会社名・数値で
同じレイアウトを再現する。元資料・埋め込み後資料・誤りID・ページ・観点・正解理由を
本ディレクトリで管理する。

### gold.json スキーマ

```json
{
  "packets": [
    { "packet_id": "P1",
      "planted": [
        { "id": "e1", "page": 7, "lens": "numbers", "quote": "12,345" }
      ] }
  ]
}
```

`lens` は `spelling|grammar|numbers|names|translation|structure` のいずれか。

### run.json スキーマ

各 run（v94 legacy / prompt減量版 / multipass版を各3回）の出力を、パケット単位に整形する。

```json
{
  "packets": [
    { "packet_id": "P1",
      "findings": [ { "page": 7, "quote": "12,345" } ],
      "uncertain_candidates": [ { "page": 8, "quote": "..." } ] }
  ]
}
```

## 合成フィクスチャ（誤りを埋め込んだ日英ペア）

実運用で渡している日英ペアは**人手校正を一通り終えた後**のもので、残存誤りがほぼ無い。
そのため recall（見つけるべき誤りをどれだけ拾えたか）が測れず、「指摘が少ない＝良い」のか
「見落とし」なのか区別がつかない。そこで、**同じ体裁で誤りを既知の位置に埋め込んだ**
合成文書を `fixtures/` に用意する。

| ファイル | 内容 |
|----------|------|
| `fixtures/aoi-seiki_ja_REF.pdf` | 日本語原文（**正**）27ページ |
| `fixtures/aoi-seiki_en_TARGET.pdf` | 英訳（誤り29件を埋め込み済み）26ページ |
| `fixtures/gold.json` | 正解セット（`score.mjs` 互換、`packet_id: "ALL"`） |
| `fixtures/gold.md` | 人が読む誤り一覧（TARGET頁／REF頁／観点／理由） |
| `fixtures/fixture-content.mjs` | 本文と埋め込み誤りの定義（唯一の情報源） |
| `fixtures/build-fixture.mjs` | HTML→PDF 生成と gold 出力（`node docs/benchmarks/fixtures/build-fixture.mjs`） |

架空企業「株式会社アオイ精機」の有価証券報告書抜粋。誤りは29件で、観点内訳は
translation 12 / numbers 9 / structure 4 / names 2 / spelling 1 / grammar 1。
埋め込みの狙いは**単ページでは原理的に取れない誤りを含めること**で、

- 跨ぎでしか出ない（配当 45 vs 54、自己資本比率 42.3 vs 42.8、営業利益 32,450 vs 31,450、
  従業員 3,214 vs 3,241、子会社名・役員名の表記揺れ、「減損なし」と注記「減損1,200」の矛盾）
- 会計連動でしか出ない（CF 三区分の合計が現金増減と合わない、セグメント内訳合計が総計と合わない）
- 日本語特有の省略を逐語訳した結果、英語で主語・目的語・指示対象が消えるもの（3件）
- 訳抜け（文・但し書きが丸ごと消えているもの、3件）

を意図的に混ぜてある。校正パケット（約10p）で取れるものと、整合性レビュー（セクション単位・
現物添付）でないと取れないものが gold.md で区別できる。

`build-fixture.mjs` は planted の `quote` が英語本文に実在するかを毎回検証し、
一致しなければ生成を中断する（gold が本文とずれるのを防ぐ）。日本語 p2 の【表紙】は
英訳版に無いため p3 以降は日英で1ページずれる。これは誤りではなく、ページ対応ズレの再現である。

## 実行

```bash
node docs/benchmarks/fixtures/build-fixture.mjs      # フィクスチャPDFとgoldを再生成
node docs/benchmarks/score.mjs docs/benchmarks/example/gold.json docs/benchmarks/example/run.json
# 位置ズレを許容する場合（±1ページ）:
node docs/benchmarks/score.mjs gold.json run.json --match-window 1
```

出力（§2.1 の指標）:

- `strict_planted_recall_pct` … `findings` のみ
- `assisted_planted_recall_pct` … `findings ∪ uncertain_candidates`
- `findings_precision_pct` / `candidate_precision_pct` / `combined_precision_pct`
- `review_burden` … packetあたり `uncertain_candidates` の avg / p90 / max
- `per_lens` … 観点別 recall

## マッチングの注意（§10.4）

`score.mjs` の突き合わせは「page一致＋正規化quoteの部分一致」による決定的な一次近似で
あり、人手ラベリングを置き換えるものではない。precision の最終判定は人が確認する。閾値
（§2.2）に対する合否は、複数runの中央値で評価し、データ量が不足する場合は理由を記録して
見直す。

## 実行時ログとの関係（§5.3）

`runtime/pass-stats.csv`（`POST /api/review/pass-stats` 経由、または将来のジョブ完了時追記）
に pass 単位の統計が残る。`score.mjs` は run 出力（findings/uncertain）を入力とするため、
CSV とは独立に再計算できる。両者を突き合わせることで incremental yield を観点別に追える。

## 実測結果（2026-08-03 整合性レビュー初回）

`review_engine=multipass` / `sectionWidth=25` / `overlap=3` で合成フィクスチャを実行した結果を
`runs/2026-08-03_consistency_sec25.json` に置いた。SEC_001=P1-25 / SEC_002=P23-26、23件の指摘。

| 指標 | 値 | 備考 |
|------|-----|------|
| recall（実質） | **18/29 = 62%** | score.mjs の機械値は 55.2%。差の2件は照合の都合（下記） |
| precision | **23/23 = 100%** | 誤検知ゼロ。全指摘が planted に対応 |
| 重複 | 5件 | 重ね合わせ区間 P23-25 の二重検出。dedupe 修正済み |

観点別 recall: numbers 9/9・names 2/2・structure 4/4（実質）・translation 3/12・spelling 0/1・grammar 0/1

**score.mjs が取りこぼす2件**（page一致＋quote部分一致という一次近似の限界。§10.4）:

- e14（減損の跨ぎ矛盾）… P.7 の「no impairment loss」を gold の位置とし、Copilot は
  相手方の P.22 を主たる箇所として報告した。跨ぎ指摘はどちらの側を page にしても正しい。
- e26（脚注番号 *3）… Copilot の quote が `*` を落として `Profit per share (Yen)3` になり、
  gold の `Profit per share (Yen) *3` と部分一致しなかった。

**見落とし11件の内訳**（すべて散文側）:

| 種類 | 件数 | 該当 |
|------|------|------|
| 訳語の揺れ・誤訳 | 5 | e06 our company group / e07 equity-method subsidiaries / e08 affiliated company / e09 revenue↔net sales / e23 Net assets の自己参照 |
| 日本語の省略の逐語訳 | 3 | e11 主語なし / e12 主語・目的語なし / e19「当該」の脱落 |
| 訳抜け | 1 | e05 臨時従業員の注記 |
| 単ページの綴り・文法 | 2 | e18 recieve / e32 The Company have |

数値・表・日付・固有名詞は取り切っている一方、**散文の言い回しに関する誤りが丸ごと残る**。
TARGET 25p + REF 31p を一度に渡すと表と数値の突き合わせに注意が向き、散文は流し読みになる。
訳語の揺れ・省略・綴り・文法は校正パケット（約10p・各行精読）側の観点passで拾う分担が妥当で、
整合性レビューは跨ぎ・数値・会計連動を担当する、という切り分けが実測で裏づけられた。

### この実測で見つかった gold 自体の欠陥（修正済み）

- REF の P.8 が「減損損失は計上していない」、P.23 が「減損損失1,200百万円を計上している」と
  **REF自身が矛盾**していた。「REFは正」という前提に反するので REF を注記側に合わせた。
- REF に英単語 `world` を混ぜた planted（旧 e10）は REF 側の欠陥だったので削除。
- 「正しい側」を planted に挙げていた2件（旧 e02 / 旧 e21）を削除。誤りは対になる e09 / e04 の側。

これにより planted は 32件 → 29件。
