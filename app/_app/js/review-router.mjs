// Conditional specialist routing for structural and translation candidates.
// The router only adds review passes when local evidence justifies them; it
// never turns a structural heuristic into an automatically accepted finding.

const MAX_CANDIDATE_PASSES = 2;

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
    passes: passes.slice(0, cap).map((pass, index) => ({
      ...pass,
      pass_index: index,
      chat_mode: pass.chatMode,
      specialist: true,
    })),
    skipped,
    warnings,
    specialist_triggered: candidatePasses.length > 0 || requiresIndependentReview(localCandidates) || requiresAdjudication(localCandidates),
  };
}
