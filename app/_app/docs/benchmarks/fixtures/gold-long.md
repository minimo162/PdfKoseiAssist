# 長尺フィクスチャ gold set（43件）

架空企業「株式会社アオイ精機 / Aoi Seiki Co., Ltd.」2026年3月期（第73期）。
TARGET(英訳) 139ページ / REF(日本語原文) 140ページ。
**REFは正**。誤りはすべて TARGET 側に埋め込んである。
日本語 p2 の【表紙】は英訳版に存在しないため、p3 以降は日英でページが1ずれる（誤りではない）。

内訳: drift 16件 / number 3件 / number-local 1件 / spelling 8件 / grammar 8件 / omission 7件

## 何を測るための文書か

| 問い | 使う誤り |
|------|----------|
| Q1 整合性レビューは何ページ幅が要るか | 距離統制ペア（drift 16件 / number 4件） |
| Q2 校正パケットは何ページ幅が要るか | 行レベル誤り（23件、6ページ間隔） |
| Q3 2つを分ける必要があるか | 同じ幅で両方の recall を見る |

**drift（訳語の揺れ）が距離の主計器**である。同じ日本語用語の英訳が2ページで食い違うだけで、
どちらの訳語も単独では正しく読める。つまり **1ページだけを REF と突き合わせても検出できない**。
両ページが同じセクションに入って初めて検出しうる。
生成時に「日本語用語は文書全体でちょうど2回」「各英訳語は1回」を検証しているので、
より近い別ページで気づけてしまうことはない。

**number（数値の食い違い）も距離の計器**である。こちらは
**原文と英訳の両方に同じ食い違い**を入れてある。先行ページは日英とも 17,400、
後続ページは日英とも 17,900。そのページだけを見れば日英は完全に一致しているので、
REF との突き合わせでは何も出ない。文書自身が2箇所で違うことを言っている矛盾だけが残る。
実務でも「原文の数値が古いまま残り、翻訳者は忠実に訳した」という形で普通に起きる。

> この3件だけは「REFは正」の前提から外れる（「誤りの側」列が「原文＋英訳」）。
> 整合性レビューのプロンプトは A: TARGET内部の跨ぎ整合 / B: REFとの照合 の二本立てで、
> これは **A の担当**である。どちらのページが正しいかは原理的に決まらないが、
> 採点は「矛盾を指摘したか」だけを見るので支障はない。

**number-local は対照群**（1件、距離20）。こちらは EN だけが誤りで REF はその数値を書いていないため、
ローカルでも「原文にない数値」として気づける余地がある。
**対照が取れて本体が取れないなら、モデルは跨ぎを見ておらずローカルなREF比較しかしていない**と分かる。

## 幅ごとの検出可能性（単純近似）

実際の分割規則（等幅＋重ね3ページ＋末尾畳み込み）で、
ペアの両ページが同じセクションに入るかを数えたもの。**これが理論上の上限**で、実測はこれを下回る。

| セクション幅 | セクション数 | 同一セクションに入る drift ペア | その距離 |
|---|---|---|---|
| 10 | 20 | 2/16 | 3 |
| 20 | 8 | 3/16 | 3, 10 |
| 25 | 6 | 5/16 | 3, 10, 20 |
| 30 | 5 | 4/16 | 3, 10 |
| 40 | 4 | 4/16 | 3, 20 |
| 50 | 3 | 6/16 | 3, 10, 20, 40 |
| 60 | 3 | 5/16 | 3, 10, 20 |
| 80 | 2 | 6/16 | 3, 10, 20, 40 |
| 100 | 2 | 9/16 | 3, 10, 20, 40, 60 |
| 139 | 1 | 16/16 | 3, 10, 20, 40, 60, 80, 100, 120 |

**幅を広げれば単調に増えるわけではない**（幅30が幅25より少ない）。
境界がどこに落ちるかで、距離の短いペアでも分断されるためである。
したがって実測の recall は、その幅で**原理的に到達可能な集合を分母に**読む必要がある。
その集合は `gold-long.json` の `reachability` にあり、次で分母を揃えられる。

