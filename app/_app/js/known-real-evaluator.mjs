export const KNOWN_REAL_EVALUATOR_VERSION = "known-real-evaluator-v1";

function textOf(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return textOf(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function explicitCaseId(finding = {}) {
  return textOf(
    finding.known_case_id
    ?? finding.knownCaseId
    ?? finding.case_id
    ?? finding.caseId
    ?? finding.fixture_id
    ?? finding.fixtureId,
  );
}

function findingHaystack(finding = {}) {
  const fields = [
    finding.quote,
    finding.issue_summary,
    finding.reason,
    finding.suggestion,
    finding.target_evidence?.quote,
    finding.reference_evidence?.quote,
    ...(Array.isArray(finding.reference_evidence) ? finding.reference_evidence.map(item => item?.quote) : []),
  ];
  return normalized(fields.filter(Boolean).join(" "));
}

function decisionOf(finding = {}) {
  const raw = textOf(
    finding.decision_state
    ?? finding.decisionState
    ?? finding.decision?.state
    ?? finding.review_state
    ?? finding.reviewState
    ?? finding.state,
  ).toLowerCase();
  if (["accepted", "adopted"].includes(raw)) return "accepted";
  if (["needs_review", "needs-review", "review_pending", "review-pending", "pending", "undecided", ""].includes(raw)) return "needs_review";
  if (["held", "rejected"].includes(raw)) return raw;
  return "unknown";
}

function hasHighlightGeometry(finding = {}) {
  const boxes = finding.highlight_boxes ?? finding.highlightBoxes;
  const candidates = finding.highlight_candidates ?? finding.highlightCandidates;
  return (Array.isArray(boxes) && boxes.length > 0)
    || (Array.isArray(candidates) && candidates.length > 0);
}

function highlightOf(finding = {}) {
  const status = textOf(finding.highlight_status ?? finding.highlightStatus).toLowerCase();
  return status === "ok" && hasHighlightGeometry(finding);
}

function matchingFindings(caseItem, findings) {
  const caseId = textOf(caseItem.id);
  const caseText = normalized(caseItem.text);
  return findings.filter(finding => {
    const explicit = explicitCaseId(finding);
    if (explicit) return explicit === caseId;
    if (!caseText) return false;
    return findingHaystack(finding).includes(caseText);
  });
}

/**
 * Evaluate the six known cases without manufacturing a pass from fixture
 * metadata alone. observedRun=true means the caller supplied a real run
 * result (including a zero-finding result); otherwise the result is explicitly
 * unmeasured.
 */
export function evaluateKnownRealCases({
  cases = [],
  findings = [],
  observedRun = false,
} = {}) {
  const caseList = Array.isArray(cases) ? cases : [];
  const findingList = Array.isArray(findings) ? findings : [];
  const measured = observedRun === true;
  const results = caseList.map(caseItem => {
    const matches = matchingFindings(caseItem, findingList);
    const detected = matches.length > 0;
    const reviewed = matches.some(finding => ["accepted", "needs_review"].includes(decisionOf(finding)));
    const highlighted = matches.some(highlightOf);
    return {
      id: textOf(caseItem.id),
      status: textOf(caseItem.status),
      expected: textOf(caseItem.expected),
      detected,
      reviewed,
      highlighted,
      matched_finding_ids: matches.map(finding => textOf(finding.id || finding.finding_id)).filter(Boolean),
      decisions: matches.map(decisionOf),
    };
  });
  const confirmed = results.filter(item => item.status === "confirmed");
  const provisional = results.filter(item => item.status === "provisional");
  const gates = {
    confirmed_detection: measured && confirmed.every(item => item.detected),
    confirmed_highlight: measured && confirmed.every(item => item.highlighted),
    provisional_review: measured && provisional.every(item => item.reviewed),
  };
  const allPass = Object.values(gates).every(Boolean);
  return {
    evaluator_version: KNOWN_REAL_EVALUATOR_VERSION,
    measured,
    status: measured ? (allPass ? "pass" : "fail") : "unmeasured",
    cases: results,
    summary: {
      total: results.length,
      confirmed_total: confirmed.length,
      provisional_total: provisional.length,
      confirmed_detected: confirmed.filter(item => item.detected).length,
      confirmed_highlighted: confirmed.filter(item => item.highlighted).length,
      provisional_reviewed: provisional.filter(item => item.reviewed).length,
    },
    gates,
  };
}
