// 通常運転は Edge を表示したまま背面に置き、入力フォーカスを奪わない。
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const start = source.indexOf("function Invoke-KoseiCopilotAttachFiles");
const end = source.indexOf("function ", start + 10);
const attach = source.slice(start, end > start ? end : undefined);
if (!source.includes("function Set-KoseiEdgeWindowNonActivating")) throw new Error("非アクティブ表示関数がない");
if (!source.includes("SW_SHOWNOACTIVATE") || !source.includes("SWP_NOACTIVATE")) throw new Error("SW_SHOWNOACTIVATE がない");
if (source.includes("Page.bringToFront")) throw new Error("自動 Page.bringToFront が残っている");
if (source.includes("Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'job-start'")) throw new Error("job開始で最小化している");
if (source.includes("--window-position=-32000,-32000") || source.includes("-WindowStyle Minimized")) throw new Error("Edgeを画面外/最小化起動している");
if (!source.includes("Start-Process -FilePath $edge -ArgumentList $args -WindowStyle Normal")) throw new Error("通常ウィンドウ起動がない");
if (!source.includes("newWindow = $true; background = $true")) throw new Error("ワーカー窓を背面作成していない");
if (!source.includes("Reason (\"worker-$w\")")) throw new Error("ワーカー窓の非アクティブ表示がない");
if (!attach.includes("$visibility -ne 'visible'") || !attach.includes("同じパケットを再試行してください")) throw new Error("hidden時の即時needs-user遷移がない");
if (attach.indexOf("$visibility -ne 'visible'") > attach.indexOf("Clear-KoseiResidualAttachments")) throw new Error("hidden確認が添付待機より後");
const showStart = source.indexOf("function Show-KoseiCopilotEdgeWindow");
const showEnd = source.indexOf("function ", showStart + 10);
const show = source.slice(showStart, showEnd > showStart ? showEnd : undefined);
if (!show.includes("copilot-user-visible.flag") || !show.includes("windowState='normal'")) throw new Error("手動Copilot表示導線が壊れている");
console.log("Test-BackgroundWindowPolicy: PASS");
