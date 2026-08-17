// hidden停止後の全packet再開とfull review継続点を静的に検証する。
import fs from "node:fs";

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
  "mergeAutoVisibilityJobState",
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
console.log("Test-AutoReviewVisibilityResume: PASS");
