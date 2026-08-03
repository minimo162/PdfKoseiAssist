// fixture-content.mjs — 合成ベンチマーク文書（架空企業「株式会社アオイ精機」FY2025 有報抜粋）
//
// 目的: 実運用と同じ「日本語原文(REF) → 英訳(TARGET)」の構図で、**既知の誤りを意図的に埋め込んだ**
// 英訳を用意し、レビューの recall / precision を測れるようにする。
// 実データは人手校正済みで誤りがほぼ無く recall が測れないため、この合成文書で網羅性を測る。
//
// 各 entry = 日本語1ページ。英語は enPages で 2ページに割れることがある（日英のページズレを再現）。
// planted[] の quote は英語ページ中に**そのまま存在する文字列**でなければならない（builder が検証）。

export const DOC = {
  companyJa: "株式会社アオイ精機",
  companyEn: "Aoi Seiki Co., Ltd.",
  fiscalJa: "2026年3月期（第73期）",
  fiscalEn: "Fiscal Year Ended March 31, 2026 (73rd Term)",
};

// <!--SPLIT--> があるとその位置で英語ページを分割する。
export const ENTRIES = [
  {
    id: "cover",
    ja: `
      <h1>有価証券報告書</h1>
      <p class="lead">株式会社アオイ精機</p>
      <p class="lead">2026年3月期（第73期）<br>自 2025年4月1日 至 2026年3月31日</p>
      <p class="note">本書は開示用ドラフトであり、監査手続は完了していない。</p>`,
    en: `
      <h1>Annual Securities Report</h1>
      <p class="lead">Aoi Seiki Co., Ltd.</p>
      <p class="lead">Fiscal Year Ended March 31, 2026 (73rd Term)<br>From April 1, 2025 to March 31, 2026</p>
      <p class="note">This document is a disclosure draft and audit procedures have not been completed.</p>`,
  },
  {
    // EDINET様式の【表紙】。英訳版では省かれるのが通例なので **日本語のみ** のページとし、
    // 以降の日英ページ番号を意図的に1ずれさせる（ページ対応ズレの再現。誤りではない）。
    id: "edinet-cover",
    jaOnly: true,
    ja: `
      <h2>【表紙】</h2>
      <table class="fin">
        <tr><th>【提出書類】</th><td>有価証券報告書</td></tr>
        <tr><th>【根拠条文】</th><td>金融商品取引法第24条第1項</td></tr>
        <tr><th>【提出先】</th><td>関東財務局長</td></tr>
        <tr><th>【提出日】</th><td>2026年6月26日</td></tr>
        <tr><th>【事業年度】</th><td>第73期（自 2025年4月1日 至 2026年3月31日）</td></tr>
        <tr><th>【会社名】</th><td>株式会社アオイ精機</td></tr>
        <tr><th>【英訳名】</th><td>Aoi Seiki Co., Ltd.</td></tr>
        <tr><th>【代表者の役職氏名】</th><td>代表取締役社長　田中 健二</td></tr>
        <tr><th>【本店の所在の場所】</th><td>東京都港区芝浦四丁目8番12号</td></tr>
        <tr><th>【電話番号】</th><td>03-1234-5678（代表）</td></tr>
      </table>`,
    en: "",
  },
  {
    id: "toc",
    ja: `
      <h2>目次</h2>
      <table class="toc">
        <tr><td>第1 企業の概況</td><td>3</td></tr>
        <tr><td>&nbsp;&nbsp;1 沿革</td><td>3</td></tr>
        <tr><td>&nbsp;&nbsp;2 主要な経営指標等の推移</td><td>4</td></tr>
        <tr><td>&nbsp;&nbsp;3 事業の内容</td><td>5</td></tr>
        <tr><td>第2 事業の状況</td><td>6</td></tr>
        <tr><td>&nbsp;&nbsp;1 経営方針及び経営環境</td><td>6</td></tr>
        <tr><td>&nbsp;&nbsp;2 経営成績等の状況の分析</td><td>7</td></tr>
        <tr><td>&nbsp;&nbsp;3 キャッシュ・フローの状況</td><td>9</td></tr>
        <tr><td>&nbsp;&nbsp;4 事業等のリスク</td><td>10</td></tr>
        <tr><td>第3 設備の状況</td><td>12</td></tr>
        <tr><td>第4 提出会社の状況</td><td>13</td></tr>
        <tr><td>第5 経理の状況</td><td>16</td></tr>
      </table>`,
    en: `
      <h2>Table of Contents</h2>
      <table class="toc">
        <tr><td>Part 1 Overview of the Company</td><td>3</td></tr>
        <tr><td>&nbsp;&nbsp;1 Corporate History</td><td>3</td></tr>
        <tr><td>&nbsp;&nbsp;2 Trends in Major Management Indicators</td><td>4</td></tr>
        <tr><td>&nbsp;&nbsp;3 Description of Business</td><td>5</td></tr>
        <tr><td>Part 2 Business Overview</td><td>6</td></tr>
        <tr><td>&nbsp;&nbsp;1 Management Policy and Business Environment</td><td>6</td></tr>
        <tr><td>&nbsp;&nbsp;2 Analysis of Operating Results</td><td>7</td></tr>
        <tr><td>&nbsp;&nbsp;3 Status of Cash Flows</td><td>9</td></tr>
        <tr><td>&nbsp;&nbsp;4 Business and Other Risks</td><td>10</td></tr>
        <tr><td>Part 3 Property, Plant and Equipment</td><td>12</td></tr>
        <tr><td>Part 4 Information about the Reporting Company</td><td>13</td></tr>
        <tr><td>Part 5 Financial Information</td><td>16</td></tr>
      </table>`,
  },
  {
    id: "history",
    ja: `
      <h2>第1 企業の概況</h2>
      <h3>1 沿革</h3>
      <p>当社は、1953年3月に精密部品の製造販売を目的として大阪府に設立された。1968年に本社を東京都へ移転し、
      1972年に東京証券取引所市場第二部へ上場、1981年に同市場第一部へ指定替えとなった。</p>
      <p>1995年に連結子会社である株式会社アオイ精機テクノを設立し、産業機械分野へ本格参入した。2010年にタイ王国へ
      生産拠点を新設、2018年には欧州販売子会社 Aoi Seiki Europe GmbH を設立し、海外売上高比率は当連結会計年度末で
      38.4%となっている。</p>
      <p>2022年4月の東京証券取引所の市場区分見直しに伴い、プライム市場へ移行した。</p>`,
    en: `
      <h2>Part 1 Overview of the Company</h2>
      <h3>1 Corporate History</h3>
      <p>The Company was established in Osaka Prefecture in March 1935 for the purpose of manufacturing and selling
      precision components. In 1968, the head office was relocated to Tokyo, and in 1972 the Company was listed on the
      Second Section of the Tokyo Stock Exchange, and was reassigned to the First Section of the same exchange in 1981.</p>
      <p>In 1995, the Company established Aoi Seiki Techno Co., Ltd., a consolidated subsidiary, and made a full-scale
      entry into the industrial machinery field. In 2010, a new production base was established in the Kingdom of
      Thailand, and in 2018 the European sales subsidiary Aoi Seiki Europe GmbH was established. The ratio of overseas
      net sales was 38.4% as of the end of the current consolidated fiscal year.</p>
      <p>In connection with the review of market segments by the Tokyo Stock Exchange in April 2022, the Company shifted
      to the Prime Market.</p>`,
  },
  {
    id: "indicators",
    ja: `
      <h3>2 主要な経営指標等の推移</h3>
      <table class="fin">
        <tr><th>回次</th><th>第69期</th><th>第70期</th><th>第71期</th><th>第72期</th><th>第73期</th></tr>
        <tr><th>決算年月</th><td>2022年3月</td><td>2023年3月</td><td>2024年3月</td><td>2025年3月</td><td>2026年3月</td></tr>
        <tr><th>売上高（百万円）</th><td>361,400</td><td>388,250</td><td>402,110</td><td>428,090</td><td>458,921</td></tr>
        <tr><th>営業利益（百万円）</th><td>18,900</td><td>22,140</td><td>25,880</td><td>28,600</td><td>32,450</td></tr>
        <tr><th>親会社株主に帰属する当期純利益（百万円）</th><td>12,300</td><td>14,900</td><td>17,220</td><td>19,050</td><td>21,880</td></tr>
        <tr><th>純資産額（百万円）</th><td>186,400</td><td>198,700</td><td>212,300</td><td>228,900</td><td>247,510</td></tr>
        <tr><th>総資産額（百万円）</th><td>498,200</td><td>521,900</td><td>544,600</td><td>566,800</td><td>585,200</td></tr>
        <tr><th>自己資本比率（%）</th><td>37.4</td><td>38.1</td><td>39.0</td><td>40.4</td><td>42.3</td></tr>
        <tr><th>1株当たり配当額（円）</th><td>28</td><td>32</td><td>36</td><td>40</td><td>45</td></tr>
        <tr><th>従業員数（人）</th><td>2,880</td><td>2,960</td><td>3,050</td><td>3,140</td><td>3,214</td></tr>
      </table>
      <p class="note">（注）1 売上高には消費税等は含まれていない。<br>
      （注）2 従業員数は就業人員数であり、臨時従業員は含まれていない。</p>`,
    en: `
      <h3>2 Trends in Major Management Indicators</h3>
      <table class="fin">
        <tr><th>Term</th><th>69th</th><th>70th</th><th>71st</th><th>72nd</th><th>73rd</th></tr>
        <tr><th>Fiscal year ended</th><td>Mar. 2022</td><td>Mar. 2023</td><td>Mar. 2024</td><td>Mar. 2025</td><td>Mar. 2026</td></tr>
        <tr><th>Net sales (Millions of yen)</th><td>361,400</td><td>388,250</td><td>402,110</td><td>428,090</td><td>459,921</td></tr>
        <tr><th>Operating income (Millions of yen)</th><td>18,900</td><td>22,140</td><td>25,880</td><td>28,600</td><td>32,450</td></tr>
        <tr><th>Profit attributable to owners of parent (Millions of yen)</th><td>12,300</td><td>14,900</td><td>17,220</td><td>19,050</td><td>21,880</td></tr>
        <tr><th>Net assets (Millions of yen)</th><td>186,400</td><td>198,700</td><td>212,300</td><td>228,900</td><td>247,510</td></tr>
        <tr><th>Total assets (Millions of yen)</th><td>498,200</td><td>521,900</td><td>544,600</td><td>566,800</td><td>585,200</td></tr>
        <tr><th>Shareholders' equity ratio (%)</th><td>37.4</td><td>38.1</td><td>39.0</td><td>40.4</td><td>42.3</td></tr>
        <tr><th>Dividend per share (Yen)</th><td>28</td><td>32</td><td>36</td><td>40</td><td>54</td></tr>
        <tr><th>Number of employees</th><td>2,880</td><td>2,960</td><td>3,050</td><td>3,140</td><td>3,214</td></tr>
      </table>
      <p class="note">(Note) 1 Net sales do not include consumption taxes.<br>
      (Note) 2 The number of employees is the number of persons at work.</p>`,
  },
  {
    id: "business",
    ja: `
      <h3>3 事業の内容</h3>
      <p>当社グループは、当社、連結子会社12社及び持分法適用関連会社3社で構成され、産業機械事業、精密機器事業
      及びその他事業の3事業を営んでいる。</p>
      <p>産業機械事業においては、工作機械及び搬送装置の製造販売を行っている。主要な連結子会社は株式会社アオイ精機テクノである。</p>
      <p>精密機器事業においては、半導体製造装置向け精密部品の製造販売を行っている。当連結会計年度において、
      当該事業の売上高は前期比8.9%増加している。</p>
      <p>その他事業においては、保守サービス及び部品販売を行っている。</p>`,
    en: `
      <h3>3 Description of Business</h3>
      <p>Our company group consists of the Company, 12 consolidated subsidiaries and 3 equity-method subsidiaries, and
      operates three businesses: the Industrial Machinery business, the Precision Equipment business and the Other business.</p>
      <p>In the Industrial Machinery business, the Group manufactures and sells machine tools and conveyance equipment.
      The principal affiliated company is Aoi Seiki Techno Co., Ltd.</p>
      <p>In the Precision Equipment business, the Group manufactures and sells precision components for semiconductor
      manufacturing equipment. In the current consolidated fiscal year, revenue of this business increased 8.9% year on year.</p>
      <p>In the Other business, the Group provides maintenance services and sells parts.</p>`,
  },
  {
    id: "policy",
    ja: `
      <h2>第2 事業の状況</h2>
      <h3>1 経営方針及び経営環境</h3>
      <p>当社グループは「精密で社会を支える」を経営理念に掲げ、中期経営計画「AOI Vision 2028」に基づき、
      収益基盤の強化と成長投資の両立を図っている。</p>
      <p>当連結会計年度における世界経済は、地政学リスクの高まりと為替の変動があったものの、設備投資需要は総じて堅調に推移した。</p>
      <p>このような環境の下、生産効率の改善と価格転嫁の進展により、収益性は前期比で大幅に改善した。</p>
      <p>資本コストを意識した経営の実現に向け、今後も引き続き取り組んでまいります。</p>`,
    en: `
      <h2>Part 2 Business Overview</h2>
      <h3>1 Management Policy and Business Environment</h3>
      <p>The Group has adopted "Supporting society through precision" as its management philosophy and, based on the
      medium-term management plan "AOI Vision 2028," is working to both strengthen its earnings base and invest for growth.</p>
      <p>In the current consolidated fiscal year, the world economy saw heightened geopolitical risk and foreign exchange
      volatility, but capital investment demand remained generally firm.</p>
      <p>Under these circumstances, improved significantly year on year due to improvements in production efficiency and
      progress in passing on prices.</p>
      <p>Will continue to work on it going forward toward the realization of management conscious of the cost of capital.</p>`,
  },
  {
    id: "results",
    ja: `
      <h3>2 経営成績等の状況の分析</h3>
      <h4>(1) 経営成績</h4>
      <p>当連結会計年度の売上高は458,921百万円（前期比7.2%増）、営業利益は32,450百万円（同13.5%増）、
      親会社株主に帰属する当期純利益は21,880百万円（同14.9%増）となった。</p>
      <p>セグメント別の売上高は、産業機械事業210,000百万円、精密機器事業180,000百万円、その他事業68,921百万円である。</p>
      <p>なお、当連結会計年度において、産業機械事業の遊休資産について減損損失1,200百万円を特別損失に計上している。</p>
      <h4>(2) 財政状態</h4>
      <p>当連結会計年度末の総資産は585,200百万円となり、前連結会計年度末に比べ18,400百万円増加した。
      自己資本比率は42.3%となった。</p>`,
    en: `
      <h3>2 Analysis of Operating Results</h3>
      <h4>(1) Operating Results</h4>
      <p>Net sales for the current consolidated fiscal year were 458,921 million yen (up 7.2% year on year), operating
      income was 32,450 million yen (up 13.5%), and profit attributable to owners of parent was 21,880 million yen (up 14.9%).</p>
      <p>Sales by segment were 210,000 million yen for the Industrial Machinery business, 180,000 million yen for the
      Precision Equipment business, and 68,921 million yen for the Other business.</p>
      <p>In addition, no impairment loss on fixed assets was recorded in the current consolidated fiscal year.</p>
      <h4>(2) Financial Position</h4>
      <p>Total assets at the end of the current consolidated fiscal year were 585,200 million yen, an increase of
      18,400 million yen from the end of the previous consolidated fiscal year. The shareholders' equity ratio was 42.8%.</p>`,
  },
  {
    id: "results2",
    ja: `
      <h4>(3) 生産、受注及び販売の実績</h4>
      <p>当連結会計年度の受注高は471,300百万円、受注残高は128,700百万円となった。受注残高は前連結会計年度末に比べ
      12,400百万円増加している。</p>
      <table class="fin">
        <tr><th>セグメント</th><th>受注高（百万円）</th><th>受注残高（百万円）</th></tr>
        <tr><td>産業機械事業</td><td>216,500</td><td>74,200</td></tr>
        <tr><td>精密機器事業</td><td>184,300</td><td>41,900</td></tr>
        <tr><td>その他事業</td><td>70,500</td><td>12,600</td></tr>
        <tr><th>合計</th><th>471,300</th><th>128,700</th></tr>
      </table>
      <p>販売実績のうち、主要な相手先である三葉電機株式会社に対する売上高は52,400百万円であり、
      総売上高に対する割合は11.4%である。</p>`,
    en: `
      <h4>(4) Results of Production, Orders Received and Sales</h4>
      <p>Orders received in the current consolidated fiscal year were 471,300 million yen, and the order backlog was
      128,700 million yen. The order backlog increased by 12,400 million yen from the end of the previous consolidated
      fiscal year.</p>
      <table class="fin">
        <tr><th>Segment</th><th>Orders received (Millions of yen)</th><th>Order backlog (Millions of yen)</th></tr>
        <tr><td>Industrial Machinery</td><td>216,500</td><td>74,200</td></tr>
        <tr><td>Precision Equipment</td><td>184,300</td><td>41,900</td></tr>
        <tr><td>Other</td><td>70,500</td><td>12,600</td></tr>
        <tr><th>Total</th><th>471,300</th><th>128,700</th></tr>
      </table>
      <p>Among sales results, net sales to Mitsuba Electric Co., Ltd., a major customer, were 52,400 million yen,
      accounting for 11.4% of total net sales.</p>`,
  },
  {
    id: "cashflow",
    ja: `
      <h3>3 キャッシュ・フローの状況</h3>
      <p>当連結会計年度における営業活動によるキャッシュ・フローは41,200百万円の収入、投資活動によるキャッシュ・フローは
      18,500百万円の支出、財務活動によるキャッシュ・フローは12,300百万円の支出となった。</p>
      <p>この結果、現金及び現金同等物の期末残高は前連結会計年度末に比べ10,400百万円増加し、
      86,900百万円となった。</p>
      <p>営業活動によるキャッシュ・フローの主な増加要因は、税金等調整前当期純利益30,900百万円及び減価償却費19,800百万円である。</p>
      <p>設備投資額は22,600百万円であり、主に精密機器事業の生産能力増強に充当している。</p>`,
    en: `
      <h3>3 Status of Cash Flows</h3>
      <p>In the current consolidated fiscal year, net cash provided by operating activities was 41,200 million yen,
      net cash used in investing activities was 18,500 million yen, and net cash used in financing activities was
      13,300 million yen.</p>
      <p>As a result, cash and cash equivalents at the end of the period increased by 10,400 million yen from the end of
      the previous consolidated fiscal year to 86,900 million yen.</p>
      <p>The main factors behind the increase in cash flows from operating activities were profit before income taxes of
      30,900 million yen and depreciation of 19,800 million yen.</p>
      <p>Capital expenditure was 22,600 million yen, mainly allocated to expanding production capacity in the Precision
      Equipment business.</p>`,
  },
  {
    id: "risk1",
    ja: `
      <h3>4 事業等のリスク</h3>
      <p>当社グループの事業展開上、投資者の判断に重要な影響を及ぼす可能性のある事項には、以下のものがある。
      なお、文中の将来に関する事項は、当連結会計年度末現在において判断したものである。</p>
      <h4>(1) 景気変動リスク</h4>
      <p>当社グループの製品需要は、顧客の設備投資動向に大きく左右される。世界的な景気後退が生じた場合、
      受注の減少により業績及び財政状態に影響を及ぼす可能性がある。</p>
      <h4>(2) 為替変動リスク</h4>
      <p>海外売上高比率が高いため、為替相場の変動は業績に影響を及ぼす可能性がある。
      当社グループは為替予約等によりリスクの一部を軽減しているが、その全てを回避できるものではない。</p>
      <h4>(3) 原材料価格変動リスク</h4>
      <p>鋼材及び電子部品の価格が急激に上昇した場合、製造原価の増加により採算が悪化する可能性がある。
      当社グループは複数購買及び価格転嫁により影響の緩和を図っている。</p>`,
    en: `
      <h3>4 Business and Other Risks</h3>
      <p>The following are matters that may have a material impact on investors' decisions in the course of the Group's
      business development. Forward-looking statements in the text are based on judgments made as of the end of the
      current consolidated fiscal year.</p>
      <h4>(1) Risk of Economic Fluctuations</h4>
      <p>Demand for the Group's products is greatly affected by trends in customers' capital investment. If a global
      economic downturn occurs, a decrease in orders received may affect the Group's business results and financial position.</p>
      <h4>(2) Foreign Exchange Risk</h4>
      <p>Because the ratio of overseas net sales is high, fluctuations in foreign exchange rates may affect business results.</p>
      <h4>(3) Raw Material Price Risk</h4>
      <p>If the prices of steel and electronic components rise sharply, profitability may deteriorate due to an increase
      in manufacturing costs. The Group seeks to mitigate the impact through multiple sourcing and price pass-through.</p>`,
  },
  {
    id: "risk2",
    ja: `
      <h4>(4) 特定顧客への依存リスク</h4>
      <p>当社グループの売上高のうち、上位5社に対する割合は34.8%である。これら顧客の購買方針の変更により、
      受注が減少する可能性がある。</p>
      <h4>(5) 情報セキュリティリスク</h4>
      <p>サイバー攻撃により生産システムが停止した場合、納期遅延及び補償費用が発生する可能性がある。
      当社グループは監視体制を強化し、外部専門機関による診断を毎年受けている。</p>
      <h4>(6) 品質リスク</h4>
      <p>製品に重大な欠陥が生じた場合、リコール費用及び信用の低下により業績に影響を及ぼす可能性がある。</p>
      <p>なお、当連結会計年度において重大な品質問題は発生していない。当該影響は軽微である。</p>
      <p>これらのリスクへの対応状況については、取締役会が四半期ごとに報告を受け、必要な指示を行っている。</p>`,
    en: `
      <h4>(4) Risk of Dependence on Specific Customers</h4>
      <p>Sales to the top five customers accounted for 34.8% of the Group's net sales. Changes in the purchasing policies
      of these customers may cause orders received to decrease.</p>
      <h4>(5) Information Security Risk</h4>
      <p>If production systems are halted by a cyber attack, delivery delays and compensation costs may arise. The Group
      has strengthened its monitoring system and recieve an annual assessment by an external specialist organization.</p>
      <h4>(6) Quality Risk</h4>
      <p>If a serious defect occurs in a product, recall costs and loss of confidence may affect business results.</p>
      <p>In addition, no serious quality problems occurred in the current consolidated fiscal year. The effect is minor.</p>
      <p>Regarding the status of responses to these risks, the Board of Directors receives quarterly reports and gives
      necessary instructions.</p>`,
  },
  {
    id: "property",
    ja: `
      <h2>第3 設備の状況</h2>
      <h3>1 主要な設備の状況</h3>
      <table class="fin">
        <tr><th>事業所名</th><th>セグメント</th><th>建物及び構築物（百万円）</th><th>機械装置（百万円）</th><th>従業員数（人）</th></tr>
        <tr><td>本社（東京都）</td><td>全社</td><td>8,400</td><td>120</td><td>420</td></tr>
        <tr><td>厚木工場（神奈川県）</td><td>産業機械</td><td>19,600</td><td>28,300</td><td>980</td></tr>
        <tr><td>諏訪工場（長野県）</td><td>精密機器</td><td>14,200</td><td>31,700</td><td>860</td></tr>
        <tr><td>タイ工場</td><td>産業機械</td><td>9,800</td><td>12,400</td><td>720</td></tr>
        <tr><th>合計</th><th>—</th><th>52,000</th><th>72,520</th><th>2,980</th></tr>
      </table>
      <h3>2 設備の新設、除却等の計画</h3>
      <p>当連結会計年度末現在における重要な設備の新設計画は、諏訪工場の第3棟増設（投資予定額14,000百万円、
      2027年6月完成予定）である。</p>`,
    en: `
      <h2>Part 3 Property, Plant and Equipment</h2>
      <h3>1 Major Facilities</h3>
      <table class="fin">
        <tr><th>Office / Plant</th><th>Segment</th><th>Buildings and structures (Thousands of yen)</th><th>Machinery (Thousands of yen)</th><th>Employees</th></tr>
        <tr><td>Head Office (Tokyo)</td><td>Company-wide</td><td>8,400</td><td>120</td><td>420</td></tr>
        <tr><td>Atsugi Plant (Kanagawa)</td><td>Industrial Machinery</td><td>19,600</td><td>28,300</td><td>980</td></tr>
        <tr><td>Suwa Plant (Nagano)</td><td>Precision Equipment</td><td>14,200</td><td>31,700</td><td>860</td></tr>
        <tr><td>Thailand Plant</td><td>Industrial Machinery</td><td>9,800</td><td>12,400</td><td>720</td></tr>
        <tr><th>Total</th><th>—</th><th>52,000</th><th>72,520</th><th>2,980</th></tr>
      </table>
      <h3>2 Plans for New Installation and Retirement of Facilities</h3>
      <p>As of the end of the current consolidated fiscal year, the significant plan for new facilities is the expansion
      of Building No. 3 at the Suwa Plant (planned investment of 14,000 million yen, scheduled for completion in June 2027).</p>`,
  },
  {
    id: "shares",
    ja: `
      <h2>第4 提出会社の状況</h2>
      <h3>1 株式等の状況</h3>
      <p>発行可能株式総数は400,000,000株、発行済株式総数は148,600,000株である。当連結会計年度において
      発行済株式総数の変動はない。</p>
      <table class="fin">
        <tr><th>株主名</th><th>所有株式数（千株）</th><th>所有割合（%）</th></tr>
        <tr><td>日本マスタートラスト信託銀行株式会社</td><td>18,900</td><td>12.7</td></tr>
        <tr><td>株式会社日本カストディ銀行</td><td>13,400</td><td>9.0</td></tr>
        <tr><td>三葉電機株式会社</td><td>7,200</td><td>4.8</td></tr>
        <tr><td>アオイ精機従業員持株会</td><td>4,100</td><td>2.8</td></tr>
      </table>
      <p>当連結会計年度末現在の株主数は18,420名である。</p>`,
    en: `
      <h2>Part 4 Information about the Reporting Company</h2>
      <h3>1 Information on Shares</h3>
      <p>The total number of authorized shares is 400,000,000 and the total number of issued shares is 148,600,000.
      There was no change in the total number of issued shares during the current consolidated fiscal year.</p>
      <table class="fin">
        <tr><th>Name of shareholder</th><th>Shares held (Thousands)</th><th>Ownership ratio (%)</th></tr>
        <tr><td>The Master Trust Bank of Japan, Ltd.</td><td>18,900</td><td>12.7</td></tr>
        <tr><td>Custody Bank of Japan, Ltd.</td><td>13,400</td><td>9.0</td></tr>
        <tr><td>Mitsuba Electric Co., Ltd.</td><td>7,200</td><td>4.8</td></tr>
        <tr><td>Aoi Seiki Employee Shareholding Association</td><td>4,100</td><td>2.8</td></tr>
      </table>
      <p>The number of shareholders as of the end of the current consolidated fiscal year was 18,420.</p>`,
  },
  {
    id: "dividend",
    ja: `
      <h3>2 配当政策</h3>
      <p>当社は、株主への利益還元を経営の重要課題と位置づけ、連結配当性向30%を目安として安定的な配当を継続することを
      基本方針としている。</p>
      <p>当連結会計年度の1株当たり配当額は年間45円（中間22円、期末23円）とした。前連結会計年度の年間配当額は40円であり、
      5円の増配となる。</p>
      <p>内部留保資金については、成長分野への設備投資及び研究開発投資に充当する方針である。</p>
      <p>当社は、会社法第459条第1項の規定に基づき、取締役会の決議によって剰余金の配当を行うことができる旨を
      定款に定めている。</p>`,
    en: `
      <h3>2 Dividend Policy</h3>
      <p>The Company positions the return of profits to shareholders as an important management issue, and its basic
      policy is to continue stable dividends with a consolidated payout ratio of 30% as a guideline.</p>
      <p>The annual dividend per share for the current consolidated fiscal year was 45 yen (interim 22 yen, year-end 23 yen).
      The annual dividend for the previous consolidated fiscal year was 40 yen, representing an increase of 5 yen.</p>
      <p>The Company's policy is to allocate internal reserves to capital investment and research and development
      investment in growth fields.</p>
      <p>Pursuant to Article 459, Paragraph 1 of the Companies Act, the Company's Articles of Incorporation provide that
      dividends of surplus may be paid by resolution of the Board of Directors.</p>`,
  },
  {
    id: "officers",
    ja: `
      <h3>3 役員の状況</h3>
      <table class="fin">
        <tr><th>役職名</th><th>氏名</th><th>生年月</th><th>所有株式数（千株）</th></tr>
        <tr><td>代表取締役社長</td><td>田中 健二</td><td>1962年5月</td><td>62</td></tr>
        <tr><td>代表取締役副社長</td><td>森 由紀子</td><td>1965年11月</td><td>38</td></tr>
        <tr><td>取締役専務執行役員</td><td>大西 亮</td><td>1968年2月</td><td>24</td></tr>
        <tr><td>社外取締役</td><td>ロバート・キム</td><td>1959年8月</td><td>—</td></tr>
      </table>
      <h3>4 コーポレート・ガバナンスの状況</h3>
      <p>当社は監査等委員会設置会社であり、取締役8名のうち4名を社外取締役としている。
      取締役会は原則として毎月1回開催し、当連結会計年度は14回開催した。</p>`,
    en: `
      <h3>3 Directors and Officers</h3>
      <table class="fin">
        <tr><th>Position</th><th>Name</th><th>Date of birth</th><th>Shares held (Thousands)</th></tr>
        <tr><td>President and Representative Director</td><td>Kenji Tanaka</td><td>May 1962</td><td>62</td></tr>
        <tr><td>Executive Vice President and Representative Director</td><td>Yukiko Mori</td><td>November 1965</td><td>38</td></tr>
        <tr><td>Director and Senior Managing Executive Officer</td><td>Ryo Onishi</td><td>February 1968</td><td>24</td></tr>
        <tr><td>Outside Director</td><td>Robert Kim</td><td>August 1959</td><td>—</td></tr>
      </table>
      <h3>4 Status of Corporate Governance</h3>
      <p>The Company is a company with an audit and supervisory committee, and four of its eight directors are outside
      directors. The Board of Directors meets in principle once a month and met 14 times in the current consolidated
      fiscal year.</p>`,
  },
  {
    id: "fin-intro",
    ja: `
      <h2>第5 経理の状況</h2>
      <p>当社の連結財務諸表は、「連結財務諸表の用語、様式及び作成方法に関する規則」に基づいて作成している。</p>
      <p>当連結会計年度末の自己資本は247,510百万円であり、前連結会計年度末に比べ18,610百万円増加した。
      増加の主な要因は、親会社株主に帰属する当期純利益21,880百万円の計上及び配当金の支払6,400百万円である。</p>
      <p>金額は百万円未満を切り捨てて表示している。</p>`,
    en: `
      <h2>Part 5 Financial Information</h2>
      <p>The Company's consolidated financial statements are prepared in accordance with the "Regulations on the
      Terminology, Forms and Preparation Methods of Consolidated Financial Statements."</p>
      <p>Shareholders' equity at the end of the current consolidated fiscal year was 247,510 million yen, an increase of
      18,610 million yen from the end of the previous consolidated fiscal year. The main factors for the increase were
      the recording of profit attributable to owners of parent of 21,880 million yen and the payment of dividends of
      6,400 million yen.</p>
      <p>Amounts are rounded down to the nearest million yen.</p>`,
  },
  {
    id: "bs-assets",
    ja: `
      <h3>1 連結貸借対照表（資産の部）</h3>
      <table class="fin">
        <tr><th>科目</th><th>前連結会計年度（百万円）</th><th>当連結会計年度（百万円）</th></tr>
        <tr><td>現金及び預金</td><td>76,500</td><td>86,900</td></tr>
        <tr><td>受取手形及び売掛金</td><td>112,300</td><td>118,900</td></tr>
        <tr><td>棚卸資産</td><td>94,700</td><td>99,200</td></tr>
        <tr><td>その他流動資産</td><td>21,300</td><td>22,100</td></tr>
        <tr><th>流動資産合計</th><th>304,800</th><th>327,100</th></tr>
        <tr><td>有形固定資産</td><td>186,400</td><td>184,900</td></tr>
        <tr><td>無形固定資産</td><td>28,100</td><td>26,700</td></tr>
        <tr><td>投資その他の資産</td><td>47,500</td><td>46,500</td></tr>
        <tr><th>固定資産合計</th><th>262,000</th><th>258,100</th></tr>
        <tr><th>資産合計</th><th>566,800</th><th>585,200</th></tr>
      </table>`,
    en: `
      <h3>1 Consolidated Balance Sheet (Assets)</h3>
      <table class="fin">
        <tr><th>Account</th><th>Previous fiscal year (Millions of yen)</th><th>Current fiscal year (Millions of yen)</th></tr>
        <tr><td>Cash and deposits</td><td>76,500</td><td>86,900</td></tr>
        <tr><td>Notes and accounts receivable-trade</td><td>112,300</td><td>118,900</td></tr>
        <tr><td>Inventories</td><td>94,700</td><td>99,200</td></tr>
        <tr><td>Other current assets</td><td>21,300</td><td>22,100</td></tr>
        <tr><th>Total current assets</th><th>304,800</th><th>327,100</th></tr>
        <tr><td>Property, plant and equipment</td><td>186,400</td><td>184,900</td></tr>
        <tr><td>Intangible assets</td><td>28,100</td><td>26,700</td></tr>
        <tr><td>Investments and other assets</td><td>47,500</td><td>46,500</td></tr>
        <tr><th>Total non-current assets</th><th>262,000</th><th>258,100</th></tr>
        <tr><th>Total assets</th><th>566,800</th><th>585,200</th></tr>
      </table>`,
  },
  {
    id: "bs-liab",
    ja: `
      <h3>2 連結貸借対照表（負債及び純資産の部）</h3>
      <table class="fin">
        <tr><th>科目</th><th>前連結会計年度（百万円）</th><th>当連結会計年度（百万円）</th></tr>
        <tr><td>支払手形及び買掛金</td><td>98,400</td><td>101,200</td></tr>
        <tr><td>短期借入金</td><td>62,000</td><td>58,000</td></tr>
        <tr><th>流動負債合計</th><th>203,500</th><th>205,900</th></tr>
        <tr><td>長期借入金</td><td>108,000</td><td>103,600</td></tr>
        <tr><th>固定負債合計</th><th>134,400</th><th>131,790</th></tr>
        <tr><th>負債合計</th><th>337,900</th><th>337,690</th></tr>
        <tr><td>株主資本</td><td>221,400</td><td>239,300</td></tr>
        <tr><td>その他の包括利益累計額</td><td>7,500</td><td>8,210</td></tr>
        <tr><th>純資産合計</th><th>228,900</th><th>247,510</th></tr>
        <tr><th>負債純資産合計</th><th>566,800</th><th>585,200</th></tr>
      </table>
      <p class="note">（注）自己資本は純資産合計から新株予約権及び非支配株主持分を控除した金額である。</p>`,
    en: `
      <h3>2 Consolidated Balance Sheet (Liabilities and Net Assets)</h3>
      <table class="fin">
        <tr><th>Account</th><th>Previous fiscal year (Millions of yen)</th><th>Current fiscal year (Millions of yen)</th></tr>
        <tr><td>Notes and accounts payable-trade</td><td>98,400</td><td>101,200</td></tr>
        <tr><td>Short-term borrowings</td><td>62,000</td><td>58,000</td></tr>
        <tr><th>Total current liabilities</th><th>203,500</th><th>205,900</th></tr>
        <tr><td>Long-term borrowings</td><td>108,000</td><td>103,600</td></tr>
        <tr><th>Total non-current liabilities</th><th>134,400</th><th>131,790</th></tr>
        <tr><th>Total liabilities</th><th>337,900</th><th>337,690</th></tr>
        <tr><td>Shareholders' equity</td><td>221,400</td><td>239,300</td></tr>
        <tr><td>Accumulated other comprehensive income</td><td>7,500</td><td>8,210</td></tr>
        <tr><th>Total net assets</th><th>228,900</th><th>247,510</th></tr>
        <tr><th>Total liabilities and net assets</th><th>566,800</th><th>585,200</th></tr>
      </table>
      <p class="note">(Note) Net assets is the amount obtained by deducting share acquisition rights and non-controlling
      interests from total net assets.</p>`,
  },
  {
    id: "pl",
    ja: `
      <h3>3 連結損益計算書</h3>
      <table class="fin">
        <tr><th>科目</th><th>前連結会計年度（百万円）</th><th>当連結会計年度（百万円）</th></tr>
        <tr><td>売上高</td><td>428,090</td><td>458,921</td></tr>
        <tr><td>売上原価</td><td>331,700</td><td>352,400</td></tr>
        <tr><th>売上総利益</th><th>96,390</th><th>106,521</th></tr>
        <tr><td>販売費及び一般管理費</td><td>67,790</td><td>74,071</td></tr>
        <tr><th>営業利益</th><th>28,600</th><th>32,450</th></tr>
        <tr><td>営業外収益</td><td>2,100</td><td>2,400</td></tr>
        <tr><td>営業外費用</td><td>3,300</td><td>3,950</td></tr>
        <tr><th>経常利益</th><th>27,400</th><th>30,900</th></tr>
        <tr><th>税金等調整前当期純利益</th><th>27,400</th><th>30,900</th></tr>
        <tr><td>法人税等合計</td><td>8,000</td><td>8,700</td></tr>
        <tr><th>親会社株主に帰属する当期純利益</th><th>19,050</th><th>21,880</th></tr>
      </table>`,
    en: `
      <h3>3 Consolidated Statement of Income</h3>
      <table class="fin">
        <tr><th>Account</th><th>Previous fiscal year (Millions of yen)</th><th>Current fiscal year (Millions of yen)</th></tr>
        <tr><td>Net sales</td><td>428,090</td><td>458,921</td></tr>
        <tr><td>Cost of sales</td><td>331,700</td><td>352,400</td></tr>
        <tr><th>Gross profit</th><th>96,390</th><th>106,521</th></tr>
        <tr><td>Selling, general and administrative expenses</td><td>67,790</td><td>74,071</td></tr>
        <tr><th>Operating income</th><th>28,600</th><th>31,450</th></tr>
        <tr><td>Non-operating income</td><td>2,100</td><td>2,400</td></tr>
        <tr><td>Non-operating expenses</td><td>3,300</td><td>3,950</td></tr>
        <tr><th>Ordinary income</th><th>27,400</th><th>30,900</th></tr>
        <tr><th>Profit before income taxes</th><th>27,400</th><th>30,900</th></tr>
        <tr><td>Total income taxes</td><td>8,000</td><td>8,700</td></tr>
        <tr><th>Profit attributable to owners of parent</th><th>19,050</th><th>21,880</th></tr>
      </table>`,
  },
  {
    id: "cf-stmt",
    ja: `
      <h3>4 連結キャッシュ・フロー計算書</h3>
      <table class="fin">
        <tr><th>科目</th><th>当連結会計年度（百万円）</th></tr>
        <tr><td>税金等調整前当期純利益</td><td>30,900</td></tr>
        <tr><td>減価償却費</td><td>19,800</td></tr>
        <tr><td>売上債権の増減額</td><td>△6,600</td></tr>
        <tr><td>棚卸資産の増減額</td><td>△4,500</td></tr>
        <tr><td>法人税等の支払額</td><td>△8,400</td></tr>
        <tr><th>営業活動によるキャッシュ・フロー</th><th>41,200</th></tr>
        <tr><td>有形固定資産の取得による支出</td><td>△22,600</td></tr>
        <tr><th>投資活動によるキャッシュ・フロー</th><th>△18,500</th></tr>
        <tr><td>配当金の支払額</td><td>△6,400</td></tr>
        <tr><th>財務活動によるキャッシュ・フロー</th><th>△12,300</th></tr>
        <tr><th>現金及び現金同等物の増減額</th><th>10,400</th></tr>
        <tr><th>現金及び現金同等物の期末残高</th><th>86,900</th></tr>
      </table>`,
    en: `
      <h3>4 Consolidated Statement of Cash Flows</h3>
      <table class="fin">
        <tr><th>Account</th><th>Current fiscal year (Millions of yen)</th></tr>
        <tr><td>Profit before income taxes</td><td>30,900</td></tr>
        <tr><td>Depreciation</td><td>19,800</td></tr>
        <tr><td>Increase/decrease in trade receivables</td><td>(6,600)</td></tr>
        <tr><td>Increase/decrease in inventories</td><td>(4,500)</td></tr>
        <tr><td>Income taxes paid</td><td>(8,400)</td></tr>
        <tr><th>Net cash provided by operating activities</th><th>41,200</th></tr>
        <tr><td>Purchase of property, plant and equipment</td><td>(22,600)</td></tr>
        <tr><th>Net cash used in investing activities</th><th>(18,500)</th></tr>
        <tr><td>Dividends paid</td><td>(6,400)</td></tr>
        <tr><th>Net cash used in financing activities</th><th>(12,300)</th></tr>
        <tr><th>Net increase in cash and cash equivalents</th><th>10,400</th></tr>
        <tr><th>Cash and cash equivalents at end of period</th><th>86,900</th></tr>
      </table>`,
  },
  {
    id: "segment",
    ja: `
      <h3>5 セグメント情報</h3>
      <table class="fin">
        <tr><th>セグメント</th><th>売上高（百万円）</th><th>セグメント利益（百万円）</th><th>セグメント資産（百万円）</th></tr>
        <tr><td>産業機械事業</td><td>210,000</td><td>15,800</td><td>248,600</td></tr>
        <tr><td>精密機器事業</td><td>180,000</td><td>13,900</td><td>221,400</td></tr>
        <tr><td>その他事業</td><td>68,921</td><td>2,750</td><td>60,200</td></tr>
        <tr><th>合計</th><th>458,921</th><th>32,450</th><th>530,200</th></tr>
        <tr><td>調整額</td><td>—</td><td>—</td><td>55,000</td></tr>
        <tr><th>連結財務諸表計上額</th><th>458,921</th><th>32,450</th><th>585,200</th></tr>
      </table>
      <p class="note">（注）セグメント利益は連結損益計算書の営業利益と一致している。</p>`,
    en: `
      <h3>5 Segment Information</h3>
      <table class="fin">
        <tr><th>Segment</th><th>Net sales (Millions of yen)</th><th>Segment profit (Millions of yen)</th><th>Segment assets (Millions of yen)</th></tr>
        <tr><td>Industrial Machinery</td><td>210,000</td><td>15,800</td><td>248,600</td></tr>
        <tr><td>Precision Equipment</td><td>180,000</td><td>13,900</td><td>221,400</td></tr>
        <tr><td>Other</td><td>68,291</td><td>2,750</td><td>60,200</td></tr>
        <tr><th>Total</th><th>458,921</th><th>32,450</th><th>530,200</th></tr>
        <tr><td>Adjustments</td><td>—</td><td>—</td><td>55,000</td></tr>
        <tr><th>Amount recorded on consolidated financial statements</th><th>458,921</th><th>32,450</th><th>585,200</th></tr>
      </table>
      <p class="note">(Note) Segment profit agrees with operating income in the consolidated statement of income.</p>`,
  },
  {
    id: "notes1",
    ja: `
      <h3>6 注記事項</h3>
      <h4>(1) 減損損失</h4>
      <p>当連結会計年度において、産業機械事業の遊休資産について、回収可能価額が帳簿価額を下回ったため、
      減損損失1,200百万円を特別損失に計上している。</p>
      <p>回収可能価額は正味売却価額により測定しており、不動産鑑定評価額を基礎としている。</p>
      <h4>(2) 継続企業の前提に関する注記</h4>
      <p>該当事項はない。</p>
      <h4>(3) 重要な後発事象</h4>
      <p>当社は2026年5月12日開催の取締役会において、諏訪工場の生産設備の一部を譲渡することを決議した。
      譲渡価額は3,800百万円である。</p>`,
    en: `
      <h3>6 Notes</h3>
      <h4>(1) Impairment Loss</h4>
      <p>In the current consolidated fiscal year, an impairment loss of 1,200 million yen was recorded as an extraordinary
      loss for idle assets in the Industrial Machinery business, because the recoverable amount fell below the book value.</p>
      <p>The recoverable amount is measured at net selling price and is based on real estate appraisal values.</p>
      <h4>(2) Notes on Going Concern Assumption</h4>
      <p>Not applicable.</p>
      <h4>(3) Significant Subsequent Events</h4>
      <p>At a meeting of the Board of Directors held on May 12, 2026, the Company resolved to transfer part of the
      production facilities of the Suwa Plant. The transfer price is 3,800 million yen.</p>`,
  },
  {
    id: "notes2",
    ja: `
      <h4>(4) 1株当たり情報</h4>
      <table class="fin">
        <tr><th>項目</th><th>前連結会計年度</th><th>当連結会計年度</th></tr>
        <tr><td>1株当たり純資産額（円）<sup>*1</sup></td><td>1,540.20</td><td>1,665.60</td></tr>
        <tr><td>1株当たり当期純利益（円）<sup>*2</sup></td><td>128.20</td><td>147.24</td></tr>
      </table>
      <p class="note">*1 1株当たり純資産額の算定上、期末発行済株式数から自己株式数を控除している。<br>
      *2 潜在株式調整後1株当たり当期純利益については、潜在株式が存在しないため記載していない。<br>
      ただし、当連結会計年度末後に付与された株式報酬は含めていない。</p>
      <h4>(5) 関連当事者情報</h4>
      <p>当連結会計年度において、開示すべき重要な関連当事者との取引はない。</p>`,
    en: `
      <h4>(4) Per Share Information</h4>
      <table class="fin">
        <tr><th>Item</th><th>Previous fiscal year</th><th>Current fiscal year</th></tr>
        <tr><td>Net assets per share (Yen)<sup>*1</sup></td><td>1,540.20</td><td>1,665.60</td></tr>
        <tr><td>Profit per share (Yen)<sup>*3</sup></td><td>128.20</td><td>147.24</td></tr>
      </table>
      <p class="note">*1 In calculating net assets per share, treasury shares are deducted from the number of shares
      issued at the end of the period.<br>
      *2 Diluted profit per share is not presented because there are no dilutive shares.</p>
      <h4>(5) Related Party Information</h4>
      <p>There were no significant related party transactions to be disclosed in the current consolidated fiscal year.</p>`,
  },
  {
    id: "admin",
    ja: `
      <h2>第6 提出会社の株式事務の概要</h2>
      <table class="fin">
        <tr><th>事業年度</th><td>毎年4月1日から翌年3月31日まで</td></tr>
        <tr><th>定時株主総会</th><td>毎年6月</td></tr>
        <tr><th>基準日</th><td>2026年3月31日</td></tr>
        <tr><th>株主名簿管理人</th><td>三葉信託銀行株式会社</td></tr>
        <tr><th>単元株式数</th><td>100株</td></tr>
        <tr><th>公告掲載方法</th><td>電子公告</td></tr>
      </table>
      <p>当社の株主は、単元未満株式について買取請求を行うことができる。</p>`,
    en: `
      <h2>Part 6 Outline of Share Handling</h2>
      <table class="fin">
        <tr><th>Fiscal year</th><td>From April 1 to March 31 of the following year</td></tr>
        <tr><th>Ordinary general meeting of shareholders</th><td>Every June</td></tr>
        <tr><th>Record date</th><td>March 31, 2025</td></tr>
        <tr><th>Shareholder registry administrator</th><td>Mitsuba Trust Bank, Ltd.</td></tr>
        <tr><th>Number of shares per unit</th><td>100 shares</td></tr>
        <tr><th>Method of public notice</th><td>Electronic public notice</td></tr>
      </table>
      <p>Shareholders of the Company may request the purchase of shares of less than one unit.</p>`,
  },
  {
    id: "reference",
    ja: `
      <h2>第7 参考情報</h2>
      <h3>1 主要な連結子会社</h3>
      <table class="fin">
        <tr><th>会社名</th><th>所在地</th><th>議決権所有割合（%）</th></tr>
        <tr><td>株式会社アオイ精機テクノ</td><td>神奈川県厚木市</td><td>100.0</td></tr>
        <tr><td>Aoi Seiki (Thailand) Co., Ltd.</td><td>タイ王国</td><td>100.0</td></tr>
        <tr><td>Aoi Seiki Europe GmbH</td><td>ドイツ連邦共和国</td><td>90.0</td></tr>
      </table>
      <h3>2 従業員の状況</h3>
      <p>当連結会計年度末の従業員数は3,214人であり、前連結会計年度末に比べ74人増加している。
      平均年齢は41.8歳、平均勤続年数は15.2年、平均年間給与は7,120千円である。</p>
      <p>代表取締役社長 田中 健二</p>`,
    en: `
      <h2>Part 7 Reference Information</h2>
      <h3>1 Principal Consolidated Subsidiaries</h3>
      <table class="fin">
        <tr><th>Company name</th><th>Location</th><th>Voting rights ratio (%)</th></tr>
        <tr><td>Aoi Seiki Tech Co., Ltd.</td><td>Atsugi, Kanagawa</td><td>100.0</td></tr>
        <tr><td>Aoi Seiki (Thailand) Co., Ltd.</td><td>Kingdom of Thailand</td><td>100.0</td></tr>
        <tr><td>Aoi Seiki Europe GmbH</td><td>Federal Republic of Germany</td><td>90.0</td></tr>
      </table>
      <h3>2 Employees</h3>
      <p>The number of employees at the end of the current consolidated fiscal year was 3,241, an increase of 74 from the
      end of the previous consolidated fiscal year. The average age was 41.8, the average length of service was 15.2 years,
      and the average annual salary was 7,120 thousand yen.</p>
      <p>Kenzi Tanaka, President and Representative Director</p>`,
  },
  {
    id: "closing",
    ja: `
      <h2>第8 その他</h2>
      <p>当社は、投資家との建設的な対話を促進するため、決算説明会を年2回開催している。
      説明資料は当社ウェブサイトに掲載している。</p>
      <p>当社は、サステナビリティに関する取組みを推進しており、2030年度までに温室効果ガス排出量を
      2013年度比で46%削減する目標を掲げている。</p>
      <p>本報告書に記載した将来に関する事項は、当連結会計年度末現在において当社が判断したものであり、
      実際の結果は様々な要因により異なる可能性がある。</p>
      <p class="note">問い合わせ先：株式会社アオイ精機 経営企画部 IR課</p>`,
    en: `
      <h2>Part 8 Other Information</h2>
      <p>The Company holds financial results briefings twice a year to promote constructive dialogue with investors.
      The Company have posted the briefing materials on its website.</p>
      <p>The Company is promoting sustainability initiatives and has set a target of reducing greenhouse gas emissions
      by 46% from the fiscal 2013 level by fiscal 2030.</p>
      <p>Forward-looking statements in this report are based on judgments made by the Company as of the end of the
      current consolidated fiscal year, and actual results may differ due to various factors.</p>
      <p class="note">Contact: Aoi Seiki Co., Ltd., Corporate Planning Department, IR Section</p>`,
  },
];

