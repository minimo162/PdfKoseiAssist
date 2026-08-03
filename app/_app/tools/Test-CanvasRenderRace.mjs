// Test-CanvasRenderRace.mjs — 1枚の canvas を使い回す PDF.js 描画の多重実行対策を検証する。
//
//   node tools/Test-CanvasRenderRace.mjs
//
// 指摘カードを続けてクリックすると renderPdfJsOriginalViewer / renderPdfPage が重なって走り、
// 前の RenderTask を cancel していないと PDF.js が
//   "Cannot use the same canvas during multiple render() operations."
// を投げる。index.html の対策（進行中タスクを保持 → 次の描画前に cancel → reject を await）が
// 実際に効くことを、同梱の PDF.js と実ブラウザで確認する。
//
// playwright が無い環境（配布先など）では SKIP して終了する。

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const FIXTURE = "docs/benchmarks/fixtures/aoi-seiki_en_TARGET.pdf";
if (!existsSync(join(appDir, FIXTURE))) {
  console.log(`SKIP: ${FIXTURE} がありません（node docs/benchmarks/fixtures/build-fixture.mjs で生成）`);
  process.exit(0);
}

async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const m = await import(join(root, "playwright", "index.js"));
    return m.chromium || m.default?.chromium;
  } catch { return null; }
}
const chromium = await loadChromium();
if (!chromium) { console.log("SKIP: playwright が見つかりません"); process.exit(0); }

// index.html と同じ対策パターンを、同梱 PDF.js に対して実行する検証ページ。
const PAGE = `<!doctype html><html><body><canvas id="c"></canvas>
<script>
// 古い Chromium 向け（同梱 PDF.js が要求する新しめの Map API を補う）。
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsertComputed) C.prototype.getOrInsertComputed = function (k, f) {
    if (this.has(k)) return this.get(k); const v = f(k); this.set(k, v); return v; };
  if (!C.prototype.getOrInsert) C.prototype.getOrInsert = function (k, v) {
    if (this.has(k)) return this.get(k); this.set(k, v); return v; };
}
</script>
<script type="module">
import * as pdfjsLib from "/pdfjs/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.min.mjs";
const canvas = document.getElementById("c");
const doc = await pdfjsLib.getDocument("/${FIXTURE}").promise;

// index.html の isPdfJsRenderCancelled / isRenderCancelled と同じ判定。
function isCancelled(e){ if(!e) return false; const n=String(e.name||"");
  if(n==="RenderingCancelledException"||n==="AbortException") return true;
  return /cancel/i.test(String(e.message||"")); }

async function paint(n, state, mode){
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha:false });
  ctx.fillStyle="#fff"; ctx.fillRect(0,0,viewport.width,viewport.height);
  if (mode === "unguarded") { await page.render({ canvasContext: ctx, viewport }).promise; return; }
  const task = page.render({ canvasContext: ctx, viewport });
  state.task = task;
  try { await task.promise; }
  catch (e) { if (isCancelled(e)) return; throw e; }
  finally { if (state.task === task) state.task = null; }
}

async function run(mode){
  const state = { task: null };
  const errors = [];
  const calls = [];
  for (let n = 1; n <= 8; n++) {
    calls.push((async () => {
      try {
        if (mode === "guarded" && state.task) {          // ← index.html の cancelPdfJsOriginalRender 相当
          const t = state.task; state.task = null;
          try { t.cancel(); } catch {}
          try { await t.promise; } catch {}
        }
        await paint(n, state, mode);
      } catch (e) { errors.push(String(e.message || e)); }
    })());
    await new Promise(r => setTimeout(r, 5));            // 指摘カードの連続クリック相当
  }
  await Promise.all(calls);
  return errors;
}

window.__result = { unguarded: await run("unguarded"), guarded: await run("guarded") };
<\/script></body></html>`;

const PORT = 8749;
const pagePath = join(appDir, ".canvas-race-check.html");
writeFileSync(pagePath, PAGE);
const server = spawn(process.execPath, ["-e", `
  const http=require("http"),fs=require("fs"),path=require("path");
  const types={".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".pdf":"application/pdf"};
  http.createServer((req,res)=>{
    const p=path.join(${JSON.stringify(appDir)}, decodeURIComponent(req.url.split("?")[0]));
    fs.readFile(p,(e,b)=>{ if(e){res.writeHead(404);res.end();return;}
      res.writeHead(200,{"content-type":types[path.extname(p)]||"application/octet-stream"});res.end(b); });
  }).listen(${PORT});
`], { stdio: "ignore" });

let failures = 0;
try {
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/.canvas-race-check.html`);
    await page.waitForFunction("window.__result", null, { timeout: 120000 });
    const result = await page.evaluate(() => window.__result);
    const sameCanvas = e => /same canvas during multiple render/i.test(e);

    // 対策なしでは実際に起きることを先に確認する（起きないなら検証が空回りしている）。
    if (!result.unguarded.some(sameCanvas)) {
      failures++;
      console.error("  FAIL 対策なしでも同一canvasエラーが再現しない（検証が無効）");
    } else console.log(`  ok   対策なしでは再現する（${result.unguarded.length}件）`);

    const leaked = result.guarded.filter(sameCanvas);
    if (leaked.length) { failures++; console.error(`  FAIL 対策ありで同一canvasエラー ${leaked.length}件: ${leaked[0]}`); }
    else console.log("  ok   対策ありでは発生しない");

    const others = result.guarded.filter(e => !sameCanvas(e));
    if (others.length) { failures++; console.error(`  FAIL 対策ありで別のエラー: ${others[0]}`); }
    else console.log("  ok   対策ありで他のエラーも無い");
  } finally { await browser.close(); }
} finally {
  server.kill();
  try { unlinkSync(pagePath); } catch {}
}

// index.html 側に対策コードが残っているかも見る（テストだけ通って本体から消える事故を防ぐ）。
const html = readFileSync(join(appDir, "index.html"), "utf8");
for (const [label, needle] of [
  ["元PDFビューア: cancelPdfJsOriginalRender", "await cancelPdfJsOriginalRender();"],
  ["元PDFビューア: RenderTask 保持", "pdfJsOriginalRenderTask = task;"],
  ["指摘レポート: cancelActiveRender", "await cancelActiveRender();"],
  ["指摘レポート: RenderTask 保持", "renderTask=task;"],
]) {
  if (html.includes(needle)) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label} が index.html に無い`); }
}

if (failures) { console.error(`\nTest-CanvasRenderRace: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-CanvasRenderRace: PASS");
