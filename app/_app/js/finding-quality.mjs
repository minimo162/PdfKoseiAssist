export function mapFindingPage(rawPage, allowedPages, totalPages = 0) {
  const raw = Number(rawPage);
  if (!Number.isInteger(raw) || raw <= 0) return null;
  const page = raw;
  const allowed = allowedPages instanceof Set ? allowedPages : new Set(allowedPages || []);
  if (!allowed.has(page)) return null;
  if (Number(totalPages) > 0 && page > Number(totalPages)) return null;
  return page;
}

/**
 * Resolve a page number returned from a review packet.
 *
 * A packet PDF has FRONT_MATTER/PAGE_MAP pages before the original pages, so
 * a model may echo the packet's output page number (for example output P.15
 * for TARGET_CHECK source P.13).  Prefer a valid source page in the active
 * packet: a real source P.15 must never be rewritten merely because a packet
 * row also happens to have outputPage 15.  Only TARGET_CHECK rows are
 * eligible for packet-page conversion; context and reference rows remain
 * non-actionable and fail closed.
 *
 * The return value carries provenance so callers can explain an automatic
 * correction without guessing whether the number was source- or packet-side.
 */
export function mapReturnedPageWithPacketMap(rawPage, allowedPages, totalPages = 0, packetPageMap = []) {
  const raw = Number(rawPage);
  if (!Number.isInteger(raw) || raw <= 0) return { page: null, mappedFrom: null, role: "" };
  const allowed = allowedPages instanceof Set ? allowedPages : new Set(allowedPages || []);
  const total = Number(totalPages) || 0;
  // An allowed TARGET source page is authoritative even if a stale total
  // page count is supplied by a caller.  This direct-source priority is what
  // prevents an output-page/context collision from rewriting a real source
  // page.
  if (allowed.has(raw)) {
    return { page: raw, mappedFrom: null, role: "TARGET_CHECK", source: "source-page" };
  }
  const rows = Array.isArray(packetPageMap) ? packetPageMap : [];
  const row = rows.find(candidate => Number(candidate?.outputPage) === raw);
  const role = String(row?.role || "");
  const normalizedRole = role.toUpperCase();
  const sourceKind = String(row?.sourceKind || "").toLowerCase();
  const sourcePage = Number(row?.sourcePage);
  const nonActionableRole = normalizedRole === "FRONT_MATTER" || normalizedRole === "PAGE_MAP"
    || normalizedRole === "TARGET_CONTEXT" || normalizedRole === "REFERENCE_CANDIDATE"
    || /^REF\d*_?CANDIDATE$/i.test(normalizedRole);
  if (row && nonActionableRole) {
    return {
      page: null,
      mappedFrom: raw,
      role,
      source: "non-actionable-packet-page",
      nonActionable: true,
    };
  }
  if (row && normalizedRole === "TARGET_CHECK" && (!sourceKind || sourceKind === "target")
      && Number.isInteger(sourcePage) && sourcePage > 0
      && allowed.has(sourcePage) && (!total || sourcePage <= total)) {
    return { page: sourcePage, mappedFrom: raw, role, source: "packet-page-map" };
  }
  // Keep a valid raw source page available to the later quote resolver.  It
  // may be outside this packet and will be excluded there if no safe quote
  // correction can be proven; it must not be converted to context/REF data.
  if (!total || raw <= total) return { page: raw, mappedFrom: null, role: role || "raw-source-candidate", source: "raw-candidate" };
  return { page: null, mappedFrom: null, role, source: "invalid" };
}

function occurrenceCount(text, needle, limit = 2) {
  const source = String(text || "");
  const value = String(needle || "");
  if (!source || !value) return 0;
  let count = 0;
  let at = source.indexOf(value);
  while (at >= 0) {
    count++;
    if (count >= limit) return count;
    at = source.indexOf(value, at + 1);
  }
  return count;
}

