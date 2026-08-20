// Test-ShutdownEndpoint.mjs — 終了エンドポイントの安全条件を検証する。
//
// PowerShell/HttpListenerをこの環境で起動しなくても、公開経路が誤って
// GET/外部Origin/実行中ジョブを受理しないことを静的に回帰検証する。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const server = readFileSync(join(here, "..", "src", "Server.ps1"), "utf8");
const indexPath = join(here, "..", "index.html");
let index = "";
try { index = readFileSync(indexPath, "utf8"); } catch {}

const serverChecks = [
  ["終了はPOSTだけ", server.includes("if ($method -ne 'POST')") && server.includes("StatusCode 405")],
  ["終了要求はloopback限定", server.includes("Test-KoseiLocalShutdownRequest") && server.includes("IPAddress]::IsLoopback")],
  ["Originは欠落/null/別originを拒否", server.includes("[string]::IsNullOrWhiteSpace($origin)") && server.includes("originUri.Scheme -ne $serverUri.Scheme") && server.includes("originUri.Host -ne $serverUri.Host") && server.includes("originUri.AbsolutePath -ne '/'")],
  ["実行中ジョブを409で保護", server.includes("StatusCode 409") && server.includes("active_job = $true")],
  ["復旧保持中ジョブを409で保護", server.includes("recoverable_job = $true")],
  ["中止済みジョブだけをscoped ACK", server.includes("Acknowledge-KoseiCancelledShutdownCheckpoint") && server.includes("discard_cancelled_only")],
  ["終了要求はjob/chain metadataを検証", server.includes("shutdown_intent_chain_id") && server.includes("shutdown_discard_approved")],
];

// index.html は配布用に生成する巨大な単一ファイルで、軽量なソース配布物では
// プレースホルダーになることがある。その場合もサーバー側の回帰検証は実行し、
// 実体がある checkout/CI では UI の静的検証も必ず実行する。
const uiChecks = index.length >= 1000 ? [
  ["UIは起動中の描画をゲートする", index.includes("kosei-startup-gate") && index.includes('data-kosei-startup="booting"')],
  ["UIは起動成功を明示する", index.includes("__koseiMarkStartupReady") && index.includes("15000")],
  ["UIは終了前に確認する", index.includes("window.confirm(prompt)")],
  ["UIは校正中に先にcancelする", index.includes("await cancelAutoReview()") && index.includes("waitForAutoReviewStop")],
  ["UIは中止済みcheckpointをscoped ACKする", index.includes("discard_cancelled_only") && index.includes("shutdown_intent_chain_id")],
  ["UIは停止後に明示状態へ切り替える", index.includes("showAppStoppedState") && index.includes("dataset.koseiStartup = \"stopped\"")],
] : [];
if (!uiChecks.length) console.log("  skip UI assertions: full index.html is not present in this checkout");
const checks = [...serverChecks, ...uiChecks];

let failed = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`  ok   ${label}`);
  else { failed++; console.error(`  FAIL ${label}`); }
}
if (failed) { console.error(`\nTest-ShutdownEndpoint: FAIL (${failed})`); process.exit(1); }
console.log("\nTest-ShutdownEndpoint: PASS");