// 埋め込んだ既知誤り。quote は英語ページに存在する文字列（builder が実在検証する）。
// lens: spelling|grammar|numbers|names|translation|structure
export const PLANTED = [
  { id: "e01", entry: "history", lens: "numbers", quote: "in March 1935",
    why: "REF「1953年3月に…設立」→ 1935 は日英不一致（設立年の誤り）" },
  { id: "e03", entry: "indicators", lens: "numbers", quote: "<td>459,921</td>",
    why: "REF 売上高 458,921 → 459,921。かつ results/pl/segment の 458,921 と社内矛盾" },
  { id: "e04", entry: "indicators", lens: "numbers", quote: "<td>54</td>",
    why: "REF 1株当たり配当額 45円 → 54（桁入替）。dividend ページの 45 yen とも矛盾" },
  { id: "e05", entry: "indicators", lens: "translation", quote: "the number of persons at work.",
    why: "REF「臨時従業員は含まれていない」が英訳から脱落（訳抜け）" },
  { id: "e06", entry: "business", lens: "translation", quote: "Our company group consists of",
    why: "「当社グループ」の訳が the Group / Our company group で揺れる" },
  { id: "e07", entry: "business", lens: "translation", quote: "3 equity-method subsidiaries",
    why: "「持分法適用関連会社」の誤訳。associates であり subsidiaries ではない" },
  { id: "e08", entry: "business", lens: "translation", quote: "The principal affiliated company is",
    why: "「主要な連結子会社」→ affiliated company は誤訳（consolidated subsidiary）" },
  { id: "e09", entry: "business", lens: "translation", quote: "revenue of this business increased 8.9%",
    why: "「売上高」の訳が net sales / revenue で揺れる" },
  { id: "e11", entry: "policy", lens: "translation", quote: "Under these circumstances, improved significantly year on year",
    why: "日本語の主語省略「収益性は…改善した」を逐語訳し英語で主語不在（省略の顕在化漏れ）" },
  { id: "e12", entry: "policy", lens: "translation", quote: "Will continue to work on it going forward",
    why: "主語・目的語が省略されたまま英訳され、誰が何に取り組むのか不明" },
  { id: "e13", entry: "results", lens: "numbers", quote: "The shareholders' equity ratio was 42.8%",
    why: "REF 42.3% → 42.8%。indicators 表の 42.3 とも社内矛盾" },
  { id: "e14", entry: "results", lens: "structure", quote: "no impairment loss on fixed assets was recorded",
    why: "REFは「減損損失1,200百万円を計上している」。英訳が逆の意味になっており、かつ notes1(P.22)の「an impairment loss of 1,200 million yen was recorded」と正面から矛盾する" },
  { id: "e15", entry: "results2", lens: "structure", quote: "<h4>(4) Results of Production",
    why: "REF は (3)。(2) の次が (4) になり項番が飛んでいる" },
  { id: "e16", entry: "cashflow", lens: "numbers", quote: "financing activities was\n      13,300 million yen",
    why: "REF 12,300 → 13,300。41,200 − 18,500 − 13,300 = 9,400 で「10,400増加」と会計的に不整合。cf-stmt 表の (12,300) とも矛盾" },
  { id: "e17", entry: "risk1", lens: "translation", quote: "fluctuations in foreign exchange rates may affect business results.</p>",
    why: "REF「為替予約等によりリスクの一部を軽減しているが、その全てを回避できるものではない」一文が丸ごと訳抜け" },
  { id: "e18", entry: "risk2", lens: "spelling", quote: "recieve an annual assessment",
    why: "receive の綴り誤り（かつ主語 The Group に対し三単現不一致）" },
  { id: "e19", entry: "risk2", lens: "translation", quote: "The effect is minor.",
    why: "「当該影響は軽微である」の「当該」が省略されたまま訳出され、何の影響か不明" },
  { id: "e20", entry: "property", lens: "structure", quote: "Buildings and structures (Thousands of yen)",
    why: "REF は「百万円」。単位が Thousands of yen になっており桁が1000倍ずれる" },
  { id: "e22", entry: "fin-intro", lens: "translation", quote: "Shareholders' equity at the end of the current consolidated fiscal year was 247,510",
    why: "「自己資本」の訳。bs-liab の注記では net assets と訳され別概念に化けている（訳語不統一）" },
  { id: "e23", entry: "bs-liab", lens: "translation", quote: "(Note) Net assets is the amount obtained by deducting",
    why: "REF「自己資本は純資産合計から…控除した金額」→ Net assets と訳すと自己参照になり意味が壊れる" },
  { id: "e24", entry: "pl", lens: "numbers", quote: "<th>Operating income</th><th>28,600</th><th>31,450</th>",
    why: "REF 営業利益 32,450 → 31,450。results/segment/indicators の 32,450 と社内矛盾。売上総利益−販管費とも合わない" },
  { id: "e25", entry: "segment", lens: "numbers", quote: "<td>68,291</td>",
    why: "REF その他事業 68,921 → 68,291。210,000+180,000+68,291=458,291 で合計 458,921 と内訳が合わない" },
  { id: "e26", entry: "notes2", lens: "structure", quote: "Profit per share (Yen)<sup>*3</sup>",
    why: "脚注番号 *3 が本文に存在しない（REF は *2）。脚注参照の不整合" },
  { id: "e27", entry: "notes2", lens: "translation", quote: "there are no dilutive shares.</p>",
    why: "REF「ただし、当連結会計年度末後に付与された株式報酬は含めていない。」の但し書きが訳抜け" },
  { id: "e28", entry: "admin", lens: "numbers", quote: "<td>March 31, 2025</td>",
    why: "REF 基準日 2026年3月31日 → March 31, 2025。表紙の期間とも矛盾" },
  { id: "e29", entry: "reference", lens: "names", quote: "Aoi Seiki Tech Co., Ltd.",
    why: "history では Aoi Seiki Techno。同一子会社名の表記揺れ（REF は「アオイ精機テクノ」）" },
  { id: "e30", entry: "reference", lens: "numbers", quote: "was 3,241, an increase of 74",
    why: "REF 3,214人 → 3,241（桁入替）。indicators 表の 3,214 とも矛盾。3,140+74=3,214 で計算とも不整合" },
  { id: "e31", entry: "reference", lens: "names", quote: "Kenzi Tanaka",
    why: "officers では Kenji Tanaka。同一人物名の表記揺れ" },
  { id: "e32", entry: "closing", lens: "grammar", quote: "The Company have posted",
    why: "主述不一致（The Company has）" },
];
