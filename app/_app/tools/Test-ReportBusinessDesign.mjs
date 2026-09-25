// Test-ReportBusinessDesign.mjs — 指摘レポートの白基調・ミニマルなデザインの回帰テスト。
//
// 確かめること（node だけで確かめられるもの）:
//   1. デザインの層は画面表示（@media screen）だけに効き、印刷の見た目を変えない。
//   2. 強調色は紺系の1色（--accent）に絞られ、選択中の枠・選択行・進捗に紫が残っていない。
//   3. 枠線・色付きの地・常に見えるボタンの枠を減らし、重要度は点の色だけで示す。
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
t("選択中の指摘は細い枠だけで、左の太い線を付けない", effective(".master-detail", "border") === "1px solid var(--line)"
  && effective(".master-detail", "box-shadow") === "none", effective(".master-detail", "border"));
t("「選択中の指摘」の見出しは画面に出さず読み上げ用に残す", effective(".master-detail>h2:first-child", "clip") === "rect(0 0 0 0)");
t("選択行は強調色の薄い地と細い左の線", effective(".issue.active", "background") === "var(--accent-soft)"
  && effective(".issue.active", "box-shadow") === "inset 2px 0 0 var(--accent)", effective(".issue.active", "box-shadow"));
t("進捗バーは強調色", effective(".review-progress-bar", "background") === "var(--accent)");
t("件数の切り替えは枠の無い文字で、選択中だけ薄い地", effective(".compact-stats .stat", "border") === "0"
  && effective(".compact-stats .stat.active", "background") === "var(--bg-soft)");
const purple = ["#7567d9", "#f0efff", "#eeecff", "#4f46e5"];
for (const [sel, prop] of [[".issue.active", "box-shadow"], [".issue.active", "background"], [".master-detail", "border-left"], [".compact-stats .stat.active", "background"]]) {
  const v = effective(sel, prop).toLowerCase();
  t(`${sel} の ${prop} に紫が残っていない`, !purple.some(c => v.includes(c)), v);
}

// 3. 要所の見た目
t("上部の案内は黄色の地をやめる", effective(".ai-notice", "background") === "transparent");
t("ボタンは普段は枠も地も無く、触れたときだけ薄い地", effective(".viewer-btn", "border") === "1px solid transparent"
  && effective(".viewer-btn", "background") === "transparent" && effective(".viewer-btn:hover", "background") === "var(--bg-soft)");
t("元PDFのボタンもほかと同じく枠を出さない", effective(".pdfbar #openTargetTop", "border") === "1px solid transparent");
t("重要度の札は地を付けず、点の色だけで示す", effective(".issue-main .severity-label", "background") === "transparent"
  && effective(".issue-main .severity-label.sev-high::first-letter", "color") === "var(--sev-high)"
  && effective(".master-detail[data-severity=\"high\"] .master-detail-meta::first-letter", "color") === "var(--sev-high)");
t("種類の札は枠と地を付けない", effective(".kind-label", "border") === "0" && effective(".kind-label", "background") === "transparent");
t("原文・修正案の枠は線を付けず地の色で分ける", effective(".master-diff-box", "border") === "0"
  && effective(".master-diff-box:not(:first-child)", "background") === "var(--accent-soft)");
t("一覧は外枠を付けず、行の間の細い線で区切る", effective(".issues", "border") === "0" && effective(".issue", "border-bottom") === "1px solid var(--line)");
t("確認済みの操作は普段は枠を出さない", effective(".issue .card-done", "border") === "1px solid transparent");
t("確認済みは緑の文字で示す", effective(".issue.done .card-done", "color") === "var(--done)");
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
