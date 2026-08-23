// Display-only confidence calibration. It never changes candidate decisions.
export const CALIBRATION_VERSION = "confidence-calibration-v1";

function asText(value) { return String(value ?? "").trim(); }
function asNumber(value, fallback = null) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
export function normalizeConfidence(value) {
  const number = asNumber(value);
  if (number === null) return null;
  const normalized = number > 1 && number <= 100 ? number / 100 : number;
  return Math.max(0, Math.min(1, normalized));
}
function outcomeOf(record = {}) {
  if (typeof record.is_correct === "boolean") return record.is_correct ? 1 : 0;
  if (typeof record.isCorrect === "boolean") return record.isCorrect ? 1 : 0;
  const raw = record.outcome ?? record.label ?? record.gold_label ?? record.goldLabel ?? record.correct;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const value = asText(raw).toLowerCase();
  if (["1", "true", "correct", "accepted", "tp", "pass", "yes"].includes(value)) return 1;
  if (["0", "false", "incorrect", "rejected", "fp", "fail", "no"].includes(value)) return 0;
  return null;
}
function groupValue(record, field) {
  const value = record?.[field];
  return asText(value) || "unknown";
}
export function calibrationBins(records = [], { binCount = 10 } = {}) {
  const count = Math.max(2, Math.min(20, Math.trunc(Number(binCount) || 10)));
  const bins = Array.from({ length: count }, (_, index) => ({
    index, lower: index / count, upper: (index + 1) / count, count: 0, labeled: 0,
    confidence_sum: 0, correct_sum: 0,
  }));
  for (const record of Array.isArray(records) ? records : []) {
    const confidence = normalizeConfidence(record?.confidence);
    if (confidence === null) continue;
    const index = Math.min(count - 1, Math.floor(confidence * count));
    const bin = bins[index];
    bin.count += 1;
    bin.confidence_sum += confidence;
    const outcome = outcomeOf(record);
    if (outcome !== null) { bin.labeled += 1; bin.correct_sum += outcome; }
  }
  return bins.map(bin => ({
    index: bin.index, lower: Number(bin.lower.toFixed(4)), upper: Number(bin.upper.toFixed(4)),
    count: bin.count, labeled: bin.labeled,
    mean_confidence: bin.count ? Number((bin.confidence_sum / bin.count).toFixed(4)) : null,
    empirical_precision: bin.labeled ? Number((bin.correct_sum / bin.labeled).toFixed(4)) : null,
    calibration_error: bin.labeled && bin.count ? Number(Math.abs(bin.confidence_sum / bin.count - bin.correct_sum / bin.labeled).toFixed(4)) : null,
  }));
}
function summarizeGroup(records, options) {
  const labeled = records.filter(record => outcomeOf(record) !== null);
  const confidences = labeled.map(record => normalizeConfidence(record.confidence)).filter(value => value !== null);
  const correct = labeled.map(outcomeOf);
  const precision = labeled.length ? correct.reduce((sum, value) => sum + value, 0) / labeled.length : null;
  const meanConfidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null;
  return {
    count: records.length, labeled: labeled.length,
    mean_confidence: meanConfidence === null ? null : Number(meanConfidence.toFixed(4)),
    empirical_precision: precision === null ? null : Number(precision.toFixed(4)),
    bins: calibrationBins(records, options),
  };
}
export function expectedCalibrationError(records = [], options = {}) {
  const bins = calibrationBins(records, options);
  const total = bins.reduce((sum, bin) => sum + bin.labeled, 0);
  if (!total) return null;
  return Number((bins.reduce((sum, bin) => sum + (bin.calibration_error || 0) * bin.labeled, 0) / total).toFixed(4));
}
export function buildCalibrationReport(records = [], options = {}) {
  const all = Array.isArray(records) ? records : [];
  const labeled = all.filter(record => outcomeOf(record) !== null);
  const confidenceRecords = labeled.map(record => ({ ...record, confidence: normalizeConfidence(record.confidence) })).filter(record => record.confidence !== null);
  const brier = confidenceRecords.length
    ? confidenceRecords.reduce((sum, record) => sum + (record.confidence - outcomeOf(record)) ** 2, 0) / confidenceRecords.length
    : null;
  const group = field => Object.fromEntries([...new Set(all.map(record => groupValue(record, field)))].sort().map(key => [key, summarizeGroup(all.filter(record => groupValue(record, field) === key), options)]));
  const holdout = all.filter(record => record?.holdout === true || record?.split === "holdout");
  const warnings = [];
  if (labeled.length < 20) warnings.push("sample_small");
  if (holdout.length && holdout.filter(record => outcomeOf(record) !== null).length < 10) warnings.push("holdout_small");
  return {
    schema_version: CALIBRATION_VERSION, sample_count: all.length, labeled_count: labeled.length,
    ece: expectedCalibrationError(all, options), brier_score: brier === null ? null : Number(brier.toFixed(4)),
    bins: calibrationBins(all, options), by_category: group("category"), by_prompt_version: group("prompt_version"),
    by_model_label: group("model_label"), by_independent_agreement: group("independent_agreement"),
    holdout: { count: holdout.length, labeled: holdout.filter(record => outcomeOf(record) !== null).length, ece: holdout.length ? expectedCalibrationError(holdout, options) : null },
    warnings,
  };
}