// Deterministic candidate generation for layout-aware review.
// These checks produce review-pending candidates only; they do not accept or
// reject a translation without evidence from the user or a specialist pass.

const FINITE_VERB_PATTERN = /\b(?:am|are|is|was|were|be|been|being|do|does|did|has|have|had|can|could|may|might|must|shall|should|will|would|need|needs|include|includes|provide|provides|show|shows|represent|represents|remain|remains|make|makes|use|uses|contain|contains|calculate|calculates)\b/i;

export function finiteVerbHeuristic(text) {
  return FINITE_VERB_PATTERN.test(String(text || ""));
}

export function detectFinitePredicateGap(block = {}) {
  if (String(block.type || "").toLowerCase() !== "paragraph") return null;
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
  const pairs = align(targetItems, referenceItems) || [];
  return pairs.filter(pair => !pair.target && pair.reference && Number(pair.score) >= 0.8).map(pair => ({
    kind: "translation_omission",
    state: "review_pending",
    severity: "high",
    evidence: {
      target: { page: Number(targetList.page) || null, block_id: String(targetList.id || "") },
      reference: pair.reference,
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
