import assert from "node:assert/strict";
import { buildDeterministicGrammarFindings, compareAlignedLists, detectFinitePredicateGap, detectNumberOfAgreementCandidate, finiteVerbHeuristic } from "../js/structural-checks.mjs";
import { extractNumberedHeadingIndex } from "../js/heading-index.mjs";

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

// #131: 主語が "the number of" で始まる名詞句のときだけ発火する。
// "Changes in the number of shares outstanding are as follows." の主語は changes。
assert.equal(detectNumberOfAgreementCandidate("Changes in the number of shares outstanding are as follows.", 12), null);
assert.equal(detectNumberOfAgreementCandidate("Details of the number of shares held by directors were disclosed.", 12), null);
assert.equal(detectNumberOfAgreementCandidate("As of March 31, 2026, the number of employees were 3,214.", 4)?.deterministic_check, "subject-verb-agreement:number-of");
assert.match(detectNumberOfAgreementCandidate("As of March 31, 2026, the number of employees were 3,214.", 4)?.suggestion || "", /employees was 3,214/);
assert.equal(detectNumberOfAgreementCandidate("The total number of shares outstanding were 100,000.", 5)?.deterministic_check, "subject-verb-agreement:number-of");

// #131: 一般過去形 (-ed) は finite 扱い。財務ページの段落を片端から possible_sentence_fragment にしない。
for (const text of [
  "Net sales increased 3.5% compared with the previous fiscal year and operating profit decreased due to higher costs.",
  "The Company recorded an impairment loss on goodwill related to the overseas subsidiary during the period.",
  "Cash and cash equivalents at the end of the fiscal year amounted to 12,345 million yen.",
  "Selling, general and administrative expenses totaled 1,234 million yen for the fiscal year.",
]) {
  assert.equal(finiteVerbHeuristic(text), true, text);
  assert.equal(detectFinitePredicateGap({ type: "paragraph", page: 3, id: "B3", text }), null, text);
}
// 分詞形容詞だけの断片は引き続き候補に残す。
assert.equal(detectFinitePredicateGap({ type: "paragraph", page: 3, id: "B3", text: "A long translated phrase without a finite predicate at all." })?.kind, "possible_sentence_fragment");
assert.equal(detectFinitePredicateGap({ type: "paragraph", page: 3, id: "B3", text: "The consolidated financial statements and the accompanying notes for the fiscal year under review." })?.kind, "possible_sentence_fragment");

// #131 (heading-index): "3.5 million shares" は小数であって「3.」見出しではない。
{
  const sidecar = [
    "===== PDF P.1 / TARGET_CHECK / 元PDF P.1 / x =====",
    "3.5 million shares were issued during the fiscal year.",
    "3. Overview of results",
    "1.概要の説明",
  ].join("\n");
  const headings = extractNumberedHeadingIndex(sidecar).map(entry => entry.text);
  assert.deepEqual(headings, ["3. Overview of results", "1. 概要の説明"]);
}
console.log("Test-StructuralChecks: PASS");
