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
  else if (mode === "done") kind = terminal?.announceContinuation ? "continuation" : "completion";
  else if (mode === "error") kind = "job_error";
  else if (mode === "cancelled") kind = "cancelled";

  return { ...importState, mode, done, total, kind, key };
}

