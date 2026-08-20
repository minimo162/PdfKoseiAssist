// Test-PacketValidationTimeout.mjs — PDF検証が応答しなくてもtimeoutし、必ず資源を解放する。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = start >= 0 ? html.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) throw new Error(`本番関数を切り出せません: ${startMarker}`);
  return html.slice(start, end);
}

const timeoutSource = sourceBetween("function withPacketBuildTimeout", "function textItemNumber");
const renderSource = sourceBetween("async function validatePdfJsRenderablePage", "function normalizeTextLayerProbe");
const generatedSource = sourceBetween("async function validateGeneratedPacketTextLayer", "function uint8ArrayCopyForPdfJsExtract");

const fakeDocument = {
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
}

await expectTimedOut(
  validateRenderable({ getPage: () => new Promise(() => {}) }, 22, 10),
  "getPage停止",
);

let renderCancelled = false;
let pageCleaned = false;
const hangingRenderPage = {
  getViewport: () => ({ width: 100, height: 100 }),
  render: () => ({
    promise: new Promise(() => {}),
    cancel() { renderCancelled = true; },
  }),
  cleanup() { pageCleaned = true; },
};
await expectTimedOut(
  validateRenderable({ getPage: async () => hangingRenderPage }, 22, 10),
  "render停止",
);
if (!renderCancelled || !pageCleaned) {
  throw new Error(`render停止時の後始末が不足しています: cancel=${renderCancelled} cleanup=${pageCleaned}`);
}

function packetError(message, cause, diagnostics) {
  const error = new Error(`${message}: ${cause?.message || cause}`);
  error.packetDiagnostics = diagnostics;
  return error;
}
function makeGeneratedValidator(dependencies) {
  return new Function(
    "createPdfDocumentLoadingTask",
    "packetFrontMatterPageCount",
    "packetBuildErrorWithDiagnostics",
    "validatePdfJsRenderablePage",
    "setStatus",
    "extractTextLayerText",
    "normalizeTextLayerProbe",
    "diagnosticTextSample",
    "PACKET_PAGE_VALIDATION_TIMEOUT_MS",
    `${timeoutSource}\n${generatedSource}\nreturn validateGeneratedPacketTextLayer;`,
  )(
    dependencies.createPdfDocumentLoadingTask,
    () => 0,
    packetError,
    dependencies.validatePdfJsRenderablePage || (async () => {}),
    dependencies.setStatus || (() => {}),
    dependencies.extractTextLayerText || (async () => "token"),
    (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
    (value) => String(value || "").slice(0, 220),
    20000,
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
