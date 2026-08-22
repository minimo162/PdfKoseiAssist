// Test-PacketValidationTimeout.mjs — PDF検証が応答しなくてもtimeoutし、必ず資源を解放する。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const runtimePolicy = JSON.parse(readFileSync(join(here, "..", "config", "runtime-html-policy.json"), "utf8"));

function literalCount(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function applyRuntimeHtmlPolicy(source) {
  if (!source.includes(runtimePolicy.source_marker)) {
    throw new Error(`実行時HTMLポリシーのmarkerが見つかりません: ${runtimePolicy.source_marker}`);
  }
  const normalized = source.replace(/\r\n?/g, "\n");
  for (const replacement of runtimePolicy.replacements || []) {
    const count = literalCount(normalized, replacement.old);
    if (count !== 1) {
      throw new Error(`実行時HTMLポリシー ${replacement.name} の一致数が${count}です`);
    }
  }
  return (runtimePolicy.replacements || []).reduce(
    (current, replacement) => current.replace(replacement.old, replacement.new),
    normalized,
  );
}

const runtimeHtml = applyRuntimeHtmlPolicy(html);
if (!runtimeHtml.includes("const PACKET_PAGE_VALIDATION_TIMEOUT_MS = 20000;")) {
  throw new Error("ページ読込・テキスト確認の20秒上限を維持していません");
}
if (!runtimeHtml.includes("const PACKET_RENDER_VALIDATION_TIMEOUT_MS = 90000;")) {
  throw new Error("PDF描画確認専用の90秒上限がありません");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) throw new Error(`本番関数を切り出せません: ${startMarker}`);
  return source.slice(start, end);
}

const timeoutSource = sourceBetween(runtimeHtml, "function withPacketBuildTimeout", "function textItemNumber");
const renderSource = sourceBetween(runtimeHtml, "async function validatePdfJsRenderablePage", "function normalizeTextLayerProbe");
const originalSource = sourceBetween(runtimeHtml, "async function validateOriginalTextLayersForPacket", "async function validateGeneratedPacketTextLayer");
const generatedSource = sourceBetween(runtimeHtml, "async function validateGeneratedPacketTextLayer", "function uint8ArrayCopyForPdfJsExtract");
if (!renderSource.includes("getViewport({ scale: 0.20 })")) {
  throw new Error("表示確認の描画縮尺が0.20になっていません");
}
if (!renderSource.includes("renderTimeoutMs = timeoutMs") ||
    !renderSource.includes("renderTask.promise,\n              renderTimeoutMs")) {
  throw new Error("ページ読込と描画のtimeoutが分離されていません");
}
if (!renderSource.includes("for (let attempt = 1; attempt <= 2; attempt += 1)") ||
    !renderSource.includes("lastError = null;\n            break;")) {
  throw new Error("描画timeout時の限定再試行がありません");
}
if (!renderSource.includes("pageLabel = \"\"") ||
    !renderSource.includes("const displayLabel = String(pageLabel || \"\") || `PDF P.${pageNo}`;")) {
  throw new Error("表示確認メッセージの役割ラベル経路がありません");
}
if (!renderSource.includes("error?.packetValidationTimeout !== true || tabHiddenNow || attempt >= 2") ||
    !renderSource.includes("lastError.packetValidationTimeout === true && typeof document !== \"undefined\" && document.hidden === true")) {
  throw new Error("再試行はtimeout時限定で、背面タブでは再試行しない制御がありません");
}
if (!renderSource.includes("lastError.message = `${lastError.message}（アプリのタブが背面のため")) {
  throw new Error("背面タブでの描画停止ヒント付与がありません");
}
if (!originalSource.includes("元PDFの表示確認を継続できません") ||
    !originalSource.includes("typeof document !== \"undefined\" && document.hidden === true")) {
  throw new Error("元PDF検証の途中背面検出がありません");
}
if (!originalSource.includes("spec.doc,\n          spec.pageNo,\n          PACKET_PAGE_VALIDATION_TIMEOUT_MS,\n          PACKET_RENDER_VALIDATION_TIMEOUT_MS,\n          `${spec.role} P.${spec.pageNo}`,")) {
  throw new Error("元PDF検証がページ読込20秒・描画90秒・役割ラベルを渡していません");
}
if (!generatedSource.includes("出力PDFの表示確認を継続できません")) {
  throw new Error("出力PDF検証の途中背面検出がありません");
}
if (!generatedSource.includes("timeoutMs < PACKET_PAGE_VALIDATION_TIMEOUT_MS") ||
    !generatedSource.includes("Math.max(timeoutMs, PACKET_RENDER_VALIDATION_TIMEOUT_MS)") ||
    !generatedSource.includes("spec.packetPageNo, timeoutMs, renderTimeoutMs, `${spec.role} 出力PDF P.${spec.packetPageNo}`")) {
  throw new Error("通常実行と明示的な短時間テストを分ける描画timeout選択がありません");
}

