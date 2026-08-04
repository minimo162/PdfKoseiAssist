// long-fixture-content.mjs — 幅（ページ数）を決めるための長尺フィクスチャ（約130ページ）
//
// 目的は3つの問いに答えること:
//   Q1 整合性レビューは何ページ幅が必要か
//   Q2 校正パケットは何ページ幅が必要か
//   Q3 そもそも2つを分ける必要があるか
//
// そのために3種類の誤りを、**性質を分けて**埋め込む。
//
// 1) 距離統制ペア＝訳語の揺れ（DRIFT_PAIRS）: 距離 3/10/20/40/60/80/100/120 ページ × 各2件
//    Q1 の主計器。同じ日本語の用語が離れた2ページに出て、英訳が anchor 側と error 側で違う。
//    **どちらの訳語も単独では正しく読める**ので、片方のページだけ見ても、
//    そのページの REF と突き合わせても、誤りだと分からない。
//    2ページを同時に見て初めて「揺れている」と分かる。
//    → 距離 d のペアは、両ページを含むセクション（幅 d 超）でしか原理的に検出できない。
//    これがないと10ページ幅でも拾えてしまい、距離の実験にならない。
//
// 2) 距離統制ペア＝数値の食い違い（NUMBER_PAIRS）: 距離 5/30/90 ページ
//    **原文と英訳の両方に同じ食い違いを入れる**。先行ページは JA/EN とも 17,400、
//    後続ページは JA/EN とも 17,900。そのページだけを見れば日英は完全に一致しているので、
//    REF との突き合わせでは何も出ない。文書自身が2箇所で違うことを言っている矛盾だけが残る。
//    → 1) と同じく純粋な距離の計器。「原文の数値が古いまま残り、翻訳者は忠実に訳した」形。
//    別に対照群を1件（距離20）だけ置く。そちらは EN だけが誤りでローカルでも気づける。
//    対照が取れて本体が取れないなら、モデルは跨ぎを見ずローカルなREF比較だけをしている。
//
// 3) 行レベル誤り（LINE_ERRORS）: 6ページ間隔で全編に分散
//    綴り・主述不一致・訳抜けを巡回配置。ローカルに見れば必ず分かる種類。
//    → 幅を広げたときに「各行精読」がどこまで劣化するかの測定（Q2）に使う。
//    同じ文面を繰り返すと「複数ページで同じ誤り」と1件にまとめられて件数が測れないため、
//    **1件ごとに文面を変えてある**。
//
// 純データ。決定的（擬似乱数は固定シード）なので、何度生成しても同じ文書になる。

// ---- 決定的な擬似乱数（再現性のため。Math.random は使わない） ----
let seed = 20260804;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = arr => arr[Math.floor(rnd() * arr.length) % arr.length];
const num = (min, max, step = 1) => Math.round((min + rnd() * (max - min)) / step) * step;
const money = (min, max) => num(min, max, 100).toLocaleString("en-US");

export const DOC = {
  companyJa: "株式会社アオイ精機",
  companyEn: "Aoi Seiki Co., Ltd.",
  fiscalJa: "2026年3月期（第73期）",
  fiscalEn: "Fiscal Year Ended March 31, 2026 (73rd Term)",
};

// 売上高の合計 = 連結売上高 458,921、セグメント利益の合計 = 営業利益 32,450。
// ここが合っていないと、会計連動の観点で毎回「合計が一致しない」と正しく指摘され、
// gold に無いぶん誤検知として数えられてしまう（実測で2件出た）。
const SEGMENTS = [
  { ja: "産業機械事業", en: "Industrial Machinery",     sales: 38500,  profit: 2300 },
  { ja: "精密機器事業", en: "Precision Equipment",      sales: 52300,  profit: 3400 },
  { ja: "電子部品事業", en: "Electronic Components",    sales: 68900,  profit: 4900 },
  { ja: "計測制御事業", en: "Measurement and Control",  sales: 81200,  profit: 5800 },
  { ja: "素材事業",     en: "Materials",                sales: 98400,  profit: 7150 },
  { ja: "サービス事業", en: "Services",                 sales: 119621, profit: 8900 },
];

const RISKS = [
  ["景気変動", "Economic Fluctuations", "顧客の設備投資動向", "trends in customers' capital investment"],
  ["為替変動", "Foreign Exchange", "海外売上高比率の高さ", "the high ratio of overseas net sales"],
  ["原材料価格", "Raw Material Prices", "鋼材及び電子部品の価格", "prices of steel and electronic components"],
  ["特定顧客への依存", "Dependence on Specific Customers", "上位顧客の購買方針", "the purchasing policies of major customers"],
  ["情報セキュリティ", "Information Security", "サイバー攻撃による生産停止", "production stoppages caused by cyber attacks"],
  ["品質", "Quality", "製品の重大な欠陥", "serious defects in products"],
  ["知的財産", "Intellectual Property", "第三者との権利関係", "rights disputes with third parties"],
  ["人材確保", "Securing Human Resources", "技術者の採用と定着", "recruitment and retention of engineers"],
  ["自然災害", "Natural Disasters", "生産拠点の被災", "damage to production bases"],
  ["法規制", "Laws and Regulations", "各国の輸出管理規制", "export control regulations in each country"],
  ["訴訟", "Litigation", "製造物責任に関する請求", "product liability claims"],
  ["カントリーリスク", "Country Risk", "海外拠点の政情", "the political situation at overseas bases"],
  ["環境", "Environmental", "温室効果ガス排出規制", "greenhouse gas emission regulations"],
  ["固定資産の減損", "Impairment of Fixed Assets", "収益性の低下", "a decline in profitability"],
  ["退職給付債務", "Retirement Benefit Obligations", "割引率の変動", "fluctuations in the discount rate"],
  ["取引先の信用", "Credit of Business Partners", "売上債権の回収", "collection of trade receivables"],
];

const NOTE_TOPICS = [
  ["連結の範囲", "Scope of Consolidation"], ["持分法の適用", "Application of the Equity Method"],
  ["会計方針", "Significant Accounting Policies"], ["有価証券の評価", "Valuation of Securities"],
  ["棚卸資産の評価", "Valuation of Inventories"], ["固定資産の減価償却", "Depreciation of Fixed Assets"],
  ["繰延資産の処理", "Treatment of Deferred Assets"], ["引当金の計上基準", "Basis for Recording Provisions"],
  ["退職給付", "Retirement Benefits"], ["ヘッジ会計", "Hedge Accounting"],
  ["収益の認識", "Revenue Recognition"], ["法人税等", "Income Taxes"],
  ["リース取引", "Lease Transactions"], ["金融商品", "Financial Instruments"],
  ["有価証券関係", "Securities"], ["デリバティブ取引", "Derivative Transactions"],
  ["ストック・オプション", "Stock Options"], ["税効果会計", "Tax Effect Accounting"],
  ["企業結合", "Business Combinations"], ["資産除去債務", "Asset Retirement Obligations"],
  ["賃貸等不動産", "Rental Properties"], ["重要な後発事象", "Significant Subsequent Events"],
];

