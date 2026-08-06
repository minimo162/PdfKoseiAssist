# 実物の開示書類での確認

合成フィクスチャ（`../fixtures/`）は素直すぎる。実文書の体裁で何が壊れるかを見るための置き場。
**PDF本体はコミットしない**（第三者の著作物）。取得元と手順だけをここに残す。

## 置いてあるもの（取得は各自）

| ファイル | 文書 | 出所 | ページ数 | サイズ |
|---|---|---|---|---|
| `shionogi_160th_en.pdf` | 塩野義製薬 第160期 有価証券報告書（英訳） | https://www.shionogi.com/content/dam/shionogi/global/investors/ir-library/annual-securities-report/Annual%20Securities%20Report%20160th.pdf | 167 | 5.36 MB |

取得:

```powershell
New-Item -ItemType Directory -Force -Path docs\benchmarks\real | Out-Null
Invoke-WebRequest -UseBasicParsing -OutFile docs\benchmarks\real\shionogi_160th_en.pdf `
  -Uri 'https://www.shionogi.com/content/dam/shionogi/global/investors/ir-library/annual-securities-report/Annual%20Securities%20Report%20160th.pdf'
```

## 走らせ方

日本語原文（REF）は持っていないので**比較資料なし**で回す。整合性レビューは元々REFを添付しないので、
これは製品の整合性モードそのままの条件になる。

```powershell
powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1 -Config rounds2 `
  -TargetPath /docs/benchmarks/real/shionogi_160th_en.pdf -NoReference
```

⚠️ `-ReferencePath ''` では駄目。`powershell -File` 経由だと空文字が引数として渡らず
「Missing an argument for parameter 'ReferencePath'」で落ちる。`-NoReference` を使うこと。

## 既知の誤りを埋めた版（推奨）

原本のままでは正解が無いので、**0指摘が正しいのか見つけられていないのかを判定できない**。
原本のページは1文字も変えずに、末尾へ「補足要約」ページを足し、そこに原本と食い違う文を置く。

```powershell
node docs\benchmarks\real\plant-real-errors.mjs                     # 埋めた版と gold-real.json を作る
node tools\Audit-DocumentMask.mjs docs\benchmarks\real\shionogi_160th_en_planted.pdf `
  --gold docs\benchmarks\real\gold-real.json                        # 引用が実在し一意か＋マスキング
powershell -ExecutionPolicy Bypass -File tools\Run-Benchmark.ps1 -Config rounds2 `
  -TargetPath /docs/benchmarks/real/shionogi_160th_en_planted.pdf -NoReference
node docs\benchmarks\score-runs.mjs --gold docs\benchmarks\real\gold-real.json `
  docs\benchmarks\runs\raw\<file>.json
