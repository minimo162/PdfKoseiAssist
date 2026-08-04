// Test-BenchmarkHook.mjs — 自動実行の入口が実ブラウザで動くことを確認する。
//
//   node tools/Test-BenchmarkHook.mjs
//
// Run-Benchmark.ps1 は CDP 越しに window.__koseiBenchmark を呼ぶ。名前の対応は
// Test-BenchmarkDriver.mjs で見ているが、**実際に PDF を読み込めるか**は
// 実ブラウザで動かさないと分からない。ここが壊れていると、実機で40分走らせた末に
// 「校正対象を読み込めません」で止まる。
//
// 確認するのは自動実行の準備部分だけで、Copilot への送信は行わない
// （サーバーと Copilot が要るため）。
//
// playwright が無い環境では SKIP して終了する。

import { existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const TARGET = "docs/benchmarks/fixtures/aoi-long_en_TARGET.pdf";
const REF = "docs/benchmarks/fixtures/aoi-long_ja_REF.pdf";
const PORT = 8791;

for (const f of [TARGET, REF]) {
  if (!existsSync(join(appDir, f))) {
    console.log(`SKIP: ${f} がありません（node docs/benchmarks/fixtures/build-long-fixture.mjs で生成）`);
    process.exit(0);
  }
}

async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const m = await import(join(root, "playwright", "index.js"));
    return m.chromium || m.default?.chromium || null;
  } catch { return null; }
}
const chromium = await loadChromium();
if (!chromium) { console.log("SKIP: playwright が見つかりません"); process.exit(0); }

const server = spawn(process.execPath, ["-e", `
  const http=require("http"),fs=require("fs"),path=require("path");
  const types={".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".pdf":"application/pdf",".json":"application/json"};
  http.createServer((req,res)=>{
    const p=path.join(${JSON.stringify(appDir)}, decodeURIComponent(req.url.split("?")[0]));
    fs.readFile(p,(e,b)=>{ if(e){res.writeHead(404);res.end();return;}
      res.writeHead(200,{"content-type":types[path.extname(p)]||"application/octet-stream"});res.end(b); });
  }).listen(${PORT});
`], { stdio: "ignore" });

let failures = 0;
const t = (name, cond, detail) => {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); if (detail !== undefined) console.error(`       ${detail}`); }
  else console.log(`  ok   ${name}`);
};

try {
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // 古い Chromium 向け（同梱 PDF.js が要求する新しめの Map API を補う）。
    await page.addInitScript(() => {
      for (const C of [Map, WeakMap]) {
        if (!C.prototype.getOrInsertComputed) C.prototype.getOrInsertComputed = function (k, f) {
          if (this.has(k)) return this.get(k); const v = f(k); this.set(k, v); return v; };
        if (!C.prototype.getOrInsert) C.prototype.getOrInsert = function (k, v) {
          if (this.has(k)) return this.get(k); this.set(k, v); return v; };
      }
    });
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(String(e.message).slice(0, 160)));

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__koseiBenchmark), null, { timeout: 20000 });
    t("入口が現れる", true);

    // Run-Benchmark.ps1 が呼ぶのと同じ順序・同じ引数で叩く
    const target = await page.evaluate(p => window.__koseiBenchmark.loadTarget(p), `/${TARGET}`);
    t("校正対象PDFをURLから読み込める（139ページ）", target.total_pages === 139, JSON.stringify(target));

    const ref = await page.evaluate(p => window.__koseiBenchmark.loadReference(p), `/${REF}`);
    t("比較資料PDFをURLから読み込める（140ページ）", ref.reference_total_pages === 140, JSON.stringify(ref));

    // 「全範囲を自動校正」は現在のページ範囲を分割するので、全ページ選択が効いていないと
    // 先頭10ページだけを測ってしまう。ここが静かに壊れると結果が丸ごと嘘になる。
    const all = await page.evaluate(() => window.__koseiBenchmark.selectAllPages());
    t("全139ページが校正対象になる", all.target_pages === 139, JSON.stringify(all));

    // 10ページ上限を外した効果の確認。25 が通らないと Q2 が測れない。
    const chunk25 = await page.evaluate(() => window.__koseiBenchmark.setChunkSize(25));
    t("1パケット25ページを設定できる（上限10のままなら10に丸められる）", chunk25.chunk === 25, JSON.stringify(chunk25));
    const chunk10 = await page.evaluate(() => window.__koseiBenchmark.setChunkSize(10));
    t("1パケット10ページにも戻せる", chunk10.chunk === 10, JSON.stringify(chunk10));

    const status = await page.evaluate(() => window.__koseiBenchmark.status());
    t("status がポーリングに必要な項目を返す",
      status.running === false && status.total_pages === 139 && status.reference_total_pages === 140 &&
      typeof status.card === "string" && typeof status.last_error === "string", JSON.stringify(status));

    const report = await page.evaluate(() => window.__koseiBenchmark.report());
    t("report が指摘.json と同じ形を返す",
      Array.isArray(report.findings) && typeof report.count === "number" && "file_name" in report,
      Object.keys(report).join(","));
    t("読み込み直後の指摘は0件（前のrunが混ざっていない）", report.count === 0);

    // 2本目の構成をこの同じページで走らせる。読み込み直すとサーバーが止まるので、
    // reset() → 再ロードで前の run が混ざらないことを確認する。
    const reset = await page.evaluate(() => window.__koseiBenchmark.reset());
    t("reset() が通る", reset === true);
    const target2 = await page.evaluate(p => window.__koseiBenchmark.loadTarget(p), `/${TARGET}`);
    const ref2 = await page.evaluate(p => window.__koseiBenchmark.loadReference(p), `/${REF}`);
    t("初期化のあと読み込み直せる（2本目の構成が走る）",
      target2.total_pages === 139 && ref2.reference_total_pages === 140);
    const status2 = await page.evaluate(() => window.__koseiBenchmark.status());
    t("比較資料が二重に積まれていない", status2.reference_total_pages === 140, JSON.stringify(status2));
    const report2 = await page.evaluate(() => window.__koseiBenchmark.report());
    t("前の run の指摘が残っていない", report2.count === 0 && report2.findings.length === 0);
    t("パケット状態も初期化される", (await page.evaluate(() => window.__koseiBenchmark.packets())).length === 0);

    t("ページ内で例外が出ていない", pageErrors.length === 0, pageErrors.join(" / "));
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}

if (failures) { console.error(`\nTest-BenchmarkHook: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-BenchmarkHook: PASS");