const ANCHOR_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "at", "between", "by", "from", "for", "in", "into",
  "is", "it", "of", "on", "or", "period", "that", "the", "this", "to", "total", "during", "with",
  "year", "years", "ended", "ending", "balance", "march", "june", "july", "april", "january",
  "february", "may", "august", "september", "october", "november", "december",
]);
const ANCHOR_SCOPE_WORDS = new Set([
  "consolidated", "consolidation", "standalone", "nonconsolidated", "forecast", "forecasts",
  "actual", "actuals", "estimate", "estimated", "estimates", "plan", "planned", "budget",
  "budgets", "projected", "projection", "projections", "guidance", "reported", "result",
  "results", "fiscal", "fy", "year", "years", "yearended", "yearend", "quarter", "quarters",
  "qtr", "date", "dated", "asof", "period", "periods", "ended", "ending",
]);

function anchorTokens(value) {
  const text = String(value || "");
  const numeric = [];
  // Separators may have disappeared during PDF normalization.  Retain a
  // contiguous run of at least two digits as evidence, rather than asking
  // the caller to reconstruct the original number formatting.
  for (const match of text.matchAll(/\d{2,}/g)) {
    numeric.push({ value: match[0], start: match.index, end: match.index + match[0].length, kind: "number" });
  }
  const lexical = [];
  for (const match of text.matchAll(/[a-z]{4,}|[ぁ-んァ-ヶー一-龠々〆〇﨑塚神羽福祥諸都髙桒邊邉濵濱齋齊]{2,}/gi)) {
    const token = match[0].toLowerCase();
    if (ANCHOR_STOP_WORDS.has(token)) continue;
    lexical.push({ value: match[0], start: match.index, end: match.index + match[0].length, kind: "lexical" });
  }
  const scope = lexical.filter(token => ANCHOR_SCOPE_WORDS.has(token.value.toLowerCase()));
  const major = lexical.filter(token => !ANCHOR_SCOPE_WORDS.has(token.value.toLowerCase()));
  return { numeric, lexical, scope, major, important: [...numeric, ...lexical] };
}

function clampWindowStart(start, length, total) {
  return Math.max(0, Math.min(Math.max(0, total - length), Math.floor(start)));
}

function anchorCandidates(value, tokens, minimum, shortMinimum, budget = 72) {
  const maxLength = Math.min(value.length, Math.max(minimum, 72));
  const lengths = [...new Set([
    maxLength,
    Math.min(value.length, 56),
    Math.min(value.length, 40),
    minimum,
    shortMinimum,
  ].filter(length => length > 0))].sort((a, b) => b - a);
  const candidates = [];
  const seen = new Set();
  const push = (start, length, token) => {
    if (candidates.length >= budget || length <= 0 || length > value.length) return;
    const at = clampWindowStart(start, length, value.length);
    const key = `${at}:${length}`;
    if (seen.has(key)) return;
    const fragment = value.slice(at, at + length);
    if (!fragment || /\u0000/.test(fragment)) return;
    seen.add(key);
    candidates.push({ start: at, length, fragment, tokenKind: token?.kind || "", tokenValue: token?.value || "" });
  };
  // Numeric anchors are deliberately generated first.  This prevents a
  // repeated sentence prefix from becoming the only candidate when a quote
  // carries a value that identifies the table row.
  const tokensByPriority = [...tokens.numeric, ...tokens.lexical]
    .sort((a, b) => (a.kind === "number" ? -1 : 1) - (b.kind === "number" ? -1 : 1)
      || (b.value.length - a.value.length) || (a.start - b.start));
  for (const token of tokensByPriority) {
    for (const length of lengths) {
      const context = Math.max(0, length - token.value.length);
      push(token.start - Math.floor(context / 2), length, token);
      push(token.start, length, token);
      push(token.end - length, length, token);
      if (candidates.length >= budget) break;
    }
    if (candidates.length >= budget) break;
  }
  return candidates;
}

function anchorHasImportantEvidence(fragment, tokens) {
  const text = String(fragment || "");
  const numericHits = tokens.numeric.filter(token => text.includes(token.value)
    || (token.value.length >= 2 && text.includes(token.value.slice(0, Math.min(4, token.value.length))))).length;
  const lexicalHit = tokens.lexical.some(token => text.includes(token.value));
  return { numericHit: numericHits > 0, numericHits, lexicalHit };
}