const fakeDocument = {
  hidden: false,
  createElement() {
    return {
      width: 0,
      height: 0,
      getContext() {
        return { fillStyle: "", fillRect() {} };
      },
    };
  },
};
const makeRenderableValidator = new Function(
  "document",
  "PACKET_PAGE_VALIDATION_TIMEOUT_MS",
  `${timeoutSource}\n${renderSource}\nreturn validatePdfJsRenderablePage;`,
);
const validateRenderable = makeRenderableValidator(fakeDocument, 20000);

async function expectTimedOut(promise, label) {
  const started = Date.now();
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  const elapsed = Date.now() - started;
  if (!error || !/完了しませんでした/.test(String(error.message || error))) {
    throw new Error(`${label}: timeout errorになりません: ${String(error || "resolved")}`);
  }
  if (elapsed > 250) throw new Error(`${label}: timeoutが遅すぎます (${elapsed}ms)`);
  return error;
}

await expectTimedOut(
  validateRenderable({ getPage: () => new Promise(() => {}) }, 22, 10),
  "getPage停止",
);

let renderCancelledCount = 0;
let renderAttemptCount = 0;
let pageCleaned = false;
const hangingRenderPage = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => {
    renderAttemptCount += 1;
    return {
      promise: new Promise(() => {}),
      cancel() { renderCancelledCount += 1; },
    };
  },
  cleanup() { pageCleaned = true; },
};
await expectTimedOut(
  validateRenderable({ getPage: async () => hangingRenderPage }, 22, 10),
  "render停止",
);
if (renderAttemptCount !== 2 || renderCancelledCount !== 2 || !pageCleaned) {
  throw new Error(`render停止時の再試行と後始末が不正です: attempts=${renderAttemptCount} cancel=${renderCancelledCount} cleanup=${pageCleaned}`);
}

fakeDocument.hidden = true;
try {
  const hiddenError = await expectTimedOut(
    validateRenderable({ getPage: async () => hangingRenderPage }, 22, 10),
    "背面render停止",
  );
  if (!String(hiddenError.message).includes("アプリのタブが背面")) {
    throw new Error(`背面タブのヒントがエラー文にありません: ${hiddenError.message}`);
  }
} finally {
  fakeDocument.hidden = false;
}

let recoveringCancels = 0;
let recoveringAttempts = 0;
const recoveringRenderPage = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => {
    recoveringAttempts += 1;
    const first = recoveringAttempts === 1;
    return {
      promise: first ? new Promise(() => {}) : Promise.resolve(),
      cancel() { if (first) recoveringCancels += 1; },
    };
  },
  cleanup() {},
};
await validateRenderable({ getPage: async () => recoveringRenderPage }, 22, 10);
if (recoveringAttempts !== 2 || recoveringCancels !== 1) {
  throw new Error(`再試行での復帰が不正です: attempts=${recoveringAttempts} cancel=${recoveringCancels}`);
}

fakeDocument.hidden = true;
let hiddenStallAttempts = 0;
const hiddenStallPage = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => {
    hiddenStallAttempts += 1;
    return { promise: new Promise(() => {}), cancel() {} };
  },
  cleanup() {},
};
try {
  await expectTimedOut(
    validateRenderable({ getPage: async () => hiddenStallPage }, 22, 10),
    "背面中render停止",
  );
  if (hiddenStallAttempts !== 1) {
    throw new Error(`背面タブでは再試行しません: attempts=${hiddenStallAttempts}`);
  }
} finally {
  fakeDocument.hidden = false;
}

