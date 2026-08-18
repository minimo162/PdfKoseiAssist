// Background window policy and per-worker failure regression checks.
// The UI is intentionally not inspected here: this checkout's UI may be
// deployed independently, while the CDP/worker contract is enforced here.

import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const review = fs.readFileSync(new URL("../src/ReviewJob.ps1", import.meta.url), "utf8");

if (source.includes("Page.bringToFront")) throw new Error("自動 Page.bringToFront が残っている");
if (source.includes("SW_SHOWNOACTIVATE") || source.includes("SWP_NOACTIVATE")) throw new Error("Win32前面制御が残っている");
if (source.includes("KoseiNativeWindow") || source.includes("Get-KoseiEdgeWindowHandles") || source.includes("Set-KoseiEdgeWindowNonActivating")) throw new Error("HWND推測/後追い前面制御が残っている");
if (source.includes("Set-KoseiEdgeWindowMinimized -Settings $Settings -Page $page -Reason 'job-start'")) throw new Error("job開始で最小化している");
if (!source.includes("newWindow = $true; background = $true")) throw new Error("ワーカー窓をCDP背面作成していない");
const visibilityStart = source.indexOf("$visibility = [string](Invoke-KoseiCdpEval");
const visibilityEnd = source.indexOf("$null = Clear-KoseiResidualAttachments", visibilityStart);
const visibilityCheck = source.slice(visibilityStart, visibilityEnd > visibilityStart ? visibilityEnd : undefined);
if (!visibilityCheck.includes("document.visibilityState") || !visibilityCheck.includes("Write-KoseiLog") || !visibilityCheck.includes("'WARN'")) {
  throw new Error("hidden時の警告ログがない");
}
if (visibilityCheck.includes("throw")) throw new Error("visibilityStateの事前拒否が残っている");
if (!source.includes("function New-KoseiFailureException") || !source.includes("Data['KoseiFailureKind']")) {
  throw new Error("typed failure helperがない");
}
const attachStart = source.indexOf("function Invoke-KoseiCopilotAttachFiles {");
const attachEnd = source.indexOf("\nfunction ", attachStart + 10);
const attach = source.slice(attachStart, attachEnd > attachStart ? attachEnd : undefined);
if (!attach.includes("$noAttachProgress") || !attach.includes("New-KoseiFailureException") || !attach.includes("'needs_user_visibility'")) {
  throw new Error("hidden stall timeoutのtyped failure producerがない");
}
if (!attach.includes("$uploadBaselineMs") || !attach.includes("performance.now()") || !attach.includes("startTime) >= baseline - 50")) {
  throw new Error("今回attemptのresource baseline計測がない");
}
if (!attach.includes("initiatorType") || !attach.includes("UPLOAD_TOKENS")) {
  throw new Error("静的resourceを除外するupload進捗フィルタがない");
}
if (!attach.includes("$initialVisibility -eq 'hidden' -or $timeoutVisibility -eq 'hidden'")) {
  throw new Error("開始/timeout visibility判定がない");
}
if (!source.includes("function ConvertTo-KoseiJsonStringArray") || !attach.includes("$uploadTokensJson = ConvertTo-KoseiJsonStringArray -Values $uploadTokens") || attach.includes("ConvertTo-Json -InputObject (,$uploadTokens)")) {
  throw new Error("upload token JSONがflat array契約になっていない");
}
if (!attach.includes("$timeoutProbeSucceeded = $false") || !attach.includes("$timeoutProbeSucceeded = $true") || !attach.includes("$uploadBaselineAvailable -and $timeoutProbeSucceeded -and")) {
  throw new Error("timeout probe成功ゲートがない");
}

if (!review.includes("$State.needs_user_visibility = $true") || !review.includes("$State.mode = 'needs_user_visibility'")) {
  throw new Error("ReviewJob上位へneeds_user_visibilityを伝播していない");
}
if (!review.includes("-Status 'paused'")) throw new Error("後続packetを一時停止していない");
if (!review.includes("worker_stop = [hashtable]::Synchronized")) throw new Error("worker単位の停止状態がない");
if (!review.includes("$Shared.worker_stop[[string]$WorkerIndex] = $true")) throw new Error("失敗workerを局所停止していない");
if (!review.includes("stop_reasons = [hashtable]::Synchronized") || !review.includes("$Shared.stop_reasons[[string]$WorkerIndex]")) throw new Error("worker停止理由がない");
if (!review.includes("function Set-KoseiPacketTerminalStatus") || !review.includes("Set-KoseiPacketTerminalStatus -State $State -Index")) throw new Error("terminal metadata helperがない");
if (!review.includes("stopReason -eq 'needs_user_visibility'") || !review.includes("@('queued','running') -contains [string]$packet.status")) throw new Error("visibility停止の残queued保持がない");
if (review.includes("$Shared.fatal") || review.includes("$shared.fatal")) throw new Error("worker失敗がジョブ全体のfatalへ昇格している");
if (review.includes("ワーカー用ウィンドウを用意できないため逐次で実行します")) throw new Error("並列窓失敗を暗黙に逐列化している");
if (!review.includes("$State.packets_done = [int]$State.packets_done + 1")) throw new Error("terminal counter更新がない");
const waitStart = review.indexOf("function Wait-KoseiWorkerHandles {");
const waitEnd = review.indexOf("\nfunction Stop-KoseiJob", waitStart + 10);
const wait = review.slice(waitStart, waitEnd > waitStart ? waitEnd : undefined);
const gate = wait.indexOf("if ($h.Async.IsCompleted)");
const stopRead = wait.indexOf("$Shared.stop_reasons");
if (gate < 0 || (stopRead >= 0 && stopRead < gate)) throw new Error("stopReasonをAsync完了前に先読みしている");
if (!/EndInvoke[\s\S]{0,260}\$Shared\.stop_reasons/.test(wait)) throw new Error("EndInvoke後のstopReason再読がない");

const showStart = source.indexOf("function Show-KoseiCopilotEdgeWindow");
const showEnd = source.indexOf("function ", showStart + 10);
const show = source.slice(showStart, showEnd > showStart ? showEnd : undefined);
if (!show.includes("copilot-user-visible.flag") || !show.includes("windowState='normal'")) {
  throw new Error("手動Copilot表示導線が壊れている");
}

console.log("Test-BackgroundWindowPolicy: PASS");
