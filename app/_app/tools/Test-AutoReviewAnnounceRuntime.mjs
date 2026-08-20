// Execute the actual announceAutoReviewState function extracted from
// index.html with the smallest possible browser/runtime surface.  This catches
// lexical/runtime regressions that syntax checks and the pure state helper do
// not see (notably an undefined `mode` in the function body).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoReviewAnnouncementState, reviewCompletionEligibility } from "../js/auto-review-state.mjs";

const here = join(fileURLToPath(new URL(".", import.meta.url)));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const start = html.indexOf("    function announceAutoReviewState(st) {");
const end = html.indexOf("    function escapeHtmlAuto(text) {", start);
if (start < 0 || end < 0) throw new Error("announceAutoReviewState source not found");
const announceSource = html.slice(start, end).trim();

const factory = new Function("autoReviewAnnouncementState", `
  let fullRunPhase = "standalone";
  let fullRunConsistencyRound = { current: 0, total: 0 };
  let lastAutoAnnouncementKey = "";
  let terminal = { announceCompletion: true, announceContinuation: false, continuationMessage: "" };
  const autoImportedPackets = new Set(["P1"]);
  const autoImportErrors = new Map();
  let autoImportingPacketId = "";
  const els = { autoReviewAnnouncer: { textContent: "" } };
  function autoReviewTerminalBehavior() { return terminal; }
  function autoReviewWarningUiSummary() { return { message: "要確認の理由があります。" }; }
  ${announceSource}
  return {
    announceAutoReviewState,
    els,
    autoImportErrors,
    setActive(value) { autoImportingPacketId = String(value || ""); },
    setTerminal(value) { terminal = { ...value }; },
    setPhase(value, current, total) {
      fullRunPhase = String(value || "");
      fullRunConsistencyRound = { current: Number(current || 0), total: Number(total || 0) };
    },
    resetAnnouncement() { lastAutoAnnouncementKey = ""; },
  };
`);
const runtime = factory(autoReviewAnnouncementState);
const packetState = {
  id: "runtime-job",
  mode: "done",
  packets_done: 1,
  packets_total: 1,
  per_packet: [{ packet_id: "P1", status: "done" }],
};
let failures = 0;
const t = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
};

runtime.autoImportErrors.set("P1", "local quote validation failed");
runtime.announceAutoReviewState(packetState);
t("実際のannounce関数が取込エラーを告知する", runtime.els.autoReviewAnnouncer.textContent.includes("取り込みに失敗しました"));

runtime.autoImportErrors.delete("P1");
runtime.setActive("P1");
runtime.announceAutoReviewState(packetState);
t("実際のannounce関数が再取込中を告知する", runtime.els.autoReviewAnnouncer.textContent.includes("検証・取り込み中"));

runtime.setActive("");
runtime.announceAutoReviewState(packetState);
t("実際のannounce関数が再取込成功後に完了を告知する", runtime.els.autoReviewAnnouncer.textContent.includes("校正が完了しました"));

const intermediateWarningState = {
  id: "runtime-intermediate-warning",
  mode: "done",
  packets_done: 1,
  packets_total: 1,
  per_packet: [{ packet_id: "P1", status: "warning", warning: "確認範囲が不足しています" }],
};
runtime.setPhase("full-consistency", 1, 2);
runtime.setTerminal({
  announceCompletion: false,
  announceContinuation: true,
  continuationMessage: "文書全体の確認を続けています。レビューはまだ終わっていません。",
});
runtime.resetAnnouncement();
runtime.announceAutoReviewState(intermediateWarningState);
t("中間warningは終了ではなくレビュー継続をARIA告知する",
  runtime.els.autoReviewAnnouncer.textContent.includes("レビューはまだ終わっていません")
  && !runtime.els.autoReviewAnnouncer.textContent.includes("要確認の状態で終了しました"));

