// Test-ReportViewNavigation.mjs — 指摘レポートの「表示する文書の切り替え」の回帰テスト（node だけで確かめられるもの）。
//
// 確かめること:
//   1. PDF枠の上に「校正対象 | 比較資料」の常設トグルと「↩ 戻る」がある。比較資料が無いレポートではトグルを隠す。
//   2. R / C / Backspace / ? のキーは、入力中の欄・修飾キー付き（Alt+← や Ctrl+R などブラウザの操作）では奪わない。
//      ← → J K は今までどおり指摘の前後移動だけに使い、表示の切り替えには使わない（#190 の1本化を崩さない）。
//   3. キー一覧は alert() ではなく画面内の一覧で出す。
//   4. 呼び名をそろえる（「日本語版」の固定文言を使わない）。言語は書き出しデータの target_language / reference_language から出す。
//   5. 文書ごとの位置の復元・比較資料の先読み・指摘を移っても比較資料の表示を保つ・履歴の配線がある。
// 実際の操作（R で往復して位置が戻る、→ で次の指摘も比較資料で開く、など）は Test-ReportViewSwitch.mjs で実ブラウザを使って確かめる。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = readFileSync(join(ROOT, "index.html"), "utf8");
const L = SOURCE.split(/\r?\n/);
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
const withRef = {
  ...data,
  target_language: "英語",
  reference_language: "日本語",
  reference_files: [{ index: 1, file_name: "ja.pdf", reference_key: "REF1_ja.pdf", zip_path: "files/reference_1.pdf", total_pages: 10 }],
  findings: [mk(1, { reference_index: 1, reference_highlight_page: 4, reference_pages: [4], reference_highlight_status: "ok" }), mk(2, {})],
};
withRef.count = withRef.findings.length;
const html = reportHtmlDocument(withRef, {});
const noRef = { ...withRef, reference_files: [], findings: [mk(1, {})] };
noRef.count = 1;
const htmlNoRef = reportHtmlDocument(noRef, {});
const script = (html.match(/<script type="module">([\s\S]*?)<\/script><\/body>/) || ["", ""])[1];

// 1. 常設のトグルと戻る
const toggle = (h) => (h.match(/<span id="docToggle"[^>]*>/) || [""])[0];
t("PDF枠のツールバーに表示文書のトグルがある", /<div class="pdfbar"><span id="docToggle" class="doc-toggle" role="group"/.test(html)
  && html.includes('<button id="viewTargetBtn" type="button" aria-pressed="true">') && html.includes('<button id="viewRefBtn" type="button" aria-pressed="false">'));
t("比較資料があるレポートではトグルを出す", toggle(html) && !/\shidden/.test(toggle(html)), toggle(html));
t("比較資料が無いレポートではトグルを隠す", /\shidden/.test(toggle(htmlNoRef)), toggle(htmlNoRef));
t("ツールバーに「↩ 戻る」があり、最初は押せない", /<button id="viewBack" class="viewer-btn ghost" type="button" disabled[^>]*>↩ 戻る<\/button>/.test(html));
t("比較資料の読み込み中の表示がある", html.includes('<div id="pdfLoading" class="pdf-loading" role="status" hidden>'));
t("「校正対象に戻る」は案内文の中に作らない（トグルに置き換えた）", !script.includes('id="backToTarget"'));

