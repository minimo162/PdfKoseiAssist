// Executable live-region state transitions for server-terminal/local-import
// races.  This intentionally avoids a browser so the error -> retry -> done
// path stays covered on Linux as well.
import { autoImportUiState, autoReviewAnnouncementState, autoReviewWarningSummary, reviewCompletionEligibility, mergeAutoReviewJobState } from "../js/auto-review-state.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");

let failures = 0;
const t = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
};

t("未確認packetだけの一括再実行導線と送信経路を持つ",
  /function incompleteAutoPayloads\(/.test(indexHtml)
  && /class="autoIncompleteRetryLink"/.test(indexHtml)
  && /function retryIncompleteAutoPackets\(/.test(indexHtml)
  && /packetsForFullRunRetry\(payloads\)/.test(indexHtml));

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
  const warningSummary = autoReviewWarningSummary({
    mode: "done",
    packets_total: 4,
    per_packet: [
      // ZERO: 旧バージョンの journal に残り得る「指摘が0件です」という warning 文言
      // （実測 2026-08-18でサーバー側は指摘0件を warning にしなくなった）。後方互換として
      // 個別の理由コードには昇格させず generic のまま扱われることを検証する。
      { packet_id: "ZERO", status: "warning", findings_count: 0, pages_checked: [1, 2], coverage: 1, warning: "指摘が0件です。必要に応じてパケットを再実行してください。" },
      { packet_id: "COVERAGE", status: "warning", findings_count: 2, pages_checked: [3], coverage: 0.25, warning: "確認済みページが対象の25%です" },
      { packet_id: "JSON", status: "error", findings_count: 0, pages_checked: [], coverage: 0, completed_by: "incomplete-json", error: "回答JSONを復元できませんでした" },
      { packet_id: "PASS", status: "warning", findings_count: 1, pages_checked: [4], coverage: 1, warning: "追撃レビューの一部に失敗または警告がありました: numbers (timeout)" },
    ],
  }, { targetPagesByPacket: new Map([
    ["ZERO", [1, 2]], ["COVERAGE", [3, 4, 5, 6]], ["JSON", [7]], ["PASS", [8]],
  ]) });
  t("warning理由はcoverage/JSON/追加pass・timeoutに分類され、指摘0件は理由に出ない", warningSummary.warningCount === 3
    && warningSummary.uncertainCount === 4
    && !warningSummary.reasonCodes.includes("no_findings")
    && warningSummary.reasonCodes.includes("generic")
    && warningSummary.reasonCodes.includes("coverage_insufficient")
    && warningSummary.reasonCodes.includes("incomplete_json")
    && warningSummary.reasonCodes.includes("extra_pass_failed")
    && warningSummary.reasonCodes.includes("timeout"));
  t("warning summaryは指摘数・確認ページ数・再試行操作を保持し、caution文言は出ない", warningSummary.findingsCount === 3
    && warningSummary.pagesCount === 4
    && warningSummary.impactText.includes("ZERO（P.1-2）")
    && warningSummary.impactText.includes("COVERAGE（P.4-6）")
    && warningSummary.impactText.includes("JSON（P.7）")
    && warningSummary.message.includes("指摘 3件")
    && warningSummary.message.includes("確認 4ページ")
    && warningSummary.message.includes("未確認:")
    && warningSummary.message.includes("未完了の依頼を再試行")
    && warningSummary.caution === "");
  const postFilter = autoReviewWarningSummary({
    mode: "done",
    packets_total: 1,
    per_packet: [{ packet_id: "NUM", status: "warning", findings_count: 16, pages_checked: [1, 2, 3] }],
  }, { targetPagesByPacket: new Map([["NUM", [1, 2, 3]]]), importedFindings: 0, importedPages: 0 });
  t("warning summaryはserver件数ではなくlocal post-filter件数を表示", postFilter.findingsCount === 0
    && postFilter.pagesCount === 3
    && postFilter.countsText === "指摘 0件 / 確認 3ページ");
  const noServerPages = autoReviewWarningSummary({
    mode: "done",
    packets_total: 1,
    per_packet: [{ packet_id: "LEGACY", status: "warning", findings_count: 1 }],
  }, { targetPagesByPacket: new Map(), importedFindings: 1, importedPages: 2 });
  t("server報告の確認ページが無い場合は代替値で表示する", noServerPages.pagesCount === 2
    && noServerPages.countsText === "指摘 1件 / 確認 2ページ");
}

{
  const original = {
    id: "retry-job",
    mode: "done",
    packets_done: 2,
    packets_total: 2,
    per_packet: [
      { packet_id: "A", status: "warning", findings_count: 1 },
      { packet_id: "B", status: "warning", findings_count: 2 },
    ],
  };
  const retryA = mergeAutoReviewJobState(original, {
    id: "retry-A", mode: "done", packets_done: 1, packets_total: 1,
    per_packet: [{ packet_id: "A", status: "done", findings_count: 1 }],
  });
  t("部分retryは元warning packet Bを保持する", retryA.per_packet.length === 2
    && retryA.per_packet.find(packet => packet.packet_id === "B")?.status === "warning"
    && retryA.packets_done === 2 && retryA.packets_total === 2);
  t("Aだけ成功では全体完了にしない", !reviewCompletionEligibility(retryA, {
    terminal, importedPacketIds: new Set(["A"]), errors: new Map(),
  }));
  t("部分retry中のwarning状態はcompletion announcementにしない", autoReviewAnnouncementState(retryA, {
    phase: "standalone", terminal, importedPacketIds: new Set(["A", "B"]), errors: new Map(),
  }).kind === "warning");
  const retryB = mergeAutoReviewJobState(retryA, {
    id: "retry-B", mode: "done", packets_done: 1, packets_total: 1,
    per_packet: [{ packet_id: "B", status: "done", findings_count: 2 }],
  });
  t("Bも成功後だけ全体完了になる", retryB.per_packet.length === 2
    && retryB.per_packet.every(packet => packet.status === "done")
    && reviewCompletionEligibility(retryB, {
      terminal, importedPacketIds: new Set(["A", "B"]), errors: new Map(),
  }));
  for (const [status, expectedMode] of [
    ["error", "error"],
    ["needs_user_visibility", "needs_user_visibility"],
    ["paused", "needs_user_visibility"],
    ["cancelled", "cancelled"],
    ["running", "running"],
    ["queued", "queued"],
  ]) {
    // Re-run the public merge with the retained packet represented by the
    // original state; this models a server response that only contains A.
    const merged = mergeAutoReviewJobState({ ...original, per_packet: [{ packet_id: "A", status: "warning" }, { packet_id: "B", status }] }, {
      id: `retry-${status}`, mode: "done", packets_done: 1, packets_total: 1,
      per_packet: [{ packet_id: "A", status: "done", findings_count: 1 }],
    });
    const announcement = autoReviewAnnouncementState(merged, {
      phase: "standalone", terminal, importedPacketIds: new Set(["A", "B"]), errors: new Map(),
    });
    t(`未解決${status} packetはtop-level modeを保持する`, merged.mode === expectedMode
      && !reviewCompletionEligibility(merged, { terminal, importedPacketIds: new Set(["A", "B"]), errors: new Map() }));
    t(`未解決${status} packetはcompletion announcementにしない`, announcement.kind !== "completion");
    const final = mergeAutoReviewJobState({
      id: "retry-final", mode: expectedMode, error: "stale error",
      packets_done: 1, packets_total: 2,
      per_packet: [{ packet_id: "A", status: "done" }, { packet_id: "B", status }],
    }, {
      id: `retry-final-${status}`, mode: "done", packets_done: 1, packets_total: 1,
      per_packet: [{ packet_id: "B", status: "done" }],
    });
    t(`最後の${status} packet成功後はdone/eligibleになる`, final.mode === "done"
      && !final.error
      && reviewCompletionEligibility(final, { terminal, importedPacketIds: new Set(["A", "B"]), errors: new Map() }));
  }
}

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
  t("全packet terminal・counter一致・final phase・取込成功だけ完了可", reviewCompletionEligibility(packetState, {
    terminal,
    importedPacketIds: imported,
    errors: new Map(),
  }));
  t("source-bound warning packetも完了eligibility対象になる", reviewCompletionEligibility({
    ...packetState,
    per_packet: [{ packet_id: "P1", status: "warning" }],
  }, { terminal, importedPacketIds: imported, errors: new Map() }));
  t("counter不一致は完了バナー対象外", !reviewCompletionEligibility({
    ...packetState,
    packets_done: 0,
  }, { terminal, importedPacketIds: imported, errors: new Map() }));
  t("最終phaseでないterminalは完了バナー対象外", !reviewCompletionEligibility(packetState, {
    terminal: { announceCompletion: false },
    importedPacketIds: imported,
    errors: new Map(),
  }));
  const warningState = {
    ...packetState,
    id: "warning-phase-job",
    per_packet: [{ packet_id: "P1", status: "warning", warning: "確認範囲が不足しています" }],
  };
  const intermediateTerminal = {
    announceCompletion: false,
    announceContinuation: true,
    continuationMessage: "レビューはまだ終わっていません。",
  };
  const intermediateWarning = autoReviewAnnouncementState(warningState, {
    phase: "full-consistency",
    round: { current: 1, total: 2 },
    terminal: intermediateTerminal,
    importedPacketIds: imported,
    errors: new Map(),
  });
  t("中間phaseのwarningはcompletionではなく継続告知になる", intermediateWarning.kind === "continuation"
    && !reviewCompletionEligibility(warningState, {
      terminal: intermediateTerminal,
      importedPacketIds: imported,
      errors: new Map(),
    }));
  const finalWarning = autoReviewAnnouncementState(warningState, {
    phase: "full-pages",
    round: { current: 0, total: 0 },
    terminal,
    importedPacketIds: imported,
    errors: new Map(),
  });
  t("最終phaseのwarningは要確認告知と完了eligibilityを両立する", finalWarning.kind === "warning"
    && reviewCompletionEligibility(warningState, { terminal, importedPacketIds: imported, errors: new Map() }));
  t("再取り込み中・失敗は完了バナー対象外", !reviewCompletionEligibility(packetState, {
    terminal,
    importedPacketIds: imported,
    errors: new Map(),
    activePacketId: "P1",
  }) && !reviewCompletionEligibility(packetState, {
    terminal,
    importedPacketIds: imported,
    errors: new Map([["P1", "failed"]]),
  }));
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
