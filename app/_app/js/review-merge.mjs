// review-merge.mjs — compatibility facade for numeric-width-safe review logic
//
// The established review implementation remains in review-merge-core.mjs.
// This facade normalizes only compatibility-width numeric glyphs and explicit
// March fiscal-year labels before deterministic numeric comparison. It
// deliberately does NOT use NFKC: U+FF0D `－` is a table missing-value dash in
// PDF extraction and must never become an ASCII negative sign.
import {
  findUniqueNumericSourceContext as coreFindUniqueNumericSourceContext,
  isConclusiveNumericFalsePositive as coreIsConclusiveNumericFalsePositive,
} from "./review-merge-core.mjs";

export * from "./review-merge-core.mjs";

const NUMERIC_REVIEW_FIELDS = [
  "quote", "referenceQuote", "reference_quote", "suggestion",
  "reason", "model_reason", "issueSummary", "issue_summary",
];
const SOURCE_CONTEXT_TEXT_FIELDS = [
  "targetText", "target_context", "referenceText", "reference_context",
  "targetRowText", "target_row_text", "referenceRowText", "reference_row_text",
  "targetQuote", "target_quote", "referenceQuote", "reference_quote",
];
const SOURCE_CONTEXT_LINE_FIELDS = [
  "targetRowLines", "target_row_lines", "referenceRowLines", "reference_row_lines",
];
const MARCH_FISCAL_YEAR_MARK = "\uE101";
const MARCH_FISCAL_YEAR_RE = /\bFY\s+March\s+((?:19|20)\d{2})\b/giu;
const MARKED_MARCH_FISCAL_YEAR_RE = new RegExp(
  `\\bFY((?:19|20)\\d{2})${MARCH_FISCAL_YEAR_MARK}`,
  "gu",
);
const JAPANESE_FISCAL_YEAR_RE = /(?<!\d)((?:19|20)\d{2})\s*年度/gu;

export function normalizeNumericWidthForReview(value) {
  return String(value ?? "")
    .replace(/[０-９]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/．/gu, ".");
}

/**
 * `FY March 2025` is a fiscal-period label, not the numeric value 2025.
 * Canonicalize the label to the already-supported `FY2025` surface. This is
 * safe without knowing the issuer's year-end because the year itself is not
 * changed. Japanese `YYYY年度` is shifted separately and only after a trusted
 * TARGET/REF source pair proves that it is the corresponding March fiscal year.
 */
export function normalizeMarchFiscalYearLabelsForReview(value) {
  MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  return String(value ?? "").replace(
    MARCH_FISCAL_YEAR_RE,
    (_all, year) => `FY${year}`,
  );
}

function markMarchFiscalYearLabels(value) {
  MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  return normalizeNumericWidthForReview(value).replace(
    MARCH_FISCAL_YEAR_RE,
    (_all, year) => `FY${year}${MARCH_FISCAL_YEAR_MARK}`,
  );
}

function stripMarchFiscalYearMarks(value) {
  return String(value ?? "").replaceAll(MARCH_FISCAL_YEAR_MARK, "");
}

function markedMarchFiscalYears(value) {
  MARKED_MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  const years = [];
  for (const match of String(value ?? "").matchAll(MARKED_MARCH_FISCAL_YEAR_RE)) {
    years.push(Number(match[1]));
  }
  return [...new Set(years.filter(Number.isInteger))];
}

function stripMarchMarksFromSourceMatch(match) {
  if (!match || typeof match !== "object") return match;
  const markedText = [
    match.text,
    match.rowText,
    ...(Array.isArray(match.rowLines) ? match.rowLines : []),
  ].join("\n");
  return {
    ...match,
    text: stripMarchFiscalYearMarks(match.text),
    rowText: stripMarchFiscalYearMarks(match.rowText),
    rowLines: Array.isArray(match.rowLines)
      ? match.rowLines.map(stripMarchFiscalYearMarks)
      : match.rowLines,
    marchFiscalYears: markedMarchFiscalYears(markedText),
  };
}

/**
 * Keep source binding and numeric extraction on the same canonical surface.
 * The private marker lets the caller retain proof that `FY2025` originated
 * from the explicit `FY March 2025` form, while it is removed from every value
 * returned to the rest of the application.
 */
