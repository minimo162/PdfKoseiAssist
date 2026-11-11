// Test-ReportViewSwitch.mjs — 指摘レポートの「校正対象／比較資料」の切り替えを実ブラウザで確かめる。
//
//   node tools/Test-ReportViewSwitch.mjs
//
// 書き出しと同じ reportHtmlDocument() で作ったレポートに、フィクスチャの英語PDF（校正対象）と
// 日本語PDF（比較資料）を入れて開き、キーとボタンで操作する。確かめること:
//   1. R で校正対象⇄比較資料を往復でき、同じ指摘のままなら文書ごとに前のスクロール位置へ戻る。
//   2. 比較資料を出したまま → で次の指摘へ進むと、次の指摘も比較資料で開く。比較資料の無い指摘では校正対象に戻して知らせる。
//      表示設定のチェックを外すと、指摘を移ったときに校正対象へ戻る。
//   3. 「↩ 戻る」/ Backspace で1つ前の表示へ戻る。指摘を移ると履歴は捨てる。
//   4. C で相手側のページ ⇄ 指摘のページ。Esc で指摘のページへ戻る。? でキー一覧（alert ではない）を開閉する。
//   5. 比較資料は先読みされ、ページのエラーが出ない。
//   6. 指摘を移ると、前の指摘の赤字エラー・トーストを持ち越さない（照合が ok でも error でもない指摘へ移っても消える）。
//
// playwright が無い環境では SKIP して終了する（PDF_KOSEI_PLAYWRIGHT_DIR に node_modules を指定してもよい）。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET = join(ROOT, "docs/benchmarks/fixtures/aoi-seiki_en_TARGET.pdf");
const REF = join(ROOT, "docs/benchmarks/fixtures/aoi-seiki_ja_REF.pdf");
for (const f of [TARGET, REF]) if (!existsSync(f)) { console.log(`SKIP: ${f} がありません`); process.exit(0); }

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch {}
for (const root of [process.env.PDF_KOSEI_PLAYWRIGHT_DIR, ...(!chromium ? [(() => { try { return execSync("npm root -g", { encoding: "utf8" }).trim(); } catch { return ""; } })()] : [])]) {
  if (chromium || !root) continue;
  try { ({ chromium } = await import(pathToFileURL(join(root, "playwright", "index.mjs")).href)); } catch {}
}
if (!chromium) { console.log("SKIP: playwright が見つかりません"); process.exit(0); }

const L = readFileSync(join(ROOT, "index.html"), "utf8").split(/\r?\n/);
const fn = (needle) => {
  const i = L.findIndex(s => s.includes(needle));
  if (i < 0) throw new Error("index.html に見つかりません: " + needle);
  const indent = L[i].match(/^\s*/)[0];
  for (let j = i + 1; j < L.length; j++) if (L[j] === indent + "}") return L.slice(i, j + 1).join("\n");
  throw new Error("閉じ括弧が見つかりません: " + needle);
};
const line = (needle) => L.find(s => s.includes(needle)) || "";
const src = [line("const categoryLabels ="), line("const categoryLabel ="), fn("function reportHtmlDocument("), fn("function suggestionKind(s)"),
  fn("function severityLabel(sev)"), fn("function pagesToRangeText(pages)"), fn("function escapeHtml(value)"), fn("function safeText(value, max"),
  `function reportScriptTag(s){ return '<script src="' + s + '"></scr' + 'ipt>' }`, `function locatorTokens(){ return [] }`].join("\n");
const { reportHtmlDocument } = eval("(function(){" + src + "; return { reportHtmlDocument }})()");

const rawDir = join(ROOT, "docs/benchmarks/runs/raw");
const pick = readdirSync(rawDir).filter(f => f.endsWith(".json")).sort().pop();
const data = JSON.parse(readFileSync(join(rawDir, pick), "utf8"));
const base = data.findings[0];
const box = (y) => [{ x: 12, y, w: 40, h: 3 }];
const mk = (no, over) => ({ ...base, no, id: "F" + no, excluded_reason: "", self_check: "", quality_warning: "", reference_index: 0,
  reference_pages: [], reference_highlight_page: 0, reference_highlight_boxes: [], reference_highlight_status: "none", counterparts: [],
  highlight_status: "ok", highlight_boxes: box(70), highlight_candidates: [box(70)], highlight_match_count: 1, ...over });
