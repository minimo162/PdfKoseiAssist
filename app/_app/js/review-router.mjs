// Conditional specialist routing for structural and translation candidates.
// The router only adds review passes when local evidence justifies them; it
// never turns a structural heuristic into an automatically accepted finding.

const MAX_CANDIDATE_PASSES = 2;

function candidateList(localCandidates = {}) {
  if (Array.isArray(localCandidates)) return localCandidates;
  if (Array.isArray(localCandidates.candidates)) return localCandidates.candidates;
  if (Array.isArray(localCandidates.ledger?.candidates)) return localCandidates.ledger.candidates;
  return [];
}

function candidateFlags(localCandidates = {}) {
  const candidates = candidateList(localCandidates);
  return {
    hasAlignmentGap: candidates.some(candidate => ["translation_omission", "alignment_gap"].includes(String(candidate?.kind)) && String(candidate?.state || "review_pending") === "review_pending"),
    hasListCountMismatch: candidates.some(candidate => String(candidate?.kind) === "translation_omission" && /list|項目/i.test(JSON.stringify(candidate))),
    hasUnmatchedFootnote: candidates.some(candidate =>
      String(candidate?.kind).toLowerCase().includes("footnote")
      || String(candidate?.evidence?.structural_role || "").toLowerCase() === "footnote"
      || String(candidate?.evidence?.reference?.block_id || "").toLowerCase().includes("footnote")
    ),
    hasHighSeverity: candidates.some(candidate => String(candidate?.severity).toLowerCase() === "high"),
    hasConflictingEvidence: candidates.some(candidate => ["1:n", "n:1"].includes(String(candidate?.evidence?.relation || candidate?.relation))),
  };
}

function asBool(value) {
  return value === true || value === 1 || value === "1";
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function requiresIndependentReview(localCandidates = {}) {
  return asBool(localCandidates.requiresIndependentReview)
    || asBool(localCandidates.highSeverity)
    || asBool(localCandidates.hasHighSeverity)
    || asBool(localCandidates.high_severity)
    || asBool(localCandidates.has_high_severity);
}

export function requiresAdjudication(localCandidates = {}) {
  return asBool(localCandidates.requiresAdjudication)
    || asBool(localCandidates.ambiguousAlignment)
    || asBool(localCandidates.hasConflictingEvidence)
    || asBool(localCandidates.ambiguous_alignment)
    || asBool(localCandidates.has_conflicting_evidence);
}

export function buildReviewPlan(
  packet = {},
  layout = {},
  localCandidates = {},
  budget = 4,
) {
  const warnings = [];
  const skipped = [];
  const candidatePasses = [];
  const hasRef = asBool(packet.hasRef ?? packet.has_ref);
  const proseRatio = asNumber(layout.proseRatio ?? layout.prose_ratio, 0);
  const candidateItems = candidateList(localCandidates);
  const candidateSource = Array.isArray(localCandidates) ? {} : localCandidates;
  const ledgerFlags = candidateFlags(localCandidates);
  localCandidates = { ...candidateSource, candidates: candidateItems, ...ledgerFlags,
    hasAlignmentGap: asBool(localCandidates.hasAlignmentGap ?? localCandidates.has_alignment_gap) || ledgerFlags.hasAlignmentGap,
    hasListCountMismatch: asBool(localCandidates.hasListCountMismatch ?? localCandidates.has_list_count_mismatch) || ledgerFlags.hasListCountMismatch,
    hasUnmatchedFootnote: asBool(localCandidates.hasUnmatchedFootnote ?? localCandidates.has_unmatched_footnote) || ledgerFlags.hasUnmatchedFootnote,
    hasHighSeverity: asBool(localCandidates.hasHighSeverity ?? localCandidates.high_severity) || ledgerFlags.hasHighSeverity,
    hasConflictingEvidence: asBool(localCandidates.hasConflictingEvidence ?? localCandidates.has_conflicting_evidence) || ledgerFlags.hasConflictingEvidence
  };

  if (proseRatio >= 0.45) {
    candidatePasses.push({ id: "grammar_prose", chatMode: "New", independent: false });
  }

  const hasTranslationGap = hasRef && (
    asBool(localCandidates.hasAlignmentGap ?? localCandidates.has_alignment_gap)
    || asBool(localCandidates.hasListCountMismatch ?? localCandidates.has_list_count_mismatch)
    || asBool(localCandidates.hasUnmatchedFootnote ?? localCandidates.has_unmatched_footnote)
  );
  if (hasTranslationGap) {
    candidatePasses.push({
      id: "translation_omission",
      chatMode: candidatePasses.length ? "Reuse" : "New",
      independent: false,
    });
  }

  const hasStructure = asBool(layout.hasTable ?? layout.has_table)
    || asBool(layout.hasList ?? layout.has_list)
    || asBool(layout.hasFootnote ?? layout.has_footnote);
  if (hasStructure && !candidatePasses.some(pass => pass.id === "translation_omission")) {
    candidatePasses.push({
      id: "structure_layout",
      chatMode: candidatePasses.length ? "Reuse" : "New",
      independent: false,
    });
  }

  if (candidatePasses.length > MAX_CANDIDATE_PASSES) {
    for (const pass of candidatePasses.slice(MAX_CANDIDATE_PASSES)) {
      skipped.push({ id: pass.id, reason: "candidate-pass-cap" });
    }
    candidatePasses.splice(MAX_CANDIDATE_PASSES);
    warnings.push("専門候補パスは最大2件に制限しました。");
  }

  const requestedBudget = Math.trunc(asNumber(budget, 4));
  const cap = requestedBudget > 0 ? requestedBudget : 4;
  const passes = candidatePasses.slice();
  if (requiresIndependentReview(localCandidates)) {
    passes.push({ id: "independent_review", chatMode: "New", independent: true });
  }
  if (requiresAdjudication(localCandidates)) {
    passes.push({ id: "adjudication", chatMode: "New", independent: true });
  }
  if (passes.length > cap) {
    for (const pass of passes.slice(cap)) skipped.push({ id: pass.id, reason: "budget-exceeded" });
  }

  return {
    schema_version: "review-plan-v1",
    passes: passes.slice(0, cap).map((pass, index) => ({
      ...pass,
      pass_index: index,
      chat_mode: pass.chatMode,
      specialist: true,
    })),
    candidate_ids: candidateList(localCandidates).filter(candidate => String(candidate?.state || "review_pending") === "review_pending").map(candidate => String(candidate.id || "")).filter(Boolean).slice(0, 200),
    candidate_kinds: [...new Set(candidateList(localCandidates).map(candidate => String(candidate?.kind || "")).filter(Boolean))],
    skipped,
    warnings,
    specialist_triggered: candidatePasses.length > 0 || requiresIndependentReview(localCandidates) || requiresAdjudication(localCandidates),
  };
}
