// Pure state helpers for the browser-side auto-review progress announcer.
// Server packets can be terminal while their local PDF/quote validation is
// still running (or has failed), so that client phase must be part of both the
// displayed state and the live-region identity.

function asId(value) {
  return String(value ?? "");
}

function hasId(collection, id) {
  if (!collection || !id) return false;
  if (typeof collection.has === "function") return collection.has(id);
  return Array.isArray(collection) && collection.map(asId).includes(id);
}

// Merge a retry/resume response that may contain only a subset of packets.
// The server returns a job-shaped state for the submitted subset, so replacing
// the previous state would make untouched warning/done packets disappear.
export function mergeAutoReviewJobState(original, resumed) {
  if (!original || !resumed) return resumed || original;
  const resumedById = new Map((resumed.per_packet || [])
    .map(packet => [asId(packet?.packet_id), packet]));
  const packets = (original.per_packet || []).map(packet =>
    resumedById.get(asId(packet?.packet_id)) || packet);
  for (const packet of resumed.per_packet || []) {
    if (!packets.some(existing => asId(existing?.packet_id) === asId(packet?.packet_id))) packets.push(packet);
  }
  const terminalCount = packets.filter(packet => ["done", "warning"].includes(String(packet?.status || ""))).length;
  const mode = aggregateAutoReviewMode(packets, resumed.mode, original.mode);
  const error = mode === "error"
    ? (resumed.error || original.error || "一部のパケットが失敗しました。")
    : mode === "needs_user_visibility"
      ? (resumed.error || original.error || "Copilot画面を表示してから同じパケットを再試行してください。")
      : "";
  return {
    ...resumed,
    mode,
    error,
    packets_total: packets.length,
    packets_done: terminalCount,
    per_packet: packets,
  };
}

function aggregateAutoReviewMode(packets, ...sourceModes) {
  const statuses = new Set(packets.map(packet => String(packet?.status || "")));
  // Packet status is authoritative.  A retry response often carries an old
  // top-level mode from the parent job; retaining that mode after the last
  // packet reaches done would make a successful retry impossible to finish.
  if (packets.length && packets.every(packet => ["done", "warning"].includes(String(packet?.status || "")))) return "done";
  if (statuses.has("needs_user_visibility") || statuses.has("paused")) return "needs_user_visibility";
  if (statuses.has("error")) return "error";
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.has("running")) return "running";
  if (statuses.has("queued")) return "queued";
  const modes = new Set(sourceModes.map(value => String(value || "")));
  if (modes.has("needs_user_visibility")) return "needs_user_visibility";
  if (modes.has("error")) return "error";
  if (modes.has("cancelled")) return "cancelled";
  if (modes.has("running")) return "running";
  if (modes.has("queued")) return "queued";
  return String(sourceModes.find(value => value) || "queued");
}

export function autoImportUiState(st, {
  importedPacketIds = new Set(),
  errors = new Map(),
  activePacketId = "",
} = {}) {
  const packets = Array.isArray(st?.per_packet) ? st.per_packet : [];
  const pendingPacketId = packets.find(packet => {
    const id = asId(packet?.packet_id);
    return ["done", "warning"].includes(String(packet?.status || ""))
      && !hasId(importedPacketIds, id);
  })?.packet_id || "";
  const errorPacketId = packets.find(packet => hasId(errors, asId(packet?.packet_id)))?.packet_id || "";
  const importingPacketId = asId(activePacketId) || asId(pendingPacketId);
  return {
    pendingPacketId: asId(pendingPacketId),
    errorPacketId: asId(errorPacketId),
    importingPacketId,
    importing: Boolean(importingPacketId),
    importError: Boolean(errorPacketId),
  };
}

/**
 * Return the semantic announcement state and a key that changes for every
 * client-side import transition.  `terminal` is the existing pure result of
 * autoReviewTerminalBehavior; keeping it as an input avoids duplicating the
 * full-review round rules here.
 */
export function autoReviewAnnouncementState(st, {
  phase = "",
  round = {},
  terminal = {},
  importedPacketIds = new Set(),
  errors = new Map(),
  activePacketId = "",
} = {}) {
  const mode = String(st?.mode || "");
  const done = Number(st?.packets_done || 0);
  const total = Number(st?.packets_total || 0);
  const hasWarning = packetsHaveWarning(st);
  const allPacketsDone = Array.isArray(st?.per_packet) && st.per_packet.length > 0
    && done === total && done === st.per_packet.length
    && st.per_packet.every(packet => String(packet?.status || "") === "done");
  const roundKey = `${Number(round?.current || 0)}/${Number(round?.total || 0)}`;
  const importState = autoImportUiState(st, { importedPacketIds, errors, activePacketId });
  const importKey = importState.importingPacketId
    ? `import:${importState.importingPacketId}`
    : "import:idle";
  const errorKey = importState.errorPacketId
    ? `error:${importState.errorPacketId}`
    : "error:none";
  const key = `${asId(st?.id)}|${mode}|${done}|${total}|${phase}|${roundKey}|${importKey}|${errorKey}`;

  let kind = "silent";
  if (importState.importing) kind = "importing";
  else if (importState.importError) kind = "import_error";
  else if (mode === "queued" || mode === "running") kind = "progress";
  else if (mode === "done") kind = hasWarning ? "warning"
    : (allPacketsDone && terminal?.announceContinuation ? "continuation"
      : (allPacketsDone && terminal?.announceCompletion ? "completion" : "warning"));
  else if (mode === "error") kind = "job_error";
  else if (mode === "cancelled") kind = "cancelled";

  return { ...importState, mode, done, total, kind, key };
}

function packetsHaveWarning(st) {
  return (Array.isArray(st?.per_packet) ? st.per_packet : [])
    .some(packet => String(packet?.status || "") === "warning");
}

// The server can report a terminal job with warnings or before the browser
// has imported every packet.  A completion banner is reserved for the strict
// all-done state: every packet must be `done`, counters must agree, the review
// phase must already be final, and local import must be idle and error-free.
export function reviewCompletionEligibility(st, {
  terminal = {},
  importedPacketIds = new Set(),
  errors = new Map(),
  activePacketId = "",
} = {}) {
  const packets = Array.isArray(st?.per_packet) ? st.per_packet : [];
  const done = Number(st?.packets_done || 0);
  const total = Number(st?.packets_total || 0);
  const allDone = packets.length > 0 && done === total && done === packets.length
    && packets.every(packet => String(packet?.status || "") === "done");
  const importState = autoImportUiState(st, { importedPacketIds, errors, activePacketId });
  return Boolean(String(st?.mode || "") === "done"
    && terminal?.announceCompletion
    && allDone
    && !importState.importing
    && !importState.importError);
}
