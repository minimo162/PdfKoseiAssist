import {
  REVIEW_DECISION_STATES,
  buildReviewOverview,
  decisionLabel,
  normalizeDecisionState,
  normalizeFindingDecision,
  normalizePacketVerificationState,
  packetVerificationLabel,
} from "../js/audit-contract.mjs";

let failures = 0;
function t(name, condition, detail = "") {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`PASS: ${name}`);
  }
}

t("decision states include all four user outcomes", REVIEW_DECISION_STATES.includes("accepted")
  && REVIEW_DECISION_STATES.includes("needs_review")
  && REVIEW_DECISION_STATES.includes("held")
  && REVIEW_DECISION_STATES.includes("rejected"));
t("unknown decision is undecided", normalizeDecisionState("unexpected") === "undecided");
t("decision labels are user facing", decisionLabel("accepted") === "採用" && decisionLabel("held") === "保留");
t("complete packet is page_complete", normalizePacketVerificationState({ packet_id: "P1", status: "done", coverage: 1 }) === "page_complete");
t("read_error packet is needs_review", normalizePacketVerificationState({ packet_id: "P1", status: "done", coverage: 0, warning: "read_error" }) === "needs_review");
t("repaired packet is needs_review", normalizePacketVerificationState({ packet_id: "P1", status: "done", coverage: 1, repaired: true }) === "needs_review");
t("partial packet is incomplete", normalizePacketVerificationState({ packet_id: "P1", status: "warning", coverage: 0.6 }) === "incomplete");
t("packet label exposes state name", packetVerificationLabel({ packet_id: "P1", status: "warning", coverage: 0.6 }) === "確認範囲不足");
t("finding decision can be restored from map", normalizeFindingDecision({ id: "F1" }, new Map([["F1", "rejected"]])) === "rejected");

const overview = buildReviewOverview({
  totalPages: 10,
  packets: [
    { packet_id: "P1", status: "done", target_pages: [1, 2, 3, 4, 5], pages_checked: [1, 2, 3, 4, 5], coverage: 1 },
    { packet_id: "P2", status: "warning", target_pages: [6, 7, 8, 9, 10], pages_checked: [6, 7], coverage: 0.4 },
  ],
  findings: [
    { id: "F1", confidence: 0.9, decision_state: "accepted" },
    { id: "F2", confidence: 0.7, decision_state: "needs_review" },
  ],
});
t("overview keeps page and packet progress separate", overview.checkedPageCount === 7
  && overview.targetPageCount === 10
  && overview.packetsDone === 2
  && overview.packetsWarning === 1
  && overview.overallState === "needs_review");
t("overview keeps decision counts", overview.decisionCounts.accepted === 1
  && overview.decisionCounts.needs_review === 1);

if (failures) {
  console.error(`Test-AuditContract: FAIL (${failures})`);
  process.exit(1);
}
console.log("Test-AuditContract: PASS");

