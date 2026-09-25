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

import { checkReportBrowser } from "./report-browser-check.mjs";
import { existsSync, readFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const TARGET = "docs/benchmarks/fixtures/aoi-long_en_TARGET.pdf";
const REF = "docs/benchmarks/fixtures/aoi-long_ja_REF.pdf";
// ページ数は gold から読む。ここに数字を直書きすると、フィクスチャを増補したときに
// 「実機で40分走らせる直前の配線確認」が古い数字で落ちる。
const PORT = 8791;
const gold = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..",
  "docs", "benchmarks", "fixtures", "gold-long.json"), "utf8"));
const T_PAGES = gold.target_pages, R_PAGES = gold.ref_pages;

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

    // 開始に失敗したとき、理由が status() に出るか。
    // 実測: proofread10 が「開始を確認できませんでした」だけで止まった。startAutoReview は
    // 失敗を自前の catch で処理するので呼び出し側の Promise は正常終了し、silent な早期
    // return（PDF未読込・ページ範囲不正）に至っては例外にすらならない。理由が拾えないと
    // 40分の実測が「画面を見てください」で終わる。
    {
      await page.evaluate(() => window.__koseiBenchmark.startProofread());
      const s = await page.evaluate(() => window.__koseiBenchmark.status());
      t("PDF未読込で開始したら理由が last_error に出る", Boolean(s.last_error), JSON.stringify(s.last_error));
      t("開始できなかったので running は false のまま", s.running === false);
      await page.evaluate(() => window.__koseiBenchmark.reset());
      t("reset() で開始失敗の理由が消える（前のrunの理由を引きずらない）",
        (await page.evaluate(() => window.__koseiBenchmark.status())).last_error === "");
    }

    // Run-Benchmark.ps1 が呼ぶのと同じ順序・同じ引数で叩く
    const target = await page.evaluate(p => window.__koseiBenchmark.loadTarget(p), `/${TARGET}`);
    t(`校正対象PDFをURLから読み込める（${T_PAGES}ページ）`, target.total_pages === T_PAGES, JSON.stringify(target));

    const ref = await page.evaluate(p => window.__koseiBenchmark.loadReference(p), `/${REF}`);
    t(`比較資料PDFをURLから読み込める（${R_PAGES}ページ）`, ref.reference_total_pages === R_PAGES, JSON.stringify(ref));

    // sourceContext の実ページ根拠は製品と同じ extractTextLayerText() から
    // 読む必要がある。静的な入口名チェックだけでなく、比較資料を読み込んだ
    // 実ブラウザで read-only hook が非空本文を返すことを確認する。
    const referencePageText = await page.evaluate(() => window.__koseiBenchmark.referencePageText(0, 1));
    t("referencePageText() が比較資料の実抽出本文を返す",
      typeof referencePageText === "string" && referencePageText.trim().length > 0,
      String(referencePageText || "").slice(0, 160));

    // 「全範囲を自動校正」は現在のページ範囲を分割するので、全ページ選択が効いていないと
    // 先頭10ページだけを測ってしまう。ここが静かに壊れると結果が丸ごと嘘になる。
    const all = await page.evaluate(() => window.__koseiBenchmark.selectAllPages());
    const allStatus = await page.evaluate(() => window.__koseiBenchmark.status());
    t(`全${T_PAGES}ページが校正対象になる`, all.target_pages === T_PAGES, JSON.stringify(all));
    t("全範囲選択直後に候補範囲エラーが出ない", allStatus.last_error === "", JSON.stringify(allStatus));

    // 10ページ上限を外した効果の確認。25 が通らないと Q2 が測れない。
    const chunk25 = await page.evaluate(() => window.__koseiBenchmark.setChunkSize(25));
    t("1パケット25ページを設定できる（上限10のままなら10に丸められる）", chunk25.chunk === 25, JSON.stringify(chunk25));
    const chunk10 = await page.evaluate(() => window.__koseiBenchmark.setChunkSize(10));
    t("1パケット10ページにも戻せる", chunk10.chunk === 10, JSON.stringify(chunk10));

    const status = await page.evaluate(() => window.__koseiBenchmark.status());
    t("status がポーリングに必要な項目を返す",
      status.running === false && status.total_pages === T_PAGES && status.reference_total_pages === R_PAGES &&
      typeof status.card === "string" && typeof status.last_error === "string", JSON.stringify(status));
    // パケット作成中はカードが動かない。細かい進捗が別に取れないと無音と区別できない。
    t("status が detail（細かい進捗）も返す", typeof status.detail === "string", JSON.stringify(status.detail));

    const report = await page.evaluate(() => window.__koseiBenchmark.report());
    t("report が指摘.json と同じ形を返す",
      Array.isArray(report.findings) && typeof report.count === "number" && "file_name" in report,
      Object.keys(report).join(","));
    t("読み込み直後の指摘は0件（前のrunが混ざっていない）", report.count === 0);

    await page.waitForFunction(() => /^\d+\.\d+/.test(window.__koseiAutomation.version));
    t("互換エイリアスは同じオブジェクト", await page.evaluate(() => window.__koseiAutomation === window.__koseiBenchmark));
    const beforeDetection = await page.evaluate(() => window.__koseiAutomation.report().file_name);
    const language = await page.evaluate(p => window.__koseiAutomation.detectLanguage(p), `/${REF}`);
    t("別PDFの先頭5ページから日本語判定", language.language === "日本語" && language.pages === Math.min(5, R_PAGES) && language.sample_chars > 0, JSON.stringify(language));
    t("言語判定が読み込み済みの対象を変えない", await page.evaluate(() => window.__koseiAutomation.report().file_name) === beforeDetection);
    const autoRange = await page.evaluate(() => window.__koseiAutomation.autoReferenceRange());
    t("比較資料の範囲を自動入力できる", Boolean(autoRange.reference_range));
    let uploaded = null;
    await page.route('**/api/drop/*/report', async route => {
      uploaded = route.request().postDataBuffer();
      await route.fulfill({status:200, contentType:'application/json', body:'{"ok":true}'});
    });
    const exported = await page.evaluate(() => window.__koseiAutomation.exportReportZip('/api/drop/0123456789abcdef0123456789abcdef/report'));
    t("指摘0件でも実ZIPを生成してアップロード", exported.ok && exported.findings === 0 && uploaded?.readUInt32LE(0) === 0x04034b50 && uploaded.length === exported.bytes, JSON.stringify(exported));

    await checkReportBrowser(browser, uploaded);

    // 実際に開始できるか。Run-Benchmark.ps1 は status().running が true になることで
    // 開始を確認するので、ここが false のままだと「開始を確認できませんでした」で落ちる。
    // 実測で proofread10 がこれを踏んだ。全ページだと重いので範囲を10ページに絞る。
    {
      await page.evaluate(() => { document.getElementById("pageRangeInput").value = "1-10"; });
      const narrowed = await page.evaluate(() => window.__koseiBenchmark.setChunkSize(10));
      t("10ページに絞れる", narrowed.chunk === 10, JSON.stringify(narrowed));

      await page.evaluate(() => window.__koseiBenchmark.startProofread());
      const running = await page.waitForFunction(
        () => window.__koseiBenchmark.status().running === true, null, { timeout: 10000 }
      ).then(() => true).catch(() => false);
      t("startProofread() で実行中になる（Run-Benchmark はこれで開始を確認する）", running,
        JSON.stringify(await page.evaluate(() => window.__koseiBenchmark.status())));

      // ここにはサーバーが無いのでジョブ投入は必ず失敗する。その理由が拾えるところまで見る。
      const surfaced = await page.waitForFunction(
        () => { const s = window.__koseiBenchmark.status(); return s.running === false && Boolean(s.last_error); },
        null, { timeout: 240000 }
      ).then(() => true).catch(() => false);
      t("投入に失敗したら理由が last_error に出る（無言で終わらない）", surfaced,
        JSON.stringify(await page.evaluate(() => window.__koseiBenchmark.status())));
    }

    // 2本目の構成をこの同じページで走らせる。読み込み直すとサーバーが止まるので、
    // reset() → 再ロードで前の run が混ざらないことを確認する。
    const reset = await page.evaluate(() => window.__koseiBenchmark.reset());
    t("reset() が通る", reset === true);
    const target2 = await page.evaluate(p => window.__koseiBenchmark.loadTarget(p), `/${TARGET}`);
    const ref2 = await page.evaluate(p => window.__koseiBenchmark.loadReference(p), `/${REF}`);
    t("初期化のあと読み込み直せる（2本目の構成が走る）",
      target2.total_pages === T_PAGES && ref2.reference_total_pages === R_PAGES);
    const status2 = await page.evaluate(() => window.__koseiBenchmark.status());
    t("比較資料が二重に積まれていない", status2.reference_total_pages === R_PAGES, JSON.stringify(status2));
    const report2 = await page.evaluate(() => window.__koseiBenchmark.report());
    t("前の run の指摘が残っていない", report2.count === 0 && report2.findings.length === 0);
    t("パケット状態も初期化される", (await page.evaluate(() => window.__koseiBenchmark.packets())).length === 0);

    // proofread10 と同じ順序（全ページ選択 → 10ページ刻み → 開始）で開始できるか。
    // 上の10ページ版と違い、ここは全パケット分の範囲を持ったまま開始する。
    // パケット作成は重いので、開始が確認できた時点で打ち切る（この後ブラウザを閉じる）。
    {
      await page.evaluate(() => window.__koseiBenchmark.selectAllPages());
      await page.evaluate(() => window.__koseiBenchmark.setChunkSize(10));
      await page.evaluate(() => window.__koseiBenchmark.startProofread());
      const running = await page.waitForFunction(
        () => { const s = window.__koseiBenchmark.status(); return s.running === true || Boolean(s.last_error); },
        null, { timeout: 10000 }
      ).then(() => true).catch(() => false);
      const s = await page.evaluate(() => window.__koseiBenchmark.status());
      t(`全${T_PAGES}ページ・10ページ刻みでも開始できる（proofread10 と同じ順序）`,
        running && s.running === true && !s.last_error, JSON.stringify(s));
    }

    t("ページ内で例外が出ていない", pageErrors.length === 0, pageErrors.join(" / "));
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}

if (failures) { console.error(`\nTest-BenchmarkHook: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-BenchmarkHook: PASS");
