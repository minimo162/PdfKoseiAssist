// review-merge.mjs — Phase 4/§11 finding統合
//
// 計画書 §11 / 改善原則5「重複は即削除せず、まず束ねる」:
//   - exact dedupe: page | category | normalized_quote | normalized_suggestion が完全一致
//     したものだけを自動削除する。
//   - similar group: page | category | normalized_quote が一致するものは削除せず、同一箇所の
//     候補として束ねる。異なる suggestion を失わない（V2 の過剰削除バグの是正）。
//
// 純関数。ブラウザ／Node の両方から import 可能。

export function normalizeQuote(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s 　]+/g, " ")
    .trim();
}

function exactKey(f) {
  return JSON.stringify([f.page, f.category, normalizeQuote(f.quote), normalizeQuote(f.suggestion)]
    .map(v => String(v == null ? "" : v)));
}

function groupKey(f) {
  return JSON.stringify([f.page, f.category, normalizeQuote(f.quote)]
    .map(v => String(v == null ? "" : v)));
}

const NUMERIC_CATEGORIES = new Set([
  "number_mismatch", "value_inconsistency", "accounting_inconsistency", "numbers",
]);
const PLACEHOLDER_RE = /⟦#[A-Z]{3}⟧/g;

function signedPlaceholderTokens(value) {
  const text = String(value || "");
  const out = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(0, start).match(/\S\s*$/)?.[0]?.trim() || "";
    const after = text.slice(end).match(/^\s*\S/)?.[0]?.trim() || "";
    const negative = before === "△" || before === "▲" || (before === "(" && after === ")");
    out.push(`${negative ? "-" : "+"}${match[0]}`);
  }
  return out;
}

const sameTokens = (a, b) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

// Numeric false-positive filtering is deliberately conservative.  A number is
// useful here only when its nearby unit/measure family is explicit, or when the
// masking layer has an unambiguous family for the symbol.  Bare digits and
// mixed-family table snippets remain findings because text-only import cannot
// prove that they are the same metric.
const NUMERIC_TOKEN_RE = /⟦#[A-Z]{3}⟧|[△▲+−-]\s*\(?\s*\d[\d,]*(?:\.\d+)?\s*\)?|\(\s*\d[\d,]*(?:\.\d+)?\s*\)|\d[\d,]*(?:\.\d+)?/g;
// Match compound Japanese scales before their shorter components.  PDF text
// extraction may insert spaces inside 百万円/十億円, so the spaces are allowed
// only between scale characters and are removed by scaleExponent().
const SCALE_WORD_RE = /trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|oku|k\b/gi;
const SCALE_EXPONENTS = new Map([
  ["trillion", 12], ["trillions", 12], ["兆", 12],
  ["billion", 9], ["billions", 9], ["十億", 9],
  ["million", 6], ["millions", 6], ["百万", 6],
  ["thousand", 3], ["thousands", 3], ["千", 3], ["万", 4], ["oku", 8], ["k", 3],
]);

// These patterns intentionally prefer explicit measure words.  Generic words
// such as "total" or "result" are not unit evidence and are excluded.
const FAMILY_PATTERNS = [
  { family: "rate", re: /%|％|percent(?:age)?\b|per\s*cent\b|exchange\s*rate|currency\s*rate|為替(?:レート|率)?|増減率|利益率|rate\b|ratio\b|margin\b/i },
  { family: "shares", re: /shares?\b|share\s*count|stock\s*units?|株式数|株数|持株数|株/i },
  { family: "units", re: /vehicles?\b|vehicle\s*(?:sales|volume|count)|units?\b|shipments?\b|deliveries?\b|sales\s+volume|production\s+volume|台数|販売台数|生産台数|出荷台数|数量|台/i },
  { family: "count", re: /employees?\b|persons?\b|people\b|customers?\b|patents?\b|cases?\b|headcount\b|number\s+of\b|count\b|人数|人員数|従業員数|件数|人数|名|件|個|社/i },
  { family: "money", re: /¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|金額|revenue\b|net\s+sales\b|sales\s+amount|operating\s+income|ordinary\s+income|profit\b|loss\b|assets?\b|liabilit(?:y|ies)\b|cash\s+flow|cost\b|price\b|amount\b/i },
];

