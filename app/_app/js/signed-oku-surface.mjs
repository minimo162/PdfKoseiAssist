// Signed-oku width normalization shared by source binding and review filtering.
//
// PDF extraction can preserve full-width digits/decimal points/Latin letters.
// Normalize only those one-character width variants in a proof copy. Keep
// bracket width, explicit plus signs, triangles and U+FF0D untouched so the
// strict review logic can still reject mixed brackets, combined signs and a
// table's missing-value dash. Callers must continue to retain the original
// finding for highlighting and display.

const FINDING_TEXT_FIELDS = Object.freeze([
  "quote", "referenceQuote", "reference_quote", "suggestion",
  "reason", "model_reason", "issueSummary", "issue_summary",
]);

const FINDING_TEXT_ARRAY_FIELDS = Object.freeze([
  "quote_variants", "quoteVariants", "referenceQuotes", "reference_quotes", "quotes",
]);

const FINDING_RECORD_ARRAY_FIELDS = Object.freeze([
  "counterparts", "counterParts",
]);

const FINDING_RECORD_TEXT_FIELDS = Object.freeze([
  "quote", "text",
]);

const FINDING_RECORD_TEXT_ARRAY_FIELDS = Object.freeze([
  "quotes",
]);

const CONTEXT_TEXT_FIELDS = Object.freeze([
  "targetText", "target_text", "targetContext", "target_context",
  "targetSource", "target_source",
  "referenceText", "reference_text", "referenceContext", "reference_context",
  "referenceSource", "reference_source",
  "targetRowText", "target_row_text", "referenceRowText", "reference_row_text",
  "targetQuote", "target_quote", "referenceQuote", "reference_quote",
]);

const CONTEXT_LINE_FIELDS = Object.freeze([
  "targetRowLines", "target_row_lines", "referenceRowLines", "reference_row_lines",
  "referenceQuotes", "reference_quotes",
]);

const WIDTH_VARIANT_RE = /[０-９．Ａ-Ｚａ-ｚ]/u;
const FULLWIDTH_DIGIT_RE = /[０-９]/gu;
const FULLWIDTH_LATIN_RE = /[Ａ-Ｚａ-ｚ]/gu;
// Match the same bounded romanized unit vocabulary as review-merge-core.
// The left boundary prevents ordinary words ending in "oku" from turning an
// unrelated full-width number elsewhere in the record into a proof candidate.
const OKU_UNIT_RE = /(?:(?<![A-Za-z])[oO][kK][uU](?![A-Za-z])|億(?:円)?)/u;

function asciiDigit(char) {
  return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
}

function normalizeNumericWidth(value) {
  const source = String(value ?? "");
  if (!WIDTH_VARIANT_RE.test(source)) return source;
  return source
    .replace(FULLWIDTH_DIGIT_RE, asciiDigit)
    .replace(/．/gu, ".")
    .replace(FULLWIDTH_LATIN_RE, char => char.normalize("NFKC"));
}

function containsOkuUnit(value) {
  return OKU_UNIT_RE.test(normalizeNumericWidth(value));
}

function pushStrings(out, value) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string") out.push(item);
  }
}

function findingStrings(value) {
  if (!value || typeof value !== "object") return [];
  const strings = [];
  for (const field of FINDING_TEXT_FIELDS) pushStrings(strings, value[field]);
  for (const field of FINDING_TEXT_ARRAY_FIELDS) pushStrings(strings, value[field]);
  for (const field of FINDING_RECORD_ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) continue;
    for (const record of value[field]) {
      if (!record || typeof record !== "object") continue;
      for (const textField of FINDING_RECORD_TEXT_FIELDS) pushStrings(strings, record[textField]);
      for (const arrayField of FINDING_RECORD_TEXT_ARRAY_FIELDS) pushStrings(strings, record[arrayField]);
    }
  }
  return strings;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === "string" ? normalizeNumericWidth(item) : item)
    : value;
}

