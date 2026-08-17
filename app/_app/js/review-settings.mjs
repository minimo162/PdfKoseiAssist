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
