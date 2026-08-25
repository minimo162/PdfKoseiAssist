import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoImportUiState, autoReviewAnnouncementState, mergeAutoReviewJobState } from "../js/auto-review-state.mjs";
import { createCandidateLedger, addCandidate, suppressCandidate } from "../js/candidate-ledger.mjs";
import { resolvePassSchedule } from "../js/pass-schedule.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { classifyBlockRole, flattenPageItems, toPageModel } from "../js/layout-model.mjs";
import { alignItems, alignPages } from "../js/reference-alignment.mjs";
import { computeSections, mapRefRange } from "../js/sectioning.mjs";
import { detectNumberOfAgreementCandidate, compareAlignedLists } from "../js/structural-checks.mjs";
import { tokenizeJa, tokenizeEn, Masker } from "../js/number-mask.mjs";
import { parseOkPages, validatePageChecks } from "../js/page-checks.mjs";
import { reconstructTextContentByVisualLines } from "../js/pdf-text-reconstruct.mjs";
import { evaluateKnownRealCases } from "../js/known-real-evaluator.mjs";
import { extractNumericLexemes } from "../js/finding-quality.mjs";
import { selectionAnchorForFinding, resolveSelectedFinding } from "../js/finding-selection.mjs";
import { summarizeConsistencyExecution } from "../js/review-reliability.mjs";
import { isMaskedPlaceholderOnlyMismatchFinding } from "../js/review-merge.mjs";
import { buildReviewPlan } from "../js/review-router.mjs";
import { extractNumberedHeadingIndex } from "../js/heading-index.mjs";

const packet = { id: "J", mode: "done", packets_done: 1, packets_total: 1, per_packet: [{ packet_id: "P1", status: "done" }] };
const errors = new Map([["P1", new Error("import failed")]]);
assert.deepEqual(autoImportUiState(packet, { errors }), {
  pendingPacketId: "", errorPacketId: "P1", importingPacketId: "", importing: false, importError: true,
});
assert.equal(autoReviewAnnouncementState(packet, { errors }).kind, "import_error");
assert.equal(mergeAutoReviewJobState({ mode: "done", per_packet: [] }, { mode: "done", per_packet: [] }).mode, "queued");

assert.deepEqual(resolvePassSchedule({ profile: "quick", gapPass: true, maxPasses: 1 }).passes.map(pass => pass.lens), ["gap"]);
assert.equal(resolvePassSchedule({ profile: "quick", gapPass: true, maxPasses: 1 }).passes.length, 1);
const reviewJobSource = readFileSync(new URL("../src/ReviewJob.ps1", import.meta.url), "utf8");
assert.match(reviewJobSource, /\[Math\]::Max\(0, \$cap - 1\)/);
assert.match(reviewJobSource, /if \(\$x -eq 'gap'\) \{ 'gap' \} elseif \(\$i -eq 0\)/);

const baseCandidate = {
  id: "C1", kind: "translation_omission", severity: "low", state: "accepted", decision_state: "accepted",
  evidence: { target: { page: 1, block_id: "T1", quote: "A" }, reference: { page: 1, block_id: "R1", quote: "B" } },
};
let ledger = createCandidateLedger([baseCandidate]);
ledger = suppressCandidate(ledger, "C1", "rule");
ledger = addCandidate(ledger, { ...baseCandidate, severity: "high", state: "review_pending", decision_state: "undecided" });
assert.equal(ledger.candidates[0].state, "suppressed");
assert.equal(ledger.candidates[0].decision_state, "accepted");
assert.equal(ledger.candidates[0].severity, "high");
assert.equal(ledger.suppressions.length, 1);
const unchanged = suppressCandidate(ledger, "missing", "ghost");
assert.equal(unchanged.suppressions.length, 1);
assert.equal(unchanged.counts.suppressed, 1);

const finding = {
  id: "N1", page: 1, category: "number_mismatch", quote: "Target 100",
  referenceQuote: "Value 100", referencePages: [1], referenceFile: "REF1",
};
const contexts = await collectNumericFindingContexts([finding], {
  targetTextFor: () => "Target 100",
  referenceSourceFor: () => ({ id: "R", pageCount: 2 }),
  referenceTextFor: (_ref, page) => page === 1 ? "Value 100\nValue 100" : "Value 100",
});
assert.equal(contexts.size, 0);

assert.equal(classifyBlockRole({ text: "Revenue", height: 18 }), "paragraph");
assert.equal(classifyBlockRole({ text: "Real heading", fontSize: 14 }), "heading");
const listPage = toPageModel({ page: 1, blocks: [{ id: "L1", text: "- Item", fontSize: 10 }] });
assert.equal(flattenPageItems(listPage).length, 1);