function uniqueMajorLabelAnchor(blockTexts, majorTokens) {
  for (const token of majorTokens.slice().sort((a, b) => b.value.length - a.value.length || a.start - b.start)) {
    let hit = null;
    let count = 0;
    for (const block of blockTexts) {
      const occurrences = occurrenceCount(block.text, token.value, 2);
      if (!occurrences) continue;
      count += occurrences;
      if (count > 1) break;
      hit = { block, localStart: block.text.indexOf(token.value), token };
    }
    if (count === 1 && hit && hit.localStart >= 0) {
      return {
        start: hit.block.start + hit.localStart,
        length: token.value.length,
        fragment: token.value,
        blockStart: hit.block.start,
        blockEnd: hit.block.end,
        blockIndex: hit.block.blockIndex,
        tokenKind: "major-label",
      };
    }
  }
  return null;
}

function anchorBbox(charBoxes, segment) {
  if (!Array.isArray(charBoxes) || !segment || !Number.isInteger(segment.start)
      || !Number.isInteger(segment.length) || segment.start < 0 || segment.length <= 0) return null;
  const boxes = charBoxes.slice(segment.start, segment.start + segment.length);
  if (boxes.length !== segment.length || boxes.some(box => !box
      || !Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y))
      || !Number.isFinite(Number(box.w)) || !Number.isFinite(Number(box.h))
      || Number(box.w) <= 0 || Number(box.h) <= 0)) return null;
  const minX = Math.min(...boxes.map(box => Number(box.x)));
  const minY = Math.min(...boxes.map(box => Number(box.y)));
  const maxX = Math.max(...boxes.map(box => Number(box.x) + Number(box.w)));
  const maxY = Math.max(...boxes.map(box => Number(box.y) + Number(box.h)));
  const maxCharHeight = Math.max(...boxes.map(box => Number(box.h)));
  const height = maxY - minY;
  // A fragment that silently spans multiple visual lines is not a reliable
  // line anchor.  Reject it here instead of allowing a broad bbox to make an
  // unrelated label/numeric block look vertically adjacent.
  if (![minX, minY, maxX, maxY, maxCharHeight, height].every(Number.isFinite)
      || maxX <= minX || maxY <= minY || height > maxCharHeight * 1.75) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height,
    centerY: (minY + maxY) / 2,
    maxCharHeight,
  };
}

function anchorsShareLayoutLine(charBoxes, first, second) {
  const firstBox = anchorBbox(charBoxes, first);
  const secondBox = anchorBbox(charBoxes, second);
  if (!firstBox || !secondBox) return null;
  if (first.blockIndex === second.blockIndex) {
    return { sameBlock: true, first: firstBox, second: secondBox, centerDiff: 0, overlapRatio: 1 };
  }
  const verticalOverlap = Math.max(0, Math.min(firstBox.maxY, secondBox.maxY)
    - Math.max(firstBox.minY, secondBox.minY));
  const overlapRatio = verticalOverlap / Math.max(1, Math.min(firstBox.height, secondBox.height));
  const centerDiff = Math.abs(firstBox.centerY - secondBox.centerY);
  // PDF text items on one visual line can have slightly different baselines
  // or font sizes.  A line is still proven by either substantial vertical
  // overlap or a center distance within one individual glyph height.
  const centerTolerance = Math.max(firstBox.maxCharHeight, secondBox.maxCharHeight) * 0.9;
  if (overlapRatio < 0.5 && centerDiff > centerTolerance) return null;
  return { sameBlock: false, first: firstBox, second: secondBox, centerDiff, overlapRatio, centerTolerance };
}

function scopeWordsVerified(blockTexts, scopeTokens) {
  for (const token of scopeTokens || []) {
    let count = 0;
    for (const block of blockTexts) {
      count += occurrenceCount(block.text, token.value, 2);
      if (count > 1) break;
    }
    // Scope/period words are evidence, not substitute labels.  If the quote
    // says consolidated/forecast/etc. and that word is absent or repeated on
    // the page, do not let a bare number create a misleading partial match.
    if (count !== 1) return false;
  }
  return true;
}

