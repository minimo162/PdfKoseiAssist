# 複雑段組み処理仕様（layout-v2）

## 目的

PDF.js のテキスト item と座標から、人が読む順に近い本文ブロックを復元する。物理PDFページ番号は変更せず、見開き・段組み・表・欄外をページ内部の構造として扱う。

## 中間表現

`PDF page > pane > column/band > block > line > source item` の順で保持する。block/line は bbox、role、confidence、元item ID、出力文字位置を持つ。同じitemを複数blockへ複製しない。

## 読み順

1. 横長ページで、中央の継続的な空白、左右双方の十分な文字量、中央を跨ぐ文字の少なさが揃った時だけ見開きとして左右paneへ分ける。
2. 各paneで座標分布から最大2段を推定する。固定幅では分けない。
3. 全幅見出しを先に読み、その後は左段を完読して右段へ進む。表は段読みせず行優先にする。
4. 反復する上端・下端テキストは3ページ以上の文書passでrunning header/footerとmarkする。canonical textには残し、Copilot用textからだけ除く。
5. 縦書き、異常座標、中央を跨ぐ曖昧blockは本文へ混ぜず `order-uncertain` にする。
6. 横向き単字itemとして格納された日本語の縦見出しも、各字が独立行 (`hasEOL`) である同一X座標の3字以上のrunとして検出し、表の値行から隔離する。横書きの「日本」「北米」などは隔離しない。
7. 縦長ページで複数の表が同じ高さに並ぶ場合は、密な数値行bandを先に切り出す。左右それぞれに3行以上の「行ラベル＋数値」がある時だけ独立表とし、同じ行の期間列を左右へ分断しない。

## Fail-safe

- 判定不能時に全幅Y座標順へ戻さない。blockを分離したまま `LAYOUT_STATUS: UNCERTAIN_BLOCKS_ONLY` を出す。
- uncertainページでは別blockをつないだ文法・欠落・数値対応の指摘を禁止し、単一block内の一意quoteだけを許可する。
- PDF内の文字列からpane、role、物理ページ番号を生成しない。これらはアプリが座標から生成する。
- PDF本文の構造markerらしい行を先に `［PDF本文］` で無害化してから、アプリのblock markerを外側に付ける。監査CLIと製品は同じprojection関数を使う。
- 単位見出しと表が別blockになった場合は、同じ物理ページ内で表の意味family（金額・台数・株数）と一致すると証明できる時だけ、アプリ生成の `APP_TABLE_CONTEXT` を表へ付与する。件数や出現順、同じ数値というだけでは割り当てない。row-span抽出でラベル列と値行列が分かれた場合も、直前blockに同familyの単位付きラベルが3行以上あり、後続表にラベルの残らない純数値行が3行以上ある時だけ補完する。為替レートは金額と分離し、PDF本文中の同名markerは制御情報へ昇格させない。
- ページを跨ぐ本文や表は連結しない。物理ページ番号と既存のTARGET/CONTEXT境界を維持する。
- quoteはblockごとの索引で照合し、block境界を跨ぐ文字列へ旧テキスト索引でfallbackしない。

## 互換性

`reconstructTextContentByVisualLines()` と `visual-lines-v1` は互換用に維持する。製品sidecar、監査CLI、headless fixtureは `reconstructTextContentDetailed()` の `layout-v2` を使う。引用ハイライトはlayout-v2のsource item順を正とし、既存索引はlayout-v2を利用できないlegacy文書だけのfallbackにする。

raw itemは1ページ25,000件、文字は200万字を既定上限とし、超過時は例外や黙った成功にせずdegraded warningとuncertainを記録する。引用索引は96entryのLRUとし、TARGET/REFの交換時に全消去する。

欄外反復判定は署名1件2,048文字、文書走査512ページを上限とする。長文欄外は切り詰めて同一視せず判定対象外にし、長文書は先頭・末尾を含む決定的サンプルを製品と監査CLIで共有する。意味のある `Section 1/2/3` は数字を潰して反復header扱いしない。

## 受入基準

- 合成: 2段、見開き4段、全幅見出し、wide table、左右独立表、図形grid、反復header/footer、縦書きfail-safe、125,000 item入力上限。
- Mazda Integrated Report 2025: P4/P18/P42/P55は左右pane各2段を完読し、同じYの別段を同一行にしない。P9は中央を跨ぐ要素があってもpaneを保ちuncertain、P10の大表は単一table block、P30の図中文字はtable-or-figureとして本文から隔離する。
- Mazda短信: FY2026 JA P6の左右独立表を別blockにし、FY2027 Q1 JA P14の縦見出し断片を値行から隔離する。P4/P14の販売台数、P1/P17の百万円値は同じ記号を維持し、混在表の為替レートは倍率0のままにする。
- item欠落・重複0、入力item列挙順に依存しない、quoteから元item bboxへ戻せる。
- 401ページfixtureは10秒以内、抽出hashは同一入力で安定、Edge/profile/tempを残さない。

## 実PDF gold の取得元

- Mazda Integrated Report 2025 (English): `https://www.mazda.com/content/dam/mazda/corporate/mazda-com/en/pdf/investors/library/integrated-report/ir2025e_all.pdf`
- SHA-256: `3cfdf4d16522ad1aa636afa3731f49bb1918d98c042ded564d4d18a27869e72e`
- PDF本体と抽出JSONは機密・配布物混入防止のためgit管理しない。`Test-ComplexLayoutGold.mjs` はこのchecksumの抽出JSONがローカルにある時だけP4/P10/P30/P55の実物goldを追加検証する。
