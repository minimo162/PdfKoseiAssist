// build-fixture.mjs — 合成ベンチマーク文書（日本語REF / 英訳TARGET）と gold set を生成する。
//
//   node docs/benchmarks/fixtures/build-fixture.mjs
//
// 出力:
//   aoi-seiki_ja_REF.pdf    日本語原文（正）
//   aoi-seiki_en_TARGET.pdf 英訳（既知の誤りを埋め込み済み）
//   gold.json               score.mjs 互換の正解セット
//   gold.md                 人が読むための誤り一覧（ページ・観点・理由）
//
// PDF化は Chromium（playwright）。日本語は IPAGothic を使う。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES, PLANTED, DOC } from "./fixture-content.mjs";

// playwright はグローバル導入のことがあるため、解決できなければ npm root -g から読む。
async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch { /* fallthrough */ }
  const { execSync } = await import("node:child_process");
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  const m = await import(join(root, "playwright", "index.js"));
  return (m.chromium || m.default?.chromium);
}

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const norm = s => s.replace(/\s+/g, " ").trim();
const stripTags = s => norm(s.replace(/<[^>]+>/g, " "));

// ---- ページ番号の割り当て（jaOnly は英語ページを持たない＝日英でページがずれる） ----
const jaPages = [];
const enPages = [];
for (const e of ENTRIES) {
  jaPages.push({ entry: e.id, html: e.ja });
  if (!e.jaOnly) enPages.push({ entry: e.id, html: e.en });
}
const enPageOf = new Map(enPages.map((p, i) => [p.entry, i + 1]));
const jaPageOf = new Map(jaPages.map((p, i) => [p.entry, i + 1]));

// ---- planted の quote が実在するか検証（gold の信頼性はここで担保する） ----
const gold = [];
const problems = [];
for (const p of PLANTED) {
  const page = enPageOf.get(p.entry);
  const entry = ENTRIES.find(e => e.id === p.entry);
  if (!entry || !page) { problems.push(`${p.id}: entry '${p.entry}' が英語ページに無い`); continue; }
  if (!norm(entry.en).includes(norm(p.quote))) { problems.push(`${p.id}: quote が英語本文に存在しない → ${p.quote}`); continue; }
  gold.push({ id: p.id, page, lens: p.lens, quote: stripTags(p.quote), ref_page: jaPageOf.get(p.entry), why: p.why });
}
if (problems.length) {
  console.error("planted の検証に失敗:\n" + problems.map(s => "  - " + s).join("\n"));
  process.exit(1);
}

// ---- HTML 組み立て ----
const CSS = lang => `
  @page { size: A4; margin: 16mm 15mm; }
  body { margin: 0; font-family: ${lang === "ja" ? '"IPAGothic","IPAPGothic",sans-serif' : '"DejaVu Serif","Liberation Serif",serif'};
         font-size: ${lang === "ja" ? "10.5pt" : "10pt"}; line-height: 1.7; color: #111; }
  .page { min-height: 245mm; position: relative; }
  .page + .page { break-before: page; }
  .pgnum { position: absolute; bottom: 0; width: 100%; text-align: center; font-size: 8.5pt; color: #666; }
  .hdr { border-bottom: 1px solid #999; padding-bottom: 3px; margin-bottom: 10px; font-size: 8.5pt; color: #555; }
  /* margin だと .page を突き抜けて折り返しが1ページ増えるので padding で空ける */
  h1 { font-size: 20pt; margin: 0 0 8mm; padding-top: 40mm; text-align: center; }
  h2 { font-size: 13pt; margin: 0 0 8px; border-left: 5px solid #234; padding-left: 8px; }
  h3 { font-size: 11.5pt; margin: 14px 0 6px; }
  h4 { font-size: 10.5pt; margin: 10px 0 4px; }
  p { margin: 0 0 8px; text-align: justify; }
  .lead { text-align: center; font-size: 12pt; }
  .note { font-size: 8.5pt; color: #444; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: ${lang === "ja" ? "9pt" : "8.5pt"}; }
  th, td { border: 1px solid #999; padding: 3px 5px; }
  th { background: #eef1f4; text-align: left; }
  td { text-align: right; }
  td:first-child, th:first-child { text-align: left; }
  table.toc, table.toc td, table.toc th { border: none; }
  table.toc td:last-child { text-align: right; }
  sup { font-size: 7pt; }
`;

