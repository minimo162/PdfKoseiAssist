import assert from "node:assert/strict";
import { semanticAutoReviewState } from "../js/auto-review-state.mjs";

assert.equal(semanticAutoReviewState({ mode: "done", per_packet: [{ status: "done", verification_state: "page_complete", coverage: 1 }] }), "processing_done");
assert.equal(semanticAutoReviewState({ mode: "done", per_packet: [{ status: "warning", verification_state: "incomplete", coverage: 0.6 }] }), "processing_done_with_review");
assert.equal(semanticAutoReviewState({ mode: "running", per_packet: [{ status: "running" }] }), "processing");
assert.equal(semanticAutoReviewState({ mode: "done", per_packet: [{ status: "done", verification_state: "needs_review", coverage: 1 }] }), "processing_done_with_review");
console.log("Test-SemanticCompletionState: PASS");