// 2. キー
const hLine = (needle) => script.split("\n").find(s => s.startsWith(needle)) || "";
const keySrc = [hLine("function reportTypingTarget("), hLine("function reportNavKeyDelta("), hLine("function reportViewKeyAction(")].join("\n");
let keys = null;
try { keys = new Function(keySrc + "\nreturn { reportNavKeyDelta, reportViewKeyAction };")(); } catch (e) { t("キー処理を取り出せる", false, String(e)); }
if (keys) {
  const { reportNavKeyDelta, reportViewKeyAction } = keys;
  const el = (tagName, extra = {}) => ({ tagName, closest: () => null, ...extra });
  const ev = (key, target = el("BODY"), extra = {}) => ({ key, target, ...extra });
  t("R で校正対象⇄比較資料", reportViewKeyAction(ev("r")) === "toggle-ref" && reportViewKeyAction(ev("R")) === "toggle-ref");
  t("C で相手側のページ", reportViewKeyAction(ev("c")) === "counterpart");
  t("Backspace で1つ前の表示", reportViewKeyAction(ev("Backspace")) === "back");
  t("? でキー一覧（Shift を押していてもよい）", reportViewKeyAction(ev("?", el("BODY"), { shiftKey: true })) === "help");
  t("一覧の行（button）・チェックにフォーカスがあっても R が効く", reportViewKeyAction(ev("r", el("BUTTON"))) === "toggle-ref"
    && reportViewKeyAction(ev("r", el("INPUT", { type: "checkbox" }))) === "toggle-ref");
  t("検索欄の入力中は R・Backspace を奪わない", reportViewKeyAction(ev("r", el("INPUT", { type: "search" }))) === ""
    && reportViewKeyAction(ev("Backspace", el("INPUT", { type: "text" }))) === "");
  t("選択リスト・複数行入力・編集可能な要素では奪わない", reportViewKeyAction(ev("c", el("SELECT"))) === ""
    && reportViewKeyAction(ev("r", el("TEXTAREA"))) === "" && reportViewKeyAction(ev("r", el("DIV", { isContentEditable: true }))) === "");
  t("Ctrl+R（再読み込み）・Alt+←（ブラウザの戻る）などは奪わない", reportViewKeyAction(ev("r", el("BODY"), { ctrlKey: true })) === ""
    && reportViewKeyAction(ev("ArrowLeft", el("BODY"), { altKey: true })) === "" && reportViewKeyAction(ev("Backspace", el("BODY"), { altKey: true })) === ""
    && reportViewKeyAction(ev("r", el("BODY"), { metaKey: true })) === "");
  t("Shift+R・Shift+C は切り替えにしない", reportViewKeyAction(ev("R", el("BODY"), { shiftKey: true })) === "" && reportViewKeyAction(ev("C", el("BODY"), { shiftKey: true })) === "");
  t("← → ↑ ↓ J K は表示の切り替えに使わない（指摘の前後移動のまま）",
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "j", "k"].every(k => reportViewKeyAction(ev(k)) === "")
    && reportNavKeyDelta(ev("ArrowRight")) === 1 && reportNavKeyDelta(ev("ArrowLeft")) === -1);
  t("R・C・Backspace は指摘の前後移動にしない", ["r", "c", "Backspace", "?"].every(k => reportNavKeyDelta(ev(k)) === 0));
}
t("Esc は表示設定・キー一覧を先に閉じ、閉じていれば校正対象の指摘ページへ戻る",
  /if\(e\.key==='Escape'\)\{if\(!keyHelpPanel\.hidden\)\{setKeyHelp\(false\);return\}if\(optionsPopover\.classList\.contains\('open'\)\)\{optionsPopover\.classList\.remove\('open'\);return\}if\(!reportTypingTarget\(e\.target\)&&\(viewRefIndex\|\|viewCounterpart>=0\)\)/.test(script));

// 3. キー一覧
t("キー一覧に alert() を使わない", !/\balert\(['"]/.test(script));
t("キー一覧に R・C・Backspace・? が載っている", ["['R','校正対象 ⇄ 比較資料']", "['C','指摘のページ ⇄ 相手側のページ']", "['Backspace','1つ前の表示に戻る']", "['?','この一覧を開く']"].every(s => script.includes(s)));

// 4. 呼び名
t("「日本語版 P.」の固定文言を使わない", !script.includes("日本語版 P."));
t("選択中の指摘の比較資料ボタンはトグルと同じ呼び名", script.includes("'+esc(docName(Number(r.reference_index)||1))+' P.'+"));
t("呼び名は 日本語・英語 のときだけ言語を添える", script.includes("function languageLabel(v){v=String(v||'');return v==='日本語'||v==='英語'?v:''}"));
t("書き出しデータに校正対象・比較資料の言語を入れる", SOURCE.includes("target_language: detectedTargetLanguage || \"\",")
  && SOURCE.includes("reference_language: referenceList.length ? (detectedReferenceLanguage || \"\") : \"\","));
t("書き出したレポートに言語が入る", html.includes('"target_language": "英語"') && html.includes('"reference_language": "日本語"'));

// 5. 配線
t("同じ指摘のまま往復したら、文書ごとの位置を戻す", script.includes("function prepareRestore(ref,ci,page)")
  && script.includes("const restore=pendingRestore&&pendingRestore.ref===(viewRefIndex||0)&&pendingRestore.page===currentPage")
  && script.includes("if(restore){pdfWrap.scrollTop=restore.top;pdfWrap.scrollLeft=restore.left;skipAutoScroll=true;"));
t("位置を戻すときは枠への自動スクロールをしない", script.includes("function scrollFirstActiveHighlightIntoView(){if(skipAutoScroll)return;"));
t("比較資料は最初の描画のあとに先読みする", script.includes("function prefetchReferences(){") && script.includes("setActive(active,false);if(!cards.length)setPage(currentPage);prefetchReferences();")
  && script.includes("requestIdleCallback(next,{timeout:3000})"));
t("読み込み中は表示を出し、終わったら消す", script.includes("setPdfLoading(true)") && script.includes("const doc=await docPromise;if(token!==renderToken)return;setPdfLoading(false);"));
t("比較資料を出したまま次の指摘へ進める（表示設定で切れる）", script.includes("if(stickyRef&&keepRefOnMove.checked&&r.reference_index){viewRefIndex=Number(r.reference_index)||1;setPage(referencePageOf(r),r);")
  && script.includes('<input id="keepRefOnMove" type="checkbox" checked> 指摘を移動しても比較資料の表示を保つ'));
t("「別の一致箇所」は校正対象側で出す", (script.match(/%count;stickyRef=false;setActive\('issue-'\+r\.no,false\)/g) || []).length === 2);
t("指摘を移ったら表示の履歴を捨てる", script.includes("if(historyActiveId!==c.id){viewHistory=[];historyActiveId=c.id}"));
t("「↩ 戻る」で1つ前の表示へ", script.includes("viewBackBtn.addEventListener('click',function(){goBackView()})") && script.includes("if(viewBackBtn)viewBackBtn.disabled=!viewHistory.length"));
t("ズームしても相手側の枠のまま描き直す", script.includes("setPage(currentPage,currentViewRecord())}"));
t("ページ番号は左上の1か所のまま", script.includes("pageLabel.textContent='P.'+currentPage;"));

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + String(r.detail).slice(0, 300)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ReportViewNavigation: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
