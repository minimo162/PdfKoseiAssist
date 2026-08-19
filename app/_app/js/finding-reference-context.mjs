// Shared normalization for comparison findings arriving from Copilot or saved JSON.
const PAGE_KEYS = Object.freeze([
  "reference_pages", "referencePages", "ref_pages", "refPages",
  "reference_page", "referencePage", "ref_page", "refPage",
]);
const FILE_KEYS = Object.freeze([
  "reference_file", "referenceFile", "ref_file", "refFile",
]);
const QUOTE_KEYS = Object.freeze([
  "reference_quote", "referenceQuote", "ref_quote", "refQuote",
]);

function firstPopulated(item, keys) {
  let empty = null;
  for (const key of keys) {
    const value = item?.[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length) return value;
      if (empty == null) empty = value;
      continue;
    }
    if (typeof value === "string") {
      if (value.trim()) return value;
      if (empty == null) empty = value;
      continue;
    }
    if (Number.isFinite(Number(value)) && Number(value) > 0) return value;
    if (empty == null) empty = value;
  }
  return empty;
}

function normalizePageNumbers(raw, { parsePageRange, maxPage = 99999 } = {}) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .map(n => Math.round(n)))].sort((a, b) => a - b);
  }
  if (typeof raw === "string" && raw.trim()) {
    if (typeof parsePageRange === "function") {
      try {
        const parsed = parsePageRange(raw, maxPage);
        if (Array.isArray(parsed) && parsed.length) {
          return [...new Set(parsed.map(Number)
            .filter(n => Number.isFinite(n) && n > 0)
            .map(n => Math.round(n)))].sort((a, b) => a - b);
        }
      } catch {}
    }
    return [...new Set((raw.match(/\d+/g) || []).map(Number)
      .filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? [Math.round(n)] : [];
}

export function normalizeReferencePages(item, options = {}) {
  return normalizePageNumbers(firstPopulated(item, PAGE_KEYS), options);
}

export function referencePagesForFinding(record, options = {}) {
  return normalizeReferencePages(record, options);
}

export function referencePageForFinding(record, options = {}) {
  return referencePagesForFinding(record, options)[0] || null;
}

export function referenceFileForFinding(record, fallback = "") {
  const raw = firstPopulated(record, FILE_KEYS);
  return String(raw == null ? fallback : raw).trim();
}

export function referenceQuoteForFinding(record) {
  const raw = firstPopulated(record, QUOTE_KEYS);
  return String(raw == null ? "" : raw).trim();
}

export function normalizeReferenceFinding(item, options = {}) {
  const pages = normalizeReferencePages(item, options);
  return {
    referencePages: pages,
    referencePage: pages[0] || null,
    referenceFile: referenceFileForFinding(item, options.fallbackFile || ""),
    referenceQuote: referenceQuoteForFinding(item),
  };
}

export function resolveReferenceIndex(record, references = []) {
  if (!Array.isArray(references) || !references.length) return -1;
  const wanted = referenceFileForFinding(record);
  if (!wanted && references.length === 1) return 0;
  const index = references.findIndex((ref, i) => [
    ref?.fileName,
    ref?.originalFileName,
    ref?.name,
    "REF" + (i + 1) + "_" + (ref?.fileName || ""),
  ].filter(Boolean).includes(wanted));
  return index;
}
