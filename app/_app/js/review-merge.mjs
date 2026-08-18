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
const SCALE_WORD_RE = /trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|oku|(?<![A-Za-z])k\b/gi;
const SCALE_EXPONENTS = new Map([
  ["trillion", 12], ["trillions", 12], ["兆", 12],
  ["billion", 9], ["billions", 9], ["十億", 9],
  ["million", 6], ["millions", 6], ["百万", 6],
  ["thousand", 3], ["thousands", 3], ["千", 3], ["万", 4], ["億", 8], ["oku", 8], ["k", 3],
]);

// Evidence used by the loose comparison must exclude rate markers and broad
// Japanese label characters (for example, `社` inside `会社`).  This is
// deliberately a quantity-unit vocabulary, not a measure-family classifier.
const NON_RATE_UNIT_RE = /(?:[$€£¥]|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|oku\b|(?<![A-Za-z])k\b|vehicles?\b|units?\b|shipments?\b|deliveries?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|台数|販売台数|生産台数|出荷台数|数量|株式数|株数|持株数|人員数|従業員数|件数)/i;

function hasNumericToken(value) {
  return new RegExp(NUMERIC_TOKEN_RE.source, "i").test(String(value || ""));
}

function currencyCodes(value) {
  const src = String(value || "");
  const codes = [];
  if (/(?:[$]|usd|dollars?\b)/i.test(src)) codes.push("usd");
  if (/(?:€|eur|euros?\b)/i.test(src)) codes.push("eur");
  if (/(?:£|gbp|pounds?\b)/i.test(src)) codes.push("gbp");
  if (/(?:¥|円|yen\b|jpy\b)/i.test(src)) codes.push("jpy");
  return [...new Set(codes)];
}

// Unit captions are frequently placed on the line immediately above a table
// row.  Carry only an unambiguous caption-like line into the row evidence;
// never borrow an arbitrary preceding data row.  The same-line caption is
// handled by familyEvidence itself and does not need this helper.
function precedingUnitCaption(src, lineStart) {
  const before = String(src || "").slice(0, lineStart);
  const lines = before.split(/\r?\n/);
  const captions = [];
  for (let i = lines.length - 1; i >= 0 && captions.length < 2; i--) {
    const candidate = lines[i].trim();
    if (!candidate) continue;
    const captionLike = /(?:\bunit(?:s)?\b|amounts?\s+in|\bin\s+(?:the\s+)?(?:millions?|billions?|thousands?)|単位|（?単位)/i.test(candidate);
    if ((!hasNumericToken(candidate) || captionLike) && NON_RATE_UNIT_RE.test(candidate)) {
      captions.unshift(candidate);
      continue;
    }
    break;
  }
  return captions.join(" ");
}

// A fiscal/quarter/date label is part of a value column's identity, not a
// value of its own. Extract the nearest label on the same row so a two-column
// row such as `FY2025 Net sales 60,132; FY2026 Net sales 1,266,466` cannot be
// compared positionally after the period labels are swapped.
function nearestPeriodKey(src, lineStart, tokenIndex) {
  const before = String(src || "").slice(Math.max(0, lineStart), Math.max(0, tokenIndex));
  const candidates = [];
  const add = (re, key) => {
    for (const match of before.matchAll(re)) candidates.push({ index: match.index || 0, key: key(match) });
  };
  add(/\bFY\s*(\d{2,4})\b/giu, match => `fy${match[1].length === 2 ? `20${match[1]}` : match[1]}`);
  add(/\b(\d{4})\s*年度/gu, match => `fy${match[1]}`);
  add(/\b(\d{4})\s*年\s*(\d{1,2})\s*月期/gu, match => `fy${match[1]}-${match[2]}`);
  add(/\b(first|second|third|fourth)\s+quarter\b/giu, match => {
    const quarter = { first: 1, second: 2, third: 3, fourth: 4 }[match[1].toLowerCase()];
    return `quarter${quarter}`;
  });
  add(/\bQ([1-4])\b/giu, match => `quarter${match[1]}`);
  add(/第\s*([1-4])\s*四半期/gu, match => `quarter${match[1]}`);
  add(/\byear\s+ended(?:\s+[A-Za-z]+\s+\d{1,2},?)?\s*(\d{4})\b/giu, match => `yearended${match[1]}`);
  add(/\b(three|six|nine|twelve)\s+months?\s+ended(?:\s+[A-Za-z]+\s+\d{1,2},?)?\s*(\d{4})\b/giu,
    match => `months${{ three: 3, six: 6, nine: 9, twelve: 12 }[match[1].toLowerCase()]}-${match[2]}`);
  add(/\bperiod\s+ended(?:\s+[A-Za-z]+\s+\d{1,2},?)?\s*(\d{4})\b/giu, match => `period${match[1]}`);
  candidates.sort((left, right) => left.index - right.index);
  return candidates.at(-1)?.key || "";
}

