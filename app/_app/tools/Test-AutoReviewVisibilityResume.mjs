// Regression checks for visibility-paused jobs.  This is deliberately a
// ReviewJob contract test; the UI bundle can be deployed from another commit.

import fs from "node:fs";

const review = fs.readFileSync(new URL("../src/ReviewJob.ps1", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

const submitCalls = [...html.matchAll(/await submitAndPollAutoJob\(/g)];
if (submitCalls.length < 4) throw new Error("submitAndPollAutoJob の呼び出し経路が不足");
for (const match of submitCalls) {
  const tail = html.slice(match.index, match.index + 700);
  if (!tail.includes("needs_user_visibility") && !tail.includes("isNeedsUserVisibilityState")) {
    throw new Error("submit後のneeds_user_visibility停止ガードがない");
  }
}
for (const marker of [
  "function pendingAutoVisibilityPackets",
  "async function retryNeedsUserVisibility",
  "mergeAutoReviewJobState",
  "resumeAutoReviewAfterVisibility",
  "fullRunConsistencyRound",
]) {
  if (!html.includes(marker)) throw new Error("再開処理の" + marker + "がない");
}
if (!html.includes('["done", "warning"].includes(String(packet?.status || ""))')) {
  throw new Error("done/warning済みpacketを再試行から除外していない");
}
if (!html.includes("未完了") || !html.includes("まとめて再試行")) {
  throw new Error("未完了packet件数と一括再試行導線がない");
}
if (!html.includes('String(resumedState?.mode || "") !== "done"')
  || !html.includes("submitAndPollAutoJob(packets, originalState)")) {
  throw new Error("再開jobの未解決状態防止またはoriginal progress mergeがない");
}
if (!html.includes("const displayState = mergeBaseState ? mergeAutoReviewJobState(mergeBaseState, st) : st;")
  || !html.includes("return displayState;")) {
  throw new Error("部分jobを元stateへ統合して返していない");
}
if (!html.includes('resumedState?.mode === "cancelled"') || !html.includes("fullRunCancelRequested = true")) {
  throw new Error("cancelled再開jobが全体終了扱いになっていない");
}

const cancelAt = review.indexOf("if ([bool]$State.cancel_requested)");
const needsAt = review.indexOf("elseif ([bool]$State.needs_user_visibility");
if (cancelAt < 0 || needsAt < 0 || cancelAt > needsAt) {
  throw new Error("cancel_requested が needs_user_visibility より後で判定されている");
}
if (!review.includes("$State.mode = 'needs_user_visibility'")) {
  throw new Error("可視性待ちのジョブmodeがない");
}
if (!review.includes("$eligible = @('queued','running','needs_user_visibility')")) {
  throw new Error("再開対象statusの限定がない");
}
if (review.includes("$remainingPacket.status='paused'")) throw new Error("旧直接status更新が残っている");
if (!review.includes("Set-KoseiPacketTerminalStatus -State $State -Index $packetIndex -Status 'paused' -Error ''")) {
  throw new Error("未完了packetをpaused/retryableに戻していない");
}
if (!review.includes("$Shared.worker_stop[[string]$WorkerIndex] = $true")) {
  throw new Error("可視性失敗をworker単位に閉じ込めていない");
}
if (!review.includes("$Shared.stop_reasons[[string]$WorkerIndex] = $(if ([string]$p.status -eq 'paused')")) {
  throw new Error("可視性停止理由を保存していない");
}
if (!review.includes("stopReason -eq 'needs_user_visibility'") || !review.includes("@('queued','running') -contains [string]$packet.status")) {
  throw new Error("可視性停止時にworker残件を保持していない");
}
if (review.includes("$Shared.fatal") || review.includes("$shared.fatal")) {
  throw new Error("可視性失敗が全worker停止へ昇格している");
}
if (!review.includes("needs_user_visibility = [bool]$State.needs_user_visibility")) {
  throw new Error("status応答へ可視性状態を出していない");
}
if (!review.includes("function Set-KoseiPacketTerminalStatus") || !review.includes("$State.packets_done = [int]$State.packets_done + 1")) {
  throw new Error("terminal metadata/counter helperがない");
}
if (!review.includes("function Get-KoseiFailureKind") || review.includes("$detail -match 'needs_user_visibility:")) {
  throw new Error("typed failure consumerが文字列依存になっている");
}
if (client.includes("Page.bringToFront")) throw new Error("可視性待ちで自動前面化している");

console.log("Test-AutoReviewVisibilityResume: PASS");
