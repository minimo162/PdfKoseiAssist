// Deterministic target/reference alignment.  Alignment is evidence for a
// candidate; it is never a user decision and never implies acceptance.

export const ALIGNMENT_VERSION = "reference-alignment-v1";

function textOf(value) { return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function tokens(value) { return new Set(textOf(value).split(/\s+/).filter(Boolean)); }
function numberOf(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

function similarity(left, right) {
  const a = tokens(left), b = tokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  const jaccard = common / (a.size + b.size - common);
  const containment = common / Math.max(1, Math.min(a.size, b.size));
  const prefix = textOf(left) && textOf(right) && (textOf(left).startsWith(textOf(right)) || textOf(right).startsWith(textOf(left))) ? 0.15 : 0;
  return Math.min(1, Math.max(jaccard, containment * 0.82) + prefix);
}

function roleSignature(page = {}) {
  if (Array.isArray(page?.blocks)) return page.blocks.map(block => String(block?.role || block?.type || block?.kind || "unknown")).join(" ");
  return String(page?.structural_signature || "").split("|").map(part => part.split(":", 1)[0]).join(" ");
}

function pageScore(target, reference) {
  const content = similarity(target?.structural_signature || target?.text, reference?.structural_signature || reference?.text);
  const roles = similarity(roleSignature(target), roleSignature(reference));
  const pageDistance = Math.abs(numberOf(target?.page, 0) - numberOf(reference?.page, 0));
  const pageBias = pageDistance === 0 ? 0.18 : pageDistance === 1 ? 0.10 : Math.max(0, 0.06 - pageDistance * 0.01);
  // Different-language pages often have no lexical overlap.  Role and page
  // position provide bounded evidence, while the lexical score still wins
  // when content is genuinely comparable.
  return Math.max(0, Math.min(1, content * 0.70 + roles * 0.18 + pageBias));
}

export function alignPages(targetPages = [], referencePages = [], options = {}) {
  const targets = Array.isArray(targetPages) ? targetPages : [];
  const refs = Array.isArray(referencePages) ? referencePages : [];
  const minScore = numberOf(options.minScore, 0.28);
  const selections = [];
  const used = new Set();
  const referenceDegree = new Map();
  for (const target of targets) {
    const ranked = refs.map((reference, index) => ({ reference, index, score: pageScore(target, reference) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const best = ranked[0];
    if (!best || best.score < minScore) {
      selections.push({ target, items: [] });
      continue;
    }
    const ties = ranked.filter(item => item.score >= Math.max(minScore, best.score - 0.10)).slice(0, 3);
    const items = ties.length > 1 && best.score < 0.62 ? ties : [best];
    selections.push({ target, items });
    for (const item of items) {
      used.add(item.index);
      referenceDegree.set(item.index, (referenceDegree.get(item.index) || 0) + 1);
    }
  }
  const edges = [];
  for (const selection of selections) {
    const target = selection.target;
    if (!selection.items.length) {
      edges.push({ relation: "unmatched_target", target_page: target?.page ?? null, reference_page: null, score: 0, evidence: { target_signature: target?.structural_signature || "" } });
      continue;
    }
    for (const item of selection.items) {
      const relation = selection.items.length > 1 ? "1:n" : (referenceDegree.get(item.index) > 1 ? "n:1" : "1:1");
      edges.push({ relation, target_page: target?.page ?? null, reference_page: item.reference?.page ?? null, score: Number(item.score.toFixed(4)), evidence: { target_signature: target?.structural_signature || "", reference_signature: item.reference?.structural_signature || "" } });
    }
  }
  for (const [index, reference] of refs.entries()) {
    if (!used.has(index)) edges.push({ relation: "unmatched_reference", target_page: null, reference_page: reference?.page ?? null, score: 0, evidence: { reference_signature: reference?.structural_signature || "" } });
  }
  return { version: ALIGNMENT_VERSION, edges: edges.map(edgeContract) };
}
function itemId(item, fallback) { return String(item?.id || item?.item_id || fallback); }
function edgeContract(edge = {}) {
  const score = numberOf(edge.alignment_score ?? edge.score, 0);
  const referenceIds = Array.isArray(edge.reference_block_ids)
    ? edge.reference_block_ids.map(String)
    : (Array.isArray(edge.reference_ids) ? edge.reference_ids.map(String) : []);
  const signals = Array.isArray(edge.signals) && edge.signals.length
    ? edge.signals.map(String)
    : edge.relation === "unmatched_reference"
      ? ["unmatched_reference"]
      : edge.relation === "unmatched_target"
        ? ["unmatched_target"]
        : ["semantic_match"];
  return {
    ...edge,
    target_block_id: edge.target_block_id ?? edge.target_id ?? null,
    reference_block_ids: referenceIds,
    alignment_score: score,
    signals,
    ...(edge.relation === "unmatched_reference" ? { candidate_type: "translation_omission" } : {}),
  };
}

export function alignItems(targetItems = [], referenceItems = [], options = {}) {
  const targets = Array.isArray(targetItems) ? targetItems : [];
  const refs = Array.isArray(referenceItems) ? referenceItems : [];
  const minScore = numberOf(options.minScore, 0.55);
  const selections = [];
  const usedRefs = new Set();
  const usedTargets = new Set();
  const referenceDegree = new Map();
  for (const [targetIndex, target] of targets.entries()) {
    const ranked = refs.map((reference, referenceIndex) => ({ reference, referenceIndex, score: similarity(target?.text, reference?.text) }))
      .sort((a, b) => b.score - a.score || a.referenceIndex - b.referenceIndex);
    const best = ranked[0];
    if (!best || best.score < minScore) {
      selections.push({ targetIndex, target, items: [] });
      continue;
    }
    const threshold = Math.max(minScore, best.score - 0.15);
    const items = ranked.filter(item => item.score >= threshold).slice(0, 3);
    selections.push({ targetIndex, target, items });
    usedTargets.add(targetIndex);
    for (const item of items) {
      usedRefs.add(item.referenceIndex);
      referenceDegree.set(item.referenceIndex, (referenceDegree.get(item.referenceIndex) || 0) + 1);
    }
  }
  const edges = [];
  for (const selection of selections) {
    const { targetIndex, target, items } = selection;
    if (!items.length) {
      edges.push({ relation: "unmatched_target", target_id: itemId(target, `T${targetIndex + 1}`), reference_ids: [], score: 0, evidence: { target_quote: String(target?.text || "") } });
      continue;
    }
    const relation = items.length > 1 ? "1:n" : (referenceDegree.get(items[0].referenceIndex) > 1 ? "n:1" : "1:1");
    edges.push({ relation, target_id: itemId(target, `T${targetIndex + 1}`), reference_ids: items.map(item => itemId(item.reference, `R${item.referenceIndex + 1}`)), score: Number((items.reduce((sum, item) => sum + item.score, 0) / items.length).toFixed(4)), evidence: { target_quote: String(target?.text || ""), reference_quotes: items.map(item => String(item.reference?.text || "")), target_index: targetIndex } });
  }
  for (const [referenceIndex, reference] of refs.entries()) if (!usedRefs.has(referenceIndex)) edges.push({ relation: "unmatched_reference", target_id: null, reference_ids: [itemId(reference, `R${referenceIndex + 1}`)], score: 0, evidence: { reference_quotes: [String(reference?.text || "")] } });
  return { version: ALIGNMENT_VERSION, edges: edges.map(edgeContract) };
}
export function buildAlignmentEdges(targetModel = {}, referenceModel = {}, options = {}) {
  const pageAlignment = alignPages([targetModel], [referenceModel], options);
  const targetBlocks = targetModel.blocks || [];
  const referenceBlocks = referenceModel.blocks || [];
  const itemAlignment = alignItems(targetBlocks, referenceBlocks, options);
  return {
    version: ALIGNMENT_VERSION,
    page_edges: pageAlignment.edges,
    block_edges: itemAlignment.edges,
    has_alignment_gap: itemAlignment.edges.some(edge => edge.relation === "unmatched_reference"),
    ambiguous_alignment: itemAlignment.edges.some(edge => edge.relation === "1:n" || edge.relation === "n:1" || (edge.score > 0 && edge.score < 0.72)),
  };
}

export function alignmentEvidence(edge = {}) {
  return {
    alignment_score: numberOf(edge.alignment_score ?? edge.score, 0),
    relation: String(edge.relation || ""),
    target: edge.target_id || edge.target_block_id ? { block_id: String(edge.target_id || edge.target_block_id) } : null,
    reference: Array.isArray(edge.reference_ids) && edge.reference_ids.length
      ? { block_ids: edge.reference_ids.map(String) }
      : (Array.isArray(edge.reference_block_ids) && edge.reference_block_ids.length ? { block_ids: edge.reference_block_ids.map(String) } : null),
    quotes: edge.evidence || {},
  };
}