const shortEdges = alignItems([{ id: "T", text: "Total revenue for the year" }], [{ id: "R", text: "Total" }]).edges;
assert.equal(shortEdges.some(edge => edge.relation === "1:1"), false);
const tiedPages = alignPages([{ page: 1, structural_signature: "heading:Same" }], [
  { page: 1, structural_signature: "heading:Same" }, { page: 1, structural_signature: "heading:Same" },
]).edges;
assert.equal(tiedPages.filter(edge => edge.relation === "1:n").length, 2);
const unmatchedPage = alignPages([], [{ page: 1, structural_signature: "heading:A" }]).edges[0];
assert.equal("candidate_type" in unmatchedPage, false);

const guarded = computeSections(31, { sectionWidth: 25, overlap: 3 });
assert.equal(guarded.length, 2);
assert.ok(guarded.every(section => section.pageCount <= 25));
assert.deepEqual(mapRefRange({ startPage: 9, endPage: 12 }, {
  targetTotal: 20, refTotal: 40, buffer: 0,
  targetBreakpoints: [1, 11, 999], refBreakpoints: [1, 21, 999],
}), { refStart: 1, refEnd: 40, refPageCount: 40, mode: "manual" });

const grammar = detectNumberOfAgreementCandidate("The results are final and the number of items are ten.", 1);
assert.equal(grammar.suggestion, "The results are final and the number of items is ten.");
const omissions = compareAlignedLists({ page: 1, id: "T", items: [] }, { page: 1, id: "R", items: [{ id: "R1", text: "Missing" }] });
assert.equal(omissions.length, 1);

assert.equal(tokenizeJa("(1)万一の場合").length, 0);
const jaScale = tokenizeJa("3千万円")[0];
const enScale = tokenizeEn("30 million yen")[0];
assert.equal(jaScale.micro, enScale.micro);
const periodMasker = new Masker("period");
assert.equal(periodMasker.mask("（25.4～25.6）", "ja").used.length, 0);

const rangeErrors = [];
parseOkPages("1-999999999999", new Set([1, 2]), rangeErrors);
assert.equal(rangeErrors.length, 1);
assert.equal(validatePageChecks({ ok_pages: "", exceptions: [{ page: 1, verdict: "finding" }] }, [1], []).complete, false);

const reconstructed = reconstructTextContentByVisualLines({ items: [
  { str: "ABC", transform: [1, 0, 0, 10, 0, 100], width: 100, height: 10 },
  { str: "123", transform: [1, 0, 0, 10, 50, 100], width: 20, height: 10 },
] });
assert.ok(reconstructed.includes("ABC") && reconstructed.includes("123"));
const duplicate = reconstructTextContentByVisualLines({ items: [
  { str: "ABC", transform: [1, 0, 0, 10, 0, 100], width: 30, height: 10 },
  { str: "ABC", transform: [1, 0, 0, 10, 1, 100], width: 30, height: 10 },
] });
assert.equal(duplicate, "ABC");

const confirmedOnly = evaluateKnownRealCases({
  cases: [{ id: "K1", status: "confirmed" }],
  findings: [{ id: "F1", known_case_id: "K1", decision_state: "accepted", highlight_status: "ok", highlight_boxes: [{}] }],
  observedRun: true,
});
assert.equal(confirmedOnly.status, "pass");
const unknownDecision = evaluateKnownRealCases({
  cases: [{ id: "K2", status: "provisional" }],
  findings: [{ id: "F2", known_case_id: "K2", decision_state: "suppressed" }],
  observedRun: true,
});
assert.equal(unknownDecision.status, "fail");

assert.equal(extractNumericLexemes("   26 revenue").some(item => item.value.includes("26")), true);
assert.equal(extractNumericLexemes("P.26 revenue").some(item => item.value.includes("26")), false);
const anchor = selectionAnchorForFinding({ id: "old", page: 2, category: "grammar", area_hint: "body" });
assert.equal(resolveSelectedFinding([{ id: "new", page: 2, quote: "Better citation", category: "grammar", area_hint: "body" }], "old", anchor)?.id, "new");
assert.equal(summarizeConsistencyExecution({ target_pages: [1, 2], pages_checked: [3, 4] }).state, "incomplete");
assert.equal(isMaskedPlaceholderOnlyMismatchFinding({ category: "number_mismatch", issueSummary: "伏字記号⟦#ABC⟧が異なる" }), true);

const idOnlyPlan = buildReviewPlan({ hasRef: true }, {}, {
  candidates: [{ id: "list-in-id-only", kind: "translation_omission", state: "review_pending" }],
}, 4);
assert.equal(idOnlyPlan.passes.some(pass => String(pass.lens || pass.kind).includes("list")), false);

const sidecar = [
  "===== PDF P.1 / TARGET_CHECK / 元PDF P.1 / X =====",
  "i. lowercase list item",
  "IV. Valid Uppercase Heading",
].join("\n");
assert.deepEqual(extractNumberedHeadingIndex(sidecar).map(item => item.marker), ["IV."]);

console.log("Test-Issue119Regression: PASS");
