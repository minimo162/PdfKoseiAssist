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

## 実測結果（2026-08-03 2回目 / 分担実装後）

`runs/2026-08-03_consistency_sec25_split.json`。同じフィクスチャ・同じ分割（25/3）で再実行。

| 指標 | 1回目 | 2回目 |
|------|-------|-------|
| recall（実質） | 18/29 = 62% | **19/29 = 66%** |
| precision | 23/23 = 100% | **20/20 = 100%** |
| カード | 23件（重複5） | 22件（生26 → dedupe後22。重複2組が残存） |
| 所要 | 122.0秒 | 138.2秒 |

新たに取れたもの:

- **e05**（臨時従業員の注記が訳抜け）… プロンプトを訳抜けに寄せた効果。
- **#13 セグメント利益 32,450 ⇄ 損益計算書 31,450**（`accounting_inconsistency`）…
  注記「セグメント利益は営業利益と一致」を手がかりに会計連動で矛盾を指摘した新しい型。
  e24 と同じ誤りを別の側から捉えており、修正案も P.19 側を直せと正しく言っている。

**取れなかったもの（1回目から変化なし）**: e06/e07/e08/e09/e23（訳語の揺れ・誤訳）、
e11/e12/e19（日本語の省略の逐語訳）。分担で追加した wording / ellipsis が狙っていた層が
まったく動いていない。P.5・P.6・P.11 は2回とも指摘ゼロ。

> ⚠️ **このrunでは観点passが一度も走っていなかった**（`review_engine=legacy` で実行。実機で確認済み）。
> `legacy` では multipass ブロックが丸ごとスキップされ broad 1passのみになる。
> つまり1回目・2回目とも **broad だけの測定**であり、分担（wording / ellipsis）の効果は未評価。
> 2回目の改善（e05・会計連動）はプロンプト改訂だけによるもの。
>
> 対策: 整合性レビュー（`kind=consistency`）は観点passを前提とする新機能なので、
> `review_engine` の設定に関わらず **PS側で multipass を強制**するようにした
> （校正パケットは従来どおり flag に従う＝既定 legacy で v94 と同一挙動, K34）。
> あわせて、それでも観点passが記録されていない場合はカードに警告を出す。

残った重複2組（`Profit per share (Yen)3` ⇄ `(Yen)*3`、`2 Diluted...` ⇄ `*2 Diluted...`）は
脚注記号の有無だけの差だったため、同一箇所の判定で脚注記号を無視するよう修正済み。
数値・句読点は潰さない（それ自体が指摘対象になりうるため）。

## 実測結果（2026-08-04 3回目 / 観点passが実際に走った初回）

`runs/2026-08-04_consistency_sec25_multipass.json`。`kind=consistency` で multipass を強制した後の初回。
**SEC_001（P1-25）のみ**。SEC_002（P23-26）は応答待機のまま中止したため未計測。

| | 1回目 | 2回目 | **3回目** |
|---|---|---|---|
| 観点pass | 走っていない | 走っていない | **broad→wording→ellipsis→gap** |
| recall（実質） | 18/29 = 62% | 19/29 = 66% | **26/29 = 90%** |
| precision | 100% | 100% | **27/28 = 96%** |
| 指摘 | 23件 | 22件 | 29件（SEC_001のみ） |

pass別の歩留まり: **全体 19 / 訳語の揺れ 4 / 日本語の省略 3 / 見落とし探し 3**。
追撃passが 10件を上乗せし、そのうち **7件が新規のgold検出**。

**分担で新たに取れたもの（2回とも取れなかった層）**:

| gold | 内容 | 取った pass |
|------|------|-------------|
| e06 | `Our company group` ⇄ `The Group`（訳語の揺れ） | wording |
| e08 | `The principal affiliated company`（連結子会社の誤訳） | wording |
| e09 | `revenue` ⇄ `net sales`（売上高の訳し分け） | wording |
| e23 | `(Note) Net assets is...`（自己資本を Net assets と訳し自己参照になる） | wording |
| e11 | `Under these circumstances, improved...`（主語「収益性」の脱落） | ellipsis |
| e12 | `Will continue to work on it...`（主語・目的語の脱落） | ellipsis |
| e19 | `The effect is minor.`（「当該」が消え何の影響か不明） | ellipsis |

ellipsis は修正案まで正しい（「主語を The Group、取組対象を its efforts to realize management that is
conscious of the cost of capital として明示する」）。**分担は機能している。**