/**
 * Find a long, unique contiguous anchor for a quote that spans layout blocks
 * as a location aid only.  Production quote validation and page correction
 * must not call this helper; they require a single-block full-text match.
 *
 * `normalized` and `needle` are expected to already use the same locator
 * normalization. `blockRanges` are half-open offsets into `normalized`; the
 * function never joins two ranges. A fragment must occur exactly once in one
 * block and exactly once across all blocks on the page. If the quote contains
 * a major measure/row label, that label must also occur exactly once in a
 * same visual line (proven by per-character geometry when it crosses blocks);
 * the returned `labelAnchor` lets the UI highlight both blocks without
 * treating their text as one quote. Short or ambiguous candidates return null
 * so callers can keep the existing fail-closed path.
 */
export function chooseUniqueBlockFragment(normalized, blockRanges, needle, {
  minLength = 16,
  charBoxes = null,
  locationAidOnly = false,
} = {}) {
  if (!locationAidOnly) return null;
  const source = String(normalized || "");
  const value = String(needle || "");
  const minimum = Math.max(12, Number(minLength) || 16);
  const tokens = anchorTokens(value);
  // A short numeric table cell is admissible when it is both unique and
  // carries quote-derived numeric evidence.  This is narrower than lowering
  // the global minimum: boilerplate-only fragments still fail closed.
  const shortNumericMinimum = Math.max(8, Math.min(12, minimum - 4));
  if (!source || !value || !tokens.important.length
      || value.length < (tokens.numeric.length ? shortNumericMinimum : minimum)) return null;
  const ranges = (Array.isArray(blockRanges) ? blockRanges : [])
    .map(range => ({ start: Number(range?.start), end: Number(range?.end) }))
    .filter(range => Number.isInteger(range.start) && Number.isInteger(range.end)
      && range.start >= 0 && range.end > range.start && range.end <= source.length);
  if (!ranges.length) return null;
  const candidates = anchorCandidates(value, tokens, minimum, shortNumericMinimum);
  // Fixed candidate budget + one prebuilt block string per range keeps this
  // bounded by O(blocks * budget * text) instead of scanning every quote
  // window.  In practice this remains linear in the page text for the usual
  // 600-character/80-block worst case.
  const blockTexts = ranges.map((range, blockIndex) => ({ ...range, blockIndex, text: source.slice(range.start, range.end) }));
  const labelAnchor = tokens.major.length ? uniqueMajorLabelAnchor(blockTexts, tokens.major) : null;
  if (tokens.major.length && !labelAnchor) return null;
  if (!scopeWordsVerified(blockTexts, tokens.scope)) return null;
  for (const candidate of candidates.sort((a, b) => {
    const aNumber = a.tokenKind === "number" ? 0 : 1;
    const bNumber = b.tokenKind === "number" ? 0 : 1;
    return aNumber - bNumber
      || (b.tokenValue.length - a.tokenValue.length)
      || (b.length - a.length)
      || (a.start - b.start);
  })) {
    const evidence = anchorHasImportantEvidence(candidate.fragment, tokens);
    if (tokens.numeric.length && !evidence.numericHit) continue;
    if (!tokens.numeric.length && !evidence.lexicalHit) continue;
    // A single number is not enough to distinguish `Revenue 999999` from
    // `Headcount 999999`.  If the quote has an indicator word, keep it in
    // the anchor for one-number quotes.  Multi-number table rows may use a
    // numeric segment because their repeated values are the row identity
    // (the F0017/F0023 layout split is this case).
    if (tokens.numeric.length === 1 && tokens.lexical.length && !evidence.lexicalHit) continue;
    const strongNumericHit = tokens.numeric.some(token => token.value.length >= 4
      && candidate.fragment.includes(token.value.slice(0, 4)));
    if (tokens.numeric.length > 1 && tokens.lexical.length
        && evidence.numericHits < 2 && !evidence.lexicalHit && !strongNumericHit) continue;
    const allowShort = candidate.length >= shortNumericMinimum && evidence.numericHit;
    if (candidate.length < minimum && !allowShort) continue;
    for (const block of blockTexts) {
      const localStart = block.text.indexOf(candidate.fragment);
      if (localStart < 0 || occurrenceCount(block.text, candidate.fragment) !== 1) continue;
      let globalCount = 0;
      for (const other of blockTexts) {
        globalCount += occurrenceCount(other.text, candidate.fragment);
        if (globalCount > 1) break;
      }
      if (globalCount !== 1) continue;
      const numericBlockIndex = block.blockIndex;
      const fragmentSegment = {
        start: block.start + localStart,
        length: candidate.length,
        blockIndex: numericBlockIndex,
      };
      let anchorGeometry = null;
      if (Array.isArray(charBoxes)) {
        const fragmentBox = anchorBbox(charBoxes, fragmentSegment);
        if (!fragmentBox) continue;
        if (labelAnchor) {
          anchorGeometry = anchorsShareLayoutLine(charBoxes, fragmentSegment, labelAnchor);
          if (!anchorGeometry) continue;
        }
      } else if (labelAnchor && labelAnchor.blockIndex !== numericBlockIndex) {
        // A nearby block ordinal is not geometric evidence.  The UI passes
        // charBoxes from the PDF.js layout index; callers without coordinates
        // may only use the safe same-block exception.
        continue;
      }
      return {
        start: fragmentSegment.start,
        length: candidate.length,
        fragment: candidate.fragment,
        blockStart: block.start,
        blockEnd: block.end,
        blockIndex: numericBlockIndex,
        quoteStart: candidate.start,
        tokenKind: candidate.tokenKind,
        labelAnchor,
        anchorGeometry,
        evidence,
        locationAidOnly: true,
      };
    }
  }
  return null;
}

