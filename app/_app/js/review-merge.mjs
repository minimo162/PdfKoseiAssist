// Public review-merge facade.
//
// The established review logic remains in review-merge-core.mjs. This facade
// supplies a proof-only normalization layer for full-width signed-oku text,
// while always returning the original finding objects so PDF quote matching
// and highlighting keep the exact extracted surface.
export * from "./review-merge-core.mjs";

import {
  findUniqueNumericSourceContext as coreFindUniqueNumericSourceContext,
  isConclusiveNumericFalsePositive as coreIsConclusiveNumericFalsePositive,
  resolveSameDocumentNavigationCounterpart as coreResolveSameDocumentNavigationCounterpart,
  validateSameDocumentCounterpartContext as coreValidateSameDocumentCounterpartContext,
} from "./review-merge-core.mjs";
import {
  hasUnsupportedFullwidthDashOkuEvidence,
  normalizeSignedOkuContext,
  normalizeSignedOkuFinding,
  normalizeSignedOkuText,
  restoreSignedOkuText,
} from "./signed-oku-surface.mjs";

function objectContext(value) {
  return value && typeof value === "object" ? value : {};
}

function contextMasker(value) {
  const context = objectContext(value);
  if (typeof context.compareSymbolUnitFamilies === "function") return context;
  if (context.masker && typeof context.masker.compareSymbolUnitFamilies === "function") {
    return context.masker;
  }
  return context.masker || null;
}

function normalizePageTexts(pageTexts) {
  if (pageTexts instanceof Map) {
    return new Map([...pageTexts].map(([page, text]) => [page, normalizeSignedOkuText(text)]));
  }
  if (typeof pageTexts === "function") {
    return page => normalizeSignedOkuText(pageTexts(page));
  }
  if (pageTexts && typeof pageTexts === "object") {
    return Object.fromEntries(Object.entries(pageTexts)
      .map(([page, text]) => [page, normalizeSignedOkuText(text)]));
  }
  return pageTexts;
}

function restoreQuoteFields(result, roots) {
  if (!result || typeof result !== "object") return result;
  const restore = value => typeof value === "string"
    ? restoreSignedOkuText(roots, value)
    : value;
  const restoreRecord = record => {
    if (!record || typeof record !== "object") return record;
    const clone = { ...record };
    if (typeof clone.quote === "string") clone.quote = restore(clone.quote);
    if (typeof clone.text === "string") clone.text = restore(clone.text);
    if (Array.isArray(clone.quotes)) clone.quotes = clone.quotes.map(restore);
    return clone;
  };
  const restored = { ...result };
  if (Array.isArray(restored.counterparts)) {
    restored.counterparts = restored.counterparts.map(restoreRecord);
  }
  if (Array.isArray(restored.counterParts)) {
    restored.counterParts = restored.counterParts.map(restoreRecord);
  }
  if (restored.context && typeof restored.context === "object") {
    const context = { ...restored.context };
    for (const field of [
      "targetQuote", "target_quote", "referenceQuote", "reference_quote",
    ]) {
      if (typeof context[field] === "string") context[field] = restore(context[field]);
    }
    for (const field of ["referenceQuotes", "reference_quotes"]) {
      if (Array.isArray(context[field])) context[field] = context[field].map(restore);
    }
    restored.context = context;
  }
  return restored;
}

/**
 * Bind a numeric quote after applying only signed-oku width normalization.
 * The returned row/context is proof data; the caller's source and quote are
 * not mutated.
 */
export function findUniqueNumericSourceContext(source, quote, options = {}) {
  return coreFindUniqueNumericSourceContext(
    normalizeSignedOkuText(source),
    normalizeSignedOkuText(quote),
    options,
  );
}

/**
 * Same-document validation must use the same normalized proof surface as the
 * later numeric filter. Restore only display/navigation quotes in the result;
 * row and page text remain normalized proof context.
 */
export function validateSameDocumentCounterpartContext(finding, pageTexts, options = {}) {
  const normalizedFinding = normalizeSignedOkuFinding(finding);
  const normalizedPages = normalizePageTexts(pageTexts);
  const result = coreValidateSameDocumentCounterpartContext(
    normalizedFinding,
    normalizedPages,
    options,
  );
  return restoreQuoteFields(result, [finding, pageTexts]);
}

/** Display-only counterpart navigation follows the same source binding rule. */
export function resolveSameDocumentNavigationCounterpart(finding, pageTexts, options = {}) {
  const normalizedFinding = normalizeSignedOkuFinding(finding);
  const normalizedPages = normalizePageTexts(pageTexts);
  const result = coreResolveSameDocumentNavigationCounterpart(
    normalizedFinding,
    normalizedPages,
    options,
  );
  return restoreQuoteFields(result, [finding, pageTexts]);
}

export function isConclusiveNumericFalsePositive(finding, context = {}) {
  // U+FF0D is intentionally a table missing-value dash, not a negative sign.
  // Reject every attached form before the core can scan past it and interpret
  // an inner parenthesized amount as the operative value.
  if (hasUnsupportedFullwidthDashOkuEvidence(finding)) return false;
  return coreIsConclusiveNumericFalsePositive(
    normalizeSignedOkuFinding(finding),
    normalizeSignedOkuContext(objectContext(context)),
  );
}

export function isSelfContradictoryNumericFinding(finding, context = {}) {
  return isConclusiveNumericFalsePositive(finding, context);
}

export function partitionNumericFalsePositives(findings, context = {}) {
  const kept = [], dropped = [];
  const sourceContext = objectContext(context);
  for (const finding of Array.isArray(findings) ? findings : []) {
    const extra = typeof sourceContext.forFinding === "function"
      ? objectContext(sourceContext.forFinding(finding))
      : {};
    const proven = isConclusiveNumericFalsePositive(
      finding,
      { ...sourceContext, ...extra, masker: contextMasker(sourceContext) },
    );
    (proven ? dropped : kept).push(finding);
  }
  return { kept, dropped };
}

// Keep the browser's masked -> restored ordering identical to the core helper,
// but route both numeric partitions and the optional early compatibility gate
// through the proof-only width normalizer above.
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
  const compatibleProof = (finding, context) => {
    if (hasUnsupportedFullwidthDashOkuEvidence(finding)) return false;
    return isMaskerCompatibleNumericFinding(
      normalizeSignedOkuFinding(finding),
      normalizeSignedOkuContext(objectContext(context)),
    );
  };

  const validatedCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    items, targetTextFor, sourceCache,
  );
  const numericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(items, numericContextOptions),
    validatedCounterpartContexts,
  );
  const contextForFinding = finding => numericContexts.get(String(finding?.id || "")) || {};
  const compatibleNumericDropped = items.filter(finding =>
    compatibleProof(finding, contextForFinding(finding)));
  const maskedNumericFilter = partitionNumericFalsePositives(
    items.filter(finding => !compatibleProof(finding, contextForFinding(finding))),
    { masker: options.masker || null, forFinding: contextForFinding },
  );

  const restoredFindings = await restoreMaskedFindings(maskedNumericFilter.kept);
  // Quote-variant selection is the final source-backed surface. Rebuild the
  // counterpart/numeric contexts only after selection, exactly as the core
  // pipeline does.
  await chooseSourceBackedQuoteVariants(restoredFindings);
  const restoredCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    restoredFindings, targetTextFor, sourceCache,
  );
  const restoredNumericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(restoredFindings, numericContextOptions),
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