function contextMasker(context) {
  if (!context) return null;
  if (typeof context.compareSymbolUnitFamilies === "function") return context;
  if (context.masker && typeof context.masker.compareSymbolUnitFamilies === "function") return context.masker;
  return null;
}

function numericFieldText(finding) {
  const f = finding || {};
  return [f.quote, f.referenceQuote ?? f.reference_quote, f.reason, f.suggestion,
    f.issueSummary, f.issue_summary, f.model_reason]
    .map(value => String(value || ""))
    .join(" ");
}

function hasMaskedNumericToken(finding) {
  return /⟦#[A-Z]{3}⟧/.test(numericFieldText(finding));
}

function tokenNegative(raw) {
  const s = String(raw || "");
  return /^[△▲−\-]\s*/.test(s) || /^\(\s*/.test(s);
}

function placeholderNegative(text, token) {
  const before = String(text || "").slice(0, token.index).match(/\S\s*$/)?.[0]?.trim() || "";
  const after = String(text || "").slice(token.end).match(/^\s*\S/)?.[0]?.trim() || "";
  return before === "△" || before === "▲" || before === "−" || before === "-"
    || (before === "(" && after === ")");
}

function numericTokenParts(raw) {
  let s = String(raw || "").trim();
  const negative = tokenNegative(s);
  s = s.replace(/^[△▲−+\-]\s*/, "");
  if (/^\(\s*.*\s*\)$/.test(s)) s = s.slice(1, -1).trim();
  s = s.replace(/[\s,]/g, "");
  const [integer = "0", fraction = ""] = s.split(".");
  const digits = `${integer || "0"}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return { digits, decimals: fraction.length, negative };
}

function scaleExponent(word) {
  const compact = String(word || "").replace(/\s+/g, "");
  const key = compact.toLowerCase().replace(/s$/, "");
  return SCALE_EXPONENTS.get(key) ?? SCALE_EXPONENTS.get(compact) ?? null;
}

function familyEvidence(text, token, tokens) {
  const src = String(text || "");
  const lineStart = Math.max(0, src.lastIndexOf("\n", Math.max(0, token.index) - 1) + 1);
  const nextBreak = src.indexOf("\n", Math.max(0, token.end));
  const lineEnd = nextBreak < 0 ? src.length : nextBreak;
  const line = src.slice(lineStart, lineEnd);
  const lineTokens = (tokens.length === 1 ? [token] : tokens)
    .filter(item => item.index >= lineStart && item.end <= lineEnd);
  const nearestToken = position => lineTokens.reduce((best, candidate) => {
    const bestDistance = Math.abs(position - ((best.index + best.end) / 2));
    const candidateDistance = Math.abs(position - ((candidate.index + candidate.end) / 2));
    return candidateDistance < bestDistance ? candidate : best;
  }, lineTokens[0] || token);
  const familyHits = [];
  for (const rule of FAMILY_PATTERNS) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    for (const match of line.matchAll(new RegExp(rule.re.source, flags))) {
      const position = lineStart + match.index;
      if (nearestToken(position) === token && Math.abs(position - token.index) <= 96) familyHits.push(rule.family);
    }
  }
  const exponents = [];
  for (const match of line.matchAll(SCALE_WORD_RE)) {
    const position = lineStart + match.index;
    if (nearestToken(position) === token && Math.abs(position - token.index) <= 96) {
      const exponent = scaleExponent(match[0]);
      if (Number.isInteger(exponent)) exponents.push(exponent);
    }
  }
  const directText = tokens.length === 1
    ? src
    : src.slice(Math.max(lineStart, token.index - 48), Math.min(lineEnd, token.end + 48));
  const families = [...new Set(familyHits)];
  const uniqueExponents = [...new Set(exponents)];
  const hasDirectUnit = /¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|vehicles?\b|units?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|%|％|兆|億|百万|千|台|人|名|件|個|社/i.test(directText);
  const familyStatus = families.length === 1 ? "known" : families.length > 1 ? "ambiguous" : "unknown";
  return {
    status: familyStatus,
    family: families.length === 1 ? families[0] : "",
    families,
    scaleExp: uniqueExponents.length === 1 ? uniqueExponents[0] : 0,
    scaleKnown: uniqueExponents.length === 1 || (uniqueExponents.length === 0 && hasDirectUnit),
    explicit: hasDirectUnit,
  };
}

function mergeSymbolFamilyEvidence(explicit, symbol, masker) {
  if (!symbol || !masker || typeof masker.getSymbolFamilyEvidence !== "function") return explicit;
  const masked = masker.getSymbolFamilyEvidence(symbol);
  if (explicit.status === "ambiguous" || masked.status === "ambiguous") {
    return { ...explicit, status: "ambiguous", family: "", families: [...new Set([...(explicit.families || []), ...(masked.families || [])])] };
  }
  if (explicit.status === "known" && masked.status === "known" && explicit.family !== masked.family) {
    return { ...explicit, status: "ambiguous", family: "", families: [explicit.family, masked.family] };
  }
  if (explicit.status === "known") return explicit;
  if (masked.status === "known") {
    return { ...explicit, status: "known", family: masked.family, families: masked.families, explicit: true };
  }
  return explicit;
}

function extractNumericEvidence(value, masker = null) {
  const text = String(value || "");
  const allTokens = [...text.matchAll(NUMERIC_TOKEN_RE)].map(match => ({
    raw: match[0], index: match.index, end: match.index + match[0].length,
    symbol: /^⟦#/.test(match[0]) ? match[0] : "",
  }));
  const tokens = allTokens.filter(token => {
    if (token.symbol) return true;
    const before = text.slice(0, token.index);
    const after = text.slice(token.end);
    const bare = token.raw.replace(/^[△▲+−-]/, "").replace(/[(),]/g, "");
    return !/(?:\b(?:p|page)\s*[.．]?\s*|\bfy\s*)$/i.test(before)
      && !/^\s*(?:年|年度|期|月|日)/.test(after)
      && !(bare.length === 4 && /年|年度/.test(after));
  });
  return tokens.map(token => {
    const family = mergeSymbolFamilyEvidence(familyEvidence(text, token, tokens), token.symbol, masker);
    const parts = token.symbol
      ? { digits: "", decimals: 0, negative: placeholderNegative(text, token) }
      : numericTokenParts(token.raw);
    return { ...token, ...parts, ...family };
  });
}

function quantityIntervalsOverlap(a, b) {
  if (!a.scaleKnown || !b.scaleKnown || a.symbol || b.symbol) return false;
  // Put both amounts on an integer grid in base units.  The denominator is
  // needed only when a displayed decimal has more places than its scale.
  const commonDenominatorExp = Math.max(0, a.decimals - a.scaleExp, b.decimals - b.scaleExp);
  const scaled = q => {
    const shift = q.scaleExp - q.decimals + commonDenominatorExp;
    if (shift < 0) return null;
    const amount = BigInt(q.digits) * (10n ** BigInt(shift));
    const quantum = 10n ** BigInt(shift);
    const half = quantum / 2n;
    return { low: amount - half, high: amount + (quantum - half) };
  };
  const left = scaled(a), right = scaled(b);
  return Boolean(left && right && left.low < right.high && right.low < left.high);
}

function canDropNumericPair(a, b, masker) {
  if (!a || !b || a.negative !== b.negative) return false;
  // A repeated masked symbol is a deterministic self-contradiction even when
  // its unit family is unavailable.  The symbol itself identifies the same
  // protected numeric value; keep the sign check above so a sign mismatch is
  // never suppressed.
  if (a.symbol && b.symbol && a.symbol === b.symbol) return true;
  if (a.status !== "known" || b.status !== "known") return false;
  if (a.family !== b.family) return true;
  if (a.symbol && b.symbol && masker && typeof masker.areSymbolsCompatible === "function") {
    return masker.areSymbolsCompatible(a.symbol, b.symbol);
  }
  return quantityIntervalsOverlap(a, b);
}

function allPairsProveFalsePositive(left, right, masker) {
  if (!left.length || left.length !== right.length) return false;
  return left.every((item, index) => canDropNumericPair(item, right[index], masker));
}

function fieldPairsProveFalsePositive(values, masker) {
  if (values.length < 2) return false;
  return values.slice(1).every(item => canDropNumericPair(values[0], item, masker));
}

/**
 * Hard-drop only when explicit unit/scale evidence proves the candidate is
 * equivalent or compares disjoint measure families.  The one unit-free
 * exception is an identical protected symbol with the same sign: that is a
 * deterministic self-contradiction, not a raw-value comparison.  Unknown,
 * empty, or conflicting family evidence otherwise remains a finding.
 */
export function isConclusiveNumericFalsePositive(finding, context = {}) {
  const f = finding || {};
  if (!NUMERIC_CATEGORIES.has(String(f.category || "").toLowerCase())) return false;
  const masker = contextMasker(context);
  const quote = extractNumericEvidence(f.quote, masker);
  const reference = extractNumericEvidence(f.referenceQuote ?? f.reference_quote, masker);
  // When both primary citations contain numeric evidence, they alone decide
  // the finding.  A contradictory reason/suggestion must never erase a real
  // quote/reference mismatch.  Auxiliary fields are fallback evidence only
  // when the primary pair is absent on at least one side.
  if (quote.length > 0 && reference.length > 0) {
    return allPairsProveFalsePositive(quote, reference, masker);
  }
  for (const field of [f.reason, f.suggestion, f.issueSummary, f.issue_summary, f.model_reason]) {
    const values = extractNumericEvidence(field, masker);
    if (fieldPairsProveFalsePositive(values, masker)) return true;
  }
  return false;
}

function normalizedSignedNumber(value) {
  let s = String(value || "").replace(/,/g, "").trim();
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);
  s = s.replace(/^[△▲−]/, "-").replace(/^\+/, "");
  return s;
}

function hasEqualEitherOrNumbers(value) {
  const text = String(value || "");
  const number = String.raw`[△▲+−-]?\(?\d[\d,]*(?:\.\d+)?\)?`;
  for (const re of [
    new RegExp(String.raw`(${number})\s*と\s*(${number})\s*のどちら`),
    new RegExp(String.raw`P\.?\d+の\s*(${number})\s*と\s*P\.?\d+の\s*(${number})[^。]*どちら`, "i"),
    new RegExp(String.raw`P\.?\d+[^\d。]{0,80}(${number})[^。]{0,80}P\.?\d+[^\d。]{0,80}(${number})`, "i"),
    new RegExp(String.raw`「(${number})」[^。]{0,60}日本語版の「(${number})」`),
  ]) {
    const match = text.match(re);
    if (match && normalizedSignedNumber(match[1]) === normalizedSignedNumber(match[2])) return true;
  }
  return false;
}

function stripPageAndPeriodReferences(value) {
  return String(value || "")
    .replace(/P\s*[.．]\s*\d{1,4}/gi, " ")
    .replace(/FY\s*\d{2,4}/gi, " ")
    .replace(/\d{4}年/g, " ")
    .replace(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}/gi, " ");
}

/**
 * 4,918.2 billion と 4,918,172 million のように、桁・丸めだけが違う同量を検出する。
 * 48 thousand と 48 million のように桁列が同じで単位だけが違う本物の不一致は対象外。
 */
export function hasEquivalentScaledNumbers(value) {
  const vals = [...stripPageAndPeriodReferences(value).matchAll(/[0-9][0-9,]*(?:\.[0-9]+)?/g)]
    .map(match => match[0].replace(/,/g, ""));
  const significantDigits = raw => raw.replace(".", "").replace(/^0+/, "");
  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      const a = significantDigits(vals[i]);
      const b = significantDigits(vals[j]);
      if (!a || !b || a === b) continue;
      const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
      if (shorter.length < 3 || longer.length <= shorter.length) continue;
      if (String(Math.round(Number(longer.slice(0, shorter.length + 1)) / 10)) === shorter) return true;
    }
  }
  return false;
}

function normalizedNumberTokens(value) {
  const text = String(value || "");
  const re = /[△▲+−-]?\(?\d[\d,]*(?:\.\d+)?\)?/g;
  return (text.match(re) || []).map(raw => {
    let s = normalizedSignedNumber(raw);
    const negative = s.startsWith("-");
    if (negative) s = s.slice(1);
    let [integer, fraction = ""] = s.split(".");
    integer = integer.replace(/^0+(?=\d)/, "") || "0";
    fraction = fraction.replace(/0+$/, "");
    return `${negative ? "-" : "+"}${integer}${fraction ? "." + fraction : ""}`;
  });
}

export function isLikelyTableRowIndexOmission(finding, referenceContext = "") {
  const f = finding || {};
  if (String(f.category || "").toLowerCase() !== "omission") return false;
  const quote = normalizedNumberTokens(f.quote);
  const reference = normalizedNumberTokens(f.referenceQuote ?? f.reference_quote);
  if (reference.length !== quote.length + 1 || reference.length < 2) return false;
  const first = Number(reference[0].replace(/^\+/, ""));
  if (!(Number.isInteger(first) && first >= 1 && first <= 100
      && quote.every((value, i) => value === reference[i + 1]))) return false;

  // 数字列だけでは、率・脚注・年度・実値の「20」を行番号と区別できない。
  // テキスト層にはx座標がないため、明示的な行番号見出しと5行連番の両方がある場合だけ確定する。
  // 証明できない候補は除外せず、利用者に残す。
  const contextText = String(referenceContext || "");
  const rawLines = contextText.split(/\r?\n/);
  const headerPattern = /(?:\brow\s+(?:id|no\.?|number)(?:\s*[:：])?|\bno\.(?:\s*(?:id|number))?(?:\s*[:：])?|行番号)/i;
  const headerLines = rawLines.map((line, index) => ({ line, index })).filter(x => headerPattern.test(x.line))
    .concat(rawLines.map((line, index) => ({ line, index })).filter(x => /^\s*番号\s*[:：]?\s*$/.test(x.line)));
  if (!headerLines.length) return false;
  const lines = rawLines
    .map((line, rawIndex) => ({ line, rawIndex, tokens: normalizedNumberTokens(line) }))
    .filter(x => x.tokens.length);
  const sameTokensAt = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const rowId = tokens => {
    if (tokens.length !== reference.length) return null;
    const n = Number(tokens[0].replace(/^\+/, ""));
    return Number.isInteger(n) ? n : null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!sameTokensAt(lines[i].tokens, reference)) continue;
    if (!headerLines.some(header => header.index < lines[i].rawIndex && header.index >= lines[i].rawIndex - 8)) continue;
    const before = lines.slice(Math.max(0, i - 6), i).map(x => rowId(x.tokens)).filter(Number.isInteger);
    const after = lines.slice(i + 1, i + 7).map(x => rowId(x.tokens)).filter(Number.isInteger);
    if (before.includes(first - 2) && before.includes(first - 1)
        && after.includes(first + 1) && after.includes(first + 2)) return true;
  }
  return false;
}

function explicitUnitExponents(value) {
  const out = [];
  for (const match of String(value || "").matchAll(/trillions?|billions?|millions?|thousands?|十\s*億|千\s*万|百\s*万|十\s*万|百万|十億|兆|億|万|千/gi)) {
    const word = match[0].toLowerCase().replace(/\s+/g, "").replace(/s$/, "");
    out.push(word === "trillion" || word === "兆" ? 12
      : word === "billion" || word === "十億" ? 9
      : word === "億" ? 8
      : word === "million" || word === "百万" ? 6
      : word === "千" ? 3
      : word === "十万" ? 5
      : word === "千万" ? 7 : 4);
  }
  return out;
}

function sameRestoredNumericEvidence(f) {
  const quote = normalizedNumberTokens(f.quote);
  const reference = normalizedNumberTokens(f.referenceQuote ?? f.reference_quote);
  if (!sameTokens(quote, reference)) return false;
  const quoteUnits = explicitUnitExponents(f.quote);
  const referenceUnits = explicitUnitExponents(f.referenceQuote ?? f.reference_quote);
  // 同じ数字でも million と billion のように単位が明示的に違う指摘は残す。
  return !quoteUnits.length || !referenceUnits.length || sameTokens(quoteUnits, referenceUnits);
}

/**
 * 同じ記号・同じ復元値の自己矛盾を hard-dropする。従来の raw digit
 * equality は、別表の同じ桁列を誤って消すため採用しない。
 */
export function isSelfContradictoryNumericFinding(finding, context = {}) {
  return isConclusiveNumericFalsePositive(finding, context);
}

export function partitionNumericFalsePositives(findings, context = {}) {
  const kept = [], dropped = [];
  const masker = contextMasker(context);
  for (const finding of findings || []) {
    const proven = isConclusiveNumericFalsePositive(finding, { masker });
    (proven ? dropped : kept).push(finding);
  }
  return { kept, dropped };
}

export function hasReviewLensEvidence(packet) {
  const p = packet || {};
  const lensPacket = /_(BROAD|TERMS|NUMBERS|STRUCTURE|GAP)(_R\d+)?$/i.test(String(p.packet_id || ""));
  const multipass = Array.isArray(p.passes) && p.passes.length > 1;
  return lensPacket || multipass;
}

export function shouldWarnMissingLens(reviewKind, packets) {
  const finished = (packets || []).filter(p => ["done", "warning"].includes(p?.status));
  return reviewKind === "consistency" && finished.length > 0 && finished.every(p => !hasReviewLensEvidence(p));
}

// 完全重複だけを除去する（順序保持、最初の1件を残す）。
export function exactDedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings || []) {
    const k = exactKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// exact dedupe 後に、同一箇所（page|category|normalized_quote）を候補として束ねる。
// 代表は先頭、others に別案を保持する。異なる suggestion は失わない。
export function groupSimilar(findings) {
  const map = new Map();
  for (const f of findings || []) {
    const k = groupKey(f);
    if (!map.has(k)) {
      map.set(k, { key: k, representative: f, members: [f] });
    } else {
      map.get(k).members.push(f);
    }
  }
  return [...map.values()].map(g => ({
    key: g.key,
    page: g.representative.page,
    category: g.representative.category,
    quote: g.representative.quote,
    representative: g.representative,
    count: g.members.length,
    candidates: g.members.map(m => ({
      suggestion: m.suggestion,
      reason: m.reason,
      pass_id: m.pass_id ?? m.passId ?? null,
      pass_lens: m.pass_lens ?? m.passLens ?? null,
      confidence: m.confidence ?? null,
      evidence_quality: m.evidence_quality ?? m.evidenceQuality ?? null,
    })),
  }));
}

// 統合パイプライン: exact dedupe → similar group。集計値も返す。
export function integrateFindings(findings) {
  const input = Array.isArray(findings) ? findings : [];
  const deduped = exactDedupe(input);
  const groups = groupSimilar(deduped);
  return {
    findings_new: deduped.length,
    findings_exact_dup: input.length - deduped.length,
    finding_groups: groups.length,
    deduped,
    groups,
  };
}