### 残った見落とし（3件）

- **e07** `3 equity-method subsidiaries`（持分法適用関連会社を subsidiaries と誤訳。正しくは associates）
  … 揺れではなく**誤訳**なので `translation` 観点の担当。consistency プロファイルには入れていない。
  なお score.mjs では e07 が「検出」と出るが、これは card #8（当社グループの揺れ）の quote が
  同じ行を含んだための一致であり、誤訳自体は指摘されていない。
- **e18** `recieve`（綴り）… 設計上 consistency の担当外。校正パケット側の spelling pass。
- **e32** `The Company have posted`（P.26）… SEC_002 が完走しなかったため未測定。

### score.mjs の照合限界（2件、いずれも実際には検出できている）

- e14（減損の跨ぎ矛盾）… gold は P.7、Copilot は相手方の P.22 を主たる箇所として報告。
- e26（脚注番号 *3）… Copilot の quote が `*` を落とし、gold の `(Yen) *3` と部分一致しなかった。

### 唯一の誤検知（#1）

P.1 に対する「REF の【表紙】記載事項一式が英訳に無い」。EDINET様式の【表紙】は英訳版で省くのが
通例なので gold では非誤りとしているが、**指摘としては妥当**（実務では判断材料になる）。
ハルシネーションではない。

### SEC_002 の停止と、末尾セクションの見直し

SEC_002（P23-26、4ページ）が応答待機181秒・受信496文字で進まず中止した。
そもそも 26ページを width25/overlap3 で割ると 4ページだけの SEC_002 ができ、
往復が1回増えるうえ重ね合わせ区間 P23-25 で同じ誤りが二重に出る（1・2回目の重複の原因）。
`computeSections` に **末尾の極小セクションを前へ畳む**規則を追加した（既定は幅の40%未満）。
26ページなら 1セクション（1-26）で済み、往復も重複も発生しない。

## 実測結果（2026-08-04 4回目 / 1セクション化後）

`runs/2026-08-04_consistency_1section.json`。末尾セクションの畳み込みにより **P1-26 の1セクション**で完走。
所要 94.2秒（3回目は SEC_001 だけで101.4秒＋SEC_002が停止）。**停滞は再現せず。**

| | 3回目(P1-25) | 4回目(P1-26) |
|---|---|---|
| recall（実質） | 26/29 = 90% | **24/29 = 83%** |
| precision | 27/28 = 96% | **25/26 = 96%** |
| 生の指摘 | 29件 | **47件** |
| カード（dedupe後） | 29件 | **26件** |
| pass別 | 20/4/3/3 | **20/4/3/20** |

### 単発runの振れは実在する（§2.2 は複数runの中央値で判定する）

4回目で落ちたのは **e05**（臨時従業員の注記が訳抜け）と **e23**（自己資本を Net assets と訳し自己参照化）。
どちらも3回目では取れていた。逆に増えたものは無い。プロンプト・分割以外の条件は同じで、
**Copilot 側の揺れ**とみるのが妥当。broad のみの2回（62%・66%）とは明確な差があり、
分担の効果は揺れの幅を超えている。

### gap pass が既出の再掲になっている

4回目の pass別は broad 20 / wording 4 / ellipsis 3 / **gap 20**。生47件が dedupe 後26カードになった、
つまり **21件が重複**で、その大半は gap の再掲。3回目の gap は3件（うち新規あり）だったのに対し、
4回目の gap は新規をほぼ生んでいない。`Get-KoseiPriorFindingsDigest` で既出を渡しているが、
抑止が効いていない。往復1回分のコストに見合っているか、runを重ねて確認する必要がある。

dedupe が21件を吸収して26カードに収めているので、利用者への表示は破綻していない。

### 両方のrunで取れていないもの

| gold | 内容 | 扱い |
|------|------|------|
| e07 | 持分法適用関連会社を subsidiaries と誤訳 | `translation` 観点の担当。consistency には入れていない |
| e18 | `recieve`（綴り） | 設計上、校正パケット側 spelling pass の担当 |
| e32 | `The Company have posted`（文法） | 同上 grammar pass の担当。1セクション化で範囲には入った |
| e14 / e26 | 検出できているが score.mjs の照合が外れる | e14 は相手方ページに、e26 は quote から `*` が落ちる |

残る真の穴は e07 だけで、e18/e32 は校正パケット側で拾う設計。
**整合性レビュー単体の実力は 83〜90%** とみてよい。