const parseProbability = raw => {
  if (raw === null || raw === undefined || raw === "") return { value: null, invalid: false };
  const value = Number(raw);
  return { value: Number.isFinite(value) && value >= 0 && value <= 1 ? value : null, invalid: !Number.isFinite(value) || value < 0 || value > 1 };
};

export function assessFindingEvidence({ confidence, readingConfidence, evidenceQuality, requireComplete = false } = {}) {
  const overall = parseProbability(confidence);
  const reading = parseProbability(readingConfidence);
  const quality = String(evidenceQuality || "").trim().toLowerCase();
  let excludedReason = "";
  if (overall.invalid || reading.invalid) excludedReason = "invalid-confidence";
  else if (quality && quality !== "clear") excludedReason = "low-evidence";
  else if (reading.value !== null && reading.value < 0.75) excludedReason = "low-reading-confidence";
  const missingEvidence = overall.value === null || reading.value === null || !quality;
  if (!excludedReason && requireComplete && missingEvidence) excludedReason = "missing-evidence";
  return {
    confidence: overall.value,
    readingConfidence: reading.value,
    evidenceQuality: quality,
    excludedReason,
    needsHumanReview: missingEvidence,
    warning: missingEvidence ? "根拠の確信度が欠けているため、人による確認が必要です。" : "",
  };
}

