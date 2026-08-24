// Compatibility wrapper around the established review merge core.
// Adds fail-safe deterministic rejection of model findings that cannot change the source,
// and a narrow masked-symbol proof for cross-language scaled amounts.
import * as base from "./review-merge-core-base.mjs";
export * from "./review-merge-core-base.mjs";

const NUMERIC_CATEGORIES = new Set(["number_mismatch","value_inconsistency","accounting_inconsistency","numbers"]);

function normalized(value) {
  return base.normalizeQuote ? base.normalizeQuote(value) : String(value || "").normalize("NFKC").toLowerCase().replace(/[\s 　]+/g," ").trim();
}

// 「修正案が原文と同一」は数値証明ではなく、適用しても何も変わらない指摘である。
// ここで黙って落とすと除外理由を利用者が確認できないため、判定は
// finding-quality.mjs の isNoOpSuggestionFinding が持ち、UI 側が
// excludedReason="no-op-suggestion" として除外一覧に残す。

function isSelfDuplicateAlternative(finding) {
  const suggestion = String(finding?.suggestion || "");
  if (!/(?:または|もしくは|あるいは|\bor\b)/i.test(suggestion)) return false;
  const quoted = [...suggestion.matchAll(/[「『“”"']([^」』“”"']+)[」』“”"']/g)]
    .map(match => normalized(match[1])).filter(Boolean);
  return quoted.length >= 2 && new Set(quoted).size === 1;
}

function scaleExp(word) {
  const key = String(word || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/s$/, "");
  if (key === "trillion" || key === "兆") return 12;
  if (key === "billion") return 9;
  if (key === "oku" || key === "億") return 8;
  if (key === "million" || key === "百万") return 6;
  if (key === "万") return 4;
  if (key === "thousand" || key === "k" || key === "千") return 3;
  return null;
}

