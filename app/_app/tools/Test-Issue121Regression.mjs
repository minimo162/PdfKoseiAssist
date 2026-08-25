import assert from "node:assert/strict";
import { tokenizeJa } from "../js/number-mask.mjs";
import { flattenPageItems, toPageModel } from "../js/layout-model.mjs";
import { computeSections, mapRefRange } from "../js/sectioning.mjs";
import { summarizeConsistencyExecution } from "../js/review-reliability.mjs";
import { buildReviewPlan } from "../js/review-router.mjs";
import { createCandidateLedger } from "../js/candidate-ledger.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";

const compound = tokenizeJa("売上高は2億3千万円となった。");
assert.equal(compound.length, 1);
assert.equal(compound[0].micro, 230_000_000n * 1_000_000n);
assert.equal(compound[0].source, "explicit-compound-scale");

const page = toPageModel({
  page: 1,
  blocks: [
    { id: "R1", role: "table-row", text: "売上高 230百万円" },
    { id: "C1", role: "caption", text: "表1 売上高" },
  ],
});
assert.deepEqual(flattenPageItems(page).map(item => item.role), ["table-row", "caption"]);

assert.deepEqual(
  computeSections(26, { sectionWidth: 25, overlap: 0 }).map(({ startPage, endPage }) => [startPage, endPage]),
  [[1, 26]],
);
assert.deepEqual(
  computeSections(31, { sectionWidth: 25, overlap: 3 }).map(({ startPage, endPage }) => [startPage, endPage]),
  [[1, 31]],
);
const fractional = mapRefRange(
  { startPage: 25, endPage: 25 },
  { targetTotal: 25, refTotal: 20, buffer: 0, targetBreakpoints: [25.5], refBreakpoints: [10.5] },
);
assert.equal(fractional.mode, "manual");
assert.equal(fractional.refStart, 10);

assert.equal(summarizeConsistencyExecution({
  target_pages: [1, 2],
  pages_checked: [1, 2, 3],
  findings_count: 0,
}).state, "completed-zero");

const listPlan = buildReviewPlan(
  { has_ref: true },
  {},
  { candidates: [{
    id: "C-list",
    kind: "translation_omission",
    state: "review_pending",
    reasons: ["reference list/table item has no same-page target counterpart"],
  }] },
);
assert.ok(listPlan.passes.some(pass => pass.id === "translation_omission"));

const pending = {
  id: "C-pending",
  kind: "translation_omission",
  state: "review_pending",
  decision_state: "undecided",
  severity: "medium",
  evidence: { target: { page: 1, block_id: "B1", quote: "A" } },
};
const accepted = { ...pending, id: "C-accepted", state: "accepted", decision_state: "accepted", severity: "high" };
const ledger = createCandidateLedger([pending, accepted]);
assert.equal(ledger.candidates.length, 1);
assert.equal(ledger.candidates[0].id, "C-pending");
assert.equal(ledger.candidates[0].state, "accepted");
assert.equal(ledger.candidates[0].decision_state, "accepted");
assert.equal(ledger.candidates[0].severity, "high");

const referenceCalls = [];
const numericContexts = await collectNumericFindingContexts([{
  id: "F1",
  page: 1,
  category: "number_mismatch",
  quote: "Sales 100",
  referenceQuote: "売上 100",
  referencePages: [2],
}], {
  targetTextFor: () => "Sales 100",
  referenceTextFor: (_ref, pageNumber) => {
    referenceCalls.push(pageNumber);
    return pageNumber === 2 || pageNumber === 3 ? "売上 100" : "";
  },
  referenceSourceFor: () => ({ id: "REF1" }),
  referencePageCount: 3,
});
assert.ok(numericContexts.has("F1"));
assert.deepEqual(referenceCalls, [2]);

console.log("Test-Issue121Regression: PASS");