## 3run の突き合わせ（2026-08-04）

観点passが実際に走った3回。3回目のみ P1-25、4・5回目は1セクション化後の P1-26。

| | 3回目 | 4回目 | 5回目 | 中央値 |
|---|---|---|---|---|
| recall（実質） | 26/29 = 90% | 24/29 = 83% | 24/29 = 83% | **24/29 = 83%** |
| precision | 96% | 96% | 96% | **96%** |
| 生の指摘 | 29 | 47 | 43 | — |
| カード（dedupe後） | 29 | 26 | 31 | — |
| pass別 | 20/4/3/**3** | 20/4/3/**20** | 18/4/3/**18** | — |
| 所要 | 101.4秒 | 94.2秒 | 77.2秒 | — |

`e18`（綴り）と `e32`（文法）は設計上 consistency の担当外なので、
**担当範囲だけで見れば 24/27 = 89%**。

### 揺れではなく傾向だったもの: 注記の見落とし

`e05`（P.4 の（注）2「臨時従業員は含まれていない」の訳抜け）と
`e23`（P.18 の（注）「自己資本」を Net assets と訳して自己参照化）は、
**3回目だけ検出、4・5回目は連続で未検出**。どちらも **注記（(注)行）** である点が共通する。
broad は本文と表の数値に注意が向き、wording / ellipsis は散文を見るため、
注記の小さい文字が3passとも手薄になる。

3回目で取れたのは gap pass が3件出したときで、4・5回目の gap は18〜20件すべて既出の再掲だった。
**gap の新規歩留まりが 3件 → 0件 → 0件** と落ちており、注記の穴と gap の失速が連動している。

対策として gap の追撃文を次のように変えた（効果は次回以降のrunで測る）:

- 既出一覧を「**報告禁止**リスト」として提示し、出力前に page/quote の重複を1件ずつ自己点検させる
- 本文・表の数値は見終わっている前提を明示し、**注記・脚注・(注)行・表の但し書き・単位の説明**を名指しで指示
- 0件が正しい答えになりうると明示（無理に絞り出させない）

### 引用の切り取り幅違いによる重複（5組）

5回目で、同じ誤りに対して一方が他方の一部になる引用が5組出た。

| ページ | 例 |
|---|---|
| P.3 | `…for the purpose of manufacturing` ⇄ `…for the purpose of manufacturing and selling precision components.` |
| P.11 | `The effect is minor.` ⇄ `In addition, no serious quality problems… The effect is minor.` |
| P.12 | `Buildings and structures (Thousands of yen)` ⇄ `…(Thousands of yen) Machinery (Thousands of yen)` |
| P.16 | `…was 247,510 million yen` ⇄ `…was 247,510 million yen, an increase of 18,610 million yen…` |
| P.25 | `…was 3,241, an increase` ⇄ `…was 3,241, an increase of 74 from…` |

同一ページで一方が他方を含む場合も同一箇所とみなすよう dedupe を拡張した。
短い引用は無関係な文にも含まれてしまうため、**短いほうが12文字以上のときだけ**適用する。
これで5回目の31カードは26カードになる。

## 実測結果（2026-08-04 6回目 / gap強化＋引用包含dedupe 後）

`runs/2026-08-04_consistency_gap_v2.json`。1セクション（P1-26）。

| | 4回目 | 5回目 | **6回目** |
|---|---|---|---|
| recall（実質） | 24/29 = 83% | 24/29 = 83% | **25/29 = 86%** |
| precision | 96% | 96% | **25/25 = 100%** |
| 生の指摘 | 47 | 43 | **28** |
| カード | 26 | 31 | **25** |
| pass別 gap | 20 | 18 | **2** |
| 所要 | 94.2秒 | 77.2秒 | **69.1秒** |

**予測どおりの結果になった。**

- **gap が 18件 → 2件**。既出の再掲がほぼ消え、指摘の総量が 43 → 28 に落ちた。
- **e05**（P.4 の（注）2「臨時従業員は含まれていない」訳抜け）と
  **e23**（P.18 の（注）「自己資本」を Net assets と訳して自己参照化）が**両方とも復帰**。
  gap の追撃文で注記・脚注・(注)行を名指ししたことが効いている。
- **誤検知ゼロ**。4・5回目にあった「REF の【表紙】が英訳に無い」（gold では非誤り）も出なくなった。
- **重複がほぼ消滅**（生28 → 25カード）。引用包含の統合が効いている。
- **69.1秒で最速**。無駄な再掲が減った分そのまま速くなった。

### 残る穴

| gold | 内容 | 状況 |
|------|------|------|
| e06 | `Our company group` ⇄ `The Group` | 3・4・5回目は検出、6回目のみ未検出（run間で揺れる） |
| e07 | 持分法適用関連会社を subsidiaries と誤訳 | 全runで未検出。`translation` 観点の担当で consistency には入れていない |
| e18 | `recieve`（綴り） | 設計上、校正パケット側 spelling pass の担当 |
| e32 | `The Company have posted`（文法） | 同上 grammar pass の担当 |

`e18` / `e32` を除いた担当範囲では **25/27 = 93%**。

> `e14`（減損の跨ぎ矛盾）と `e26`（脚注番号 *3）は全runで score.mjs の照合が外れるが、
> 実際には毎回検出できている（e14 は相手方ページに、e26 は quote から `*` が落ちるため）。
> 上表の「実質」はこの2件を戻した値。

## 校正パケット側の初測定（2026-08-04 / thorough）

`runs/2026-08-04_proofread_thorough.json`。26ページ→3パケット（P1-10 / P11-20 / P21-26）、
22カード、175.5秒。**誤検知ゼロ（22/22 = 100%）**。

| | 整合性レビュー | 校正パケット |
|---|---|---|
| recall（実質） | **25/29 = 86%** | **22/29 = 76%** |
| precision | 100% | 100% |
| 所要 | **69.1秒** | 175.5秒 |
| 単位 | 1セクション26p | 3パケット×10p |

### 相補性が実証された（和集合 27/29 = 93%）

**校正パケットだけが取ったもの（整合性が取れない層）**

| gold | 内容 | なぜ整合性で取れないか |
|------|------|----------------------|
| e18 | `recieve`（綴り） | 各行精読が要る。26p一括では文字単位まで見ない |
| e32 | `The Company have posted`（主述不一致） | 同上 |

**整合性レビューだけが取ったもの（パケットが取れない層）**

| gold | 内容 | なぜパケットで取れないか |
|------|------|------------------------|
| e29 | `Aoi Seiki Tech`（P.25）⇄ `Techno`（P.3） | **パケット1と3に分かれる。原理的に不可能** |
| e14 | P.7「減損なし」⇄ P.22「減損1,200計上」 | **同上。10p単位では跨げない** |
| e08 | `The principal affiliated company`（連結子会社の誤訳） | 訳語の揺れ。`wording` 観点 |
| e09 | `revenue` ⇄ `net sales` | 同上 |
| e19 | `The effect is minor.`（「当該」の脱落） | `ellipsis` 観点 |

**跨ぎ2件（e14 / e29）が予測どおり分かれた。** 10ページ単位に切った時点で
「P.3 の Techno と P.25 の Tech が違う」は物理的に見えない。逆に綴り・文法は
26ページを一度に見る整合性レビューでは埋もれる。**両者は代替ではなく補完**である。

### 唯一の真の穴

`e07`（持分法適用関連会社を `equity-method subsidiaries` と誤訳。正しくは associates）は
**両者とも、全runを通して一度も検出していない**。「揺れ」ではなく単独の誤訳なので、
整合性の `wording` でも、パケットの `translation` でも拾えていない。
`e06`（`Our company group`）は整合性の3・4・5回目で検出しており、run間で揺れる。

> ⚠️ **この測定は thorough ではなく broad 1pass だった**（`settings.json` の構文エラーにより
> 既定値 `review_engine=legacy` / `review_profile_batch=quick` で動作していた）。
> したがって **22/29 は校正パケット側の下限値**であり、thorough での実力は未測定。
> 原因: `"review_max_passes": 10` の行末にカンマが無く JSON として壊れていた。
> PS 側は読み込み失敗時に既定値へ黙って戻る作りで、警告はログファイルにしか出ていなかった。
> 対策として settings.json の読み込み失敗を `/api/ready-state` 経由で画面に赤帯表示するようにした。
>
> （旧メモ）
> 175.5秒 ÷ 3パケット ≒ 58秒/パケットで、10passなら1ターン6秒となり速すぎる。
> `review_engine` が `legacy` のままなら broad 1passのみで、この 22/29 は**下限値**になる
> （`wording` / `ellipsis` が走れば e06 / e08 / e09 / e19 が拾える可能性がある）。
> 校正パケットは K34 のため multipass を強制していないので、設定の確認が必要。
