// plant-real-errors.mjs — 実物の開示書類に、既知の誤りを埋めた版を作る。
//
//   node docs/benchmarks/real/plant-real-errors.mjs
//
// なぜ要るか（2026-08-05 実測）:
//   マスカーを直して実物（167p）が通るようになったが、返ってきたのは **0指摘** だった。
//   モデルは「167ページ全部を確認したが断定できる跨ぎ不整合は無かった」と答えている。
//   公表済みの監査済み文書なので 0件はありうる。しかし**実物には正解が無い**ので、
//   0件が正しいのか、それとも見つけられていないのかを**判定する手段が無い**。
//   合成フィクスチャで 75.8% 出ることは、実物で動くことを意味しない（現に送信すら
//   止まっていた）。実物の体裁のまま、答えの分かっている誤りを入れるしかない。
//
// 作り方の方針:
//   **原本のページは1文字も変えない。** 末尾に「補足要約」ページを足し、そこに
//   原本の記述と食い違う文を置く。原本の数値・語をアンカーにするので、跨ぎの不整合として成立する。
//
//   ⚠️ 原本のページに上書き（白い矩形＋新しい文字）をしてはいけない。
//      元の文字列は内容ストリームに残るので、抽出テキストには**両方**が出る。
//      見た目だけ変わって、製品が読むテキストは壊れる。この道具が避けているのはその型。
//
// 限界（正直に）:
//   - 埋めた誤りは全部「末尾の補足ページ 対 原本」になるので、**距離が長い側に偏る**。
//   - 補足ページの文体は原本ほど込み入っていない。実文書の表の中に埋まった誤りより易しい。
//   だから合成フィクスチャの代わりにはならない。「実物でも取れるか」の下限を見るためのもの。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "../../../pdflib/pdf-lib.esm.min.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "shionogi_160th_en.pdf");
const OUT = join(here, "shionogi_160th_en_planted.pdf");
const GOLD = join(here, "gold-real.json");

if (!existsSync(SRC)) {
  console.error(`${SRC} がありません。README.md の手順で取得してください。`);
  process.exit(2);
}

// 埋める誤り。**原本の記述（anchor）と食い違う文（line）を補足ページに置く。**
// anchorPage は原本のページ番号（1始まり）、anchorQuote はその根拠になる原文。
// quote は補足ページ側の文字列で、採点はこちらを主たる箇所として見る。
const PLANTED = [
  {
    id: "r-num-01", kind: "number", lens: "numbers", anchorPage: 37,
    anchorQuote: "Pharmaceutical Business 438,268",
    line: "Sales results for the fiscal year under review amounted to 438,286 million yen in the Pharmaceutical Business.",
    quote: "amounted to 438,286 million yen",
    why: "原本 p37 の売上高は 438,268 百万円。ここでは 438,286 と桁が入れ替わっている",
  },
  {
    id: "r-num-02", kind: "number", lens: "numbers", anchorPage: 37,
    anchorQuote: "Pharmaceutical Business 119,870",
    line: "Production results for the fiscal year under review amounted to 119,780 million yen in the Pharmaceutical Business.",
    quote: "amounted to 119,780 million yen",
    why: "原本 p37 の生産実績は 119,870 百万円。ここでは 119,780 と桁が入れ替わっている",
  },
  {
    id: "r-num-03", kind: "number-control", lens: "numbers", anchorPage: 37,
    anchorQuote: "Pharmaceutical Business 11,601",
    line: "Goods purchase results for the fiscal year under review amounted to 11,601 million yen in the Pharmaceutical Business.",
    quote: "amounted to 11,601 million yen",
    why: "対照群。原本 p37 と**一致している**ので、これを指摘したら誤検知",
  },
  {
    id: "r-term-01", kind: "term", lens: "wording", anchorPage: 37,
    anchorQuote: "ViiV Healthcare Ltd.",
    line: "The largest customer in the current fiscal year was ViiV Healthcare Limited, as described above.",
    quote: "ViiV Healthcare Limited, as described above",
    why: "原本は一貫して ViiV Healthcare Ltd. と書いている。ここだけ Limited と綴られている",
  },
  {
    id: "r-term-02", kind: "term", lens: "wording", anchorPage: 37,
    anchorQuote: "Suzuken Co., Ltd.",
    line: "Sales to Suzuken Company, Limited in the previous fiscal year represented a material portion of total sales.",
    quote: "Sales to Suzuken Company, Limited in the previous fiscal year",
    why: "原本は Suzuken Co., Ltd.。ここだけ Company, Limited と綴られている",
  },
  {
    id: "r-str-01", kind: "structure", lens: "structure", anchorPage: 142,
    anchorQuote: "Forward foreign exchange contracts",
    line: "Note 21 sets out the status of the major shareholders of the Company.",
    quote: "Note 21 sets out the status of the major shareholders",
    why: "原本の Note 21 は為替予約など金融商品の注記。同じ注記番号が別の内容に割り当てられている",
  },
  {
    id: "r-str-02", kind: "structure", lens: "structure", anchorPage: 37,
    anchorQuote: "please refer to “V. Financial Information",
    line: "For details of material accounting policies, please refer to VI. Financial Information of this report.",
    quote: "please refer to VI. Financial Information of this report",
    why: "原本は V. Financial Information を参照している。ここでは VI. になっている",
  },
  {
    id: "r-strloc-01", kind: "structure-local", lens: "structure", anchorPage: null,
    anchorQuote: null,
    line: "The review covered the following three areas: (1) production, (2) purchases, and (4) sales.",
    quote: "(1) production, (2) purchases, and (4) sales",
    why: "同一ページで項番が (1)(2)(4) と飛んでいる（(3) が無い）",
  },
];

