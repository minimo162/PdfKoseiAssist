// Candidate ledger for deterministic checks and conditional specialist review.
// The ledger is the durable boundary between evidence and user decisions.

export const CANDIDATE_LEDGER_VERSION = "candidate-ledger-v1";
export const CANDIDATE_STATES = Object.freeze(["review_pending", "suppressed", "accepted", "rejected", "held"]);

function textOf(value) { return String(value ?? "").replace(/[\t ]+/g, " ").trim(); }
function numberOf(value, fallback = null) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function listOf(value) { return Array.isArray(value) ? value : value == null || value === "" ? [] : [value]; }
function stablePart(value) { return textOf(value).toLowerCase().replace(/\s+/g, " "); }

export function candidateFingerprint(candidate = {}) {
  const evidence = candidate.evidence || {};
  return [candidate.kind || candidate.category || "candidate", evidence.target?.page, evidence.target?.block_id, evidence.reference?.page, evidence.reference?.block_id, evidence.target?.quote, evidence.reference?.quote].map(stablePart).join("|");
}

export function createCandidate(candidate = {}, options = {}) {
  const evidence = candidate.evidence || {};
  const state = CANDIDATE_STATES.includes(String(candidate.state)) ? String(candidate.state) : "review_pending";
  return {
    id: textOf(candidate.id) || `C-${candidateFingerprint(candidate).slice(0, 72) || "unknown"}`,
    fingerprint: textOf(candidate.fingerprint) || candidateFingerprint(candidate),
    kind: textOf(candidate.kind || candidate.category) || "structural_difference",
    state,
    severity: textOf(candidate.severity) || "medium",
    route: textOf(candidate.route) || "deterministic",
    source: textOf(candidate.source) || "layout-v2",
    evidence: {
      target: evidence.target ? {
        page: numberOf(evidence.target.page), block_id: textOf(evidence.target.block_id), quote: textOf(evidence.target.quote),
      } : null,
      reference: evidence.reference ? {
        page: numberOf(evidence.reference.page), block_id: textOf(evidence.reference.block_id), quote: textOf(evidence.reference.quote),
      } : null,
      alignment_score: numberOf(evidence.alignment_score),
      relation: textOf(evidence.relation),
      structural_role: textOf(evidence.structural_role),
    },
    reasons: listOf(candidate.reasons).map(textOf).filter(Boolean).slice(0, 8),
    created_at: textOf(candidate.created_at) || textOf(options.createdAt),
    decision_state: textOf(candidate.decision_state) || "undecided",
  };
}

export function createCandidateLedger(candidates = [], options = {}) {
  const byFingerprint = new Map();
  const suppressions = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const candidate = createCandidate(raw, options);
    const key = candidate.fingerprint || candidate.id;
    const existing = byFingerprint.get(key);
    if (!existing) {
      byFingerprint.set(key, candidate);
      continue;
    }
    // Preserve durable identity while accepting stronger evidence and a
    // decision that has progressed beyond review_pending in either direction.
    const existingDecided = existing.state !== "review_pending";
    const candidateDecided = candidate.state !== "review_pending";
    const progressed = candidateDecided && !existingDecided
      ? { state: candidate.state, decision_state: candidate.decision_state }
      : {};
    byFingerprint.set(key, {
      ...existing,
      ...progressed,
      severity: candidate.severity === "high" || existing.severity === "high" ? "high" : existing.severity,
    });
  }
  return {
    schema_version: CANDIDATE_LEDGER_VERSION,
    candidates: [...byFingerprint.values()],
    suppressions,
    counts: countCandidates([...byFingerprint.values()]),
  };
}

export function countCandidates(candidates = []) {
  const counts = { review_pending: 0, suppressed: 0, accepted: 0, rejected: 0, held: 0, total: 0 };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const state = CANDIDATE_STATES.includes(String(candidate?.state)) ? String(candidate.state) : "review_pending";
    counts[state] += 1;
    counts.total += 1;
  }
  return counts;
}

export function addCandidate(ledger = {}, candidate = {}, options = {}) {
  const normalized = createCandidateLedger([...(ledger.candidates || []), candidate], options);
  return { ...normalized, suppressions: Array.isArray(ledger.suppressions) ? ledger.suppressions.slice(0, 200) : [] };
}

export function suppressCandidate(ledger = {}, candidateId, reason, source = "rule") {
  const id = textOf(candidateId);
  if (!(ledger.candidates || []).some(candidate => candidate.id === id)) return {
    ...createCandidateLedger(ledger.candidates || []),
    suppressions: Array.isArray(ledger.suppressions) ? ledger.suppressions.slice(0, 200) : [],
  };
  const candidates = (ledger.candidates || []).map(candidate => candidate.id === id ? { ...candidate, state: "suppressed" } : candidate);
  const entry = { candidate_id: id, reason: textOf(reason) || "suppressed", source: textOf(source) || "rule" };
  const suppressions = [...(ledger.suppressions || [])];
  if (!suppressions.some(item => item.candidate_id === entry.candidate_id && item.reason === entry.reason && item.source === entry.source)) suppressions.push(entry);
  const normalized = createCandidateLedger(candidates);
  return { ...normalized, suppressions: suppressions.slice(0, 200) };
}

export function mergeCandidateLedgers(...ledgers) {
  const candidates = ledgers.flatMap(ledger => Array.isArray(ledger?.candidates) ? ledger.candidates : []);
  const suppressions = ledgers.flatMap(ledger => Array.isArray(ledger?.suppressions) ? ledger.suppressions : []);
  const merged = createCandidateLedger(candidates);
  return { ...merged, suppressions, counts: countCandidates(merged.candidates) };
}

export function toLegacyFinding(candidate = {}) {
  const evidence = candidate.evidence || {};
  return {
    id: candidate.id,
    category: candidate.kind,
    severity: candidate.severity,
    state: candidate.state,
    review_pending: candidate.state === "review_pending",
    page: numberOf(evidence.target?.page),
    block_id: textOf(evidence.target?.block_id),
    quote: textOf(evidence.target?.quote),
    reference_page: numberOf(evidence.reference?.page),
    reference_block_id: textOf(evidence.reference?.block_id),
    reference_quote: textOf(evidence.reference?.quote),
    alignment_score: numberOf(evidence.alignment_score),
    evidence,
  };
}

export function serializeCandidateLedger(ledger = {}) {
  const normalized = createCandidateLedger(ledger.candidates || []);
  return {
    schema_version: CANDIDATE_LEDGER_VERSION,
    candidates: normalized.candidates,
    suppressions: Array.isArray(ledger.suppressions) ? ledger.suppressions.slice(0, 200) : [],
    counts: normalized.counts,
  };
}
