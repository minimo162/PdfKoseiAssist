// Test-Issue190ReportReadability.mjs — 指摘レポートの見やすさ（#190）の回帰テスト。
//
// 確かめること（node だけで確かめられるもの）:
//   1. 修正案の種類（置き換え英文／やること）は、一覧に札としては出さず、詳細欄の見出しと差分の出し分けに使う。
//      #190 で一覧に「修正案」「やること」「要確認」の札を付けたが、違いが分かりにくいという利用者の判断で
//      #192 で取りやめた。種類は data-kind と詳細欄の差分表示（isAct）に残る。
//   2. ← → キーで前後の指摘へ移動でき、検索欄などの入力中は奪わない。
//   3. 原文・修正案・やることの枠に、文を途中で切る固定の高さ・行数制限が残っていない。
//   4. 前後移動は「◀ n/N ▶」に1本化されている（左上の「前・次」とページ選択の「◀▶」が無い）。
// 画面での見え方はスクリーンショットで確かめた（PR #190 の本文を参照）。
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
const { reportHtmlDocument, suggestionKind } =
  eval("(function(){" + src + "; return { reportHtmlDocument, suggestionKind }})()");

const rawDir = join(ROOT, "docs/benchmarks/runs/raw");
const pick = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith(".json")).sort().pop() : null;
if (!pick) { console.error("素材の実行結果がありません: " + rawDir); process.exit(1); }
const data = JSON.parse(readFileSync(join(rawDir, pick), "utf8"));
const base = data.findings[0];
const mk = (no, over) => ({ ...base, no, id: "F" + no, page: 3, excluded_reason: "", self_check: "", quality_warning: "", ...over });
const fixture = {
  ...data,
  findings: [
    mk(1, { suggestion: "Number of treasury shares", suggestion_kind: "replacement" }),
    mk(2, { suggestion: "\"existing subordinated loans\" を \"Existing Subordinated Loan\" に統一する。", suggestion_kind: "action" }),
    mk(3, { suggestion: "", suggestion_kind: "" }),
    mk(4, { suggestion: "Changed text", suggestion_kind: "action", self_check: "suspect", self_check_reason: "理由" }),
  ],
};
fixture.count = fixture.findings.length;
const html = reportHtmlDocument(fixture, {});

// 1. 種類は画面に札として出さず、差分の出し分けにだけ使う
const article = (no) => (html.match(new RegExp(`<article class="issue[^"]*" id="issue-${no}"[\\s\\S]*?</article>`)) || [""])[0];
const rowMain = (no) => (article(no).match(/<button type="button" class="issue-main"[\s\S]*?<\/button>/) || [""])[0];
t("一覧の行に「修正案」「やること」の札を出さない", fixture.findings.every(r => !rowMain(r.no).includes("kind-label")), rowMain(2));
t("一覧の行に「要確認」の札を出さない", !rowMain(4).includes("要確認") && !html.includes("nhr-label"), rowMain(4));
// 一覧の札は出さないまま、詳細欄の見出しだけを種類で言い分ける（v95.5 後の外部レビュー「貼り替える英文か、調べる指示かが分かりにくい」）。
t("詳細欄の見出しは「置き換え候補」「確認すること」で言い分ける", html.includes("<small>'+(isAct?'確認すること':'置き換え候補')+'</small>")
  && !html.includes("<small>修正案</small>")
  && !html.includes("やること（貼り付け用の英文ではありません）") && !html.includes("修正案（この英文に置き換えます）"));
t("置き換え候補には、確認して反映する旨と、候補文だけのコピーを添える", html.includes("採用する場合は元の資料に反映してください") && html.includes("data-master-copy-suggestion"));
t("種類は差分の出し分け（やることは原文との差分にしない）に残る", html.includes("isAct=r.suggestion_kind==='action'")
  && fixture.findings.filter(r => String(r.suggestion || "").trim()).every(r => article(r.no).includes(`data-kind="${r.suggestion_kind}"`)));
t("札は suggestionKind() の判定を使った書き出しとも一致する",
  suggestionKind("Number of treasury shares") === "replacement");