export function findUniqueNumericSourceContext(source, quote, options = {}) {
  const match = coreFindUniqueNumericSourceContext(
    markMarchFiscalYearLabels(source),
    markMarchFiscalYearLabels(quote),
    options,
  );
  return stripMarchMarksFromSourceMatch(match);
}

function normalizeFindingBase(finding) {
  if (!finding || typeof finding !== "object") return finding;
  const normalized = { ...finding };
  for (const field of NUMERIC_REVIEW_FIELDS) {
    if (typeof finding[field] === "string") {
      normalized[field] = normalizeMarchFiscalYearLabelsForReview(
        normalizeNumericWidthForReview(finding[field]),
      );
    }
  }
  return normalized;
}

function normalizeFindingNumericWidthOnly(finding) {
  if (!finding || typeof finding !== "object") return finding;
  const normalized = { ...finding };
  for (const field of NUMERIC_REVIEW_FIELDS) {
    if (typeof finding[field] === "string") {
      normalized[field] = normalizeNumericWidthForReview(finding[field]);
    }
  }
  return normalized;
}

function normalizeFindingList(findings) {
  return (Array.isArray(findings) ? findings : []).map(normalizeFindingNumericWidthOnly);
}

function normalizeContextBase(context) {
  if (!context || typeof context !== "object") return context || {};
  const normalized = { ...context };
  for (const field of SOURCE_CONTEXT_TEXT_FIELDS) {
    if (typeof context[field] === "string") {
      normalized[field] = normalizeMarchFiscalYearLabelsForReview(
        normalizeNumericWidthForReview(context[field]),
      );
    }
  }
  for (const field of SOURCE_CONTEXT_LINE_FIELDS) {
    if (Array.isArray(context[field])) {
      normalized[field] = context[field].map(value =>
        normalizeMarchFiscalYearLabelsForReview(normalizeNumericWidthForReview(value)));
    }
  }
  return normalized;
}

function sideSourceText(finding, context, side) {
  const target = side === "target";
  const values = target
    ? [
      finding?.quote,
      context?.targetText,
      context?.target_context,
      context?.targetRowText,
      context?.target_row_text,
      context?.targetQuote,
      context?.target_quote,
      ...(Array.isArray(context?.targetRowLines) ? context.targetRowLines : []),
      ...(Array.isArray(context?.target_row_lines) ? context.target_row_lines : []),
    ]
    : [
      finding?.referenceQuote,
      finding?.reference_quote,
      context?.referenceText,
      context?.reference_context,
      context?.referenceRowText,
      context?.reference_row_text,
      context?.referenceQuote,
      context?.reference_quote,
      ...(Array.isArray(context?.referenceRowLines) ? context.referenceRowLines : []),
      ...(Array.isArray(context?.reference_row_lines) ? context.reference_row_lines : []),
    ];
  return values.map(value => String(value ?? "")).filter(Boolean).join("\n");
}

function japaneseMarchFiscalYears(value) {
  JAPANESE_FISCAL_YEAR_RE.lastIndex = 0;
  const years = [];
  for (const match of normalizeNumericWidthForReview(value).matchAll(JAPANESE_FISCAL_YEAR_RE)) {
    years.push(Number(match[1]) + 1);
  }
  return [...new Set(years.filter(Number.isInteger))];
}

function explicitMarchFiscalYears(value) {
  MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  const years = [];
  for (const match of normalizeNumericWidthForReview(value).matchAll(MARCH_FISCAL_YEAR_RE)) {
    years.push(Number(match[1]));
  }
  return [...new Set(years.filter(Number.isInteger))];
}

function contextMarchFiscalYears(context, side, fallbackText) {
  const direct = context?.[`${side}MarchFiscalYears`]
    || context?.[`${side}_march_fiscal_years`];
  const supplied = Array.isArray(direct)
    ? direct.map(Number).filter(Number.isInteger)
    : [];
  return [...new Set([...supplied, ...explicitMarchFiscalYears(fallbackText)])];
}