// ---- ページ生成ヘルパ ----
//
// ⚠️ 乱数から作る値は必ず**1回だけ**計算して日英の両方に埋める。
//    日本語側と英語側で別々に呼ぶと日英で違う数値になり、意図しない不整合が
//    全ページに入る（実測で 139/139 ページが該当し、Copilot の指摘はほぼ全部
//    その巻き添えだった＝測定不能）。語句の選択(pick)も同じで、必ず日英ペアで選ぶ。
const finTable = rows => `<table class="fin">${rows.map(r => `<tr>${r.map((c, i) => i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
const finHead = cells => `<tr>${cells.map(c => `<th>${c}</th>`).join("")}</tr>`;
// 日英ペアから1つ選ぶ。戻り値は [ja, en]。
const pickPair = arr => arr[Math.floor(rnd() * arr.length) % arr.length];

const V = {
  phase1: [["設計", "design"], ["製造", "manufacturing"], ["販売", "sales"], ["保守", "maintenance services"]],
  phase2: [["据付", "installation"], ["運用支援", "operational support"], ["部品供給", "parts supply"]],
  products: [["搬送装置", "conveyance equipment"], ["精密加工機", "precision processing machines"],
             ["測定器", "measuring instruments"], ["制御盤", "control panels"],
             ["機能材料", "functional materials"], ["保守用部品", "spare parts for maintenance"]],
  plants: [["厚木工場", "the Atsugi Plant"], ["諏訪工場", "the Suwa Plant"],
           ["水戸工場", "the Mito Plant"], ["タイ工場", "the Thailand Plant"]],
  subsidiaries: [["株式会社アオイ精機テクノ", "Aoi Seiki Techno Co., Ltd."],
                 ["Aoi Seiki (Thailand) Co., Ltd.", "Aoi Seiki (Thailand) Co., Ltd."],
                 ["Aoi Seiki Europe GmbH", "Aoi Seiki Europe GmbH"],
                 ["株式会社アオイ計測", "Aoi Measurement Co., Ltd."]],
  customers: [["電機", "electrical equipment"], ["自動車", "automotive"],
              ["半導体", "semiconductor"], ["化学", "chemical"]],
  markets: [["国内市場", "the domestic market"], ["北米市場", "the North American market"],
            ["アジア市場", "the Asian market"], ["欧州市場", "the European market"]],
  trends: [["堅調に推移した", "remained firm"], ["回復基調にある", "is on a recovery trend"],
           ["一部で減速した", "slowed in some areas"]],
  capexUse: [["生産能力の増強", "expanding production capacity"], ["省人化投資", "labor-saving investment"],
             ["研究開発設備", "research and development facilities"], ["品質保証設備", "quality assurance facilities"]],
  updown: [["増加", "increased"], ["減少", "decreased"]],
  mitigations: [["複数購買", "multiple sourcing"], ["為替予約", "forward exchange contracts"],
                ["在庫水準の適正化", "optimization of inventory levels"],
                ["監視体制の強化", "strengthening of monitoring systems"], ["保険の付保", "insurance coverage"]],
  siteRoles: [["組立", "assembly"], ["加工", "processing"], ["検査", "inspection"],
              ["研究開発", "research and development"]],
  titles: [["取締役", "Director"], ["監査等委員", "Audit and Supervisory Committee Member"],
           ["執行役員", "Executive Officer"], ["社外取締役", "Outside Director"]],
  methods: [["定額法", "the straight-line method"], ["定率法", "the declining-balance method"],
            ["移動平均法", "the moving-average method"], ["原則的な方法", "the principle-based method"],
            ["簡便法", "the simplified method"]],
};

function buildPages() {
  const pages = [];
  const add = (chapter, ja, en, opts = {}) => pages.push({ chapter, ja, en, ...opts });
  const money2 = (min, max) => { const v = money(min, max); return v; };

  // --- 表紙・目次 ---
  add("cover", `<h1>有価証券報告書</h1><p class="lead">${DOC.companyJa}</p>
    <p class="lead">${DOC.fiscalJa}<br>自 2025年4月1日 至 2026年3月31日</p>
    <p class="note">本書は開示用ドラフトであり、監査手続は完了していない。</p>`,
    `<h1>Annual Securities Report</h1><p class="lead">${DOC.companyEn}</p>
    <p class="lead">${DOC.fiscalEn}<br>From April 1, 2025 to March 31, 2026</p>
    <p class="note">This document is a disclosure draft and audit procedures have not been completed.</p>`);

  // EDINET様式の【表紙】は英訳版に無い（ページ対応を1ずらす。誤りではない）
  add("cover", `<h2>【表紙】</h2>${finTable([
    ["【提出書類】", "有価証券報告書"], ["【根拠条文】", "金融商品取引法第24条第1項"],
    ["【提出先】", "関東財務局長"], ["【提出日】", "2026年6月26日"],
    ["【会社名】", DOC.companyJa], ["【英訳名】", DOC.companyEn],
    ["【代表者の役職氏名】", "代表取締役社長　田中 健二"],
  ])}`, "", { jaOnly: true });

  for (let i = 0; i < 2; i++) {
    const from = i * 6;
    const jaToc = ["第1 企業の概況", "第2 事業の状況", "第3 設備の状況", "第4 提出会社の状況", "第5 経理の状況", "第6 その他"];
    const enToc = ["Part 1 Overview", "Part 2 Business", "Part 3 Property", "Part 4 Company Information", "Part 5 Financial Information", "Part 6 Other"];
    const rows = jaToc.slice(from, from + 6).map((t, k) => ({ ja: t, en: enToc.slice(from, from + 6)[k], page: 4 + (from + k) * 20 }));
    add("cover", `<h2>目次${i ? "（続）" : ""}</h2><table class="toc">${
      rows.map(r => `<tr><td>${r.ja}</td><td>${r.page}</td></tr>`).join("")}</table>`,
      `<h2>Table of Contents${i ? " (continued)" : ""}</h2><table class="toc">${
      rows.map(r => `<tr><td>${r.en}</td><td>${r.page}</td></tr>`).join("")}</table>`);
  }

  // --- 第1 企業の概況 ---
  add("overview", `<h2>第1 企業の概況</h2><h3>1 沿革</h3>
    <p>当社は、1953年3月に精密部品の製造販売を目的として大阪府に設立された。1968年に本社を東京都へ移転し、
    1972年に東京証券取引所市場第二部へ上場、1981年に同市場第一部へ指定替えとなった。</p>
    <p>1995年に連結子会社である株式会社アオイ精機テクノを設立し、産業機械分野へ本格参入した。</p>`,
    `<h2>Part 1 Overview of the Company</h2><h3>1 Corporate History</h3>
    <p>The Company was established in Osaka Prefecture in March 1953 for the purpose of manufacturing and selling
    precision components. In 1968, the head office was relocated to Tokyo, and in 1972 the Company was listed on the
    Second Section of the Tokyo Stock Exchange, and was reassigned to the First Section in 1981.</p>
    <p>In 1995, the Company established Aoi Seiki Techno Co., Ltd., a consolidated subsidiary, and made a full-scale
    entry into the industrial machinery field.</p>`);

  add("overview", `<h3>1 沿革（続）</h3>
    <p>2010年にタイ王国へ生産拠点を新設し、2018年には欧州販売子会社 Aoi Seiki Europe GmbH を設立した。
    2022年4月の東京証券取引所の市場区分見直しに伴い、プライム市場へ移行している。</p>
    <p>2024年に計測制御事業を分社化し、株式会社アオイ計測を設立した。</p>`,
    `<h3>1 Corporate History (continued)</h3>
    <p>In 2010, a new production base was established in the Kingdom of Thailand, and in 2018 the European sales
    subsidiary Aoi Seiki Europe GmbH was established. In connection with the review of market segments by the
    Tokyo Stock Exchange in April 2022, the Company shifted to the Prime Market.</p>
    <p>In 2024, the Measurement and Control business was spun off and Aoi Measurement Co., Ltd. was established.</p>`);

  {
    const rows = [["売上高（百万円）", "Net sales (Millions of yen)", 361400, 388250, 402110, 428090, 458921],
                  ["営業利益（百万円）", "Operating income (Millions of yen)", 18900, 22140, 25880, 28600, 32450],
                  ["経常利益（百万円）", "Ordinary income (Millions of yen)", 17700, 21000, 24600, 27400, 30900],
                  ["当期純利益（百万円）", "Profit (Millions of yen)", 12300, 14900, 17220, 19050, 21880],
                  ["総資産額（百万円）", "Total assets (Millions of yen)", 498200, 521900, 544600, 566800, 585200],
                  ["純資産額（百万円）", "Net assets (Millions of yen)", 186400, 198700, 212300, 228900, 247510]];
    const body = (idx) => rows.map(r => `<tr><th>${r[idx]}</th>${r.slice(2).map(v => `<td>${v.toLocaleString("en-US")}</td>`).join("")}</tr>`).join("");
    add("overview", `<h3>2 主要な経営指標等の推移</h3><table class="fin">${finHead(["回次", "第69期", "第70期", "第71期", "第72期", "第73期"])}${body(0)}</table>`,
      `<h3>2 Trends in Major Management Indicators</h3><table class="fin">${finHead(["Term", "69th", "70th", "71st", "72nd", "73rd"])}${body(1)}</table>`);
  }

  {
    const rows = [["売上高（百万円）", "Net sales (Millions of yen)", 288400, 301200, 318900],
                  ["経常利益（百万円）", "Ordinary income (Millions of yen)", 16800, 18400, 20100],
                  ["当期純利益（百万円）", "Profit (Millions of yen)", 11900, 13200, 14800],
                  ["従業員数（人）", "Number of employees (Persons)", 1980, 2040, 2110]];
    const body = (idx) => rows.map(r => `<tr><th>${r[idx]}</th>${r.slice(2).map(v => `<td>${v.toLocaleString("en-US")}</td>`).join("")}</tr>`).join("");
    add("overview", `<h3>2 主要な経営指標等の推移（提出会社）</h3><table class="fin">${finHead(["回次", "第71期", "第72期", "第73期"])}${body(0)}</table>
    <p class="note">（注）売上高には消費税等は含まれていない。</p>`,
      `<h3>2 Trends in Major Management Indicators (the Company)</h3><table class="fin">${finHead(["Term", "71st", "72nd", "73rd"])}${body(1)}</table>
    <p class="note">(Note) Net sales do not include consumption taxes.</p>`);
  }

  // 事業の内容（セグメントごと2ページ）
  SEGMENTS.forEach((s, i) => {
    const ph1 = pickPair(V.phase1), ph2 = pickPair(V.phase2), prod = pickPair(V.products);
    const emp = num(180, 620), plant = pickPair(V.plants);
    add("overview", `<h3>3 事業の内容 — ${s.ja}</h3>
      <p>${s.ja}においては、${ph1[0]}から${ph2[0]}までを一貫して行っている。
      当該事業の主要な製品は${prod[0]}である。</p>
      <p>当連結会計年度における当該事業の従業員数は${emp}人であり、主要な生産拠点は${plant[0]}である。</p>`,
      `<h3>3 Description of Business — ${s.en}</h3>
      <p>In the ${s.en} business, the Group carries out everything from ${ph1[1]} to ${ph2[1]} on an integrated basis.
      The principal product of this business is ${prod[1]}.</p>
      <p>The number of employees in this business during the current consolidated fiscal year was ${emp},
      and the principal production base is ${plant[1]}.</p>`);

    // 比率は連結売上高 458,921 に対する実際の割合。乱数にすると
    // 「比率とセグメント売上高が合わない」と正しく指摘され、gold に無いぶん誤検知になる
    // （実測で幅50が6件まとめて拾った）。
    const sub = pickPair(V.subsidiaries), ratio = (s.sales / 458921 * 100).toFixed(1), cust = pickPair(V.customers);
    add("overview", `<h3>3 事業の内容 — ${s.ja}（続）</h3>
      <p>当該事業に属する主要な連結子会社は${sub[0]}である。</p>
      <p>当該事業の売上高が連結売上高に占める割合は${ratio}%である。主要な販売先は国内の${cust[0]}メーカーである。</p>`,
      `<h3>3 Description of Business — ${s.en} (continued)</h3>
      <p>The principal consolidated subsidiary belonging to this business is ${sub[1]}.</p>
      <p>The ratio of this business's net sales to consolidated net sales is ${ratio}%.
      The principal customers are domestic ${cust[1]} manufacturers.</p>`);
  });

  // --- 第2 事業の状況 ---
  add("business", `<h2>第2 事業の状況</h2><h3>1 経営方針及び経営環境</h3>
    <p>当社グループは「精密で社会を支える」を経営理念に掲げ、中期経営計画「AOI Vision 2028」に基づき、
    収益基盤の強化と成長投資の両立を図っている。</p>
    <p>当連結会計年度における世界経済は、地政学リスクの高まりと為替の変動があったものの、
    設備投資需要は総じて堅調に推移した。</p>`,
    `<h2>Part 2 Business Overview</h2><h3>1 Management Policy and Business Environment</h3>
    <p>The Group has adopted "Supporting society through precision" as its management philosophy and, based on the
    medium-term management plan "AOI Vision 2028," is working to both strengthen its earnings base and invest for growth.</p>
    <p>In the current consolidated fiscal year, the world economy saw heightened geopolitical risk and foreign exchange
    volatility, but capital investment demand remained generally firm.</p>`);

  add("business", `<h3>1 経営方針及び経営環境（続）</h3>
    <p>中期経営計画では、2028年度に売上高5,200億円、営業利益率9.0%を目標としている。
    資本コストを意識した経営の実現に向け、ROIC経営の全社展開を進めている。</p>
    <p>優先的に対処すべき課題は、生産能力の増強、技術者の確保、及びサプライチェーンの強靭化である。</p>`,
    `<h3>1 Management Policy and Business Environment (continued)</h3>
    <p>Under the medium-term management plan, the Group targets net sales of 520.0 billion yen and an operating margin
    of 9.0% for fiscal 2028. To realize management conscious of the cost of capital, the Group is rolling out
    ROIC-based management across the organization.</p>
    <p>The priority issues to be addressed are expanding production capacity, securing engineers, and strengthening
    the resilience of the supply chain.</p>`);

  add("business", `<h3>2 経営成績等の状況の分析</h3><h4>(1) 経営成績</h4>
    <p>当連結会計年度の売上高は458,921百万円（前期比7.2%増）、営業利益は32,450百万円（同13.5%増）、
    親会社株主に帰属する当期純利益は21,880百万円（同14.9%増）となった。</p>
    <p>増収の主な要因は、精密機器事業における半導体製造装置向け需要の回復である。</p>`,
    `<h3>2 Analysis of Operating Results</h3><h4>(1) Operating Results</h4>
    <p>Net sales for the current consolidated fiscal year were 458,921 million yen (up 7.2% year on year), operating
    income was 32,450 million yen (up 13.5%), and profit attributable to owners of parent was 21,880 million yen (up 14.9%).</p>
    <p>The main factor behind the increase in net sales was the recovery in demand for semiconductor manufacturing
    equipment in the Precision Equipment business.</p>`);

  add("business", `<h4>(2) 財政状態</h4>
    <p>当連結会計年度末の総資産は585,200百万円となり、前連結会計年度末に比べ18,400百万円増加した。
    負債合計は337,690百万円、純資産合計は247,510百万円である。</p>
    <p>自己資本比率は42.3%となり、前連結会計年度末から1.9ポイント上昇した。</p>`,
    `<h4>(2) Financial Position</h4>
    <p>Total assets at the end of the current consolidated fiscal year were 585,200 million yen, an increase of
    18,400 million yen from the end of the previous consolidated fiscal year. Total liabilities were 337,690 million yen
    and total net assets were 247,510 million yen.</p>
    <p>The shareholders' equity ratio was 42.3%, up 1.9 points from the end of the previous consolidated fiscal year.</p>`);

  SEGMENTS.forEach((s, i) => {
    const sales = s.sales;
    const growth = (num(20, 130) / 10).toFixed(1);
    const profit = s.profit;
    const mkt = pickPair(V.markets), tr = pickPair(V.trends);
    add("business", `<h4>(3) セグメント別の状況 — ${s.ja}</h4>
      <p>${s.ja}の売上高は${sales.toLocaleString("en-US")}百万円（前期比${growth}%増）、
      セグメント利益は${profit.toLocaleString("en-US")}百万円となった。</p>
      <p>${mkt[0]}における需要が${tr[0]}。</p>`,
      `<h4>(3) Status by Segment — ${s.en}</h4>
      <p>Net sales of the ${s.en} business were ${sales.toLocaleString("en-US")} million yen
      (up ${growth}% year on year), and segment profit was ${profit.toLocaleString("en-US")} million yen.</p>
      <p>Demand in ${mkt[1]} ${tr[1]}.</p>`);

    const capex = num(1200, 5800, 100).toLocaleString("en-US");
    const use = pickPair(V.capexUse);
    const backlog = num(8000, 42000, 100).toLocaleString("en-US");
    const ud = pickPair(V.updown);
    add("business", `<h4>(3) セグメント別の状況 — ${s.ja}（続）</h4>
      <p>当該セグメントの設備投資額は${capex}百万円であり、主に${use[0]}に充当した。</p>
      <p>受注残高は${backlog}百万円であり、前連結会計年度末から${ud[0]}している。</p>`,
      `<h4>(3) Status by Segment — ${s.en} (continued)</h4>
      <p>Capital expenditure in this segment was ${capex} million yen, mainly allocated to ${use[1]}.</p>
      <p>The order backlog was ${backlog} million yen, which ${ud[1]} from the end of the previous consolidated fiscal year.</p>`);
  });

  add("business", `<h3>3 キャッシュ・フローの状況</h3>
    <p>当連結会計年度における営業活動によるキャッシュ・フローは41,200百万円の収入、投資活動によるキャッシュ・フローは
    18,500百万円の支出、財務活動によるキャッシュ・フローは12,300百万円の支出となった。</p>
    <p>この結果、現金及び現金同等物の期末残高は86,900百万円となった。</p>`,
    `<h3>3 Status of Cash Flows</h3>
    <p>In the current consolidated fiscal year, net cash provided by operating activities was 41,200 million yen,
    net cash used in investing activities was 18,500 million yen, and net cash used in financing activities was
    12,300 million yen.</p>
    <p>As a result, cash and cash equivalents at the end of the period were 86,900 million yen.</p>`);

  add("business", `<h3>3 キャッシュ・フローの状況（続）</h3>
    <p>営業活動によるキャッシュ・フローの主な増加要因は、税金等調整前当期純利益30,900百万円及び減価償却費19,800百万円である。</p>
    <p>投資活動によるキャッシュ・フローの主な減少要因は、有形固定資産の取得による支出である。</p>`,
    `<h3>3 Status of Cash Flows (continued)</h3>
    <p>The main factors behind cash flows from operating activities were profit before income taxes of 30,900 million yen
    and depreciation of 19,800 million yen.</p>
    <p>The main factor behind cash flows used in investing activities was the purchase of property, plant and equipment.</p>`);

  RISKS.forEach(([jaTitle, enTitle, jaCause, enCause], i) => {
    const mit = pickPair(V.mitigations);
    add("risk", `<h3>4 事業等のリスク — (${i + 1}) ${jaTitle}リスク</h3>
      <p>当社グループの事業は${jaCause}の影響を受ける。これらが著しく変動した場合、
      業績及び財政状態に影響を及ぼす可能性がある。</p>
      <p>当社グループは、${mit[0]}等により影響の緩和を図っているが、その全てを回避できるものではない。</p>
      <p>当該リスクへの対応状況は、取締役会が四半期ごとに報告を受けている。</p>`,
      `<h3>4 Business and Other Risks — (${i + 1}) ${enTitle} Risk</h3>
      <p>The Group's business is affected by ${enCause}. If these change significantly, the Group's business results
      and financial position may be affected.</p>
      <p>The Group seeks to mitigate the impact through measures such as ${mit[1]}, but cannot avoid all of it.</p>
      <p>The status of responses to this risk is reported to the Board of Directors on a quarterly basis.</p>`);

    // リスクは1項目2ページ（実際の有報でもこの程度の分量になる）。
    // 距離120のペアを置くために文書長が必要、という事情も兼ねている。
    add("risk", `<h3>4 事業等のリスク — (${i + 1}) ${jaTitle}リスク（続）</h3>
      <p>当該リスクが顕在化した場合の業績への影響額は、現時点で合理的に見積もることが困難である。</p>
      <p>当社グループは、${jaTitle}に関する社内規程を整備し、担当部門が定期的に状況を確認している。</p>
      <p>また、リスク管理委員会が年2回、対応状況の評価を行い、必要に応じて対応方針を見直している。</p>`,
      `<h3>4 Business and Other Risks — (${i + 1}) ${enTitle} Risk (continued)</h3>
      <p>It is difficult to reasonably estimate the amount of impact on business results if this risk materializes.</p>
      <p>The Group has established internal rules concerning ${enTitle.toLowerCase()}, and the responsible department
      regularly checks the situation.</p>
      <p>In addition, the Risk Management Committee evaluates the status of responses twice a year and reviews the
      response policy as necessary.</p>`);
  });

  // --- 第3 設備の状況 ---
  for (let i = 0; i < 6; i++) {
    const site = ["本社（東京都）", "厚木工場（神奈川県）", "諏訪工場（長野県）", "水戸工場（茨城県）", "タイ工場", "欧州拠点"][i];
    const siteEn = ["Head Office (Tokyo)", "Atsugi Plant (Kanagawa)", "Suwa Plant (Nagano)", "Mito Plant (Ibaraki)", "Thailand Plant", "European Base"][i];
    const bld = money2(2000, 22000), mac = money2(1000, 34000), land = money2(500, 9000), emp = num(80, 1100);
    const seg = SEGMENTS[Math.floor(rnd() * SEGMENTS.length) % SEGMENTS.length];
    const role = pickPair(V.siteRoles);
    add("property", `${i === 0 ? "<h2>第3 設備の状況</h2>" : ""}<h3>1 主要な設備の状況 — ${site}</h3>${
      finTable([["建物及び構築物（百万円）", bld], ["機械装置（百万円）", mac],
                ["土地（百万円）", land], ["従業員数（人）", emp]])}
      <p>当該事業所は${seg.ja}に属し、${role[0]}を担っている。</p>`,
      `${i === 0 ? "<h2>Part 3 Property, Plant and Equipment</h2>" : ""}<h3>1 Major Facilities — ${siteEn}</h3>${
      finTable([["Buildings and structures (Millions of yen)", bld], ["Machinery (Millions of yen)", mac],
                ["Land (Millions of yen)", land], ["Number of employees (Persons)", emp]])}
      <p>This site belongs to the ${seg.en} business and is responsible for ${role[1]}.</p>`);
  }

  // --- 第4 提出会社の状況 ---
  add("company", `<h2>第4 提出会社の状況</h2><h3>1 株式等の状況</h3>
    <p>発行可能株式総数は400,000,000株、発行済株式総数は148,600,000株である。
    当連結会計年度において発行済株式総数の変動はない。</p>`,
    `<h2>Part 4 Information about the Reporting Company</h2><h3>1 Information on Shares</h3>
    <p>The total number of authorized shares is 400,000,000 and the total number of issued shares is 148,600,000.
    There was no change in the total number of issued shares during the current consolidated fiscal year.</p>`);

  add("company", `<h3>1 株式等の状況（大株主）</h3>${
    finTable([["日本マスタートラスト信託銀行株式会社", "18,900千株", "12.7%"],
              ["株式会社日本カストディ銀行", "13,400千株", "9.0%"],
              ["三葉電機株式会社", "7,200千株", "4.8%"],
              ["アオイ精機従業員持株会", "4,100千株", "2.8%"]])}
    <p>当連結会計年度末現在の株主数は18,420名である。</p>`,
    `<h3>1 Information on Shares (Major Shareholders)</h3>${
    finTable([["The Master Trust Bank of Japan, Ltd.", "18,900 thousand shares", "12.7%"],
              ["Custody Bank of Japan, Ltd.", "13,400 thousand shares", "9.0%"],
              ["Mitsuba Electric Co., Ltd.", "7,200 thousand shares", "4.8%"],
              ["Aoi Seiki Employee Shareholding Association", "4,100 thousand shares", "2.8%"]])}
    <p>The number of shareholders as of the end of the current consolidated fiscal year was 18,420.</p>`);

  add("company", `<h3>2 配当政策</h3>
    <p>当社は、連結配当性向30%を目安として安定的な配当を継続することを基本方針としている。
    当連結会計年度の1株当たり配当額は年間45円（中間22円、期末23円）とした。</p>
    <p>内部留保資金については、成長分野への設備投資及び研究開発投資に充当する方針である。</p>`,
    `<h3>2 Dividend Policy</h3>
    <p>The Company's basic policy is to continue stable dividends with a consolidated payout ratio of 30% as a guideline.
    The annual dividend per share for the current consolidated fiscal year was 45 yen (interim 22 yen, year-end 23 yen).</p>
    <p>The Company's policy is to allocate internal reserves to capital investment and research and development in growth fields.</p>`);

  const NAMES_JA = ["田中 健二", "森 由紀子", "大西 亮", "ロバート・キム", "佐藤 誠", "高橋 直子", "伊藤 学", "渡辺 千夏",
                    "中村 浩", "小林 明日香", "加藤 隆", "吉田 真澄", "山田 康平", "松本 有希", "井上 剛", "清水 綾子",
                    "斎藤 徹", "村上 詩織", "林 大輔", "内田 香織"];
  const NAMES_EN = ["Kenji Tanaka", "Yukiko Mori", "Ryo Onishi", "Robert Kim", "Makoto Sato", "Naoko Takahashi",
                    "Manabu Ito", "Chinatsu Watanabe", "Hiroshi Nakamura", "Asuka Kobayashi", "Takashi Kato", "Masumi Yoshida",
                    "Kohei Yamada", "Yuki Matsumoto", "Tsuyoshi Inoue", "Ayako Shimizu", "Toru Saito", "Shiori Murakami",
                    "Daisuke Hayashi", "Kaori Uchida"];
  for (let i = 0; i < 5; i++) {
    const rows = Array.from({ length: 4 }, (_, k) => {
      const idx = i * 4 + k;
      return { ja: NAMES_JA[idx] || `役員 ${idx + 1}`, en: NAMES_EN[idx] || `Officer ${idx + 1}`,
               title: pickPair(V.titles), y: num(1955, 1975), m: num(1, 12) };
    });
    add("company", `<h3>3 役員の状況（${i + 1}）</h3>${
      finTable(rows.map(r => [r.ja, r.title[0], `${r.y}年${r.m}月`]))}`,
      `<h3>3 Directors and Officers (${i + 1})</h3>${
      finTable(rows.map(r => [r.en, r.title[1], `${r.m}/${r.y}`]))}`);
  }

  for (let i = 0; i < 5; i++) {
    const topic = ["コーポレート・ガバナンスの概要", "内部統制システム", "監査の状況", "役員の報酬等", "株式の保有状況"][i];
    const topicEn = ["Overview of Corporate Governance", "Internal Control System", "Status of Audits", "Remuneration of Officers", "Status of Shareholdings"][i];
    add("company", `<h3>4 コーポレート・ガバナンスの状況 — ${topic}</h3>
      <p>当社は監査等委員会設置会社であり、取締役8名のうち4名を社外取締役としている。
      取締役会は原則として毎月1回開催し、当連結会計年度は14回開催した。</p>
      <p>${topic}に関する当社の方針は、取締役会において毎年見直しを行っている。</p>`,
      `<h3>4 Status of Corporate Governance — ${topicEn}</h3>
      <p>The Company is a company with an audit and supervisory committee, and four of its eight directors are outside
      directors. The Board of Directors meets in principle once a month and met 14 times in the current consolidated fiscal year.</p>
      <p>The Company's policy on ${topicEn.toLowerCase()} is reviewed annually by the Board of Directors.</p>`);
  }

  // --- 第5 経理の状況 ---
  add("financial", `<h2>第5 経理の状況</h2>
    <p>当社の連結財務諸表は、「連結財務諸表の用語、様式及び作成方法に関する規則」に基づいて作成している。
    金額は百万円未満を切り捨てて表示している。</p>`,
    `<h2>Part 5 Financial Information</h2>
    <p>The Company's consolidated financial statements are prepared in accordance with the "Regulations on the
    Terminology, Forms and Preparation Methods of Consolidated Financial Statements."
    Amounts are rounded down to the nearest million yen.</p>`);

  // 科目名は日英ペアで持ち、金額は1回だけ書く
  const fin2Pair = (rows, lang) => `<table class="fin">${
    lang === "ja" ? finHead(["科目", "前連結会計年度", "当連結会計年度"]) : finHead(["Account", "Previous FY", "Current FY"])}${
    rows.map(r => `<tr><th>${lang === "ja" ? r[0] : r[1]}</th><td>${r[2].toLocaleString("en-US")}</td><td>${r[3].toLocaleString("en-US")}</td></tr>`).join("")}</table>`;

  const bs1 = [["現金及び預金", "Cash and deposits", 76500, 86900], ["受取手形及び売掛金", "Notes and accounts receivable-trade", 112300, 118900],
               ["棚卸資産", "Inventories", 94700, 99200], ["その他流動資産", "Other current assets", 21300, 22100],
               ["流動資産合計", "Total current assets", 304800, 327100]];
  const bs2 = [["有形固定資産", "Property, plant and equipment", 186400, 184900], ["無形固定資産", "Intangible assets", 28100, 26700],
               ["投資その他の資産", "Investments and other assets", 47500, 46500], ["固定資産合計", "Total non-current assets", 262000, 258100],
               ["資産合計", "Total assets", 566800, 585200]];
  add("financial", `<h3>1 連結貸借対照表（資産の部）</h3>${fin2Pair(bs1, "ja")}`, `<h3>1 Consolidated Balance Sheet (Assets)</h3>${fin2Pair(bs1, "en")}`);
  add("financial", `<h3>1 連結貸借対照表（資産の部・続）</h3>${fin2Pair(bs2, "ja")}`, `<h3>1 Consolidated Balance Sheet (Assets, continued)</h3>${fin2Pair(bs2, "en")}`);

  const bsL = [["支払手形及び買掛金", "Notes and accounts payable-trade", 98400, 101200], ["短期借入金", "Short-term borrowings", 62000, 58000],
               ["その他流動負債", "Other current liabilities", 43100, 46700], ["流動負債合計", "Total current liabilities", 203500, 205900],
               ["長期借入金", "Long-term borrowings", 108000, 103600], ["固定負債合計", "Total non-current liabilities", 134400, 131790]];
  add("financial", `<h3>2 連結貸借対照表（負債の部）</h3>${fin2Pair(bsL, "ja")}`, `<h3>2 Consolidated Balance Sheet (Liabilities)</h3>${fin2Pair(bsL, "en")}`);

  const bsN = [["株主資本", "Shareholders' equity", 221400, 239300], ["その他の包括利益累計額", "Accumulated other comprehensive income", 7500, 8210],
               ["純資産合計", "Total net assets", 228900, 247510], ["負債純資産合計", "Total liabilities and net assets", 566800, 585200]];
  add("financial", `<h3>2 連結貸借対照表（純資産の部）</h3>${fin2Pair(bsN, "ja")}
    <p class="note">（注）自己資本は純資産合計から新株予約権及び非支配株主持分を控除した金額である。</p>`,
    `<h3>2 Consolidated Balance Sheet (Net Assets)</h3>${fin2Pair(bsN, "en")}
    <p class="note">(Note) Equity is the amount obtained by deducting share acquisition rights and non-controlling interests from total net assets.</p>`);

  const pl1 = [["売上高", "Net sales", 428090, 458921], ["売上原価", "Cost of sales", 331700, 352400],
               ["売上総利益", "Gross profit", 96390, 106521], ["販売費及び一般管理費", "Selling, general and administrative expenses", 67790, 74071],
               ["営業利益", "Operating income", 28600, 32450]];
  add("financial", `<h3>3 連結損益計算書</h3>${fin2Pair(pl1, "ja")}`, `<h3>3 Consolidated Statement of Income</h3>${fin2Pair(pl1, "en")}`);
  const pl2 = [["営業外収益", "Non-operating income", 2100, 2400], ["営業外費用", "Non-operating expenses", 3300, 3950],
               ["経常利益", "Ordinary income", 27400, 30900], ["法人税等合計", "Total income taxes", 8000, 8700],
               ["親会社株主に帰属する当期純利益", "Profit attributable to owners of parent", 19050, 21880]];
  add("financial", `<h3>3 連結損益計算書（続）</h3>${fin2Pair(pl2, "ja")}`, `<h3>3 Consolidated Statement of Income (continued)</h3>${fin2Pair(pl2, "en")}`);
  const ci = [["当期純利益", "Profit", 19400, 22200], ["その他の包括利益", "Other comprehensive income", 1200, 710],
              ["包括利益", "Comprehensive income", 20600, 22910]];
  add("financial", `<h3>4 連結包括利益計算書</h3>${fin2Pair(ci, "ja")}`, `<h3>4 Consolidated Statement of Comprehensive Income</h3>${fin2Pair(ci, "en")}`);
  const se = [["資本金", "Share capital", 32000, 32000], ["資本剰余金", "Capital surplus", 41200, 41200],
              ["利益剰余金", "Retained earnings", 152300, 168000], ["自己株式", "Treasury shares", -4100, -1900]];
  for (let i = 0; i < 2; i++) {
    add("financial", `<h3>5 連結株主資本等変動計算書（${i + 1}）</h3>${fin2Pair(se, "ja")}`,
      `<h3>5 Consolidated Statement of Changes in Equity (${i + 1})</h3>${fin2Pair(se, "en")}`);
  }
  const cf1 = [["税金等調整前当期純利益", "Profit before income taxes", 27400, 30900], ["減価償却費", "Depreciation", 18200, 19800],
               ["売上債権の増減額", "Increase/decrease in trade receivables", -5100, -6600],
               ["棚卸資産の増減額", "Increase/decrease in inventories", -3800, -4500],
               ["営業活動によるキャッシュ・フロー", "Net cash provided by operating activities", 37600, 41200]];
  add("financial", `<h3>6 連結キャッシュ・フロー計算書</h3>${fin2Pair(cf1, "ja")}`, `<h3>6 Consolidated Statement of Cash Flows</h3>${fin2Pair(cf1, "en")}`);
  const cf2 = [["有形固定資産の取得による支出", "Purchase of property, plant and equipment", -19800, -22600],
               ["投資活動によるキャッシュ・フロー", "Net cash used in investing activities", -16400, -18500],
               ["配当金の支払額", "Dividends paid", -5900, -6400],
               ["財務活動によるキャッシュ・フロー", "Net cash used in financing activities", -11800, -12300],
               ["現金及び現金同等物の期末残高", "Cash and cash equivalents at end of period", 76500, 86900]];
  add("financial", `<h3>6 連結キャッシュ・フロー計算書（続）</h3>${fin2Pair(cf2, "ja")}`, `<h3>6 Consolidated Statement of Cash Flows (continued)</h3>${fin2Pair(cf2, "en")}`);

  NOTE_TOPICS.forEach(([jaTopic, enTopic], i) => {
    const m = pickPair(V.methods), amt = money2(200, 9800);
    add("notes", `<h3>7 注記事項 — ${jaTopic}</h3>
      <p>${jaTopic}について、当社グループは${m[0]}を採用している。当連結会計年度において重要な変更はない。</p>
      <p class="note">（注）当該注記に係る金額は${amt}百万円である。</p>`,
      `<h3>7 Notes — ${enTopic}</h3>
      <p>With respect to ${enTopic.toLowerCase()}, the Group applies ${m[1]}. There were no significant
      changes in the current consolidated fiscal year.</p>
      <p class="note">(Note) The amount related to this note is ${amt} million yen.</p>`);
  });

  for (let i = 0; i < 5; i++) {
    const rows = SEGMENTS.slice(i, i + 3).map(s => ({
      ja: s.ja, en: s.en, a: s.sales.toLocaleString("en-US"), b: s.profit.toLocaleString("en-US") }));
    add("notes", `<h3>8 セグメント情報（${i + 1}）</h3>${finTable(rows.map(r => [r.ja, r.a, r.b]))}
      <p class="note">（注）セグメント利益の合計は連結損益計算書の営業利益と一致している。</p>`,
      `<h3>8 Segment Information (${i + 1})</h3>${finTable(rows.map(r => [r.en, r.a, r.b]))}
      <p class="note">(Note) The total of segment profit agrees with operating income in the consolidated statement of income.</p>`);
  }

  add("notes", `<h3>9 関連当事者情報</h3>
    <p>当連結会計年度において、開示すべき重要な関連当事者との取引はない。</p>
    <p>役員及び主要株主との取引についても、開示すべき重要なものはない。</p>`,
    `<h3>9 Related Party Information</h3>
    <p>There were no significant related party transactions to be disclosed in the current consolidated fiscal year.</p>
    <p>There were also no significant transactions with officers or major shareholders to be disclosed.</p>`);

  add("notes", `<h3>10 1株当たり情報</h3>${
    finTable([["1株当たり純資産額（円）", "1,540.20", "1,665.60"], ["1株当たり当期純利益（円）", "128.20", "147.24"]])}
    <p class="note">（注）潜在株式調整後1株当たり当期純利益については、潜在株式が存在しないため記載していない。</p>`,
    `<h3>10 Per Share Information</h3>${
    finTable([["Net assets per share (Yen)", "1,540.20", "1,665.60"], ["Profit per share (Yen)", "128.20", "147.24"]])}
    <p class="note">(Note) Diluted profit per share is not presented because there are no dilutive shares.</p>`);

  for (let i = 0; i < 6; i++) {
    const t = ["有価証券明細表", "有形固定資産等明細表", "社債明細表", "借入金等明細表", "引当金明細表", "資産除去債務明細表"][i];
    const tEn = ["Schedule of Securities", "Schedule of Property, Plant and Equipment", "Schedule of Bonds",
                 "Schedule of Borrowings", "Schedule of Provisions", "Schedule of Asset Retirement Obligations"][i];
    const rows = Array.from({ length: 4 }, (_, k) => ({ k, a: money2(100, 48000), b: money2(50, 12000) }));
    add("supplementary", `<h3>11 附属明細表 — ${t}</h3>${finTable(rows.map(r => [`区分${r.k + 1}`, r.a, r.b]))}`,
      `<h3>11 Supplementary Schedules — ${tEn}</h3>${finTable(rows.map(r => [`Category ${r.k + 1}`, r.a, r.b]))}`);
  }

  // --- 第6 その他 ---
  add("closing", `<h2>第6 提出会社の株式事務の概要</h2>${
    finTable([["事業年度", "毎年4月1日から翌年3月31日まで"], ["定時株主総会", "毎年6月"],
              ["基準日", "2026年3月31日"], ["単元株式数", "100株"], ["公告掲載方法", "電子公告"]])}`,
    `<h2>Part 6 Outline of Share Handling</h2>${
    finTable([["Fiscal year", "From April 1 to March 31 of the following year"], ["Ordinary general meeting", "Every June"],
              ["Record date", "March 31, 2026"], ["Shares per unit", "100 shares"], ["Method of public notice", "Electronic public notice"]])}`);

  add("closing", `<h2>第7 参考情報</h2><h3>1 主要な連結子会社</h3>${
    finTable([["株式会社アオイ精機テクノ", "神奈川県厚木市", "100.0%"],
              ["Aoi Seiki (Thailand) Co., Ltd.", "タイ王国", "100.0%"],
              ["Aoi Seiki Europe GmbH", "ドイツ連邦共和国", "90.0%"],
              ["株式会社アオイ計測", "長野県諏訪市", "100.0%"]])}`,
    `<h2>Part 7 Reference Information</h2><h3>1 Principal Consolidated Subsidiaries</h3>${
    finTable([["Aoi Seiki Techno Co., Ltd.", "Atsugi, Kanagawa", "100.0%"],
              ["Aoi Seiki (Thailand) Co., Ltd.", "Kingdom of Thailand", "100.0%"],
              ["Aoi Seiki Europe GmbH", "Federal Republic of Germany", "90.0%"],
              ["Aoi Measurement Co., Ltd.", "Suwa, Nagano", "100.0%"]])}`);

  add("closing", `<h3>2 従業員の状況</h3>
    <p>当連結会計年度末の従業員数は3,214人であり、前連結会計年度末に比べ74人増加している。
    平均年齢は41.8歳、平均勤続年数は15.2年、平均年間給与は7,120千円である。</p>`,
    `<h3>2 Employees</h3>
    <p>The number of employees at the end of the current consolidated fiscal year was 3,214, an increase of 74 from the
    end of the previous consolidated fiscal year. The average age was 41.8, the average length of service was 15.2 years,
    and the average annual salary was 7,120 thousand yen.</p>`);

  add("closing", `<h2>第8 その他</h2>
    <p>当社は、投資家との建設的な対話を促進するため、決算説明会を年2回開催している。
    説明資料は当社ウェブサイトに掲載している。</p>
    <p>本報告書に記載した将来に関する事項は、当連結会計年度末現在において当社が判断したものである。</p>
    <p class="note">問い合わせ先：株式会社アオイ精機 経営企画部 IR課</p>`,
    `<h2>Part 8 Other Information</h2>
    <p>The Company holds financial results briefings twice a year to promote constructive dialogue with investors.
    The Company has posted the briefing materials on its website.</p>
    <p>Forward-looking statements in this report are based on judgments made by the Company as of the end of the
    current consolidated fiscal year.</p>
    <p class="note">Contact: Aoi Seiki Co., Ltd., Corporate Planning Department, IR Section</p>`);

  return pages;
}

export const PAGES = buildPages();

// =====================================================================
// 埋め込む誤りの定義
// =====================================================================

// 1) 訳語の揺れによる距離統制ペア（Q1 の主計器）。
//
//    jaTerm が anchor / error の2ページだけに出る。英訳は enAnchor と enError で違う語を当てる。
//    どちらも単独では正しい訳なので、**そのページだけを REF と突き合わせても誤りにならない**。
//    build-long-fixture.mjs が「jaTerm は文書全体でちょうど2回」「enAnchor / enError はそれぞれ1回」を
//    検証して、他ページに同じ語が漏れて実効距離が縮むのを防ぐ。
export const DRIFT_PAIRS = [
  { id: "w003", distance: 3, anchorEnPage: 21, errorEnPage: 24,
    jaTerm: "工程内検査", enAnchor: "in-process inspection", enError: "in-line inspection",
    ja1: "当社グループは、工程内検査の自動化を進め、不適合の早期発見に取り組んでいる。",
    en1: "The Group is promoting the automation of in-process inspection and is working to detect nonconformities at an early stage.",
    ja2: "工程内検査の結果は、品質保証部門が月次で集計している。",
    en2: "The results of in-line inspection are compiled monthly by the quality assurance department." },

  { id: "w010", distance: 10, anchorEnPage: 33, errorEnPage: 43,
    jaTerm: "基幹部品", enAnchor: "core components", enError: "key parts",
    ja1: "基幹部品の内製化率は、当連結会計年度において前連結会計年度を上回った。",
    en1: "The in-house production ratio of core components exceeded that of the previous consolidated fiscal year.",
    ja2: "基幹部品の調達については、複数の供給元を確保することを方針としている。",
    en2: "The Group's policy for the procurement of key parts is to secure multiple sources of supply." },

  { id: "w020", distance: 20, anchorEnPage: 45, errorEnPage: 65,
    jaTerm: "協力会社", enAnchor: "partner companies", enError: "cooperating suppliers",
    ja1: "当社グループは、協力会社との定期的な連絡会を通じて生産計画を共有している。",
    en1: "The Group shares its production plans through regular liaison meetings with partner companies.",
    ja2: "協力会社に対しては、当社グループの行動規範の遵守を要請している。",
    en2: "The Group requests that cooperating suppliers comply with its code of conduct." },

  { id: "w040", distance: 40, anchorEnPage: 51, errorEnPage: 91,
    jaTerm: "保全計画", enAnchor: "maintenance program", enError: "preservation plan",
    ja1: "生産設備については、年度ごとの保全計画に基づいて点検を実施している。",
    en1: "Production facilities are inspected in accordance with an annual maintenance program.",
    ja2: "保全計画の実施状況は、四半期ごとに経営会議へ報告している。",
    en2: "The status of implementation of the preservation plan is reported quarterly to the management meeting." },

  { id: "w060", distance: 60, anchorEnPage: 39, errorEnPage: 99,
    jaTerm: "技能伝承", enAnchor: "transfer of skills", enError: "succession of techniques",
    ja1: "熟練技能者の減少に備え、技能伝承の仕組みを社内に整備している。",
    en1: "In preparation for the decline in the number of skilled workers, the Group has established an internal framework for the transfer of skills.",
    ja2: "技能伝承に関する研修は、年間を通じて計画的に実施している。",
    en2: "Training related to the succession of techniques is conducted systematically throughout the year." },

  { id: "w080", distance: 80, anchorEnPage: 27, errorEnPage: 107,
    jaTerm: "設備稼働率", enAnchor: "facility utilization rate", enError: "equipment operating ratio",
    ja1: "当連結会計年度の設備稼働率は、前連結会計年度を上回る水準で推移した。",
    en1: "The facility utilization rate for the current consolidated fiscal year remained above the level of the previous consolidated fiscal year.",
    ja2: "設備稼働率は、生産管理部門が日次で把握している。",
    en2: "The equipment operating ratio is monitored on a daily basis by the production control department." },

  { id: "w100", distance: 100, anchorEnPage: 15, errorEnPage: 115,
    jaTerm: "試作評価", enAnchor: "prototype evaluation", enError: "trial production assessment",
    ja1: "新製品の開発にあたっては、試作評価の工程を必ず経ることとしている。",
    en1: "In developing new products, the Group always goes through a prototype evaluation process.",
    ja2: "試作評価に要する期間の短縮が、開発上の課題となっている。",
    en2: "Shortening the period required for trial production assessment is an issue in development." },

  { id: "w120", distance: 120, anchorEnPage: 9, errorEnPage: 129,
    jaTerm: "安全在庫", enAnchor: "safety stock", enError: "buffer inventory",
    ja1: "主要な部材については、安全在庫を設定して供給の途絶に備えている。",
    en1: "For principal materials, the Group sets a safety stock to prepare for disruptions in supply.",
    ja2: "安全在庫の水準は、需要動向を踏まえて定期的に見直している。",
    en2: "The level of buffer inventory is reviewed periodically in light of demand trends." },

  // 各距離に2件目を置く。1件しかないと recall が 0% か 100% しか取らず、
  // 1回のrunでは「どの幅で落ちるか」が読み取れないため。
  { id: "w003b", distance: 3, anchorEnPage: 60, errorEnPage: 63,
    jaTerm: "受入検査", enAnchor: "acceptance inspection", enError: "incoming inspection",
    ja1: "購入部材については、受入検査を行ったうえで生産工程へ払い出している。",
    en1: "Purchased materials are released to the production process after acceptance inspection.",
    ja2: "受入検査の基準は、部材の重要度に応じて定めている。",
    en2: "The criteria for incoming inspection are established according to the importance of the material." },

  { id: "w010b", distance: 10, anchorEnPage: 71, errorEnPage: 81,
    jaTerm: "歩留まり", enAnchor: "yield rate", enError: "production yield",
    ja1: "主力製品の歩留まりは、当連結会計年度において改善した。",
    en1: "The yield rate of the mainstay products improved in the current consolidated fiscal year.",
    ja2: "歩留まりの改善は、製造原価の低減に直接寄与する。",
    en2: "An improvement in production yield contributes directly to lowering the cost of sales." },

  { id: "w020b", distance: 20, anchorEnPage: 17, errorEnPage: 37,
    jaTerm: "保守契約", enAnchor: "maintenance contracts", enError: "service agreements",
    ja1: "納入後の製品については、保守契約に基づく定期点検を提供している。",
    en1: "For products after delivery, the Group provides periodic inspections based on maintenance contracts.",
    ja2: "保守契約の更新率は、安定的に推移している。",
    en2: "The renewal rate of service agreements has remained stable." },

  { id: "w040b", distance: 40, anchorEnPage: 29, errorEnPage: 69,
    jaTerm: "予防保全", enAnchor: "preventive maintenance", enError: "proactive servicing",
    ja1: "生産設備については、予防保全の考え方に基づき部品を計画的に交換している。",
    en1: "For production facilities, parts are replaced on a planned basis in accordance with the concept of preventive maintenance.",
    ja2: "予防保全に要する費用は、製造原価に含めている。",
    en2: "The costs required for proactive servicing are included in the cost of sales." },

  { id: "w060b", distance: 60, anchorEnPage: 48, errorEnPage: 108,
    jaTerm: "原価低減活動", enAnchor: "cost reduction activities", enError: "cost saving initiatives",
    ja1: "各工場では、原価低減活動を全員参加で推進している。",
    en1: "At each plant, cost reduction activities are promoted with the participation of all employees.",
    ja2: "原価低減活動の成果は、四半期ごとに集計している。",
    en2: "The results of cost saving initiatives are compiled on a quarterly basis." },

  { id: "w080b", distance: 80, anchorEnPage: 41, errorEnPage: 121,
    jaTerm: "外注加工費", enAnchor: "outsourcing processing costs", enError: "subcontracting expenses",
    ja1: "外注加工費は、生産量の増加に伴い前連結会計年度から増加した。",
    en1: "Outsourcing processing costs increased from the previous consolidated fiscal year in line with the increase in production volume.",
    ja2: "外注加工費の管理は、購買部門が一元的に行っている。",
    en2: "Subcontracting expenses are managed centrally by the purchasing department." },

  { id: "w100b", distance: 100, anchorEnPage: 23, errorEnPage: 123,
    jaTerm: "省エネルギー投資", enAnchor: "energy saving investment", enError: "energy conservation investment",
    ja1: "当社グループは、温室効果ガスの削減に向けて省エネルギー投資を継続している。",
    en1: "The Group continues to make energy saving investment to reduce greenhouse gas emissions.",
    ja2: "省エネルギー投資の回収期間は、おおむね5年を目安としている。",
    en2: "The payback period for energy conservation investment is generally set at around five years." },

  { id: "w120b", distance: 120, anchorEnPage: 8, errorEnPage: 128,
    jaTerm: "治工具", enAnchor: "jigs and tools", enError: "tooling equipment",
    ja1: "治工具については、社内で設計及び製作を行っている。",
    en1: "Jigs and tools are designed and manufactured in-house.",
    ja2: "治工具の更新は、生産計画に合わせて実施している。",
    en2: "The replacement of tooling equipment is carried out in line with production plans." },
];

// 2) 数値の食い違いによる距離統制ペア。
//
//    side = "both"（既定）: **原文と英訳の両方に同じ食い違いがある**形にする。
//      anchor ページでは JA/EN とも 17,400、error ページでは JA/EN とも 17,900。
//      そのページだけを見れば日英は完全に一致しているので、REF との突き合わせでは何も出ない。
//      文書自身が2箇所で違うことを言っている、という跨ぎの矛盾だけが残る。
//      → drift と同じく純粋な距離の計器になる。
//      実務でも「原文の数値が古いまま残り、翻訳者は忠実に訳した」という形で普通に起きる。
//      ⚠️ この3件だけは「REFは正」の前提から外れる（gold の side で区別している）。
//         整合性レビューのプロンプトは A: TARGET内部の跨ぎ整合 / B: REFとの照合 の二本立てで、
//         これは A の担当。どちらのページが正しいかは原理的に決まらないが、
//         採点は「矛盾を指摘したか」だけを見るので支障はない。
//
//    side = "target"（1件だけ）: 対照群。error ページの JA は「上記の〜」と数値を繰り返さず、
//      EN だけが数値を書き、それが誤っている。ローカルでも「原文にない数値」として
//      気づける余地がある。**これが取れて both が取れないなら、モデルは跨ぎを見ておらず
//      ローカルなREF比較しかしていない**と分かる。その切り分けのために1件だけ置く。
export const NUMBER_PAIRS = [
  { id: "n005", distance: 5, anchorEnPage: 20, errorEnPage: 25, side: "both",
    label: "研究開発費", correct: "17,400", wrong: "17,900",
    ja1: "当連結会計年度の研究開発費の総額は17,400百万円である。",
    en1: "Total research and development expenses for the current consolidated fiscal year were 17,400 million yen.",
    ja2: "研究開発費（17,900百万円）には、基礎研究に係る費用を含んでいる。",
    en2: "Research and development expenses (17,900 million yen) include costs related to basic research.",
    quote: "Research and development expenses (17,900 million yen)" },

  { id: "n030", distance: 30, anchorEnPage: 57, errorEnPage: 87, side: "both",
    label: "特許保有件数", correct: "1,860", wrong: "1,680",
    ja1: "当連結会計年度末における当社グループの特許保有件数は1,860件である。",
    en1: "The number of patents held by the Group as of the end of the current consolidated fiscal year was 1,860.",
    ja2: "保有する1,680件の特許のうち、約4割が海外で登録されたものである。",
    en2: "Of the 1,680 patents held by the Group, approximately 40% are registered overseas.",
    quote: "Of the 1,680 patents held by the Group" },

  { id: "n090", distance: 90, anchorEnPage: 32, errorEnPage: 122, side: "both",
    label: "海外売上高比率", correct: "38.4", wrong: "34.8",
    ja1: "当連結会計年度の海外売上高比率は38.4%である。",
    en1: "The ratio of overseas net sales for the current consolidated fiscal year was 38.4%.",
    ja2: "海外売上高比率34.8%は、前連結会計年度から上昇している。",
    en2: "The ratio of overseas net sales of 34.8% increased from the previous consolidated fiscal year.",
    quote: "overseas net sales of 34.8%" },

  // 対照群（1件だけ）。EN だけが誤っており、REF はその数値を書いていない。
  { id: "n020x", distance: 20, anchorEnPage: 53, errorEnPage: 73, side: "target",
    label: "教育研修時間", correct: "32.5", wrong: "35.2",
    ja1: "当連結会計年度の従業員1人当たりの教育研修時間は32.5時間である。",
    en1: "Training hours per employee for the current consolidated fiscal year were 32.5 hours.",
    ja2: "上記の教育研修時間は、前連結会計年度から増加している。",
    en2: "The training hours of 35.2 hours referred to above increased from the previous consolidated fiscal year.",
    quote: "training hours of 35.2 hours referred to above" },
];

// 3) 行レベル誤り。6ページ間隔で全編に分散。ローカルに見れば必ず分かる種類。
//    幅を広げたときの「各行精読」の劣化を測る。
//    文面は1件ごとに変えてある（同一文だと「複数ページで同じ誤り」と1件にまとめられ、
//    ページ単位の recall が測れなくなるため）。
const SPELLING = [
  { ja: "当社グループは、品質管理体制の整備を継続的に進めている。",
    en: "The Group continuously promotes the enhancement of its quality management system and recieves regular external audits.",
    quote: "recieves regular external audits", why: "receives の綴り誤り（recieves）" },
  { ja: "当連結会計年度において、重大な製品事故は発生していない。",
    en: "No serious product accidents occured during the current consolidated fiscal year.",
    quote: "No serious product accidents occured", why: "occurred の綴り誤り（occured）" },
  { ja: "当該事業は、報告セグメントとして区分して管理している。",
    en: "This business is managed as a seperate reportable segment.",
    quote: "managed as a seperate reportable segment", why: "separate の綴り誤り（seperate）" },
  { ja: "生産設備の維持管理に係る費用は、発生時に費用処理している。",
    en: "Maintainance costs for production facilities are expensed as incurred.",
    quote: "Maintainance costs for production facilities", why: "Maintenance の綴り誤り（Maintainance）" },
  { ja: "需要の増加に対応するため、生産能力を増強した。",
    en: "The Group expanded its production capacity in order to accomodate the increase in demand.",
    quote: "accomodate the increase in demand", why: "accommodate の綴り誤り（accomodate）" },
  { ja: "当社は、必要な安全対策を講じている。",
    en: "The Company has taken the neccessary safety measures.",
    quote: "taken the neccessary safety measures", why: "necessary の綴り誤り（neccessary）" },
  { ja: "当該方針は、当連結会計年度の期首から適用している。",
    en: "This policy has been applied from the begining of the current consolidated fiscal year.",
    quote: "from the begining of the current consolidated fiscal year", why: "beginning の綴り誤り（begining）" },
  { ja: "調達を担当する部門が、供給元の評価を行っている。",
    en: "The department responsable for procurement evaluates its suppliers.",
    quote: "The department responsable for procurement", why: "responsible の綴り誤り（responsable）" },
];

const GRAMMAR = [
  { ja: "当社は、関係法令の遵守を徹底している。",
    en: "The Company have thoroughly complied with the relevant laws and regulations.",
    quote: "The Company have thoroughly complied", why: "単数主語 The Company に対する動詞が have（主述不一致）" },
  { ja: "従業員数は、翌連結会計年度において増加する見込みである。",
    en: "The number of employees are expected to increase in the next consolidated fiscal year.",
    quote: "The number of employees are expected", why: "The number of 〜 は単数扱い（are → is）" },
  { ja: "各生産拠点は、環境マネジメント規格の認証を取得している。",
    en: "Each of the production bases have obtained environmental management certification.",
    quote: "Each of the production bases have obtained", why: "Each of 〜 は単数扱い（have → has）" },
  { ja: "取締役会は、翌年度の予算を承認した。",
    en: "The Board of Directors have approved the budget for the next fiscal year.",
    quote: "The Board of Directors have approved", why: "機関としての Board は単数扱い（have → has）" },
  { ja: "これらの施策は、当連結会計年度の下期に実施した。",
    en: "This measures were implemented in the second half of the current consolidated fiscal year.",
    quote: "This measures were implemented", why: "指示語と名詞の数が不一致（This → These）" },
  { ja: "アジア地域の売上高は、過去3年間で着実に増加している。",
    en: "The Group's net sales in Asia has grown steadily over the past three years.",
    quote: "net sales in Asia has grown steadily", why: "net sales は複数扱い（has → have）" },
  { ja: "両者の間に重要な差異はない。",
    en: "There is no significant differences between the two methods.",
    quote: "There is no significant differences", why: "There is に複数名詞（is → are）" },
  { ja: "減損の兆候に関する判定結果は、経理部門が確認している。",
    en: "The results of the impairment indicator assessment was reviewed by the accounting department.",
    quote: "assessment was reviewed by the accounting department", why: "主語は The results（複数）なので was → were" },
];

const OMISSION = [
  { ja: "なお、当該取組みの効果は翌連結会計年度以降に発現する見込みである。ただし、その時期及び金額は現時点で確定していない。",
    en: "The effects of these initiatives are expected to materialize from the next consolidated fiscal year onward.",
    quote: "expected to materialize from the next consolidated fiscal year onward",
    why: "REF の「ただし、その時期及び金額は現時点で確定していない」が丸ごと訳抜け" },
  { ja: "当該金額は、取締役会の決議に基づいて算定している。なお、当該金額には消費税等は含まれていない。",
    en: "This amount is calculated based on a resolution of the Board of Directors.",
    quote: "This amount is calculated based on a resolution",
    why: "REF の「なお、当該金額には消費税等は含まれていない」が訳抜け" },
  { ja: "当該方針は、当連結会計年度において変更していない。この方針は、翌連結会計年度においても継続する予定である。",
    en: "This policy was not changed during the current consolidated fiscal year.",
    quote: "This policy was not changed during the current consolidated fiscal year",
    why: "REF の「翌連結会計年度においても継続する予定である」が訳抜け" },
  { ja: "当該取引は、通常の取引条件に基づいて行っている。また、当該取引に関する担保の提供はない。",
    en: "These transactions are conducted on ordinary trading terms.",
    quote: "These transactions are conducted on ordinary trading terms",
    why: "REF の「当該取引に関する担保の提供はない」が訳抜け" },
  { ja: "当該見積りは、過去の実績に基づいて算定している。当該見積りは、将来の市場環境の変化により変動する可能性がある。",
    en: "These estimates are calculated based on past results.",
    quote: "These estimates are calculated based on past results",
    why: "REF の「将来の市場環境の変化により変動する可能性がある」が訳抜け" },
  { ja: "当該契約の期間は5年である。なお、当該契約に基づく支払は、四半期ごとに行われる。",
    en: "The term of this contract is five years.",
    quote: "The term of this contract is five years",
    why: "REF の「当該契約に基づく支払は、四半期ごとに行われる」が訳抜け" },
  { ja: "これらの数値は、社内管理資料に基づいて算定している。これらの数値は、監査手続の対象外である。",
    en: "These figures are calculated based on internal management materials.",
    quote: "These figures are calculated based on internal management materials",
    why: "REF の「これらの数値は、監査手続の対象外である」が訳抜け" },
];

export const LINE_ERRORS = (() => {
  const banks = [["spelling", SPELLING], ["grammar", GRAMMAR], ["omission", OMISSION]];
  const used = { spelling: 0, grammar: 0, omission: 0 };
  const out = [];
  let n = 0;
  for (let page = 4; page <= 136; page += 6) {
    const [kind, bank] = banks[n % banks.length];
    const v = bank[used[kind]++];
    if (!v) throw new Error(`${kind} の文例が足りない（${used[kind]}件目）`);
    out.push({
      id: `L${String(page).padStart(3, "0")}`, enPage: page, kind,
      jaAdd: `<p>${v.ja}</p>`, enAdd: `<p>${v.en}</p>`, quote: v.quote, why: v.why,
    });
    n++;
  }
  return out;
})();

// =====================================================================
// A: 翻訳校正（REF が正。同一ページで完結する誤り）
// =====================================================================
//
// 幅の実験（B）とは別に、「日本語が数字を含めてきちんと英訳されているか」を測る。
// これが無いと、実務で一番効く観点がベンチマークに1件も入っていないことになる。
//
//   num-tr   数値の誤訳（桁・単位・スケール・年・符号・％）
//   name-tr  固有名詞・地名・部署名・日付の誤訳
//   supply   日本語が言外に置いた要素（主語など）を補えていない逐語訳
//   over     原文にない情報を足している（補い過ぎ）
//
// diffNums: 日英で意図的に食い違わせた数値。生成時の「日英の数値が一致するか」検査から除く。
export const LOCAL_ERRORS = [
  { id: "t012", enPage: 12, kind: "num-tr", lens: "numbers", diffNums: ["312", "321"],
    ja: "当連結会計年度の研究開発人員は312人である。",
    en: "The number of research and development personnel for the current consolidated fiscal year was 321.",
    quote: "research and development personnel for the current consolidated fiscal year was 321",
    why: "REF 312人 → 321（桁の入れ替え）" },

  { id: "t031", enPage: 31, kind: "num-tr", lens: "numbers", diffNums: [],
    ja: "当該設備の年間維持費は48百万円である。",
    en: "The annual maintenance cost of this equipment is 48 thousand yen.",
    quote: "annual maintenance cost of this equipment is 48 thousand yen",
    why: "REF「48百万円」→ 48 thousand yen（単位が千円になっている）" },

  { id: "t047", enPage: 47, kind: "num-tr", lens: "numbers", diffNums: [],
    ja: "当該補助金の総額は12億円である。",
    en: "The total amount of this subsidy is 12 million yen.",
    quote: "The total amount of this subsidy is 12 million yen",
    why: "REF「12億円」→ 12 million yen（正しくは 1.2 billion yen。桁が2つ違う）" },

  { id: "t068", enPage: 68, kind: "num-tr", lens: "numbers", diffNums: ["2019", "2016"],
    ja: "当該基本契約は2019年に締結した。",
    en: "This basic agreement was concluded in 2016.",
    quote: "This basic agreement was concluded in 2016",
    why: "REF 2019年 → 2016（年の誤り）" },

  { id: "t090", enPage: 90, kind: "num-tr", lens: "numbers", diffNums: [],
    ja: "当該調整項目は△2,400百万円である。",
    en: "This adjustment item was 2,400 million yen.",
    quote: "This adjustment item was 2,400 million yen",
    why: "REF は△（マイナス）だが英訳で符号が落ちている" },

  { id: "t117", enPage: 117, kind: "num-tr", lens: "numbers", diffNums: ["9.4", "4.9"],
    ja: "当該引当金の計上率は9.4%である。",
    en: "The recording rate of this provision is 4.9%.",
    quote: "The recording rate of this provision is 4.9%",
    why: "REF 9.4% → 4.9%（数字の入れ替え）" },

  { id: "t019", enPage: 19, kind: "name-tr", lens: "names", diffNums: [],
    ja: "当該計測設備は株式会社アオイ計測が管理している。",
    en: "This measuring equipment is managed by Aoi Seiki Measurement Co., Ltd.",
    quote: "managed by Aoi Seiki Measurement Co., Ltd.",
    why: "社名が誤り。正しくは Aoi Measurement Co., Ltd.（Seiki が混入）" },

  { id: "t055", enPage: 55, kind: "name-tr", lens: "names", diffNums: [],
    ja: "当該保守拠点は茨城県水戸市に所在する。",
    en: "This service base is located in Mito, Tochigi Prefecture.",
    quote: "located in Mito, Tochigi Prefecture",
    why: "REF「茨城県」→ Tochigi Prefecture（県名の誤り）" },

  { id: "t084", enPage: 84, kind: "name-tr", lens: "names", diffNums: [],
    ja: "本件に関する窓口は経営企画部IR課である。",
    en: "The contact for this matter is the Corporate Planning Department, PR Section.",
    quote: "Corporate Planning Department, PR Section",
    why: "REF「IR課」→ PR Section（部署名の誤り）" },

  { id: "t126", enPage: 126, kind: "name-tr", lens: "names", diffNums: ["26", "16"],
    ja: "次回の定時株主総会は2026年6月26日に開催する予定である。",
    en: "The next ordinary general meeting of shareholders is scheduled to be held on June 16, 2026.",
    quote: "scheduled to be held on June 16, 2026",
    why: "REF 6月26日 → June 16（日付の誤り）" },

  { id: "t026", enPage: 26, kind: "supply", lens: "ellipsis", diffNums: [],
    ja: "電子部品事業の収益性は回復傾向にある。前連結会計年度と比べ、大幅に改善した。",
    en: "The profitability of the Electronic Components business is on a recovery trend. Improved significantly compared with the previous consolidated fiscal year.",
    quote: "Improved significantly compared with the previous consolidated fiscal year.",
    why: "日本語が省いた主語（収益性）を補えておらず、英文に主語が無い" },

  { id: "t062", enPage: 62, kind: "supply", lens: "ellipsis", diffNums: [],
    ja: "技術者の確保は当社グループの重要な課題である。今後も継続して取り組んでまいります。",
    en: "Securing engineers is an important issue for the Group. Will continue to work on it going forward.",
    quote: "Will continue to work on it going forward.",
    why: "日本語が省いた主語（当社グループ）を補えておらず、英文に主語が無い" },

  { id: "t097", enPage: 97, kind: "supply", lens: "ellipsis", diffNums: [],
    ja: "出荷判定会議は毎週開催している。品質保証部門と協議のうえ、出荷の可否を決定している。",
    en: "The shipment review meeting is held weekly. Decides whether shipment is possible after consultation with the quality assurance department.",
    quote: "Decides whether shipment is possible after consultation",
    why: "日本語が省いた主語（出荷判定会議）を補えておらず、英文に主語が無い" },

  { id: "t133", enPage: 133, kind: "supply", lens: "ellipsis", diffNums: [],
    ja: "当該基準は事業環境の変化を踏まえて定めている。必要に応じて見直すこととしている。",
    en: "These criteria are established in light of changes in the business environment. Will be reviewed as necessary.",
    quote: "Will be reviewed as necessary.",
    why: "日本語が省いた主語（当該基準）を補えておらず、英文に主語が無い" },

  { id: "t044", enPage: 44, kind: "over", lens: "translation", diffNums: ["2"],
    ja: "当該費用の増加は一時的なものである。",
    en: "The increase in this expense is temporary and is expected to be resolved within the next two quarters.",
    quote: "expected to be resolved within the next two quarters",
    why: "REF にない見通し（2四半期以内に解消）を英訳が付け加えている" },

  { id: "t105", enPage: 105, kind: "over", lens: "translation", diffNums: ["3"],
    ja: "当該引当金は合理的に見積もっている。",
    en: "This provision is reasonably estimated based on the past three years of actual results.",
    quote: "based on the past three years of actual results",
    why: "REF にない根拠（過去3年の実績）を英訳が付け加えている" },
];

// =====================================================================
// B3: 会計連動の跨ぎ不整合（原文と訳文の両方に同じ矛盾がある）
// =====================================================================
//
// 内訳の合計が別ページの総計と合わない。数値をただ突き合わせるだけでは出ず、
// 勘定科目の関係を理解して初めて出る。26ページ版では測れていた能力なので戻す。
export const ACCOUNTING_PAIRS = [
  { id: "a006", distance: 6, breakdownEnPage: 30, totalEnPage: 36,
    jaBreak: "販売費及び一般管理費の内訳は、人件費38,200百万円、減価償却費6,400百万円、その他28,900百万円である。",
    enBreak: "The breakdown of selling, general and administrative expenses is personnel expenses of 38,200 million yen, depreciation of 6,400 million yen, and other expenses of 28,900 million yen.",
    jaTotal: "当連結会計年度の販売費及び一般管理費の合計は74,071百万円である。",
    enTotal: "Total selling, general and administrative expenses for the current consolidated fiscal year were 74,071 million yen.",
    quote: "personnel expenses of 38,200 million yen, depreciation of 6,400 million yen, and other expenses of 28,900 million yen",
    altQuote: "Total selling, general and administrative expenses for the current consolidated fiscal year were 74,071 million yen",
    why: "内訳の合計 73,500 が p36 の総計 74,071 と合わない（差 571）。原文にも同じ矛盾がある" },

  { id: "a009", distance: 9, breakdownEnPage: 89, totalEnPage: 98,
    jaBreak: "法人税等の内訳は、法人税5,900百万円、住民税1,100百万円、事業税1,400百万円である。",
    enBreak: "The breakdown of income taxes is corporate tax of 5,900 million yen, inhabitant tax of 1,100 million yen, and enterprise tax of 1,400 million yen.",
    jaTotal: "当連結会計年度の法人税等合計は8,700百万円である。",
    enTotal: "Total income taxes for the current consolidated fiscal year were 8,700 million yen.",
    quote: "corporate tax of 5,900 million yen, inhabitant tax of 1,100 million yen, and enterprise tax of 1,400 million yen",
    altQuote: "Total income taxes for the current consolidated fiscal year were 8,700 million yen",
    why: "内訳の合計 8,400 が p98 の合計 8,700 と合わない（差 300）。原文にも同じ矛盾がある" },
];