let nonTimeoutAttempts = 0;
const failingRenderPage = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => {
    nonTimeoutAttempts += 1;
    return { promise: Promise.reject(new Error("boom")), cancel() {} };
  },
  cleanup() {},
};
let boomError = null;
try { await validateRenderable({ getPage: async () => failingRenderPage }, 22, 10); } catch (caught) { boomError = caught; }
if (!boomError || String(boomError.message) !== "boom" || nonTimeoutAttempts !== 1) {
  throw new Error(`非timeoutエラーは再試行しません: ${String(boomError)} attempts=${nonTimeoutAttempts}`);
}
fakeDocument.hidden = true;
try {
  let hiddenBoom = null;
  try { await validateRenderable({ getPage: async () => failingRenderPage }, 22, 10); } catch (caught) { hiddenBoom = caught; }
  if (!hiddenBoom || String(hiddenBoom.message) !== "boom") {
    throw new Error(`非timeoutエラーに背面ヒントを付与しました: ${String(hiddenBoom)}`);
  }
} finally {
  fakeDocument.hidden = false;
}

let unlabeledAttempts = 0;
const unlabeledRenderPage = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => {
    unlabeledAttempts += 1;
    return { promise: new Promise(() => {}), cancel() {} };
  },
  cleanup() {},
};
const unlabeledError = await expectTimedOut(
  validateRenderable({ getPage: async () => unlabeledRenderPage }, 22, 10),
  "既定ラベル",
);
if (unlabeledAttempts !== 2 || !String(unlabeledError.message).startsWith("PDF P.22 の表示確認")) {
  throw new Error(`既定ラベルのtimeout文が不正です: attempts=${unlabeledAttempts} ${unlabeledError.message}`);
}

