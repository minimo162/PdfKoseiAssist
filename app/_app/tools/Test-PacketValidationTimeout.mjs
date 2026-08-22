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
if (!renderSource.includes("opListTimeoutMs = timeoutMs") ||
    !renderSource.includes("page.getOperatorList(),")) {
  throw new Error("表示確認がoperatorList検証（worker駆動・背面でも停止しない）になっていません");
}
if (renderSource.includes("page.render(") || renderSource.includes("getViewport(")) {
  throw new Error("表示確認にcanvas描画が残っています");
}
if (!renderSource.includes("for (let attempt = 1; attempt <= 2; attempt += 1)") ||
    !renderSource.includes("lastError = null;\n            break;")) {
  throw new Error("描画timeout時の限定再試行がありません");
}
if (!renderSource.includes("pageLabel = \"\"") ||
    !renderSource.includes("const displayLabel = String(pageLabel || \"\") || `PDF P.${pageNo}`;")) {
  throw new Error("表示確認メッセージの役割ラベル経路がありません");
}
if (!renderSource.includes("error?.packetValidationTimeout !== true || attempt >= 2")) {
  throw new Error("再試行はtimeout時限定になっていません");
}
if (runtimeHtml.includes("表示確認を継続できません") ||
    renderSource.includes("document.hidden") ||
    originalSource.includes("document.hidden") ||
    generatedSource.includes("document.hidden")) {
  throw new Error("worker駆動検証に背面タブ依存が残っています");
}
if (!originalSource.includes("spec.doc,\n          spec.pageNo,\n          PACKET_PAGE_VALIDATION_TIMEOUT_MS,\n          PACKET_RENDER_VALIDATION_TIMEOUT_MS,\n          `${spec.role} P.${spec.pageNo}`,")) {
  throw new Error("元PDF検証がページ読込20秒・描画90秒・役割ラベルを渡していません");
}
if (!generatedSource.includes("timeoutMs < PACKET_PAGE_VALIDATION_TIMEOUT_MS") ||
    !generatedSource.includes("Math.max(timeoutMs, PACKET_RENDER_VALIDATION_TIMEOUT_MS)") ||
    !generatedSource.includes("spec.packetPageNo, timeoutMs, opListTimeoutMs, `${spec.role} 出力PDF P.${spec.packetPageNo}`")) {
  throw new Error("通常実行と明示的な短時間テストを分ける表示確認timeout選択がありません");
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

let opListAttemptCount = 0;
let pageCleaned = false;
const hangingOpListPage = {
  getOperatorList: () => {
    opListAttemptCount += 1;
    return new Promise(() => {});
  },
  cleanup() { pageCleaned = true; },
};
await expectTimedOut(
  validateRenderable({ getPage: async () => hangingOpListPage }, 22, 10),
  "表示確認停止",
);
if (opListAttemptCount !== 2 || !pageCleaned) {
  throw new Error(`表示確認停止時の再試行と後始末が不正です: attempts=${opListAttemptCount} cleanup=${pageCleaned}`);
}

let recoveringAttempts = 0;
const recoveringOpListPage = {
  getOperatorList: () => {
    recoveringAttempts += 1;
    return recoveringAttempts === 1
      ? new Promise(() => {})
      : Promise.resolve({ fnArray: [], argsArray: [] });
  },
  cleanup() {},
};
await validateRenderable({ getPage: async () => recoveringOpListPage }, 22, 10);
if (recoveringAttempts !== 2) {
  throw new Error(`再試行での復帰が不正です: attempts=${recoveringAttempts}`);
}

fakeDocument.hidden = true;
let hiddenStallAttempts = 0;
const hiddenStallPage = {
  getOperatorList: () => {
    hiddenStallAttempts += 1;
    return new Promise(() => {});
  },
  cleanup() {},
};
try {
  const hiddenError = await expectTimedOut(
    validateRenderable({ getPage: async () => hiddenStallPage }, 22, 10),
    "背面中の表示確認停止",
  );
  if (hiddenStallAttempts !== 2) {
    throw new Error(`worker駆動検証は背面でも再試行します: attempts=${hiddenStallAttempts}`);
  }
  if (String(hiddenError.message).includes("アプリのタブが背面")) {
    throw new Error(`不要な背面ヒントが残っています: ${hiddenError.message}`);
  }
} finally {
  fakeDocument.hidden = false;
}

let nonTimeoutAttempts = 0;
const failingOpListPage = {
  getOperatorList: () => {
    nonTimeoutAttempts += 1;
    return Promise.reject(new Error("boom"));
  },
  cleanup() {},
};
let boomError = null;
try { await validateRenderable({ getPage: async () => failingOpListPage }, 22, 10); } catch (caught) { boomError = caught; }
if (!boomError || String(boomError.message) !== "boom" || nonTimeoutAttempts !== 1) {
  throw new Error(`非timeoutエラーは再試行しません: ${String(boomError)} attempts=${nonTimeoutAttempts}`);
}
fakeDocument.hidden = true;
try {
  let hiddenBoom = null;
  try { await validateRenderable({ getPage: async () => failingOpListPage }, 22, 10); } catch (caught) { hiddenBoom = caught; }
  if (!hiddenBoom || String(hiddenBoom.message) !== "boom") {
    throw new Error(`非timeoutエラーに背面ヒントを付与しました: ${String(hiddenBoom)}`);
  }
} finally {
  fakeDocument.hidden = false;
}

let unlabeledAttempts = 0;
const unlabeledOpListPage = {
  getOperatorList: () => {
    unlabeledAttempts += 1;
    return new Promise(() => {});
  },
  cleanup() {},
};
const unlabeledError = await expectTimedOut(
  validateRenderable({ getPage: async () => unlabeledOpListPage }, 22, 10),
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
  validatePdfJsRenderablePage: async (_doc, pageNo, pageLoadTimeoutMs, opListTimeoutMs, pageLabel) => {
    originalRenderCalls.push({ pageNo, pageLoadTimeoutMs, opListTimeoutMs, pageLabel });
  },
});
const originalValidation = await validateOriginal({ packetId: "PACKET_001" });
if (originalRenderCalls.length !== 1 ||
    originalRenderCalls[0].pageNo !== 12 ||
    originalRenderCalls[0].pageLoadTimeoutMs !== 20000 ||
    originalRenderCalls[0].opListTimeoutMs !== 90000 ||
    originalRenderCalls[0].pageLabel !== "TARGET_CHECK P.12") {
  throw new Error(`元PDF P.12のtimeout分離・役割ラベルが不正です: ${JSON.stringify(originalRenderCalls)}`);
}
if (originalValidation.probes.length !== 1 || originalValidation.textlessPages.length !== 0) {
  throw new Error(`元PDF検証の後続テキスト確認が壊れています: ${JSON.stringify(originalValidation)}`);
}

