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

### 実測（2026-08-06・推奨構成1回）

| | 結果 |
|---|---|
| planted の検出 | **4/7 = 57.1%** |
| 観点別 | number **2/2** / structure **2/2** / term **0/2** / structure-local **0/1** |
| 対照群（正しい値を再掲） | 指摘なし＝正しい |
| precision | **測れない**（下記） |

取れたもの: 桁の入れ替え（438,268 → 438,286 / 119,870 → 119,780）、
参照先の部番号違い（V. → VI.）、注記番号の使い回し（Note 21）。
取れなかったもの: 社名の表記揺れ2件（`Ltd.` → `Limited`、`Co., Ltd.` → `Company, Limited`）、
同一ページの項番の飛び（(1)(2)(4)）。**合成フィクスチャと同じ弱点が実物でも出た**
（term と structure-local が弱い）。

### precision は測れない。ただし「誤検知」は1件も無かった

planted 以外に4件の指摘が出た。gold は原本にもともと有る不整合を知らないので、
機械的には誤検知に数えられて precision 50% と表示されていた。**全部を原本と照合したところ、
4件とも実在の不整合だった。**

| 指摘 | 原本での確認 |
|---|---|
| 中国子会社の旧社名に `(China)` の有無が不統一 | p40「Ping An-Shionogi **(China)** Co., Ltd.」/ p7 は `(China)` なし |
| `Pharmaceutical Business` と `Pharmaceuticals Business` | p9 は複数形、セグメント表（p37）は単数形 |
| 労働組合名が2通り | p9 31行「SHIONOGI Worker's Union」/ 34行「the Shionogi Labor Union」 |
| `Co, Ltd.` のピリオド欠落 | p23 22行に `Co, Ltd.` と `Co., Ltd.` が**同じ行に並存** |

`gold-real.json` は `precision_measurable: false` を持ち、`score-runs.mjs` は precision を
「測れない」と表示する。**数字が独り歩きするより空欄のほうがよい。**

> なお原本のまま（誤りを埋めない版）を回したときは0指摘だった。同じ文書で、埋めた版では
> 上の4件を見つけている。**0指摘は「この文書に何も無い」ことを意味しない。**

### この素材の限界（正直に）

- 埋めた誤りは全部「末尾の補足ページ 対 原本」なので、**距離が長い側に偏る**。
- 補足ページの文体は原本ほど込み入っていない。実文書の表の中に埋まった誤りより易しい。
- したがって合成フィクスチャの代わりにはならない。**実物でも取れるかの下限**を見るためのもの。
- 合成フィクスチャの数字（`../README.md`）とは分母が違う。**混ぜないこと。**
