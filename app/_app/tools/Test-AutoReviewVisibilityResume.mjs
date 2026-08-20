// Regression checks for visibility-paused jobs.  This is deliberately a
// ReviewJob contract test; the UI bundle can be deployed from another commit.

import fs from "node:fs";
import vm from "node:vm";

const review = fs.readFileSync(new URL("../src/ReviewJob.ps1", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/Server.ps1", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

const submitCalls = [...html.matchAll(/await submitAndPollAutoJob\(/g)];
if (submitCalls.length < 4) throw new Error("submitAndPollAutoJob の呼び出し経路が不足");
for (const match of submitCalls) {
  const tail = html.slice(match.index, match.index + 700);
  if (!tail.includes("needs_user_visibility") && !tail.includes("isNeedsUserVisibilityState")) {
    throw new Error("submit後のneeds_user_visibility停止ガードがない");
  }
}
for (const marker of [
  "function pendingAutoVisibilityPackets",
  "async function retryNeedsUserVisibility",
  "mergeAutoReviewJobState",
  "resumeAutoReviewAfterVisibility",
  "fullRunConsistencyRound",
]) {
  if (!html.includes(marker)) throw new Error("再開処理の" + marker + "がない");
}
if (!html.includes('["done", "warning"].includes(String(packet?.status || ""))')) {
  throw new Error("done/warning済みpacketを再試行から除外していない");
}
if (!html.includes("未完了") || !html.includes("まとめて再試行")) {
  throw new Error("未完了packet件数と一括再試行導線がない");
}
if (!html.includes('String(resumedState?.mode || "") !== "done"')
  || (!html.includes("submitAndPollAutoJob(packets, originalState)")
    && !html.includes("submitAndPollAutoJob(retryPackets, originalState)"))) {
  throw new Error("再開jobの未解決状態防止またはoriginal progress mergeがない");
}
if (!html.includes("const displayState = mergeBaseState ? mergeAutoReviewJobState(mergeBaseState, st) : st;")
  || !html.includes("return displayState;")) {
  throw new Error("部分jobを元stateへ統合して返していない");
}
if (!html.includes('resumedState?.mode === "cancelled"') || !html.includes("fullRunCancelRequested = true")) {
  throw new Error("cancelled再開jobが全体終了扱いになっていない");
}

const cancelAt = review.indexOf("if ([bool]$State.cancel_requested)");
const needsAt = review.indexOf("elseif ([bool]$State.needs_user_visibility");
if (cancelAt < 0 || needsAt < 0 || cancelAt > needsAt) {
  throw new Error("cancel_requested が needs_user_visibility より後で判定されている");
}
if (!review.includes("$State.mode = 'needs_user_visibility'")) {
  throw new Error("可視性待ちのジョブmodeがない");
}
if (!review.includes("$eligible = @('queued','running','needs_user_visibility')")) {
  throw new Error("再開対象statusの限定がない");
}
if (review.includes("$remainingPacket.status='paused'")) throw new Error("旧直接status更新が残っている");
const visibilityPauseStart = review.indexOf("elseif ([bool]$State.needs_user_visibility");
const visibilityPauseEnd = review.indexOf("\n            else {", visibilityPauseStart);
const visibilityPauseSource = visibilityPauseStart >= 0 && visibilityPauseEnd > visibilityPauseStart
  ? review.slice(visibilityPauseStart, visibilityPauseEnd) : "";
const pauseCalls = [...visibilityPauseSource.matchAll(
  /Set-KoseiPacketTerminalStatus[\\s\\S]*?-Status\\s+'paused'/g
)];
if (!pauseCalls.some(match => match[0].includes("$packetIndex"))) {
  throw new Error("未完了packetをpaused/retryableに戻していない");
}
if (!review.includes("$Shared.worker_stop[[string]$WorkerIndex] = $true")) {
  throw new Error("可視性失敗をworker単位に閉じ込めていない");
}
if (!review.includes("$Shared.stop_reasons[[string]$WorkerIndex] = $(if ([string]$p.status -eq 'paused')")) {
  throw new Error("可視性停止理由を保存していない");
}
if (!review.includes("stopReason -eq 'needs_user_visibility'") || !review.includes("@('queued','running') -contains [string]$packet.status")) {
  throw new Error("可視性停止時にworker残件を保持していない");
}
if (review.includes("$Shared.fatal") || review.includes("$shared.fatal")) {
  throw new Error("可視性失敗が全worker停止へ昇格している");
}
if (!review.includes("needs_user_visibility = [bool]$State.needs_user_visibility")) {
  throw new Error("status応答へ可視性状態を出していない");
}
if (!review.includes("function Set-KoseiPacketTerminalStatus") || !review.includes("$State.packets_done = [int]$State.packets_done + 1")) {
  throw new Error("terminal metadata/counter helperがない");
}
if (!review.includes("function Get-KoseiFailureKind") || review.includes("$detail -match 'needs_user_visibility:")) {
  throw new Error("typed failure consumerが文字列依存になっている");
}
if (client.includes("Page.bringToFront")) throw new Error("可視性待ちで自動前面化している");

// Ordered full-run stages are optional metadata: legacy packets still use the
// implicit stage 1, while a later stage is blocked until every earlier packet
// is successful.  Keep this contract close to the existing visibility tests.
for (const marker of [
  "function Get-KoseiPacketStageIndex",
  "function Get-KoseiOrderedStageGroups",
  "function Test-KoseiStageRunnable",
  "current_stage_index",
  "stage_index",
]) {
  if (!review.includes(marker)) throw new Error("段階実行の" + marker + "がない");
}
const stageRunnableStart = review.indexOf("function Test-KoseiStageRunnable");
const stageRunnableEnd = review.indexOf("function Add-KoseiCompletedPacket", stageRunnableStart);
const stageRunnableSource = stageRunnableStart >= 0 && stageRunnableEnd > stageRunnableStart
  ? review.slice(stageRunnableStart, stageRunnableEnd) : "";
if (!stageRunnableSource.includes("@('done','warning') -notcontains [string]$_.status")) {
  throw new Error("先行stageのerror/cancel/pausedを成功扱いしていない");
}
const stageLoopStart = review.indexOf("foreach ($stage in $stageGroups)");
const stageLoopEnd = review.indexOf("# 利用者の中止は", stageLoopStart);
const stageLoopSource = stageLoopStart >= 0 && stageLoopEnd > stageLoopStart
  ? review.slice(stageLoopStart, stageLoopEnd) : "";
if (!stageLoopSource.includes("$stagePackets.Count -eq 0")
  || !stageLoopSource.includes("Test-KoseiStageRunnable -State $State -StageIndex $stageIndex")) {
  throw new Error("空stageまたは先行stage未完了時のbarrierがない");
}

// A tab-close request is deferred only while a server-owned job is active;
// without an active job the existing shutdown grace period remains intact.
for (const marker of ["CloseRequested", "DeferredClose", "Test-KoseiJobRunning", "タブ閉鎖後も実行中ジョブを継続します"]) {
  if (!server.includes(marker)) throw new Error("タブ閉鎖時の" + marker + "契約がない");
}
if (!server.includes("if ($jobRunning) {") || !server.includes("タブ閉鎖検知のため停止")) {
  throw new Error("active jobのないタブ閉鎖shutdown分岐がない");
}
const autoShutdownStart = server.indexOf("if (-not $NoAutoShutdown) {");
const autoShutdownSource = autoShutdownStart >= 0 ? server.slice(autoShutdownStart, server.indexOf("\n                }", autoShutdownStart)) : "";
if (!autoShutdownSource.includes("$jobNeedsRecoveryLease")
  || !autoShutdownSource.includes("-not $jobNeedsRecoveryLease -and -not $serverState.HasBrowserHeartbeat")
  || !autoShutdownSource.includes("-not $jobNeedsRecoveryLease -and $serverState.HasBrowserHeartbeat")) {
  throw new Error("heartbeat/no-browser timeoutがactive review jobを抑止しない");
}
if (!server.includes("$ServerState.CloseRequested = $false")
  || !server.includes("$ServerState.DeferredClose = $false")) {
  throw new Error("後続heartbeatでdeferred closeを解除できない");
}
if (!server.includes("Get-KoseiRecoverableJobState")
  || !server.includes("$jobNeedsRecoveryLease = $jobRunning -or ($null -ne $recoverable)")
  || !server.includes("-not $jobNeedsRecoveryLease -and -not $serverState.HasBrowserHeartbeat")
  || !server.includes("-not $jobNeedsRecoveryLease -and $serverState.HasBrowserHeartbeat")) {
  throw new Error("terminal import失敗のrecoverable leaseがshutdown timeoutを抑止しない");
}
const pollStart = html.indexOf("async function pollAutoReviewJob(jobId");
const pollEnd = html.indexOf("\n    els.createReviewPdfBtn.addEventListener", pollStart);
const pollSource = pollStart >= 0 && pollEnd > pollStart ? html.slice(pollStart, pollEnd) : "";
if (!pollSource.includes('displayState.mode === "done" && completionReady')
  || !pollSource.includes("await acknowledgeRecoveredJob(jobId")
  || !pollSource.includes("!importPending && !importError")) {
  throw new Error("通常pollの成功importがserver result ACKへ到達しない");
}
if (!html.includes("const acknowledgedReviewJobIds = new Set()")
  || !html.includes("acknowledgedReviewJobIds.has(id)")) {
  throw new Error("result ACKがclient側でidempotentになっていない");
}

// A reconnect must rebuild the local masking/page-map context from bounded
// metadata and prove that the currently loaded target is the same source.
for (const marker of [
  "async function sha256HexBytes(bytes)",
  "target_pdf_sha256: originalPdfSha256",
  "recovery_metadata: buildRecoveryMetadata(packets)",
  "async function prepareRecoverableSourceBinding(descriptor, packets)",
  "expectedHash !== currentHash",
  "expectedPages !== currentPages",
  "const localMasker = MASKING_ENABLED ? new Masker(seed) : null",
  "jobMasker = sourceBinding.masker",
  "lastAutoPacketPageMaps = sourceBinding.pageMaps",
  "lastAutoImportOutcome = null",
  "function validateAutoImportSourceBinding(data, incoming)",
  "指摘候補を対象PDFの根拠へ結び付けられなかったため",
  "対象packet全ページを確認した根拠がないため",
  "sourceBound: Boolean(sourceBinding.ok)",
  "sourceSha256: String(section?.sourceSha256 || \"\").trim().toLowerCase()",
  "sourcePageCount: Number(section?.sourcePageCount || section?.totalPages || 0)",
  "async function recoveryReferenceFor(section)",
  "if (candidates.length !== 1) return null",
  "const actualHash = await sha256HexBytes(ref.bytes)",
  "if (actualHash !== expectedHash) return null",
  "pageTexts.set(Number(finding.page), await textForPage(Number(finding.page)))",
]) {
  if (!html.includes(marker)) throw new Error("source-bound recovery guardの" + marker + "がない");
}
const recoveryStart = html.indexOf("async function restoreRecoverableJobAfterTargetLoad()");
const recoveryEnd = html.indexOf("\n    async function probeRecoverableJob()", recoveryStart);
const recoverySource = recoveryStart >= 0 && recoveryEnd > recoveryStart ? html.slice(recoveryStart, recoveryEnd) : "";
if (!recoverySource.includes("const recoveryStillRunning =")
  || !recoverySource.includes("await pollAutoReviewJob(String(descriptor.id || \"\"), descriptor")
  || recoverySource.includes("submitAndPollAutoJob(")) {
  throw new Error("実行中jobの再訪が新jobを作らず既存jobのpollを再開していない");
}
if (!recoverySource.includes("autoImportedPackets.add(String(packet.packet_id || \"\"))")
  || !recoverySource.includes("recoveryCompletionReady = reviewCompletionEligibility")
  || !recoverySource.includes("if (allImported && !autoImportErrors.size)")
  || !recoverySource.includes("await acknowledgeRecoveredJob(descriptor.id, descriptor.recovery_chain_id, recoveryContext)")) {
  throw new Error("復旧成功packetの集合追加またはcompletion eligibility前ACKが残っている");
}
if (!recoverySource.includes('const recoveredPacketStatuses = new Set(["done", "warning"])')
  || !recoverySource.includes("recoveredPacketStatuses.has(String(packet.status || \"\"))")
  || !recoverySource.includes("if (!recoveredPacketStatuses.has(String(packet.status || \"\"))) continue")) {
  throw new Error("再訪時のwarning packetがdoneと同じsource-bound import/ACK契約に入っていない");
}
const importStart = html.indexOf("async function importResponse()");
const importEnd = html.indexOf("\n    /**\n     * 修正案", importStart);
const importSource = importStart >= 0 && importEnd > importStart ? html.slice(importStart, importEnd) : "";
if (!importSource.includes("const sourceBinding = validateAutoImportSourceBinding(data, incoming)")
  || !importSource.includes("if (!sourceBinding.ok) throw new Error(sourceBinding.message)")) {
  throw new Error("全候補除外/空回答を成功扱いしないsource-bound import guardがない");
}
const pollImportAdd = pollSource.indexOf("autoImportedPackets.add(rp.packet_id)");
const pollImportApply = pollSource.indexOf("await applyAutoAnswer");
if (pollImportAdd < 0 || pollImportApply < 0 || pollImportAdd < pollImportApply) {
  throw new Error("通常pollが回答検証前にautoImportedPacketsへ追加している");
}

const retryStart = html.indexOf("function packetsForFullRunRetry(packets)");
const retryEnd = html.indexOf("function rememberAutoVisibilityResume", retryStart);
const retrySource = retryStart >= 0 && retryEnd > retryStart ? html.slice(retryStart, retryEnd) : "";
if (retrySource.includes("if (!fullRunActive) return packets")
  || !retrySource.includes("const groups = new Map()")
  || !retrySource.includes("ordered.flatMap")
  || !retrySource.includes("const stageIndex = position + 1")
  || !retrySource.includes("stage_total: total")) {
  throw new Error("full-run retryが元stageを再付番せずfullRunActiveへ依存しています");
}
const individualRetryStart = html.indexOf("async function retryAutoPacket(packetId)");
const individualRetryEnd = html.indexOf("async function pollAutoReviewJob", individualRetryStart);
const individualRetrySource = individualRetryStart >= 0 && individualRetryEnd > individualRetryStart
  ? html.slice(individualRetryStart, individualRetryEnd) : "";
if ((individualRetrySource.match(/submitAndPollAutoJob\(/g) || []).length !== 1
  || !individualRetrySource.includes("const retryPayload = packetsForFullRunRetry([payload])")) {
  throw new Error("fullRun終了後の個別retryが同じstage正規化経路を使っていません");
}

// A warning result is ACKed after source-bound import, but its visible retry
// must still be a usable new-root submission after the old chain is deleted.
// Revisit recovery must rebuild the complete prompt/text/definition payload;
// a packet_id/target_pages-only stub is not a safe retry.
for (const marker of [
  "function buildRecoverableRetryPayload(packet, metadata, text, pdfBase64 = \"\")",
  "recovery_definition: recoveryPacketDefinition(packet)",
  "prompt_name: packetPromptFileName(packet)",
  "text_name: packetTextFileName(packet)",
  "function recoveryStateForRetry(state)",
  "acknowledgedReviewJobIds.has(`chain:${chainId}`)",
  "const retryBaseState = recoveryStateForRetry(mergeBaseState)",
  "return await pollAutoReviewJob(autoReviewJobId, retryBaseState)",
]) {
  if (!html.includes(marker)) throw new Error("warning ACK後のsource-bound root retry契約がない: " + marker);
}
if (html.includes('payloads.set(id, { packet_id: id, target_pages: targetPagesForPacket })')) {
  throw new Error("再訪復旧payloadがpacket_id/target_pagesだけのまま");
}
// Recovery is asynchronous. A target swap while source-bound packet rebuild
// is pending must leave the old retained result pending and must not install
// A's local state, import findings, or acknowledge A.
for (const marker of [
  "let targetLoadGeneration = 0",
  "const targetLoadRequestGeneration = ++targetLoadGeneration",
  "function captureRecoverySourceContext()",
  "function isCurrentRecoverySourceContext(context)",
  "referenceList !== context.references",
  "await prepareRecoverableSourceBinding(descriptor, packets, recoveryContext)",
  "await applyAutoAnswer(answer, packet.packet_id, recoveryContext)",
  "acknowledgeRecoveredJob(descriptor.id, descriptor.recovery_chain_id, recoveryContext)",
  "const allTerminalPacketsValid",
  "recoveredMode !== \"done\" || !allTerminalPacketsValid",
  "lastImportDroppedDuplicates",
  "lastHyphenFoldedCount",
  "totalDroppedDuplicates",
  "currentPageNo",
  "captureRecoveryToast",
  "recoveryToastSuppressionDepth",
  "targetLoadBusyOwner",
]) {
  if (!html.includes(marker)) throw new Error("非同期source-bound復旧の対象世代ガードがない: " + marker);
}
const recoveryContextStart = html.indexOf("function captureRecoverySourceContext()");
const recoveryContextEnd = html.indexOf("function updateReferenceRangeMode", recoveryContextStart);
const recoveryContextSource = recoveryContextStart >= 0 && recoveryContextEnd > recoveryContextStart
  ? html.slice(recoveryContextStart, recoveryContextEnd) : "";
const asyncRecoverySource = recoveryStart >= 0 && recoveryEnd > recoveryStart ? recoverySource : "";
const raceContext = {
  targetLoadGeneration: 1,
  pdfDoc: { name: "pdf-A" },
  originalPdfBytes: { name: "bytes-A" },
  originalPdfSha256: "a".repeat(64),
  originalFileName: "target-A.pdf",
  totalPages: 1,
  referenceList: [],
  pendingRecoverableJob: {
    id: "a-job",
    target_pdf_sha256: "a".repeat(64),
    target_page_count: 1,
    target_file_name: "target-A.pdf",
    mode: "done",
    recovery_metadata: { packets: [] },
  },
  els: {
    responseText: { value: "before" },
    status: { innerHTML: "old-status", textContent: "old-status", hidden: false, className: "old" },
    importStatus: { innerHTML: "old-import", textContent: "old-import", hidden: false, className: "old" },
    autoReviewCard: { innerHTML: "old-card", textContent: "old-card", hidden: false, className: "old" },
    reviewCompletionBanner: { innerHTML: "old-banner", textContent: "old-banner", hidden: false, className: "old" },
  },
  autoImportedPackets: new Set(),
  autoImportErrors: new Map(),
  autoImportRawAnswers: new Map(),
  acknowledgedReviewJobIds: new Set(),
  lastAutoPacketPageMaps: new Map([["sentinel", ["A"]]]),
  lastAutoPayloadByPacket: new Map([["sentinel", { packet_id: "A" }]]),
  jobMasker: { name: "masker-A" },
  jobMaskerSeed: 77,
  lastAutoImportOutcome: { sourceBound: true },
  lastImportDroppedDuplicates: 3,
  lastHyphenFoldedCount: 4,
  totalDroppedDuplicates: 5,
  currentPageNo: 1,
  lastAutoJobState: null,
  autoReviewJobId: "",
  autoRunStartedAt: 0,
  autoImportingPacketId: "",
  activeImportAllowedPages: null,
  activeImportPacketPageMap: null,
  nextFindingSerial: 2,
  viewerSource: "target",
  viewerReferenceId: "",
  autoReviewRunning: false,
  lastAutoCompletionAt: 0,
  autoRunFirstStartedAt: 0,
  lastAutoReviewKind: "",
  lastAutoAnnouncementKey: "old-announcement",
  fullRunActive: false,
  fullRunStage: "",
  fullRunPhase: "",
  fullRunConsistencyRound: {},
  fullRunWaitingVisibility: false,
  recoveryToastSuppressionDepth: 0,
  recoveryToastQueue: [],
  showToast: () => {},
  clearTimeout: () => {},
  findings: [{ id: "existing-A" }],
  activeFindingId: null,
  importCalls: 0,
  ackCalls: 0,
  rendered: 0,
  statuses: [],
  setStatus: value => { raceContext.statuses.push(String(value || "")); },
  fetch: async () => ({ ok: true, json: async () => ({ mode: "done", packets: [{ packet_id: "P1", status: "done", raw_answer: "{}" }] }) }),
  prepareRecoverableSourceBinding: async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    raceContext.targetLoadGeneration = 2;
    raceContext.pdfDoc = { name: "pdf-B" };
    raceContext.originalPdfBytes = { name: "bytes-B" };
    raceContext.originalPdfSha256 = "b".repeat(64);
    raceContext.originalFileName = "target-B.pdf";
    return { ok: true, pageMaps: new Map([["P1", ["A"]]]), payloads: new Map([["P1", { packet_id: "P1" }]]), masker: { name: "masker-from-A" }, maskerSeed: 1 };
  },
  applyAutoAnswer: async () => { raceContext.importCalls++; return true; },
  acknowledgeRecoveredJob: async () => { raceContext.ackCalls++; return true; },
  renderAutoCard: () => { raceContext.rendered++; },
  updateAutoButtons: () => {},
  reviewCompletionEligibility: () => true,
};
vm.runInNewContext(`${recoveryContextSource}\nthis.__capture = captureRecoverySourceContext; this.__current = isCurrentRecoverySourceContext;`, raceContext);
vm.runInNewContext(`${asyncRecoverySource}\nthis.__restore = restoreRecoverableJobAfterTargetLoad;`, raceContext);
await raceContext.__restore();
if (raceContext.importCalls !== 0 || raceContext.ackCalls !== 0 || raceContext.rendered !== 0) {
  throw new Error("対象PDF A→B差し替え後に復旧import/ACK/UI適用が実行された");
}
if (raceContext.lastAutoPacketPageMaps.get("sentinel")?.[0] !== "A"
  || raceContext.lastAutoPayloadByPacket.get("sentinel")?.packet_id !== "A"
  || raceContext.jobMasker?.name !== "masker-A"
  || raceContext.findings.length !== 1
  || raceContext.pendingRecoverableJob?.id !== "a-job") {
  throw new Error("対象PDF A→B差し替え時にAの復旧globals/findings/pending結果が壊れた");
}
const retainedContext = raceContext.__capture();
raceContext.referenceList = [{ id: "new-ref", doc: {}, bytes: {} }];
if (raceContext.__current(retainedContext)) throw new Error("比較資料差し替えをsource-bound復旧世代が見逃した");

// Recovery import is one transaction.  If the first answer has already
// appended a finding and the reference set changes before the next packet,
// every imported/global/UI mutation is rolled back and the retained job stays
// available for a later, source-bound attempt.
const transactionContext = {
  targetLoadGeneration: 7,
  pdfDoc: { name: "pdf-T" },
  originalPdfBytes: { name: "bytes-T" },
  originalPdfSha256: "t".repeat(64),
  originalFileName: "target-T.pdf",
  totalPages: 2,
  referenceList: [],
  pendingRecoverableJob: {
    id: "transaction-job",
    target_pdf_sha256: "t".repeat(64),
    target_page_count: 2,
    target_file_name: "target-T.pdf",
    mode: "done",
    recovery_metadata: { packets: [] },
  },
  els: {
    responseText: { value: "before-response" },
    status: { innerHTML: "old-status", textContent: "old-status", hidden: false, className: "old" },
    importStatus: { innerHTML: "old-import", textContent: "old-import", hidden: false, className: "old" },
    autoReviewCard: { innerHTML: "old-card", textContent: "old-card", hidden: false, className: "old" },
    reviewCompletionBanner: { innerHTML: "old-banner", textContent: "old-banner", hidden: false, className: "old" },
  },
  autoImportedPackets: new Set(["before"]),
  autoImportErrors: new Map([["before", "old-error"]]),
  autoImportRawAnswers: new Map([["before", "old-answer"]]),
  acknowledgedReviewJobIds: new Set(),
  lastAutoPacketPageMaps: new Map([["sentinel", ["T"]]]),
  lastAutoPayloadByPacket: new Map([["sentinel", { packet_id: "T" }]]),
  jobMasker: { name: "masker-T" },
  jobMaskerSeed: 17,
  lastAutoImportOutcome: { sourceBound: true },
  lastImportDroppedDuplicates: 8,
  lastHyphenFoldedCount: 9,
  totalDroppedDuplicates: 10,
  currentPageNo: 2,
  lastAutoJobState: null,
  autoReviewJobId: "old-job",
  autoRunStartedAt: 11,
  autoImportingPacketId: "before",
  activeImportAllowedPages: [1],
  activeImportPacketPageMap: new Map([["before", [1]]]),
  nextFindingSerial: 2,
  viewerSource: "target",
  viewerReferenceId: "",
  autoReviewRunning: false,
  lastAutoCompletionAt: 12,
  autoRunFirstStartedAt: 13,
  lastAutoReviewKind: "old-kind",
  lastAutoAnnouncementKey: "old-announcement",
  fullRunActive: false,
  fullRunStage: "",
  fullRunPhase: "",
  fullRunConsistencyRound: {},
  fullRunWaitingVisibility: false,
  recoveryToastSuppressionDepth: 0,
  recoveryToastQueue: [],
  showToast: () => {},
  clearTimeout: () => {},
  findings: [{ id: "existing-T", quote: "keep" }],
  activeFindingId: "existing-T",
  applyCalls: 0,
  ackCalls: 0,
  fetch: async () => ({ ok: true, json: async () => ({
    mode: "done",
    packets: [
      { packet_id: "P1", status: "done", raw_answer: "{}" },
      { packet_id: "P2", status: "done", raw_answer: "{}" },
    ],
  }) }),
  prepareRecoverableSourceBinding: async () => ({
    ok: true,
    pageMaps: new Map([["P1", [1]], ["P2", [2]]]),
    payloads: new Map([["P1", { packet_id: "P1" }], ["P2", { packet_id: "P2" }]]),
    masker: { name: "masker-import" },
    maskerSeed: 99,
  }),
  applyAutoAnswer: async (_answer, packetId) => {
    transactionContext.applyCalls++;
    if (transactionContext.applyCalls === 1) {
      transactionContext.findings.push({ id: "partial-P1", quote: "must-rollback" });
      transactionContext.nextFindingSerial = 99;
      transactionContext.els.responseText.value = "partial-response";
      transactionContext.autoImportedPackets.add(String(packetId));
      transactionContext.referenceList = [{ id: "new-ref", doc: {}, bytes: {} }];
    }
    return true;
  },
  acknowledgeRecoveredJob: async () => { transactionContext.ackCalls++; return true; },
  renderAutoCard: () => { transactionContext.els.autoReviewCard.innerHTML = "new-card"; },
  renderFindings: () => {},
  renderAllPageNotes: () => {},
  updateAutoButtons: () => {},
  setStatus: value => { transactionContext.els.status.textContent = String(value || ""); },
  reviewCompletionEligibility: () => true,
};
vm.runInNewContext(`${recoveryContextSource}\nthis.__capture = captureRecoverySourceContext;`, transactionContext);
vm.runInNewContext(`${asyncRecoverySource}\nthis.__restore = restoreRecoverableJobAfterTargetLoad;`, transactionContext);
const transactionResult = await transactionContext.__restore();
if (transactionResult !== false || transactionContext.applyCalls !== 1 || transactionContext.ackCalls !== 0) {
  throw new Error("復旧途中のsource変更がtransaction rollback/ACK停止として扱われていない");
}
if (transactionContext.findings.length !== 1
  || transactionContext.findings[0]?.id !== "existing-T"
  || transactionContext.nextFindingSerial !== 2
  || transactionContext.els.responseText.value !== "before-response"
  || transactionContext.els.autoReviewCard.innerHTML !== "old-card"
  || transactionContext.els.status.innerHTML !== "old-status"
  || transactionContext.autoImportedPackets.size !== 1
  || !transactionContext.autoImportedPackets.has("before")
  || transactionContext.lastAutoPacketPageMaps.get("sentinel")?.[0] !== "T"
  || transactionContext.jobMasker?.name !== "masker-T"
  || transactionContext.lastAutoJobState !== null
  || transactionContext.pendingRecoverableJob?.id !== "transaction-job") {
  throw new Error("復旧transaction rollback後に部分finding/global/UIまたは保持jobが残った");
}

function makeTerminalRecoveryScenario({ mode, running = false }) {
  const ctx = {
    targetLoadGeneration: 3,
    pdfDoc: { name: `pdf-${mode}` },
    originalPdfBytes: { name: `bytes-${mode}` },
    originalPdfSha256: "c".repeat(64),
    originalFileName: "target-terminal.pdf",
    totalPages: 2,
    referenceList: [],
    pendingRecoverableJob: {
      id: `${mode}-job`,
      target_pdf_sha256: "c".repeat(64),
      target_page_count: 2,
      target_file_name: "target-terminal.pdf",
      mode: running ? "running" : mode,
      recovery_metadata: { packets: [] },
    },
    els: {
      responseText: { value: "before-response" },
      pageIndicator: { innerHTML: "old-page", textContent: "old-page", hidden: false, className: "old" },
      viewerTargetPageTabs: { innerHTML: "old-tabs", textContent: "old-tabs", hidden: false, className: "old" },
      status: { innerHTML: "old-status", textContent: "old-status", hidden: false, className: "old" },
      importStatus: { innerHTML: "old-import", textContent: "old-import", hidden: false, className: "old" },
      autoReviewCard: { innerHTML: "old-card", textContent: "old-card", hidden: false, className: "old" },
      reviewCompletionBanner: { innerHTML: "old-banner", textContent: "old-banner", hidden: false, className: "old" },
      toast: { textContent: "old-toast", className: "toast show", classList: { add() {}, remove() {} } },
    },
    autoImportedPackets: new Set(["before"]),
    autoImportErrors: new Map([["before", "old-error"]]),
    autoImportRawAnswers: new Map([["before", "old-answer"]]),
    acknowledgedReviewJobIds: new Set(),
    lastAutoPacketPageMaps: new Map([["sentinel", ["before"]]]),
    lastAutoPayloadByPacket: new Map([["sentinel", { packet_id: "before" }]]),
    jobMasker: { name: "masker-before" },
    jobMaskerSeed: 21,
    lastAutoImportOutcome: { sourceBound: true },
    lastImportDroppedDuplicates: 2,
    lastHyphenFoldedCount: 3,
    totalDroppedDuplicates: 4,
    currentPageNo: 2,
    lastAutoJobState: null,
    autoReviewJobId: "old-job",
    autoRunStartedAt: 11,
    autoImportingPacketId: "before",
    activeImportAllowedPages: [1],
    activeImportPacketPageMap: new Map([["before", [1]]]),
    nextFindingSerial: 2,
    viewerSource: "target",
    viewerReferenceId: "",
    autoReviewRunning: false,
    lastAutoCompletionAt: 12,
    autoRunFirstStartedAt: 13,
    lastAutoReviewKind: "old-kind",
    lastAutoAnnouncementKey: "old-announcement",
    fullRunActive: false,
    fullRunStage: "",
    fullRunPhase: "",
    fullRunConsistencyRound: {},
    fullRunWaitingVisibility: false,
    recoveryToastSuppressionDepth: 0,
    recoveryToastQueue: [],
    showToast: () => {},
    clearTimeout: () => {},
    findings: [{ id: "existing-terminal", quote: "keep" }],
    activeFindingId: "existing-terminal",
    applyCalls: 0,
    ackCalls: 0,
    fetch: async () => ({ ok: true, json: async () => running
      ? { mode: "running", packets: [{ packet_id: "P1", status: "running" }] }
      : { mode: "error", packets: [
        { packet_id: "P1", status: "done", raw_answer: "{}" },
        { packet_id: "P2", status: "error", raw_answer: "" },
      ] } }),
    prepareRecoverableSourceBinding: async () => ({
      ok: true,
      pageMaps: new Map([["P1", [1]], ["P2", [2]]]),
      payloads: new Map([["P1", { packet_id: "P1" }], ["P2", { packet_id: "P2" }]]),
      masker: { name: "masker-terminal" },
      maskerSeed: 88,
    }),
    applyAutoAnswer: async (_answer, packetId) => {
      ctx.applyCalls++;
      ctx.findings.push({ id: `partial-${packetId}`, quote: "rollback" });
      ctx.lastImportDroppedDuplicates = 99;
      ctx.lastHyphenFoldedCount = 98;
      ctx.totalDroppedDuplicates = 97;
      ctx.currentPageNo = 9;
      ctx.els.responseText.value = "partial-response";
      ctx.els.toast.textContent = "partial-toast";
      ctx.els.toast.className = "toast show partial";
      return true;
    },
    acknowledgeRecoveredJob: async () => { ctx.ackCalls++; return true; },
    renderAutoCard: () => { ctx.els.autoReviewCard.innerHTML = "new-card"; },
    renderFindings: () => {},
    renderAllPageNotes: () => {},
    updateAutoButtons: () => {},
    setStatus: value => { ctx.els.status.textContent = String(value || ""); },
    reviewCompletionEligibility: () => true,
  };
  if (running) {
    ctx.pollAutoReviewJob = async () => {
      await ctx.applyAutoAnswer("{}", "P1");
      ctx.autoImportedPackets.add("P1");
      ctx.autoImportErrors.set("P2", "terminal import failure");
      return { id: "running-job", mode: "error", recovery_chain_id: "terminal-chain" };
    };
  }
  vm.runInNewContext(`${recoveryContextSource}\nthis.__capture = captureRecoverySourceContext;`, ctx);
  vm.runInNewContext(`${asyncRecoverySource}\nthis.__restore = restoreRecoverableJobAfterTargetLoad;`, ctx);
  return ctx;
}

// An immediately terminal error may contain one completed packet.  The
// completed answer must be rolled back with the terminal error, not retained
// or acknowledged as a partial success.
const terminalErrorContext = makeTerminalRecoveryScenario({ mode: "error" });
if (await terminalErrorContext.__restore() !== false
  || terminalErrorContext.applyCalls !== 1
  || terminalErrorContext.ackCalls !== 0
  || terminalErrorContext.findings.length !== 1
  || terminalErrorContext.findings[0]?.id !== "existing-terminal"
  || terminalErrorContext.lastImportDroppedDuplicates !== 2
  || terminalErrorContext.lastHyphenFoldedCount !== 3
  || terminalErrorContext.totalDroppedDuplicates !== 4
  || terminalErrorContext.currentPageNo !== 2
  || terminalErrorContext.viewerSource !== "target"
  || terminalErrorContext.viewerReferenceId !== ""
  || terminalErrorContext.activeFindingId !== "existing-terminal"
  || terminalErrorContext.lastAutoAnnouncementKey !== "old-announcement"
  || terminalErrorContext.els.responseText.value !== "before-response"
  || terminalErrorContext.els.toast.textContent !== "old-toast"
  || terminalErrorContext.els.toast.className !== "toast show"
  || terminalErrorContext.pendingRecoverableJob?.id !== "error-job") {
  throw new Error("即時terminal errorのcompleted packet部分importがtransaction rollbackされていない");
}

// A returning tab can import one packet while polling a running job and then
// receive a terminal error.  The poll's false/error-map path must still cause
// the outer recovery transaction to roll back everything.
const runningFailureContext = makeTerminalRecoveryScenario({ mode: "running", running: true });
if (await runningFailureContext.__restore() !== false
  || runningFailureContext.applyCalls !== 1
  || runningFailureContext.ackCalls !== 0
  || runningFailureContext.findings.length !== 1
  || runningFailureContext.autoImportErrors.size !== 1
  || !runningFailureContext.autoImportErrors.has("before")
  || runningFailureContext.currentPageNo !== 2
  || runningFailureContext.viewerSource !== "target"
  || runningFailureContext.activeFindingId !== "existing-terminal"
  || runningFailureContext.els.toast.textContent !== "old-toast"
  || runningFailureContext.pendingRecoverableJob?.id !== "running-job") {
  throw new Error("running→terminal import failureがouter recovery rollbackになっていない");
}

// A superseded target load is silent.  The newer PDF remains active while an
// older staged candidate is destroyed and its object URL is revoked, even
// when that older candidate finishes after the newer load has committed.
const handleStart = html.indexOf("async function handlePdfFile(file)");
const handleEnd = html.indexOf("\n    function renderReferenceListUi", handleStart);
const handleSource = handleStart >= 0 && handleEnd > handleStart ? html.slice(handleStart, handleEnd) : "";
for (const marker of [
  "const targetLoadRequestGeneration = ++targetLoadGeneration",
  "let stagedCandidate = null",
  "if (!targetCommitted && stagedCandidate?.doc && stagedCandidate.doc !== pdfDoc)",
  "if (!targetCommitted && candidateObjectUrl)",
  "if (superseded) {",
]) {
  if (!handleSource.includes(marker)) throw new Error("旧PDFのsuperseded cleanup契約がない: " + marker);
}
let releaseOldCandidate;
const destroyedStagedDocs = [];
const revokedStagedUrls = [];
const loadStatuses = [];
const loadToasts = [];
const makeLoadNode = () => ({ hidden: false, disabled: false, value: "", textContent: "", innerHTML: "" });
const loadContext = {
  targetLoadGeneration: 0,
  targetLoadBusyOwner: 0,
  pdfDoc: null,
  originalPdfObjectUrl: "",
  originalPdfBytes: null,
  originalPdfSha256: "",
  originalFileName: "",
  totalPages: 0,
  nativePdfZoomMode: "",
  viewerSource: "",
  viewerReferenceId: "",
  findings: [],
  activeFindingId: null,
  nextFindingSerial: 1,
  reviewPdfBytes: null,
  reviewPdfFileName: "",
  targetPages: [],
  referenceList: [],
  referencePages: [],
  referenceRangeAutoMode: true,
  pendingRecoverableJob: null,
  referencePdfBytes: null,
  referenceFileName: "",
  referencePdfDoc: null,
  referenceTotalPages: 0,
  jobMasker: null,
  jobMaskerSeed: 0,
  lastAutoPacketPageMaps: new Map(),
  lastAutoPayloadByPacket: new Map(),
  lastAutoImportOutcome: null,
  lastAutoJobState: null,
  autoReviewJobId: "",
  autoImportedPackets: new Set(),
  autoImportErrors: new Map(),
  autoImportRawAnswers: new Map(),
  autoImportingPacketId: "",
  activeImportAllowedPages: null,
  activeImportPacketPageMap: null,
  els: {
    dropZone: {
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
    },
    selectedFile: makeLoadNode(),
    pageRangeInput: makeLoadNode(),
    createReviewPdfBtn: makeLoadNode(),
    downloadReviewPdfBtn: makeLoadNode(),
    copyPromptBtn: makeLoadNode(),
    resetRangeBtn: makeLoadNode(),
    openOriginalPdfBtn: makeLoadNode(),
    fitWidthBtn: makeLoadNode(),
    zoomInBtn: makeLoadNode(),
    zoomOutBtn: makeLoadNode(),
    reviewPdfStatus: makeLoadNode(),
    referencePageRangeInput: makeLoadNode(),
  },
  URL: {
    createObjectURL: blob => {
      const url = `blob:${blob.parts?.[0]?.[0] === 65 ? "A" : "B"}-${revokedStagedUrls.length + 1}`;
      return url;
    },
    revokeObjectURL: url => { revokedStagedUrls.push(String(url)); },
  },
  Blob: function Blob(parts) { this.parts = parts; },
  setStatus: value => { loadStatuses.push(String(value || "")); },
  showToast: value => { loadToasts.push(String(value || "")); },
  staleRecoveryContextError: () => { const error = new Error("superseded"); error.code = "stale_recovery_source"; return error; },
  stagePdfCandidate: async file => {
    if (file.name === "A.pdf") {
      await new Promise(resolve => { releaseOldCandidate = resolve; });
      return { fileName: "A.pdf", bytes: new Uint8Array([65]), doc: { name: "doc-A" }, totalPages: 4, fileSize: 1 };
    }
    return { fileName: "B.pdf", bytes: new Uint8Array([66]), doc: { name: "doc-B" }, totalPages: 3, fileSize: 1 };
  },
  openPdfDocument: async () => {},
  sha256HexBytes: async bytes => bytes[0] === 65 ? "a".repeat(64) : "b".repeat(64),
  commitStagedPdfCandidate: (candidate, callbacks) => callbacks.commit(candidate),
  destroyPdfDocumentBestEffort: doc => {
    destroyedStagedDocs.push(String(doc?.name || ""));
    if (doc) doc.destroyed = true;
  },
  clearReportTextCaches: () => {},
  updateResultsPresentation: () => {},
  hasReferencePdf: () => false,
  updateReferenceRangeMode: () => {},
  // The load transaction fixture does not need PDF text extraction; stub the
  // new post-commit language metadata step so the test remains focused on
  // superseded target ownership and cleanup.
  renderDetectedLanguageUi: () => {},
  updateTargetLanguageDetection: async () => "その他",
  applyReferenceRangeSetting: () => ({ references: [], rangeText: "" }),
  parsePageRange: () => [],
  pagesToRangeText: pages => pages.join(","),
  syncLegacyReferenceAlias: () => {},
  applyAutoReferenceRange: () => {},
  defaultReferencePagesForTargets: () => [],
  targetLoadCommitGeneration: 0,
  formatBytes: value => String(value),
  pageRangeLabel: () => "1-3",
  refreshRangeFromInput: () => {},
  buildPrompt: () => {},
  renderFindings: () => {},
  fitPageWidth: async () => {},
  renderViewer: async () => {},
  updateViewerSourceTabs: () => {},
  restoreRecoverableJobAfterTargetLoad: async () => false,
  probeRecoverableJob: async () => null,
};
vm.runInNewContext(`${handleSource}\nthis.__handle = handlePdfFile;`, loadContext);
const oldLoad = loadContext.__handle({ name: "A.pdf", type: "application/pdf" });
while (!releaseOldCandidate) await new Promise(resolve => setTimeout(resolve, 0));
const newLoad = await loadContext.__handle({ name: "B.pdf", type: "application/pdf" });
if (!newLoad?.ok || loadContext.originalFileName !== "B.pdf" || loadContext.pdfDoc?.name !== "doc-B") {
  throw new Error("新しい対象PDFのcommitがsuperseded loadにより成立していない");
}
releaseOldCandidate();
const oldLoadResult = await oldLoad;
if (!oldLoadResult?.superseded
  || loadContext.originalFileName !== "B.pdf"
  || loadContext.pdfDoc?.name !== "doc-B"
  || destroyedStagedDocs.filter(name => name === "doc-A").length !== 1
  || !revokedStagedUrls.some(url => url.includes("A"))
  || loadToasts.some(message => message.includes("読み込めませんでした"))
  || loadStatuses.some(message => message.includes("読み込めませんでした"))) {
  throw new Error("superseded旧PDFが新PDFのUIを汚染するかstaged doc/URLを解放していない");
}

// Reverse-order busy ownership: A commits and is then superseded while B is
// still staging.  A's finally must leave aria-busy set until B finishes.
let releaseBusyCandidate;
let releaseBusyAView;
let busyAViewStarted = false;
loadContext.targetLoadGeneration = 0;
loadContext.targetLoadBusyOwner = 0;
loadContext.pdfDoc = null;
loadContext.originalPdfObjectUrl = "";
loadContext.originalPdfBytes = null;
loadContext.originalPdfSha256 = "";
loadContext.originalFileName = "";
loadContext.totalPages = 0;
loadContext.els.dropZone.attrs = {};
loadContext.stagePdfCandidate = async file => {
  if (file.name === "A.pdf") return { fileName: "A.pdf", bytes: new Uint8Array([65]), doc: { name: "busy-A" }, totalPages: 2, fileSize: 1 };
  await new Promise(resolve => { releaseBusyCandidate = resolve; });
  return { fileName: "B.pdf", bytes: new Uint8Array([66]), doc: { name: "busy-B" }, totalPages: 2, fileSize: 1 };
};
loadContext.fitPageWidth = async () => {
  if (loadContext.pdfDoc?.name === "busy-A") {
    busyAViewStarted = true;
    await new Promise(resolve => { releaseBusyAView = resolve; });
  }
};
loadContext.renderViewer = async () => {};
const busyA = loadContext.__handle({ name: "A.pdf", type: "application/pdf" });
while (!busyAViewStarted) await new Promise(resolve => setTimeout(resolve, 0));
const busyB = loadContext.__handle({ name: "B.pdf", type: "application/pdf" });
while (!releaseBusyCandidate) await new Promise(resolve => setTimeout(resolve, 0));
releaseBusyAView();
const busyAResult = await busyA;
if (!busyAResult?.superseded || !Object.prototype.hasOwnProperty.call(loadContext.els.dropZone.attrs, "aria-busy")) {
  throw new Error("旧PDF完了時に新PDF staging中のaria-busyを解除している");
}
releaseBusyCandidate();
const busyBResult = await busyB;
if (!busyBResult?.ok || Object.prototype.hasOwnProperty.call(loadContext.els.dropZone.attrs, "aria-busy")) {
  throw new Error("最新PDF完了後にaria-busyが正しく解除されていない");
}

const restoreForRetryStart = html.indexOf("async function prepareRecoverableSourceBinding");
const restoreForRetryEnd = html.indexOf("\n    async function restoreRecoverableJobAfterTargetLoad", restoreForRetryStart);
const restoreForRetrySource = restoreForRetryStart >= 0 && restoreForRetryEnd > restoreForRetryStart
  ? html.slice(restoreForRetryStart, restoreForRetryEnd) : "";
if (!restoreForRetrySource.includes("payloads.set(entry.id, buildRecoverableRetryPayload")
  || !restoreForRetrySource.includes("maskSidecarTextForSend(rawText, entry.id, localMasker)")) {
  throw new Error("再訪warningの完全payload再構築またはsource-bound maskingがない");
}
const retryPayloadStart = html.indexOf("function buildRecoverableRetryPayload(packet, metadata, text, pdfBase64 = \"\")");
const retryPayloadEnd = html.indexOf("\n    async function prepareRecoverableSourceBinding", retryPayloadStart);
const retryPayloadSource = retryPayloadStart >= 0 && retryPayloadEnd > retryPayloadStart
  ? html.slice(retryPayloadStart, retryPayloadEnd) : "";
if (retryPayloadSource.includes("autoSampleStrategyPrompt(strategy, hasRef)")
  || !retryPayloadSource.includes("const referenceAvailable")
  || !retryPayloadSource.includes("referenceSections")
  || !retryPayloadSource.includes(".every(section => !!section?.doc && !!section?.bytes)")
  || !retryPayloadSource.includes("const hasReference = referenceRequired && referenceAvailable")) {
  throw new Error("再訪proofread payload rebuildが未定義hasRefまたは未検証の参照資料を使用している");
}
if (!individualRetrySource.includes("const originalState = recoveryStateForRetry(lastAutoJobState)")) {
  throw new Error("同一タブwarning ACK後の個別retryがroot化されない");
}

// Execute the production rebuild function with the smallest production-like
// dependency surface.  This catches an undeclared helper (the former `hasRef`
// ReferenceError) rather than only checking its source text.
let observedHasReference = null;
const rebuildContext = {
  CONSISTENCY_LENS_PROMPTS: {},
  buildRecoverableHeadingIndex: text => `HEADINGS:${text}`,
  buildPacketPromptText: () => "PACKET",
  autoPromptSuffix: () => "SUFFIX",
  maskingPromptSection: hasReference => `MASK:${hasReference}`,
  candidateValidationPromptSection: () => "VALIDATE",
  autoSampleStrategyPrompt: (_strategy, hasReference) => {
    observedHasReference = hasReference;
    return "STRATEGY";
  },
  recoveryPacketDefinition: packet => ({ packet_id: String(packet.packetId || "") }),
  packetPromptFileName: () => "PROMPT.txt",
  packetTextFileName: () => "TEXT.txt",
  packetPdfFileName: () => "PACKET.pdf",
};
vm.runInNewContext(`${retryPayloadSource}\nthis.__rebuild = buildRecoverableRetryPayload;`, rebuildContext);
const rebuiltProofread = rebuildContext.__rebuild(
  { packetId: "P1_S2", kind: "proofread", targetCheckPages: [1], referenceSections: [] },
  { stage_index: 1, stage_total: 1 },
  "proofread source text",
);
if (!rebuiltProofread?.prompt || observedHasReference !== false) {
  throw new Error("再訪proofread payload rebuildが実行時にsource-bound参照なしを処理できない");
}
let missingReferenceRejected = false;
try {
  rebuildContext.__rebuild(
    { packetId: "P1_S2", kind: "proofread", targetCheckPages: [1], referenceSections: [{ pages: [1] }] },
    { stage_index: 1, stage_total: 1 },
    "proofread source text",
  );
} catch { missingReferenceRejected = true; }
if (!missingReferenceRejected) throw new Error("未解決の比較資料をsource-bound retryへ渡している");

// The recovery reference resolver rejects same-name ambiguity, different
// bytes, and page-count drift before it exposes a document to rebuild.
const referenceStart = html.indexOf("async function recoveryReferenceFor(section)");
const referenceEnd = html.indexOf("\n    function buildRecoverableHeadingIndex", referenceStart);
const referenceSource = referenceStart >= 0 && referenceEnd > referenceStart ? html.slice(referenceStart, referenceEnd) : "";
const referenceContext = {
  referenceList: [],
  sha256HexBytes: async bytes => String(bytes?.hash || ""),
};
vm.runInNewContext(`${referenceSource}\nthis.__resolveReference = recoveryReferenceFor;`, referenceContext);
const sameNameA = { fileName: "日本語.pdf", bytes: { hash: "a".repeat(64) }, doc: {}, totalPages: 3 };
const sameNameB = { fileName: "日本語.pdf", bytes: { hash: "b".repeat(64) }, doc: {}, totalPages: 3 };
referenceContext.referenceList = [sameNameA, sameNameB];
if (await referenceContext.__resolveReference({ originalFileName: "日本語.pdf", totalPages: 3, sourcePageCount: 3, sourceSha256: "a".repeat(64) })) {
  throw new Error("同名REFの重複候補をsource-bound recoveryが受理している");
}
referenceContext.referenceList = [sameNameA];
if (await referenceContext.__resolveReference({ originalFileName: "日本語.pdf", totalPages: 3, sourcePageCount: 3, sourceSha256: "b".repeat(64) })) {
  throw new Error("同名別内容のREFをsource-bound recoveryが受理している");
}
if (await referenceContext.__resolveReference({ originalFileName: "日本語.pdf", totalPages: 4, sourcePageCount: 4, sourceSha256: "a".repeat(64) })) {
  throw new Error("REF page count mismatchをsource-bound recoveryが受理している");
}
if ((await referenceContext.__resolveReference({ originalFileName: "日本語.pdf", totalPages: 3, sourcePageCount: 3, sourceSha256: "a".repeat(64) })) !== sameNameA) {
  throw new Error("一致するREF source bindingを復元できない");
}

// Exercise the real submitter after a warning result was acknowledged.  The
// POST body must be a fresh root payload, not a retry that names the deleted
// parent chain.
const submitStart = html.indexOf("function recoveryStateForRetry(state)");
const submitEnd = html.indexOf("\n    async function waitForCopilotPreparation", submitStart);
const submitSource = submitStart >= 0 && submitEnd > submitStart ? html.slice(submitStart, submitEnd) : "";
const submittedRequests = [];
const submitContext = {
  acknowledgedReviewJobIds: new Set(["chain:warning-chain"]),
  originalPdfSha256: "a".repeat(64),
  originalFileName: "target.pdf",
  totalPages: 1,
  MASKING_ENABLED: true,
  setAutoCard: () => {},
  buildRecoveryMetadata: packets => ({ packets }),
  fetch: async (_url, options) => {
    submittedRequests.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ job_id: "new-root-job" }) };
  },
  pollAutoReviewJob: async (jobId, mergeBaseState) => ({ id: jobId, mergeBaseState }),
};
vm.runInNewContext(`${submitSource}\nthis.__submit = submitAndPollAutoJob;`, submitContext);
await submitContext.__submit(
  [{ packet_id: "P1_S2", prompt: "rebuilt", text: "masked", target_pages: [1] }],
  { id: "old-warning-job", recovery_chain_id: "warning-chain", recovery_parent_job_id: "old-warning-job" },
);
const rootBody = submittedRequests[0];
if (!rootBody || rootBody.recovery_chain_id || rootBody.recovery_parent_job_id || rootBody.recovery_ancestor_job_ids) {
  throw new Error("warning ACK後のretryが削除済みrecovery chainを再送している");
}