const refOf = (page, y) => ({ reference_index: 1, reference_pages: [page], reference_highlight_page: page, reference_highlight_boxes: box(y), reference_highlight_status: "ok" });
const fixture = {
  ...data,
  exported_at: "2026-11-02T00:00:00.000Z",
  target_language: "英語",
  reference_language: "日本語",
  reference_files: [{ index: 1, file_name: "aoi-seiki_ja_REF.pdf", reference_key: "REF1_aoi-seiki_ja_REF.pdf", zip_path: "files/reference_1.pdf", total_pages: 27 }],
  current_target_pages: "1-26",
  findings: [
    mk(1, { page: 3, ...refOf(4, 75), counterparts: [{ page: 5, status: "ok", quote: "x", boxes: box(20) }] }),
    mk(2, { page: 6 }),
    mk(3, { page: 8, ...refOf(9, 60) }),
    mk(4, { page: 12, highlight_status: "error", highlight_error: "quote を照合できません。", highlight_boxes: [], highlight_candidates: [], highlight_match_count: 0 }),
    mk(5, { page: 13, highlight_status: "pending", highlight_boxes: [], highlight_candidates: [], highlight_match_count: 0 }),
  ],
};
fixture.count = fixture.findings.length;
fixture.total_count = fixture.findings.length;
fixture.excluded_count = 0;
const html = reportHtmlDocument(fixture, { targetPayloadScriptTags: '<script src="payload.js"></script>' });
const b64 = (p) => readFileSync(p).toString("base64");
const files = {
  "/report.html": ["text/html", html],
  "/assets/pdfjs_payload.js": ["text/javascript",
    `window.__PDF_KOSEI_PDFJS_LIB_B64_CHUNKS__=[${JSON.stringify(b64(join(ROOT, "pdfjs/build/pdf.min.mjs")))}];\n`
    + `window.__PDF_KOSEI_PDFJS_WORKER_B64_CHUNKS__=[${JSON.stringify(b64(join(ROOT, "pdfjs/build/pdf.worker.min.mjs")))}];\n`],
  "/payload.js": ["text/javascript",
    `window.__PDF_KOSEI_TARGET_PDF_B64_CHUNKS__=[${JSON.stringify(b64(TARGET))}];\n`
    + `window.__PDF_KOSEI_REF_PDF_B64_CHUNKS_1__=[${JSON.stringify(b64(REF))}];\n`],
};

const results = [];
const t = (name, ok, detail = "") => results.push({ ok: !!ok, name, detail });

