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
  // Packet evidence is absent here, so a stale top-level terminal mode must
  // not manufacture completion.
  return "queued";
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
      && !hasId(importedPacketIds, id)
      && !hasId(errors, id);
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
  const allPacketsTerminal = Array.isArray(st?.per_packet) && st.per_packet.length > 0
    && done === total && done === st.per_packet.length
    && st.per_packet.every(packet => ["done", "warning"].includes(String(packet?.status || "")));
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
  if (importState.importError) kind = "import_error";
  else if (importState.importing) kind = "importing";
  else if (mode === "queued" || mode === "running") kind = "progress";
  else if (mode === "done") {
    // A warning packet is not itself a final announcement: full-review
    // intermediate rounds can finish with warnings while the next stage is
    // already scheduled.  The explicit terminal contract owns the priority
    // so the live region cannot announce completion before the final stage.
    if (allPacketsTerminal && terminal?.announceContinuation) kind = "continuation";
    else if (allPacketsTerminal && hasWarning && terminal?.announceCompletion) kind = "warning";
    else if (allPacketsTerminal && terminal?.announceCompletion) kind = "completion";
    else kind = "silent";
  }
  else if (mode === "error") kind = "job_error";
  else if (mode === "cancelled") kind = "cancelled";

  return { ...importState, mode, done, total, kind, key };
}

function packetsHaveWarning(st) {
  return (Array.isArray(st?.per_packet) ? st.per_packet : [])
    .some(packet => String(packet?.status || "") === "warning");
}

// Keep the reason for a non-successful terminal packet visible to the user.
// ReviewJob intentionally stores the raw diagnostic (warning/error/completed_by)
// so that the browser can distinguish an empty result from incomplete coverage
// or a failed follow-up pass without exposing internal exception strings.
const AUTO_WARNING_REASON_LABELS = Object.freeze({
  coverage_insufficient: "確認範囲が不足",
  incomplete_json: "回答JSONが不完全",
  extra_pass_failed: "追加の確認パスが失敗または時間切れ",
  timeout: "回答の確認が時間切れ",
  read_error: "一部のページを読み取れない",
  repair: "回答の一部を復元したため再取得が必要",
  generic: "一部の確認が未完了",
});

function packetTargetPages(packet, targetPagesByPacket) {
  const id = asId(packet?.packet_id);
  if (targetPagesByPacket && typeof targetPagesByPacket.get === "function") {
    const pages = targetPagesByPacket.get(id) ?? targetPagesByPacket.get(packet?.packet_id);
    if (Array.isArray(pages)) return pages.map(Number).filter(Number.isInteger);
    if (pages && Array.isArray(pages.target_pages)) return pages.target_pages.map(Number).filter(Number.isInteger);
  }
  if (targetPagesByPacket && typeof targetPagesByPacket === "object" && !Array.isArray(targetPagesByPacket)) {
    const pages = targetPagesByPacket[id];
    if (Array.isArray(pages)) return pages.map(Number).filter(Number.isInteger);
    if (pages && Array.isArray(pages.target_pages)) return pages.target_pages.map(Number).filter(Number.isInteger);
  }
  return Array.isArray(packet?.target_pages)
    ? packet.target_pages.map(Number).filter(Number.isInteger)
    : [];
}