// A closed tab must not make a terminal result disappear before the client can
// reconnect.  Inputs are removed promptly, while signed result checkpoints
// and the journal remain until explicit ack or the finite retention deadline.
for (const marker of [
  "function Get-KoseiRecoverableJobState",
  "function Acknowledge-KoseiJobResult",
  "function Get-KoseiRecoveryChainStates",
  "function Acknowledge-KoseiRecoveryChain",
  "function Invoke-KoseiRetainedRecoverySweep",
  "result_retained = $true",
  "recovery_checkpoint_ready = $false",
  "Test-KoseiRecoveryCheckpointReady",
  "Remove-KoseiJobInputArtifacts -State $State",
  "Test-KoseiTerminalJobMode -State $state -and [bool]$state.result_retained",
]) {
  if (!review.includes(marker)) throw new Error("terminal結果保持の" + marker + "がない");
}
for (const marker of [
  "path -eq '/api/review/recoverable'",
  "path -eq '/api/review/recoverable/result'",
  "path -eq '/api/review/recoverable/ack'",
  "/api/review/jobs/([0-9a-f]{32})/ack",
  'fetch("/api/review/recoverable"',
  "restoreRecoverableJobAfterTargetLoad",
  "acknowledgeRecoveredJob",
]) {
  if (!server.includes(marker) && !html.includes(marker)) throw new Error("結果再接続の" + marker + "がない");
}
if (!html.includes("await acknowledgeRecoveredJob(descriptor.id")
  || !html.includes("if (pendingRecoverableJob) {")
  || !html.includes("restoreRecoverableJobAfterTargetLoad().catch")
  || !html.includes('recoveredMode === "done"')
  || !html.includes('recoveredMode === "needs_user_visibility"')) {
  throw new Error("再読込後の結果import成功時だけackする導線がない");
}
for (const marker of [
  "function Get-KoseiRecoveryChainRootState",
  "function Resolve-KoseiRecoverySourceBinding",
  "Test-KoseiRecoveryChainHasActiveDescendant",
  "Set-KoseiRecoveryChainRetentionDeadline",
]) {
  if (!review.includes(marker)) throw new Error("retry lineage/期限回帰の" + marker + "がない");
}

console.log("Test-AutoReviewVisibilityResume: PASS");