let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch(process.env.PDF_KOSEI_CHROMIUM ? { executablePath: process.env.PDF_KOSEI_CHROMIUM } : { channel: "msedge" }); }
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  await context.route("http://127.0.0.1:59996/**", route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (files[path]) return route.fulfill({ status: 200, contentType: files[path][0], body: files[path][1] });
    if (path.startsWith("/assets/cmaps/")) {
      const f = join(ROOT, "pdfjs/cmaps", path.slice("/assets/cmaps/".length));
      if (existsSync(f)) return route.fulfill({ status: 200, contentType: extname(f) === ".bcmap" ? "application/octet-stream" : "text/plain", body: readFileSync(f) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  const page = await context.newPage();
  // 古い Chromium 向け（同梱 PDF.js が要求する新しめの Map API を補う）。
  await page.addInitScript(() => {
    for (const C of [Map, WeakMap]) {
      if (!C.prototype.getOrInsertComputed) C.prototype.getOrInsertComputed = function (k, f) { if (this.has(k)) return this.get(k); const v = f(k); this.set(k, v); return v; };
      if (!C.prototype.getOrInsert) C.prototype.getOrInsert = function (k, v) { if (this.has(k)) return this.get(k); this.set(k, v); return v; };
    }
  });
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e.message).slice(0, 200)));
  page.on("dialog", d => { pageErrors.push("dialog: " + d.message().slice(0, 80)); d.dismiss(); });
  await page.goto("http://127.0.0.1:59996/report.html");

  const state = () => page.evaluate(() => ({
    view: document.querySelector(".page-pane").dataset.view,
    label: document.getElementById("pageLabel").textContent,
    top: Math.round(document.getElementById("pdfWrap").scrollTop),
    active: document.querySelector(".issue.active")?.dataset.no,
    back: document.getElementById("viewBack").disabled,
    refBtn: document.getElementById("viewRefBtn").textContent,
    refDisabled: document.getElementById("viewRefBtn").disabled,
    target: document.getElementById("viewTargetBtn").textContent,
    pressed: document.getElementById("viewRefBtn").getAttribute("aria-pressed"),
    toast: document.getElementById("viewToast").hidden ? "" : document.getElementById("viewToast").textContent,
    hint: document.querySelector(".pdf-hint").textContent,
    hintError: document.querySelector(".pdf-hint").classList.contains("error"),
    loading: !document.getElementById("pdfLoading").hidden,
  }));
  // 描画が終わり、黄色・青の枠が出て、自動スクロール（requestAnimationFrame）も済むまで待つ。
  const settle = async (view, label) => {
    await page.waitForFunction(([v, l]) => document.querySelector(".page-pane").dataset.view === v
      && document.getElementById("pageLabel").textContent === l
      && document.getElementById("pdfLoading").hidden
      && document.querySelectorAll("#highlightLayer .report-highlight-box").length > 0, [view, label], { timeout: 15000 });
    await page.waitForTimeout(250);
    return state();
  };
  const press = async (key) => { await page.keyboard.press(key); };
  const setTop = (y) => page.evaluate(v => { document.getElementById("pdfWrap").scrollTop = v; }, y);
  const near = (a, b) => Math.abs(a - b) <= 2;

  let s = await settle("target", "P.3");
  t("最初は校正対象を出す", s.view === "target" && s.active === "1" && s.pressed === "false", JSON.stringify(s));
  t("トグルの呼び名に言語を添える", s.target === "校正対象（英語）" && s.refBtn.startsWith("比較資料（日本語）"), JSON.stringify(s));
  t("最初は「↩ 戻る」を押せない", s.back === true);
  const scrollable = await page.evaluate(() => { const w = document.getElementById("pdfWrap"); return w.scrollHeight - w.clientHeight; });
  t("PDF枠がスクロールできる大きさで描かれる（位置の復元を確かめられる）", scrollable > 160, String(scrollable));
  // 比較資料は先読みされる（初回の R で読み込み待ちにならない）
  await page.waitForFunction(() => !document.getElementById("viewRefBtn").textContent.includes("読み込み中"), null, { timeout: 15000 });

  await setTop(120);
  await press("r");
  s = await settle("ref", "P.4");
  t("R で比較資料の対応ページへ", s.view === "ref" && s.pressed === "true" && s.refBtn === "比較資料（日本語）", JSON.stringify(s));
  t("比較資料を出すと「↩ 戻る」を押せる", s.back === false);
  await setTop(140);
  await press("r");
  s = await settle("target", "P.3");
  t("R で校正対象へ戻ると、前に見ていた位置（120）へ戻る", near(s.top, 120), JSON.stringify(s));
  await press("r");
  s = await settle("ref", "P.4");
  t("もう一度 R で比較資料へ行くと、比較資料で見ていた位置（140）へ戻る", near(s.top, 140), JSON.stringify(s));

  await page.click("#viewBack");
  s = await settle("target", "P.3");
  t("「↩ 戻る」で1つ前（校正対象・位置120）へ", near(s.top, 120), JSON.stringify(s));
  await press("Backspace");
  s = await settle("ref", "P.4");
  t("Backspace でさらに1つ前（比較資料・位置140）へ", near(s.top, 140), JSON.stringify(s));

  // 比較資料を出したまま次の指摘へ
  await press("ArrowRight");
  s = await settle("target", "P.6");
  t("比較資料の無い指摘では校正対象に戻して知らせる", s.active === "2" && s.refDisabled && s.toast.includes("比較資料の対応箇所がない"), JSON.stringify(s));
  t("指摘を移ると表示の履歴を捨てる", s.back === true);
  await press("ArrowRight");
  s = await settle("ref", "P.9");
  t("比較資料を出したまま → で進むと、次の指摘も比較資料で開く", s.active === "3" && s.pressed === "true", JSON.stringify(s));
  t("前の指摘の「比較資料の対応箇所がない」トーストを次の指摘へ持ち越さない", s.toast === "", JSON.stringify(s));

  await press("Escape");
  s = await settle("target", "P.8");
  t("Esc で校正対象の指摘ページへ戻る", s.active === "3", JSON.stringify(s));
  await press("ArrowLeft");
  await settle("target", "P.6");
  await press("ArrowLeft");
  s = await settle("target", "P.3");
  t("校正対象へ戻したあとは、指摘を移っても校正対象のまま", s.active === "1", JSON.stringify(s));

  // 相手側のページ
  await press("c");
  s = await settle("counter", "P.5（相手側）");
  t("C で相手側のページへ", s.active === "1" && s.back === false, JSON.stringify(s));
  await press("c");
  s = await settle("target", "P.3");
  t("もう一度 C で指摘のページへ", s.active === "1", JSON.stringify(s));
  await press("Backspace");
  s = await settle("counter", "P.5（相手側）");
  t("Backspace で相手側のページへ戻る", s.active === "1", JSON.stringify(s));
  await page.click("#viewRefBtn");
  s = await settle("ref", "P.4");
  t("相手側から比較資料のボタンで比較資料へ", s.view === "ref", JSON.stringify(s));
  await page.click("#viewTargetBtn");
  s = await settle("target", "P.3");
  t("校正対象のボタンで指摘のページへ", s.view === "target", JSON.stringify(s));

  // 表示設定で「比較資料の表示を保つ」を外す
  await page.evaluate(() => { const cb = document.getElementById("keepRefOnMove"); cb.checked = false; cb.dispatchEvent(new Event("change")); });
  await press("r");
  await settle("ref", "P.4");
  await press("ArrowRight");
  await settle("target", "P.6");
  await press("ArrowRight");
  s = await settle("target", "P.8");
  t("「比較資料の表示を保つ」を外すと、指摘を移ったら校正対象に戻る", s.active === "3", JSON.stringify(s));

  // 前の指摘の赤字エラーを、次の指摘へ持ち越さない。ハイライトの無い指摘（照合が ok でも error でもない）へ移っても消える。
  await page.evaluate(() => { const cb = document.getElementById("keepRefOnMove"); cb.checked = true; cb.dispatchEvent(new Event("change")); });
  // ハイライト枠の無い指摘は settle() で待てないので、ページの描画が終わるまで待つ。
  const settleNoBox = async (label) => {
    await page.waitForFunction(l => document.querySelector(".page-pane").dataset.view === "target"
      && document.getElementById("pageLabel").textContent === l && document.getElementById("pdfLoading").hidden, label, { timeout: 15000 });
    await page.waitForTimeout(600);
    return state();
  };
  await press("r");
  await settle("ref", "P.9");
  await press("ArrowRight");
  s = await settleNoBox("P.12");
  t("照合できなかった指摘では、その指摘を出している間は赤字のエラーを出す", s.active === "4" && s.hintError && s.hint.includes("該当箇所を表示できませんでした"), JSON.stringify(s));
  await press("ArrowRight");
  s = await settleNoBox("P.13");
  t("次の指摘（照合が ok でも error でもない）へ移ると、前の指摘の赤字エラーが残らない", s.active === "5" && !s.hintError && !s.hint.includes("該当箇所を表示できませんでした"), JSON.stringify(s));
  await press("ArrowLeft");
  s = await settleNoBox("P.12");
  t("エラーの指摘へ戻ると、もう一度赤字のエラーを出す", s.active === "4" && s.hintError, JSON.stringify(s));
  await press("ArrowLeft");
  s = await settle("ref", "P.9");
  t("比較資料のある指摘へ移ると、前の指摘の赤字エラーではなく比較資料の案内を出す", s.active === "3" && !s.hintError && s.hint.includes("比較資料（日本語）を表示しています"), JSON.stringify(s));
  await page.evaluate(() => { const cb = document.getElementById("keepRefOnMove"); cb.checked = false; cb.dispatchEvent(new Event("change")); });
  await press("Escape");
  await settle("target", "P.8");

  // キー一覧
  await press("?");
  t("? でキー一覧を開く（alert ではない）", await page.locator("#keyHelpPanel").isVisible());
  t("キー一覧に R・C・Backspace が載っている", /R[\s\S]*校正対象 ⇄ 比較資料[\s\S]*C[\s\S]*相手側[\s\S]*Backspace/.test(await page.locator("#keyHelpPanel").textContent()));
  await press("Escape");
  t("Esc でキー一覧を閉じる", !(await page.locator("#keyHelpPanel").isVisible()));
  s = await state();
  t("キー一覧を閉じる Esc では表示を変えない", s.view === "target" && s.label === "P.8", JSON.stringify(s));

  // 検索欄の入力中は R を奪わない
  await page.click("#q");
  await page.keyboard.type("r");
  s = await state();
  t("検索欄では r を文字として入力する（表示を切り替えない）", s.view === "target" && (await page.inputValue("#q")) === "r", JSON.stringify(s));

  t("ページのエラー・ダイアログが出ない", pageErrors.length === 0, pageErrors.join(" | "));
} finally { await browser.close(); }

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + String(r.detail).slice(0, 400)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ReportViewSwitch: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
