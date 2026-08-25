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

/**
 * Extract complete numeric lexemes from the raw quote before a locator
 * profile removes spaces.  A strict locator may turn `143,459 137,450` into
 * `143,459137,450`; the latter must never be reparsed as the invented token
 * `459137`.  `normalize` is the same profile callback used for the page
 * index, so each returned value can be matched without guessing from the
 * compacted quote.
 */
export function extractNumericLexemes(rawQuote, normalize = value => String(value || "")) {
  const source = String(rawQuote || "");
  if (!source) return [];
  const out = [];
  const seen = new Set();
  // Keep signs, accounting parentheses, grouping separators, and decimals in
  // the lexeme.  This is deliberately not a generic `\d+` tokenizer.
  const re = /(?:[△▲＋+−-]\s*)?(?:[（(]\s*)?(?:\d+(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*[）)])?/g;
  for (const match of source.matchAll(re)) {
    const raw = String(match[0] || "").trim();
    if (!raw || !/\d/.test(raw)) continue;
    // Page labels are navigation metadata, not row values.  Do not let
    // `P.26` or `page 26` become a split-anchor candidate.
    const prefix = source.slice(0, Number(match.index || 0));
    // An empty prefix means the number starts the quote; only suppress a
    // number when a real page-label prefix (`P.26`/`page 26`) precedes it.
    if (/(?:^|\b)(?:p|page)\s*[.．]?\s*$/i.test(prefix.trim())) continue;
    const value = String(normalize(raw) || "");
    if (!value || !/\d/.test(value)) continue;
    const normalizedStart = String(normalize(source.slice(0, Number(match.index || 0))) || "").length;
    const key = `${normalizedStart}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      raw,
      value,
      start: normalizedStart,
      end: normalizedStart + value.length,
      rawStart: Number(match.index || 0),
      rawEnd: Number(match.index || 0) + match[0].length,
    });
  }
  return out;
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

function anchorTokens(value, numericAllowlist = null) {
  const text = String(value || "");
  const numeric = [];
  if (Array.isArray(numericAllowlist)) {
    // Production split-anchor callers pass complete numeric lexemes extracted
    // from the raw quote.  Never infer a new number from the compacted needle
    // in this mode (`459137` must not be made from `459 137`).
    const seen = new Set();
    for (const item of numericAllowlist) {
      const tokenValue = String(item?.value ?? item?.normalized ?? item ?? "");
      if (!tokenValue || !/\d/.test(tokenValue)) continue;
      let start = Number(item?.start);
      if (!Number.isInteger(start) || start < 0 || text.slice(start, start + tokenValue.length) !== tokenValue) {
        start = text.indexOf(tokenValue);
      }
      if (start < 0) continue;
      const key = `${start}:${tokenValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      numeric.push({
        value: tokenValue,
        start,
        end: start + tokenValue.length,
        kind: "number",
        raw: String(item?.raw ?? item?.rawValue ?? ""),
      });
    }
  } else {
    // Backward-compatible location-aid behavior for callers that do not have
    // a raw quote.  The production split-anchor path always supplies the
    // allowlist above.
    for (const match of text.matchAll(/\d{2,}/g)) {
      numeric.push({ value: match[0], start: match.index, end: match.index + match[0].length, kind: "number" });
    }
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

function numericLexemeBoundary(text, start, length, token) {
  const source = String(text || "");
  const value = String(token || "");
  const before = source[start - 1] || "";
  const after = source[start + length] || "";
  // A compacted layout block may place adjacent cells directly next to each
  // other.  Reject a substring that ends in the middle of a digit/grouping
  // run; only a complete lexeme from the raw quote may be highlighted.
  if (/[0-9０-９,，.．]/.test(before) || /[0-9０-９,，.．]/.test(after)) return false;
  // If the page contains an accounting sign or parenthesis immediately next
  // to the matched digits, the quote must include that sign/parenthesis too.
  if (/[△▲＋+−-（(]/.test(before) && !/^[△▲＋+−-（(]/.test(value)) return false;
  if (/[）)]/.test(after) && !/[）)]$/.test(value)) return false;
  return true;
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
    // A raw-quote allowlist may identify a complete short numeric cell that
    // is isolated in its own layout block.  Include that exact length so the
    // returned segment can be the full cell rather than an invented context
    // window spanning adjacent cells.
    ...tokens.numeric.map(token => token.value.length),
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
    candidates.push({
      start: at,
      length,
      fragment,
      tokenKind: token?.kind || "",
      tokenValue: token?.value || "",
      tokenRawValue: token?.raw || token?.rawValue || "",
    });
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
  const minCharHeight = Math.min(firstBox.maxCharHeight, secondBox.maxCharHeight);
  const baselineDiff = Math.abs(firstBox.maxY - secondBox.maxY);
  // Substantial vertical overlap is the primary proof that two independently
  // extracted blocks share a visual line.  When overlap is low, use a much
  // stricter center/baseline tolerance than the old 0.9×height fallback: a
  // y-offset of 8–9px for 10px glyphs is a different row even if the broad
  // center-distance heuristic happened to accept it.
  const centerTolerance = Math.max(1, minCharHeight * 0.25);
  const baselineTolerance = Math.max(1, minCharHeight * 0.25);
  if (overlapRatio < 0.5
      && (centerDiff > centerTolerance || baselineDiff > baselineTolerance)) return null;
  return {
    sameBlock: false,
    first: firstBox,
    second: secondBox,
    centerDiff,
    overlapRatio,
    centerTolerance,
    baselineDiff,
    baselineTolerance,
  };
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
 * Find a long, unique contiguous anchor for a quote that spans layout blocks.
 * The default is still a location aid only.  A display-only caller may opt in
 * to the explicit `mode: "split-anchor"` mode; that mode is intentionally
 * narrow and returns enough provenance for the caller to draw the numeric
 * fragment and its unique major label as two separate boxes.  It never makes
 * the joined quote a valid single-block evidence match.
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
  mode = "",
  numericTokens = null,
} = {}) {
  const splitAnchorMode = mode === "split-anchor";
  if (!locationAidOnly && !splitAnchorMode) return null;
  const source = String(normalized || "");
  const value = String(needle || "");
  const minimum = Math.max(12, Number(minLength) || 16);
  const tokens = anchorTokens(value, Array.isArray(numericTokens) ? numericTokens : null);
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
    const exactAllowlistedCell = Array.isArray(numericTokens)
      && candidate.tokenKind === "number"
      && candidate.length === candidate.tokenValue.length
      && candidate.length >= 8;
    const allowShort = (candidate.length >= shortNumericMinimum && evidence.numericHit) || exactAllowlistedCell;
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
      let fragmentSegment = {
        start: block.start + localStart,
        length: candidate.length,
        blockIndex: numericBlockIndex,
      };
      if (splitAnchorMode && candidate.tokenKind === "number") {
        // A contextual fragment can be unique while its numeric part occurs
        // in another table cell on the same page.  Count the complete numeric
        // token across all blocks before accepting a split-anchor; letters
        // may adjoin a PDF-extracted token (e.g. `123dollar`), but a longer
        // digit run must not count as the same token.
        const token = String(candidate.tokenValue || "");
        if (!token) continue;
        const tokenHits = [];
        for (const other of blockTexts) {
          let at = other.text.indexOf(token);
          while (at >= 0) {
            if (numericLexemeBoundary(other.text, at, token.length, token)) {
              tokenHits.push({ block: other, localStart: at });
              if (tokenHits.length > 1) break;
            }
            at = other.text.indexOf(token, at + 1);
          }
          if (tokenHits.length > 1) break;
        }
        if (tokenHits.length !== 1 || tokenHits[0].block.blockIndex !== numericBlockIndex) continue;
        fragmentSegment = {
          start: tokenHits[0].block.start + tokenHits[0].localStart,
          length: token.length,
          blockIndex: numericBlockIndex,
        };
      }
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
        length: fragmentSegment.length,
        fragment: source.slice(fragmentSegment.start, fragmentSegment.start + fragmentSegment.length),
        blockStart: block.start,
        blockEnd: block.end,
        blockIndex: numericBlockIndex,
        quoteStart: candidate.start,
        tokenKind: candidate.tokenKind,
        tokenRawValue: candidate.tokenRawValue || "",
        labelAnchor,
        anchorGeometry,
        evidence,
        locationAidOnly: !splitAnchorMode,
        highlightMode: splitAnchorMode ? "split-anchor" : "location-aid",
      };
    }
  }
  return null;
}

