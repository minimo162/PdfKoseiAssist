# 長尺フィクスチャ gold set（112件）

架空企業「株式会社アオイ精機 / Aoi Seiki Co., Ltd.」2026年3月期（第73期）。
TARGET(英訳) 200ページ / REF(日本語原文) 201ページ。
**REFは正**。誤りはすべて TARGET 側に埋め込んである。
日本語 p2 の【表紙】は英訳版に存在しないため、p3 以降は日英でページが1ずれる（誤りではない）。

内訳: drift 8件 / number 24件 / number-local 2件 / num-tr 8件 / name-tr 5件 / supply 5件 / over 3件 / term 24件 / spelling 11件 / grammar 11件 / omission 11件

## 何を測るための文書か

| 問い | 使う誤り |
|------|----------|
| Q1 整合性レビューは何ページ幅が要るか | 距離統制ペア（drift 8件 / number 26件） |
| Q2 校正パケットは何ページ幅が要るか | 行レベル誤り（33件、6ページ間隔） |
| Q3 2つを分ける必要があるか | 同じ幅で両方の recall を見る |

**drift（訳語の揺れ）が距離の主計器**である。同じ日本語用語の英訳が2ページで食い違うだけで、
どちらの訳語も単独では正しく読める。つまり **1ページだけを REF と突き合わせても検出できない**。
両ページが同じセクションに入って初めて検出しうる。
生成時に「日本語用語は文書全体でちょうど2回」「各英訳語は1回」を検証しているので、
より近い別ページで気づけてしまうことはない。

**number（数値の食い違い）も距離の計器**である（24件・距離 5/15/30/50/70/90/110/130 × 各3件）。
こちらは**原文と英訳の両方に同じ食い違い**を入れてある。先行ページは日英とも 17,400、
後続ページは日英とも 17,900。そのページだけを見れば日英は完全に一致しているので、
REF との突き合わせでは何も出ない。文書自身が2箇所で違うことを言っている矛盾だけが残る。
実務でも「原文の数値が古いまま残り、翻訳者は忠実に訳した」という形で普通に起きる。

> number と number-local は「REFは正」の前提から外れる（「誤りの側」列が「原文＋英訳」）。
> 整合性レビューのプロンプトは A: TARGET内部の跨ぎ整合 / B: REFとの照合 の二本立てで、
> これは **A の担当**である。どちらのページが正しいかは原理的に決まらないが、
> 採点は「矛盾を指摘したか」だけを見るので支障はない。

**term（形式の揺れ）が、REFなしの整合性レビューにとっての主計器**である
（24件・距離 5/15/30/50/70/90/110/130 × 各3件）。
固有名詞・制度名・規程名が2箇所で違う表記になっている（`the AOI Quality Standard` と
`the AOI Quality Standards`、`the Nagoya Branch` と `the Nagoya Branch Office`）。
drift と違って**英語だけを読んでも同じものを指していると分かる**ので、原文が無くても判定できる。

> 会計連動（内訳の合計と総計の不一致）は**廃止した**。マスクした状態では記号を足すことになり、
> 原理的に成立しない（実測でも幅25/50/100/200 のすべてで 0/6 だった）。

**number-local は対照群**（2件、距離 20/75）。
こちらは EN だけが誤りで REF はその数値を書いていないため、
ローカルでも「原文にない数値」として気づける余地がある。
**対照が取れて本体が取れないなら、モデルは跨ぎを見ておらずローカルなREF比較しかしていない**と分かる。

## 幅ごとの検出可能性（単純近似）

実際の分割規則（等幅＋重ね3ページ＋末尾畳み込み）で、
ペアの両ページが同じセクションに入るかを数えたもの。**これが理論上の上限**で、実測はこれを下回る。

