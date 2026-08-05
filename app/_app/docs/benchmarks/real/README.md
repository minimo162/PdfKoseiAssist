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

## 読み方（gold が無い）

planted が無いので recall は出せない。**見るのは precision と、壊れ方**である。

- 指摘のうち、実際に文書がおかしいものが何件か（人が読んで判定する）
- マスカーが実文書の表で正しく動いているか（単位が行の見出しやキャプションにしかない表）
- 添付・文脈長・処理時間が合成フィクスチャと比べてどう変わるか

合成フィクスチャの数字（`../README.md`）とは**別物として記録すること**。分母が無いので混ぜられない。