const SUGGESTION_NUMERIC_CATEGORIES = new Set([
  "number_mismatch", "value_inconsistency", "accounting_inconsistency", "numbers",
  "date_mismatch", "日付不一致", "数値不一致", "数値の食い違い", "計算の食い違い",
]);

// A suggestion is not always a paste-ready replacement.  In particular,
// omission/consistency findings often tell the reviewer what to verify or
// add, and their Japanese action sentence quite legitimately contains the
// fiscal years or dates being discussed.  Do not turn that instruction into
// a misleading "numeric-token-change" replacement.
function looksLikeActionSuggestion(value) {
  const text = String(value || "").trim();
  if (!text || !/[ぁ-んァ-ヶ一-龯]/u.test(text)) return false;
  // Keep this deliberately verb-oriented.  A Japanese noun/label embedded in
  // an English replacement is not enough to bypass the numeric guard.
  return /(?:記載|明記|追記|追加|補足|確認|検討|修正|訂正|統一|一致|揃え|合わせ|見直|反映|変更|削除|再生成|補う|入れ|示す|直す|対応|整合|確認し|記入)(?:する|してください|します|せよ|すること|を)?[。．、）」』\s]*$/u.test(text);
}

const SECTION_INDEX_RE = /[（(]\s*\d{1,3}\s*[）)]/gu;

