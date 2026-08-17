// 自動校正ログ領域は行数に関係なく同じ高さで、キーボードから読める。
import fs from "node:fs";

const here = new URL("..", import.meta.url);
const html = fs.readFileSync(new URL("index.html", here), "utf8");
const css = html.match(/#autoReviewCard\s*\{([^}]*)\}/)?.[1] || "";
if (!/height\s*:\s*clamp\(/.test(css)) throw new Error("autoReviewCard が固定 height ではない");
if (/min-height|max-height/.test(css)) throw new Error("autoReviewCard が内容依存の min/max height を使っている");
if (!/overflow-y\s*:\s*auto/.test(css)) throw new Error("autoReviewCard の内部スクロールがない");
const card = html.match(/<div\s+id="autoReviewCard"[^>]*>/)?.[0] || "";
for (const marker of ['tabindex="0"', 'role="region"', 'aria-label="自動校正ログ"']) {
  if (!card.includes(marker)) throw new Error(`autoReviewCard の${marker}がない`);
}
if (html.includes("観点ごとの走査が記録されていません。")) throw new Error("内部実装語の二重警告が残っている");
if (!html.includes("観点ごとの確認が記録されていません。アプリを更新してから、もう一度実行してください。")) throw new Error("利用者向け観点警告がない");
if (!html.includes("needs_user_visibility") || !html.includes("autoVisibilityRetryLink") || !html.includes("showCopilotAndRetryAutoPacket")) throw new Error("hidden時の表示/同一packet再試行導線がない");
console.log("Test-AutoReviewCardUi: PASS");
