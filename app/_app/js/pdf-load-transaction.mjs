// PDF file staging helpers. Parsing happens before callers commit application state.

function fileNameOf(file, fallback = "document.pdf") {
  return String(file?.name || fallback).trim() || fallback;
}

function assertPdfFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new TypeError("PDFファイルを読み込めませんでした。");
  }
  const name = fileNameOf(file, "選択ファイル.pdf");
  if (!/\.pdf$/i.test(name) && file.type !== "application/pdf") {
    throw new Error(`${name} はPDFではありません。`);
  }
}

function pageCountOf(doc) {
  const totalPages = Number(doc?.numPages);
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error("PDFのページ数を確認できませんでした。");
  }
  return totalPages;
}

function destroyPdfDocumentBestEffort(doc) {
  try {
    const result = doc?.destroy?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

function bytesView(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

function bytesEqual(left, right) {
  const a = bytesView(left);
  const b = bytesView(right);
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function candidateFromBytes(file, bytes, doc, fileNameOverride) {
  return Object.freeze({
    file,
    bytes,
    doc,
    totalPages: pageCountOf(doc),
    fileName: fileNameOverride === undefined ? fileNameOf(file) : String(fileNameOverride || ""),
    byteLength: Number(bytes?.byteLength) || 0,
    fileSize: Number(file?.size) || Number(bytes?.byteLength) || 0,
  });
}

export async function stagePdfCandidate(file, openPdfDocument) {
  assertPdfFile(file);
  if (typeof openPdfDocument !== "function") throw new TypeError("PDF parser is required.");
  const bytes = await file.arrayBuffer();
  const doc = await openPdfDocument(bytes);
  try {
    return candidateFromBytes(file, bytes, doc);
  } catch (error) {
    destroyPdfDocumentBestEffort(doc);
    throw error;
  }
}

export function commitStagedPdfCandidate(candidate, { commit, discard } = {}) {
  if (!candidate || typeof commit !== "function") throw new TypeError("A staged PDF and commit callback are required.");
  try {
    return commit(candidate);
  } catch (error) {
    try { if (typeof discard === "function") discard(candidate); } catch {}
    throw error;
  }
}

function isDuplicateReference(ref, fileName, bytes) {
  const candidateBytes = bytesView(bytes);
  const byteLength = candidateBytes?.byteLength || 0;
  const refBytes = bytesView(ref?.bytes);
  const refByteLength = refBytes ? refBytes.byteLength : (Number(ref?.byteLength) || 0);
  return String(ref?.fileName || "") === fileName
    && refByteLength === byteLength
    && bytesEqual(refBytes, candidateBytes);
}

export async function stageReferencePdfBatch(files, existingReferences, openPdfDocument, { maxFiles = Infinity } = {}) {
  if (typeof openPdfDocument !== "function") throw new TypeError("PDF parser is required.");
  const sourceFiles = Array.from(files || []).filter(Boolean);
  const existing = Array.isArray(existingReferences) ? existingReferences : [];
  const pending = [];
  const skipped = [];
  for (const file of sourceFiles) {
    assertPdfFile(file);
    const bytes = await file.arrayBuffer();
    const fileName = fileNameOf(file, "");
    if ([...existing, ...pending].some(ref => isDuplicateReference(ref, fileName, bytes))) {
      skipped.push(file);
      continue;
    }
    pending.push({ file, bytes, fileName });
  }
  if (Number.isFinite(maxFiles) && existing.length + pending.length > maxFiles) {
    return { limited: true, candidates: [], skipped, files: sourceFiles };
  }

  const candidates = [];
  try {
    for (const item of pending) {
      const doc = await openPdfDocument(item.bytes);
      try {
        const assignedName = item.fileName || `reference_${existing.length + candidates.length + 1}.pdf`;
        candidates.push(candidateFromBytes(item.file, item.bytes, doc, assignedName));
      } catch (error) {
        destroyPdfDocumentBestEffort(doc);
        throw error;
      }
    }
  } catch (error) {
    for (const candidate of candidates) destroyPdfDocumentBestEffort(candidate.doc);
    throw error;
  }
  return { limited: false, candidates, skipped, files: sourceFiles };
}
