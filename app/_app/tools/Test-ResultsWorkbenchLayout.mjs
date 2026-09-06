// Test-ResultsWorkbenchLayout.mjs — PDFと指摘一覧を同時に見られる結果レイアウトを実ブラウザで固定する。

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  if (process.env.PDF_KOSEI_PLAYWRIGHT_DIR) {
    try {
      const module = await import(pathToFileURL(join(process.env.PDF_KOSEI_PLAYWRIGHT_DIR, "playwright", "index.mjs")).href);
      return module.chromium || module.default?.chromium || null;
    } catch {}
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const module = await import(pathToFileURL(join(root, "playwright", "index.js")).href);
    return module.chromium || module.default?.chromium || null;
  } catch { return null; }
}

const chromium = await loadChromium();
if (!chromium) {
  console.log("SKIP: playwright が見つかりません");
  process.exit(0);
}

async function launchBrowser() {
  try { return await chromium.launch(); }
  catch (firstError) {
    try { return await chromium.launch({ channel: "msedge" }); }
    catch { throw firstError; }
  }
}

const html = readFileSync(join(here, "..", "index.html"), "utf8");
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Layout fixture: module boot belongs to the full-app browser tests. Do not
  // run a startup watchdog against an about:blank page without module imports.
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""), { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    document.getElementById("resultsEmptyState").hidden = true;
    document.getElementById("resultsWorkbench").hidden = false;
    document.getElementById("viewerShell").innerHTML = '<div style="height:1400px;background:#fff">PDF page</div>';
  });

  const setFindingCount = async (count) => page.evaluate((nextCount) => {
    document.getElementById("findingsList").innerHTML = Array.from({ length: nextCount }, (_, index) => `
      <article class="finding-card" role="button" tabindex="0">
        <div class="finding-title">#${index + 1} P.${index + 1} grammar</div>
        <div class="reason">確認する指摘です。</div>
      </article>`).join("");
  }, count);
  const measure = async () => page.evaluate(() => {
    const workbench = document.getElementById("resultsWorkbench");
    const viewer = document.getElementById("viewerShell");
    const list = document.getElementById("findingsList");
    const firstCard = list.firstElementChild;
    return {
      workbenchHeight: workbench.getBoundingClientRect().height,
      viewerClientHeight: viewer.clientHeight,
      viewerScrollHeight: viewer.scrollHeight,
      viewerOverflowY: getComputedStyle(viewer).overflowY,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      listOverflowY: getComputedStyle(list).overflowY,
      firstCardHeight: firstCard?.getBoundingClientRect().height || 0,
    };
  });

  await setFindingCount(1);
  const single = await measure();
  if (single.workbenchHeight < 620 || single.workbenchHeight > 900) {
    throw new Error(`結果領域がviewport内の想定高ではありません: ${JSON.stringify(single)}`);
  }
  if (single.viewerClientHeight < 500 || single.listClientHeight < 500) {
    throw new Error(`PDFと指摘一覧の閲覧高を同時に確保できません: ${JSON.stringify(single)}`);
  }
  if (single.viewerScrollHeight <= single.viewerClientHeight || single.viewerOverflowY !== "auto") {
    throw new Error(`PDF側を独立スクロールできません: ${JSON.stringify(single)}`);
  }
  await page.locator("#viewerShell").focus();
  if (await page.evaluate(() => document.activeElement?.id) !== "viewerShell") {
    throw new Error("PDFスクロール領域へキーボードフォーカスできません");
  }
  for (let index = 0; index < 6; index += 1) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const viewerScrollTop = await page.locator("#viewerShell").evaluate((element) => element.scrollTop);
  if (viewerScrollTop <= 0) throw new Error("矢印キーでPDF表示をスクロールできません");
  if (single.firstCardHeight <= 0 || single.firstCardHeight >= single.listClientHeight / 2) {
    throw new Error(`指摘1件のカードが一覧高へ引き伸ばされています: ${JSON.stringify(single)}`);
  }
  if (single.listScrollHeight > single.listClientHeight + 1 || single.listOverflowY !== "auto") {
    throw new Error(`指摘1件でも不要な縦スクロールが発生しています: ${JSON.stringify(single)}`);
  }

  await setFindingCount(24);
  const many = await measure();
  if (many.listScrollHeight <= many.listClientHeight || many.listOverflowY !== "auto") {
    throw new Error(`指摘が多い場合に一覧だけを縦スクロールできません: ${JSON.stringify(many)}`);
  }
  if (many.viewerClientHeight !== single.viewerClientHeight || many.listClientHeight !== single.listClientHeight) {
    throw new Error(`指摘件数によって左右の閲覧高が変わりました: single=${JSON.stringify(single)} many=${JSON.stringify(many)}`);
  }

  // A completed 12-request run must not put its diagnostic rows ahead of the
  // workbench. Exercise native disclosures and warning visibility at each width.
  await page.evaluate(() => {
    document.getElementById("reviewOverview").hidden = false;
    document.getElementById("reviewOverviewSubtitle").textContent = "確認範囲不足があります。再試行してください。";
    document.getElementById("reviewOverviewActions").innerHTML = '<button class="btn">未完了を再試行</button>';
    document.getElementById("reviewPacketList").innerHTML = Array.from({ length: 12 }, () => '<div class="review-packet-row">ページ確認完了</div>').join("");
    document.getElementById("reviewFindingDetails").hidden = false;
    document.getElementById("reviewDetailPanel").hidden = false;
    const card = document.getElementById("autoReviewCard");
    card.hidden = false;
    card.innerHTML = '<strong>完了 12/12</strong><details><summary>依頼別の詳細</summary>詳細</details>';
    card.dataset.idle = "true";
  });
  for (const width of [1440, 845, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const processing = page.locator("#reviewProcessingDetails");
    if (await processing.evaluate(node => node.open)) throw new Error("処理詳細が初期表示で展開されています");
    if (!await page.getByRole("button", { name: "未完了を再試行" }).isVisible()) throw new Error("再試行操作が折りたたみに隠れています");
    if (!await page.locator("#reviewOverviewSubtitle").isVisible()) throw new Error("警告が隠れています");
    const closedHeight = await page.locator("#reviewOverview").evaluate(node => node.getBoundingClientRect().height);
    const logHeight = await page.locator("#autoReviewCard").evaluate(node => node.getBoundingClientRect().height);
    if (logHeight > 150) throw new Error(`完了ログの空白が残っています: ${width}/${logHeight}`);
    await processing.locator("summary").first().focus();
    await page.keyboard.press("Enter");
    if (!await processing.evaluate(node => node.open) || !await page.locator("#reviewPacketList").isVisible()) throw new Error("処理詳細をキーボードで開けません");
    const openHeight = await page.locator("#reviewOverview").evaluate(node => node.getBoundingClientRect().height);
    if (openHeight - closedHeight < 300) throw new Error("処理詳細の折りたたみで一覧への距離が短縮されません");
    await processing.locator("summary").first().click();
    const detail = page.locator("#reviewFindingDetails");
    const followsWorkbench = await detail.evaluate(node => Boolean(document.getElementById("resultsWorkbench").compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (!followsWorkbench) throw new Error("指摘詳細が一覧の前にあります");
    await detail.locator("summary").first().click();
    if (!await page.locator("#reviewDetailPanel").isVisible()) throw new Error("指摘詳細を開けません");
    await detail.locator("summary").first().click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (overflow) throw new Error(`横はみ出し: ${width}`);
    console.log(`UI focus ${width}: overview ${openHeight} -> ${closedHeight}, idle log ${logHeight}`);
  }
  console.log(`Test-ResultsWorkbenchLayout: PASS single=${JSON.stringify(single)} many=${JSON.stringify(many)}`);
} finally {
  await browser.close();
}