| セクション幅 | セクション数 | 届く term | 届く number | 届く drift | その距離 |
|---|---|---|---|---|---|
| 10 | 29 | 3/24 | 1/24 | 1/8 | 5 |
| 20 | 12 | 5/24 | 3/24 | 1/8 | 5, 15 |
| 25 | 9 | 6/24 | 6/24 | 3/8 | 5, 15 |
| 30 | 7 | 4/24 | 4/24 | 2/8 | 5, 15 |
| 40 | 5 | 5/24 | 6/24 | 2/8 | 5, 15 |
| 50 | 4 | 9/24 | 10/24 | 3/8 | 5, 15, 30, 50 |
| 60 | 4 | 7/24 | 6/24 | 2/8 | 5, 15, 30 |
| 80 | 3 | 8/24 | 8/24 | 3/8 | 5, 15, 30, 50 |
| 100 | 2 | 17/24 | 17/24 | 5/8 | 5, 15, 30, 50, 70, 90 |
| 120 | 2 | 12/24 | 12/24 | 7/8 | 5, 15, 30, 50, 70, 90 |
| 150 | 1 | 24/24 | 24/24 | 8/8 | 5, 15, 30, 50, 70, 90, 110, 130 |
| 200 | 1 | 24/24 | 24/24 | 8/8 | 5, 15, 30, 50, 70, 90, 110, 130 |

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
| t012 | 12 | — | — | num-tr | 英訳のみ | ○ | `research and development personnel for the current c` | REF 312人 → 321（桁の入れ替え） |
| L016 | 16 | — | — | omission | 英訳のみ | ○ | `expected to materialize from the next consolidated f` | REF の「ただし、その時期及び金額は現時点で確定していない」が丸ごと訳抜け |
| t019 | 19 | — | — | name-tr | 英訳のみ | ○ | `managed by Aoi Seiki Measurement Co., Ltd.` | 社名が誤り。正しくは Aoi Measurement Co., Ltd.（Seiki が混入） |
| L022 | 22 | — | — | spelling | 英訳のみ | ○ | `No serious product accidents occured` | occurred の綴り誤り（occured） |
| w003 | 24 | 21 | 3 | drift | 英訳のみ | × | `in-line inspection` | 「工程内検査」の英訳が p21 では in-process inspection、p24 では in-line inspection と揺れている |
| n005 | 25 | 20 | 5 | number | 原文＋英訳 | × | `Research and development expenses (17,900 million ye` | 研究開発費が p20 で 17,400、p25 で 17,900 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t026 | 26 | — | — | supply | 英訳のみ | ○ | `Improved significantly compared with the previous co` | 日本語が省いた主語（収益性）を補えておらず、英文に主語が無い |
| L028 | 28 | — | — | grammar | 英訳のみ | ○ | `The number of employees are expected` | The number of 〜 は単数扱い（are → is） |
| t031 | 31 | — | — | num-tr | 英訳のみ | ○ | `annual maintenance cost of this equipment is 48 thou` | REF「48百万円」→ 48 thousand yen（単位が千円になっている） |
| L034 | 34 | — | — | omission | 英訳のみ | ○ | `This amount is calculated based on a resolution` | REF の「なお、当該金額には消費税等は含まれていない」が訳抜け |
| m005 | 35 | 30 | 5 | term | 英訳のみ | × | `facilities at the Kawagoe Technology Center were upd` | 「川越技術センター」の表記が p30 では the Kawagoe Technical Center、p35 では the Kawagoe Technology Center と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L040 | 40 | — | — | spelling | 英訳のみ | ○ | `managed as a seperate reportable segment` | separate の綴り誤り（seperate） |
| w010 | 43 | 33 | 10 | drift | 英訳のみ | × | `key parts` | 「基幹部品」の英訳が p33 では core components、p43 では key parts と揺れている |
| t044 | 44 | — | — | over | 英訳のみ | ○ | `expected to be resolved within the next two quarters` | REF にない見通し（2四半期以内に解消）を英訳が付け加えている |
| L046 | 46 | — | — | grammar | 英訳のみ | ○ | `Each of the production bases have obtained` | Each of 〜 は単数扱い（have → has） |
| t047 | 47 | — | — | num-tr | 英訳のみ | ○ | `The total amount of this subsidy is 12 million yen` | REF「12億円」→ 12 million yen（正しくは 1.2 billion yen。桁が2つ違う） |
| m030 | 48 | 18 | 30 | term | 英訳のみ | × | `Operation of the Tohoku Distribution Center began` | 「東北物流センター」の表記が p18 では the Tohoku Logistics Center、p48 では the Tohoku Distribution Center と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L052 | 52 | — | — | omission | 英訳のみ | ○ | `This policy was not changed during the current conso` | REF の「翌連結会計年度においても継続する予定である」が訳抜け |
| n005b | 54 | 49 | 5 | number | 原文＋英訳 | × | `Of the 8,740 quality improvement proposals` | 品質改善提案件数が p49 で 8,470、p54 で 8,740 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t055 | 55 | — | — | name-tr | 英訳のみ | ○ | `located in Mito, Tochigi Prefecture` | REF「茨城県」→ Tochigi Prefecture（県名の誤り） |
| L058 | 58 | — | — | spelling | 英訳のみ | ○ | `Maintainance costs for production facilities` | Maintenance の綴り誤り（Maintainance） |
| n050 | 61 | 11 | 50 | number | 原文＋英訳 | × | `its 3,680 business partners` | 取引先の総数が p11 で 3,860、p61 で 3,680 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t062 | 62 | — | — | supply | 英訳のみ | ○ | `Will continue to work on it going forward.` | 日本語が省いた主語（当社グループ）を補えておらず、英文に主語が無い |
| L064 | 64 | — | — | grammar | 英訳のみ | ○ | `The Board of Directors have approved` | 機関としての Board は単数扱い（have → has） |
| w020 | 65 | 45 | 20 | drift | 英訳のみ | × | `cooperating suppliers` | 「協力会社」の英訳が p45 では partner companies、p65 では cooperating suppliers と揺れている |
| t068 | 68 | — | — | num-tr | 英訳のみ | ○ | `This basic agreement was concluded in 2016` | REF 2019年 → 2016（年の誤り） |
| L070 | 70 | — | — | omission | 英訳のみ | ○ | `These transactions are conducted on ordinary trading` | REF の「当該取引に関する担保の提供はない」が訳抜け |
| n020x | 73 | 53 | 20 | number-local | 英訳のみ | ○ | `training hours of 35.2 hours referred to above` | 教育研修時間は p53 で 32.5。p73 の英訳だけが 35.2 と書いている（REF は数値を繰り返していない）。対照群 |
| L076 | 76 | — | — | spelling | 英訳のみ | ○ | `accomodate the increase in demand` | accommodate の綴り誤り（accomodate） |
| m050 | 79 | 29 | 50 | term | 英訳のみ | × | `belong to the Sagamihara Research Institute` | 「相模原研究所」の表記が p29 では the Sagamihara Research Laboratory、p79 では the Sagamihara Research Institute と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n075x | 80 | 5 | 75 | number-local | 英訳のみ | ○ | `safety education of 16.8 hours referred to above` | 安全教育時間は p5 で 18.6。p80 の英訳だけが 16.8 と書いている（REF は数値を繰り返していない）。対照群 |
| L082 | 82 | — | — | grammar | 英訳のみ | ○ | `This measures were implemented` | 指示語と名詞の数が不一致（This → These） |
| n070 | 83 | 13 | 70 | number | 原文＋英訳 | × | `interest-bearing debt of 116,600 million yen` | 有利子負債残高が p13 で 161,600、p83 で 116,600 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t084 | 84 | — | — | name-tr | 英訳のみ | ○ | `Corporate Planning Department, PR Section` | REF「IR課」→ PR Section（部署名の誤り） |
| m015 | 86 | 71 | 15 | term | 英訳のみ | × | `The business results of Aoi Advanced Material Co., L` | 「株式会社アオイ先端材料」の表記が p71 では Aoi Advanced Materials Co., Ltd.、p86 では Aoi Advanced Material Co., Ltd. と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n030 | 87 | 57 | 30 | number | 原文＋英訳 | × | `Of the 1,680 patents held by the Group` | 特許保有件数が p57 で 1,860、p87 で 1,680 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L088 | 88 | — | — | omission | 英訳のみ | ○ | `These estimates are calculated based on past results` | REF の「将来の市場環境の変化により変動する可能性がある」が訳抜け |
| m030b | 89 | 59 | 30 | term | 英訳のみ | × | `The members of the Environment Conservation Committe` | 「環境保全委員会」の表記が p59 では the Environmental Conservation Committee、p89 では the Environment Conservation Committee と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| t090 | 90 | — | — | num-tr | 英訳のみ | ○ | `This adjustment item was 2,400 million yen` | REF は△（マイナス）だが英訳で符号が落ちている |
| w040 | 91 | 51 | 40 | drift | 英訳のみ | × | `preservation plan` | 「保全計画」の英訳が p51 では maintenance program、p91 では preservation plan と揺れている |
| m070 | 93 | 23 | 70 | term | 英訳のみ | × | `placed in the Manufacturing Engineering Division` | 「生産技術本部」の表記が p23 では the Production Engineering Division、p93 では the Manufacturing Engineering Division と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L094 | 94 | — | — | spelling | 英訳のみ | ○ | `taken the neccessary safety measures` | necessary の綴り誤り（neccessary） |
| n090b | 96 | 6 | 90 | number | 原文＋英訳 | × | `Orders received of 478,600 million yen` | 受注高が p6 で 476,800、p96 で 478,600 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t097 | 97 | — | — | supply | 英訳のみ | ○ | `Decides whether shipment is possible after consultat` | 日本語が省いた主語（出荷判定会議）を補えておらず、英文に主語が無い |
| m090 | 98 | 8 | 90 | term | 英訳のみ | × | `The Investment Council checks the progress of invest` | 「投資委員会」の表記が p8 では the Investment Committee、p98 では the Investment Council と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| w060 | 99 | 39 | 60 | drift | 英訳のみ | × | `succession of techniques` | 「技能伝承」の英訳が p39 では transfer of skills、p99 では succession of techniques と揺れている |
| L100 | 100 | — | — | grammar | 英訳のみ | ○ | `net sales in Asia has grown steadily` | net sales は複数扱い（has → have） |
| t105 | 105 | — | — | over | 英訳のみ | ○ | `based on the past three years of actual results` | REF にない根拠（過去3年の実績）を英訳が付け加えている |
| L106 | 106 | — | — | omission | 英訳のみ | ○ | `The term of this contract is five years` | REF の「当該契約に基づく支払は、四半期ごとに行われる」が訳抜け |
| w080 | 107 | 27 | 80 | drift | 英訳のみ | × | `equipment operating ratio` | 「設備稼働率」の英訳が p27 では facility utilization rate、p107 では equipment operating ratio と揺れている |
| L112 | 112 | — | — | spelling | 英訳のみ | ○ | `from the begining of the current consolidated fiscal` | beginning の綴り誤り（begining） |
| w100 | 115 | 15 | 100 | drift | 英訳のみ | × | `trial production assessment` | 「試作評価」の英訳が p15 では prototype evaluation、p115 では trial production assessment と揺れている |
| t117 | 117 | — | — | num-tr | 英訳のみ | ○ | `The recording rate of this provision is 4.9%` | REF 9.4% → 4.9%（数字の入れ替え） |
| L118 | 118 | — | — | grammar | 英訳のみ | ○ | `There is no significant differences` | There is に複数名詞（is → are） |
| n090 | 122 | 32 | 90 | number | 原文＋英訳 | × | `overseas net sales of 34.8%` | 海外売上高比率が p32 で 38.4、p122 で 34.8 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L124 | 124 | — | — | omission | 英訳のみ | ○ | `These figures are calculated based on internal manag` | REF の「これらの数値は、監査手続の対象外である」が訳抜け |
| t126 | 126 | — | — | name-tr | 英訳のみ | ○ | `scheduled to be held on June 16, 2026` | REF 6月26日 → June 16（日付の誤り） |
| m015b | 128 | 113 | 15 | term | 英訳のみ | × | `The renewal of the Integrated Production Control Sys` | 「統合生産管理システム」の表記が p113 では the Integrated Production Management System、p128 では the Integrated Production Control System と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| w120 | 129 | 9 | 120 | drift | 英訳のみ | × | `buffer inventory` | 「安全在庫」の英訳が p9 では safety stock、p129 では buffer inventory と揺れている |
| L130 | 130 | — | — | spelling | 英訳のみ | ○ | `The department responsable for procurement` | responsible の綴り誤り（responsable） |
| n030b | 132 | 102 | 30 | number | 原文＋英訳 | × | `total area of production bases of 248,500 square met` | 生産拠点の総面積が p102 で 284,500、p132 で 248,500 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t133 | 133 | — | — | supply | 英訳のみ | ○ | `Will be reviewed as necessary.` | 日本語が省いた主語（当該基準）を補えておらず、英文に主語が無い |
| n015 | 134 | 119 | 15 | number | 原文＋英訳 | × | `Of the 1,427 employees at overseas bases` | 海外拠点の従業員数が p119 で 1,247、p134 で 1,427 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L136 | 136 | — | — | grammar | 英訳のみ | ○ | `assessment was reviewed by the accounting department` | 主語は The results（複数）なので was → were |
| n130 | 137 | 7 | 130 | number | 原文＋英訳 | × | `water consumption of 512,900 cubic meters` | 水使用量が p7 で 512,400、p137 で 512,900 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| n005c | 140 | 135 | 5 | number | 原文＋英訳 | × | `The 12,840 units shipped` | 製品出荷台数が p135 で 12,480、p140 で 12,840 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m030c | 141 | 111 | 30 | term | 英訳のみ | × | `The number of contracts for the Smart Maintenance Se` | 「スマート保全サービス」の表記が p111 では the Smart Maintenance Service、p141 では the Smart Maintenance Services と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L142 | 142 | — | — | omission | 英訳のみ | ○ | `This system is applied to all domestic subsidiaries` | REF の「海外子会社への適用は検討中である」が訳抜け |
| t145 | 145 | — | — | num-tr | 英訳のみ | ○ | `The number of tests conducted for this item was 1,40` | REF 1,450件 → 1,405（桁の入れ替え） |
| m130 | 147 | 17 | 130 | term | 英訳のみ | × | `The certification as the Certified Health and Produc` | 「健康経営優良法人」の表記が p17 では the Certified Health & Productivity Management Organization、p147 では the Certified Health and Productivity Management Organization と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L148 | 148 | — | — | spelling | 英訳のみ | ○ | `aims to acheive further improvements` | achieve の綴り誤り（acheive） |
| m090c | 150 | 60 | 90 | term | 英訳のみ | × | `The staff of the Kyushu Branch Office was increased` | 「九州営業所」の表記が p60 では the Kyushu Sales Office、p150 では the Kyushu Branch Office と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| m110 | 151 | 41 | 110 | term | 英訳のみ | × | `achievement of the Environmental Goal 2035 is disclo` | 「環境目標2035」の表記が p41 では the Environmental Target 2035、p151 では the Environmental Goal 2035 と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n110 | 152 | 42 | 110 | number | 原文＋英訳 | × | `ratio of female employees of 27.1%` | 女性従業員比率が p42 で 21.7、p152 で 27.1 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L154 | 154 | — | — | grammar | 英訳のみ | ○ | `There was several inquiries` | There was に複数名詞（was → were） |
| m050b | 158 | 108 | 50 | term | 英訳のみ | × | `The Employee Inventions Regulations are revised` | 「職務発明規程」の表記が p108 では the Employee Invention Regulations、p158 では the Employee Inventions Regulations と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n050b | 159 | 109 | 50 | number | 原文＋英訳 | × | `Software assets of 7,460 million yen` | ソフトウェア資産が p109 で 7,640、p159 で 7,460 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L160 | 160 | — | — | omission | 英訳のみ | ○ | `These costs are recorded in selling, general and adm` | REF の「計上区分は四半期ごとに見直している」が訳抜け |
| m005b | 162 | 157 | 5 | term | 英訳のみ | × | `The AOI Quality Standards are reviewed once a year` | 「アオイ品質基準」の表記が p157 では the AOI Quality Standard、p162 では the AOI Quality Standards と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| t165 | 165 | — | — | num-tr | 英訳のみ | ○ | `The annual cost of this initiative is 230 billion ye` | REF「230百万円」→ 230 billion yen（単位が10億円になっている） |
| L166 | 166 | — | — | spelling | 英訳のみ | ○ | `the enviroment protection rules` | environment の綴り誤り（enviroment） |
| n130b | 168 | 38 | 130 | number | 原文＋英訳 | × | `its 1,380 principal customers` | 主要顧客数が p38 で 1,830、p168 で 1,380 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m005c | 169 | 164 | 5 | term | 英訳のみ | × | `The employees of the Koriyama Factory are mainly hir` | 「郡山工場」の表記が p164 では the Koriyama Plant、p169 では the Koriyama Factory と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n015b | 170 | 155 | 15 | number | 原文＋英訳 | × | `Of the 2,640 patent applications` | 特許出願件数が p155 で 2,460、p170 で 2,640 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m015c | 171 | 156 | 15 | term | 英訳のみ | × | `Reports made under the Whistle-blowing Regulations` | 「内部通報規程」の表記が p156 では the Whistleblowing Regulations、p171 では the Whistle-blowing Regulations と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L172 | 172 | — | — | grammar | 英訳のみ | ○ | `Each of the committees meet twice a year` | Each of 〜 は単数扱い（meet → meets） |
| n070b | 173 | 103 | 70 | number | 原文＋英訳 | × | `Of the 4,720 training participants` | 研修受講者数が p103 で 4,270、p173 で 4,720 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m070b | 174 | 104 | 70 | term | 英訳のみ | × | `grants from the Aoi Technical Foundation` | 「アオイ技術振興財団」の表記が p104 では the Aoi Technology Foundation、p174 では the Aoi Technical Foundation と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n030c | 176 | 146 | 30 | number | 原文＋英訳 | × | `electricity consumption of 67,320 megawatt-hours` | 電力使用量が p146 で 63,720、p176 で 67,320 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L178 | 178 | — | — | omission | 英訳のみ | ○ | `This equipment operates in accordance with the produ` | REF の「休止している設備はない」が訳抜け |
| m110b | 179 | 69 | 110 | term | 英訳のみ | × | `The participation rate in the Employee Stock Ownersh` | 「従業員持株制度」の表記が p69 では the Employee Stock Ownership Plan、p179 では the Employee Stock Ownership Program と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| m130b | 180 | 50 | 130 | term | 英訳のみ | × | `The scope of the Green Factory Program is all domest` | 「グリーンファクトリー計画」の表記が p50 では the Green Factory Plan、p180 では the Green Factory Program と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| t181 | 181 | — | — | name-tr | 英訳のみ | ○ | `located in Selangor, Malaysia` | REF「ペナン州」→ Selangor（州名の誤り） |
| n110b | 182 | 72 | 110 | number | 原文＋英訳 | × | `renewable energy ratio of 36.2%` | 再生可能エネルギー比率が p72 で 32.6、p182 で 36.2 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| L184 | 184 | — | — | spelling | 英訳のみ | ○ | `The evaluation method is consistant` | consistent の綴り誤り（consistant） |
| m110c | 185 | 75 | 110 | term | 英訳のみ | × | `Cases that received the AOI Kaizen Award` | 「アオイ改善大賞」の表記が p75 では the AOI Improvement Award、p185 では the AOI Kaizen Award と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n070c | 186 | 116 | 70 | number | 原文＋英訳 | × | `Of the 3,490 tons of industrial waste` | 産業廃棄物排出量が p116 で 3,940、p186 で 3,490 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| n110c | 187 | 77 | 110 | number | 原文＋英訳 | × | `average age of production facilities of 14.2 years` | 生産設備の平均経過年数が p77 で 12.4、p187 で 14.2 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m050c | 188 | 138 | 50 | term | 英訳のみ | × | `obtained the AOI Environment Certification` | 「アオイ環境認証」の表記が p138 では the AOI Environmental Certification、p188 では the AOI Environment Certification と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| t189 | 189 | — | — | supply | 英訳のみ | ○ | `Revises the development plan as necessary.` | 日本語が省いた主語（当社グループ）を補えておらず、英文に主語が無い |
| L190 | 190 | — | — | grammar | 英訳のみ | ○ | `The Group have been expanding` | The Group は単数扱い（have → has） |
| n090c | 191 | 101 | 90 | number | 原文＋英訳 | × | `Greenhouse gas emissions of 49,130 tons` | 温室効果ガス排出量が p101 で 41,930、p191 で 49,130 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m130c | 193 | 63 | 130 | term | 英訳のみ | × | `Orders for the Aoi Transfer Robot increased` | 「アオイ搬送ロボット」の表記が p63 では the Aoi Conveyance Robot、p193 では the Aoi Transfer Robot と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| n050c | 194 | 144 | 50 | number | 原文＋英訳 | × | `retirement benefit obligations of 51,280 million yen` | 退職給付債務が p144 で 52,180、p194 で 51,280 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| m070c | 195 | 125 | 70 | term | 英訳のみ | × | `The relocation of the Nagoya Branch Office` | 「名古屋支店」の表記が p125 では the Nagoya Branch、p195 では the Nagoya Branch Office と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
| L196 | 196 | — | — | omission | 英訳のみ | ○ | `These rules were established with the approval of th` | REF の「改正の際も同様の手続を経ている」が訳抜け |
| n130c | 197 | 67 | 130 | number | 原文＋英訳 | × | `Of the 9,510 orders received` | 受注件数が p67 で 9,150、p197 で 9,510 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| n015c | 198 | 183 | 15 | number | 原文＋英訳 | × | `investment in education and training of 1,920 millio` | 教育研修投資額が p183 で 1,290、p198 で 1,920 と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない |
| t199 | 199 | — | — | over | 英訳のみ | ○ | `the improvement is expected to continue for the next` | REF にない見通し（今後数年の継続）を英訳が付け加えている |
| m090b | 200 | 110 | 90 | term | 英訳のみ | × | `The successor model of the Aoi Precision Line` | 「アオイプレシジョンシリーズ」の表記が p110 では the Aoi Precision Series、p200 では the Aoi Precision Line と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範） |