function sectionIndexes(value) {
  const text = String(value || "").normalize("NFKC");
  return [...text.matchAll(SECTION_INDEX_RE)].map(match => ({
    value: Number(String(match[0]).replace(/\D/g, "")),
    start: Number(match.index || 0),
    end: Number(match.index || 0) + match[0].length,
  }));
}

function sectionIndexPlaceholder(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(SECTION_INDEX_RE, "__section_index__")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isLeadingSectionIndex(value, index) {
  const text = String(value || "").normalize("NFKC");
  return text.slice(0, Number(index?.start) || 0).trim() === "";
}

/**
 * A translated heading may intentionally correct its list number, e.g.
 * TARGET `(2) Consolidated Cash Flows` -> `(3) ...`.  This is safe only when
 * it is a translation finding, the rest of the replacement is byte-for-byte
 * the same after masking that one heading index, and the new index is
 * present in the cited reference quote.  A number changed elsewhere in the
 * sentence is still rejected.
 */
function isVerifiedSectionIndexCorrection({ quote = "", referenceQuote = "", reference_quote = "", suggestion = "", category = "", issueScope = "", issue_scope = "" } = {}) {
  referenceQuote = String(referenceQuote || reference_quote || "");
  const kind = String(category || "").trim().toLowerCase();
  const scope = String(issueScope || issue_scope || "").trim().toLowerCase();
  if (kind !== "mistranslation" && kind !== "translation_consistency" && scope !== "translation_consistency") return false;
  const before = sectionIndexes(quote);
  const after = sectionIndexes(suggestion);
  if (before.length !== 1 || after.length !== 1 || before[0].value === after[0].value) return false;
  // Only a leading heading/list marker is eligible.  A parenthesized amount
  // in the middle of a translated sentence is content, not a section number.
  if (!isLeadingSectionIndex(quote, before[0]) || !isLeadingSectionIndex(suggestion, after[0])) return false;
  const reference = sectionIndexes(referenceQuote);
  if (reference.length !== 1 || !isLeadingSectionIndex(referenceQuote, reference[0])
      || reference[0].value !== after[0].value) return false;
  return sectionIndexPlaceholder(quote) === sectionIndexPlaceholder(suggestion);
}

// `100 millions of yen` is a common but unidiomatic rendering of the
// Japanese 億円 unit.  Replacing it with `hundreds of millions of yen`
// changes the surface number while preserving the unit meaning; allow only
// this exact scale/unit rewrite and only when every surrounding character
// remains unchanged.  Do not generalize this exception to arbitrary
// `100 thousands`/`100 billions` prose, where the quantity may actually
// change.
const CARDINAL_UNIT_REWRITES = Object.freeze([
  { from: /^\s*\(\s*In\s+100\s+millions\s+of\s+yen\s*\)\s*$/i, to: /^\s*\(\s*In\s+hundreds\s+of\s+millions\s+of\s+yen\s*\)\s*$/i },
]);

function unitPhrasePlaceholder(value, from, to) {
  const text = String(value || "").normalize("NFKC");
  return text
    .replace(from, "__unit_phrase__")
    .replace(to, "__unit_phrase__")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isSafeCardinalUnitRewrite({ quote = "", suggestion = "" } = {}) {
  for (const rewrite of CARDINAL_UNIT_REWRITES) {
    // Reset regexp state before each invocation in case a future rewrite
    // pattern becomes global and RegExp.test starts mutating lastIndex.
    rewrite.from.lastIndex = 0;
    rewrite.to.lastIndex = 0;
    const hasFrom = rewrite.from.test(String(quote || ""));
    rewrite.from.lastIndex = 0;
    const hasTo = rewrite.to.test(String(suggestion || ""));
    rewrite.to.lastIndex = 0;
    if (!hasFrom || !hasTo) continue;
    if (unitPhrasePlaceholder(quote, rewrite.from, rewrite.to)
        === unitPhrasePlaceholder(suggestion, rewrite.from, rewrite.to)) return true;
    rewrite.from.lastIndex = 0;
    rewrite.to.lastIndex = 0;
  }
  return false;
}

function comparableSuggestionTokens(value) {
  let source = String(value || "").normalize("NFKC");
  // Page references are navigation metadata, not values that a proofreading
  // correction is expected to preserve.  Remove them before comparing the
  // remaining numeric/date tokens.
  source = source.replace(/\b(?:P|page)\s*[.．]?\s*\d{1,4}\b/giu, " ");
  const tokens = [];
  const dateRe = /\b(?:FY\s*)?\d{4}(?:\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?\s*期?|[/-]\d{1,2}(?:[/-]\d{1,2})?)?/giu;
  const dateSpans = [];
  for (const match of source.matchAll(dateRe)) {
    const raw = String(match[0] || "").replace(/\s+/g, "").toLowerCase();
    if (!raw) continue;
    dateSpans.push([match.index, match.index + match[0].length]);
    tokens.push(`date:${raw}`);
  }
  const numberRe = /[+＋−-]?\(?\d[\d,]*(?:\.\d+)?\)?/g;
  for (const match of source.matchAll(numberRe)) {
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    if (dateSpans.some(([left, right]) => start < right && end > left)) continue;
    let matched = String(match[0]);
    // In product names, an ASCII hyphen immediately after a letter is a
    // lexical separator (`CX-30`, `Model-3`), not a negative sign.  Keep a
    // standalone/whitespace-separated `-30` as a real negative number.
    if (matched.startsWith("-") && /[A-Za-z]/.test(source[start - 1] || "")) matched = matched.slice(1);
    let raw = matched.replace(/,/g, "").replace(/^\((.*)\)$/, "-$1")
      .replace(/^[△▲−]/, "-").replace(/^[+＋]/, "");
    const negative = raw.startsWith("-");
    if (negative) raw = raw.slice(1);
    let [integer, fraction = ""] = raw.split(".");
    integer = integer.replace(/^0+(?=\d)/, "") || "0";
    tokens.push(`number:${negative ? "-" : "+"}${integer}${fraction ? `.${fraction}` : ""}`);
  }
  return tokens;
}

/**
 * Detect a correction proposal that changes a numeric/date token even though
 * the finding is not a numeric/date finding.  This protects proofreading
 * suggestions such as `CX 30` → `CX 30.00`: the grammar edit may be valid,
 * but the unrelated numeric rewrite must be regenerated rather than shown as
 * a paste-ready correction.  Page references are deliberately ignored.
 */
export function suggestionChangesNumericOrDateTokens({ quote = "", referenceQuote = "", reference_quote = "", suggestion = "", category = "", issueScope = "", issue_scope = "", suggestionKind = "", suggestion_kind = "" } = {}) {
  referenceQuote = String(referenceQuote || reference_quote || "");
  if (SUGGESTION_NUMERIC_CATEGORIES.has(String(category || "").trim().toLowerCase())) return false;
  if (String(suggestionKind || suggestion_kind || "").trim().toLowerCase() === "action") return false;
  if (looksLikeActionSuggestion(suggestion)) return false;
  if (isVerifiedSectionIndexCorrection({ quote, referenceQuote, suggestion, category, issueScope, issue_scope })) return false;
  if (isSafeCardinalUnitRewrite({ quote, suggestion })) return false;
  const before = comparableSuggestionTokens(quote);
  const after = comparableSuggestionTokens(suggestion);
  if (!before.length && !after.length) return false;
  const base = new Map(), candidate = new Map();
  for (const token of before) base.set(token, (base.get(token) || 0) + 1);
  for (const token of after) candidate.set(token, (candidate.get(token) || 0) + 1);
  if (base.size === candidate.size && [...base].every(([token, count]) => candidate.get(token) === count)) return false;
  // A reference quote can carry the source's canonical value when the target
  // quote was shortened.  Permit a suggestion token only when it is already
  // present in either cited source; never trust a number introduced solely by
  // the model's correction text.
  const cited = new Set([...comparableSuggestionTokens(quote), ...comparableSuggestionTokens(referenceQuote)]);
  if ([...base].some(([token, count]) => count > (candidate.get(token) || 0))) return true;
  return [...candidate].some(([token, count]) => count > (base.get(token) || 0) && !cited.has(token));
}

const SAFE_SUGGESTION_REGENERATION_TEXT = "原文の数値・日付・固有名詞を変えず、文法部分だけ修正した案を作り直してください。";

export function sanitizeSuggestionByNumericIntegrity({ quote = "", referenceQuote = "", reference_quote = "", suggestion = "", category = "", issueScope = "", issue_scope = "", suggestionKind = "", suggestion_kind = "" } = {}) {
  referenceQuote = String(referenceQuote || reference_quote || "");
  const original = String(suggestion || "");
  if (!suggestionChangesNumericOrDateTokens({
    quote,
    referenceQuote,
    suggestion: original,
    category,
    issueScope,
    issue_scope,
    suggestionKind,
    suggestion_kind,
  })) {
    return { suggestion: original, original: "", needsRegeneration: false };
  }
  return {
    suggestion: SAFE_SUGGESTION_REGENERATION_TEXT,
    original,
    needsRegeneration: true,
  };
}

const SUGGESTION_INTEGRITY_MARKER = "numeric-token-change";
const SUGGESTION_INTEGRITY_WARNING = "自動作成された案は原文と一致しない内容を含んでいたため、表示していません。";
const INCOMPLETE_EVIDENCE_WARNING = "原文の数値・日付・固有名詞を照合し、表示中の修正案が合わなければ修正案を作り直してください。";

// Keep old exports/report payloads readable without carrying the old
// implementation wording into the user-facing warning.  The original
// proposal remains in suggestion_original for audit/export only.
const LEGACY_INTEGRITY_WARNING_PATTERNS = [
  /Copilotが生成した元の修正案は、?数値・日付・固有名詞を変更していたため破棄しました。?\s*現在表示しているのは置き換え文ではなく、安全な再生成を依頼する「やること」です。?/gu,
  /Copilotの元の修正案は破棄済みです。?/gu,
  /元の修正案を無効化しました。?/gu,
  /現在表示しているのは置き換え文ではなく、安全な再生成を依頼する「やること」です。?/gu,
];

function normalizeIntegrityWarning(value = "") {
  let warning = String(value || "").trim();
  let hadLegacyIntegrityWarning = false;
  for (const pattern of LEGACY_INTEGRITY_WARNING_PATTERNS) {
    const replaced = warning.replace(pattern, "");
    hadLegacyIntegrityWarning ||= replaced !== warning;
    warning = replaced;
  }
  const hadIntegrityWarning = warning.includes(SUGGESTION_INTEGRITY_WARNING);
  warning = warning.replaceAll(SUGGESTION_INTEGRITY_WARNING, "").trim();
  if (hadLegacyIntegrityWarning || hadIntegrityWarning) {
    warning = [warning, SUGGESTION_INTEGRITY_WARNING].filter(Boolean).join(" ");
  }
  return warning;
}

// Keep legacy report payloads readable after they are re-imported or
// rendered directly.  The old sentence only delegated the decision back to
// the user; this replacement names the concrete comparison and next action.
export function normalizeFindingQualityWarning(value = "") {
  return normalizeIntegrityWarning(String(value || "")).replace(
    /根拠の確信度が欠けているため、人による確認が必要です?。?/gu,
    INCOMPLETE_EVIDENCE_WARNING,
  );
}

/**
 * Apply the suggestion safety gate to a finding at a shared normalization
 * boundary.  The marker makes the operation idempotent when an imported JSON
 * is normalized again while writing a ZIP/JSON/CSV export.
 */
export function normalizeSuggestionIntegrityFinding(finding = {}) {
  const out = { ...finding };
  const quote = String(out.quote ?? "");
  const referenceQuote = String(out.referenceQuote || out.reference_quote || "");
  const suggestion = String(out.suggestion ?? "");
  const category = String(out.category ?? "");
  const issueScope = String(out.issueScope ?? out.issue_scope ?? "");
  const suggestionKind = String(out.suggestionKind ?? out.suggestion_kind ?? "");
  const original = String(out.suggestionOriginal ?? out.suggestion_original ?? "");
  const marker = String(out.suggestionIntegrity ?? out.suggestion_integrity ?? "");
  const markerSuppressed = marker === SUGGESTION_INTEGRITY_MARKER;
  const alreadySuppressed = markerSuppressed
    || (original && suggestion === SAFE_SUGGESTION_REGENERATION_TEXT);
  const hasQualityWarning = out.qualityWarning !== undefined || out.quality_warning !== undefined;
  const normalizedWarning = normalizeFindingQualityWarning(out.qualityWarning ?? out.quality_warning ?? "");
  if (hasQualityWarning) {
    out.qualityWarning = normalizedWarning;
    out.quality_warning = normalizedWarning;
  }
  if (alreadySuppressed) {
    // Older exported payloads may carry the marker while still retaining the
    // unsafe proposal.  Normalize those payloads too; otherwise opening a
    // JSON and exporting it again could resurrect `CX 30.00`.  A safe
    // regeneration instruction is stable, so repeated ZIP/JSON/CSV passes
    // remain idempotent.
    const preservedOriginal = original
      || (suggestion && suggestion !== SAFE_SUGGESTION_REGENERATION_TEXT ? suggestion : "");
    out.suggestion = SAFE_SUGGESTION_REGENERATION_TEXT;
    out.suggestionOriginal = preservedOriginal;
    out.suggestion_original = preservedOriginal;
    out.suggestionIntegrity = SUGGESTION_INTEGRITY_MARKER;
    out.suggestion_integrity = SUGGESTION_INTEGRITY_MARKER;
    out.suggestionKind = "action";
    out.suggestion_kind = "action";
    out.needsHumanReview = true;
    out.needs_human_review = true;
    const warning = normalizeFindingQualityWarning(out.qualityWarning ?? out.quality_warning ?? "");
    out.qualityWarning = warning.includes(SUGGESTION_INTEGRITY_WARNING)
      ? warning : `${warning ? `${warning} ` : ""}${SUGGESTION_INTEGRITY_WARNING}`;
    out.quality_warning = out.qualityWarning;
    return out;
  }
  const result = sanitizeSuggestionByNumericIntegrity({ quote, referenceQuote, suggestion, category, issueScope, issue_scope: issueScope, suggestionKind, suggestion_kind: suggestionKind });
  if (!result.needsRegeneration) return out;
  out.suggestion = result.suggestion;
  out.suggestionOriginal = result.original;
  out.suggestion_original = result.original;
  out.suggestionIntegrity = SUGGESTION_INTEGRITY_MARKER;
  out.suggestion_integrity = SUGGESTION_INTEGRITY_MARKER;
  out.suggestionKind = "action";
  out.suggestion_kind = "action";
  out.needsHumanReview = true;
  out.needs_human_review = true;
  const warning = normalizeFindingQualityWarning(out.qualityWarning ?? out.quality_warning ?? "");
  out.qualityWarning = warning.includes(SUGGESTION_INTEGRITY_WARNING)
    ? warning : `${warning ? `${warning} ` : ""}${SUGGESTION_INTEGRITY_WARNING}`;
  out.quality_warning = out.qualityWarning;
  return out;
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
    warning: missingEvidence ? INCOMPLETE_EVIDENCE_WARNING : "",
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

// 四半期表記の同値化。Q1 / 1Q / 第1四半期 は同じ四半期を指す表記差であり、
// 「四半期が一致していない」という主張の根拠にはならない。
export function normalizeQuarterNotation(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/第\s*([1-4])\s*四半期/gu, (_all, digit) => `q${digit}`)
    .replace(/(?<![a-z0-9])([1-4])\s*q(?![a-z0-9])/gu, (_all, digit) => `q${digit}`)
    .replace(/q\s*([1-4])(?![a-z0-9])/gu, (_all, digit) => `q${digit}`);
}

function noOpComparisonText(value, { foldQuarters = false } = {}) {
  const normalized = foldQuarters
    ? normalizeQuarterNotation(value)
    : String(value ?? "").normalize("NFKC").toLowerCase();
  return normalized.replace(/[\s 　]+/gu, "");
}

function instructionTargetTokens(value) {
  const text = String(value ?? "");
  const tokens = [];
  for (const pattern of [/「([^」\r\n]{1,80})」/g, /『([^』\r\n]{1,80})』/g]) {
    for (const match of text.matchAll(pattern)) {
      const token = noOpComparisonText(match[1], { foldQuarters: true });
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * 適用しても原文が変わらない指摘（no-op）を判定する。
 *
 * 1. 修正案が原文と同一。quote は検証段階で実文書の表記へ書き換わることがあるため、
 *    取り込み直後と引用検証後の両方で評価する必要がある。
 * 2. 「やること」形式の指示で、指示対象として括弧引用された語がすべて原文に既に
 *    存在する場合。四半期表記（Q1 / 1Q / 第1四半期）だけは同値として畳む。
 *
 * 空白だけの差は既存の ws-only-diff 経路が扱うため、ここでは畳まない。
 */
export function isNoOpSuggestionFinding(finding = {}) {
  const quote = String(finding?.quote ?? "");
  const suggestion = String(finding?.suggestion ?? "");
  if (!quote.trim() || !suggestion.trim()) return false;
  if (noOpComparisonText(quote) === noOpComparisonText(suggestion)) return true;
  const kind = String(finding?.suggestionKind ?? finding?.suggestion_kind ?? "").trim().toLowerCase();
  const isInstruction = kind === "action" || looksLikeActionSuggestion(suggestion);
  if (!isInstruction) return false;
  const targets = instructionTargetTokens(suggestion);
  if (!targets.length) return false;
  const comparableQuote = noOpComparisonText(quote, { foldQuarters: true });
  return targets.every(token => comparableQuote.includes(token));
}

const LOCAL_EDIT_CATEGORIES = new Set(["typo", "grammar"]);
// 語の異同を見るための素朴なトークン化。英字・数字・和文をまとめて拾い、
// 大文字小文字と単純な複数形（-s）だけを畳む。綴り修正（`Mexco`→`Mexico`）は
// 別語として数えられる必要があるため、これ以上の正規化はしない。
function localEditTokens(value) {
  const text = String(value ?? "").normalize("NFKC").toLowerCase();
  return (text.match(/[a-z0-9]+|[぀-ヿ㐀-䶿一-鿿]+/gu) || []);
}

function foldPluralToken(token) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function sentenceCount(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  return text.split(/[.!?。！？]+\s*/u).filter(part => part.trim()).length;
}

/**
 * typo / grammar は「原文の局所編集」（綴り、重複語、活用、句読点など）に
 * 限定する契約とする。引用に無い語を複数持ち込む、文を分割・再構成する、
 * 語数が大きく増えるといった提案は、明白な誤字修正ではなく英文リライトであり、
 * 自動採用候補にしてはいけない（人による確認へ落とす）。
 *
 * 実測 2026-08-24 (#106):
 *   - `BOJ normalization and and Funding by month` に対して
 *     `... fiscal easing under the Takaichi admin (Nov) have driven up ...`
 *     という引用に無い長文を生成した。
 *   - `We do not see a clear path to winning growth story for the future is needed.`
 *     を2文へ全面再構成した。
 * いずれも局所編集の範囲を超える。一方 `Cases ... is increasing` →
 * `are increasing`、`weighed`→`weighted`、`foreign foreign`→`foreign` の
 * ような1語だけの置換・削除は従来どおり通す。
 */
export function isOverreachingLocalEditSuggestion(finding = {}) {
  const category = String(finding?.category ?? "").trim().toLowerCase();
  if (!LOCAL_EDIT_CATEGORIES.has(category)) return false;
  const quote = String(finding?.quote ?? "");
  const suggestion = String(finding?.suggestion ?? "");
  if (!quote.trim() || !suggestion.trim()) return false;
  const kind = String(finding?.suggestionKind ?? finding?.suggestion_kind ?? "").trim().toLowerCase();
  // 指示文（action）は原文置換として適用されないため、この契約の対象外。
  if (kind === "action" || looksLikeActionSuggestion(suggestion)) return false;
  const quoteTokens = localEditTokens(quote);
  const suggestionTokens = localEditTokens(suggestion);
  if (!quoteTokens.length || !suggestionTokens.length) return false;
  if (sentenceCount(suggestion) > sentenceCount(quote)) return true;
  if (suggestionTokens.length - quoteTokens.length >= 3) return true;
  const known = new Set(quoteTokens.map(foldPluralToken));
  const introduced = new Set(suggestionTokens
    .map(foldPluralToken)
    .filter(token => !known.has(token)));
  return introduced.size >= 2;
}
