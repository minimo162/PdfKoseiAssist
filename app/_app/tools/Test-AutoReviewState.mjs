// Executable live-region state transitions for server-terminal/local-import
// races.  This intentionally avoids a browser so the error -> retry -> done
// path stays covered on Linux as well.
import { autoImportUiState, autoReviewAnnouncementState } from "../js/auto-review-state.mjs";

let failures = 0;
const t = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
};

const terminal = { announceCompletion: true, announceContinuation: false };
const packetState = {
  id: "job-local-import",
  mode: "done",
  packets_done: 1,
  packets_total: 1,
  per_packet: [{ packet_id: "P1", status: "done" }],
};
const imported = new Set(["P1"]);

{
  const errors = new Map([["P1", "quote validation failed"]]);
  const state = autoImportUiState(packetState, { importedPacketIds: imported, errors });
  const announcement = autoReviewAnnouncementState(packetState, {
    phase: "standalone",
    terminal,
    importedPacketIds: imported,
    errors,
  });
  t("サーバー完了後のローカル取込失敗はretry可能なエラー状態", state.importError
    && state.errorPacketId === "P1"
    && !state.importing
    && announcement.kind === "import_error"
    && announcement.key.includes("error:P1"));
}

{
  const retrying = autoReviewAnnouncementState(packetState, {
    phase: "standalone",
    terminal,
    importedPacketIds: imported,
    errors: new Map(),
    activePacketId: "P1",
  });
  t("再取り込み中は完了ではなく検証中を告知", retrying.kind === "importing"
    && retrying.importingPacketId === "P1"
    && retrying.key !== `${packetState.id}|done|1|1|standalone|0/0|import:idle|error:P1`);
}

{
  const completed = autoReviewAnnouncementState(packetState, {
    phase: "standalone",
    terminal,
    importedPacketIds: imported,
    errors: new Map(),
  });
  t("再取り込み成功後は同じjobでも完了告知へ遷移", completed.kind === "completion"
    && completed.key.includes("import:idle")
    && completed.key.includes("error:none"));
}

{
  const pending = autoReviewAnnouncementState({
    ...packetState,
    per_packet: [{ packet_id: "P2", status: "warning" }],
  }, {
    phase: "standalone",
    terminal,
    importedPacketIds: new Set(),
    errors: new Map(),
  });
  t("server doneでも未取込packetは完了告知しない", pending.kind === "importing"
    && pending.importingPacketId === "P2");
}

if (failures) {
  console.error(`\nTest-AutoReviewState: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-AutoReviewState: PASS");