function normalizeIdentityLabel(value) {
  const normalized = String(value || "")
    .replace(NUMERIC_TOKEN_RE, " ")
    .replace(SCALE_WORD_RE, " ")
    .replace(/(?:¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|units?\b|vehicles?\b|shares?\b|employees?\b|persons?\b|台数|株式数|人員数|件数)/giu, " ")
    .replace(/\b(?:fy|year|ended|first|second|third|fourth|quarter|period|balance|at)\b/giu, " ")
    .replace(/\b(?:p|page|is|are|was|were|but|and|vs|versus|the|of|to|in|on|from|for|with|a|an)\b/giu, " ")
    .replace(/(?:^|\s)(?:と|の|が|は|を|に|で|へ|より|では|ですが|だが)(?=\s|$)/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
  if (/^(?:balance|april|march|january|february|may|june|july|august|september|october|november|december|other|stock|treasury|purchase(?:\s+of\s+treasury)?|当期首残高|期首残高|期末残高|自己株式(?:の取得)?|その他)$/iu.test(normalized)) return "";
  return normalized;
}

// These patterns intentionally prefer explicit measure words.  Generic words
// such as "total" or "result" are not unit evidence and are excluded.
const FAMILY_PATTERNS = [
  { family: "rate", re: /%|％|percent(?:age)?\b|per\s*cent\b|exchange\s*rate|currency\s*rate|為替(?:レート|率)?|増減率|利益率|rate\b|ratio\b|margin\b/i },
  { family: "shares", re: /shares?\b|share\s*count|stock\s*units?|株式数|株数|持株数|株/i },
  { family: "units", re: /vehicles?\b|vehicle\s*(?:sales|volume|count)|units?\b|shipments?\b|deliveries?\b|sales\s+volume|production\s+volume|台数|販売台数|生産台数|出荷台数|数量|台/i },
  { family: "count", re: /employees?\b|persons?\b|people\b|customers?\b|patents?\b|cases?\b|headcount\b|number\s+of\b|count\b|人数|人員数|従業員数|件数|人数|名|件|個|社/i },
  // Japanese financial labels are often the only unit/family evidence left
  // in a short finding quote.  Keep this deliberately limited to accounting
  // labels; generic words such as 「合計」/Total are not enough to identify a
  // measure family.
  { family: "money", re: /¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|金額|revenue\b|net\s+sales\b|sales\s+amount|operating\s+income|ordinary\s+income|profit\b|loss\b|assets?\b|liabilit(?:y|ies)\b|cash\s+flow|cost\b|price\b|amount\b|売上(?:高|収益)?|収益|営業利益|経常利益|利益|損失|損益|資産|負債|純利益|当期純利益|税金|費用/i },
];

// ``family`` is intentionally broad (all accounting amounts are ``money``),
// but a repeated amount is only self-consistent when it is the same measure.
// Keep this vocabulary small and alias-oriented: it is used only to veto a
// hard drop when two otherwise equal amounts clearly refer to different rows.
// Generic labels such as Total/Domestic/Result are not evidence of a measure.
const MEASURE_PATTERNS = [
  // Revenue is the common English alias used by the source tables for Net
  // sales.  Treat it as the same measure, but keep it explicit so
  // `Revenue` vs `Operating income` cannot be erased by equal digits.
  { key: "net_sales", re: /net\s+sales|sales\s+revenue|(?:^|\s)revenue\b|売上(?:高|収益)?/i },
  { key: "net_assets", re: /(?:total\s+)?net\s+assets\b|純資産(?:額)?/i },
  { key: "ebitda", re: /\bebitda\b|earnings\s+before\s+interest[\s,]+tax(?:es)?[\s,]+depreciation[\s,]+and\s+amortization/i },
  { key: "operating_cash_flow", re: /(?:operating|営業)\s+(?:cash\s+flow|activities)|営業活動(?:による)?(?:キャッシュ.?フロー)?/i },
  { key: "investing_cash_flow", re: /(?:investing|投資)\s+(?:cash\s+flow|activities)|投資活動(?:による)?(?:キャッシュ.?フロー)?/i },
  { key: "financing_cash_flow", re: /(?:financing|財務)\s+(?:cash\s+flow|activities)|財務活動(?:による)?(?:キャッシュ.?フロー)?/i },
  { key: "cash_balance", re: /cash\s+and\s+cash\s+equivalents?|ending\s+cash(?:\s+and\s+cash\s+equivalents?)?|現金及び現金同等物/i },
  { key: "gross_profit", re: /gross\s+profit|売上総利益/i },
  { key: "operating_profit", re: /operating\s+profit|営業利益/i },
  { key: "current_assets", re: /(?:^|[^A-Za-z0-9_-])current\s+assets?\b|流動資産/i },
  { key: "noncurrent_assets", re: /\bnon[\s-]*current\s+assets?\b|固定資産|非流動資産/i },
  { key: "retained_earnings", re: /retained\s+earnings|利益剰余金/i },
  { key: "shareholders_equity", re: /shareholders?'?\s+equity|stockholders?'?\s+equity|株主資本(?!等変動計算書)/i },
  { key: "cost_of_sales", re: /cost\s+of\s+sales|売上原価/i },
  { key: "sga_expenses", re: /\b(?:S\s*G|S\s*&\s*G)\s*&\s*A\b|selling[\s,]+general[\s,]+and[\s,]+administrative|販売費及び一般管理費/i },
  { key: "earnings_per_share", re: /earnings\s+per\s+share|\bEPS\b|1株当たり(?:利益|当期純利益)/i },
  { key: "dividend_per_share", re: /dividend\s+per\s+share|\bDPS\b|1株当たり配当/i },
  { key: "credit_asset_valuation_loss", re: /loss\s+on\s+valuation\s+of\s+credit\s+assets|クレジット資産評価損|信用資産評価損/i },
  { key: "operating_income", re: /operating\s+income|営業利益/i },
  { key: "ordinary_income", re: /ordinary\s+income|経常利益/i },
  { key: "net_income", re: /net\s+income|income\s+attributable|純利益|当期純利益|親会社株主.{0,20}(?:純利益|利益|帰属)/i },
  { key: "profit", re: /(?:^|\s)profit\b|利益(?!率)/i },
  { key: "loss", re: /(?:^|\s)loss\b|損失|損益(?!計算書)/i },
  { key: "assets", re: /assets?\b|資産/i },
  { key: "liabilities", re: /liabilit(?:y|ies)\b|負債/i },
  { key: "cash_flow", re: /cash\s+flow|キャッシュ.?フロー/i },
  { key: "equity", re: /(?:shareholders?|stockholders?)'?\s+equity|equity\b|株主資本(?!等変動計算書)|自己資本/i },
  { key: "cost", re: /(?:^|\s)cost\b|費用|原価/i },
];

// Scope is separate from the measure.  A value can be numerically identical
// while referring to consolidated vs standalone, actual vs forecast, or
// domestic vs overseas data; those pairs must remain review findings.
const SCOPE_PATTERNS = [
  { key: "consolidated", re: /consolidated|連結/i },
  { key: "standalone", re: /standalone|non[\s-]*consolidated|単体|個別/i },
  { key: "actual", re: /actual(?:\s+results?)?|実績/i },
  { key: "forecast", re: /forecast|estimated?|estimate|予想|計画|plan/i },
  // 「当期純利益」 is a measure label, not an independent current-period
  // scope.  Require the Japanese period word to stand apart from 純利益 so
  // the equivalent English/Japanese row remains droppable.
  { key: "current", re: /current\s+(?:period|year|fiscal)|当期(?!\s*の?\s*純利益)|今期(?!\s*の?\s*純利益)/i },
  { key: "prior", re: /prior\s+(?:period|year|fiscal)|previous\s+(?:period|year|fiscal)|前年|前期/i },
  { key: "domestic", re: /domestic|国内/i },
  { key: "overseas", re: /overseas|international|海外/i },
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

// Japanese financial labels often begin with a normalized full-width ordinal
// such as 「１株当たり」. That 1 is a denominator/descriptor, not one of
// the row's compared values. Treat the same structural form as a label on
// both the strict and loose extraction paths so a TARGET/REF pair keeps the
// same number of value columns. Keep this deliberately narrow: a standalone
// 1株 or 1人 can still be a real count.
function isStructuralPerUnitNumber(text, end) {
  return /^\s*(?:株|人|件|口|枚|個|台|ページ|頁)\s*(?:当たり|あたり|につき|ごと)/u
    .test(String(text || "").slice(Number(end) || 0));
}

function isStructuralDateNumber(text, start, end, bare) {
  const src = String(text || "");
  const before = src.slice(0, Number(start) || 0);
  const after = src.slice(Number(end) || 0);
  // English dates are commonly extracted as three independent numeric
  // tokens (for example `April 1, 2024`).  Treat both the day and year as
  // date structure; otherwise an English TARGET row gains two columns that
  // are absent from the corresponding Japanese REF row.
  const englishMonth = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
  if (new RegExp(`${englishMonth}\\s*$`, "i").test(before)
      && (/^\s*,?\s*\d{4}(?=\D|$)/.test(after)
        || /,\s*$/.test(src.slice(Number(start) || 0, Number(end) || 0)))) return true;
  if (new RegExp(`${englishMonth}\\s+\\d{1,2}\\s*,\\s*$`, "i").test(before)
      && String(bare || "").length === 4) return true;
  // A text-layer row can carry the column year after the value list, e.g.
  // `Balance at March 31, 143,459 ... 1,810,029 2025`.  Once the row already
  // has its month/day heading, a trailing four-digit year is structural too.
  if (String(bare || "").length === 4 && /^\s*$/.test(after)
      && /\bBalance\s+at\s+(?:March|April)\s+\d{1,2},/i.test(before)) return true;
  // 「期末の…」 is a row label after the final value, not a period suffix.
  if (/^\s*期末/u.test(after)) return false;
  if (/^\s*期/u.test(after)) {
    return String(bare || "").length <= 2 || /(?:第|FY)\s*$/iu.test(before);
  }
  return /^\s*(?:年|年度|月|日)/u.test(after)
    || (String(bare || "").length === 4 && /年|年度/u.test(after));
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
  const periodKey = nearestPeriodKey(src, lineStart, token.index);
  const line = src.slice(lineStart, lineEnd);
  const caption = precedingUnitCaption(src, lineStart);
  const unitContext = `${line} ${caption}`;
  const lineTokens = (tokens.length === 1 ? [token] : tokens)
    .filter(item => item.index >= lineStart && item.end <= lineEnd);
  const tokenPosition = lineTokens.indexOf(token);
  const segmentStart = tokenPosition > 0 ? lineTokens[tokenPosition - 1].end : lineStart;
  const segmentEnd = token.end;
  // Measure/scope labels belong to the value segment immediately following
  // the previous numeric token.  A whole-line nearest-token search assigns
  // both labels in `Net sales 1; Operating income 2` to the first value
  // because the second label starts before the second value.  Segmenting at
  // numeric boundaries keeps column swaps visible and fails closed when a
  // segment contains multiple labels.
  const tokenSegment = src.slice(Math.max(lineStart, segmentStart), Math.min(lineEnd, segmentEnd));
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
  const measureHits = [];
  for (const rule of MEASURE_PATTERNS) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    for (const _match of tokenSegment.matchAll(new RegExp(rule.re.source, flags))) measureHits.push(rule.key);
  }
  const scopeHits = [];
  const scopeSegment = tokenPosition >= 0 && tokenPosition + 1 === lineTokens.length
    ? src.slice(Math.max(lineStart, segmentStart), lineEnd)
    : tokenSegment;
  for (const rule of SCOPE_PATTERNS) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    for (const _match of scopeSegment.matchAll(new RegExp(rule.re.source, flags))) scopeHits.push(rule.key);
  }
  // A row label applies to adjacent value columns when the intervening text
  // has no competing metric/scope label.  This preserves the legitimate
  // `Net income 60,132 60,132` duplicate while still treating an explicit
  // `; Operating income`/`Forecast` segment as a new identity.
  const previousToken = tokenPosition > 0 ? lineTokens[tokenPosition - 1] : null;
  const betweenPreviousAndCurrent = previousToken
    ? src.slice(previousToken.end, token.index)
    : "";
  const hasExplicitColumnSeparator = /[;；|｜]/.test(betweenPreviousAndCurrent);
  if (tokenPosition > 0 && !measureHits.length && !hasExplicitColumnSeparator) {
    const previous = lineTokens[tokenPosition - 1];
    const previousSegmentStart = tokenPosition > 1 ? lineTokens[tokenPosition - 2].end : lineStart;
    const previousSegment = src.slice(Math.max(lineStart, previousSegmentStart), previous.end);
    for (const rule of MEASURE_PATTERNS) {
      const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
      for (const _match of previousSegment.matchAll(new RegExp(rule.re.source, flags))) measureHits.push(rule.key);
    }
  }
  if (tokenPosition > 0 && !scopeHits.length && !hasExplicitColumnSeparator) {
    const previous = lineTokens[tokenPosition - 1];
    const previousSegmentStart = tokenPosition > 1 ? lineTokens[tokenPosition - 2].end : lineStart;
    const previousSegment = src.slice(Math.max(lineStart, previousSegmentStart), previous.end);
    for (const rule of SCOPE_PATTERNS) {
      const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
      for (const _match of previousSegment.matchAll(new RegExp(rule.re.source, flags))) scopeHits.push(rule.key);
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
  // A preceding caption applies to the row below it.  It is intentionally
  // not distance-limited: the caption can be a long table title or sit on a
  // separate line, while precedingUnitCaption has already excluded data rows.
  for (const match of caption.matchAll(SCALE_WORD_RE)) {
    const exponent = scaleExponent(match[0]);
    if (Number.isInteger(exponent)) exponents.push(exponent);
  }
  const directText = tokens.length === 1
    ? src
    : src.slice(Math.max(lineStart, token.index - 48), Math.min(lineEnd, token.end + 48));
  const families = [...new Set(familyHits)];
  const measures = [...new Set(measureHits)];
  // Specific accounting metrics also match the generic Japanese/English
  // `profit`/`loss` rule.  Keep the specific key as the identity; otherwise
  // `営業利益` and `当期純利益` both become ambiguous and can be dropped as
  // equal money values.
  const specificMeasures = measures.filter(key => !["profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity"].includes(key));
  const effectiveMeasures = specificMeasures.length ? specificMeasures : measures;
  const scopes = [...new Set(scopeHits)];
  // For permutation detection, prefer the label segment after the nearest
  // explicit column separator.  Whole-line nearest-token assignment can make
  // `vehicles 60; Revenue 1` look ambiguous because both words are close to
  // the first number; the segment itself unambiguously belongs to the current
  // column.
  const identitySegment = tokenSegment.split(/[;；|｜]/).pop();
  const identityLabelKey = normalizeIdentityLabel(identitySegment);
  const identityFamilies = [];
  for (const rule of FAMILY_PATTERNS) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    if (new RegExp(rule.re.source, flags).test(identitySegment)) identityFamilies.push(rule.family);
  }
  const identitySpecificMeasures = measures.filter(key => !["profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity"].includes(key));
  const identityKey = identitySpecificMeasures.length === 1
    ? `measure:${identitySpecificMeasures[0]}`
    : [...new Set(identityFamilies)].length === 1 ? `family:${identityFamilies[0]}` : "";
  const uniqueExponents = [...new Set(exponents)];
  const rowExponents = [
    ...line.matchAll(SCALE_WORD_RE),
    ...caption.matchAll(SCALE_WORD_RE),
  ].map(match => scaleExponent(match[0])).filter(Number.isInteger);
  const uniqueRowExponents = [...new Set(rowExponents)];
  const rowCurrencies = currencyCodes(unitContext);
  const directCurrencies = currencyCodes(directText);
  const hasDirectUnit = /¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|vehicles?\b|units?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|%|％|兆|億|百万|千|台|人|名|件|個|社/i.test(directText);
  const nonRateUnitEvidence = uniqueExponents.length > 0 || NON_RATE_UNIT_RE.test(unitContext) || NON_RATE_UNIT_RE.test(directText);
  const familyStatus = families.length === 1 ? "known" : families.length > 1 ? "ambiguous" : "unknown";
  return {
    status: familyStatus,
    family: families.length === 1 ? families[0] : "",
    families,
    measureKey: effectiveMeasures.length === 1 ? effectiveMeasures[0] : "",
    measureKeys: effectiveMeasures,
    measureExplicit: effectiveMeasures.length > 0,
    identityKey,
    identityLabelKey,
    periodKey,
    scopeKeys: scopes,
    scopeExplicit: scopes.length > 0,
    scaleExp: uniqueExponents.length === 1 ? uniqueExponents[0] : 0,
    scaleCaption: uniqueExponents.length > 0,
    // A single row/table caption applies to every amount column in the row,
    // even though the nearest-token check above assigns the caption to only
    // one token.  Rates deliberately ignore this value in canDropNumericPair.
    rowScaleExp: uniqueRowExponents.length === 1 ? uniqueRowExponents[0] : 0,
    rowCurrency: rowCurrencies.length === 1 ? rowCurrencies[0] : "",
    currencyEvidence: directCurrencies.length === 1 ? directCurrencies[0] : "",
    rateEvidence: families.includes("rate"),
    nonRateUnitEvidence,
    scaleKnown: uniqueExponents.length === 1 || uniqueRowExponents.length === 1
      || (uniqueExponents.length === 0 && (hasDirectUnit || nonRateUnitEvidence)),
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
  // Convert full-width digits without NFKC-normalizing punctuation. In
  // particular, Japanese table dash 「－」 must remain a missing-value marker,
  // not become an ASCII minus sign and attach to the next column's number.
  const text = String(value || "").replace(/[０-９]/g, char =>
    String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const allTokens = [...text.matchAll(NUMERIC_TOKEN_RE)].map(match => ({
    raw: match[0], index: match.index, end: match.index + match[0].length,
    symbol: /^⟦#/.test(match[0]) ? match[0] : "",
  }));
  const tokens = allTokens.filter(token => {
    if (token.symbol) return true;
    const before = text.slice(0, token.index);
    const after = text.slice(token.end);
    const bare = token.raw.replace(/^[△▲+−-]/, "").replace(/[(),]/g, "");
    return !isStructuralPerUnitNumber(text, token.end)
      && !/(?:\b(?:p|page)\s*[.．]?\s*|\bfy\s*)$/i.test(before)
      && !isStructuralDateNumber(text, token.index, token.end, bare);
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
  const leftScaleExp = a.scaleExp || a.rowScaleExp || 0;
  const rightScaleExp = b.scaleExp || b.rowScaleExp || 0;
  // Put both amounts on an integer grid in base units.  The denominator is
  // needed only when a displayed decimal has more places than its scale.
  const commonDenominatorExp = Math.max(0, a.decimals - leftScaleExp, b.decimals - rightScaleExp);
  const scaled = q => {
    const scaleExp = q.scaleExp || q.rowScaleExp || 0;
    const shift = scaleExp - q.decimals + commonDenominatorExp;
    if (shift < 0) return null;
    const amount = BigInt(q.digits) * (10n ** BigInt(shift));
    const quantum = 10n ** BigInt(shift);
    const half = quantum / 2n;
    return { low: amount - half, high: amount + (quantum - half) };
  };
  const left = scaled(a), right = scaled(b);
  return Boolean(left && right && left.low < right.high && right.low < left.high);
}

function explicitMeasureMismatch(a, b) {
  // Only compare a measure when both sides state one.  A short table cell may
  // legitimately omit the row label, so one-sided absence is not enough to
  // reject the otherwise conservative equality proof.
  return Boolean(a?.measureExplicit && b?.measureExplicit
    && a.measureKey && b.measureKey && a.measureKey !== b.measureKey);
}

function explicitScopeMismatch(a, b) {
  const left = new Set(a?.scopeKeys || []);
  const right = new Set(b?.scopeKeys || []);
  if (!left.size && !right.size) return false;
  // A bilingual row commonly names the period/scope on only one side
  // (`当期首残高` vs `Balance at April 1`).  Absence on one side is not proof
  // of a different scope; only two explicit, conflicting declarations veto
  // an equality drop.
  if (!left.size || !right.size) return false;
  if (left.size !== right.size) return true;
  for (const value of left) if (!right.has(value)) return true;
  return false;
}

function explicitPeriodMismatch(a, b) {
  return Boolean(a?.periodKey && b?.periodKey && a.periodKey !== b.periodKey);
}

function specificMeasureAliasKeys(token) {
  const keys = new Set(Array.isArray(token?.measureKeys) ? token.measureKeys : []);
  if (token?.measureKey) keys.add(token.measureKey);
  return [...keys].filter(key => !GENERIC_MEASURE_KEYS.has(key));
}

function specificMeasureAliasCompatible(a, b) {
  const left = specificMeasureAliasKeys(a);
  const right = new Set(specificMeasureAliasKeys(b));
  return left.length > 0 && right.size > 0 && left.some(key => right.has(key));
}

function unknownIdentityLabelMismatch(a, b) {
  const left = String(a?.identityLabelKey || "");
  const right = String(b?.identityLabelKey || "");
  if (!left || !right || left === right) return false;
  // Known measure aliases (for example Revenue/Net sales) are already
  // normalized through measureKey.  Raw labels may differ only when both
  // sides provide a specific recognized measure and those measures are the
  // same alias family.  A specific↔unknown pair is not proven equivalent.
  if (specificMeasureAliasCompatible(a, b)) return false;
  return true;
}

function tokenIdentityKey(token) {
  if (!token) return "";
  if (token.identityKey?.startsWith("measure:")) return token.identityKey;
  if (token.identityLabelKey) return `label:${token.identityLabelKey}`;
  if (token.identityKey) return token.identityKey;
  if (token.measureExplicit && token.measureKey) return `measure:${token.measureKey}`;
  if (token.status === "known" && token.family) return `family:${token.family}`;
  return "";
}

function sameIdentityMultiset(left, right) {
  if (left.length !== right.length || !left.length || left.some(key => !key) || right.some(key => !key)) return false;
  const counts = values => values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
  const leftCounts = counts(left);
  const rightCounts = counts(right);
  if (leftCounts.size !== rightCounts.size) return false;
  for (const [key, count] of leftCounts) if (rightCounts.get(key) !== count) return false;
  return true;
}

// When a multi-column excerpt contains explicit identities on every value,
// the same identities appearing in a different order are a column swap, not
// a harmless duplicate.  This catches both measure swaps and cross-family
// swaps (for example Revenue/vehicles) without changing the legacy one-cell
// rule that intentionally treats a single cross-family comparison as a
// safely distinguishable false positive.
function hasColumnIdentityPermutation(left, right) {
  if (left.length < 2 || left.length !== right.length) return false;
  const leftKeys = left.map(tokenIdentityKey);
  const rightKeys = right.map(tokenIdentityKey);
  if (!sameIdentityMultiset(leftKeys, rightKeys)) return false;
  return leftKeys.some((key, index) => key !== rightKeys[index]);
}

function canDropNumericPair(a, b, masker) {
  if (!a || !b || a.negative !== b.negative) return false;
  // The amount may be exactly equal while the claim compares two different
  // accounting rows or scopes.  Preserve those as real mismatches; a broad
  // family such as `money` is not a substitute for measure/scope identity.
  if (explicitMeasureMismatch(a, b)
      || explicitScopeMismatch(a, b)
      || explicitPeriodMismatch(a, b)) return false;
  // A repeated masked symbol is a deterministic self-contradiction even when
  // its unit family is unavailable.  The symbol itself identifies the same
  // protected numeric value; keep the sign check above so a sign mismatch is
  // never suppressed.
  if (a.symbol && b.symbol && a.symbol === b.symbol) return true;
  if (unknownIdentityLabelMismatch(a, b)) return false;
  const leftCurrency = a.currencyEvidence || a.rowCurrency || "";
  const rightCurrency = b.currencyEvidence || b.rowCurrency || "";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
  // A shared row/table scale must not be applied to percentage columns.  The
  // rates are equivalent only when their displayed numeric value and sign
  // match exactly (the caption is an amount-column rule, not a rate rule).
  if (a.rateEvidence && b.rateEvidence) {
    return a.digits === b.digits && a.decimals === b.decimals;
  }
  // Compact multi-column excerpts may omit the row label beside later amount
  // values, leaving their family status unknown.  A single shared scale
  // caption on each side plus overlapping base-unit intervals is still a
  // positive, pair-specific proof for those amount columns.  Do not use it
  // for rates (handled above), and do not infer a value when the intervals do
  // not overlap.
  if (!a.rateEvidence && !b.rateEvidence
    && a.rowScaleExp && b.rowScaleExp
    && a.nonRateUnitEvidence && b.nonRateUnitEvidence
    && quantityIntervalsOverlap(a, b)) return true;
  if (a.status !== "known" || b.status !== "known") return false;
  // If the same named measure is explicitly attached to both tokens but their
  // unit families differ (for example, yen vs vehicle count), it is not a
  // self-contradiction.  Keep it for human review.  Preserve the historical
  // conservative behaviour for unrelated/untagged families below.
  if (a.measureExplicit && b.measureExplicit && a.measureKey === b.measureKey
      && a.family !== b.family) return false;
  if (a.family !== b.family) return true;
  if (a.symbol && b.symbol && masker && typeof masker.areSymbolsCompatible === "function") {
    return masker.areSymbolsCompatible(a.symbol, b.symbol);
  }
  return quantityIntervalsOverlap(a, b);
}

const GENERIC_MEASURE_KEYS = new Set([
  "profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity",
]);

function canDropSinglePrimaryPair(a, b, masker) {
  // A single bare amount is not enough evidence: generic family/unit matches
  // can describe different rows.  Require a specific, same measure (or the
  // deterministic same protected symbol) before applying quantity proof.
  if (!a || !b) return false;
  if (a.symbol && b.symbol && a.symbol === b.symbol && a.negative === b.negative) return true;
  if (!a.measureExplicit || !b.measureExplicit
      || !a.measureKey || a.measureKey !== b.measureKey
      || GENERIC_MEASURE_KEYS.has(a.measureKey)) return false;
  const numericKey = canonicalNumericKey(a);
  if (numericKey && numericKey === canonicalNumericKey(b)) {
    const leftCurrency = a.currencyEvidence || a.rowCurrency || "";
    const rightCurrency = b.currencyEvidence || b.rowCurrency || "";
    const leftScale = a.scaleExp || a.rowScaleExp || 0;
    const rightScale = b.scaleExp || b.rowScaleExp || 0;
    const scalesAgree = !(a.scaleKnown && b.scaleKnown && leftScale !== rightScale);
    if ((!leftCurrency || !rightCurrency || leftCurrency === rightCurrency) && scalesAgree) return true;
  }
  return canDropNumericPair(a, b, masker);
}

function allPairsProveFalsePositive(left, right, masker) {
  if (!left.length || left.length !== right.length) return false;
  if (left.length === 1) return canDropSinglePrimaryPair(left[0], right[0], masker);
  return left.every((item, index) => canDropNumericPair(item, right[index], masker));
}

function hasExplicitIdentityMismatch(left, right) {
  if (!left.length || left.length !== right.length) return false;
  if (hasColumnIdentityPermutation(left, right)) return true;
  return left.some((item, index) => {
    const other = right[index];
    if (explicitMeasureMismatch(item, other)
        || explicitScopeMismatch(item, other)
        || explicitPeriodMismatch(item, other)) return true;
    const sameProtectedSymbol = Boolean(item?.symbol && other?.symbol
      && item.symbol === other.symbol && item.negative === other.negative);
    if (!sameProtectedSymbol && unknownIdentityLabelMismatch(item, other)) return true;
    // A single measure label can still be attached to different families in
    // a short excerpt (for example, an amount versus a count).  Keep that
    // finding even if the loose fallback sees identical display digits.
    return Boolean(item?.measureExplicit && other?.measureExplicit
      && item.measureKey && item.measureKey === other.measureKey
      && item.status === "known" && other.status === "known"
      && item.family !== other.family);
  });
}

function fieldPairsProveFalsePositive(values, masker) {
  if (values.length < 2) return false;
  return values.slice(1).every(item => canDropNumericPair(values[0], item, masker));
}

function canonicalNumericKey(token) {
  if (!token || token.symbol) return "";
  let digits = String(token.digits || "0").replace(/^0+(?=\d)/, "") || "0";
  let decimals = Number(token.decimals) || 0;
  // `2.0` and `2` are the same displayed value for the purpose of detecting
  // a model that calls two identical values inconsistent.
  while (decimals > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1) || "0";
    decimals--;
  }
  return `${token.negative ? "-" : "+"}${digits}:${decimals}`;
}

function repeatedNumericPairs(value, masker = null) {
  const tokens = extractNumericEvidence(value, masker);
  const groups = new Map();
  for (const token of tokens) {
    const key = canonicalNumericKey(token);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(token);
  }
  return [...groups.values()].filter(items => items.length >= 2);
}

function sameAuxiliaryNumericClass(a, b, options = {}) {
  if (!a || !b || canonicalNumericKey(a) !== canonicalNumericKey(b)) return false;
  if (a.negative !== b.negative || explicitPeriodMismatch(a, b)) return false;
  if (explicitMeasureMismatch(a, b)) return false;
  if (explicitScopeMismatch(a, b)) return false;
  const sameProtectedSymbol = Boolean(a.symbol && b.symbol
    && a.symbol === b.symbol && a.negative === b.negative);
  if (!sameProtectedSymbol && unknownIdentityLabelMismatch(a, b)) return false;
  // When matching a primary quote, an unlabeled primary table value may be
  // explained by a specifically labeled auxiliary row.  The reverse is not
  // safe: a specific primary metric must not be paired with an unknown
  // auxiliary metric.
  if (a.measureExplicit !== b.measureExplicit
      && !(options.allowUnknownLeft
        && !a.measureExplicit
        && !a.identityLabelKey
        && b.measureExplicit)) return false;
  const leftCurrency = a.currencyEvidence || a.rowCurrency || "";
  const rightCurrency = b.currencyEvidence || b.rowCurrency || "";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
  const leftScale = a.scaleExp || a.rowScaleExp || 0;
  const rightScale = b.scaleExp || b.rowScaleExp || 0;
  return !(leftScale && rightScale && leftScale !== rightScale);
}

function repeatedPairIdentityCompatible(a, b) {
  if (!a || !b || a.negative !== b.negative) return false;
  if (explicitMeasureMismatch(a, b) || explicitScopeMismatch(a, b) || explicitPeriodMismatch(a, b)) return false;
  const leftCurrency = a.currencyEvidence || a.rowCurrency || "";
  const rightCurrency = b.currencyEvidence || b.rowCurrency || "";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
  const leftScale = a.scaleExp || 0;
  const rightScale = b.scaleExp || 0;
  if (leftScale && rightScale && leftScale !== rightScale) return false;
  // `equity` often comes from the surrounding Japanese table title
  // 「株主資本等変動計算書」, not from the value's row label.  Do not let
  // that structural hit veto a specific repeated metric; real metric swaps
  // (net sales vs operating income, etc.) remain vetoed above.
  if (a.measureExplicit && b.measureExplicit
      && a.measureKey !== b.measureKey
      && a.measureKey !== "equity" && b.measureKey !== "equity") return false;
  if (a.status === "known" && b.status === "known" && a.family !== b.family) return false;
  return true;
}

function repeatedNumericClaim(value, masker = null) {
  const tokens = extractNumericEvidence(value, masker);
  // A repeated pair is conclusive only when no other numeric candidate in
  // the same field contradicts it.  This prevents `50,000 vs 50,000; ...
  // 60,132 vs 70,000` from being dropped because the first group happened to
  // repeat.
  if (tokens.length < 2) return false;
  if (!tokens.some(token => String(token.digits || "").length >= 4
      || /,/.test(String(token.raw || "")))) return false;
  const first = tokens[0];
  const firstKey = canonicalNumericKey(first);
  return Boolean(firstKey) && tokens.every(token =>
    canonicalNumericKey(token) === firstKey && sameAuxiliaryNumericClass(first, token));
}

function allNumericCandidatesSameIdentity(value, masker = null) {
  const tokens = extractNumericEvidence(value, masker);
  if (!tokens.length) return false;
  const first = tokens[0];
  const firstKey = canonicalNumericKey(first);
  return Boolean(firstKey) && tokens.every(token =>
    canonicalNumericKey(token) === firstKey && sameAuxiliaryNumericClass(first, token));
}

function repeatedClaimMatchesPrimary(primary, value, masker = null) {
  if (!primary?.length) return false;
  const tokens = extractNumericEvidence(value, masker);
  if (tokens.length < 2) return false;
  // A repeated matching pair is evidence only when every numeric candidate in
  // the auxiliary field belongs to the same primary comparison.  The prior
  // `some(group)` proof could drop `50,000 vs 50,000; 60,132 vs 70,000` after
  // noticing only the first pair.
  const matching = tokens.filter(candidate => primary.some(item =>
    canonicalNumericKey(item) === canonicalNumericKey(candidate)
      && sameAuxiliaryNumericClass(item, candidate, { allowUnknownLeft: !item.measureExplicit })));
  if (matching.length !== tokens.length) return false;
  return matching.some((candidate, index) => matching.slice(index + 1).some(other =>
    canonicalNumericKey(candidate) === canonicalNumericKey(other)
      && sameAuxiliaryNumericClass(candidate, other, { allowUnknownLeft: !candidate.measureExplicit })));
}

function cashFlowKind(value) {
  const text = String(value || "");
  if (/(?:investing\s+activities|投資活動)/i.test(text)) return "investing";
  if (/(?:financing\s+activities|財務活動)/i.test(text)) return "financing";
  if (/(?:operating\s+activities|営業活動)/i.test(text)) return "operating";
  return "";
}

function semanticNegativeCashFlow(text, token) {
  if (!token) return false;
  const src = String(text || "");
  const before = src.slice(Math.max(0, Number(token.index) - 96), Number(token.index));
  const after = src.slice(Number(token.end), Number(token.end) + 48);
  return /\b(?:used|outflow|decrease|decreased|negative|loss)\b|使用額|支出|減少|マイナス|△|▲/i.test(`${before} ${after}`);
}

function tokenEvidenceFingerprint(token) {
  if (!token || token.symbol) return "";
  const scale = token.scaleExp || token.rowScaleExp || 0;
  const currency = token.currencyEvidence || token.rowCurrency || "";
  return `${canonicalNumericKey(token)}|${scale}|${currency}`;
}

function staleQuoteVariantFingerprints(finding, primaryText, primary, masker) {
  const variants = Array.isArray(finding?.quote_variants)
    ? finding.quote_variants
    : Array.isArray(finding?.quoteVariants) ? finding.quoteVariants : [];
  if (!variants.length) return new Set();
  const current = normalizeQuote(primaryText);
  if (!variants.some(value => normalizeQuote(value) === current)) return new Set();
  const kind = cashFlowKind(primaryText);
  if (!kind) return new Set();
  const primaryFingerprints = new Set(primary.map(tokenEvidenceFingerprint).filter(Boolean));
  const stale = new Set();
  for (const variant of variants) {
    if (normalizeQuote(variant) === current || cashFlowKind(variant) !== kind) continue;
    for (const token of extractNumericEvidence(variant, masker)) {
      const fingerprint = tokenEvidenceFingerprint(token);
      if (fingerprint && !primaryFingerprints.has(fingerprint)) stale.add(fingerprint);
    }
  }
  return stale;
}

function pageLabelBeforeToken(text, token) {
  const before = String(text || "").slice(0, Number(token?.index) || 0);
  const matches = [...before.matchAll(/\bP\s*[.．]?\s*(\d{1,4})\b/gi)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

function cashFlowRoundingPairEquivalent(primaryText, left, auxiliaryText, right) {
  if (!left || !right) return false;
  const leftScale = left.scaleExp || 0;
  const rightScale = right.scaleExp || 0;
  const leftNegative = left.negative || semanticNegativeCashFlow(primaryText, left);
  const rightNegative = right.negative || semanticNegativeCashFlow(auxiliaryText, right);
  if (leftNegative !== rightNegative) return false;
  const leftCurrency = left.currencyEvidence || left.rowCurrency || "";
  const rightCurrency = right.currencyEvidence || right.rowCurrency || "";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
  if (canonicalNumericKey(left) === canonicalNumericKey(right)
      && (!leftScale || !rightScale || leftScale === rightScale)) return true;
  // A bare three-digit cash-flow table amount is conventionally in millions
  // when the narrative restates it in billions.  Restrict this exception to
  // one-decimal billion display rounding; it is not a general untyped number
  // comparison.
  if (rightScale || leftScale !== 9 || left.decimals !== 1 || String(right.digits).length < 3) return false;
  const displayed = Number(left.digits) * 10 ** (leftScale - left.decimals);
  const candidate = Number(right.digits) * 10 ** 6;
  const quantum = 10 ** (leftScale - left.decimals);
  return Number.isFinite(displayed) && Number.isFinite(candidate)
    && Math.abs(displayed - candidate) <= quantum / 2;
}

function cashFlowRoundingEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, masker) {
  if (!primary?.length || !auxiliary?.length) return false;
  const primaryKind = cashFlowKind(primaryText);
  if (!primaryKind || primaryKind !== cashFlowKind(auxiliaryText)) return false;
  const stale = staleQuoteVariantFingerprints(finding, primaryText, primary, masker);
  const primaryPage = Number(finding?.page);
  const usable = auxiliary.filter(token => {
    if (!stale.has(tokenEvidenceFingerprint(token))) return true;
    // A stale variant is admissible only when the auxiliary text explicitly
    // places that stale amount on the finding's primary page.  A same-valued
    // amount on another page is independent evidence and must keep the
    // finding alive.
    return !Number.isInteger(primaryPage) || pageLabelBeforeToken(auxiliaryText, token) !== primaryPage;
  });
  if (!usable.length) return false;
  // Every remaining auxiliary candidate must agree with a primary value, and
  // every primary value must be represented.  This prevents an early matching
  // candidate from hiding a second, contradictory amount.
  if (!usable.every(right => primary.some(left =>
    cashFlowRoundingPairEquivalent(primaryText, left, auxiliaryText, right)))) return false;
  return primary.every(left => usable.some(right =>
    cashFlowRoundingPairEquivalent(primaryText, left, auxiliaryText, right)));
}

// A compact finding often contains only the row label and its values.  In
// that form the unit caption ("In billions of yen" / "単位：億円") is not part
// of either quote, so the strict unit-family proof above cannot help.  These
// helpers provide the small, deterministic normalization that is safe for a
// self-contradictory finding:
//   * comma/decimal formatting is ignored;
//   * (), △ and ▲ are the same negative sign;
//   * identical numeric values are equal even when the unit caption is absent;
//   * a common decimal-place shift (5,018.9 ⇔ 50,189) is accepted only for a
//     clearly financial row, and only when the shift is consistent for every
//     non-rate value in the pair.
//
// The last rule is intentionally narrower than a general "numbers look
// similar" heuristic.  It catches the billion/億 (or million/百万円) layout
// that Copilot frequently reports as a mismatch while leaving untyped values
// such as `Total 48` vs `Total 49` untouched.
const FINANCIAL_LABEL_RE = /(?:net\s+sales|sales\s+amount|revenue|operating\s+income|ordinary\s+income|net\s+income|income\s+attributable|profit|loss|assets?|liabilit(?:y|ies)|cash\s+flow|cost|amount|売上(?:高|収益)?|収益|営業利益|経常利益|親会社株主|当期純利益|純利益|損失|損益|資産|負債|金額|費用)/i;

function looseNumericTokens(value) {
  // NFKC is useful for fullwidth digits/commas, but it turns the Japanese
  // table placeholder `－` into ASCII `-`.  Preserve that glyph so a blank
  // dash followed by the next column's value is not misread as a negative
  // number (the exact false positive this fallback is meant to remove).
  const text = String(value || "").replace(/－/g, "\uE000").normalize("NFKC").replace(/\uE000/g, "－");
  const re = /[△▲+−-]?\s*\(?\s*\d[\d,]*(?:\.\d+)?\s*\)?/g;
  const matches = [...text.matchAll(re)];
  // Percent is a display marker for the rate column, not quantity evidence
  // for every amount in the same excerpt.  Keep it in `percent` below but do
  // not let it suppress the unit-free amount fallback.
  const directUnitRe = /(?:¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|oku\b|(?<![A-Za-z])k\b|vehicles?\b|units?\b|shipments?\b|deliveries?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|台数|販売台数|生産台数|出荷台数|数量|株式数|株数|持株数|人員数|従業員数|件数)/i;
  const out = [];
  for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
    const match = matches[matchIndex];
    const raw = match[0].trim();
    const index = match.index || 0;
    const before = text.slice(0, index);
    const after = text.slice(index + raw.length);
    const unsignedForContext = raw.replace(/^[△▲−+\-]\s*/, "").replace(/[(),]/g, "");
    // Page/fiscal-year/date labels are structure, not compared measure
    // values.  Mirror extractNumericEvidence so a different page label does
    // not prevent an otherwise identical target/reference pair from being
    // recognized as self-consistent.
    if (/(?:\b(?:p|page)\s*[.．]?\s*|\bfy\s*)$/i.test(before)
      || isStructuralPerUnitNumber(text, index + raw.length)
      || isStructuralDateNumber(text, index, index + raw.length, unsignedForContext)) continue;
    const negative = tokenNegative(raw);
    const unsigned = raw
      .replace(/^[△▲−+\-]\s*/, "")
      .replace(/^\(\s*/, "")
      .replace(/\s*\)$/, "")
      .replace(/[\s,]/g, "");
    const [integer = "0", fraction = ""] = unsigned.split(".");
    const digits = `${integer || "0"}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
    const percent = /^\s*[%％]/.test(after) || /[%％]\s*$/.test(before.slice(-2));
    // Only treat a unit as evidence for this particular value when it is
    // adjacent to that value, before the next numeric token or after the
    // previous one.  A rate column elsewhere in the same excerpt must not
    // disable the unit-free decimal-shift normalization for the amount
    // columns (for example, `5,018.9 ... (2.0)%`).
    const previousEnd = matchIndex > 0
      ? (matches[matchIndex - 1].index || 0) + matches[matchIndex - 1][0].length
      : 0;
    const nextStart = matchIndex + 1 < matches.length
      ? (matches[matchIndex + 1].index || text.length)
      : text.length;
    const localBefore = text.slice(Math.max(previousEnd, index - 24), index);
    const localAfter = text.slice(index + raw.length, Math.min(nextStart, index + raw.length + 24));
    const unitText = `${localBefore} ${localAfter}`;
    const scales = [...unitText.matchAll(/trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|oku\b|(?<![A-Za-z])k\b/gi)]
      .map(item => scaleExponent(item[0]))
      .filter(Number.isInteger);
    const scaleValues = [...new Set(scales)];
    const currency = /(?:¥|円|yen\b|jpy\b)/i.test(unitText)
      ? "jpy"
      : /(?:usd|dollars?\b)/i.test(unitText)
        ? "usd"
        : /(?:eur|euros?\b)/i.test(unitText) ? "eur" : "";
    const genericUnit = /(?:vehicles?\b|units?\b|shipments?\b|deliveries?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|台数|販売台数|生産台数|出荷台数|数量|株式数|株数|持株数|人員数|従業員数|件数)/i.test(unitText)
      ? "measure" : "";
    const unitKey = JSON.stringify({
      scale: scaleValues.length === 1 ? scaleValues[0] : scaleValues.length ? "ambiguous" : 0,
      currency,
      genericUnit,
    });
    const explicit = directUnitRe.test(unitText);
    out.push({ raw, digits, decimals: fraction.length, negative, percent, explicit, unitKey });
  }
  return out;
}

function looseDigitsEqual(a, b) {
  return String(a?.digits || "0").replace(/^0+(?=\d)/, "")
    === String(b?.digits || "0").replace(/^0+(?=\d)/, "");
}

function sameSignedValue(a, b) {
  const unitsAgree = (!a?.explicit && !b?.explicit)
    || (a?.explicit && b?.explicit && a.unitKey === b.unitKey);
  return Boolean(a && b && a.negative === b.negative && a.decimals === b.decimals
    && looseDigitsEqual(a, b) && unitsAgree);
}

function sameDecimalScaleValue(a, b) {
  if (!a || !b || a.negative !== b.negative || a.percent !== b.percent
    || a.explicit || b.explicit) return false;
  // `5,018.9` and `50,189` have the same significant digits after the
  // decimal point is removed.  The missing decimal is the visible symptom of
  // a scale caption changing from billion/100-million style to a Japanese
  // integer table.  Require a real decimal-place difference so 48 vs 48 is
  // handled by exact equality and 48 vs 49 never qualifies.
  return a.decimals !== b.decimals && looseDigitsEqual(a, b);
}

function allPairsAreNormalizedEquivalent(quoteText, referenceText, strictQuote = [], strictReference = []) {
  const quote = looseNumericTokens(quoteText);
  const reference = looseNumericTokens(referenceText);
  if (!quote.length || quote.length !== reference.length) return false;
  const financial = FINANCIAL_LABEL_RE.test(String(quoteText || ""))
    || FINANCIAL_LABEL_RE.test(String(referenceText || ""));
  let inferredScale = null;
  for (let i = 0; i < quote.length; i++) {
    const left = quote[i], right = reference[i];
    const strictLeft = strictQuote[i], strictRight = strictReference[i];
    // The strict extractor sees row/table captions that may be far from the
    // number (including a preceding line).  Once it has paired explicit
    // non-rate unit/scale evidence, a decimal-place-only inference is not
    // authoritative; the strict quantity proof above is the sole authority.
    const strictUnitEvidence = Boolean(strictLeft?.nonRateUnitEvidence || strictLeft?.scaleCaption
      || strictRight?.nonRateUnitEvidence || strictRight?.scaleCaption);
    const strictLeftCurrency = strictLeft?.currencyEvidence || strictLeft?.rowCurrency || "";
    const strictRightCurrency = strictRight?.currencyEvidence || strictRight?.rowCurrency || "";
    if (strictLeftCurrency && strictRightCurrency && strictLeftCurrency !== strictRightCurrency) return false;
    if (left.negative !== right.negative) return false;
    if (sameSignedValue(left, right)) continue;
    // Rates are already in their display unit.  A decimal-place inference on
    // `2.0%` vs `20%` would turn a genuine percentage mismatch into a drop.
    if (strictUnitEvidence || !financial || left.percent || right.percent || !sameDecimalScaleValue(left, right)) return false;
    const shift = left.decimals - right.decimals;
    if (inferredScale === null) inferredScale = shift;
    if (inferredScale !== shift) return false;
  }
  return true;
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
    // Reject explicit measure/scope/period identity differences before any
    // quantity proof. Shared row captions can make two cross-family columns
    // look numerically equivalent, so the identity veto must run before the
    // scale-aware interval shortcut as well as before the loose fallback.
    if (hasExplicitIdentityMismatch(quote, reference)) return false;
    // Run the strict masked/unit-aware proof first.  The normalized textual
    // proof then handles short unmasked excerpts (including parentheses vs
    // Japanese triangles and decimal-place scale changes) without relying on
    // a model-authored reason or suggestion.
    if (allPairsProveFalsePositive(quote, reference, masker)) return true;
    // The display-only fallback is intentionally disabled for a single
    // primary pair.  Without a specific same-measure proof, equal bare
    // digits such as `Total 48` vs `Total 48` are not enough to hard-drop.
    if (quote.length === 1 && reference.length === 1) return false;
    // Decimal-place fallback is intentionally unavailable once either quote
    // carries an explicit scale caption.  The strict base-unit proof above is
    // the only authority in that case; otherwise `12.3 million` vs `123
    // 百万円` (both display digits `123`) would be incorrectly dropped.
    // The loose proof itself checks explicit evidence on each mismatched
    // pair.  This keeps the guard local: a rate's `%` marker must not block
    // otherwise unit-free amount columns, while `12.3 yen` vs `123 円` and
    // `12.3 USD` vs `123 USD` remain findings.  Captions/scales in a pair are
    // likewise left to the strict quantity proof above.
    return allPairsAreNormalizedEquivalent(f.quote, f.referenceQuote ?? f.reference_quote, quote, reference);
  }
  // If exactly one primary citation contains numeric evidence, the other side
  // is not directly comparable.  A narrowly bounded auxiliary proof is still
  // useful for the real report shape: the reason may repeat the one cited
  // value twice while the producer omitted referenceQuote.  It must match a
  // value actually present in the primary quote; a suggestion alone is never
  // enough.  The cash-flow rounding exception is similarly restricted to a
  // named investing/financing/operating row.
  if ((quote.length > 0) !== (reference.length > 0)) {
    const primary = quote.length > 0 ? quote : reference;
    const primaryText = quote.length > 0 ? f.quote : (f.referenceQuote ?? f.reference_quote);
    for (const field of [f.reason, f.model_reason, f.issueSummary, f.issue_summary]) {
      const values = extractNumericEvidence(field, masker);
      if (repeatedClaimMatchesPrimary(primary, field, masker)) return true;
      if (cashFlowRoundingEquivalent(primaryText, primary, field, values, f, masker)) return true;
    }
    return false;
  }
  // With no primary numeric evidence, a repeated value in the model's reason
  // is positive evidence of a self-contradictory comparison (e.g. the same
  // financing cash flow copied three times).  Do not trust self_check flags;
  // derive this from the numeric text and its local identity instead.
  for (const field of [f.reason, f.model_reason, f.issueSummary, f.issue_summary]) {
    if ((isSafeEqualEitherOrClaim(field) && allNumericCandidatesSameIdentity(field, masker))
        || repeatedNumericClaim(field, masker)) return true;
    const values = extractNumericEvidence(field, masker);
    if (fieldPairsProveFalsePositive(values, masker)) return true;
  }
  // A suggestion-only page-labelled tautology remains supported for legacy
  // reports where the producer omitted both quote fields.
  if (isSafeEqualEitherOrClaim(f.suggestion)
      && allNumericCandidatesSameIdentity(f.suggestion, masker)) return true;
  if (fieldPairsProveFalsePositive(extractNumericEvidence(f.suggestion, masker), masker)) return true;
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

function hasLargePageEqualEitherOrNumbers(value) {
  const text = String(value || "");
  if (!hasEqualEitherOrNumbers(text)) return false;
  const number = String.raw`[△▲+−-]?\(?\d[\d,]*(?:\.\d+)?\)?`;
  const match = text.match(new RegExp(
    String.raw`P\.?\d+の\s*(${number})\s*と\s*P\.?\d+の\s*(${number})[^。]*どちら`,
    "i",
  ));
  if (!match || normalizedSignedNumber(match[1]) !== normalizedSignedNumber(match[2])) return false;
  // Short page labels such as 「P.4の304とP.15の304」 are often a model's
  // prose summary rather than restored masked evidence.  Require a visibly
  // substantial accounting value (comma-formatted or at least four digits)
  // before using this auxiliary-field shortcut.
  return [match[1], match[2]].some(raw => normalizedSignedNumber(raw)
    .replace(/^-/, "").replace(/\./g, "").length >= 4);
}

function stripPageAndPeriodReferences(value) {
  return String(value || "")
    .replace(/P\s*[.．]\s*\d{1,4}/gi, " ")
    .replace(/FY\s*\d{2,4}/gi, " ")
    .replace(/\d{4}年/g, " ")
    .replace(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}/gi, " ");
}

function isSafeEqualEitherOrClaim(value) {
  const text = String(value || "");
  if (!hasLargePageEqualEitherOrNumbers(text)) return false;
  // The page-labelled form is common after masking is restored (for example,
  // "P.22の60,132とP.25の60,132のどちら"). It is safe only when the claim
  // does not simultaneously name two different measures, scopes, or scales.
  const measures = [...new Set(MEASURE_PATTERNS.filter(rule => rule.re.test(text)).map(rule => rule.key))];
  if (measures.length > 1) return false;
  const scopes = [...new Set(SCOPE_PATTERNS.filter(rule => rule.re.test(text)).map(rule => rule.key))];
  if (scopes.length > 1) return false;
  const scales = [...new Set([...text.matchAll(SCALE_WORD_RE)]
    .map(match => scaleExponent(match[0])).filter(Number.isInteger))];
  if (scales.length > 1) return false;
  return currencyCodes(text).length <= 1;
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