function relationForMarchAndJapaneseYears(marchYears, japaneseYears) {
  if (!marchYears.length || !japaneseYears.length) return "none";
  const march = new Set(marchYears);
  const japanese = new Set(japaneseYears);
  const exact = march.size === japanese.size
    && [...march].every(year => japanese.has(year));
  // Positive authorization requires the complete bounded period set to agree.
  // A partial overlap may come from an adjacent table/header and is therefore
  // ambiguity, not permission to shift every Japanese fiscal-year label.
  return exact ? "equivalent" : "conflict";
}

function sourceBoundMarchFiscalYearRelation(finding, context) {
  if (!context?.targetRowUnique || !context?.referenceRowUnique) return "none";
  const targetText = sideSourceText(finding, context, "target");
  const referenceText = sideSourceText(finding, context, "reference");
  const targetMarch = contextMarchFiscalYears(context, "target", targetText);
  const referenceMarch = contextMarchFiscalYears(context, "reference", referenceText);
  const targetJapanese = japaneseMarchFiscalYears(targetText);
  const referenceJapanese = japaneseMarchFiscalYears(referenceText);
  const relations = [
    relationForMarchAndJapaneseYears(targetMarch, referenceJapanese),
    relationForMarchAndJapaneseYears(referenceMarch, targetJapanese),
  ].filter(relation => relation !== "none");
  if (relations.includes("conflict")) return "conflict";
  return relations.includes("equivalent") ? "equivalent" : "none";
}

function shiftJapaneseFiscalYearsForMarch(value) {
  JAPANESE_FISCAL_YEAR_RE.lastIndex = 0;
  return normalizeNumericWidthForReview(value).replace(
    JAPANESE_FISCAL_YEAR_RE,
    (_all, year) => `FY${Number(year) + 1}`,
  );
}

function shiftFindingJapaneseFiscalYears(finding) {
  if (!finding || typeof finding !== "object") return finding;
  const normalized = { ...finding };
  for (const field of NUMERIC_REVIEW_FIELDS) {
    if (typeof normalized[field] === "string") {
      normalized[field] = shiftJapaneseFiscalYearsForMarch(normalized[field]);
    }
  }
  return normalized;
}

function shiftContextJapaneseFiscalYears(context) {
  const normalized = { ...context };
  for (const field of SOURCE_CONTEXT_TEXT_FIELDS) {
    if (typeof normalized[field] === "string") {
      normalized[field] = shiftJapaneseFiscalYearsForMarch(normalized[field]);
    }
  }
  for (const field of SOURCE_CONTEXT_LINE_FIELDS) {
    if (Array.isArray(normalized[field])) {
      normalized[field] = normalized[field].map(shiftJapaneseFiscalYearsForMarch);
    }
  }
  return normalized;
}

function prepareNumericReviewInput(finding, context = {}) {
  const normalizedFinding = normalizeFindingBase(finding);
  const normalizedContext = normalizeContextBase(context);
  const relation = sourceBoundMarchFiscalYearRelation(finding, context);
  if (relation === "conflict") {
    return {
      finding: normalizedFinding,
      context: { ...normalizedContext, marchFiscalYearConflict: true },
      marchFiscalYearConflict: true,
    };
  }
  if (relation !== "equivalent") {
    return { finding: normalizedFinding, context: normalizedContext, marchFiscalYearConflict: false };
  }
  return {
    finding: shiftFindingJapaneseFiscalYears(normalizedFinding),
    context: shiftContextJapaneseFiscalYears(normalizedContext),
    marchFiscalYearConflict: false,
  };
}

export function isConclusiveNumericFalsePositive(finding, context = {}) {
  const prepared = prepareNumericReviewInput(finding, context);
  if (prepared.marchFiscalYearConflict) return false;
  return coreIsConclusiveNumericFalsePositive(prepared.finding, prepared.context);
}

export function isSelfContradictoryNumericFinding(finding, context = {}) {
  return isConclusiveNumericFalsePositive(finding, context);
}

export function partitionNumericFalsePositives(findings, context = {}) {
  const kept = [], dropped = [];
  const items = Array.isArray(findings) ? findings : [];
  for (const finding of items) {
    const extra = typeof context.forFinding === "function"
      ? (context.forFinding(finding) || {})
      : {};
    const proven = isConclusiveNumericFalsePositive(finding, { ...context, ...extra });
    (proven ? dropped : kept).push(finding);
  }
  return { kept, dropped };
}

