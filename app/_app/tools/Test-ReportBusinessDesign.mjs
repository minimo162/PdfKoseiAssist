// Test-ReportBusinessDesign.mjs — 指摘レポートの白基調・ビジネス向けデザインの回帰テスト。
//
// 確かめること（node だけで確かめられるもの）:
//   1. デザインの層は画面表示（@media screen）だけに効き、印刷の見た目を変えない。
//   2. 強調色は紺系の1色（--accent）に絞られ、選択中の枠・選択行・進捗に紫が残っていない。
//   3. 見出し・札・操作の要所が、同じ色の変数と角丸で描かれている。
//   4. #190 で決めた読みやすさ（文を切らない・確認済みの文字・太い黄色の枠）を崩していない。
// 画面での見え方はスクリーンショットで確かめた（PR の本文を参照）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const start = html.indexOf("<title>PDF校正アシスト 指摘ビューア</title>");
const styleStart = html.indexOf("<style>", start), styleEnd = html.indexOf("</style>", styleStart);
const css = html.slice(styleStart + 7, styleEnd).replace(/\/\*[\s\S]*?\*\//g, "");

const results = [];
const t = (name, ok, detail = "") => results.push({ ok: !!ok, name, detail });

// 最後に効く宣言を、画面用（印刷以外）と印刷用に分けて見る。
function collect(text) {
  const rules = [];
  let i = 0;
  const walk = (media) => {
    while (i < text.length) {
      const open = text.indexOf("{", i), close = text.indexOf("}", i);
      if (close >= 0 && (open < 0 || close < open)) { i = close + 1; return; }
      if (open < 0) { i = text.length; return; }
      const head = text.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith("@")) { walk(/\bprint\b/.test(head) ? "print" : /\bscreen\b/.test(head) ? "screen" : media); continue; }
      const end = text.indexOf("}", i);
      rules.push({ media, selectors: head.split(",").map(s => s.trim()), body: text.slice(i, end) });
      i = end + 1;
    }
  };
  walk("all");
  return rules;
}
const rules = collect(css);
function effective(selector, prop, media = "screen") {
  let normal = null, important = null;
  for (const r of rules) {
    if (media === "screen" ? r.media === "print" : r.media === "screen") continue;
    if (!r.selectors.includes(selector)) continue;
    for (const decl of r.body.split(";")) {
      const k = decl.indexOf(":");
      if (k < 0 || decl.slice(0, k).trim() !== prop) continue;
      const value = decl.slice(k + 1).trim();
      if (/!important$/.test(value)) important = value; else normal = value;
    }
  }
  return (important || normal || "").replace(/\s*!important$/, "");
}

// 1. 画面だけに効く
const screenRules = rules.filter(r => r.media === "screen");
t("デザインの層が @media screen にまとまっている", screenRules.length >= 40, String(screenRules.length));
t("印刷では一覧の行が全文を出す設定のまま", effective(".issue-title strong", "white-space", "print") === "normal");
t("印刷では確認済みの操作を出さない", effective(".issue .card-done", "display", "print") === "none");

// 2. 強調色を1色に絞る
const accent = (css.match(/--accent:(#[0-9a-f]{6})/gi) || []).pop() || "";
t("強調色は紺系の1色", /#1f4fbf/i.test(accent), accent);
t("--primary / --lavender も強調色にそろえる", effective(":root", "--primary") === "var(--accent)" && effective(":root", "--lavender") === "var(--accent-soft)");
t("選択中の指摘の左の線は強調色", /var\(--accent\)/.test(effective(".master-detail", "border-left")), effective(".master-detail", "border-left"));
t("「選択中の指摘」の見出しは紫ではなく控えめな灰色", effective(".master-detail>h2:first-child", "color") === "var(--muted)");
t("選択行は強調色の薄い地と左の線", effective(".issue.active", "background") === "var(--accent-soft)"
  && /var\(--accent\)/.test(effective(".issue.active", "box-shadow")), effective(".issue.active", "box-shadow"));
t("進捗バーは強調色", effective(".review-progress-bar", "background") === "var(--accent)");
t("件数の切り替えは選択中だけ強調色", effective(".compact-stats .stat.active", "color") === "var(--accent)");
const purple = ["#7567d9", "#f0efff", "#eeecff", "#4f46e5"];
for (const [sel, prop] of [[".issue.active", "box-shadow"], [".issue.active", "background"], [".master-detail", "border-left"], [".compact-stats .stat.active", "background"]]) {
  const v = effective(sel, prop).toLowerCase();
  t(`${sel} の ${prop} に紫が残っていない`, !purple.some(c => v.includes(c)), v);
}

// 3. 要所の見た目
t("見出しの前に小さな印を付ける", /data:image\/svg\+xml/.test(effective(".app header .header-line h1:before", "background")));
t("上部の案内は黄色の地をやめる", effective(".ai-notice", "background") === "transparent");
t("重要度の札は角丸4pxの控えめな札", effective(".issue-main .severity-label", "border-radius") === "4px");
t("種類の札も同じ角丸", effective(".kind-label", "border-radius") === "4px");
t("修正案の札は強調色", effective(".kind-rep", "color") === "var(--accent)");
t("ボタンは白地・細い枠でそろえる", effective(".viewer-btn", "background") === "#fff" && effective(".viewer-btn", "border") === "1px solid var(--line-strong)");
t("確認済みは緑の薄い地で示す", effective(".issue.done .card-done", "background") === "var(--done-soft)");
t("狭い幅では操作の列を折り返す", effective(".compact-controls", "flex-wrap") === "wrap" && effective(".compact-stats", "min-width") === "max-content");

// 4. #190 の読みやすさを崩していない
t("原文・修正案の枠に高さの上限が無い", effective(".master-diff-box", "max-height") === "none");
t("確認済みの操作に文字が出る", !["0", ""].includes(effective(".issue .card-done", "font-size")), effective(".issue .card-done", "font-size"));
t("確認済みの行は薄く表示する", effective(".issue.done .issue-main", "opacity") === ".5");
t("黄色の枠が太い", /^3px solid/.test(effective(".report-highlight-box", "outline")));
t("一覧の行は固定の高さで札を切らない", effective(".issue", "height") === "auto");

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + String(r.detail).slice(0, 300)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ReportBusinessDesign: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