```

⚠️ 原本のページに上書き（白い矩形＋新しい文字）をしてはいけない。元の文字列は内容ストリームに
残るので、抽出テキストには**両方**が出る。見た目だけ変わって、製品が読むテキストは壊れる。

### 実測（2026-08-06・推奨構成）

| 観点の指示 | planted の検出 | number | structure | term | structure-local |
|---|---|---|---|---|---|
| 判断基準なし | 4/7 = 57.1% | 2/2 | 2/2 | **0/2** | 0/1 |
| 判断基準（片側） | 5/7 = 71.4% | 2/2 | 1/2 | **2/2** | 0/1 |
| **判断基準（両方向）** | **7/7 = 100%（2回連続）** | 2/2 | 2/2 | 2/2 | 1/1 |

> ⚠️ **観点ごとの分母は 1〜2件しかない。** 「structure-local 0/1 → 1/1」は1件の当たり外れで、
> 観点別に何かを言える数字ではない。意味があるのは **7/7 が2回続いた**という全体のほうである。
> 合成フィクスチャ（分母70）と実物（分母7）は、精度がまるで違うことを忘れないこと。

対照群（正しい値を再掲した行）は、どちらも値の不一致としては報告されていない＝正しい。
precision は**測れない**（下記）。

**term が 0/2 → 2/2 になったのがこの素材の主な成果。** 埋めた2件は
`Ltd.` → `Limited`、`Co., Ltd.` → `Company, Limited` で、どちらも
「別の実体かもしれない」と読める言い換えである。合成フィクスチャの term 24件は
形の違い（複数形・記号の書き分け）に偏っていて**この型が少数派**なので、同じ変更を入れても
中央値は動かなかった（19 → 19）。**実物のほうが先に効果を見せた**（引き継ぎ書 §7.11）。

いまも取れないのは `structure-local`（同一ページの項番の飛び）。合成でも実物でも弱い。

### precision は測れない。ただし照合した範囲では「誤検知」は無かった

planted 以外にも指摘が出る。gold は原本にもともと有る不整合を知らないので、機械的には
誤検知に数えられる（表示上は precision 50% などになる）。**照合した範囲では全部が実在の不整合だった。**

判断基準を入れる前（4件）:

| 指摘 | 原本での確認 |
|---|---|
| 中国子会社の旧社名に `(China)` の有無が不統一 | p40「Ping An-Shionogi **(China)** Co., Ltd.」/ p7 は `(China)` なし |
| `Pharmaceutical Business` と `Pharmaceuticals Business` | p9 は複数形、セグメント表（p37）は単数形 |
| 労働組合名が2通り | p9 31行「SHIONOGI Worker's Union」/ 34行「the Shionogi Labor Union」 |
| `Co, Ltd.` のピリオド欠落 | p23 22行に `Co, Ltd.` と `Co., Ltd.` が**同じ行に並存** |

判断基準を入れた後（7件）。緩めた分だけ表記系が増えた。実質的な主張を1つ確認した:

| 指摘 | 原本での確認 |
|---|---|
| p52 の注記番号が重複 | 39〜42行が **`1. 2. 3. 2.`**（2が重複し、4が欠番） |

残りは `Act` / `act` の大文字小文字、`Research and Development` と `R&D` の混在、
`Medium-Term` / `Medium-term`、`Notes to` / `Notes on`、冠詞の有無など。
**校正の観点では拾いたいもの**だが、件数は増える。これが判断基準を緩めた代償である。

判断基準を両方向にした後（6件・2件）。**緩めたのに増えていない**（前は7件）。
ここでも実在の欠陥が見つかった:

| 指摘 | 原本での確認 |
|---|---|
| p149 の項番 (iii) が重複し (iv) が欠落 | 9〜10行が **`(iii) Capital` と `(iii) Acquiring company`**（(iv) が無い） |

他は `Act` / `act`、`Medium-Term Business Plan` の大文字、`SHIONOGI Group` の大文字、
`STS2030 Revision` の計画名、`Statement` / `Statements`、`Notes on` / `Notes to`、
適用法令の条番号の不一致。

`gold-real.json` は `precision_measurable: false` を持ち、`score-runs.mjs` は precision を
「測れない」と表示する。**数字が独り歩きするより空欄のほうがよい。**

> なお原本のまま（誤りを埋めない版）を回したときは0指摘だった。同じ文書で、埋めた版では
> 上の4件を見つけている。**0指摘は「この文書に何も無い」ことを意味しない。**

### ⚠️ 埋める誤りは**複数ページに散らすこと**（2026-08-06）

16件を1ページに詰め込んだら、同じ構成の2回が **14/14 と 1/14** に割れた。
機械的な失敗ではなく、2回目はモデルの注意が原本側に向いて補足ページをほぼ見なかっただけである。
**全部が1ページにあると「そのページを見たか否か」で全滅か満点になり、1回の run では何も言えない。**

3件ずつ6ページに散らしたら、そうならなくなった。

| 素材 | 結果 |
|---|---|
| 1ページ集中 | 14/14 と **1/14**（両極） |
| **3件×6ページ** | **11/14・13/14・14/14**（中央値 92.9%） |

観点別（3回）: number **5/5 が3回とも** / structure **3/3 が3回とも** /
term 4/4・4/4・2/4 / structure-local 1/2・2/2・1/2。
原本側の指摘は 4・4・6件で安定しており、`p52` の注記番号重複や `p149` の項番重複を含む。

`ITEMS_PER_PAGE` で1ページあたりの件数を変えられる。**増やすと連動しやすくなる。**

### この素材の限界（正直に）

- 埋めた誤りは全部「末尾の補足ページ 対 原本」なので、**距離が長い側に偏る**。
- 補足ページの文体は原本ほど込み入っていない。実文書の表の中に埋まった誤りより易しい。
- したがって合成フィクスチャの代わりにはならない。**実物でも取れるかの下限**を見るためのもの。
- 合成フィクスチャの数字（`../README.md`）とは分母が違う。**混ぜないこと。**
