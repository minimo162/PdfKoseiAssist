import assert from "node:assert/strict";
import { toPageModel, flattenPageItems } from "../js/layout-model.mjs";
import { alignItems, alignPages, alignmentEvidence } from "../js/reference-alignment.mjs";
import { createCandidateLedger, suppressCandidate, toLegacyFinding } from "../js/candidate-ledger.mjs";
import { buildStructuralCandidateLedger } from "../js/structural-checks.mjs";
import { buildReviewPlan } from "../js/review-router.mjs";

const target = toPageModel({ version: "layout-v2", blocks: [
  { id: "B1", role: "heading", text: "Principal Risks" },
  { id: "L1", role: "list", text: "1. Demand\n2. Quality", items: [{ id: "L1-1", text: "Demand" }, { id: "L1-2", text: "Quality" }] },
  { id: "B2", role: "paragraph", text: "Supply chain risk remains material." },
] }, { page: 31 });
const reference = toPageModel({ version: "layout-v2", blocks: [
  { id: "R1", role: "heading", text: "主要なリスク" },
  { id: "R2", role: "paragraph", text: "需要・市場環境の変化" },
  { id: "R3", role: "paragraph", text: "サプライチェーン・調達の中断" },
] }, { page: 31 });

assert.equal(target.blocks[1].role, "list");
assert.equal(flattenPageItems(target, ["list"]).length, 2);
assert.equal(target.version, "layout-model-v1");

const oneToMany = alignItems([{ id: "T1", text: "risk market" }], [
  { id: "R1", text: "risk market" },
  { id: "R2", text: "risk market" },
], { minScore: 0.2 });
assert.equal(oneToMany.edges.find(edge => edge.target_id === "T1")?.relation, "1:n");
assert.equal(oneToMany.edges.find(edge => edge.target_id === "T1")?.target_block_id, "T1");
assert.ok(Array.isArray(oneToMany.edges.find(edge => edge.target_id === "T1")?.signals));
assert.equal(oneToMany.edges.find(edge => edge.target_id === "T1")?.alignment_score, oneToMany.edges.find(edge => edge.target_id === "T1")?.score);
assert.equal(alignmentEvidence({ target_block_id: "T1", reference_block_ids: ["R1"], alignment_score: 0.91 }).alignment_score, 0.91);
const manyToOne = alignItems([
  { id: "T1", text: "risk market" },
  { id: "T2", text: "risk market" },
], [{ id: "R1", text: "risk market" }], { minScore: 0.2 });
assert.equal(manyToOne.edges.filter(edge => edge.reference_ids.includes("R1")).length, 2);
assert.ok(manyToOne.edges.filter(edge => edge.reference_ids.includes("R1")).every(edge => edge.relation === "n:1"));const pageShift = alignPages([{ page: 31, structural_signature: "heading|paragraph" }], [{ page: 33, structural_signature: "heading|paragraph" }], { minScore: 0.2 });
assert.equal(pageShift.edges[0].reference_page, 33);
const reordered = alignPages([
  { page: 1, structural_signature: "risk alpha" },
  { page: 2, structural_signature: "risk beta" },
], [
  { page: 10, structural_signature: "risk beta" },
  { page: 11, structural_signature: "risk alpha" },
], { minScore: 0.2 });
assert.equal(reordered.edges.find(edge => edge.target_page === 1)?.reference_page, 11);
assert.equal(reordered.edges.find(edge => edge.target_page === 2)?.reference_page, 10);
const complexPage = toPageModel({ version: "layout-v2", blocks: [
  { id: "TBL", role: "table", items: [{ id: "ROW1", text: "Revenue 100" }] },
  { id: "FN", role: "footnote", text: "Note: illustrative" },
] }, { page: 32 });
assert.equal(complexPage.tables[0].role, "table");
assert.equal(complexPage.footnotes[0].role, "footnote");
const referenceList = toPageModel({ version: "layout-v2", blocks: [
  { id: "R-LIST", role: "list", text: "1. 需要\n2. 品質\n3. 市場", items: [
    { id: "R-1", text: "1. 需要" }, { id: "R-2", text: "2. 品質" }, { id: "R-3", text: "3. 市場" },
  ] },
] }, { page: 31 });
const listLedger = buildStructuralCandidateLedger({ target, reference: referenceList });
assert.equal(listLedger.counts.review_pending, 1);
assert.equal(listLedger.candidates[0].evidence.reference.block_id, "R-3");

const ledger = createCandidateLedger([
  { id: "C1", kind: "translation_omission", severity: "high", evidence: { reference: { page: 31, block_id: "R3", quote: "サプライチェーン" } } },
  { id: "C2", kind: "translation_omission", severity: "low", evidence: { reference: { page: 31, block_id: "R3", quote: "サプライチェーン" } } },
]);
assert.equal(ledger.candidates.length, 1);
assert.equal(ledger.counts.review_pending, 1);
const suppressed = suppressCandidate(ledger, "C1", "same-heading context is insufficient");
assert.equal(suppressed.candidates[0].state, "suppressed");
assert.equal(toLegacyFinding(suppressed.candidates[0]).review_pending, false);

const structural = buildStructuralCandidateLedger({ target, reference });
assert.ok(structural.candidates.every(candidate => candidate.state === "review_pending"));
const plan = buildReviewPlan({ has_ref: true }, { prose_ratio: 0.5, has_list: true }, structural, 4);
assert.equal(plan.schema_version, "review-plan-v1");
assert.ok(Array.isArray(plan.candidate_ids));
assert.ok(plan.specialist_triggered);
console.log("Test-LayoutAlignmentLedger: PASS");
