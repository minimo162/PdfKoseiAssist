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

const checks = [
  ["終了はPOSTだけ", server.includes("if ($method -ne 'POST')") && server.includes("StatusCode 405")],
  ["終了要求はloopback限定", server.includes("Test-KoseiLocalShutdownRequest") && server.includes("IPAddress]::IsLoopback")],
  ["Originのport/hostを確認", server.includes("originUri.Port -eq $serverUri.Port") && server.includes("originUri.Host.Equals('localhost'")],
  ["実行中ジョブを409で保護", server.includes("StatusCode 409") && server.includes("active_job = $true")],
  ["復旧保持中ジョブを409で保護", server.includes("recoverable_job = $true")],
  ["UIは終了前に確認する", index.includes("window.confirm(prompt)")],
  ["UIは校正中に先にcancelする", index.includes("await cancelAutoReview()") && index.includes("waitForAutoReviewStop")],
  ["UIは停止後に明示状態へ切り替える", index.includes("showAppStoppedState") && index.includes("dataset.koseiStartup = \"stopped\"")],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`  ok   ${label}`);
  else { failed++; console.error(`  FAIL ${label}`); }
}
if (failed) { console.error(`\nTest-ShutdownEndpoint: FAIL (${failed})`); process.exit(1); }
console.log("\nTest-ShutdownEndpoint: PASS");
