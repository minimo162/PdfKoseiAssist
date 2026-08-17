// Automatic review must not steal the user's foreground window.
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const attachStart = source.indexOf("function Invoke-KoseiCopilotAttachFiles");
const attachEnd = source.indexOf("function ", attachStart + 10);
const attach = source.slice(attachStart, attachEnd > attachStart ? attachEnd : undefined);
if (attach.includes("Page.bringToFront")) {
  throw new Error("attachment flow must not bring Edge to the foreground");
}
if (!source.includes("必要時はCopilot画面を表示して確認できます")) {
  throw new Error("background-window fallback guidance is missing");
}
console.log("Test-BackgroundWindowPolicy: PASS");
