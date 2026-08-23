import assert from "node:assert/strict";
import { compareAlignedLists, detectFinitePredicateGap } from "../js/structural-checks.mjs";

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
console.log("Test-StructuralChecks: PASS");