function normalizeFindingRecords(value) {
  if (!Array.isArray(value)) return value;
  return value.map(record => {
    if (!record || typeof record !== "object") return record;
    const clone = { ...record };
    for (const field of FINDING_RECORD_TEXT_FIELDS) {
      if (typeof clone[field] === "string") clone[field] = normalizeNumericWidth(clone[field]);
    }
    for (const field of FINDING_RECORD_TEXT_ARRAY_FIELDS) {
      if (Array.isArray(clone[field])) clone[field] = normalizeStringArray(clone[field]);
    }
    return clone;
  });
}

function normalizeObjectTextGroup(value, textFields, lineFields = []) {
  if (!value || typeof value !== "object") return value;
  const strings = [];
  for (const field of textFields) pushStrings(strings, value[field]);
  for (const field of lineFields) pushStrings(strings, value[field]);
  if (!strings.some(containsOkuUnit) || !strings.some(item => WIDTH_VARIANT_RE.test(item))) return value;

  const clone = { ...value };
  for (const field of textFields) {
    if (typeof clone[field] === "string") clone[field] = normalizeNumericWidth(clone[field]);
  }
  for (const field of lineFields) {
    if (Array.isArray(clone[field])) clone[field] = normalizeStringArray(clone[field]);
  }
  return clone;
}

/** Normalize only proof-safe width variants when the text actually contains an oku unit. */
export function normalizeSignedOkuText(value) {
  const source = String(value ?? "");
  return containsOkuUnit(source) ? normalizeNumericWidth(source) : source;
}

/** Return a proof copy; the original finding remains untouched for highlighting. */
export function normalizeSignedOkuFinding(finding) {
  if (!finding || typeof finding !== "object") return finding;
  const strings = findingStrings(finding);
  if (!strings.some(containsOkuUnit) || !strings.some(item => WIDTH_VARIANT_RE.test(item))) {
    return finding;
  }
  const clone = { ...finding };
  for (const field of FINDING_TEXT_FIELDS) {
    if (typeof clone[field] === "string") clone[field] = normalizeNumericWidth(clone[field]);
  }
  for (const field of FINDING_TEXT_ARRAY_FIELDS) {
    if (Array.isArray(clone[field])) clone[field] = normalizeStringArray(clone[field]);
  }
  for (const field of FINDING_RECORD_ARRAY_FIELDS) {
    if (Array.isArray(clone[field])) clone[field] = normalizeFindingRecords(clone[field]);
  }
  return clone;
}

/** Normalize source-context proof text without mutating the caller's cached context. */
export function normalizeSignedOkuContext(context) {
  return normalizeObjectTextGroup(context, CONTEXT_TEXT_FIELDS, CONTEXT_LINE_FIELDS);
}

function collectNestedStrings(value, out, seen, depth) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object" || depth <= 0 || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectNestedStrings(item, out, seen, depth - 1);
    return;
  }
  for (const item of Object.values(value)) collectNestedStrings(item, out, seen, depth - 1);
}

/**
 * Restore an exact display substring from an original finding/page-text root.
 * The supported width conversions are one UTF-16 code unit to one code unit,
 * so an index in the normalized candidate maps back to the same original
 * slice. If no source substring is found, return the normalized value.
 */
export function restoreSignedOkuText(root, normalizedValue) {
  if (typeof normalizedValue !== "string" || !normalizedValue) return normalizedValue;
  const strings = [];
  collectNestedStrings(root, strings, new WeakSet(), 6);
  for (const candidate of strings) {
    if (normalizeSignedOkuText(candidate) === normalizedValue) return candidate;
  }
  for (const candidate of strings) {
    const normalizedCandidate = normalizeSignedOkuText(candidate);
    const index = normalizedCandidate.indexOf(normalizedValue);
    if (index >= 0) return candidate.slice(index, index + normalizedValue.length);
  }
  return normalizedValue;
}

