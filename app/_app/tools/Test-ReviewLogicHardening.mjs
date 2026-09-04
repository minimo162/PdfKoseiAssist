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
assert.match(review, /\$lastLeaseTouch = \(Get-Date\)\.AddMinutes\(-1\)/);
assert.match(review, /-not \$protectedRetainedJobIds\.ContainsKey\(\$uploadId\)/);

const lookup = runtime.match(/function Get-KoseiJobStateRuntime \{[\s\S]*?\n\}/)?.[0] || "";
assert.ok(lookup && !lookup.includes("Complete-KoseiCancelledResultDiscardRuntime"), "state lookup must be side-effect free");
assert.match(runtime, /最新応答snapshotのJSON解析に失敗しました/);

assert.match(copilot, /CDP WebSocket受信失敗/);
assert.match(copilot, /baselineAssistantText/);
assert.match(copilot, /-not \$markerFound -and \(Test-KoseiCopilotRefusalText/);
assert.match(copilot, /'"\(\?:findings\|read_error\)"\\s\*:'/);
assert.ok(!copilot.includes("for ($attempt = 1; $attempt -le 3; $attempt++)"), "ambiguous editor length must not reinsert a chunk");
assert.match(copilot, /削除\|共有\|delete\|remove\|share/);
assert.match(copilot, /同名の添付ファイルは識別できません/);
assert.match(copilot, /Remove-Item -LiteralPath \$visibleFlag/);

assert.match(html, /function repairJsonOutsideStrings/);
assert.match(html, /raw\.matchAll\(\/\x60\x60\x60\(\?:json\)\?/);
assert.match(html, /activeImportAllowedPages instanceof Set && activeImportAllowedPages\.size/);
assert.match(html, /role: "unmapped".*nonActionable: true/);
assert.ok(!html.includes("role: \"fallback\", source: \"fallback\""), "unmappable pages must not be assigned to the first allowed page");
assert.match(html, /const visuallyOrderedItems = sourceItems\.slice\(\)\.sort/);
assert.match(html, /const autoImportedPasses = new Set\(\)/);
assert.match(html, /autoImportedPasses\.add\(passImportKey\)/);
assert.match(html, /named\.replace\(\/\^REF\\d\+_\//);
assert.match(html, /\[502, 503\]\.includes\(res\.status\)/);

// --- #130 item 3: 原文引用の境界判定は正規化前テキストの隣接文字で行う ---
{
  const { resolveSameDocumentNavigationCounterpart, validateSameDocumentCounterpartContext } =
    await import("../js/review-merge.mjs");
  const navigationCount = (quote, page1, page2, counterQuote) => resolveSameDocumentNavigationCounterpart(
    { page: 1, category: "number_mismatch", quote, reason: `P.2の「${counterQuote}」と一致しません` },
    { 1: page1, 2: page2 },
  ).counterparts.length;
  assert.equal(navigationCount("1,100百万円", "売上高 1,100百万円", "売上高 1,200百万円", "1,200百万円"), 1,
    "a numeric quote right after a label (whitespace between) must bind");
  assert.equal(navigationCount("Net sales 1,100 million yen", "Net sales 1,100 million yen", "Net sales 1,200 million yen", "200 million yen"), 0,
    "a fragment after a grouping comma must not bind");
  assert.equal(navigationCount("Net sales 1000", "Net sales 1000", "Net sales 2000", "Net sales 200"), 0,
    "a quote followed by more digits must not bind");
  assert.equal(navigationCount("sales 1,100", "Net sales 1,100", "Net sales 1,200", "sales 1,200"), 0,
    "a word-suffix fragment must still not bind");

  // --- #130 item 6: 数値密度の高い 300 行ページでも束縛が 200ms 未満で返る ---
  const denseLines = [];
  for (let index = 0; index < 300; index++) {
    denseLines.push(`Row${index} ${1000 + index} ${2000 + index} ${3000 + index} ${4000 + index} ${5000 + index}`);
  }
  const dense = denseLines.join("\n");
  const denseFinding = {
    page: 1, category: "number_mismatch", quote: "Row10 1010 2010",
    reason: "P.1の「Row10 1010 2010」はP.2の「Row20 1020 2020」と一致しません",
  };
  validateSameDocumentCounterpartContext(denseFinding, { 1: dense, 2: dense });
  const started = performance.now();
  validateSameDocumentCounterpartContext(denseFinding, { 1: dense, 2: dense });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `validateSameDocumentCounterpartContext took ${elapsed.toFixed(1)} ms on a 300-line dense page`);
}

console.log("Review logic hardening regression checks passed.");
