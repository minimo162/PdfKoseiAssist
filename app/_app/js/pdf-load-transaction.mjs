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
  return candidateFromBytes(file, bytes, doc);
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

function isDuplicateReference(ref, fileName, byteLength) {
  return String(ref?.fileName || "") === fileName
    && Number(ref?.byteLength) === byteLength;
}

export async function stageReferencePdfBatch(files, existingReferences, openPdfDocument, { maxFiles = Infinity } = {}) {
  if (typeof openPdfDocument !== "function") throw new TypeError("PDF parser is required.");
  const sourceFiles = Array.from(files || []).filter(Boolean);
  const existing = Array.isArray(existingReferences) ? existingReferences : [];
  if (Number.isFinite(maxFiles) && existing.length + sourceFiles.length > maxFiles) {
    return { limited: true, candidates: [], skipped: [], files: sourceFiles };
  }

  const candidates = [];
  const skipped = [];
  for (const file of sourceFiles) {
    assertPdfFile(file);
    const bytes = await file.arrayBuffer();
    const fileName = String(file?.name || "");
    const byteLength = Number(bytes?.byteLength) || 0;
    if ([...existing, ...candidates].some(ref => isDuplicateReference(ref, fileName, byteLength))) {
      skipped.push(file);
      continue;
    }
    const doc = await openPdfDocument(bytes);
    const assignedName = fileName || `reference_${existing.length + candidates.length + 1}.pdf`;
    candidates.push(candidateFromBytes(file, bytes, doc, assignedName));
  }
  return { limited: false, candidates, skipped, files: sourceFiles };
}
