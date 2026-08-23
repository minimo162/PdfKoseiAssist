import assert from "node:assert/strict";
import { buildCalibrationReport, expectedCalibrationError } from "../docs/benchmarks/calibration.mjs";
import { summarizeReviewRuns, sampleSuppressedCandidates, detectOperationalDrift, buildEvaluationDashboard } from "../docs/benchmarks/evaluation-dashboard.mjs";

const records = [
  { id: "a", confidence: 0.9, outcome: "correct", category: "grammar", prompt_version: "v1", model_label: "A", independent_agreement: "agree", holdout: true },
  { id: "b", confidence: 0.8, outcome: "incorrect", category: "grammar", prompt_version: "v1", model_label: "A", independent_agreement: "conflict" },
  { id: "c", confidence: 0.4, outcome: "rejected", category: "translation", prompt_version: "v2", model_label: "B" },
  { id: "d", confidence: 0.6, outcome: "accepted", category: "translation", prompt_version: "v2", model_label: "B" },
];
const calibration = buildCalibrationReport(records, { binCount: 4 });
assert.equal(calibration.schema_version, "confidence-calibration-v1");
assert.equal(calibration.labeled_count, 4);
assert.ok(Number.isFinite(calibration.ece));
assert.equal(calibration.holdout.labeled, 1);
assert.ok(calibration.by_category.grammar);
assert.equal(expectedCalibrationError([], { binCount: 4 }), null);

const runs = [
  { id: "run-1", semantic_calls: 5, retries: 2, elapsed_ms: 1200, packets: [{ packet_id: "p1", status: "done" }], findings: [{ decision_state: "needs_review", independent_agreement: true }], candidates: [{ state: "suppressed" }] },
  { id: "run-2", semantic_calls: 2, retries: 0, elapsed_ms: 800, packets: [{ packet_id: "p2", status: "warning" }], findings: [{ decision_state: "accepted", independent_agreement: false }], candidates: [{ state: "review_pending" }] },
  { id: "run-3", semantic_calls: 3, retries: 1, elapsed_ms: 1000, packets: [{ packet_id: "p3", status: "done" }], findings: [], candidates: [] },
];
const summary = summarizeReviewRuns(runs, { semanticCallBudget: 4, holdoutIds: ["run-2"] });
assert.equal(summary.semantic_calls, 10);
assert.equal(summary.transport_retries, 3);
assert.equal(summary.suppressed_candidates, 1);
assert.deepEqual(summary.over_budget_runs, ["run-1"]);
assert.equal(summary.holdout_runs, 1);
assert.deepEqual(summary.holdout_run_ids, ["run-2"]);
assert.equal(summary.suppression_sample.length, 1);
assert.equal(sampleSuppressedCandidates([{ id: "a", state: "suppressed" }, { id: "b", state: "review_pending" }], { sampleSize: 1, seed: "test" }).length, 1);
const drift = detectOperationalDrift({ ...summary, runs: 3 }, { ...summary, runs: 3, review_burden: 0 });
assert.ok(drift.comparable);
assert.ok(drift.warnings.includes("review_burden_drift"));
const dashboard = buildEvaluationDashboard({ runs, calibration, semanticCallBudget: 4 });
assert.equal(dashboard.schema_version, "evaluation-dashboard-v1");
assert.equal(dashboard.calibration.schema_version, "confidence-calibration-v1");
console.log("Test-CalibrationDashboard: PASS");