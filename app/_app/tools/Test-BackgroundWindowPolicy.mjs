// 校正途中の前面奪取を防ぎ、hidden時はジョブ上位の利用者操作待ちへ伝播する。
import fs from "node:fs";

const here = new URL("..", import.meta.url);
const source = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const review = fs.readFileSync(new URL("../src/ReviewJob.ps1", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
if (source.includes("Page.bringToFront")) throw new Error("自動 Page.bringToFront が残っている");
if (source.includes("SW_SHOWNOACTIVATE") || source.includes("SWP_NOACTIVATE")) throw new Error("Win32前面制御が残っている");
if (source.includes("KoseiNativeWindow") || source.includes("Get-KoseiEdgeWindowHandles") || source.includes("Set-KoseiEdgeWindowNonActivating")) throw new Error("HWND推測/後追い前面制御が残っている");
if (source.includes("Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'job-start'")) throw new Error("job開始で最小化している");
if (!source.includes("newWindow = $true; background = $true")) throw new Error("ワーカー窓をCDP背面作成していない");
if (!source.includes("needs_user_visibility:")) throw new Error("hidden時の構造通知がない");
if (!review.includes("$State.needs_user_visibility = $true") || !review.includes("$State.mode = 'needs_user_visibility'")) throw new Error("ReviewJob上位へneeds_user_visibilityを伝播していない");
if (!review.includes("status='paused'")) throw new Error("後続packetを一時停止していない");
if (!index.includes("needs_user_visibility") || !index.includes("autoVisibilityRetryLink") || !index.includes("showCopilotAndRetryAutoPacket")) throw new Error("UIのCopilot表示/同一packet再試行導線がない");
const showStart = source.indexOf("function Show-KoseiCopilotEdgeWindow");
const showEnd = source.indexOf("function ", showStart + 10);
const show = source.slice(showStart, showEnd > showStart ? showEnd : undefined);
if (!show.includes("copilot-user-visible.flag") || !show.includes("windowState='normal'")) throw new Error("手動Copilot表示導線が壊れている");
console.log("Test-BackgroundWindowPolicy: PASS");
