import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = relative => fs.readFileSync(path.resolve(here, relative), "utf8");
const review = read("../src/ReviewJob.ps1");
const runtime = read("../src/RuntimeReviewFixes.ps1");
const copilot = read("../src/CopilotClient.ps1");
const html = read("../index.html");

assert.ok(!review.includes("Test-KoseiTerminalJobMode -State $State -and -not"), "terminal predicate must group the function call");
assert.ok(!review.includes("[IO.File]::Replace($resultTemp, $resultPath, $null, $true)"), "checkpoint replace needs a PS5.1-compatible backup");
assert.match(review, /checked_pages_all is only a model assertion/);
assert.match(review, /\$manifest\.ack \| Add-Member -NotePropertyName status/);
assert.match(review, /if \(& \$CanCommit\) \{[\s\S]*?\$terminalCommitted = \$true/);
assert.match(review, /\$mergedUniquePages\.Count\/\[double\]\$expectedUniquePages\.Count/);

const lookup = runtime.match(/function Get-KoseiJobStateRuntime \{[\s\S]*?\n\}/)?.[0] || "";
assert.ok(lookup && !lookup.includes("Complete-KoseiCancelledResultDiscardRuntime"), "state lookup must be side-effect free");

assert.match(copilot, /CDP WebSocket受信失敗/);
assert.match(copilot, /baselineAssistantText/);
assert.match(copilot, /-not \$markerFound -and \(Test-KoseiCopilotRefusalText/);
assert.match(copilot, /'"\(\?:findings\|read_error\)"\\s\*:'/);
assert.ok(!copilot.includes("for ($attempt = 1; $attempt -le 3; $attempt++)"), "ambiguous editor length must not reinsert a chunk");
assert.match(copilot, /削除\|共有\|delete\|remove\|share/);

assert.match(html, /function repairJsonOutsideStrings/);
assert.match(html, /raw\.matchAll\(\/\x60\x60\x60\(\?:json\)\?/);
assert.match(html, /activeImportAllowedPages instanceof Set && activeImportAllowedPages\.size/);
assert.match(html, /role: "unmapped".*nonActionable: true/);
assert.ok(!html.includes("role: \"fallback\", source: \"fallback\""), "unmappable pages must not be assigned to the first allowed page");
assert.match(html, /const visuallyOrderedItems = sourceItems\.slice\(\)\.sort/);
assert.match(html, /const autoImportedPasses = new Set\(\)/);
assert.match(html, /autoImportedPasses\.add\(passImportKey\)/);

console.log("Review logic hardening regression checks passed.");