// 補足ページの本文。planted の line を挟みつつ、それらしい体裁にする。
// ⚠️ 原本に既にある文字列と同じものを書かないこと（引用の一意性が壊れる）。
const HEADING = "Supplementary Summary of Production, Purchases and Sales";
const INTRO = [
  "This supplementary summary restates the principal figures and references presented in this report",
  "for the convenience of readers. It does not form part of the audited financial statements.",
];

const doc = await PDFDocument.load(readFileSync(SRC), { updateMetadata: false });
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const [w, h] = (() => { const p = doc.getPage(0).getSize(); return [p.width, p.height]; })();
const originalPages = doc.getPageCount();

const MARGIN = 56, SIZE = 10.5, LEAD = 18;
let page = null, y = 0;
const newPageNumbers = [];
function newPage() {
  page = doc.addPage([w, h]);
  newPageNumbers.push(doc.getPageCount());
  y = h - MARGIN;
  page.drawText(HEADING, { x: MARGIN, y, size: 12, font: bold, color: rgb(0, 0, 0) });
  y -= LEAD * 1.6;
  return doc.getPageCount();
}
function writeLine(text) {
  if (!page || y < MARGIN + LEAD) newPage();
  page.drawText(text, { x: MARGIN, y, size: SIZE, font, color: rgb(0, 0, 0) });
  const at = doc.getPageCount();
  y -= LEAD;
  return at;
}

newPage();
for (const l of INTRO) writeLine(l);
y -= LEAD * 0.5;

const gold = [];
for (const p of PLANTED) {
  y -= LEAD * 0.5;
  const at = writeLine(p.line);
  gold.push({
    id: p.id, page: at, lens: p.lens, quote: p.quote, kind: p.kind,
    distance: p.anchorPage ? at - p.anchorPage : 0,
    anchor_page: p.anchorPage,
    alt: p.anchorPage ? [{ page: p.anchorPage, quote: p.anchorQuote }] : undefined,
    ref_page: null, local_hint: p.kind === "structure-local",
    why: p.why,
  });
}

const bytes = await doc.save();
writeFileSync(OUT, bytes);

writeFileSync(GOLD, JSON.stringify({
  note: "実物の有価証券報告書（英訳）に既知の誤りを埋めた版。原本のページは変えていない。"
    + "誤りは末尾の補足ページにあり、原本のページをアンカーにした跨ぎの不整合として成立する。",
  fixture_version: "real-1",
  target_pdf: "shionogi_160th_en_planted.pdf",
  ref_pdf: null,
  target_pages: doc.getPageCount(),
  ref_pages: 0,
  // ⚠️ **precision は測れない。** 原本にもともと含まれる不整合を gold は知らないので、
  //    planted に当たらなかった指摘が「誤検知」なのか「原本の実在の不整合」なのか区別できない。
  //    実測（2026-08-06）: planted 以外の4件は**全部が原本の実在の不整合**だった
  //    （社名の (China) の有無・Pharmaceutical/Pharmaceuticals・労働組合名が2通り・
  //      同じ行に Co, Ltd. と Co., Ltd.）。それでも表示上の precision は 50% と出ていた。
  //    score-runs.mjs はこの旗を見て precision を「測れない」と表示する。
  precision_measurable: false,
  ignored: [],
  // 幅ごとに「その幅の窓に主たる箇所とアンカーが同時に入る planted」の一覧。
  // 埋めた誤りは全部**末尾の補足ページ 対 原本**なので、文書全体を1セクションにする
  // 構成（推奨構成）でしか届かない。幅を狭めた構成で測るなら、その幅の一覧を足すこと。
  reachability_overlap: 3,
  reachability: { [String(doc.getPageCount())]: gold.map(g => g.id), "200": gold.map(g => g.id) },
  // ⚠️ packet_id は **"ALL"** にすること。`report-to-run.mjs` は run の全指摘を1つの
  //    packet_id="ALL" にまとめる。gold 側を別の名前（"SEC_001" 等）にすると、
  //    score.mjs の突き合わせ相手が空になり、**当たっていても recall 0% と出る**。
  //    実際それで 4件当たっているのに 0/7 と表示された（2026-08-06）。
  //    合成フィクスチャの gold も "ALL" になっている。
  packets: [{ packet_id: "ALL", planted: gold }],
  details: {
    original_pages: originalPages,
    appended_pages: newPageNumbers,
    caveat: "距離は全部『末尾の補足ページ 対 原本』に偏る。補足ページの文体は原本より易しい。"
      + "合成フィクスチャの代わりにはならず、実物でも取れるかの下限を見るためのもの。",
  },
}, null, 2) + "\n");

console.log(`原本 ${originalPages}p → ${doc.getPageCount()}p（補足 ${newPageNumbers.length}ページ）`);
console.log(`planted ${gold.length}件: ` + Object.entries(gold.reduce((a, g) => (a[g.kind] = (a[g.kind] || 0) + 1, a), {}))
  .map(([k, v]) => `${k}=${v}`).join(" "));
console.log(`出力: ${OUT}`);
console.log(`gold: ${GOLD}`);