const SIGNED_OKU_CORE = "(?:⟦#[A-Z]{3}⟧|\\d[\\d,，]*(?:\\.\\d+)?)";
const SIGNED_OKU_UNIT = "(?:(?<![A-Za-z])[oO][kK][uU]|億(?:円)?)(?![A-Za-z])";
const PARENTHESIZED_OKU_CORE = `(?:\\(\\s*${SIGNED_OKU_CORE}\\s*\\)|（\\s*${SIGNED_OKU_CORE}\\s*）)`;
// Prefix signs are valid only on an unparenthesized amount. Accounting
// parentheses are themselves the negative sign; `-(100)` and `△(100)` are
// deliberately outside this shape.
const SIGNED_OKU_AMOUNT = `(?:[△▲+＋−-]\\s*${SIGNED_OKU_CORE}`
  + `|${PARENTHESIZED_OKU_CORE}`
  + `|${SIGNED_OKU_CORE})\\s*${SIGNED_OKU_UNIT}`;
const SIGNED_OKU_SURFACE_RE = new RegExp(SIGNED_OKU_AMOUNT, "iu");
const SIGNED_OKU_SURFACE_GLOBAL_RE = new RegExp(SIGNED_OKU_AMOUNT, "giu");
const UNSUPPORTED_FULLWIDTH_DASH_OKU_RE = new RegExp(
  `(?:－\\s*(?:${SIGNED_OKU_CORE}|${PARENTHESIZED_OKU_CORE})`
    + `|[（(]\\s*－\\s*${SIGNED_OKU_CORE}\\s*[）)])\\s*${SIGNED_OKU_UNIT}`,
  "iu",
);
const MALFORMED_SIGNED_OKU_RE = new RegExp(
  `(?:[△▲+＋−-]\\s*){2,}${SIGNED_OKU_CORE}\\s*${SIGNED_OKU_UNIT}`
    + `|[△▲+＋−-]\\s*[（(]\\s*(?:[△▲+＋−-]\\s*)?${SIGNED_OKU_CORE}`
    + `|[（(]\\s*[△▲+＋−-]\\s*${SIGNED_OKU_CORE}`
    + `|\\(\\s*(?:[△▲+＋−-]\\s*)?${SIGNED_OKU_CORE}\\s*）\\s*${SIGNED_OKU_UNIT}`
    + `|（\\s*(?:[△▲+＋−-]\\s*)?${SIGNED_OKU_CORE}\\s*\\)\\s*${SIGNED_OKU_UNIT}`,
  "iu",
);

function signedOkuSurfaceRemainder(value) {
  const normalized = normalizeSignedOkuText(value);
  SIGNED_OKU_SURFACE_GLOBAL_RE.lastIndex = 0;
  return normalized
    .replace(SIGNED_OKU_SURFACE_GLOBAL_RE, "__SIGNED_OKU_AMOUNT__")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** True when U+FF0D is attached to an oku amount and must remain reviewable. */
export function hasUnsupportedFullwidthDashOkuEvidence(value) {
  const strings = [];
  collectNestedStrings(value, strings, new WeakSet(), 6);
  return strings
    .map(normalizeSignedOkuText)
    .some(text => UNSUPPORTED_FULLWIDTH_DASH_OKU_RE.test(text));
}

/**
 * Narrow admission gate for formatting/terminology source binding.
 * This does not itself suppress a finding; the review merge still proves
 * value, sign, unit, row, period, scope and currency equivalence.
 */
export function isSignedOkuSurfaceCandidate(finding, referenceQuote) {
  const category = String(finding?.category || "").toLowerCase();
  if (category !== "formatting" && category !== "terminology") return false;
  const quote = normalizeSignedOkuText(String(finding?.quote || "").trim());
  const reference = normalizeSignedOkuText(String(referenceQuote || "").trim());
  if (!quote || !reference
      || UNSUPPORTED_FULLWIDTH_DASH_OKU_RE.test(quote)
      || UNSUPPORTED_FULLWIDTH_DASH_OKU_RE.test(reference)
      || MALFORMED_SIGNED_OKU_RE.test(quote)
      || MALFORMED_SIGNED_OKU_RE.test(reference)
      || !SIGNED_OKU_SURFACE_RE.test(quote)
      || !SIGNED_OKU_SURFACE_RE.test(reference)) return false;
  return signedOkuSurfaceRemainder(quote) === signedOkuSurfaceRemainder(reference);
}
