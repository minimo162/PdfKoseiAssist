// UI state contract for the optional reference range and always-available review settings.

export function reviewControlState(hasReference) {
  const referenceEnabled = Boolean(hasReference);
  return Object.freeze({
    referenceRangeDisabled: !referenceEnabled,
    autoReferenceRangeDisabled: !referenceEnabled,
    reviewSettingsDisabled: false,
  });
}

export function applyReferenceBufferSetting(references, value, min = 0, max = 8) {
  const numeric = Number(value);
  const fallback = Number.isFinite(Number(min)) ? Number(min) : 0;
  const lower = Math.min(fallback, Number(max));
  const upper = Math.max(fallback, Number(max));
  const bufferPages = Number.isFinite(numeric)
    ? Math.min(upper, Math.max(lower, Math.round(numeric)))
    : lower;
  return Object.freeze({
    bufferPages,
    references: Object.freeze(Array.from(references || [], ref => ref && ({ ...ref, bufferPages }))),
  });
}

function integerClamp(value, min, max) {
  const lower = Math.min(Number(min), Number(max));
  const upper = Math.max(Number(min), Number(max));
  return Math.min(upper, Math.max(lower, Math.round(Number(value))));
}

function rangeArray(start, end) {
  const a = Math.max(1, Math.round(Number(start) || 1));
  const b = Math.max(a, Math.round(Number(end) || a));
  return Array.from({ length: b - a + 1 }, (_, index) => a + index);
}

/**
 * Validate one user-entered reference range against every reference document
 * before replacing any list item. The returned list is a clone so a failed
 * parser call cannot partially mutate the active reference state.
 */
export function applyReferenceRangeSetting(references, value, parseRange, formatRange = pages => pages.join(", ")) {
  if (typeof parseRange !== "function") throw new TypeError("A reference range parser is required.");
  const source = Array.from(references || []);
  const text = String(value ?? "").trim();
  if (!text) {
    return Object.freeze({
      rangeText: "",
      references: Object.freeze(source.map(ref => ref && ({ ...ref, rangeText: "" }))),
    });
  }
  const staged = source.map(ref => {
    if (!ref) return ref;
    const pages = parseRange(text, ref.totalPages);
    if (!Array.isArray(pages) || !pages.length) throw new Error("比較資料のページ範囲を確認してください。");
    const normalized = typeof formatRange === "function" ? formatRange(pages) : text;
    return { ...ref, rangeText: String(normalized || text).trim() || text };
  });
  const normalizedText = staged.find(Boolean)?.rangeText || text;
  return Object.freeze({ rangeText: normalizedText, references: Object.freeze(staged) });
}

/**
 * Resolve the comparison candidate pages for one reference item. This is
 * shared with the UI so a configured zero buffer remains zero rather than
 * falling through to the default buffer.
 */
export function referencePagesForItem(ref, pages, {
  targetTotalPages = 0,
  defaultBuffer = 3,
  minBuffer = 0,
  maxBuffer = 8,
  parseRange,
} = {}) {
  if (!ref || !Array.isArray(pages) || !pages.length) return [];
  const totalReferencePages = Number(ref.totalPages);
  if (!Number.isInteger(totalReferencePages) || totalReferencePages < 1) return [];
  const manualRange = String(ref.rangeText || "").trim();
  if (manualRange) {
    if (typeof parseRange !== "function") throw new TypeError("A reference range parser is required.");
    return parseRange(manualRange, totalReferencePages);
  }
  if (ref.mode === "all") return rangeArray(1, totalReferencePages);
  const numericBuffer = Number(ref.bufferPages);
  const fallbackBuffer = Number.isFinite(Number(defaultBuffer)) ? Number(defaultBuffer) : 0;
  const buffer = integerClamp(Number.isFinite(numericBuffer) ? numericBuffer : fallbackBuffer, minBuffer, maxBuffer);
  const targetTotal = Math.max(1, Number(targetTotalPages) || pages.length);
  const start = Math.min(...pages);
  const end = Math.max(...pages);
  const rawStart = 1 + Math.floor((start - 1) * totalReferencePages / targetTotal);
  const rawEnd = Math.ceil(end * totalReferencePages / targetTotal);
  return rangeArray(
    integerClamp(rawStart - buffer, 1, totalReferencePages),
    integerClamp(rawEnd + buffer, 1, totalReferencePages),
  );
}

export function loadResultAccepted(result, { requireAdded = false } = {}) {
  return Boolean(result?.ok) && (!requireAdded || Number(result.addedCount) > 0);
}

export function referenceRangeModeAfterAction(currentMode, action) {
  if (action === "manual-input") return false;
  if (action === "explicit-auto" || action === "empty-input") return true;
  return Boolean(currentMode);
}

/**
 * Infer the dominant document language from extracted PDF text.
 *
 * This is intentionally a conservative, local heuristic rather than a
 * translation/model call: language is only used to make the Copilot prompt
 * less error-prone and must not block loading a PDF.  Kana is a strong
 * Japanese signal; Han-only text is left as "その他" because it may be
 * Chinese.  A short or image-only document also returns "その他".
 */
export function detectDocumentLanguage(text) {
  const value = String(text ?? "");
  if (!value.trim()) return "その他";
  const kana = (value.match(/[\u3040-\u30ff\u31f0-\u31ff]/g) || []).length;
  const han = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const hangul = (value.match(/[\uac00-\ud7af]/g) || []).length;
  const cyrillic = (value.match(/[\u0400-\u04ff]/g) || []).length;
  const arabic = (value.match(/[\u0600-\u06ff]/g) || []).length;
  const meaningful = kana + han + latin + hangul + cyrillic + arabic;
  if (!meaningful) return "その他";
  // Even a small amount of kana is decisive in accounting PDFs where most
  // characters are numbers, punctuation, or Latin company names.
  if (kana >= 2 || (kana > 0 && kana * 3 >= han)) return "日本語";
  if (latin >= 8 && latin >= (han + hangul + cyrillic + arabic) * 2) return "英語";
  return "その他";
}

export function mergeDetectedDocumentLanguages(languages) {
  const values = Array.from(languages || [], value => String(value || "その他").trim() || "その他");
  if (!values.length) return "その他";
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : "その他";
}

/**
 * Prevent a slow PDF text extraction from committing after its source was
 * replaced or removed.  Source identity is intentional: two documents can
 * have the same page count and generation values must not be enough to make
 * an old result current again.
 */
export function languageDetectionSnapshotIsCurrent(snapshot, current) {
  if (!snapshot || !current) return false;
  if (snapshot.source !== current.source || snapshot.generation !== current.generation) return false;
  if (snapshot.pageCount !== undefined && snapshot.pageCount !== current.pageCount) return false;
  return true;
}
