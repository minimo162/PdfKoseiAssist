// review-merge.mjs — compatibility facade for numeric-width-safe review logic
//
// The established review implementation remains in review-merge-core.mjs.
// This facade normalizes only compatibility-width numeric glyphs before
// deterministic numeric comparison. It deliberately does NOT use NFKC:
// U+FF0D `－` is a table missing-value dash in PDF extraction and must never
// become an ASCII negative sign.
import {
  isConclusiveNumericFalsePositive as coreIsConclusiveNumericFalsePositive,
} from "./review-merge-core.mjs";

export * from "./review-merge-core.mjs";

const NUMERIC_REVIEW_FIELDS = [
  "quote", "referenceQuote", "reference_quote", "suggestion",
  "reason", "model_reason", "issueSummary", "issue_summary",
];

export function normalizeNumericWidthForReview(value) {
  return String(value ?? "")
    .replace(/[０-９]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/．/gu, ".");
}

function normalizeFindingNumericWidth(finding) {
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
  return (Array.isArray(findings) ? findings : []).map(normalizeFindingNumericWidth);
}

export function isConclusiveNumericFalsePositive(finding, context = {}) {
  return coreIsConclusiveNumericFalsePositive(normalizeFindingNumericWidth(finding), context);
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

// Keep the original masked -> restored pipeline, but evaluate width-normalized
// clones at the deterministic numeric gates while returning the untouched
// findings to the UI. This preserves source quotes exactly as extracted.
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

  const normalizedItems = normalizeFindingList(items);
  const validatedCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    normalizedItems, targetTextFor, sourceCache,
  );
  const numericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(normalizedItems, numericContextOptions),
    validatedCounterpartContexts,
  );
  const contextForFinding = finding => numericContexts.get(String(finding?.id || "")) || {};
  const compatibleNumericDropped = items.filter(finding =>
    isMaskerCompatibleNumericFinding(
      normalizeFindingNumericWidth(finding),
      contextForFinding(finding),
    ));
  const maskedNumericFilter = partitionNumericFalsePositives(
    items.filter(finding => !isMaskerCompatibleNumericFinding(
      normalizeFindingNumericWidth(finding),
      contextForFinding(finding),
    )),
    { masker: options.masker || null, forFinding: contextForFinding },
  );

  const restoredFindings = await restoreMaskedFindings(maskedNumericFilter.kept);
  await chooseSourceBackedQuoteVariants(restoredFindings);
  const normalizedRestoredFindings = normalizeFindingList(restoredFindings);
  const restoredCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    normalizedRestoredFindings, targetTextFor, sourceCache,
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
