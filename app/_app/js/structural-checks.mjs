import { createCandidateLedger } from './candidate-ledger.mjs';
import { alignItems } from './reference-alignment.mjs';

// Deterministic candidate generation for layout-aware review.
// These checks produce review-pending candidates only; they do not accept or
// reject a translation without evidence from the user or a specialist pass.

const FINITE_VERB_PATTERN = /\b(?:am|are|is|was|were|be|been|being|do|does|did|has|have|had|can|could|may|might|must|shall|should|will|would|need|needs|include|includes|provide|provides|show|shows|represent|represents|remain|remains|make|makes|use|uses|contain|contains|calculate|calculates)\b/i;

export function finiteVerbHeuristic(text) {
  return FINITE_VERB_PATTERN.test(String(text || ""));
}

export function detectFinitePredicateGap(block = {}) {
  const role = String(block.role || block.type || block.kind || "").toLowerCase();
  if (!["paragraph", "prose"].includes(role)) return null;
  if (block.isHeading || block.isCaption || block.isTableCell) return null;
  const text = String(block.text || "").trim();
  const tokenCount = Number(block.tokenCount ?? text.split(/\s+/).filter(Boolean).length);
  if (tokenCount < 8 || !/[.!?]$/.test(text) || finiteVerbHeuristic(text)) return null;
  return {
    kind: "possible_sentence_fragment",
    state: "review_pending",
    severity: "medium",
    evidence: { page: Number(block.page) || null, block_id: String(block.id || ""), quote: text },
  };
}

export function compareAlignedLists(targetList = {}, referenceList = {}, alignItems) {
  const align = typeof alignItems === "function"
    ? alignItems
    : (targetItems, referenceItems) => referenceItems.map((reference, index) => ({
      target: targetItems[index] || null,
      reference,
      score: targetItems[index] ? 1 : 0,
    }));
  const targetItems = Array.isArray(targetList.items) ? targetList.items : [];
  const referenceItems = Array.isArray(referenceList.items) ? referenceList.items : [];
  const rawPairs = align(targetItems, referenceItems) || [];
  const pairs = Array.isArray(rawPairs) ? rawPairs : (Array.isArray(rawPairs.edges) ? rawPairs.edges : []);
  return pairs.filter(pair => !pair.target && pair.reference && Number(pair.score) >= 0.8).map(pair => ({
    kind: "translation_omission",
    state: "review_pending",
    severity: "high",
    evidence: {
      target: { page: Number(targetList.page) || null, block_id: String(targetList.id || "") },
      reference: {
        page: Number(pair.reference.page ?? pair.reference.reference_page) || null,
        block_id: String(pair.reference.block_id || pair.reference.id || ""),
        quote: String(pair.reference.quote ?? pair.reference.text ?? ""),
      },
      alignment_score: Number(pair.score),
    },
  }));
}

export function collectStructuralCandidates({ blocks = [], listComparisons = [] } = {}) {
  const predicateGaps = (Array.isArray(blocks) ? blocks : [])
    .map(detectFinitePredicateGap)
    .filter(Boolean);
  const listGaps = (Array.isArray(listComparisons) ? listComparisons : [])
    .flatMap(comparison => compareAlignedLists(comparison.target, comparison.reference, comparison.alignItems));
  return [...predicateGaps, ...listGaps];
}

function roleOf(block = {}) {
  return String(block?.role || block?.type || block?.kind || "").toLowerCase();
}

function pageOf(block = {}) {
  const page = Number(block?.page);
  return Number.isFinite(page) ? page : null;
}

function itemList(block = {}) {
  if (Array.isArray(block?.items) && block.items.length) return block.items.map((item, index) => ({
    id: String(item?.id || item?.item_id || `${block.id || "B"}-I${index + 1}`),
    text: String(item?.text ?? item?.value ?? item ?? "").trim(),
    page: pageOf(item) ?? pageOf(block),
  })).filter(item => item.text);
  if (!["list", "list-item", "table", "table-row"].includes(roleOf(block))) return [];
  return String(block?.text || "").split(/\r?\n/).map((text, index) => ({
    id: `${block.id || "B"}-L${index + 1}`,
    text: text.trim(),
    page: pageOf(block),
  })).filter(item => item.text);
}

function structuralBlocks(model = {}) {
  return (Array.isArray(model?.blocks) ? model.blocks : []).filter(block =>
    ["list", "list-item", "table", "table-row", "footnote"].includes(roleOf(block))
  );
}

function samePageSupport(targetBlock, referenceBlock) {
  const targetPage = pageOf(targetBlock);
  const referencePage = pageOf(referenceBlock);
  if (targetPage === null || referencePage === null) return { ok: true, score: 0.65 };
  const distance = Math.abs(targetPage - referencePage);
  return { ok: distance === 0, score: distance === 0 ? 1 : 0 };
}

