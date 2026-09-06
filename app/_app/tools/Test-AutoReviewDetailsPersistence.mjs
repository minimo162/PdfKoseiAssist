// Test-AutoReviewDetailsPersistence.mjs — ログ詳細の開閉状態を再描画で保持する。
//
// 進捗カードはサーバーのポーリングごとにHTMLを更新するため、<details> を
// 作り直しても利用者が開いた状態／閉じた状態を勝手に変更してはいけない。
// 本番 index.html の setAutoCard を取り出し、実ブラウザのDOM操作で確認する。

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const m = await import(join(root, "playwright", "index.js"));
    return m.chromium || m.default?.chromium || null;
  } catch { return null; }
}
const chromium = await loadChromium();
if (!chromium) {
  console.log("SKIP: playwright が見つかりません");
  process.exit(0);
}

const html = readFileSync(join(here, "..", "index.html"), "utf8");
const match = html.match(/function setAutoCard\(html, show = true\) \{[\s\S]*?\n    \}/);
if (!match) throw new Error("本番 setAutoCard が見つかりません");
const setAutoCardSource = match[0];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<div id="autoReviewCard"></div>');
  await page.evaluate((source) => {
    const card = document.getElementById("autoReviewCard");
    const setAutoCard = new Function("els", source + "; return setAutoCard;")({ autoReviewCard: card });
    window.renderDetails = (message) => setAutoCard(
      '<details class="auto-review-details"><summary>ログの詳細</summary><div class="auto-review-details-body">'
        + String(message) + "</div></details>"
    );
    window.resetCardForNewJob = () => setAutoCard("新しいジョブを準備しています…");
  }, setAutoCardSource);

  await page.evaluate(() => window.renderDetails("最初の進捗"));
  await page.click("#autoReviewCard summary");
  if (!await page.locator("#autoReviewCard details").evaluate((node) => node.open)) {
    throw new Error("利用者の開操作を確認できません");
  }

  for (const message of ["2回目の進捗", "3回目の進捗", "4回目の進捗"]) {
    await page.evaluate((value) => window.renderDetails(value), message);
    const open = await page.locator("#autoReviewCard details").evaluate((node) => node.open);
    if (!open) throw new Error(`再描画後もログ詳細を開いたままにできません: ${message}`);
  }

  await page.click("#autoReviewCard summary");
  if (await page.locator("#autoReviewCard details").evaluate((node) => node.open)) {
    throw new Error("利用者の閉操作を確認できません");
  }
  await page.evaluate(() => window.renderDetails("閉じた後の進捗"));
  if (await page.locator("#autoReviewCard details").evaluate((node) => node.open)) {
    throw new Error("利用者が閉じたログ詳細を再描画で開き直しました");
  }

  // 新しいジョブの開始案内は details を破棄するため、前ジョブの開閉状態を持ち越さない。
  await page.evaluate(() => {
    document.getElementById("autoReviewCard").dataset.idle = "true";
    window.resetCardForNewJob();
  });
  if (await page.locator("#autoReviewCard").getAttribute("data-idle") !== null) {
    throw new Error("新しい実行に完了時のコンパクト表示が残っています");
  }
  await page.evaluate(() => window.renderDetails("新しいジョブの進捗"));
  if (await page.locator("#autoReviewCard details").evaluate((node) => node.open)) {
    throw new Error("新しいジョブに前ジョブの開閉状態を持ち越しました");
  }

  console.log("Test-AutoReviewDetailsPersistence: PASS");
} finally {
  await browser.close();
}