runtime.setPhase("full-consistency", 2, 2);
runtime.setTerminal({ announceCompletion: true, announceContinuation: false, continuationMessage: "" });
runtime.resetAnnouncement();
runtime.announceAutoReviewState(intermediateWarningState);
t("最終warningだけは要確認の終了をARIA告知する",
  runtime.els.autoReviewAnnouncer.textContent.includes("要確認の状態で終了しました"));

// Execute the real completion-banner function too.  This checks that a
// warning cannot bypass reviewCompletionEligibility during an intermediate
// full-review round, while the final warning remains visible and actionable.
const phaseStart = html.indexOf("    const AUTO_REVIEW_PHASES =");
const phaseEnd = html.indexOf("    function autoReviewSkippedRoundDecision", phaseStart);
const bannerStart = html.indexOf("    function renderReviewCompletionBanner(st = lastAutoJobState) {");
const bannerEnd = html.indexOf("    function renderFindings()", bannerStart);
if (phaseStart < 0 || phaseEnd < 0 || bannerStart < 0 || bannerEnd < 0) throw new Error("completion banner source not found");
const phaseSource = html.slice(phaseStart, phaseEnd).trim();
const bannerSource = html.slice(bannerStart, bannerEnd).trim();
const bannerFactory = new Function("reviewCompletionEligibility", `
  let fullRunPhase = "full-consistency";
  let fullRunConsistencyRound = { current: 1, total: 2 };
  let lastAutoCompletionAt = 0;
  let lastAutoJobState = null;
  let autoImportingPacketId = "";
  const autoImportedPackets = new Set(["P1"]);
  const autoImportErrors = new Map();
  const findings = [];
  const originalFileName = "target.pdf";
  const node = () => ({
    hidden: true,
    className: "",
    textContent: "",
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
  });
  const els = {
    reviewCompletionBanner: node(),
    reviewCompletionHeading: node(),
    reviewCompletionDetails: node(),
  };
  function pendingAutoImportPacketId() { return ""; }
  function autoImportErrorPacketId() { return ""; }
  function autoReviewWarningUiSummary() {
    return {
      findingsCount: 1,
      progressText: "依頼 1/1件",
      countsText: "指摘 1件 / 確認 1ページ",
      impactText: "P.1",
      reasonText: "確認範囲が不足",
      caution: "",
      nextAction: "要確認パケットをリトライ",
    };
  }
  function resetReviewCompletionBanner() {
    lastAutoCompletionAt = 0;
    els.reviewCompletionBanner.hidden = true;
    els.reviewCompletionBanner.setAttribute("aria-hidden", "true");
    els.reviewCompletionBanner.className = "review-completion-banner";
    els.reviewCompletionDetails.textContent = "";
  }
  ${phaseSource}
  ${bannerSource}
  return {
    els,
    renderReviewCompletionBanner,
    setRound(current, total) { fullRunConsistencyRound = { current, total }; },
    setPhase(value) { fullRunPhase = String(value || ""); },
  };
`);
const bannerRuntime = bannerFactory(reviewCompletionEligibility);
bannerRuntime.renderReviewCompletionBanner(intermediateWarningState);
t("中間warningは完了bannerを表示しない", bannerRuntime.els.reviewCompletionBanner.hidden
  && bannerRuntime.els.reviewCompletionBanner.attrs["aria-hidden"] === "true"
  && !bannerRuntime.els.reviewCompletionHeading.textContent.includes("終了しました"));
bannerRuntime.setRound(2, 2);
bannerRuntime.setPhase("full-pages");
bannerRuntime.renderReviewCompletionBanner(intermediateWarningState);
t("最終warningは完了bannerと要確認見出しを表示する", !bannerRuntime.els.reviewCompletionBanner.hidden
  && bannerRuntime.els.reviewCompletionBanner.className.includes("warning")
  && bannerRuntime.els.reviewCompletionHeading.textContent.includes("要確認で終了しました")
  && bannerRuntime.els.reviewCompletionDetails.textContent.includes("確認範囲が不足"));

if (failures) {
  console.error(`\nTest-AutoReviewAnnounceRuntime: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-AutoReviewAnnounceRuntime: PASS");
