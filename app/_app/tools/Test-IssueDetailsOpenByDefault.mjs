// Test-IssueDetailsOpenByDefault.mjs — 指摘の「理由・詳細」を最初から開いて出す回帰テスト。
//
// 確かめること:
//   1. レポートの一覧カードの「理由・比較資料・照合情報」が open 付きで書き出される。
//   2. 選択中の指摘欄（renderMasterDetail が作り直す）の「理由・詳細」が open 付きで作られる。
//   3. 理由とは別の折りたたみ（このレポートについて・修正案について）は閉じたまま。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const L = readFileSync(join(ROOT, "index.html"), "utf8").split(/\r?\n/);
const fn = (needle) => {
  const i = L.findIndex(s => s.includes(needle));
  if (i < 0) throw new Error("index.html に見つかりません: " + needle);
  const indent = L[i].match(/^\s*/)[0];
  for (let j = i + 1; j < L.length; j++) if (L[j] === indent + "}") return L.slice(i, j + 1).join("\n");
  throw new Error("閉じ括弧が見つかりません: " + needle);
};
const line = (needle) => {
  const value = L.find(s => s.includes(needle));
  if (!value) throw new Error("index.html に見つかりません: " + needle);
  return value;
};

const results = [];
const t = (name, ok, detail = "") => results.push({ ok: !!ok, name, detail });

const src = [
  line("const categoryLabels ="),
  line("const categoryLabel ="),
  fn("function reportHtmlDocument("),
  fn("function suggestionKind(s)"),
  fn("function severityLabel(sev)"),
  fn("function pagesToRangeText(pages)"),
  fn("function escapeHtml(value)"),
  fn("function safeText(value, max"),
  `function reportScriptTag(s){ return '<script src="' + s + '"></scr' + 'ipt>' }`,
  `function locatorTokens(){ return [] }`,
].join("\n");
const { reportHtmlDocument } = eval("(function(){" + src + "; return { reportHtmlDocument }})()");

const rawDir = join(ROOT, "docs/benchmarks/runs/raw");
const pick = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith(".json")).sort().pop() : null;
if (!pick) { console.error("素材の実行結果がありません: " + rawDir); process.exit(1); }
const data = JSON.parse(readFileSync(join(rawDir, pick), "utf8"));
const base = data.findings[0];
const mk = (no, over) => ({ ...base, no, id: "F" + no, page: 3, excluded_reason: "", self_check: "", quality_warning: "", ...over });
const fixture = {
  ...data,
  findings: [
    mk(1, { reason: "理由その1", suggestion: "Number of treasury shares", suggestion_kind: "replacement" }),
    mk(2, { reason: "理由その2", suggestion: "表記を統一する。", suggestion_kind: "action" }),
  ],
};
fixture.count = fixture.findings.length;
const html = reportHtmlDocument(fixture, {});

const issueDetails = html.match(/<details class="issue-details"[^>]*>/g) || [];
t("一覧カードの理由欄が指摘の数だけある", issueDetails.length === fixture.findings.length, issueDetails.length);
t("一覧カードの理由欄は open 付き", issueDetails.length > 0 && issueDetails.every(tag => /\sopen(?=[\s>])/.test(tag)), issueDetails.join(" "));
t("選択中の指摘欄の「理由・詳細」は open 付きで作る", html.includes(`<details class="master-extra" open><summary>理由・詳細</summary>`));
t("「このレポートについて」は閉じたまま", /<details class="report-about"><summary>/.test(html));
t("「修正案について」は閉じたまま", !/<details class="suggestion-history"[^>]*\sopen[\s>]/.test(html));

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + String(r.detail).slice(0, 300)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-IssueDetailsOpenByDefault: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