function packetDiagnosticText(packet) {
  return [packet?.warning, packet?.error, packet?.completed_by, packet?.detail]
    .map(value => String(value ?? "").toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function packetWarningReasons(packet, targetPagesByPacket) {
  const text = packetDiagnosticText(packet);
  const reasons = [];
  if (/read_error|読み取れない/.test(text)) reasons.push("read_error");
  if (/自動修復|一部を復元/.test(text)) reasons.push("repair");
  const targetPages = packetTargetPages(packet, targetPagesByPacket);
  const checkedPages = Array.isArray(packet?.pages_checked)
    ? packet.pages_checked.map(Number).filter(Number.isInteger)
    : [];
  const rawCoverage = packet?.coverage;
  const coverage = Number(rawCoverage);
  const hasCoverage = rawCoverage !== null && rawCoverage !== undefined && rawCoverage !== "" && Number.isFinite(coverage);
  const measuredCoverage = hasCoverage
    ? coverage
    : (targetPages.length ? checkedPages.filter(page => targetPages.includes(page)).length / targetPages.length : 1);

  if (/(?:incomplete-json|不完全(?:な)?json|有効な回答json|schema|回答形式)/i.test(text)) reasons.push("incomplete_json");
  if (/(?:追加|追撃|follow[- ]?up|pass).*(?:失敗|警告|error|failed|timeout|タイムアウト)|(?:失敗|警告|error|failed).*(?:追加|追撃|follow[- ]?up|pass)/i.test(text)) {
    reasons.push("extra_pass_failed");
  }
  if (/(?:timeout|タイムアウト|時間切れ|回答待機)/i.test(text)) reasons.push("timeout");
  if (measuredCoverage < 0.70 && (targetPages.length || checkedPages.length || hasCoverage)) {
    reasons.push("coverage_insufficient");
  }
  // 指摘0件そのものは理由にしない（実測 2026-08-18）。サーバー側 CopilotClient.ps1 も
  // 指摘0件では warning を立てなくなったが、旧ジョブのjournalに残る
  // 「指摘が0件です。…」という過去の警告文言が万一渡ってきても、ここで
  // 個別の理由コードに昇格させず generic のまま扱う。
  return reasons.length ? [...new Set(reasons)] : ["generic"];
}

function pageRangeText(pages) {
  const sorted = [...new Set((pages || []).map(Number).filter(page => Number.isInteger(page) && Number.isFinite(page)))]
    .sort((a, b) => a - b);
  const ranges = [];
  for (const page of sorted) {
    const last = ranges.at(-1);
    if (last && page === last.end + 1) last.end = page;
    else ranges.push({ start: page, end: page });
  }
  return ranges.map(range => range.start === range.end ? String(range.start) : `${range.start}-${range.end}`).join(",");
}

/**
 * Build a user-facing explanation for terminal warning/error packets.
 * This is deliberately pure so the browser card, toast, and aria live region
 * cannot drift into different interpretations of the same job state.
 */
export function autoReviewWarningSummary(st, {
  targetPagesByPacket = new Map(),
  importedFindings = null,
  importedPages = null,
} = {}) {
  const packets = Array.isArray(st?.per_packet) ? st.per_packet : [];
  const uncertainPackets = packets.filter(packet => ["warning", "error"].includes(String(packet?.status || "")));
  const warningPackets = packets.filter(packet => String(packet?.status || "") === "warning");
  const donePackets = packets.filter(packet => String(packet?.status || "") === "done");
  const findingCount = uncertainPackets.concat(donePackets)
    .reduce((sum, packet) => sum + Math.max(0, Number(packet?.findings_count || 0)), 0);
  const checkedPages = new Set();
  for (const packet of packets) {
    for (const page of Array.isArray(packet?.pages_checked) ? packet.pages_checked : []) {
      const n = Number(page);
      if (Number.isInteger(n)) checkedPages.add(n);
    }
  }
  const reasonCodes = [];
  const packetReasons = uncertainPackets.map(packet => {
    const codes = packetWarningReasons(packet, targetPagesByPacket);
    for (const code of codes) if (!reasonCodes.includes(code)) reasonCodes.push(code);
    return { packetId: asId(packet?.packet_id), codes };
  });
  const packetImpacts = uncertainPackets.map(packet => {
    const pages = packetTargetPages(packet, targetPagesByPacket);
    const checked = new Set((Array.isArray(packet?.pages_checked) ? packet.pages_checked : [])
      .map(Number).filter(Number.isInteger));
    const missing = pages.filter(page => !checked.has(Number(page)));
    const relevantPages = missing.length ? missing : (pages.length ? pages : [...checked]);
    return {
      packetId: asId(packet?.packet_id),
      pages: [...new Set(relevantPages)].sort((a, b) => a - b),
      pageText: pageRangeText(relevantPages),
    };
  });
  const labels = reasonCodes.map(code => AUTO_WARNING_REASON_LABELS[code] || AUTO_WARNING_REASON_LABELS.generic);
  const uniqueLabels = [...new Set(labels)];
  const doneCount = donePackets.length;
  const total = Number(st?.packets_total || packets.length || 0);
  const importedFindingCount = importedFindings !== null && importedFindings !== undefined
    && Number.isInteger(Number(importedFindings)) ? Number(importedFindings) : null;
  const importedPageCount = importedPages !== null && importedPages !== undefined
    && Number.isInteger(Number(importedPages)) ? Number(importedPages) : null;
  const displayedFindingCount = importedFindingCount === null ? findingCount : importedFindingCount;
  // 「確認Nページ」は Copilot が報告した確認済みページ数（pages_checked の和集合）を
  // 第一に使う。importedPages は「指摘のあるページ数」であり語義が異なるため、
  // サーバー報告が無いときだけ代替値として使う。
  const modelCheckedCount = checkedPages.size;
  const displayCheckedCount = modelCheckedCount > 0
    ? modelCheckedCount
    : (importedPageCount === null ? 0 : Math.max(0, importedPageCount));
  const reasonText = uniqueLabels.join("・");
  const progressText = `${doneCount}件完了 / 要確認 ${warningPackets.length}件${uncertainPackets.length > warningPackets.length ? `・失敗 ${uncertainPackets.length - warningPackets.length}件` : ""}`;
  const countsText = `指摘 ${displayedFindingCount}件 / 確認 ${displayCheckedCount}ページ`;
  const impactText = packetImpacts.length
    ? packetImpacts.map(packet => `${packet.packetId || "対象packet"}${packet.pageText ? `（P.${packet.pageText}）` : "（ページ不明）"}`).join("、")
    : "対象packet・ページを特定できません";
  const nextAction = uncertainPackets.length
    ? "未完了の依頼を再試行してください。"
    : "結果を確認してください。";
  // 「指摘0件でも確認が十分とは限らない」という注記（caution）は実測 2026-08-18 で廃止。
  // フィールド自体は index.html 側テンプレートがまだ参照しているため空文字で残す
  // （空文字なら「${caution ? ... : ""}」の分岐で何も表示されない）。
  const caution = "";
  return {
    warningCount: warningPackets.length,
    uncertainCount: uncertainPackets.length,
    doneCount,
    total,
    findingsCount: displayedFindingCount,
    pagesCount: displayCheckedCount,
    checkedPages: [...checkedPages].sort((a, b) => a - b),
    reasonCodes,
    reasonLabels: uniqueLabels,
    packetReasons,
    packetImpacts,
    progressText,
    countsText,
    impactText,
    reasonText,
    nextAction,
    caution,
    message: `${progressText}。${countsText}。未確認: ${impactText}。理由: ${reasonText || AUTO_WARNING_REASON_LABELS.generic}。${caution ? `${caution} ` : ""}${nextAction}`,
    toast: `要確認 ${warningPackets.length}件。未確認: ${impactText}。理由: ${reasonText || AUTO_WARNING_REASON_LABELS.generic}。${nextAction}`,
  };
}

// The server can report a terminal job with warnings or before the browser
// has imported every packet.  A completion banner is reserved for the strict
// all-terminal state: every packet must be `done` or `warning`, counters must
// agree, the review phase must already be final, and local import must be idle
// and error-free.  Warning presentation remains separate in the announcement
// helper above, but a source-bound warning is still eligible for completion.
export function reviewCompletionEligibility(st, {
  terminal = {},
  importedPacketIds = new Set(),
  errors = new Map(),
  activePacketId = "",
} = {}) {
  const packets = Array.isArray(st?.per_packet) ? st.per_packet : [];
  const done = Number(st?.packets_done || 0);
  const total = Number(st?.packets_total || 0);
  const allTerminal = packets.length > 0 && done === total && done === packets.length
    && packets.every(packet => ["done", "warning"].includes(String(packet?.status || "")));
  const importState = autoImportUiState(st, { importedPacketIds, errors, activePacketId });
  return Boolean(String(st?.mode || "") === "done"
    && terminal?.announceCompletion
    && allTerminal
    && !importState.importing
    && !importState.importError);
}

/**
 * Transport `mode` stays backward compatible (`done` is still used by the
 * recovery API), while this explicit semantic state keeps processing complete,
 * page verification, and human review distinct.
 */
export function semanticAutoReviewState(st = {}) {
  const packets = Array.isArray(st?.per_packet) ? st.per_packet : [];
  const statuses = packets.map(packet => String(packet?.status || ""));
  if (statuses.includes("needs_user_visibility") || statuses.includes("paused")) return "needs_user_visibility";
  if (statuses.includes("error") || String(st?.mode || "") === "error") return "error";
  if (statuses.some(status => ["queued", "running"].includes(status)) || ["queued", "running"].includes(String(st?.mode || ""))) return "processing";
  const terminal = packets.length > 0 && statuses.every(status => ["done", "warning"].includes(status));
  if (!terminal) return String(st?.mode || "processing");
  const needsReview = packets.some(packet => {
    const verification = String(packet?.verification_state || "").toLowerCase();
    const coverage = Number(packet?.coverage);
    return String(packet?.status || "") === "warning" || ["needs_review", "incomplete", "invalid"].includes(verification) || (Number.isFinite(coverage) && coverage < 1);
  });
  return needsReview ? "processing_done_with_review" : "processing_done";
}
