// Operational review metrics are observational only. They do not auto-accept findings.
export const EVALUATION_DASHBOARD_VERSION = "evaluation-dashboard-v1";
function asNumber(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function asText(value) { return String(value ?? "").trim(); }
function list(value) { return Array.isArray(value) ? value : []; }
function terminal(packet) { return ["done", "warning"].includes(asText(packet?.status)); }
function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// Keep a deterministic, bounded sample of suppressed candidates for FN audits.
// The sample is observational and must never change candidate visibility.
export function sampleSuppressedCandidates(candidates = [], { sampleSize = 20, seed = "suppression-v1" } = {}) {
  const limit = Math.max(0, Math.min(200, Math.trunc(Number(sampleSize) || 0)));
  return list(candidates)
    .filter(candidate => asText(candidate?.state) === "suppressed" || candidate?.suppressed === true)
    .map((candidate, index) => ({ candidate, rank: stableHash(`${seed}|${candidate?.id ?? candidate?.fingerprint ?? index}`) }))
    .sort((left, right) => left.rank - right.rank || asText(left.candidate?.id).localeCompare(asText(right.candidate?.id)))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function summarizeReviewRuns(runs = [], { holdoutIds = [], semanticCallBudget = 4, suppressionSampleSize = 20, suppressionSampleSeed = "suppression-v1" } = {}) {
  const items = list(runs);
  const holdouts = new Set(list(holdoutIds).map(String));
  const packets = items.flatMap(run => list(run?.packets ?? run?.per_packet));
  const findings = items.flatMap(run => list(run?.findings));
  const candidates = items.flatMap(run => list(run?.candidates ?? run?.candidate_ledger?.candidates));
  const suppressionRecords = items.flatMap(run => list(run?.suppressions ?? run?.candidate_ledger?.suppressions));
  const suppressionPool = [
    ...candidates,
    ...suppressionRecords.map(record => ({ ...record, state: "suppressed" })),
  ];
  const calls = items.reduce((sum, run) => sum + asNumber(run?.semantic_calls ?? run?.copilot_calls ?? run?.copilot_call_count), 0);
  const retries = items.reduce((sum, run) => sum + asNumber(run?.transport_retries ?? run?.retries), 0);
  const latency = items.map(run => asNumber(run?.elapsed_ms ?? run?.latency_ms, null)).filter(Number.isFinite);
  const reviewStates = findings.filter(finding => ["needs_review", "held", "undecided"].includes(asText(finding?.decision_state ?? finding?.decision)));
  const suppressed = candidates.filter(candidate => asText(candidate?.state) === "suppressed");
  const independent = findings.filter(finding => finding?.independent_agreement === true || asText(finding?.independent_agreement).toLowerCase() === "true");
  const budget = Math.max(1, asNumber(semanticCallBudget, 4));
  const overBudget = items.filter(run => asNumber(run?.semantic_calls ?? run?.copilot_calls ?? run?.copilot_call_count) > budget).map(run => asText(run?.id || run?.job_id));
  const holdoutRuns = items.filter(run => run?.holdout === true || holdouts.has(asText(run?.id || run?.run_id || run?.job_id)));
  const holdoutRunIds = holdoutRuns.map(run => asText(run?.id || run?.run_id || run?.job_id)).filter(Boolean).sort();
  const terminalPackets = packets.filter(terminal).length;
  return {
    schema_version: EVALUATION_DASHBOARD_VERSION, runs: items.length, packets: packets.length, terminal_packets: terminalPackets,
    packet_completion: packets.length ? Number((terminalPackets / packets.length).toFixed(4)) : null,
    findings: findings.length, review_burden: reviewStates.length,
    candidate_count: candidates.length, suppressed_candidates: suppressed.length,
    suppression_rate: candidates.length ? Number((suppressed.length / candidates.length).toFixed(4)) : null,
    suppression_records: suppressionRecords.length,
    suppression_sample: sampleSuppressedCandidates(suppressionPool, { sampleSize: suppressionSampleSize, seed: suppressionSampleSeed }),
    semantic_calls: calls, transport_retries: retries,
    mean_latency_ms: latency.length ? Math.round(latency.reduce((sum, value) => sum + value, 0) / latency.length) : null,
    independent_agreement_rate: findings.length ? Number((independent.length / findings.length).toFixed(4)) : null,
    semantic_call_budget: budget, over_budget_runs: overBudget,
    holdout_runs: holdoutRuns.length, holdout_run_ids: holdoutRunIds,
    warnings: overBudget.length ? ["semantic_call_budget_exceeded"] : [],
  };
}
export function detectOperationalDrift(current = {}, baseline = {}, { minRuns = 3, relativeThreshold = 0.2 } = {}) {
  if (asNumber(current.runs) < minRuns || asNumber(baseline.runs) < minRuns) return { comparable: false, warnings: ["insufficient_runs"] };
  const warnings = [];
  for (const field of ["packet_completion", "independent_agreement_rate", "suppression_rate"]) {
    const now = asNumber(current[field], null); const before = asNumber(baseline[field], null);
    if (now === null || before === null || before === 0) continue;
    if (Math.abs(now - before) / Math.abs(before) >= relativeThreshold) warnings.push(`${field}_drift`);
  }
  if (asNumber(current.review_burden) > asNumber(baseline.review_burden) * (1 + relativeThreshold)) warnings.push("review_burden_drift");
  if (asNumber(current.mean_latency_ms) > asNumber(baseline.mean_latency_ms) * (1 + relativeThreshold)) warnings.push("latency_drift");
  return { comparable: true, warnings: [...new Set(warnings)] };
}
export function buildEvaluationDashboard({ runs = [], baseline = null, calibration = null, holdoutIds = [], semanticCallBudget = 4, suppressionSampleSize = 20, suppressionSampleSeed = "suppression-v1" } = {}) {
  const summary = summarizeReviewRuns(runs, { holdoutIds, semanticCallBudget, suppressionSampleSize, suppressionSampleSeed });
  const baselineSummary = baseline?.summary || baseline;
  const drift = baseline ? detectOperationalDrift(summary, baselineSummary) : { comparable: false, warnings: [] };
  return { schema_version: EVALUATION_DASHBOARD_VERSION, summary, drift, calibration: calibration || null };
}