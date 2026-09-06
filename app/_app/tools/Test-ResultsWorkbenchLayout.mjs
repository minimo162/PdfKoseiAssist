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
  // Render the production card template and bind its actual event handlers.
  const cardsStart = html.indexOf("      const openFindingDetails =");
  const cardsEnd = html.indexOf("      const active = shownFindings.find", cardsStart);
  const reasonSource = html.slice(html.indexOf("    function findingReasonMarkup"), html.indexOf("    function findingEvidenceMarkup"));
  const controlsSource = html.slice(html.indexOf("    function hasTextSelectionWithin"), html.indexOf("    function selectFinding"));
  if (cardsStart < 0 || cardsEnd < cardsStart) throw new Error("本番カード描画を抽出できません");
  await page.evaluate(({ cards, reason, controls }) => {
    const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
    const fixture = [
      { id:"reason-1", page:12, category:"grammar", severity:"medium", reason:'"raised funds" と "to make" の並列が一致しません。\n' + "長い理由。".repeat(180) + '<img src=x onerror="alert(1)">', quote:"raised funds and to make", suggestion:"raised funds and made" },
      { id:"reason-2", page:7, category:"typo", severity:"low", reason:"", quote:"LIABILIRIES" },
    ];
    window.cardActivations = 0;
    const dependencies = {
      els:{ findingsList:document.getElementById("findingsList") }, shownFindings:fixture, activeFindingId:"reason-1", escapeHtml,
      findingPrimaryLabel:()=>"要点", findingPrimaryText:()=>"動詞の並列", findingSuggestionLine:f=>f.suggestion || "",
      findingDecision:f=>f.decision || "undecided", decisionLabel:s=>s, findingEvidenceMarkup:()=>"", humanReviewLabel:()=>"",
      excludedReasonLabel:s=>s, referencePagesLabel:()=>"", selectFinding:()=>{ window.cardActivations++; },
      setFindingDecision:(id,state)=>{ fixture.find(f=>f.id===id).decision=state; render(); },
    };
    const render = new Function(...Object.keys(dependencies), reason + controls + cards).bind(null, ...Object.values(dependencies));
    render();
    window.expectedReason = fixture[0].reason;
  }, { cards:html.slice(cardsStart,cardsEnd), reason:reasonSource, controls:controlsSource });
  const first = page.locator('[data-finding-id="reason-1"]');
  if (await first.locator(".finding-reason p").textContent() !== await page.evaluate(() => window.expectedReason)) throw new Error("理由が省略・改変されています");
  if (await first.locator("img").count()) throw new Error("理由のHTMLが実行可能な要素になっています");
  if (!await page.getByText("理由が回答に含まれていません。", { exact:true }).isVisible()) throw new Error("理由未提供を明示していません");
  if (await first.locator('[data-decision="accepted"]').isVisible()) throw new Error("任意の採否操作が常時表示されています");
  await first.locator("summary").click();
  await first.locator('[data-decision="accepted"]').press("Enter");
  if (!await first.locator("details").evaluate(node=>node.open)) throw new Error("採否の再描画で補足欄が閉じました");
  if (await first.locator('[data-decision="accepted"]').getAttribute("aria-pressed") !== "true") throw new Error("採用操作が反映されません");
  await first.locator("summary").focus();
  await page.keyboard.press("Enter");
  if (await first.locator("details").evaluate(node=>node.open)) throw new Error("補足欄をキーボードで閉じられません");
  if (await page.evaluate(() => window.cardActivations) !== 0) throw new Error("補足操作がカード選択を誤発火しました");
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth+1)) throw new Error("長い理由が狭幅ではみ出します");
  console.log(`Test-ResultsWorkbenchLayout: PASS single=${JSON.stringify(single)} many=${JSON.stringify(many)}`);
} finally {
  await browser.close();
}