function blockPairs(targetBlocks, referenceBlocks) {
  const edges = alignItems(targetBlocks, referenceBlocks, { minScore: 0.45 }).edges;
  const pairs = [];
  const usedReferences = new Set();
  for (const edge of edges) {
    if (!edge.target_id || !Array.isArray(edge.reference_ids) || !edge.reference_ids.length) continue;
    const target = targetBlocks.find(block => String(block.id) === String(edge.target_id));
    const reference = referenceBlocks.find(block => String(block.id) === String(edge.reference_ids[0]));
    if (!target || !reference || roleOf(target) !== roleOf(reference)) continue;
    const pageSupport = samePageSupport(target, reference);
    if (!pageSupport.ok) continue;
    usedReferences.add(String(reference.id));
    pairs.push({ target, reference, score: Math.max(Number(edge.score) || 0, pageSupport.score) });
  }
  // Cross-language translations often have no lexical overlap.  Same-page,
  // same-role structural order is a bounded fallback, never an acceptance.
  for (const reference of referenceBlocks) {
    if (usedReferences.has(String(reference.id))) continue;
    const target = targetBlocks.find(candidate =>
      roleOf(candidate) === roleOf(reference) &&
      !pairs.some(pair => pair.target === candidate) &&
      samePageSupport(candidate, reference).ok
    );
    if (!target) continue;
    usedReferences.add(String(reference.id));
    pairs.push({ target, reference, score: 0.7 });
  }
  return pairs;
}

function listDifferenceCandidates(targetModel = {}, referenceModel = {}) {
  const targetBlocks = structuralBlocks(targetModel);
  const referenceBlocks = structuralBlocks(referenceModel);
  const candidates = [];
  for (const pair of blockPairs(targetBlocks, referenceBlocks)) {
    if (pair.score < 0.65 || !["list", "list-item", "table", "table-row"].includes(roleOf(pair.target))) continue;
    const targetItems = itemList(pair.target);
    const referenceItems = itemList(pair.reference);
    if (!targetItems.length || !referenceItems.length) continue;
    const itemEdges = alignItems(targetItems, referenceItems, { minScore: 0.8 }).edges;
    const matchedReferenceIds = new Set(itemEdges
      .filter(item => item.relation !== "unmatched_reference")
      .flatMap(item => item.reference_ids || [])
      .map(String));
    const unmatchedReferenceItems = itemEdges
      .filter(item => item.relation === "unmatched_reference")
      .map(edge => referenceItems.find(item => edge.reference_ids?.includes(String(item.id))))
      .filter(Boolean);
    // Different languages may produce zero lexical item matches.  In that
    // case, only the count residue is a candidate; equal-length lists are not
    // treated as omissions merely because their text differs.
    const residue = matchedReferenceIds.size
      ? unmatchedReferenceItems
      : (referenceItems.length > targetItems.length ? referenceItems.slice(targetItems.length) : []);
    for (const referenceItem of residue) {
      candidates.push({
        kind: "translation_omission",
        state: "review_pending",
        severity: "high",
        source: "reference-alignment",
        evidence: {
          target: { page: pageOf(pair.target), block_id: String(pair.target.id || ""), quote: String(pair.target.text || "") },
          reference: { page: pageOf(pair.reference), block_id: String(referenceItem.id || pair.reference.id || ""), quote: referenceItem.text },
          relation: "unmatched_reference",
          alignment_score: pair.score,
        },
        reasons: ["reference list/table item has no same-page target counterpart"],
      });
    }
  }
  return candidates;
}

/**
 * Run local deterministic checks and return the durable ledger consumed by
 * the conditional review router. Optional layout models enable reference
 * alignment without changing the legacy paragraph/list checks.
 */
export function buildStructuralCandidateLedger({
  target = null,
  reference = null,
  blocks = [],
  listComparisons = [],
  createdAt = "",
} = {}) {
  const candidates = collectStructuralCandidates({ blocks, listComparisons });
  if (target && reference) {
    candidates.push(...listDifferenceCandidates(target, reference));
    const targetBlocks = Array.isArray(target.blocks) ? target.blocks : [];
    const referenceBlocks = Array.isArray(reference.blocks) ? reference.blocks : [];
    const edges = alignItems(targetBlocks, referenceBlocks, { minScore: 0.55 }).edges;
    for (const edge of edges.filter(item => item.relation === "unmatched_reference")) {
      const refBlock = referenceBlocks.find(block => String(block.id) === String(edge.reference_ids?.[0] || ""));
      if (!refBlock || roleOf(refBlock) !== "footnote") continue;
      const page = pageOf(refBlock);
      const targetHasSamePageFootnote = targetBlocks.some(block => roleOf(block) === "footnote" && pageOf(block) === page);
      if (targetHasSamePageFootnote) continue;
      candidates.push({
        kind: "translation_omission",
        state: "review_pending",
        severity: "high",
        source: "reference-alignment",
        evidence: {
          target: null,
          reference: { page, block_id: refBlock.id, quote: refBlock.text },
          relation: edge.relation,
          alignment_score: 0.7,
        },
        reasons: ["reference footnote has no same-page target counterpart"],
      });
    }
  }
  return createCandidateLedger(candidates, { createdAt });
}