const hiddenGuardCalls = [];
const validateWhileHidden = makeOriginalValidator({
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
await validateWhileHidden({ packetId: "PACKET_003" });
if (hiddenGuardCalls.length !== 1) {
  throw new Error(`worker駆動検証は背面でも継続します: ${JSON.stringify(hiddenGuardCalls)}`);
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
    validatePdfJsRenderablePage: async (_doc, pageNo, pageLoadTimeoutMs, opListTimeoutMs, pageLabel) => {
      captured.push({ pageNo, pageLoadTimeoutMs, opListTimeoutMs, pageLabel });
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
    defaultRenderTimeouts[0].opListTimeoutMs !== 90000 ||
    defaultRenderTimeouts[0].pageLabel !== "TARGET_CHECK 出力PDF P.1") {
  throw new Error(`通常実行のtimeout分離が不正です: ${JSON.stringify(defaultRenderTimeouts)}`);
}
const explicitRenderTimeouts = await captureGeneratedRenderTimeout(10);
if (explicitRenderTimeouts.length !== 1 ||
    explicitRenderTimeouts[0].pageLoadTimeoutMs !== 10 ||
    explicitRenderTimeouts[0].opListTimeoutMs !== 10 ||
    explicitRenderTimeouts[0].pageLabel !== "TARGET_CHECK 出力PDF P.1") {
  throw new Error(`明示timeoutが尊重されていません: ${JSON.stringify(explicitRenderTimeouts)}`);
}

const generatedHiddenCalls = [];
let hiddenRunDocDestroyed = false;
const validateGeneratedWhileHidden = makeGeneratedValidator({
  documentStub: { hidden: true },
  createPdfDocumentLoadingTask: () => ({
    promise: Promise.resolve({ numPages: 1, destroy() { hiddenRunDocDestroyed = true; } }),
    destroy() {},
  }),
  validatePdfJsRenderablePage: async (...args) => { generatedHiddenCalls.push(args); },
});
await validateGeneratedWhileHidden(
  { packetId: "PACKET_003" },
  new Uint8Array([1]),
  { specs: [{ role: "TARGET_CHECK", sourceKind: "target", pageNo: 15, packetPageNo: 1, fileName: "target.pdf" }], probes: [] },
  10,
);
if (generatedHiddenCalls.length !== 1) {
  throw new Error(`worker駆動検証は背面でも出力PDF検証を継続します: ${JSON.stringify(generatedHiddenCalls)}`);
}
if (!hiddenRunDocDestroyed) {
  throw new Error("背面での検証完了後に生成PDF documentを破棄していません");
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