function makeOriginalValidator(dependencies) {
  return new Function(
    "document",
    "packetSourcePageSpecs",
    "setStatus",
    "validatePdfJsRenderablePage",
    "extractTextLayerText",
    "PACKET_PAGE_VALIDATION_TIMEOUT_MS",
    "PACKET_RENDER_VALIDATION_TIMEOUT_MS",
    "textLayerProbeCandidates",
    "diagnosticTextSample",
    "normalizeTextLayerProbe",
    `${timeoutSource}\n${originalSource}\nreturn validateOriginalTextLayersForPacket;`,
  )(
    dependencies.documentStub || { hidden: false },
    () => dependencies.specs || [],
    dependencies.setStatus || (() => {}),
    dependencies.validatePdfJsRenderablePage || (async () => {}),
    dependencies.extractTextLayerText || (async () => "original-source-token"),
    20000,
    90000,
    dependencies.textLayerProbeCandidates || ((value) => String(value || "").trim() ? ["original-source-token"] : []),
    (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 260),
    (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
  );
}

const originalRenderCalls = [];
const validateOriginal = makeOriginalValidator({
  specs: [{
    doc: { name: "source-doc" },
    pageNo: 12,
    role: "TARGET_CHECK",
    sourceKind: "target",
    packetPageNo: 20,
    fileName: "target.pdf",
  }],
  validatePdfJsRenderablePage: async (_doc, pageNo, pageLoadTimeoutMs, renderTimeoutMs, pageLabel) => {
    originalRenderCalls.push({ pageNo, pageLoadTimeoutMs, renderTimeoutMs, pageLabel });
  },
});
const originalValidation = await validateOriginal({ packetId: "PACKET_001" });
if (originalRenderCalls.length !== 1 ||
    originalRenderCalls[0].pageNo !== 12 ||
    originalRenderCalls[0].pageLoadTimeoutMs !== 20000 ||
    originalRenderCalls[0].renderTimeoutMs !== 90000 ||
    originalRenderCalls[0].pageLabel !== "TARGET_CHECK P.12") {
  throw new Error(`元PDF P.12のtimeout分離・役割ラベルが不正です: ${JSON.stringify(originalRenderCalls)}`);
}
if (originalValidation.probes.length !== 1 || originalValidation.textlessPages.length !== 0) {
  throw new Error(`元PDF検証の後続テキスト確認が壊れています: ${JSON.stringify(originalValidation)}`);
}

const hiddenGuardCalls = [];
const validateHiddenGuard = makeOriginalValidator({
  documentStub: { hidden: true },
  specs: [{
    doc: { name: "source-doc" },
    pageNo: 12,
    role: "TARGET_CHECK",
    sourceKind: "target",
    packetPageNo: 20,
    fileName: "target.pdf",
  }],
  validatePdfJsRenderablePage: async (...args) => { hiddenGuardCalls.push(args); },
});
let hiddenGuardError = null;
try { await validateHiddenGuard({ packetId: "PACKET_003" }); } catch (caught) { hiddenGuardError = caught; }
if (!hiddenGuardError || !/アプリのタブが背面/.test(String(hiddenGuardError.message))) {
  throw new Error(`背面タブの事前拒否がありません: ${String(hiddenGuardError || "resolved")}`);
}
if (hiddenGuardCalls.length !== 0) {
  throw new Error("背面タブなのに描画確認を開始しました");
}

function packetError(message, cause, diagnostics) {
  const error = new Error(`${message}: ${cause?.message || cause}`);
  error.packetDiagnostics = diagnostics;
  return error;
}
function makeGeneratedValidator(dependencies) {
  return new Function(
    "document",
    "createPdfDocumentLoadingTask",
    "packetFrontMatterPageCount",
    "packetBuildErrorWithDiagnostics",
    "validatePdfJsRenderablePage",
    "setStatus",
    "extractTextLayerText",
    "normalizeTextLayerProbe",
    "diagnosticTextSample",
    "PACKET_PAGE_VALIDATION_TIMEOUT_MS",
    "PACKET_RENDER_VALIDATION_TIMEOUT_MS",
    `${timeoutSource}\n${generatedSource}\nreturn validateGeneratedPacketTextLayer;`,
  )(
    dependencies.documentStub || { hidden: false },
    dependencies.createPdfDocumentLoadingTask,
    () => 0,
    packetError,
    dependencies.validatePdfJsRenderablePage || (async () => {}),
    dependencies.setStatus || (() => {}),
    dependencies.extractTextLayerText || (async () => "token"),
    (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
    (value) => String(value || "").slice(0, 220),
    20000,
    90000,
  );
}

let loadingTaskDestroyed = false;
const validateLoadingTimeout = makeGeneratedValidator({
  createPdfDocumentLoadingTask: () => ({
    promise: new Promise(() => {}),
    destroy() { loadingTaskDestroyed = true; },
  }),
});
await expectTimedOut(
  validateLoadingTimeout({ packetId: "PACKET_002" }, new Uint8Array([1]), {}, 10),
  "生成PDF読込停止",
);
if (!loadingTaskDestroyed) throw new Error("生成PDF読込timeout時にloading taskを破棄していません");

let generatedDocDestroyed = false;
const failedStatuses = [];
const generatedDoc = {
  numPages: 0,
  destroy() { generatedDocDestroyed = true; },
};
const validateTextTimeout = makeGeneratedValidator({
  createPdfDocumentLoadingTask: () => ({ promise: Promise.resolve(generatedDoc), destroy() {} }),
  setStatus: (value) => failedStatuses.push(value),
  extractTextLayerText: () => new Promise(() => {}),
});
await expectTimedOut(
  validateTextTimeout(
    { packetId: "PACKET_002" },
    new Uint8Array([1]),
    { specs: [], probes: [{ role: "対象PDF", pageNo: 14, packetPageNo: 22, candidates: ["token"] }] },
    10,
  ),
  "text取得停止",
);
if (!generatedDocDestroyed) throw new Error("text取得timeout時に生成PDF documentを破棄していません");
if (failedStatuses.some((value) => String(value).includes("検証が完了しました"))) {
  throw new Error("失敗した検証を成功statusとして表示しました");
}

async function captureGeneratedRenderTimeout(timeoutMs) {
  const captured = [];
  let destroyed = false;
  const validate = makeGeneratedValidator({
    createPdfDocumentLoadingTask: () => ({
      promise: Promise.resolve({ numPages: 1, destroy() { destroyed = true; } }),
      destroy() {},
    }),
    validatePdfJsRenderablePage: async (_doc, pageNo, pageLoadTimeoutMs, renderTimeoutMs, pageLabel) => {
      captured.push({ pageNo, pageLoadTimeoutMs, renderTimeoutMs, pageLabel });
    },
  });
  await validate(
    { packetId: "PACKET_002" },
    new Uint8Array([1]),
    { specs: [{ role: "TARGET_CHECK", sourceKind: "target", pageNo: 15, packetPageNo: 1, fileName: "target.pdf" }], probes: [] },
    timeoutMs,
  );
  if (!destroyed) throw new Error("描画timeout確認後に生成PDF documentを破棄していません");
  return captured;
}

const defaultRenderTimeouts = await captureGeneratedRenderTimeout(20000);
if (defaultRenderTimeouts.length !== 1 ||
    defaultRenderTimeouts[0].pageLoadTimeoutMs !== 20000 ||
    defaultRenderTimeouts[0].renderTimeoutMs !== 90000 ||
    defaultRenderTimeouts[0].pageLabel !== "TARGET_CHECK 出力PDF P.1") {
  throw new Error(`通常実行のtimeout分離が不正です: ${JSON.stringify(defaultRenderTimeouts)}`);
}
const explicitRenderTimeouts = await captureGeneratedRenderTimeout(10);
if (explicitRenderTimeouts.length !== 1 ||
    explicitRenderTimeouts[0].pageLoadTimeoutMs !== 10 ||
    explicitRenderTimeouts[0].renderTimeoutMs !== 10 ||
    explicitRenderTimeouts[0].pageLabel !== "TARGET_CHECK 出力PDF P.1") {
  throw new Error(`明示timeoutが尊重されていません: ${JSON.stringify(explicitRenderTimeouts)}`);
}

const generatedHiddenGuardCalls = [];
let hiddenGuardDocDestroyed = false;
const validateGeneratedHiddenGuard = makeGeneratedValidator({
  documentStub: { hidden: true },
  createPdfDocumentLoadingTask: () => ({
    promise: Promise.resolve({ numPages: 1, destroy() { hiddenGuardDocDestroyed = true; } }),
    destroy() {},
  }),
  validatePdfJsRenderablePage: async (...args) => { generatedHiddenGuardCalls.push(args); },
});
let generatedGuardError = null;
try {
  await validateGeneratedHiddenGuard(
    { packetId: "PACKET_003" },
    new Uint8Array([1]),
    { specs: [{ role: "TARGET_CHECK", sourceKind: "target", pageNo: 15, packetPageNo: 1, fileName: "target.pdf" }], probes: [] },
    10,
  );
} catch (caught) { generatedGuardError = caught; }
if (!generatedGuardError || !/出力PDFの表示確認を継続できません/.test(String(guardMessageOf(generatedGuardError)))) {
  throw new Error(`出力PDF検証の背面タブ事前拒否がありません: ${String(generatedGuardError || "resolved")}`);
}
if (generatedHiddenGuardCalls.length !== 0) {
  throw new Error("背面タブなのに出力PDFの描画確認を開始しました");
}
if (!hiddenGuardDocDestroyed) {
  throw new Error("背面タブ拒否時に生成PDF documentを破棄していません");
}

function guardMessageOf(error) {
  return String(error?.cause?.message || error?.message || error);
}

const successfulStatuses = [];
let successfulDocDestroyed = false;
const validateSuccess = makeGeneratedValidator({
  createPdfDocumentLoadingTask: () => ({
    promise: Promise.resolve({ numPages: 0, destroy() { successfulDocDestroyed = true; } }),
    destroy() {},
  }),
  setStatus: (value) => successfulStatuses.push(value),
});
await validateSuccess({ packetId: "PACKET_002" }, new Uint8Array([1]), { specs: [], probes: [] }, 10);
if (!successfulDocDestroyed) throw new Error("成功時に生成PDF documentを破棄していません");
if (!String(successfulStatuses.at(-1) || "").includes("確認用PDFの検証が完了しました")) {
  throw new Error(`全検証後の成功statusがありません: ${JSON.stringify(successfulStatuses)}`);
}

console.log("Test-PacketValidationTimeout: PASS");
