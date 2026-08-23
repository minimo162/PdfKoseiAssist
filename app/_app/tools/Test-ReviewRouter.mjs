import assert from "node:assert/strict";
import { buildReviewPlan } from "../js/review-router.mjs";

const plan = buildReviewPlan(
  { has_ref: true },
  { prose_ratio: 0.7, has_list: true },
  { has_alignment_gap: true, high_severity: true },
  4,
);
assert.deepEqual(plan.passes.map(pass => pass.id), ["grammar_prose", "translation_omission", "independent_review"]);
assert.equal(plan.passes[0].chat_mode, "New");
assert.equal(plan.passes[1].chat_mode, "Reuse");
assert.equal(plan.passes[2].independent, true);
assert.equal(plan.specialist_triggered, true);
const noRef = buildReviewPlan({ hasRef: false }, { hasTable: true }, { hasAlignmentGap: true }, 4);
assert.deepEqual(noRef.passes.map(pass => pass.id), ["structure_layout"]);
const arrayPlan = buildReviewPlan({ has_ref: true }, {}, [
  { id: "C-array", kind: "translation_omission", severity: "high", state: "review_pending" },
], 4);
assert.ok(arrayPlan.candidate_ids.includes("C-array"));
assert.ok(arrayPlan.passes.some(pass => pass.id === "independent_review" && pass.chat_mode === "New"));
const capped = buildReviewPlan({ hasRef: true }, { proseRatio: 1, hasTable: true }, { hasAlignmentGap: true }, 1);
assert.equal(capped.passes.length, 1);
assert.ok(capped.skipped.some(item => item.reason === "budget-exceeded"));
console.log("Test-ReviewRouter: PASS");
