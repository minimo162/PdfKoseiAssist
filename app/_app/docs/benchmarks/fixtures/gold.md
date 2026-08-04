# 合成ベンチマーク gold set（30件）

架空企業「株式会社アオイ精機 / Aoi Seiki Co., Ltd.」2026年3月期（第73期）。
TARGET(英訳) 26ページ / REF(日本語原文) 27ページ。
**REFは正**。誤りはすべて TARGET 側に埋め込んである。
日本語 p2 の【表紙】は英訳版に存在しない（EDINET様式のため）ので、p3以降は日英でページが1ずれる。
これは誤りではなく、ページ対応ズレの再現である。

観点別内訳: numbers 9件 / translation 13件 / structure 4件 / spelling 1件 / names 2件 / grammar 1件

| ID | TARGET頁 | REF頁 | 観点 | 該当箇所 | 埋め込んだ誤りの内容 |
|----|---------|-------|------|----------|---------------------|
| e01 | 3 | 4 | numbers | `in March 1935` | REF「1953年3月に…設立」→ 1935 は日英不一致（設立年の誤り） |
| e03 | 4 | 5 | numbers | `459,921` | REF 売上高 458,921 → 459,921。かつ results/pl/segment の 458,921 と社内矛盾 |
| e04 | 4 | 5 | numbers | `54` | REF 1株当たり配当額 45円 → 54（桁入替）。dividend ページの 45 yen とも矛盾 |
| e05 | 4 | 5 | translation | `the number of persons at work.` | REF「臨時従業員は含まれていない」が英訳から脱落（訳抜け） |
| e06 | 5 | 6 | translation | `Our company group consists of` | 「当社グループ」の訳が the Group / Our company group で揺れる |
| e07 | 5 | 6 | translation | `3 equity-method subsidiaries` | 「持分法適用関連会社」の誤訳。associates であり subsidiaries ではない |
| e08 | 5 | 6 | translation | `The principal affiliated company is` | 「主要な連結子会社」→ affiliated company は誤訳（consolidated subsidiary） |
| e09 | 5 | 6 | translation | `revenue of this business increased 8.9%` | 「売上高」の訳が net sales / revenue で揺れる |
| e11 | 6 | 7 | translation | `Under these circumstances, improved significantly year on ye` | 日本語の主語省略「収益性は…改善した」を逐語訳し英語で主語不在（省略の顕在化漏れ） |
| e12 | 6 | 7 | translation | `Will continue to work on it going forward` | 主語・目的語が省略されたまま英訳され、誰が何に取り組むのか不明 |
| e13 | 7 | 8 | numbers | `The shareholders' equity ratio was 42.8%` | REF 42.3% → 42.8%。indicators 表の 42.3 とも社内矛盾 |
| e14 | 7 | 8 | structure | `no impairment loss on fixed assets was recorded` | REFは「減損損失1,200百万円を計上している」。英訳が逆の意味になっており、かつ notes1(P.22)の「an impairment loss of 1,200 million yen was recorded」と正面から矛盾する |
| e15 | 8 | 9 | structure | `(4) Results of Production` | REF は (3)。(2) の次が (4) になり項番が飛んでいる |
| e16 | 9 | 10 | numbers | `financing activities was 13,300 million yen` | REF 12,300 → 13,300。41,200 − 18,500 − 13,300 = 9,400 で「10,400増加」と会計的に不整合。cf-stmt 表の (12,300) とも矛盾 |
| e17 | 10 | 11 | translation | `fluctuations in foreign exchange rates may affect business r` | REF「為替予約等によりリスクの一部を軽減しているが、その全てを回避できるものではない」一文が丸ごと訳抜け |
| e18 | 11 | 12 | spelling | `recieve an annual assessment` | receive の綴り誤り（かつ主語 The Group に対し三単現不一致） |
| e19 | 11 | 12 | translation | `The effect is minor.` | 「当該影響は軽微である」の「当該」が省略されたまま訳出され、何の影響か不明 |
| e20 | 12 | 13 | structure | `Buildings and structures (Thousands of yen)` | REF は「百万円」。単位が Thousands of yen になっており桁が1000倍ずれる |
| e22 | 16 | 17 | translation | `Shareholders' equity at the end of the current consolidated ` | 「自己資本」の訳。bs-liab の注記では net assets と訳され別概念に化けている（訳語不統一） |
| e23 | 18 | 19 | translation | `(Note) Net assets is the amount obtained by deducting` | REF「自己資本は純資産合計から…控除した金額」→ Net assets と訳すと自己参照になり意味が壊れる |
| e24 | 19 | 20 | numbers | `Operating income 28,600 31,450` | REF 営業利益 32,450 → 31,450。results/segment/indicators の 32,450 と社内矛盾。売上総利益−販管費とも合わない |
| e25 | 21 | 22 | numbers | `68,291` | REF その他事業 68,921 → 68,291。210,000+180,000+68,291=458,291 で合計 458,921 と内訳が合わない |
| e26 | 23 | 24 | structure | `Profit per share (Yen) *3` | 脚注番号 *3 が本文に存在しない（REF は *2）。脚注参照の不整合 |
| e27 | 23 | 24 | translation | `there are no dilutive shares.` | REF「ただし、当連結会計年度末後に付与された株式報酬は含めていない。」の但し書きが訳抜け |
| e28 | 24 | 25 | numbers | `March 31, 2025` | REF 基準日 2026年3月31日 → March 31, 2025。表紙の期間とも矛盾 |
| e29 | 25 | 26 | names | `Aoi Seiki Tech Co., Ltd.` | history では Aoi Seiki Techno。同一子会社名の表記揺れ（REF は「アオイ精機テクノ」） |
| e30 | 25 | 26 | numbers | `was 3,241, an increase of 74` | REF 3,214人 → 3,241（桁入替）。indicators 表の 3,214 とも矛盾。3,140+74=3,214 で計算とも不整合 |
| e31 | 25 | 26 | names | `Kenzi Tanaka` | officers では Kenji Tanaka。同一人物名の表記揺れ |
| e33 | 12 | 13 | translation | `Employees` | REF の表頭「従業員数（人）」の単位「人」が英訳で欠落している（Employees (Persons) 等が要る） |
| e32 | 26 | 27 | grammar | `The Company have posted` | 主述不一致（The Company has） |

## 検出の難易度について

- **単ページで気づけるもの**（綴り・主述不一致・訳抜け・省略の逐語訳）は校正パケット（約10p）でも取れるはず。
- **跨ぎでしか気づけないもの**（e03/e04↔e21、e13、e14↔e24、e30、e29、e31）は
  整合性レビュー（セクション単位・現物添付）でないと原理的に検出できない。
- **会計連動でしか気づけないもの**（e16 の CF 合計、e25 の内訳合計、e24 の 売上総利益−販管費）は
  数値をただ突き合わせるだけでは出ず、勘定科目の関係を理解して初めて出る。