function normalizeSourceFragment(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")
    .replace(/[−‐‑‒–—―﹣－]/g, "-")
    .replace(/[“”„‟〝〟]/g, '"')
    .replace(/[‘’‚‛＇`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueOccurrenceIndex(haystack, needle) {
  if (!haystack || !needle) return -1;
  const first = haystack.indexOf(needle);
  if (first < 0) return -1;
  return haystack.indexOf(needle, first + Math.max(1, needle.length)) < 0 ? first : -1;
}

/**
 * マスク済みquoteをPDF本文へ戻す。
 * 復元済み候補が本文に一意にある場合はそれを優先し、数値ワイルドカードが
 * 複数行に当たる場合は最初の行を選ばずfail-closedにする。
 */
export function chooseSourceBackedFragment(masked, candidates, source) {
  const normalizedSource = normalizeSourceFragment(source);
  if (!normalizedSource) return "";
  const exact = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const normalized = normalizeSourceFragment(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const index = uniqueOccurrenceIndex(normalizedSource, normalized);
    if (index >= 0) exact.push({ candidate: String(candidate), normalized, index });
  }
  if (exact.length) {
    exact.sort((a, b) => b.normalized.length - a.normalized.length);
    const best = exact[0];
    const bestEnd = best.index + best.normalized.length;
    if (exact.every(item => item.index >= best.index && item.index + item.normalized.length <= bestEnd)) {
      return best.candidate;
    }
    return "";
  }

  const normalizedMasked = normalizeSourceFragment(masked);
  if (!normalizedMasked) return "";
  const parts = normalizedMasked.split(/(⟦#[A-Z]{3}⟧)/gi);
  const pattern = parts.map(part => /^⟦#[A-Z]{3}⟧$/i.test(part)
    ? String.raw`\d[\d,]*(?:\.\d+)?`
    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  let matches = [];
  try { matches = [...normalizedSource.matchAll(new RegExp(pattern, "gi"))].map(match => match[0]); }
  catch (_) { return ""; }
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : "";
}

function claimedMissingStructureNumbers(finding) {
  const text = [finding?.issueSummary, finding?.reason].map(String).join(" ");
  const numbers = new Set();
  const patterns = [
    /(?:項番|見出し番号|番号)\s*(?:が|の|は)?\s*(\d{1,3})\s*(?:を)?\s*(?:欠|抜|欠落|存在しな|見当たら|ない|ありません)/gi,
    /(?:missing|omitted|skipped|absent)\s+(?:item|section|number|no\.?\s*)?(\d{1,3})/gi,
    /(?:item|section|number|no\.?)\s*(\d{1,3})\s+(?:is\s+)?(?:missing|omitted|skipped|absent)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) numbers.add(Number(match[1]));
  }
  return numbers;
}

export function hasClaimedMissingStructureNumber(finding) {
  return claimedMissingStructureNumbers(finding).size > 0;
}

function normalizeStructureBody(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\s\-‐‑‒–—―•・*]+/, "")
    .replace(/^[\s(\[]*\d{1,3}\s*[)\].．:：-]\s*/, "")
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[^a-z0-9ぁ-んァ-ヶー一-龠々〆〇]+/g, "");
}

function quotedStructureBodies(value) {
  const text = String(value || "");
  const bodies = [];
  for (const pattern of [/「([^」]{6,240})」/g, /『([^』]{6,240})』/g, /“([^”]{6,240})”/g, /"([^"\r\n]{6,240})"/g]) {
    for (const match of text.matchAll(pattern)) bodies.push(match[1]);
  }
  return bodies;
}

function structureBodyCandidates(finding) {
  const raw = [finding?.quote];
  for (const value of [finding?.issueSummary, finding?.reason, finding?.suggestion]) {
    raw.push(...quotedStructureBodies(value));
  }
  return Array.from(new Set(raw.map(normalizeStructureBody).filter(body => body.length >= 12)));
}

/**
 * 「項番Nが無い」という主張を、同じ見出し本文を持つ実在の番号付き行で反証する。
 * ページ内の無関係な項番Nだけでは除外しない。
 */
export function isContradictedMissingStructureFinding(finding, pageText) {
  const missing = claimedMissingStructureNumbers(finding);
  if (!missing.size) return false;
  const candidateBodies = structureBodyCandidates(finding);
  if (!candidateBodies.length) return false;
  for (const line of String(pageText || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[([]?\s*(\d{1,3})\s*[)\].．:：]\s*(.+)$/);
    if (!match || !missing.has(Number(match[1]))) continue;
    const lineBody = normalizeStructureBody(match[2]);
    if (lineBody.length < 12) continue;
    if (candidateBodies.some(body => lineBody === body || lineBody.includes(body) || body.includes(lineBody))) return true;
  }
  return false;
}
