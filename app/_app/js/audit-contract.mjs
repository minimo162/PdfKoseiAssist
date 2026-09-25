// Shared client-side contracts for the review dashboard and audit-aware UI.
// Keep these helpers pure so the browser, fixtures, and Node tests agree on
// the meaning of terminal packet states and user decisions.

export const REVIEW_DECISION_STATES = Object.freeze([
  "undecided",
  "accepted",
  "needs_review",
  "held",
  "rejected",
]);

export const REVIEW_DECISION_LABELS = Object.freeze({
  undecided: "未判定",
  accepted: "採用",
  needs_review: "要確認",
  held: "保留",
  rejected: "棄却",
});

export const REVIEW_DECISION_SHORTCUTS = Object.freeze({
  a: "accepted",
  v: "needs_review",
  h: "held",
  x: "rejected",
});

export const PACKET_VERIFICATION_STATES = Object.freeze([
  "invalid",
  "incomplete",
  "needs_review",
  "page_complete",
]);

export const PACKET_VERIFICATION_LABELS = Object.freeze({
  invalid: "回答不完全",
  incomplete: "確認範囲不足",
  needs_review: "一部未完了",
  page_complete: "ページ確認完了",
});

function asText(value) {
  return String(value ?? "");
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasNonEmpty(value) {
  return asText(value).trim().length > 0;
}

export function normalizeDecisionState(value) {
  const state = asText(value).trim().toLowerCase();
  return REVIEW_DECISION_STATES.includes(state) ? state : "undecided";
}

export function decisionLabel(value) {
  return REVIEW_DECISION_LABELS[normalizeDecisionState(value)];
}

export function normalizePacketVerificationState(packet = {}) {
  const explicit = asText(packet.verification_state || packet.verificationState).trim().toLowerCase();
  if (PACKET_VERIFICATION_STATES.includes(explicit)) return explicit;
  const coverage = asNumber(packet.coverage, 0);
  const hasReadError = hasNonEmpty(packet.read_error) || /read[_ -]?error|読み取れない|読めません/i.test(
    [packet.warning, packet.error, packet.detail, packet.completed_by].map(asText).join(" "),
  );
  const hasRepair = packet.repaired === true || packet.repaired === 1
    || hasNonEmpty(packet.parse_fixes) || /repair|修復|truncated|切断/i.test(
      [packet.warning, packet.error, packet.detail, packet.completed_by].map(asText).join(" "),
    );
  const status = asText(packet.status).toLowerCase();
  if (status === "error" || status === "invalid" || !hasNonEmpty(packet.packet_id)) return "invalid";
  if (hasReadError || hasRepair) return "needs_review";
  if (coverage < 1) return "incomplete";
  return "page_complete";
}

export function packetVerificationLabel(packetOrState) {
  const state = typeof packetOrState === "string"
    ? packetOrState
    : normalizePacketVerificationState(packetOrState);
  return PACKET_VERIFICATION_LABELS[state] || PACKET_VERIFICATION_LABELS.invalid;
}

export function normalizeFindingDecision(finding = {}, decisions = null) {
  const id = asText(finding.id || finding.finding_id);
  const fromMap = decisions && typeof decisions.get === "function" ? decisions.get(id) : null;
  const fromObject = decisions && typeof decisions === "object" && !Array.isArray(decisions) ? decisions[id] : null;
  return normalizeDecisionState(finding.decision_state || finding.decisionState || fromMap || fromObject);
}

export function buildReviewOverview({
  packets = [],
  findings = [],
  totalPages = 0,
  decisions = null,
} = {}) {
  const packetList = Array.isArray(packets) ? packets : [];
  const findingList = Array.isArray(findings) ? findings : [];
  const targetPages = new Set();
  const checkedPages = new Set();
  for (const packet of packetList) {
    for (const page of Array.isArray(packet?.target_pages) ? packet.target_pages : []) {
      const number = Number(page);
      if (Number.isInteger(number) && number > 0) targetPages.add(number);
    }
    for (const page of Array.isArray(packet?.pages_checked) ? packet.pages_checked : []) {
      const number = Number(page);
      if (Number.isInteger(number) && number > 0) checkedPages.add(number);
    }
  }
  const expectedPageCount = targetPages.size || Math.max(0, Math.trunc(asNumber(totalPages, 0)));
  const coverage = expectedPageCount ? Math.min(1, checkedPages.size / expectedPageCount) : 0;
  const terminalPackets = packetList.filter(packet => ["done", "warning"].includes(asText(packet?.status)));
  const warningPackets = packetList.filter(packet => ["warning", "error"].includes(asText(packet?.status)));
  const decisionCounts = Object.fromEntries(REVIEW_DECISION_STATES.map(state => [state, 0]));
  for (const finding of findingList) decisionCounts[normalizeFindingDecision(finding, decisions)] += 1;
  const confidences = findingList.map(finding => asNumber(finding.confidence, NaN)).filter(Number.isFinite);
  const confidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : null;
  const overallState = warningPackets.length
    ? "needs_review"
    : terminalPackets.length === packetList.length && packetList.length > 0 && coverage >= 1
      ? "page_complete"
      : packetList.some(packet => asText(packet?.status) === "running")
        ? "incomplete"
        : "invalid";
  return {
    overallState,
    targetPageCount: expectedPageCount,
    checkedPageCount: checkedPages.size,
    coverage,
    packetsTotal: packetList.length,
    packetsDone: terminalPackets.length,
    packetsWarning: warningPackets.length,
    findingCount: findingList.length,
    confidence,
    decisionCounts,
    targetPages: [...targetPages].sort((a, b) => a - b),
    checkedPages: [...checkedPages].sort((a, b) => a - b),
  };
}

