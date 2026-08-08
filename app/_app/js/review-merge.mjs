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

export function isLikelyTableRowIndexOmission(finding) {
  const f = finding || {};
  if (String(f.category || "").toLowerCase() !== "omission") return false;
  const quote = normalizedNumberTokens(f.quote);
  const reference = normalizedNumberTokens(f.referenceQuote ?? f.reference_quote);
  if (reference.length !== quote.length + 1 || reference.length < 2) return false;
  const first = Number(reference[0].replace(/^\+/, ""));
  return Number.isInteger(first) && first >= 1 && first <= 100
    && quote.every((value, i) => value === reference[i + 1]);
}

function explicitUnitExponents(value) {
  const out = [];
  for (const match of String(value || "").matchAll(/trillions?|billions?|millions?|thousands?|兆|億|百万|千/gi)) {
    const word = match[0].toLowerCase().replace(/s$/, "");
    out.push(word === "trillion" || word === "兆" ? 12
      : word === "billion" ? 9
      : word === "億" ? 8
      : word === "million" || word === "百万" ? 6 : 3);
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
 * モデルが同じ記号を「異なる数値」と報告した自己矛盾だけを除外する。
 * 符号は比較に含めるので、△X と X のような本物の不一致は残る。
 */
export function isSelfContradictoryNumericFinding(finding) {
  const f = finding || {};
  if (!NUMERIC_CATEGORIES.has(String(f.category || "").toLowerCase())) return false;
  const quote = signedPlaceholderTokens(f.quote);
  const reference = signedPlaceholderTokens(f.referenceQuote ?? f.reference_quote);
  if (sameTokens(quote, reference)) return true;
  const reason = signedPlaceholderTokens(f.reason);
  if (reason.length >= 2 && new Set(reason).size === 1) return true;
  return hasEqualEitherOrNumbers(f.suggestion) || hasEqualEitherOrNumbers(f.reason)
    || hasEqualEitherOrNumbers(f.issueSummary ?? f.issue_summary)
    || sameRestoredNumericEvidence(f);
}

export function partitionNumericFalsePositives(findings) {
  const kept = [], dropped = [];
  for (const finding of findings || []) {
    (isSelfContradictoryNumericFinding(finding) ? dropped : kept).push(finding);
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
