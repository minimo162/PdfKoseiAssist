import assert from "node:assert/strict";
import { buildDeterministicGrammarFindings, compareAlignedLists, detectFinitePredicateGap, detectNumberOfAgreementCandidate } from "../js/structural-checks.mjs";

const gap = detectFinitePredicateGap({ type: "paragraph", page: 18, id: "B18", text: "A long translated phrase without a finite predicate at all." });
assert.equal(gap?.state, "review_pending");
assert.equal(detectFinitePredicateGap({ type: "heading", text: "A heading." }), null);
const listGaps = compareAlignedLists(
  { id: "L1", page: 31, items: [{ text: "one" }] },
  { id: "R1", page: 31, items: [{ text: "one" }, { text: "two" }] },
  (target, reference) => [
    { target: target[0], reference: reference[0], score: 0.99 },
    { target: null, reference: reference[1], score: 0.91 },
  ],
);
assert.equal(listGaps.length, 1);
assert.equal(listGaps[0].kind, "translation_omission");
assert.equal(listGaps[0].state, "review_pending");
const sva = detectNumberOfAgreementCandidate(
  "The number of shares to be granted as PSU are calculated based on the performance outlook at the beginning of the fiscal year, using it as the target value, and are determined according to the level of achievement.",
  78,
);
assert.equal(sva?.page, 78);
assert.equal(sva?.deterministic_check, "subject-verb-agreement:number-of");
assert.match(sva?.suggestion || "", /number of shares.*is calculated/i);
assert.equal(detectNumberOfAgreementCandidate("A number of shares are calculated.", 78), null);
assert.equal(detectNumberOfAgreementCandidate("The number of shares is calculated.", 78), null);
assert.equal(detectNumberOfAgreementCandidate("The number of directors who are members of the Audit Committee shall be not more than eight.", 57), null);
assert.equal(detectNumberOfAgreementCandidate("The number of shares that are currently held by the officers represents the current total.", 68), null);
assert.equal(detectNumberOfAgreementCandidate("In calculating the number of workers and wages, workers who are dispatched from the Company to other companies are excluded.", 82), null);
assert.equal(buildDeterministicGrammarFindings([{ page: 78, text: sva.quote }]).length, 1);
console.log("Test-StructuralChecks: PASS");