// Keep the original masked -> restored pipeline, but evaluate normalized
// clones at deterministic numeric gates while returning untouched findings to
// the UI. Source matching itself is handled by the wrapper above, so `FY March
// YYYY` is not misread as a numeric table value.
export async function runNumericImportTwoPass(findings, options = {}) {
  const items = Array.isArray(findings) ? findings : [];
  const prepareValidatedSameDocumentCounterparts = options.prepareValidatedSameDocumentCounterparts;
  const collectNumericFindingContexts = options.collectNumericFindingContexts;
  const restoreMaskedFindings = options.restoreMaskedFindings || (list => list);
  const chooseSourceBackedQuoteVariants = options.chooseSourceBackedQuoteVariants || (async () => {});
  const isMaskerCompatibleNumericFinding = options.isMaskerCompatibleNumericFinding
    || (() => false);
  if (typeof prepareValidatedSameDocumentCounterparts !== "function"
      || typeof collectNumericFindingContexts !== "function") {
    throw new TypeError("runNumericImportTwoPass requires source-context callbacks");
  }
  const sourceCache = options.sourceCache || {
    pages: new Map(),
    sources: new Map(),
    maxPages: 64,
    maxSources: 64,
  };
  const targetTextFor = options.targetTextFor || (async () => "");
  const numericContextOptions = {
    targetTextFor,
    referenceTextFor: options.referenceTextFor || (async () => ""),
    referenceSourceFor: options.referenceSourceFor,
  };
  const mergeValidatedContexts = (numericContexts, validatedContexts) => {
    const merged = numericContexts instanceof Map ? numericContexts : new Map();
    if (validatedContexts instanceof Map) {
      for (const [id, context] of validatedContexts) {
        merged.set(id, { ...context, ...(merged.get(id) || {}) });
      }
    }
    return merged;
  };
  const maskerCompatible = (finding, findingContext) => {
    const prepared = prepareNumericReviewInput(finding, findingContext);
    return !prepared.marchFiscalYearConflict
      && isMaskerCompatibleNumericFinding(prepared.finding, prepared.context);
  };

  const normalizedItems = normalizeFindingList(items);
  const validatedCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    items, targetTextFor, sourceCache,
  );
  const numericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(normalizedItems, numericContextOptions),
    validatedCounterpartContexts,
  );
  const contextForFinding = finding => numericContexts.get(String(finding?.id || "")) || {};
  const compatibleNumericDropped = items.filter(finding =>
    maskerCompatible(finding, contextForFinding(finding)));
  const maskedNumericFilter = partitionNumericFalsePositives(
    items.filter(finding => !maskerCompatible(finding, contextForFinding(finding))),
    { masker: options.masker || null, forFinding: contextForFinding },
  );

  const restoredFindings = await restoreMaskedFindings(maskedNumericFilter.kept);
  await chooseSourceBackedQuoteVariants(restoredFindings);
  const normalizedRestoredFindings = normalizeFindingList(restoredFindings);
  const restoredCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    restoredFindings, targetTextFor, sourceCache,
  );
  const restoredNumericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(normalizedRestoredFindings, numericContextOptions),
    restoredCounterpartContexts,
  );
  const restoredContextForFinding = finding =>
    restoredNumericContexts.get(String(finding?.id || "")) || {};
  const restoredNumericFilter = partitionNumericFalsePositives(
    restoredFindings,
    { masker: options.masker || null, forFinding: restoredContextForFinding },
  );
  return {
    sourceCache,
    numericContexts,
    restoredNumericContexts,
    validatedCounterpartContexts,
    restoredCounterpartContexts,
    compatibleNumericDropped,
    maskedNumericFilter,
    restoredFindings,
    restoredNumericFilter,
    coerced: restoredNumericFilter.kept,
    numericFilteredCount: compatibleNumericDropped.length
      + maskedNumericFilter.dropped.length + restoredNumericFilter.dropped.length,
  };
}
