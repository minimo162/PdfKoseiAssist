import assert from "node:assert/strict";
import { semanticAutoReviewState, mergeAutoReviewJobState, autoReviewWarningSummary } from "../js/auto-review-state.mjs";

assert.equal(semanticAutoReviewState({ mode: "done", per_packet: [{ status: "done", verification_state: "page_complete", coverage: 1 }] }), "processing_done");
assert.equal(semanticAutoReviewState({ mode: "done", per_packet: [{ status: "warning", verification_state: "incomplete", coverage: 0.6 }] }), "processing_done_with_review");
assert.equal(semanticAutoReviewState({ mode: "running", per_packet: [{ status: "running" }] }), "processing");
assert.equal(semanticAutoReviewState({ mode: "done", per_packet: [{ status: "done", verification_state: "needs_review", coverage: 1 }] }), "processing_done_with_review");
const warning = { mode:"done", per_packet:[{packet_id:"P",status:"warning",verification_state:"needs_review",coverage:1,warning:"回答の一部を復元したため、この依頼を再試行してください。"}] };
assert.ok(autoReviewWarningSummary(warning).reasonCodes.includes("repair"));
const resumed = mergeAutoReviewJobState(warning, {mode:"done",per_packet:[{packet_id:"P",status:"done",verification_state:"page_complete",coverage:1}]});
assert.equal(semanticAutoReviewState(resumed), "processing_done");
assert.equal(autoReviewWarningSummary(resumed).uncertainCount, 0);
console.log("Test-SemanticCompletionState: PASS");
