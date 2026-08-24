import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAutoImportStopGate, summarizeConsistencyExecution, consistencyExecutionLabel } from "../js/review-reliability.mjs";

const gate = createAutoImportStopGate();
assert.equal(gate.enter(), true);
assert.equal(gate.enter(), false);
gate.resume();
assert.equal(gate.enter(), true);

const knownMismatch = { packet_id: "SEC_001_STRUCTURE", status: "done", target_pages: [1, 2], pages_checked: [1, 2], findings_count: 1 };
assert.equal(summarizeConsistencyExecution(knownMismatch).state, "completed-with-findings");
assert.match(consistencyExecutionLabel(knownMismatch, x => x), /指摘1件/);

const clean = { packet_id: "SEC_001_TERMS", status: "done", target_pages: [1, 2], pages_checked: [1, 2], findings_count: 0 };
assert.equal(summarizeConsistencyExecution(clean).state, "completed-zero");
assert.match(consistencyExecutionLabel(clean, x => x), /正常に2ページ/);

assert.equal(summarizeConsistencyExecution({ status: "done", target_pages: [], pages_checked: [], findings_count: 0 }).state, "no-target");
assert.equal(summarizeConsistencyExecution({ status: "done", target_pages: [1], pages_checked: [], findings_count: 0 }).state, "not-executed");
assert.equal(summarizeConsistencyExecution({ status: "error", target_pages: [1], pages_checked: [], error: "bad" }).state, "failed");

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, "..", "index.html"), "utf8");
assert.match(index, /createAutoImportStopGate/);
assert.match(index, /consistencyExecutionLabel/);
assert.match(index, /await yieldToBrowser\(\)/);
assert.doesNotMatch(index, /return "内容を確認してください"/);
assert.doesNotMatch(index, /findingQualityWarningText\(f\) \?/);
assert.doesNotMatch(index, /const qualityBlock = reviewLabel \|\| visibleQualityWarning/);

console.log("review reliability tests passed");