function buildHtml(lang, pages) {
  const hdr = lang === "ja"
    ? `${DOC.companyJa}　${DOC.fiscalJa}`
    : `${DOC.companyEn} — ${DOC.fiscalEn}`;
  const body = pages.map((p, i) => `
    <div class="page" data-entry="${p.entry}">
      ${i === 0 ? "" : `<div class="hdr">${hdr}</div>`}
      ${p.html}
      ${i === 0 ? "" : `<div class="pgnum">- ${i + 1} -</div>`}
    </div>`).join("\n");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
    <title>${lang === "ja" ? DOC.companyJa : DOC.companyEn}</title>
    <style>${CSS(lang)}</style></head><body>${body}</body></html>`;
}

const jaHtml = buildHtml("ja", jaPages);
const enHtml = buildHtml("en", enPages);
writeFileSync(join(OUT, "aoi-seiki_ja_REF.html"), jaHtml);
writeFileSync(join(OUT, "aoi-seiki_en_TARGET.html"), enHtml);

// ---- gold 出力 ----
const byLens = {};
for (const g of gold) byLens[g.lens] = (byLens[g.lens] || 0) + 1;

writeFileSync(join(OUT, "gold.json"), JSON.stringify({
  note: "合成文書（架空企業）。英訳TARGETに既知の誤りを埋め込んだもの。page は TARGET(英訳) のページ番号。",
  target_pdf: "aoi-seiki_en_TARGET.pdf",
  ref_pdf: "aoi-seiki_ja_REF.pdf",
  target_pages: enPages.length,
  ref_pages: jaPages.length,
  packets: [{ packet_id: "ALL", planted: gold.map(({ id, page, lens, quote }) => ({ id, page, lens, quote })) }],
  details: gold,
}, null, 2) + "\n");

const mdRows = gold.map(g =>
  `| ${g.id} | ${g.page} | ${g.ref_page} | ${g.lens} | \`${g.quote.slice(0, 60)}\` | ${g.why} |`).join("\n");
writeFileSync(join(OUT, "gold.md"), `# 合成ベンチマーク gold set（${gold.length}件）

架空企業「${DOC.companyJa} / ${DOC.companyEn}」${DOC.fiscalJa}。
TARGET(英訳) ${enPages.length}ページ / REF(日本語原文) ${jaPages.length}ページ。
**REFは正**。誤りはすべて TARGET 側に埋め込んである。
日本語 p2 の【表紙】は英訳版に存在しない（EDINET様式のため）ので、p3以降は日英でページが1ずれる。
これは誤りではなく、ページ対応ズレの再現である。

観点別内訳: ${Object.entries(byLens).map(([k, v]) => `${k} ${v}件`).join(" / ")}

| ID | TARGET頁 | REF頁 | 観点 | 該当箇所 | 埋め込んだ誤りの内容 |
|----|---------|-------|------|----------|---------------------|
${mdRows}

## 検出の難易度について

- **単ページで気づけるもの**（綴り・主述不一致・訳抜け・省略の逐語訳）は校正パケット（約10p）でも取れるはず。
- **跨ぎでしか気づけないもの**（e03/e04↔e21、e13、e14↔e24、e30、e29、e31）は
  整合性レビュー（セクション単位・現物添付）でないと原理的に検出できない。
- **会計連動でしか気づけないもの**（e16 の CF 合計、e25 の内訳合計、e24 の 売上総利益−販管費）は
  数値をただ突き合わせるだけでは出ず、勘定科目の関係を理解して初めて出る。
`);

// ---- PDF 化 ----
const chromium = await loadChromium();
const browser = await chromium.launch();
try {
  for (const [name, html] of [["aoi-seiki_ja_REF", jaHtml], ["aoi-seiki_en_TARGET", enHtml]]) {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: join(OUT, `${name}.pdf`), format: "A4", printBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`gold: ${gold.length}件 / TARGET ${enPages.length}p / REF ${jaPages.length}p`);
console.log(`観点別: ${Object.entries(byLens).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`出力: ${OUT}`);
