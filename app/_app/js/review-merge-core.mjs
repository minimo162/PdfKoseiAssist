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
  const alternative = /(?:または|もしくは|あるいは|\bor\b)/i;
  if (!alternative.test(suggestion)) return false;
  const quoted = [...suggestion.matchAll(/[「『“”"']([^」』“”"']+)[」』“”"']/g)]
    .map(match => normalized(match[1])).filter(Boolean);
  if (quoted.length < 2 || new Set(quoted).size !== 1) return false;

  // A repeated term does not by itself make two proposals redundant.  For
  // example, `Delete "not" or move "not" before the verb` has one target but
  // two materially different operations.  Treat it as noise only when both
  // alternatives express the same action, or when this is merely a duplicated
  // spelling in a neutral "use/unify this term" construction.
  const actionSignature = value => normalized(value
    .replace(/[「『“”"'][^」』“”"']+[」』“”"']/g, "{quote}")
    .replace(/[\s、。,:;.!?！？]+$/u, "")
    // Japanese suggestions commonly alternate between a noun phrase and the
    // same imperative/polite ending (削除 / 削除する / 削除します).
    .replace(/(?:する|します|してください|して|した|しろ|せよ)$/u, ""));
  // Split only after quotations have been replaced.  Otherwise the word
  // "or" in a quoted term becomes a false branch separator.
  const alternativeSurface = suggestion.replace(/[「『“”"'][^」』“”"']+[」』“”"']/g, "{quote}");
  const actions = alternativeSurface.split(/(?:または|もしくは|あるいは|\bor\b)/i)
    .map(actionSignature)
    .filter(Boolean);
  if (actions.length >= 2 && actions.every(action => action === actions[0])) return true;
  const outsideQuotes = normalized(suggestion.replace(/[「『“”"'][^」』“”"']+[」』“”"']/g, ""));
  return /^(?:(?:または|もしくは|あるいは|or)|[\s、。,:;]|(?:に|を|へ|の|と)|(?:表記|用語|名称)|(?:統一|使用|採用|標準化|unify|use|standardize|normalize)(?:する|します|してください)?)+$/i
    .test(outsideQuotes);
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
  const add = (symbol, exp, sign, unit = "", index = -1) => {
    // Do not de-duplicate: the same masked amount can occur in different
    // metric rows.  A set turns two distinct occurrences into one proof and
    // can therefore hide a real mismatch in the comparison text.
    out.push({ symbol, exp, sign, unit, index, measureKeys: [] });
  };
  const scaled = /([△▲+＋−-])?\s*([（(])?\s*(⟦#[A-Z]{3}⟧)\s*([）)])?\s*(trillions?|billions?|millions?|thousands?|oku|k|兆|億|百\s*万|万|千)(?![A-Za-z])/giu;
  for (const match of text.matchAll(scaled)) {
    const exp = scaleExp(match[5]);
    if (!Number.isInteger(exp)) continue;
    const prefix = match[1] || "";
    const parenthesized = Boolean(match[2] && match[4]);
    const negative = parenthesized || /[△▲−-]/u.test(prefix);
    add(match[3], exp, negative ? -1 : 1, "scaled", match.index);
  }
  // Japanese masking normally consumes the explicit 億/千 scale into the placeholder,
  // leaving only 円 (for example `▲⟦#ABC⟧円`). The symbol already encodes the scaled
  // quantity, so retain a money-typed fallback with an unknown exponent.
  const money = /([△▲+＋−-])?\s*([（(])?\s*(⟦#[A-Z]{3}⟧)\s*([）)])?\s*(円|yen\b)/giu;
  for (const match of text.matchAll(money)) {
    const prefix = match[1] || "";
    const parenthesized = Boolean(match[2] && match[4]);
    const negative = parenthesized || /[△▲−-]/u.test(prefix);
    add(match[3], null, negative ? -1 : 1, "money", match.index);
  }
  return out;
}

// #128: 指標キーは記号集合ではなく出現ごとに結び付ける。同じ伏字記号が複数の
// 行に出る場合、最初の行のキーを全ての出現に使い回してはいけない。
function attachOccurrenceMeasureKeys(text, amounts, masker) {
  const bySymbol = new Map();
  for (const token of base.numericEvidenceMeasureKeysForReview(text, masker)) {
    if (!token.symbol) continue;
    const list = bySymbol.get(token.symbol) || [];
    list.push(token.measureKeys || []);
    bySymbol.set(token.symbol, list);
  }
  // numericEvidence and scaledMaskedAmounts do not necessarily see the same
  // occurrences: a leading `⟦#ABC⟧` without a scale is numeric evidence but
  // is not a scaled amount.  Resolve each scaled amount through its actual
  // source position, rather than consuming a per-symbol ordinal.
  const positionsBySymbol = new Map();
  for (const match of String(text || "").matchAll(/⟦#[A-Z]{3}⟧/gu)) {
    const list = positionsBySymbol.get(match[0]) || [];
    list.push(match.index);
    positionsBySymbol.set(match[0], list);
  }
  return amounts.map(amount => {
    const symbolIndex = String(text || "").indexOf(amount.symbol, Math.max(0, amount.index));
    const offset = (positionsBySymbol.get(amount.symbol) || []).indexOf(symbolIndex);
    return { ...amount, measureKeys: bySymbol.get(amount.symbol)?.[offset] || [] };
  });
}

// #128: 円だけを伴う money fallback(exp 不明)を、英文側の明示スケールに対する
// ワイルドカードにしない。masker が同じ記号を同じ exponent で実際に生成した
// 記録(chosenExp)があるときだけ同値とみなす。masker が無ければ fail-closed。
function maskerConfirmsExponent(masker, symbol, exp) {
  if (!masker || !Array.isArray(masker.occurrences) || !Number.isInteger(exp)) return false;
  const records = masker.occurrences.filter(rec => rec?.symbol === symbol && Number.isInteger(rec?.chosenExp));
  return records.length > 0 && records.every(rec => rec.chosenExp === exp);
}

function crossLanguageScaledSymbolSubset(finding, masker = null) {
  const category = String(finding?.category || "").toLowerCase();
  if (!NUMERIC_CATEGORIES.has(category)) return false;
  // 壊れた・曖昧な符号表記は base 側と同じく fail-closed のまま残す。
  if (base.hasMalformedNumericSignEvidence(finding)) return false;
  const quoteText = finding?.quote;
  const comparisonText = finding?.referenceQuote ?? finding?.reference_quote ?? finding?.suggestion;
  // #152: 通貨が明示的に食い違う（US$ ⇔ 円）なら、同じ記号でも同値の証明にならない。
  const currencyOf = value => {
    const text = String(value || "");
    const codes = new Set();
    if (/(?:[$]|usd|dollars?\b|ドル)/i.test(text)) codes.add("usd");
    if (/(?:€|eur\b|euros?\b|ユーロ)/i.test(text)) codes.add("eur");
    if (/(?:¥|円|yen\b|jpy\b)/i.test(text)) codes.add("jpy");
    return codes.size === 1 ? [...codes][0] : "";
  };
  const quoteCurrency = currencyOf(quoteText), comparisonCurrency = currencyOf(comparisonText);
  if (quoteCurrency && comparisonCurrency && quoteCurrency !== comparisonCurrency) return false;
  const quote = attachOccurrenceMeasureKeys(quoteText, scaledMaskedAmounts(quoteText), masker);
  const comparison = attachOccurrenceMeasureKeys(comparisonText, scaledMaskedAmounts(comparisonText), masker);
  if (!quote.length || !comparison.length) return false;
  // A named metric needs a named counterpart.  Falling back from a labelled
  // amount to an unlabelled one is not a proof of equivalence.
  const labelCompatible = (item, candidate) => {
    const left = item.measureKeys || [];
    const right = candidate.measureKeys || [];
    return !left.length && !right.length || left.length > 0 && right.length > 0
      && right.some(key => left.includes(key));
  };
  const exponentCompatible = (item, candidate) => {
    if (item.exp == null && candidate.exp == null) return true;
    if (item.exp != null && candidate.exp != null) return item.exp === candidate.exp;
    return maskerConfirmsExponent(masker, item.symbol, item.exp ?? candidate.exp);
  };
  const remaining = comparison.slice();
  let previousPosition = -1;
  for (const item of quote) {
    const index = remaining.findIndex(candidate => candidate.symbol === item.symbol
      && candidate.sign === item.sign
      && exponentCompatible(item, candidate)
      && labelCompatible(item, candidate));
    if (index < 0) return false;
    // #152: 対応は同じ順序で並んでいなければならない。当期と前期を入れ替えた訳
    // （¥A (¥B in the previous year) ⇔ B（前期はA））は記号の集合が同じでも別物。
    const position = comparison.indexOf(remaining[index]);
    if (position < previousPosition) return false;
    previousPosition = position;
    remaining.splice(index, 1);
  }
  // If a named metric appears on both sides, an unpaired comparison occurrence
  // with that same metric is an unverified extra value, not harmless context.
  // This catches `Sales #ABC, Operating income #DEF` even when another row
  // happened to reuse #ABC.
  const quoteMetricKeys = new Set(quote.flatMap(item => item.measureKeys || []));
  if (quoteMetricKeys.size && remaining.some(candidate =>
    (candidate.measureKeys || []).some(key => quoteMetricKeys.has(key)))) return false;
  // #152: 比較側に対応の取れない金額が残るなら、英文側の金額は「比較側のどれか」と
  // 一致しただけで、当期と前期・総額と増減額のどちらを訳すべきだったかは証明できない
  // （例: 英文 ¥98.0 billion ⇔ 当期1,250億円（前期は980億円））。余りが許されるのは、
  // quote 側の全金額が指標名で対応し、余りが別の指標名の行（売上高など）である場合だけ。
  const everyQuoteLabelled = quote.every(item => (item.measureKeys || []).length > 0);
  const extrasAreOtherMetrics = remaining.every(candidate => (candidate.measureKeys || []).length > 0);
  if (remaining.length && !(everyQuoteLabelled && extrasAreOtherMetrics)) return false;
  return true;
}

export function isDeterministicReviewNoise(finding, context = {}) {
  return isSelfDuplicateAlternative(finding)
    || crossLanguageScaledSymbolSubset(finding, context?.masker || null);
}

function deterministicNoise(finding, context = {}) {
  return isDeterministicReviewNoise(finding, context);
}

export function isSelfContradictoryNumericFinding(finding, context = {}) {
  return deterministicNoise(finding, context) || base.isSelfContradictoryNumericFinding(finding, context);
}

export function partitionNumericFalsePositives(findings, context = {}) {
  const preDropped = [];
  const remaining = [];
  for (const finding of findings || []) {
    (deterministicNoise(finding, context) ? preDropped : remaining).push(finding);
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
