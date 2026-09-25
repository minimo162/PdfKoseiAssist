// Rebuild an already-exported report folder with the current viewer and launcher.
// Usage: node tools/Build-ReportPackageFromExport.mjs <export-folder>
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exportDir = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Export folder is required");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceLines = readFileSync(join(root, "index.html"), "utf8").split(/\r?\n/);
const line = (needle) => {
  const value = sourceLines.find((entry) => entry.includes(needle));
  if (!value) throw new Error(`index.html is missing: ${needle}`);
  return value;
};
const fn = (needle) => {
  const start = sourceLines.findIndex((entry) => entry.includes(needle));
  if (start < 0) throw new Error(`index.html is missing: ${needle}`);
  const indent = sourceLines[start].match(/^\s*/)[0];
  for (let i = start + 1; i < sourceLines.length; i++) {
    if (sourceLines[i] === `${indent}}`) return sourceLines.slice(start, i + 1).join("\n");
  }
  throw new Error(`Function is not closed: ${needle}`);
};
const constBlock = (needle) => {
  const start = sourceLines.findIndex((entry) => entry.includes(needle));
  if (start < 0) throw new Error(`index.html is missing: ${needle}`);
  const indent = sourceLines[start].match(/^\s*/)[0];
  for (let i = start + 1; i < sourceLines.length; i++) {
    if (sourceLines[i] === `${indent}};`) return sourceLines.slice(start, i + 1).join("\n");
  }
  throw new Error(`Constant block is not closed: ${needle}`);
};
const between = (startNeedle, endNeedle) => {
  const start = sourceLines.findIndex((entry) => entry.includes(startNeedle));
  const end = sourceLines.findIndex((entry, index) => index > start && entry.includes(endNeedle));
  if (start < 0 || end < 0) throw new Error(`Cannot extract ${startNeedle}`);
  return sourceLines.slice(start, end).join("\n").trimEnd();
};

const viewerSource = [
  line("const categoryLabels ="),
  line("const categoryLabel ="),
  constBlock("const EXCLUDED_REASON_LABELS ="),
  line("const excludedReasonLabel ="),
  fn("function reportHtmlDocument("),
  fn("function suggestionKind(s)"),
  fn("function severityLabel(sev)"),
  fn("function pagesToRangeText(pages)"),
  fn("function escapeHtml(value)"),
  fn("function safeText(value, max"),
  `function reportScriptTag(s){ return '<script src="' + s + '"></scr' + 'ipt>' }`,
  `function locatorTokens(){ return [] }`,
].join("\n");
const { reportHtmlDocument, suggestionKind } = eval(
  `(function(){${viewerSource}; return { reportHtmlDocument, suggestionKind }})()`,
);

const launcherSource = [
  between("function buildReportServerPs1Text(", "function buildReportOpenCmdText("),
  between("function buildReportOpenCmdText(", "async function buildHtmlReportZipInBrowser("),
].join("\n");
const { buildReportServerPs1Text, buildReportOpenCmdText } = eval(
  `(function(){${launcherSource}; return { buildReportServerPs1Text, buildReportOpenCmdText }})()`,
);

const dataDir = join(exportDir, "_data");
mkdirSync(dataDir, {recursive:true});
for (const name of ["assets", "指摘.json", "指摘.csv", "README_使い方.txt", "report-server.ps1", "確認状況.json"]) {
  if (existsSync(join(exportDir, name)) && !existsSync(join(dataDir, name))) renameSync(join(exportDir, name), join(dataDir, name));
}
const reportPath = join(exportDir, "指摘レポート.html");
const oldHtml = readFileSync(reportPath, "utf8");
const payloadTags = [...oldHtml.matchAll(/<script src="(?:_data\/)?assets\/(?:report_payload\.js|pdf_chunks\/[^"]+)"><\/script>/g)]
  .map((match) => match[0].replace('src="assets/', 'src="_data/assets/'));
if (!payloadTags.length) throw new Error("The exported PDF payload script tags were not found");

const data = JSON.parse(readFileSync(join(dataDir, "指摘.json"), "utf8"));
for (const finding of data.findings || []) finding.suggestion_kind = suggestionKind(finding.suggestion);
data.suggestion_action_count = (data.findings || []).filter((finding) => finding.suggestion_kind === "action").length;
data.suggestion_replacement_count = (data.findings || []).filter((finding) => finding.suggestion_kind === "replacement").length;
data.report_viewer = "browser-built-pdfjs-loopback-http-current";

writeFileSync(reportPath, reportHtmlDocument(data, { targetPayloadScriptTags: payloadTags.join("\n") }), "utf8");
writeFileSync(join(exportDir, "指摘レポートを開く.cmd"), buildReportOpenCmdText(), "utf8");
writeFileSync(join(dataDir, "report-server.ps1"), buildReportServerPs1Text(), "utf8");
writeFileSync(join(dataDir, "指摘.json"), JSON.stringify(data, null, 2), "utf8");
writeFileSync(join(dataDir, "README_使い方.txt"), [
  "PDF校正アシスト HTML指摘ビューアZIP",
  "",
  "1. ZIPを右クリックして、すべて展開します。ZIPの中から直接起動しないでください。",
  "2. 展開先の「指摘レポートを開く.cmd」をダブルクリックします。",
  "3. Edgeに開いた指摘レポートを確認します。",
  "4. 見終わったら、Edgeのタブを閉じます。一時サーバーは自動で終わります。",
  "",
  "起動時は、PC内だけで使う http://127.0.0.1 の一時サーバーを使用します。",
  "レポートやPDFをインターネットへ送信する処理ではありません。",
  "_dataフォルダーは移動・削除しないでください。",
  "",
  "画面の使い方:",
  "・右側の指摘を選ぶと、左側のPDFで該当箇所を表示します。",
  "・確認が終わった指摘は「確認済み」にできます。状態は _data/確認状況.json に保存されます。",
  "・CSVは画面の「その他の保存」から保存できます。",
].join("\r\n"), "utf8");

console.log(`Rebuilt report package: ${exportDir}`);