// 2. キーボード
const script = (html.match(/<script type="module">([\s\S]*?)<\/script><\/body>/) || ["", ""])[1];
const hLine = (needle) => script.split("\n").find(s => s.startsWith(needle)) || "";
const keySrc = [hLine("function reportTypingTarget("), hLine("function reportNavKeyDelta(")].join("\n");
let reportNavKeyDelta = null;
try { ({ reportNavKeyDelta } = new Function(keySrc + "\nreturn { reportNavKeyDelta };")()); } catch (e) { t("キー処理を取り出せる", false, String(e)); }
if (reportNavKeyDelta) {
  const el = (tagName, extra = {}) => ({ tagName, closest: () => null, ...extra });
  const ev = (key, target, extra = {}) => ({ key, target, ...extra });
  t("→ キーで次の指摘へ", reportNavKeyDelta(ev("ArrowRight", el("BODY"))) === 1);
  t("← キーで前の指摘へ", reportNavKeyDelta(ev("ArrowLeft", el("BODY"))) === -1);
  t("一覧の行（button）にフォーカスがあっても → で進める", reportNavKeyDelta(ev("ArrowRight", el("BUTTON"))) === 1);
  t("確認済みのチェックにフォーカスがあっても ← で戻れる", reportNavKeyDelta(ev("ArrowLeft", el("INPUT", { type: "checkbox" }))) === -1);
  t("検索欄の入力中は ← → を奪わない", reportNavKeyDelta(ev("ArrowRight", el("INPUT", { type: "search" }))) === 0
    && reportNavKeyDelta(ev("ArrowLeft", el("INPUT", { type: "text" }))) === 0);
  t("選択リスト・複数行入力では ← → を奪わない", reportNavKeyDelta(ev("ArrowRight", el("SELECT"))) === 0
    && reportNavKeyDelta(ev("ArrowLeft", el("TEXTAREA"))) === 0);
  t("編集可能な要素の中では ← → を奪わない", reportNavKeyDelta(ev("ArrowRight", el("DIV", { isContentEditable: true }))) === 0
    && reportNavKeyDelta(ev("ArrowRight", el("SPAN", { closest: () => ({}) }))) === 0);
  t("Alt+← （ブラウザの戻る）などの修飾キー付きは奪わない", reportNavKeyDelta(ev("ArrowLeft", el("BODY"), { altKey: true })) === 0
    && reportNavKeyDelta(ev("ArrowRight", el("BODY"), { ctrlKey: true })) === 0);
  t("ほかのキーは移動にしない", reportNavKeyDelta(ev("a", el("BODY"))) === 0 && reportNavKeyDelta(ev("Enter", el("BODY"))) === 0);
}
t("keydown の処理が reportNavKeyDelta を使う", /document\.addEventListener\('keydown',function\(e\)\{const delta=reportNavKeyDelta\(e\)/.test(script));

// 3. 文を途中で切らない（印刷以外で最後に効く宣言を見る）
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
function screenRules(text) {
  const rules = [];
  let i = 0;
  const walk = (inPrint) => {
    while (i < text.length) {
      const open = text.indexOf("{", i), close = text.indexOf("}", i);
      if (close >= 0 && (open < 0 || close < open)) { i = close + 1; return; }
      if (open < 0) { i = text.length; return; }
      const head = text.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith("@")) { walk(inPrint || /\bprint\b/.test(head)); continue; }
      const end = text.indexOf("}", i);
      if (!inPrint) rules.push({ selectors: head.split(",").map(s => s.trim()), body: text.slice(i, end) });
      i = end + 1;
    }
  };
  walk(false);
  return rules;
}
const rules = screenRules(css.replace(/\/\*[\s\S]*?\*\//g, ""));
function effective(selector, prop) {
  let normal = null, important = null;
  for (const r of rules) {
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
t("原文・修正案の枠に高さの上限が無い", effective(".master-diff-box", "max-height") === "none", effective(".master-diff-box", "max-height"));
t("原文・修正案の枠ではみ出しを切り捨てない", effective(".master-diff-box", "overflow") === "visible", effective(".master-diff-box", "overflow"));
t("一覧側の原文・修正案も行数で切らない", effective(".always-diff .diff-text", "-webkit-line-clamp") === "unset"
  && effective(".always-diff .diff-text", "overflow") === "visible");
t("選択中の指摘欄は高さの上限を設けて中だけスクロールする",
  /calc\(/.test(effective(".master-detail", "max-height")) && effective(".master-detail", "overflow-y") === "auto");
t("一覧の行は固定の高さで札を切らない", effective(".issue", "height") === "auto");
t("確認済みの行は薄く表示する", effective(".issue.done .issue-main", "opacity") === ".5");
t("確認済みの操作に文字が出る（font-size:0 で隠さない）", effective(".issue .card-done", "font-size") !== "0"
  && article(1).includes('title="この指摘を確認済みにする">確認済み</label>'));
t("黄色の枠が太い", /^3px solid/.test(effective(".report-highlight-box", "outline")), effective(".report-highlight-box", "outline"));

// 4. 前後移動の1本化・PDFの幅表示
t("左上の「前・次」ボタンが無い", !html.includes('id="prevIssue"') && !html.includes('id="nextIssue"'));
t("ページ選択の「◀▶」が無い", !html.includes('id="pageJumpPrev"') && !html.includes('id="pageJumpNext"'));
t("ページ選択（ドロップダウン）は残す", html.includes('<select id="pageJump"'));
t("選択中の指摘の「◀ n/N ▶」がある", html.includes("data-master-prev") && html.includes("data-master-next") && html.includes("master-pos"));
t("縮小・拡大・標準・幅は残す", ["zoomOut", "zoomIn", "zoomReset", "zoomFitWidth"].every(id => html.includes(`id="${id}"`)));
t("PDFは最初から幅表示で開く", script.includes("let zoomMode='page-width'") && script.includes("setZoom('page-width');setActive(active,false)"));
t("幅表示は文字のある範囲に合わせる", script.includes("async function contentFitBox(") && script.includes("await contentFitBox(page,base,"));
t("指摘を選ぶとハイライトを枠の中央へ送る", script.includes("function scrollFirstActiveHighlightIntoView") && script.includes("(wrapRect.top+wrapRect.bottom)/2"));

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + String(r.detail).slice(0, 300)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-Issue190ReportReadability: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
