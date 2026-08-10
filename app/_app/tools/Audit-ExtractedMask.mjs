// Audit-ExtractedMask.mjs — PDF.jsで保存済みの抽出JSONを、ブラウザ無しで再監査する。
//
//   node tools/Audit-DocumentMask.mjs doc.pdf --save-extract tmp/doc.extract.json
//   node tools/Audit-ExtractedMask.mjs tmp/doc.extract.json --lang ja --json tmp/doc.audit.json

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Masker, maskSidecarByRole, verify } from "../js/number-mask.mjs";
import { LAYOUT_TEXT_RECONSTRUCTION_VERSION } from "../js/pdf-text-reconstruct.mjs";
import {
  PDFJS_EXTRACT_SCHEMA, PDFJS_BUNDLED_VERSION, TEXT_RECONSTRUCTION_VERSION,
  EXTRACT_TEXT_SEPARATOR, sha256File, sha256Text, writeJsonAtomic,
} from "./pdfjs-headless-runner.mjs";

const argv = process.argv.slice(2);
const inputArg = argv.find(x => !x.startsWith("--"));
if (!inputArg) {
  console.error("usage: node tools/Audit-ExtractedMask.mjs <extract.json> [--lang en|ja] [--json audit.json] [--context]");
  process.exit(2);
}
const inputPath = resolve(inputArg);
const lang = argv.includes("--lang") ? String(argv[argv.indexOf("--lang") + 1] || "en") : "en";
const data = JSON.parse(readFileSync(inputPath, "utf8"));
if (!Array.isArray(data.pages)) throw new Error("extract.json に pages 配列がありません");
if (data.schema !== PDFJS_EXTRACT_SCHEMA) {
  throw new Error(`unsupported extract schema: expected ${PDFJS_EXTRACT_SCHEMA}, got ${data.schema || "(missing)"}`);
}
if (String(data.pdfjsVersion) !== PDFJS_BUNDLED_VERSION) {
  throw new Error(`PDF.js version mismatch: expected ${PDFJS_BUNDLED_VERSION}, got ${data.pdfjsVersion || "(missing)"}`);
}
if (![TEXT_RECONSTRUCTION_VERSION, LAYOUT_TEXT_RECONSTRUCTION_VERSION].includes(String(data.reconstructionVersion))) {
  throw new Error(`text reconstruction version mismatch: expected ${TEXT_RECONSTRUCTION_VERSION} or ${LAYOUT_TEXT_RECONSTRUCTION_VERSION}, got ${data.reconstructionVersion || "(missing)"}`);
}
const actualTextSha256 = sha256Text(data.pages.map(x => String(x || "")).join(EXTRACT_TEXT_SEPARATOR));
if (!data.textSha256 || data.textSha256 !== actualTextSha256) {
  throw new Error(`extract text hash mismatch: expected ${data.textSha256 || "(missing)"}, got ${actualTextSha256}`);
}
if (!/^[0-9a-f]{64}$/i.test(String(data.sourceSha256 || ""))) {
  throw new Error("extract sourceSha256 is missing or invalid");
}
if (data.source && existsSync(resolve(String(data.source)))) {
  const actualSourceSha256 = sha256File(resolve(String(data.source)));
  if (actualSourceSha256 !== data.sourceSha256) {
    throw new Error(`source PDF hash mismatch: expected ${data.sourceSha256}, got ${actualSourceSha256}`);
  }
}

const role = lang === "ja" ? "REF1_CANDIDATE" : "TARGET_CHECK";
const sidecar = data.pages.map((text, i) => `===== PDF P.${i + 1} / ${role} / x =====\n${text || ""}\n`).join("");
const masker = new Masker(1);
const masked = maskSidecarByRole(sidecar, masker);
const verification = verify(masked);
const symbolMatches = [...masked.matchAll(/⟦#[A-Z]{3}⟧/g)];

const pageAt = (() => {
  const marks = [...masked.matchAll(/^===== PDF P\.(\d+) \//gm)].map(m => ({ at: m.index, page: Number(m[1]) }));
  return position => { let page = 0; for (const mark of marks) { if (mark.at > position) break; page = mark.page; } return page; };
})();
const occurrences = masker.occurrences.map((o, i) => ({
  page: symbolMatches[i] ? pageAt(symbolMatches[i].index) : 0,
  symbol: o.symbol, raw: o.raw, micro: o.micro.toString(), chosenExp: o.chosenExp,
  family: o.family, source: o.source, namespace: o.namespace,
}));

const bySurface = new Map();
for (const occurrence of occurrences) {
  if (occurrence.namespace !== "amount") continue;
  const surface = String(occurrence.raw).replace(/[^\d.,]/g, "");
  if (surface.replace(/\D/g, "").length < 3) continue;
  if (!bySurface.has(surface)) bySurface.set(surface, []);
  bySurface.get(surface).push(occurrence);
}
const microBySymbol = new Map(occurrences.map(o => [o.symbol, BigInt(o.micro)]));
const digits = n => String(n < 0n ? -n : n).length;
const splits = [...bySurface.entries()].map(([surface, rows]) => {
  const list = [...new Set(rows.map(x => x.symbol))];
  const sizes = list.map(symbol => digits(microBySymbol.get(symbol) || 0n));
  const digitGap = Math.max(...sizes) - Math.min(...sizes);
  const familyMicros = new Map();
  for (const row of rows) {
    if (!row.family || row.namespace !== "amount") continue;
    if (!familyMicros.has(row.family)) familyMicros.set(row.family, new Set());
    familyMicros.get(row.family).add(row.micro);
  }
  const sameFamilySplit = [...familyMicros.entries()].filter(([, values]) => values.size > 1).map(([family]) => family);
  return { surface, symbols: list, digitGap,
    suspicious: sameFamilySplit.length > 0 || (digitGap > 0 && digitGap <= 12), sameFamilySplit };
}).filter(x => x.symbols.length > 1);
const metadataIssues = occurrences.filter(x => x.namespace === "amount" && x.chosenExp
  && (!x.family || (x.source === "evidence" && !["money", "units", "shares", "count"].includes(x.family))));

console.log(`抽出JSON: ${basename(inputPath)} / ${data.pages.length}ページ / lang=${lang}`);
console.log(`マスク後の判定: ${verification.ok ? "OK" : `NG（${verification.leaks.length}件）`}`);
console.log(`同じ数字表記の複数記号: ${splits.length}件 / 単位解釈候補: ${splits.filter(x => x.suspicious).length}件`);
console.log(`単位メタデータ矛盾: ${metadataIssues.length}件`);
for (const split of splits.filter(x => x.suspicious)) {
  console.log(`  ${split.surface} → ${split.symbols.join(" ")}（桁差 ${split.digitGap}）`);
}

if (argv.includes("--context")) {
  for (const split of splits.filter(x => x.suspicious)) {
    console.log(`  ── ${split.surface}`);
    for (const symbol of split.symbols) {
      const rows = occurrences.filter(x => x.symbol === symbol);
      console.log(`     ${symbol}: ${rows.map(x => `p${x.page} exp=${x.chosenExp ?? "-"} ${x.family}/${x.source}`).join(", ")}`);
    }
  }
}

if (argv.includes("--json")) {
  const outputPath = resolve(argv[argv.indexOf("--json") + 1]);
  writeJsonAtomic(outputPath, { source: data.source || inputPath, sourceSha256: data.sourceSha256 || "",
    extractTextSha256: actualTextSha256, lang, verification, occurrences, splits, metadataIssues });
  console.log(`監査JSONを保存: ${outputPath}`);
}

if (!verification.ok) process.exit(1);