function scaledMaskedAmounts(value) {
  const text = String(value || "");
  const out = [];
  const seen = new Set();
  const add = (symbol, exp, sign, unit = "") => {
    const key = `${symbol}|${exp ?? "?"}|${sign}|${unit}`;
    if (!seen.has(key)) { seen.add(key); out.push({ symbol, exp, sign, unit }); }
  };
  const scaled = /([△▲+＋−-])?\s*([（(])?\s*(⟦#[A-Z]{3}⟧)\s*([）)])?\s*(trillions?|billions?|millions?|thousands?|oku|k|兆|億|百\s*万|万|千)(?![A-Za-z])/giu;
  for (const match of text.matchAll(scaled)) {
    const exp = scaleExp(match[5]);
    if (!Number.isInteger(exp)) continue;
    const prefix = match[1] || "";
    const parenthesized = Boolean(match[2] && match[4]);
    const negative = parenthesized || /[△▲−-]/u.test(prefix);
    add(match[3], exp, negative ? -1 : 1, "scaled");
  }
  // Japanese masking normally consumes the explicit 億/千 scale into the placeholder,
  // leaving only 円 (for example `▲⟦#ABC⟧円`). The symbol already encodes the scaled
  // quantity, so retain a money-typed fallback with an unknown exponent.
  const money = /([△▲+＋−-])?\s*([（(])?\s*(⟦#[A-Z]{3}⟧)\s*([）)])?\s*(円|yen\b)/giu;
  for (const match of text.matchAll(money)) {
    const prefix = match[1] || "";
    const parenthesized = Boolean(match[2] && match[4]);
    const negative = parenthesized || /[△▲−-]/u.test(prefix);
    add(match[3], null, negative ? -1 : 1, "money");
  }
  return out;
}

function crossLanguageScaledSymbolSubset(finding) {
  const category = String(finding?.category || "").toLowerCase();
  if (!NUMERIC_CATEGORIES.has(category)) return false;
  // 壊れた・曖昧な符号表記は base 側と同じく fail-closed のまま残す。
  if (base.hasMalformedNumericSignEvidence(finding)) return false;
  const quote = scaledMaskedAmounts(finding?.quote);
  const comparison = scaledMaskedAmounts(finding?.referenceQuote ?? finding?.reference_quote ?? finding?.suggestion);
  if (!quote.length || !comparison.length) return false;
  const remaining = comparison.slice();
  for (const item of quote) {
    const index = remaining.findIndex(candidate => candidate.symbol === item.symbol
      && candidate.sign === item.sign
      && (item.exp == null || candidate.exp == null || item.exp === candidate.exp));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export function isDeterministicReviewNoise(finding) {
  return isSelfDuplicateAlternative(finding) || crossLanguageScaledSymbolSubset(finding);
}

function deterministicNoise(finding) {
  return isDeterministicReviewNoise(finding);
}

export function isSelfContradictoryNumericFinding(finding, context = {}) {
  return deterministicNoise(finding) || base.isSelfContradictoryNumericFinding(finding, context);
}

export function partitionNumericFalsePositives(findings, context = {}) {
  const preDropped = [];
  const remaining = [];
  for (const finding of findings || []) {
    (deterministicNoise(finding) ? preDropped : remaining).push(finding);
  }
  const result = base.partitionNumericFalsePositives(remaining, context);
  return { kept: result.kept, dropped: preDropped.concat(result.dropped) };
}

export async function runNumericImportTwoPass(findings, options = {}) {
  const items = Array.isArray(findings) ? findings : [];
  const prepareValidatedSameDocumentCounterparts = options.prepareValidatedSameDocumentCounterparts;
  const collectNumericFindingContexts = options.collectNumericFindingContexts;
  const restoreMaskedFindings = options.restoreMaskedFindings || (list => list);
  const chooseSourceBackedQuoteVariants = options.chooseSourceBackedQuoteVariants || (async () => {});
  const isMaskerCompatibleNumericFinding = options.isMaskerCompatibleNumericFinding || (() => false);
  if (typeof prepareValidatedSameDocumentCounterparts !== "function" || typeof collectNumericFindingContexts !== "function") {
    throw new TypeError("runNumericImportTwoPass requires source-context callbacks");
  }
  const sourceCache = options.sourceCache || { pages: new Map(), sources: new Map(), maxPages: 64, maxSources: 64 };
  const targetTextFor = options.targetTextFor || (async () => "");
  const numericContextOptions = {
    targetTextFor,
    referenceTextFor: options.referenceTextFor || (async () => ""),
    referenceSourceFor: options.referenceSourceFor,
  };
  const mergeValidatedContexts = (numericContexts, validatedContexts) => {
    const merged = numericContexts instanceof Map ? numericContexts : new Map();
    if (validatedContexts instanceof Map) {
      for (const [id, context] of validatedContexts) merged.set(id, { ...context, ...(merged.get(id) || {}) });
    }
    return merged;
  };
  const validatedCounterpartContexts = await prepareValidatedSameDocumentCounterparts(items, targetTextFor, sourceCache);
  const numericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(items, numericContextOptions), validatedCounterpartContexts,
  );
  const contextForFinding = finding => numericContexts.get(String(finding?.id || "")) || {};
  const compatibleNumericDropped = items.filter(finding => isMaskerCompatibleNumericFinding(finding, contextForFinding(finding)));
  const maskedNumericFilter = partitionNumericFalsePositives(
    items.filter(finding => !isMaskerCompatibleNumericFinding(finding, contextForFinding(finding))),
    { masker: options.masker || null, forFinding: contextForFinding },
  );
  const restoredFindings = await restoreMaskedFindings(maskedNumericFilter.kept);
  await chooseSourceBackedQuoteVariants(restoredFindings);
  const restoredCounterpartContexts = await prepareValidatedSameDocumentCounterparts(restoredFindings, targetTextFor, sourceCache);
  const restoredNumericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(restoredFindings, numericContextOptions), restoredCounterpartContexts,
  );
  const restoredContextForFinding = finding => restoredNumericContexts.get(String(finding?.id || "")) || {};
  const restoredNumericFilter = partitionNumericFalsePositives(
    restoredFindings, { masker: options.masker || null, forFinding: restoredContextForFinding },
  );
  return {
    sourceCache, numericContexts, restoredNumericContexts, validatedCounterpartContexts, restoredCounterpartContexts,
    compatibleNumericDropped, maskedNumericFilter, restoredFindings, restoredNumericFilter,
    coerced: restoredNumericFilter.kept,
    numericFilteredCount: compatibleNumericDropped.length + maskedNumericFilter.dropped.length + restoredNumericFilter.dropped.length,
  };
}