```bash
node docs/benchmarks/score.mjs docs/benchmarks/fixtures/gold-long.json <run>.json --reachable 25 --by kind,distance
```

## 埋め込み一覧

| ID | TARGET頁 | 対の頁 | 距離 | 種類 | 誤りの側 | ローカル | 該当箇所 | 内容 |
|----|---------|-------|------|------|---------|---------|----------|------|
| L004 | 4 | — | — | spelling | 英訳のみ | ○ | `recieves regular external audits` | receives の綴り誤り（recieves） |
| L010 | 10 | — | — | grammar | 英訳のみ | ○ | `The Company have thoroughly complied` | 単数主語 The Company に対する動詞が have（主述不一致） |
| L016 | 16 | — | — | omission | 英訳のみ | ○ | `expected to materialize from the next consolidated f` | REF の「ただし、その時期及び金額は現時点で確定していない」が丸ごと訳抜け |
| L022 | 22 | — | — | spelling | 英訳のみ | ○ | `No serious product accidents occured` | occurred の綴り誤り（occured） |
| w003 | 24 | 21 | 3 | drift | 英訳のみ | × | `in-line inspection` | 「工程内検査」の英訳が p21 では in-process inspection、p24 では in-line inspection と揺れている |
| n005 | 25 | 20 | 5 | number | 原文＋英訳 | × | `Research and development expenses (17,900 million ye` | 研究開発費が p20 で 17,400、p25 で 17,900 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L028 | 28 | — | — | grammar | 英訳のみ | ○ | `The number of employees are expected` | The number of 〜 は単数扱い（are → is） |
| L034 | 34 | — | — | omission | 英訳のみ | ○ | `This amount is calculated based on a resolution` | REF の「なお、当該金額には消費税等は含まれていない」が訳抜け |
| w020b | 37 | 17 | 20 | drift | 英訳のみ | × | `service agreements` | 「保守契約」の英訳が p17 では maintenance contracts、p37 では service agreements と揺れている |
| L040 | 40 | — | — | spelling | 英訳のみ | ○ | `managed as a seperate reportable segment` | separate の綴り誤り（seperate） |
| w010 | 43 | 33 | 10 | drift | 英訳のみ | × | `key parts` | 「基幹部品」の英訳が p33 では core components、p43 では key parts と揺れている |
| L046 | 46 | — | — | grammar | 英訳のみ | ○ | `Each of the production bases have obtained` | Each of 〜 は単数扱い（have → has） |
| L052 | 52 | — | — | omission | 英訳のみ | ○ | `This policy was not changed during the current conso` | REF の「翌連結会計年度においても継続する予定である」が訳抜け |
| L058 | 58 | — | — | spelling | 英訳のみ | ○ | `Maintainance costs for production facilities` | Maintenance の綴り誤り（Maintainance） |
| w003b | 63 | 60 | 3 | drift | 英訳のみ | × | `incoming inspection` | 「受入検査」の英訳が p60 では acceptance inspection、p63 では incoming inspection と揺れている |
| L064 | 64 | — | — | grammar | 英訳のみ | ○ | `The Board of Directors have approved` | 機関としての Board は単数扱い（have → has） |
| w020 | 65 | 45 | 20 | drift | 英訳のみ | × | `cooperating suppliers` | 「協力会社」の英訳が p45 では partner companies、p65 では cooperating suppliers と揺れている |
| w040b | 69 | 29 | 40 | drift | 英訳のみ | × | `proactive servicing` | 「予防保全」の英訳が p29 では preventive maintenance、p69 では proactive servicing と揺れている |
| L070 | 70 | — | — | omission | 英訳のみ | ○ | `These transactions are conducted on ordinary trading` | REF の「当該取引に関する担保の提供はない」が訳抜け |
| n020x | 73 | 53 | 20 | number-local | 英訳のみ | ○ | `training hours of 35.2 hours referred to above` | 教育研修時間は p53 で 32.5。p73 の英訳だけが 35.2 と書いている（REF は数値を繰り返していない）。対照群 |
| L076 | 76 | — | — | spelling | 英訳のみ | ○ | `accomodate the increase in demand` | accommodate の綴り誤り（accomodate） |
| w010b | 81 | 71 | 10 | drift | 英訳のみ | × | `production yield` | 「歩留まり」の英訳が p71 では yield rate、p81 では production yield と揺れている |
| L082 | 82 | — | — | grammar | 英訳のみ | ○ | `This measures were implemented` | 指示語と名詞の数が不一致（This → These） |
| n030 | 87 | 57 | 30 | number | 原文＋英訳 | × | `Of the 1,680 patents held by the Group` | 特許保有件数が p57 で 1,860、p87 で 1,680 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L088 | 88 | — | — | omission | 英訳のみ | ○ | `These estimates are calculated based on past results` | REF の「将来の市場環境の変化により変動する可能性がある」が訳抜け |
| w040 | 91 | 51 | 40 | drift | 英訳のみ | × | `preservation plan` | 「保全計画」の英訳が p51 では maintenance program、p91 では preservation plan と揺れている |
| L094 | 94 | — | — | spelling | 英訳のみ | ○ | `taken the neccessary safety measures` | necessary の綴り誤り（neccessary） |
| w060 | 99 | 39 | 60 | drift | 英訳のみ | × | `succession of techniques` | 「技能伝承」の英訳が p39 では transfer of skills、p99 では succession of techniques と揺れている |
| L100 | 100 | — | — | grammar | 英訳のみ | ○ | `net sales in Asia has grown steadily` | net sales は複数扱い（has → have） |
| L106 | 106 | — | — | omission | 英訳のみ | ○ | `The term of this contract is five years` | REF の「当該契約に基づく支払は、四半期ごとに行われる」が訳抜け |
| w080 | 107 | 27 | 80 | drift | 英訳のみ | × | `equipment operating ratio` | 「設備稼働率」の英訳が p27 では facility utilization rate、p107 では equipment operating ratio と揺れている |
| w060b | 108 | 48 | 60 | drift | 英訳のみ | × | `cost saving initiatives` | 「原価低減活動」の英訳が p48 では cost reduction activities、p108 では cost saving initiatives と揺れている |
| L112 | 112 | — | — | spelling | 英訳のみ | ○ | `from the begining of the current consolidated fiscal` | beginning の綴り誤り（begining） |
| w100 | 115 | 15 | 100 | drift | 英訳のみ | × | `trial production assessment` | 「試作評価」の英訳が p15 では prototype evaluation、p115 では trial production assessment と揺れている |
| L118 | 118 | — | — | grammar | 英訳のみ | ○ | `There is no significant differences` | There is に複数名詞（is → are） |
| w080b | 121 | 41 | 80 | drift | 英訳のみ | × | `subcontracting expenses` | 「外注加工費」の英訳が p41 では outsourcing processing costs、p121 では subcontracting expenses と揺れている |
| n090 | 122 | 32 | 90 | number | 原文＋英訳 | × | `overseas net sales of 34.8%` | 海外売上高比率が p32 で 38.4、p122 で 34.8 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| w100b | 123 | 23 | 100 | drift | 英訳のみ | × | `energy conservation investment` | 「省エネルギー投資」の英訳が p23 では energy saving investment、p123 では energy conservation investment と揺れている |
| L124 | 124 | — | — | omission | 英訳のみ | ○ | `These figures are calculated based on internal manag` | REF の「これらの数値は、監査手続の対象外である」が訳抜け |
| w120b | 128 | 8 | 120 | drift | 英訳のみ | × | `tooling equipment` | 「治工具」の英訳が p8 では jigs and tools、p128 では tooling equipment と揺れている |
| w120 | 129 | 9 | 120 | drift | 英訳のみ | × | `buffer inventory` | 「安全在庫」の英訳が p9 では safety stock、p129 では buffer inventory と揺れている |
| L130 | 130 | — | — | spelling | 英訳のみ | ○ | `The department responsable for procurement` | responsible の綴り誤り（responsable） |
| L136 | 136 | — | — | grammar | 英訳のみ | ○ | `assessment was reviewed by the accounting department` | 主語は The results（複数）なので was → were |
