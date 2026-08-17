// Execute the actual announceAutoReviewState function extracted from
// index.html with the smallest possible browser/runtime surface.  This catches
// lexical/runtime regressions that syntax checks and the pure state helper do
// not see (notably an undefined `mode` in the function body).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoReviewAnnouncementState } from "../js/auto-review-state.mjs";

const here = join(fileURLToPath(new URL(".", import.meta.url)));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const start = html.indexOf("    function announceAutoReviewState(st) {");
const end = html.indexOf("    function escapeHtmlAuto(text) {", start);
if (start < 0 || end < 0) throw new Error("announceAutoReviewState source not found");
const announceSource = html.slice(start, end).trim();

const terminal = { announceCompletion: true, announceContinuation: false, continuationMessage: "" };
const factory = new Function("autoReviewAnnouncementState", `
  let fullRunPhase = "standalone";
  let fullRunConsistencyRound = { current: 0, total: 0 };
  let lastAutoAnnouncementKey = "";
  const autoImportedPackets = new Set(["P1"]);
  const autoImportErrors = new Map();
  let autoImportingPacketId = "";
  const els = { autoReviewAnnouncer: { textContent: "" } };
  function autoReviewTerminalBehavior() { return ${JSON.stringify(terminal)}; }
  ${announceSource}
  return {
    announceAutoReviewState,
    els,
    autoImportErrors,
    setActive(value) { autoImportingPacketId = String(value || ""); },
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

if (failures) {
  console.error(`\nTest-AutoReviewAnnounceRuntime: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-AutoReviewAnnounceRuntime: PASS");

