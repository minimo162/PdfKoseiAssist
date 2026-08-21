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

// `100oku` and `100 oku` are the same amount spelling.  The same is true
// when accounting parentheses surround the amount: `(100)oku` and
// `(100) oku` differ only by an optional gap after the closing parenthesis.
// Copilot can label that surface-only difference as formatting/terminology,
// so keep this proof independent of the numeric-category allowlist.  It is
// deliberately exact: case, value, sign, unit vocabulary, and all other text
// must remain unchanged.
const OKU_AMOUNT_GAP_RE = /(\(\s*(?:⟦#[A-Z]{3}⟧|\d[\d,]*(?:\.\d+)?)\s*\)|(?:⟦#[A-Z]{3}⟧|\d[\d,]*(?:\.\d+)?))\s*([oO][kK][uU])(?![A-Za-z])/g;
const NEGATIVE_OKU_AMOUNT_RE = /\(\s*(?:⟦#[A-Z]{3}⟧|\d[\d,]*(?:\.\d+)?)\s*\)\s*[oO][kK][uU](?![A-Za-z])/;
const JAPANESE_NEGATIVE_OKU_AMOUNT_RE = /(?:△|▲|[-−])\s*(?:⟦#[A-Z]{3}⟧|\d[\d,]*(?:\.\d+)?)\s*億(?:円)?/u;

function normalizeOkuAmountGap(value) {
  return String(value || "").trim().replace(OKU_AMOUNT_GAP_RE, (_all, amount, unit) => `${amount} ${unit}`);
}

function isOkuAmountGapOnlyFinding(finding) {
  const f = finding || {};
  const quote = String(f.quote || "").trim();
  if (!quote) return false;
  const reference = String(f.referenceQuote ?? f.reference_quote ?? "").trim();
  const comparison = reference || String(f.suggestion || "").trim();
  if (!comparison || quote === comparison) return false;
  const quoteNormalized = normalizeOkuAmountGap(quote);
  const comparisonNormalized = normalizeOkuAmountGap(comparison);
  return quoteNormalized === comparisonNormalized
    && (quoteNormalized !== quote || comparisonNormalized !== comparison);
}

function isNegativeOkuEquivalenceCandidate(finding) {
  const f = finding || {};
  const quote = String(f.quote || "").trim();
  const reference = String(f.referenceQuote ?? f.reference_quote ?? "").trim();
  if (!quote || !reference) return false;
  const isNegativeOku = value => NEGATIVE_OKU_AMOUNT_RE.test(value)
    || JAPANESE_NEGATIVE_OKU_AMOUNT_RE.test(value);
  return isNegativeOku(quote) && isNegativeOku(reference);
}

function okuUnitSpelling(value) {
  return String(value || "").match(/([oO][kK][uU])(?![A-Za-z])/)?.[1] || "";
}

function okuAuxiliaryNumericContradiction(finding, quote, comparison, masker) {
  const allowed = new Set([...quote, ...comparison]
    .map(token => `${canonicalNumericKey(token)}:${token.negative ? "negative" : "positive"}`)
    .filter(key => !key.startsWith(":")));
  if (!allowed.size) return false;
  return [finding?.reason, finding?.model_reason, finding?.issueSummary,
    finding?.issue_summary, finding?.suggestion]
    .map(value => canonicalClaimText(value))
    .filter(Boolean)
    .some(value => extractNumericEvidence(value, masker).some(token => {
      const key = canonicalNumericKey(token);
      return key && !allowed.has(`${key}:${token.negative ? "negative" : "positive"}`);
    }));
}

function hasExplicitSourceUnitCaption(context, side) {
  const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "");
  return /(?:\bunit(?:s)?\b|amounts?\s+in|\bin\s+(?:the\s+)?(?:millions?|billions?|thousands?)|単位)[^\n]{0,80}(?:oku|兆|億|百万|万|千|million|billion|trillion|thousand|yen|jpy|usd)/iu.test(text);
}

function partialSourceCaptionContradicts(context, side, resolvedDescriptor) {
  if (!resolvedDescriptor) return false;
  const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "");
  const rowText = String(context?.[`${side}RowText`] || context?.[`${side}_row_text`] || "");
  if (!text || !rowText) return false;
  const lines = text.split(/\r?\n/);
  const rowIndex = lines.findIndex(line => line.includes(rowText));
  if (rowIndex < 0) return false;
  const captionRe = /(?:\bunit(?:s)?\b|amounts?\s+in|\bin\s+(?:the\s+)?(?:millions?|billions?|thousands?)|単位)/iu;
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 24); index--) {
    const line = String(lines[index] || "").trim();
    if (!captionRe.test(line)) continue;
    // PDF extraction can flatten adjacent table captions onto one line. Split
    // independent parenthesized captions before judging the row, matching the
    // general source-unit resolver; a valid `(単位：億円)` segment must not be
    // contradicted by the neighbouring table's `(単位：千台)` segment.
    const segments = [...line.matchAll(/(?:\([^()\n]*\)|（[^（）\n]*）)/gu)]
      .map(match => match[0])
      .filter(segment => {
        SCALE_WORD_RE.lastIndex = 0;
        const matched = SCALE_WORD_RE.test(segment);
        SCALE_WORD_RE.lastIndex = 0;
        return matched;
      });
    const candidates = segments.length > 1 ? segments : [line];
    const compatible = candidates.some(candidate => {
      const scales = [...candidate.matchAll(SCALE_WORD_RE)]
        .map(match => scaleExponent(match[0]))
        .filter(Number.isInteger);
      const uniqueScales = [...new Set(scales)];
      if (uniqueScales.length !== 1 || uniqueScales[0] !== resolvedDescriptor.scale) return false;
      if (!/(?:円|\byen\b|\bjpy\b|\busd\b)/iu.test(candidate)) return true;
      const currencies = [...new Set(currencyCodes(candidate))];
      return currencies.length === 1 && currencies[0] === resolvedDescriptor.currency;
    });
    return !compatible;
  }
  return false;
}

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
// U+FF0B (＋) is an explicit positive sign; U+FF0D (－) is intentionally
// absent because PDF tables use it as a missing-value dash.
const NUMERIC_TOKEN_RE = /⟦#[A-Z]{3}⟧|[△▲+＋−-]\s*\(?\s*\d[\d,]*(?:\.\d+)?\s*\)?|\(\s*\d[\d,]*(?:\.\d+)?\s*\)|\d[\d,]*(?:\.\d+)?/g;
// Match compound Japanese scales before their shorter components.  PDF text
// extraction may insert spaces inside 百万円/十億円, so the spaces are allowed
// only between scale characters and are removed by scaleExponent().
const SCALE_WORD_RE = /trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|(?<![A-Za-z])oku(?![A-Za-z])|(?<![A-Za-z])mil\.?(?=\s*(?:yen|円))|(?<![A-Za-z])k\b/gi;
const SCALE_EXPONENTS = new Map([
  ["trillion", 12], ["trillions", 12], ["兆", 12],
  ["billion", 9], ["billions", 9], ["十億", 9],
  ["million", 6], ["millions", 6], ["百万", 6],
  ["mil", 6],
  ["thousand", 3], ["thousands", 3], ["千", 3], ["万", 4], ["億", 8], ["oku", 8], ["k", 3],
]);

// Evidence used by the loose comparison must exclude rate markers and broad
// Japanese label characters (for example, `社` inside `会社`).  This is
// deliberately a quantity-unit vocabulary, not a measure-family classifier.
const NON_RATE_UNIT_RE = /(?:[$€£¥]|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|(?<![A-Za-z])oku(?![A-Za-z])|(?<![A-Za-z])k\b|vehicles?\b|units?\b|shipments?\b|deliveries?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|台数|販売台数|生産台数|出荷台数|数量|株式数|株数|持株数|人員数|従業員数|件数)/i;

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
  // A model may restate a detailed Japanese period as an anaphoric English
  // label (`2025年3月期 ... 同じFY2025の値`).  Reuse the earlier detailed
  // period only when that explicit same-period phrase names the same year;
  // a bare FY2025 remains distinct from 2025年3月期.
  const samePeriod = [...before.matchAll(/(?:同じ|same)\s*FY\s*(\d{2,4})\b/giu)].at(-1);
  if (samePeriod) {
    const year = samePeriod[1].length === 2 ? `20${samePeriod[1]}` : samePeriod[1];
    const detailed = candidates.filter(candidate =>
      candidate.index < (samePeriod.index || 0) && candidate.key.startsWith(`fy${year}-`));
    if (detailed.length) return detailed.at(-1).key;
  }
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
  { family: "money", re: /¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|金額|revenue\b|net\s+sales\b|sales\s+amount|operating\s+income|ordinary\s+income|profit\b|loss\b|assets?\b|liabilit(?:y|ies)\b|cash\s+flow|cost\b|price\b|amount\b|売上(?:高|収益)?|収益|営業利益|経常利益|利益|損失|損益|評価損|売却益|戻入益|引当金(?:繰入額)?|資産|負債|純利益|当期純利益|税金|費用/i },
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
  // Narrative financing notes use a short bilingual label rather than a
  // statement-line name.  Keep these aliases paired narrowly so a source
  // bound `700億円`/`70 billion yen` amount can be converted, while an
  // unrelated amount remains a finding.
  { key: "loan_amount", re: /loan\s+amount|借入額|借入金額/i },
  { key: "early_repayment_total", re: /total\s+amount\s+of\s+early\s+repayment|early\s+repayment\s+amount|期限前弁済(?:総額|額)/i },
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
  { key: "net_assets_per_share_stock_count", re: /number\s+of\s+common\s+stock\s+used\s+in\s+the\s+calculation\s+of\s+net\s+assets\s+per\s+share|１?株当たり純資産額の算定に用いられた/i },
  // Opening-balance vectors in the equity-change table use different
  // language on each side (`Balance at April 1` / `当期首残高`).  Keep this
  // alias narrow: it identifies that row only and does not make generic
  // `balance`/`total` labels interchangeable with another measure.
  { key: "opening_balance", re: /balance\s+at\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|(?:opening|beginning)\s+balance|当期首残高|期首残高/i },
  { key: "dividend_per_share", re: /dividend\s+per\s+share|\bDPS\b|1株当たり配当/i },
  // The attached result uses a bilingual `Dividends paid`/`剰余金の配当`
  // row.  Treat the two labels as one measure so identical signed columns
  // are proven equivalent without mistaking an unrelated amount for it.
  { key: "dividends_paid", re: /dividends?\s+paid\b|剰余金の配当|配当金額?/i },
  // Row-number columns must not be confused with employee values.  This
  // alias lets a bilingual employee-count row bind even when the TARGET quote
  // contains only the numeric vector and the REF retains its row label.
  { key: "employee_count", re: /number\s+of\s+employees?\b|employee\s+(?:count|number)\b|従業員数|就業人員|人員数/i },
  // The TARGET/REF pair may phrase the same stock-count row differently.
  // Keep this alias narrow so an average-share row is recognized without
  // treating arbitrary `shares` or `株式数` labels as the same measure.
  { key: "average_shares", re: /average\s+(?:number\s+of\s+)?shares?\b|期中平均(?:普通)?株式数|普通株式の期中平均株式数|期中平均株数/i },
  { key: "production_termination_loss_provision", re: /provision\s+for\s+loss\s+on\s+production\s+termination|生産終了損失引当金(?:繰入額)?/i },
  { key: "deferred_hedge_result", re: /deferred\s+gains?\s*\/\s*\(losses?\)\s+on\s+hedges|繰延\s*ヘッジ\s*損益/i },
  { key: "subsidiary_business_loss_provision", re: /reserve\s+for\s+loss\s+on\s+business\s+of\s+subsidiaries\s+and\s+affiliates|関係会社事業損失引当金/i },
  { key: "investment_security_sale_gain", re: /gain\s+on\s+sales?\s+of\s+investment\s+securities|投資有価証券売却益/i },
  { key: "environmental_provision_reversal", re: /reversal\s+of\s+provision\s+for\s+environmental\s+measures|環境対策引当金戻入益/i },
  { key: "subsidiary_investment_valuation_loss", re: /loss\s+on\s+valuation\s+of\s+investments?\s+in\s+capital\s+of\s+subsidiaries\s+and\s+affiliates|関係会社出資金評価損/i },
  { key: "comprehensive_income", re: /comprehensive\s+income|包括利益/i },
  { key: "credit_asset_valuation_loss", re: /loss\s+on\s+valuation\s+of\s+credit\s+assets|クレジット資産評価損|信用資産評価損/i },
  { key: "operating_income", re: /operating\s+income|営業利益/i },
  { key: "ordinary_income", re: /ordinary\s+income|経常利益/i },
  // Net loss / 純損失 is the loss-side label of the same net-income line,
  // not the generic loss measure.  Keep this alias explicit so Operating
  // income and other distinct measures remain incompatible.
  { key: "net_income", re: /net\s+(?:income|loss)|income\s+attributable|純(?:利益|損失)|当期純利益|親会社株主.{0,20}(?:純利益|利益|帰属)/i },
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
  // Exclude explicit non-consolidated forms before recognizing consolidated;
  // otherwise 非連結/non-consolidated is incorrectly treated as consolidated.
  { key: "consolidated", re: /(?<!non-)(?<!non\s)\bconsolidated\b|(?<!非)連結/i },
  { key: "standalone", re: /standalone|unconsolidated|non[\s-]*consolidated|非\s*連結|単体|個別/i },
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

// PDF text extraction can insert arbitrary whitespace inside a Japanese
// compound label (for example `非  連結`).  Normalize only these scope forms
// before applying the deliberately narrow patterns so spaced 非連結 never
// becomes both standalone and consolidated evidence.
function normalizeScopeText(value) {
  let text = String(value || "")
    .replace(/非\s*連\s*結/gu, "非連結")
    // Keep the hyphen while collapsing extraction whitespace so the
    // consolidated rule's `non-` guard remains effective for `non-\nconsolidated`.
    .replace(/\bnon\s*-\s*consolidated\b/giu, "non-consolidated")
    .replace(/\bnon\s+consolidated\b/giu, "non-consolidated")
    .replace(/\bunconsolidated\b/giu, "unconsolidated");

  // `un consolidated` is not a general synonym in prose.  Treat the split
  // form as an extraction artifact only when the same bounded fragment has a
  // numeric row and a recognized measure label.  Standalone `un` and
  // `consolidated` lines are joined by precedingScopeFragmentText before this
  // check, while unrelated prose remains untouched.
  if (hasNumericToken(text) && MEASURE_PATTERNS.some(rule => rule.re.test(text))) {
    text = text.replace(/\bun[\s\r\n\t]+consolidated\b/giu, "unconsolidated");
  }
  return text;
}

// A PDF text layer can split a scope caption over adjacent lines (for example
// `非\n連結` or `non\nconsolidated`).  Carry at most two immediately preceding
// *scope-fragment* lines into the current value segment.  Numeric or ordinary
// row lines stop the window so a neighbouring row's scope cannot leak into the
// current row; following lines are never considered.
function isScopeFragmentLine(value) {
  const line = String(value || "")
    .trim()
    .replace(/^[「『（(【［\[]+|[」』）)】］\]]+$/gu, "")
    .trim();
  return /^(?:非\s*連\s*結|非\s*連|連\s*結|非|連|結|non-?|un|consolidated|unconsolidated|non\s*-\s*consolidated)$/iu.test(line);
}

function precedingScopeFragmentText(src, lineStart, maxLines = 2) {
  const source = String(src || "");
  let cursor = Math.max(0, Number(lineStart) || 0);
  const starts = [];
  for (let count = 0; count < maxLines && cursor > 0; count++) {
    const previousEnd = cursor > 0 && source[cursor - 1] === "\n" ? cursor - 1 : cursor;
    const previousStart = source.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
    const previousLine = source.slice(previousStart, previousEnd);
    if (!previousLine.trim() || hasNumericToken(previousLine) || !isScopeFragmentLine(previousLine)) break;
    starts.unshift(previousStart);
    cursor = previousStart;
  }
  return starts.length ? source.slice(starts[0], lineStart) : "";
}

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

// A model-authored reason can spell out the sign instead of repeating the
// accounting glyph (for example, a local `負の` phrase for a parenthesized
// amount). Treat a semantic word as a sign only when it is a tightly local,
// explicit numeric
// construction.  A distant `loss`/`decrease` label is often a row name or a
// separate claim and must not turn an unrelated positive amount negative.
function localSemanticNegative(text, token) {
  if (!token || token.symbol) return false;
  const raw = String(token.raw || "").trim();
  // An explicit plus sign is stronger evidence than prose around the value.
  if (/^[+＋]\s*/.test(raw)) return false;
  const before = String(text || "").slice(Math.max(0, Number(token.index) - 40), Number(token.index));
  // Do not match the `negative` suffix inside a negated/nonnegative phrase;
  // those constructions explicitly describe a non-negative value.
  if (/(?:\bnot\s+(?:a\s+)?(?:negative|minus)|\bnon[\s-]*(?:negative|minus)|非負\s*の)\s*$/iu.test(before)) return false;
  return /(?:負\s*の|マイナス|negative|minus)\s*$/iu.test(before);
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
  s = s.replace(/^[△▲−+＋\-]\s*/, "");
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
  // Japanese quarterly labels such as `第1四半期` carry the quarter ordinal
  // as structure, not as a compared amount.
  if (/^\s*四半期/u.test(after) && /第\s*$/u.test(before)) return true;
  if (/^\s*期/u.test(after)) {
    return String(bare || "").length <= 2 || /(?:第|FY)\s*$/iu.test(before);
  }
  return /^\s*(?:年|年度|月|日)/u.test(after)
    // Only a four-digit integer can be the trailing Japanese year.  A
    // decimal amount such as `27.5` also has four string characters; treating
    // it as a year when a later date appears in the same sentence removes the
    // primary amount needed to bind a rounded cross-page claim.
    || (/^\d{4}$/u.test(String(bare || "")) && /年|年度/u.test(after));
}

function scaleExponent(word) {
  const compact = String(word || "").replace(/\s+/g, "").replace(/\.$/, "");
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
  const scopePrefix = precedingScopeFragmentText(src, lineStart);
  const normalizedScopeSegment = normalizeScopeText(`${scopePrefix}${scopeSegment}`);
  for (const rule of SCOPE_PATTERNS) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    for (const _match of normalizedScopeSegment.matchAll(new RegExp(rule.re.source, flags))) scopeHits.push(rule.key);
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
    const previousSegment = normalizeScopeText(src.slice(Math.max(lineStart, previousSegmentStart), previous.end));
    for (const rule of MEASURE_PATTERNS) {
      const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
      for (const _match of previousSegment.matchAll(new RegExp(rule.re.source, flags))) measureHits.push(rule.key);
    }
  }
  if (tokenPosition > 0 && !scopeHits.length && !hasExplicitColumnSeparator) {
    const previous = lineTokens[tokenPosition - 1];
    const previousSegmentStart = tokenPosition > 1 ? lineTokens[tokenPosition - 2].end : lineStart;
    const previousSegment = normalizeScopeText(src.slice(Math.max(lineStart, previousSegmentStart), previous.end));
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
  // Keep currency evidence token-local when a reason contains two values on
  // one line.  The wider directText window is useful for labels, but it can
  // otherwise see both `yen` and `USD` in two separate clauses and erase the
  // very currency mismatch that should keep a finding alive.
  const currencyText = tokens.length === 1
    ? directText
    : src.slice(Math.max(lineStart, token.index - 24), Math.min(lineEnd, token.end + 24));
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
  const directCurrencies = currencyCodes(currencyText);
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
    const bare = token.raw.replace(/^[△▲+＋−-]/, "").replace(/[(),]/g, "");
    return !isStructuralPerUnitNumber(text, token.end)
      // Page references are structural numbers, regardless of whether the
      // extracted text used ASCII, full-width, or localized punctuation.
      // Keep this in step with parsePageMarkers instead of maintaining a
      // second ASCII-only `p|page` grammar here.
      && !tokenFallsInsidePageMarker(text, token)
      && !/(?:\b(?:p|page)\s*[.．]?\s*|\bfy\s*)$/i.test(before)
      && !isStructuralDateNumber(text, token.index, token.end, bare);
  });
  return tokens.map(token => {
    const family = mergeSymbolFamilyEvidence(familyEvidence(text, token, tokens), token.symbol, masker);
    const parts = token.symbol
      ? { digits: "", decimals: 0, negative: placeholderNegative(text, token) }
      : numericTokenParts(token.raw);
    const semanticNegative = localSemanticNegative(text, token);
    return {
      ...token,
      ...parts,
      negative: Boolean(parts.negative || semanticNegative),
      ...family,
    };
  });
}

// Bind a quote to a unique source row before borrowing adjacent unit/table
// context. Matching a few numeric substrings is not enough: repeated values
// in two rows, or a tied match on the same page, must fail closed. The caller
// may use the returned `text` for scale evidence and `rowText` for measure
// identity, but only when `unique` is true.
export function findUniqueNumericSourceContext(source, quote, options = {}) {
  const lines = String(source || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const quoteTokens = extractNumericEvidence(quote);
  const quoteKeys = quoteTokens.map(canonicalNumericKey);
  if (!lines.length || !quoteKeys.length || quoteKeys.some(key => !key)) return null;
  // Forecast/financial-results tables may split one long label onto a
  // separate line (the four-row forecast in the live export uses five visual
  // lines).  Keep the window bounded, but allow the complete source vector to
  // bind before falling back to the conservative ambiguity check.
  const maxWindowLines = Math.max(1, Math.min(12, Number(options.maxWindowLines) || 8));

  // PDF.js may place two fiscal-year columns/rows on one visual line.  In
  // that shape the whole line has more numeric tokens than the quoted row,
  // so a token-count-only window cannot bind the citation (the real Mazda
  // P.1 summary is one such line).  A literal quote match is source-backed:
  // it still has to be unique on that line, and the returned row fragment is
  // anchored at the quoted period rather than borrowing the neighbouring
  // period's numbers.  Do not use model-authored prose here.
  const compact = value => String(value || "").replace(/[ \t\u00a0]+/g, " ").trim();
  // Number/unit gaps are PDF layout artifacts, not source identity.  Remove
  // only a gap between a numeric character and a recognized scale/currency
  // unit; ordinary spaces remain meaningful so adjacent table columns cannot
  // be concatenated into a false quote match.
  const compactNumericUnits = value => compact(value)
    .replace(/([0-9０-９])\s+(?=(?:兆|億|万|千|百|十|円|％|%))/gu, "$1");
  const compactQuote = compactNumericUnits(quote);
  if (compactQuote) {
    const textCandidates = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = compactNumericUnits(lines[lineIndex]);
      let cursor = 0;
      while (cursor <= line.length) {
        const matchIndex = line.indexOf(compactQuote, cursor);
        if (matchIndex < 0) break;
        const prefix = line.slice(0, matchIndex);
        const periodMatches = [
          ...prefix.matchAll(/(?:\bFY\s*\d{2,4}\b|(?<!\d)\d{4}\s*年\s*\d{1,2}\s*月)/giu),
        ];
        const periodStart = periodMatches.length
          ? periodMatches[periodMatches.length - 1].index
          : matchIndex;
        const labelPrefix = line.slice(0, periodStart);
        const labelMatches = [];
        for (const rule of MEASURE_PATTERNS) {
          const flags = rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`;
          for (const labelMatch of labelPrefix.matchAll(new RegExp(rule.re.source, flags))) {
            labelMatches.push({ index: labelMatch.index, text: labelMatch[0], key: rule.key });
          }
        }
        let label = labelMatches.length
          ? [...labelMatches].sort((left, right) => {
            const generic = new Set(["profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity", "net_income"]);
            const leftPriority = generic.has(left.key) ? 0 : 1;
            const rightPriority = generic.has(right.key) ? 0 : 1;
            return (rightPriority - leftPriority) || (right.text.length - left.text.length) || (right.index - left.index);
          })[0].text.trim()
          : "";
        // The English FY2025 line in the real summary follows a numeric
        // FY2026 line, while its `Comprehensive income` label is on that
        // preceding line.  Borrow only one immediately preceding line and
        // only its single most-specific measure label; a competing/tied
        // label remains unbound and therefore cannot authorize a drop.
        if (!label) {
          const previous = lineIndex > 0 ? compact(lines[lineIndex - 1]) : "";
          const previousMatches = [];
          for (const rule of MEASURE_PATTERNS) {
            const flags = rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`;
            for (const previousMatch of previous.matchAll(new RegExp(rule.re.source, flags))) {
              previousMatches.push({ text: previousMatch[0], key: rule.key });
            }
          }
          const generic = new Set(["profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity", "net_income"]);
          const specific = [...new Set(previousMatches.filter(match => !generic.has(match.key)).map(match => match.key))];
          if (specific.length === 1) {
            label = previousMatches.find(match => match.key === specific[0])?.text?.trim() || "";
          }
        }
        const periodRow = line.slice(periodStart, matchIndex + compactQuote.length).trim();
        const rowText = [label, periodRow].filter(Boolean).join(" ");
        textCandidates.push({
          lineIndex,
          rowStart: lineIndex,
          rowEnd: lineIndex,
          rowText: rowText || compactQuote,
          matchIndex,
          matchEnd: matchIndex + compactQuote.length,
        });
         cursor = matchIndex + Math.max(1, compactQuote.length);
      }
    }
    // PDF.js can split a long narrative at a visual-line boundary.  Search a
    // bounded line window with the boundary removed, then deduplicate the same
    // occurrence seen through larger windows.  This is still source-bound:
    // the complete quote must occur once, and a second occurrence remains
    // ambiguous/KEEP.
    const normalizedLines = lines.map(compactNumericUnits);
    const crossLineCandidates = new Map();
    for (let start = 0; start < normalizedLines.length; start++) {
      let joined = "";
      for (let end = start; end < Math.min(normalizedLines.length, start + maxWindowLines); end++) {
        joined += normalizedLines[end];
        if (end === start || joined.length < compactQuote.length) continue;
        let cursor = 0;
        while (cursor <= joined.length) {
          const matchIndex = joined.indexOf(compactQuote, cursor);
          if (matchIndex < 0) break;
          const matchEnd = matchIndex + compactQuote.length;
          let firstLine = start;
          let lastLine = end;
          let offset = 0;
          for (let line = start; line <= end; line++) {
            const lineEnd = offset + normalizedLines[line].length;
            if (matchIndex < lineEnd) {
              firstLine = line;
              break;
            }
            offset = lineEnd;
          }
          offset = 0;
          for (let line = start; line <= end; line++) {
            const lineEnd = offset + normalizedLines[line].length;
            if (matchEnd <= lineEnd) {
              lastLine = line;
              break;
            }
            offset = lineEnd;
          }
          if (firstLine !== lastLine) {
            const globalMatchIndex = normalizedLines.slice(0, start)
              .reduce((total, value) => total + value.length, 0) + matchIndex;
            const key = `${globalMatchIndex}:${compactQuote.length}`;
            crossLineCandidates.set(key, {
              lineIndex: firstLine,
              rowStart: firstLine,
              rowEnd: lastLine,
              rowText: lines.slice(firstLine, lastLine + 1).join(" "),
              matchIndex,
              matchEnd,
            });
          }
          cursor = matchIndex + Math.max(1, compactQuote.length);
        }
      }
    }
    textCandidates.push(...crossLineCandidates.values());
    if (textCandidates.length === 1) {
      const candidate = textCandidates[0];
      const contextStart = Math.max(0, candidate.rowStart - 8);
      return {
        unique: true,
        rowText: candidate.rowText,
        // Keep the source line boundaries as well as the flattened identity
        // string.  A finding can cite a compact vector spanning several table
        // rows; the flattened `rowText` is useful for the existing single-row
        // gates, while the boundaries let a stricter source-backed vector gate
        // compare each metric at the same row position.
        rowLines: lines.slice(candidate.rowStart, candidate.rowEnd + 1),
        text: lines.slice(contextStart, candidate.rowEnd + 1).map(compact).join("\n"),
        rowStart: candidate.rowStart,
        rowEnd: candidate.rowEnd,
      };
    }
  }
  const candidates = new Map();
  for (let start = 0; start < lines.length; start++) {
    for (let end = start; end < Math.min(lines.length, start + maxWindowLines); end++) {
      const windowLines = lines.slice(start, end + 1);
      const sourceTokens = extractNumericEvidence(windowLines.join("\n"));
      const sourceKeys = sourceTokens.map(canonicalNumericKey);
      if (sourceKeys.length !== quoteKeys.length
          || sourceKeys.some((key, index) => key !== quoteKeys[index])) continue;
      const numericLines = windowLines
        .map((line, index) => extractNumericEvidence(line).length ? index : -1)
        .filter(index => index >= 0);
      if (!numericLines.length) continue;
      const rowStart = start + numericLines[0];
      const rowEnd = start + numericLines[numericLines.length - 1];
      const key = `${rowStart}:${rowEnd}`;
      candidates.set(key, { rowStart, rowEnd });
    }
  }
  // PDF text extraction may place a second table beside the cited table.  In
  // that case each source line has extra numeric cells, so an exact token-count
  // window is intentionally too strict.  Bind a vector by metric row instead:
  // every quoted metric group must occur as an ordered subsequence on one
  // source line, and the complete line sequence must be unique.
  if (!candidates.size) {
    const quoteEvidence = extractNumericEvidence(quote);
    const genericMeasure = new Set(["profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity", "net_income"]);
    const groups = [];
    for (const token of quoteEvidence) {
      const keys = [...new Set((token.measureKeys || []).filter(key => !genericMeasure.has(key)))];
      const identity = keys[0] || [...new Set(token.measureKeys || [])][0] || "";
      const previous = groups.at(-1);
      if (!previous || (identity && previous.identity && identity !== previous.identity)) {
        groups.push({ identity, tokens: [token] });
      } else {
        previous.tokens.push(token);
      }
    }
    if (groups.length >= 2 && groups.every(group => group.tokens.length > 0)) {
      const sourceLines = lines.map((line, index) => {
        const tokens = extractNumericEvidence(line);
        const preceding = index > 0 && !extractNumericEvidence(lines[index - 1]).length ? lines[index - 1] : "";
        const identityText = [preceding, line].filter(Boolean).join(" ");
        const identities = new Set(extractNumericEvidence(identityText)
          .flatMap(token => token.measureKeys || [])
          .filter(Boolean));
        return { index, tokens, identities };
      }).filter(item => item.tokens.length);
      const containsGroup = (line, group) => {
        const wanted = group.tokens.map(canonicalNumericKey);
        const available = line.tokens.map(canonicalNumericKey);
        for (let start = 0; start <= available.length - wanted.length; start++) {
          if (!wanted.every((key, index) => key && available[start + index] === key)) continue;
          if (group.identity && line.identities.size
              && !line.identities.has(group.identity)) continue;
          return true;
        }
        return false;
      };
      const choices = groups.map(group => sourceLines.filter(line => containsGroup(line, group)));
      const paths = [];
      const walk = (groupIndex, previousLine, selected) => {
        if (paths.length > 1) return;
        if (groupIndex >= choices.length) {
          paths.push([...selected]);
          return;
        }
        for (const candidate of choices[groupIndex]) {
          if (candidate.index <= previousLine) continue;
          walk(groupIndex + 1, candidate.index, [...selected, candidate.index]);
        }
      };
      walk(0, -1, []);
      if (paths.length === 1) {
        const rowStart = paths[0][0];
        const rowEnd = paths[0].at(-1);
        candidates.set(`${rowStart}:${rowEnd}`, { rowStart, rowEnd });
      }
    }
  }
  if (candidates.size !== 1) return null;
  const [{ rowStart, rowEnd }] = [...candidates.values()];
  // Keep enough preceding visual lines to retain a nearby table unit caption
  // (for example `(Millions of Yen)` above a statement row).  Positive use
  // still requires a unique row and compatible source-backed measure; this
  // wider context only makes the already-bound unit visible to the gate.
  const contextStart = Math.max(0, rowStart - 8);
  // PDF text extraction can put the row label on the line immediately before
  // the value columns.  Fold only that one nonnumeric line, and only when it
  // contains a recognized measure alias, into the source row identity.  This
  // keeps a unique source-backed measure usable without borrowing an
  // arbitrary neighbouring row; repeated/tied numeric rows still return null
  // above.
  let labelStart = rowStart;
  for (let index = rowStart - 1; index >= Math.max(0, rowStart - 2); index--) {
    const candidate = lines[index];
    if (extractNumericEvidence(candidate).length) break;
    if (MEASURE_PATTERNS.some(rule => rule.re.test(candidate))) {
      labelStart = index;
      break;
    }
  }
  const rowIdentityLines = labelStart < rowStart
    ? lines.slice(labelStart, rowEnd + 1)
    : lines.slice(rowStart, rowEnd + 1);
  return {
    unique: true,
    rowText: rowIdentityLines.join(" "),
    rowLines: lines.slice(rowStart, rowEnd + 1),
    text: lines.slice(contextStart, rowEnd + 1).join("\n"),
    rowStart,
    rowEnd,
  };
}

function sourceContextMeasureSequence(value) {
  return extractNumericEvidence(value).map(token =>
    [...new Set((token.measureKeys || []).filter(Boolean))]);
}

function sourceContextMeasureMatchesQuote(context, finding) {
  const targetRow = String(context?.targetRowText || context?.target_row_text || "");
  const referenceRow = String(context?.referenceRowText || context?.reference_row_text || "");
  if (!targetRow || !referenceRow) return false;
  const targetQuote = String(context?.targetQuote || context?.target_quote || finding?.quote || "");
  const referenceQuote = String(context?.referenceQuote || context?.reference_quote
    || finding?.referenceQuote || finding?.reference_quote || "");
  const targetQuoteMeasures = sourceContextMeasureSequence(targetQuote);
  const referenceQuoteMeasures = sourceContextMeasureSequence(referenceQuote);
  const targetRowMeasures = sourceContextMeasureSequence(targetRow);
  const referenceRowMeasures = sourceContextMeasureSequence(referenceRow);
  // A quote with a recognized row label must bind to the same source-backed
  // measure.  Unlabelled numeric quotes are allowed to use the unique row
  // identity; they are still protected by the unique-window requirement.
  if (targetQuoteMeasures.length !== targetRowMeasures.length
      || referenceQuoteMeasures.length !== referenceRowMeasures.length) return false;
  for (let index = 0; index < targetQuoteMeasures.length; index++) {
    const quoteKeys = targetQuoteMeasures[index];
    const rowKeys = targetRowMeasures[index];
    if (quoteKeys.length && (!rowKeys.length || !quoteKeys.some(key => rowKeys.includes(key)))) return false;
  }
  for (let index = 0; index < referenceQuoteMeasures.length; index++) {
    const quoteKeys = referenceQuoteMeasures[index];
    const rowKeys = referenceRowMeasures[index];
    if (quoteKeys.length && (!rowKeys.length || !quoteKeys.some(key => rowKeys.includes(key)))) return false;
  }
  return true;
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

function cashFlowPeriodYearEvidence(value) {
  const source = String(value || "");
  const fiscalYears = periodYearSequence(source);
  const monthNumbers = new Map([
    ["january", 1], ["february", 2], ["march", 3], ["april", 4],
    ["may", 5], ["june", 6], ["july", 7], ["august", 8],
    ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  ]);
  const dateFiscalYears = [...source.matchAll(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*(\d{4})\b/giu,
  )].map(match => {
    const month = monthNumbers.get(match[1].toLowerCase());
    const year = Number(match[2]);
    return String(month <= 3 ? year : year + 1);
  });
  return { fiscalYears, dateFiscalYears };
}

function semanticNegativeCashFlow(text, token) {
  if (!token) return false;
  const src = String(text || "");
  const before = src.slice(Math.max(0, Number(token.index) - 96), Number(token.index));
  const after = src.slice(Number(token.end), Number(token.end) + 48);
  // `provided by/(used in)` is a bilingual table label, not a sign assertion
  // for the value that follows.  An unmarked number in that row must remain
  // positive/unknown; only an explicit parenthesis/triangle or a direct
  // `used` sentence may establish the negative sign.
  if (/(?:provided\s+by|provided\s+from)\s*\/\s*\(?[^\n]{0,24}\bused\s+in\b/iu.test(before)) return false;
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
  const parsed = parsePageMarkers(before);
  if (parsed.malformed.length) return null;
  return parsed.markers.length ? parsed.markers[parsed.markers.length - 1].page : null;
}

function cashFlowRoundingPairEquivalent(primaryText, left, auxiliaryText, right, options = {}) {
  if (!left || !right) return false;
  const leftScale = left.scaleExp || 0;
  const rightScale = right.scaleExp || 0;
  // An explicit numeric sign outranks surrounding prose.  In particular,
  // `used ... +27.5` is an explicit positive value, not a semantic negative.
  const explicitPositive = token => /^[+＋]\s*/.test(String(token?.raw || "").trim());
  const explicitNegative = token => tokenNegative(token?.raw);
  const leftNegative = explicitPositive(left)
    ? false
    : explicitNegative(left) || left.negative || semanticNegativeCashFlow(primaryText, left);
  const inheritedSemanticNegative = options.inheritPrimarySemanticSign
    ? semanticNegativeCashFlow(primaryText, left)
    : false;
  const rightNegative = explicitPositive(right)
    ? false
    : explicitNegative(right) || right.negative
      || semanticNegativeCashFlow(auxiliaryText, right)
      || inheritedSemanticNegative;
  if (leftNegative !== rightNegative) return false;
  const leftCurrency = left.currencyEvidence || left.rowCurrency || "";
  const rightCurrency = right.currencyEvidence || right.rowCurrency || "";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
  const leftMagnitude = canonicalNumericKey({ ...left, negative: false }).replace(/^\+/, "");
  const rightMagnitude = canonicalNumericKey({ ...right, negative: false }).replace(/^\+/, "");
  if (leftMagnitude === rightMagnitude
      && (!leftScale || !rightScale || leftScale === rightScale)) return true;
  // When both citations state their scales, compare their displayed rounding
  // intervals directly.  The live export contains `0.9 billion` versus
  // `(868) millions of yen`; rejecting the explicit million caption here
  // made the safer, better-evidenced shape fail while the legacy bare `868`
  // exception below succeeded.  Keep the semantic sign/currency gates above
  // and let the shared integer interval proof enforce the rounding boundary.
  if (leftScale && rightScale) {
    return quantityIntervalsOverlap(
      { ...left, negative: false, scaleExp: leftScale, rowScaleExp: 0, scaleKnown: true },
      { ...right, negative: false, scaleExp: rightScale, rowScaleExp: 0, scaleKnown: true },
    );
  }
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

function explicitMeasureKeysFromText(value) {
  const matches = MEASURE_PATTERNS
    .filter(rule => rule.re.test(String(value || "")))
    .map(rule => rule.key);
  const specific = matches.filter(key => !GENERIC_MEASURE_KEYS.has(key));
  return [...new Set(specific.length ? specific : matches)];
}

const PAGE_MARKER_RE = /(?:\bP\s*[.．]?\s*(\d{1,4})\b|\bPage\s+(\d{1,4})\b)/giu;
const MALFORMED_PAGE_MARKER_RE = /(?:\bP\s*[-‐‑‒–—−]\s*\d{1,4}\b|\bPage\s*[-‐‑‒–—−]\s*\d{1,4}\b)/giu;

export function parsePageMarkers(value) {
  const source = String(value || "").normalize("NFKC");
  const markers = [...source.matchAll(PAGE_MARKER_RE)].map(match => ({
    page: Number(match[1] || match[2]),
    index: match.index || 0,
    raw: match[0],
  })).filter(marker => Number.isInteger(marker.page));
  const malformed = [...source.matchAll(MALFORMED_PAGE_MARKER_RE)].map(match => ({
    index: match.index || 0,
    raw: match[0],
  }));
  return { source, markers, malformed };
}

function tokenFallsInsidePageMarker(value, token) {
  const parsed = parsePageMarkers(value);
  const start = Number(token?.index);
  const end = Number(token?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  return parsed.markers.some(marker => {
    const markerStart = Number(marker.index) || 0;
    const markerEnd = markerStart + String(marker.raw || "").length;
    return start >= markerStart && end <= markerEnd;
  });
}

function claimPageMarkersMalformed(value) {
  return parsePageMarkers(value).malformed.length > 0;
}

function claimPageEvidencePresent(value) {
  const parsed = parsePageMarkers(value);
  return parsed.markers.length > 0 || parsed.malformed.length > 0;
}

function claimPageSegments(value, masker = null) {
  const parsed = parsePageMarkers(value);
  const source = parsed.source;
  const markers = parsed.markers;
  return markers.map((marker, index) => {
    const start = (marker.index || 0) + marker.raw.length;
    const end = index + 1 < markers.length ? (markers[index + 1].index || source.length) : source.length;
    const text = source.slice(start, end);
    return {
      page: marker.page,
      text,
      tokens: extractNumericEvidence(text, masker),
    };
  });
}

function claimAmountTokens(segment) {
  return (segment?.tokens || []).filter(token => !token.rateEvidence && !token.symbol);
}

function claimTokenMeasureCompatible(token, measureKeys) {
  const tokenKeys = [...new Set((token?.measureKeys || []).filter(key => !GENERIC_MEASURE_KEYS.has(key)))];
  return tokenKeys.length > 0 && measureKeys.length > 0
    && tokenKeys.some(key => measureKeys.includes(key));
}

function claimAmountBindingMatches(left, right) {
  if (!left || !right || canonicalNumericKey(left) !== canonicalNumericKey(right)) return false;
  const leftScale = left.scaleExp || left.rowScaleExp || 0;
  const rightScale = right.scaleExp || right.rowScaleExp || 0;
  if (leftScale && rightScale && leftScale !== rightScale) return false;
  const leftCurrency = left.currencyEvidence || left.rowCurrency || "";
  const rightCurrency = right.currencyEvidence || right.rowCurrency || "";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
  const leftKeys = [...new Set((left.measureKeys || []).filter(key => !GENERIC_MEASURE_KEYS.has(key)))];
  const rightKeys = [...new Set((right.measureKeys || []).filter(key => !GENERIC_MEASURE_KEYS.has(key)))];
  if (leftKeys.length && rightKeys.length && !leftKeys.some(key => rightKeys.includes(key))) return false;
  return true;
}

function claimTokenContext(text, token, radius = 96) {
  const source = String(text || "");
  const start = Math.max(0, Number(token?.index) || 0);
  const end = Math.min(source.length, Number(token?.end) || start);
  return source.slice(Math.max(0, start - radius), Math.min(source.length, end + radius));
}

function claimAmountIsContextual(text, token) {
  return /(?:decreas(?:e|ed|ing)|increas(?:e|ed|ing)|change|net\s+(?:increase|decrease)|compared\s+with|prior|previous|前年|前期|増減|減少|増加|変動|比較)/iu
    .test(claimTokenContext(text, token));
}

function claimAmountRoleScore(text, token, roleHint) {
  const context = claimTokenContext(text, token, 48);
  let score = 0;
  if (roleHint === "balance") {
    if (/(?:end(?:ing)?(?:\s+of\s+the\s+period)?|at\s+end|balance|期末(?:残高)?|残高|現在)/iu.test(context)) score += 5;
    if (/(?:to\s+[¥$€£]?|まで|へ)/iu.test(context)) score += 2;
    if (/(?:decreas(?:e|ed|ing)|increas(?:e|ed|ing)|change|net\s+(?:increase|decrease)|増減|減少|増加|変動)/iu.test(context)) score -= 6;
  } else if (roleHint === "cash_flow") {
    if (/(?:cash\s+flow|activities|キャッシュ.?フロー|活動)/iu.test(context)) score += 2;
  }
  if (/(?:prior|previous|前年|前期|compared\s+with)/iu.test(context)) score -= 2;
  return score;
}

function claimPeriodDescriptor(value) {
  const source = String(value || "");
  const fiscalYears = new Set();
  const completeDates = new Set();
  const quarters = new Set();
  for (const match of source.matchAll(/\bFY\s*(\d{2,4})\b/giu)) {
    const year = match[1].length === 2 ? `20${match[1]}` : match[1];
    fiscalYears.add(year);
  }
  for (const match of source.matchAll(/(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/gu)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = match[3] ? Number(match[3]) : null;
    fiscalYears.add(String(month <= 3 ? year : year + 1));
    if (day) {
      completeDates.add(`${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
      quarters.add(String(month >= 4 ? Math.ceil((month - 3) / 3) : 4));
    }
  }
  for (const match of source.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})(?!\d)/giu)) {
    const months = new Map([
      ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
      ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
    ]);
    const month = months.get(match[1].toLowerCase());
    const year = Number(match[3]);
    fiscalYears.add(String(month <= 3 ? year : year + 1));
    completeDates.add(`${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`);
    quarters.add(String(month >= 4 ? Math.ceil((month - 3) / 3) : 4));
  }
  for (const match of source.matchAll(/(?<!\d)(\d{4})\s*年(?!\s*\d{1,2}\s*月)/gu)) fiscalYears.add(match[1]);
  for (const match of source.matchAll(/(?:first|second|third|fourth)\s+(?:quarter|(?:three|six|nine|twelve)\s+months?)/giu)) {
    quarters.add(String({ first: 1, second: 2, third: 3, fourth: 4 }[match[0].split(/\s+/)[0].toLowerCase()]));
  }
  for (const match of source.matchAll(/第\s*([1-4])\s*四半期/gu)) quarters.add(match[1]);
  return { fiscalYears, completeDates, quarters };
}

function fiscalQuarterEndDates(period) {
  if (!period?.quarters?.size || period.fiscalYears?.size !== 1) return [];
  const fiscalYear = Number([...period.fiscalYears][0]);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) return [];
  const quarterEnds = [
    { month: 6, yearOffset: -1 },
    { month: 9, yearOffset: -1 },
    { month: 12, yearOffset: -1 },
    { month: 3, yearOffset: 0 },
  ];
  return [...period.quarters].flatMap(value => {
    const quarter = Number(value);
    const end = quarterEnds[quarter - 1];
    if (!end) return [];
    const year = fiscalYear + end.yearOffset;
    const day = new Date(Date.UTC(year, end.month, 0)).getUTCDate();
    return [`${year}-${String(end.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`];
  });
}

function quarterDateEvidenceCompatible(left, right) {
  const check = (quarterPeriod, datePeriod) => {
    if (!quarterPeriod.quarters.size || !datePeriod.completeDates.size) return true;
    const expectedDates = fiscalQuarterEndDates(quarterPeriod);
    return expectedDates.length > 0
      && [...datePeriod.completeDates].some(date => expectedDates.includes(date));
  };
  return check(left, right) && check(right, left);
}

function claimPeriodsCompatible(leftText, rightText) {
  const left = claimPeriodDescriptor(leftText), right = claimPeriodDescriptor(rightText);
  if (!left.fiscalYears.size || !right.fiscalYears.size
      || ![...left.fiscalYears].some(year => right.fiscalYears.has(year))) return false;
  if (left.completeDates.size && right.completeDates.size
      && ![...left.completeDates].some(date => right.completeDates.has(date))) return false;
  if (left.quarters.size && right.quarters.size
      && ![...left.quarters].some(quarter => right.quarters.has(quarter))) return false;
  return quarterDateEvidenceCompatible(left, right);
}

function periodDescriptorHasEvidence(period) {
  return Boolean(period?.fiscalYears?.size
    || period?.completeDates?.size
    || period?.quarters?.size);
}

function strictClaimPeriodsCompatible(leftText, rightText) {
  const left = claimPeriodDescriptor(leftText), right = claimPeriodDescriptor(rightText);
  if (!periodDescriptorHasEvidence(left) || !periodDescriptorHasEvidence(right)) return false;
  if (left.fiscalYears.size > 1 || right.fiscalYears.size > 1
      || left.completeDates.size > 1 || right.completeDates.size > 1
      || left.quarters.size > 1 || right.quarters.size > 1) return false;
  if (left.fiscalYears.size && right.fiscalYears.size
      && ![...left.fiscalYears].every(year => right.fiscalYears.has(year))) return false;
  if (left.completeDates.size && right.completeDates.size
      && ![...left.completeDates].every(date => right.completeDates.has(date))) return false;
  if (left.quarters.size && right.quarters.size
      && ![...left.quarters].every(quarter => right.quarters.has(quarter))) return false;
  const checkQuarterDate = (quarterPeriod, datePeriod) => {
    if (!quarterPeriod.quarters.size || !datePeriod.completeDates.size) return true;
    const expectedDates = fiscalQuarterEndDates(quarterPeriod);
    return expectedDates.length === 1
      && datePeriod.completeDates.size === 1
      && datePeriod.completeDates.has(expectedDates[0]);
  };
  return checkQuarterDate(left, right) && checkQuarterDate(right, left);
}

function claimCoreScopes(token) {
  return [...new Set((token?.scopeKeys || []).filter(key => key !== "prior"))];
}

function claimScopesCompatible(left, right, trustedSourceContext = false) {
  const leftScopes = claimCoreScopes(left), rightScopes = claimCoreScopes(right);
  // Scope words extracted from a model-authored claim are useful only as a
  // veto.  Matching `consolidated` tokens in the same reason do not prove
  // that the two page amounts belong to the same source scope; that proof
  // must come from a verified counterpart or source-bound context.
  if (leftScopes.length && rightScopes.length
      && (leftScopes.length !== rightScopes.length
        || leftScopes.some(scope => !rightScopes.includes(scope)))) return false;
  return Boolean(trustedSourceContext);
}

function claimSegmentForBinding(segment) {
  const segmentMeasures = explicitMeasureKeysFromText(segment?.text);
  const segmentScopes = clauseScopeKeys(segment?.text, segment?.tokens);
  return {
    ...segment,
    tokens: (segment?.tokens || []).map(token => {
      const measureKeys = token.measureKeys?.length ? token.measureKeys : segmentMeasures;
      return {
        ...token,
        measureKeys,
        measureKey: token.measureKey || (measureKeys.length === 1 ? measureKeys[0] : ""),
        scopeKeys: [...new Set([...(token.scopeKeys || []), ...segmentScopes])],
      };
    }),
  };
}

function completeQuotedClauses(value) {
  const source = String(value || "").normalize("NFKC");
  const clauses = [];
  for (const pattern of [
    /「([^「」]*)」/gu,
    /『([^『』]*)』/gu,
    /“([^“”]*)”/gu,
    /"([^"]*)"/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const clause = normalizeQuote(match[1]);
      if (clause) clauses.push(clause);
    }
  }
  return clauses;
}

function independentSourceClauses(value) {
  const source = String(value || "").normalize("NFKC");
  return source.split(/(?:[。.!?;；]+|\r?\n+)/u)
    .map(clause => normalizeQuote(clause))
    .filter(Boolean);
}

function isGenericSourceFragment(value) {
  const clause = normalizeQuote(value);
  if (!clause) return true;
  if (/^(?:cash|net\s+cash|cash\s+flows?)$/iu.test(clause)) return true;
  const words = clause.match(/\p{L}+/gu) || [];
  return words.length <= 3
    && Boolean(cashFlowKind(clause))
    && !/(?:net|cash|provided|used|inflow|outflow|キャッシュ)/iu.test(clause);
}

// A report-side counterpart quote is not evidence merely because it is
// present in the model payload.  Before numeric filtering, the browser can
// bind it to the extracted text of the claimed same-document page.  Accept a
// quoted label at the start of a source row (the table values may follow the
// label) but reject word-prefix fragments and generic labels.  Repeated
// occurrences remain ambiguous and therefore return zero.
function compactSourceForBinding(value) {
  // PDF text layers may expose a discretionary/soft hyphen where the quoted
  // text has an ordinary word boundary (for example `long­term` vs
  // `long term`).  Remove only that layout artifact and whitespace; ordinary
  // hyphens remain meaningful in source clauses.
  return normalizeQuote(value).replace(/[\s\u00ad]/g, "");
}

function canonicalSourceParts(value) {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  let compact = "";
  const origins = [];
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (/[\s\u00ad]/u.test(char)) continue;
    compact += char;
    origins.push(index);
  }
  return { normalized, compact, origins };
}

function sourceBindingCacheEntry(source, cache) {
  if (!cache || !(cache.sources instanceof Map)) return null;
  const key = String(source || "");
  const existing = cache.sources.get(key);
  if (existing) return existing;
  const maxSources = Number.isInteger(cache.maxSources) ? cache.maxSources : 64;
  while (cache.sources.size >= maxSources) {
    const first = cache.sources.keys().next().value;
    if (first === undefined) break;
    cache.sources.delete(first);
  }
  const entry = {
    parts: canonicalSourceParts(key),
    occurrences: new Map(),
    windows: new Map(),
  };
  cache.sources.set(key, entry);
  return entry;
}

function canonicalSourceQuoteOccurrenceIndexes(source, quote, cache = null) {
  const normalizedQuote = normalizeQuote(quote);
  if (!normalizedQuote || isGenericSourceFragment(normalizedQuote)) return [];
  const compactQuote = compactSourceForBinding(normalizedQuote);
  if (!compactQuote) return [];
  const entry = sourceBindingCacheEntry(source, cache);
  const cacheKey = compactQuote;
  if (entry?.occurrences.has(cacheKey)) return entry.occurrences.get(cacheKey);
  const parts = entry?.parts || canonicalSourceParts(source);
  const compactSource = parts.compact;
  const quoteEndsClause = /[.!?。！？；;:：]$/u.test(normalizedQuote);
  const indexes = [];
  let cursor = 0;
  while (cursor <= compactSource.length) {
    const index = compactSource.indexOf(compactQuote, cursor);
    if (index < 0) break;
    const before = index > 0 ? compactSource[index - 1] : "";
    const end = index + compactQuote.length;
    const after = end < compactSource.length ? compactSource[end] : "";
    // A punctuation-complete sentence may begin immediately after a source
    // row label in PDF text extraction (for example `activities Net cash...`).
    // Unpunctuated labels still require a true word boundary so generic or
    // partial fragments cannot authorize a row.
    const sourceStart = parts.origins[index] ?? 0;
    const lineBoundaryBefore = /(?:\r\n|\r|\n)[\t ]*$/u.test(
      parts.normalized.slice(0, sourceStart),
    );
    const boundedBefore = !before || !/[\p{L}\p{N}]/u.test(before)
      || lineBoundaryBefore || quoteEndsClause;
    const boundedAfter = !after || !/[\p{L}]/u.test(after) || quoteEndsClause;
    if (boundedBefore && boundedAfter) indexes.push(index);
    cursor = index + Math.max(1, compactQuote.length);
  }
  if (entry) entry.occurrences.set(cacheKey, indexes);
  return indexes;
}

function sourceQuoteBindingCount(source, quote, cache = null) {
  return canonicalSourceQuoteOccurrenceIndexes(source, quote, cache).length;
}

// Return the smallest unique source-line window containing a complete quote.
// A whole-page substring is not enough for value binding: a different row on
// the same page may contain the same number.  Keeping the minimal window also
// makes a changed counterpart amount fail closed instead of borrowing a value
// from a neighbouring row.
function sourceQuoteWindows(source, quote, cache = null) {
  const normalizedQuote = normalizeQuote(quote);
  if (!normalizedQuote || isGenericSourceFragment(normalizedQuote)) return [];
  const needle = compactSourceForBinding(normalizedQuote);
  const entry = sourceBindingCacheEntry(source, cache);
  if (entry?.windows.has(needle)) return entry.windows.get(needle);
  if (canonicalSourceQuoteOccurrenceIndexes(source, normalizedQuote, cache).length !== 1) {
    if (entry) entry.windows.set(needle, []);
    return [];
  }
  const lines = String(source || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length || !needle) return [];
  const candidates = [];
  const maxLines = 6;
  for (let start = 0; start < lines.length; start++) {
    for (let end = start; end < Math.min(lines.length, start + maxLines); end++) {
      const windowText = lines.slice(start, end + 1).join(" ");
      if (!compactSourceForBinding(windowText).includes(needle)) continue;
      candidates.push({ start, end, text: windowText });
      // The first matching end for a start is the only useful one.  Larger
      // windows merely add adjacent rows and make identity less precise.
      break;
    }
  }
  if (!candidates.length) {
    if (entry) entry.windows.set(needle, []);
    return [];
  }
  const minimumSpan = Math.min(...candidates.map(candidate => candidate.end - candidate.start));
  const windows = candidates.filter(candidate => candidate.end - candidate.start === minimumSpan);
  if (entry) entry.windows.set(needle, windows);
  return windows;
}

// Period labels on a PDF page are not interchangeable evidence for every
// row on that page.  Bind identity checks to the unique quote window and the
// nearest preceding header/section run only.  A non-header row is skipped
// while looking for that run (needed for a later table row), but once the run
// starts, a non-header line is a hard boundary.  This keeps unrelated notes
// appended or prepended elsewhere from authorizing a row.
function sourceWindowAssociatedContext(source, window) {
  const lines = String(source || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const start = Number(window?.start);
  const end = Number(window?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end >= lines.length) {
    return { text: String(window?.text || ""), ambiguousPeriod: true };
  }
  const isPeriodOrUnitHeader = line => {
    const period = claimPeriodDescriptor(line);
    const numericAmounts = extractNumericEvidence(line)
      .filter(token => !token.rateEvidence && !token.symbol);
    return !numericAmounts.length
      && (periodDescriptorHasEvidence(period) || explicitUnitExponents(line).length > 0);
  };
  const isBracketPeriodOnly = line => /^\s*[([（].*[\])）]\s*$/u.test(line)
    && periodDescriptorHasEvidence(claimPeriodDescriptor(line))
    && explicitUnitExponents(line).length === 0
    && explicitMeasureKeysFromText(line).length === 0
    && !/(?:cash\s+flows?|cashflow|statement|balance\s+sheet|financial\s+results?|cash[・･\s-]*flow|活動|計算書)/iu.test(line);
  const isSectionHeader = line => extractNumericEvidence(line).length === 0
    && !isBracketPeriodOnly(line)
    && /(?:^\s*[([（].*[\])）]\s*$|cash\s+flows?|cashflow|statement|balance\s+sheet|financial\s+results?|cash[・･\s-]*flow|活動|計算書)/iu.test(line);
  const isStrongHeaderBoundary = line => explicitUnitExponents(line).length > 0
    || (/^\s*[([（]/u.test(line) && !isBracketPeriodOnly(line));
  const preceding = [];
  let headerRunStarted = false;
  let skipped = 0;
  let sectionSeen = false;
  let periodBeforeSection = false;
  let periodAfterSection = false;
  let structuralHeaderSeen = false;
  for (let index = start - 1; index >= 0 && skipped < 8; index--) {
    const line = lines[index];
    const periodHeader = isPeriodOrUnitHeader(line);
    const sectionHeader = isSectionHeader(line);
    const header = periodHeader || sectionHeader;
    if (header) {
      // A period-only note immediately before the row is not allowed to
      // replace the real period header that follows its section label.  The
      // normal table shape has one contiguous header run (possibly with
      // several FY/date columns); this two-run shape is the hostile case.
      if (periodHeader) {
        if (sectionSeen) periodAfterSection = true;
        else periodBeforeSection = true;
      }
      if (sectionHeader) sectionSeen = true;
      if (sectionHeader || isStrongHeaderBoundary(line)
          || explicitMeasureKeysFromText(line).length > 0) {
        structuralHeaderSeen = true;
      }
      preceding.unshift(line);
      headerRunStarted = true;
      if (isStrongHeaderBoundary(line)) break;
      continue;
    }
    if (headerRunStarted) break;
    skipped++;
  }
  return {
    text: [...preceding, ...lines.slice(start, end + 1)].join("\n"),
    ambiguousPeriod: periodBeforeSection && periodAfterSection,
    structuralHeaderSeen,
  };
}

function sourceTokensContainClaimAmounts(segment, sourceWindow) {
  const expected = claimAmountTokens(segment);
  const available = extractNumericEvidence(sourceWindow)
    .filter(token => !token.rateEvidence && !token.symbol);
  if (!expected.length || !available.length) return false;
  const used = new Set();
  for (const expectedToken of expected) {
    const matches = available.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => !used.has(index)
        && claimAmountBindingMatches(candidate, expectedToken)
        && candidate.negative === expectedToken.negative);
    // A repeated candidate in the same source row is ambiguous even when its
    // display value happens to be the expected rounded value.
    if (matches.length !== 1) return false;
    used.add(matches[0].index);
  }
  return true;
}

function sourceSegmentIdentityMatches(segment, sourceContext) {
  const segmentText = String(segment?.text || "");
  const sourceText = String(sourceContext || "");
  const expectedMeasures = explicitMeasureKeysFromText(segmentText)
    .filter(key => !GENERIC_MEASURE_KEYS.has(key));
  const sourceMeasures = explicitMeasureKeysFromText(sourceText)
    .filter(key => !GENERIC_MEASURE_KEYS.has(key));
  if (expectedMeasures.length
      && (!sourceMeasures.length || !expectedMeasures.some(key => sourceMeasures.includes(key)))) return false;

  const expectedScales = [...new Set(explicitUnitExponents(segmentText))];
  const sourceScales = [...new Set(explicitUnitExponents(sourceText))];
  if (expectedScales.length && expectedScales.some(scale => !sourceScales.includes(scale))) return false;

  const expectedCurrencies = currencyCodes(segmentText);
  const sourceCurrencies = currencyCodes(sourceText);
  if (expectedCurrencies.length
      && expectedCurrencies.some(currency => !sourceCurrencies.includes(currency))) return false;

  const expectedScopes = claimCoreScopes({
    scopeKeys: clauseScopeKeys(segmentText, segment?.tokens || []),
  });
  const sourceScopes = claimCoreScopes({
    scopeKeys: clauseScopeKeys(sourceText, extractNumericEvidence(sourceText)),
  });
  // Some PDF table pages omit the consolidated/standalone caption even
  // though the surrounding document and the quoted row identify the same
  // statement.  When the extracted source does expose scope words, they must
  // agree; an omitted caption is not itself permission to invent a mismatch.
  if (expectedScopes.length && sourceScopes.length
      && expectedScopes.some(scope => !sourceScopes.includes(scope))) return false;

  const expectedPeriod = claimPeriodDescriptor(segmentText);
  const sourcePeriod = claimPeriodDescriptor(sourceText);
  for (const key of ["fiscalYears", "completeDates", "quarters"]) {
    if ([...expectedPeriod[key]].some(value => !sourcePeriod[key].has(value))) return false;
  }
  return true;
}

function sourceConsolidationScopeEvidence(sourceWindow, sourcePage) {
  const sourceText = `${sourceWindow}\n${sourcePage}`;
  const scopes = clauseScopeKeys(sourceText, extractNumericEvidence(sourceText))
    .filter(scope => scope === "consolidated" || scope === "standalone");
  return new Set(scopes);
}

function sourceScopesCompatible(targetWindow, targetPage, counterpartWindow, counterpartPage) {
  const targetScopes = sourceConsolidationScopeEvidence(targetWindow, targetPage);
  const counterpartScopes = sourceConsolidationScopeEvidence(counterpartWindow, counterpartPage);
  // A page containing both consolidated and standalone evidence is ambiguous;
  // it must not authorize a rounded equivalence even if one peer happens to
  // match.  When each side has one explicit scope, they must agree.
  if (targetScopes.size > 1 || counterpartScopes.size > 1) return false;
  if (!targetScopes.size || !counterpartScopes.size) return true;
  return [...targetScopes][0] === [...counterpartScopes][0];
}

function sourceSegmentBindingMatches(segment, source, quote, cache = null) {
  const windows = sourceQuoteWindows(source, quote, cache);
  if (windows.length !== 1) return false;
  const window = windows[0].text;
  if (!sourceTokensContainClaimAmounts(segment, window)) return false;
  const sourceContext = sourceWindowAssociatedContext(source, windows[0]);
  if (!sourceContext || sourceContext.ambiguousPeriod
      || sourceContext.structuralHeaderSeen !== true) return false;
  return sourceSegmentIdentityMatches(segment, sourceContext.text);
}

function sourcePageClaimAmountsMatch(finding, fields, targetSource, counterpartSource,
  findingPage, counterpartPage, counterpartQuote, cache = null) {
  const targetQuote = String(finding?.quote || "");
  if (!targetQuote || !counterpartQuote) return false;
  if (sourceQuoteBindingCount(targetSource, targetQuote, cache) !== 1
      || sourceQuoteBindingCount(counterpartSource, counterpartQuote, cache) !== 1) return false;
  const targetWindows = sourceQuoteWindows(targetSource, targetQuote, cache);
  const counterpartWindows = sourceQuoteWindows(counterpartSource, counterpartQuote, cache);
  if (targetWindows.length !== 1 || counterpartWindows.length !== 1) return false;
  const targetWindow = targetWindows[0].text;
  const counterpartWindow = counterpartWindows[0].text;
  if (!sourceScopesCompatible(targetWindow, targetSource, counterpartWindow, counterpartSource)) return false;
  let checkedNumericField = false;
  for (const field of fields) {
    const text = String(field || "");
    const segments = claimPageSegments(text).map(claimSegmentForBinding);
    if (!segments.length) continue;
    const targetSegment = segments.find(segment => segment.page === findingPage);
    const counterpartSegment = segments.find(segment => segment.page === counterpartPage);
    if (!targetSegment || !counterpartSegment) return false;
    const targetAmounts = claimAmountTokens(targetSegment);
    const counterpartAmounts = claimAmountTokens(counterpartSegment);
    if (!targetAmounts.length && !counterpartAmounts.length) continue;
    checkedNumericField = true;
    if (targetAmounts.length
        && !sourceSegmentBindingMatches(targetSegment, targetSource, targetQuote, cache)) return false;
    if (counterpartAmounts.length
        && !sourceSegmentBindingMatches(counterpartSegment, counterpartSource, counterpartQuote, cache)) return false;
  }
  return checkedNumericField;
}

function pageTextAt(pageTexts, page) {
  if (pageTexts instanceof Map) return String(pageTexts.get(page) || "");
  if (typeof pageTexts === "function") return String(pageTexts(page) || "");
  return String(pageTexts?.[page] || "");
}

/**
 * Validate model-declared same-document counterpart evidence against the
 * extracted source text.  This intentionally returns no record for malformed,
 * duplicate, or multi-page claims.  It is a source-bound pre-filter helper;
 * counterpart/status fields supplied by a model are never accepted here.
 */
export function validateSameDocumentCounterpartContext(finding, pageTexts, options = {}) {
  const f = finding || {};
  const findingPage = Number(f.page);
  if (!Number.isInteger(findingPage)) return { counterparts: [], context: {} };
  const fields = [f.reason, f.model_reason, f.issueSummary, f.issue_summary, f.suggestion]
    .map(value => String(value || ""))
    .filter(Boolean);
  const parsedFields = fields.map(value => parsePageMarkers(value));
  const markedFields = parsedFields.filter(parsed => parsed.markers.length || parsed.malformed.length);
  if (!markedFields.length || markedFields.some(parsed => parsed.malformed.length)) {
    return { counterparts: [], context: {} };
  }
  const pageSets = markedFields.map(parsed => {
    const pages = parsed.markers.map(marker => marker.page);
    return { pages, unique: [...new Set(pages)] };
  });
  const sourceCache = options?.sourceCache || null;
  const endpointSets = pageSets.filter(set => set.pages.length === 2
    && set.unique.length === 2 && set.unique.includes(findingPage));
  const sameEndpointPages = endpointSets.length
    ? endpointSets[0].unique.slice().sort((a, b) => a - b)
    : [];
  const ignoredMetadataOnly = markedFields.every((parsed, index) => {
    const set = pageSets[index];
    if (set.pages.length === 2 && set.unique.length === 2 && set.unique.includes(findingPage)) return true;
    return parsed.malformed.length === 0 && parsed.markers.length === 1
      && extractNumericEvidence(parsed.source).length === 0
      && completeQuotedClauses(parsed.source).length === 0;
  });
  if (endpointSets.length && ignoredMetadataOnly
      && sameEndpointPages.length === 2) {
    const counterpartPage = sameEndpointPages.find(page => page !== findingPage);
    const targetSource = pageTextAt(pageTexts, findingPage);
    const source = pageTextAt(pageTexts, counterpartPage);
    const fallback = targetSource && source
      ? sameDocumentNumericSourceFallback(f, targetSource, source, counterpartPage, sourceCache)
      : null;
    if (fallback) return fallback;
  }
  // Every page-labelled canonical/suggestion field must name exactly the same
  // two distinct endpoints.  This keeps a third or duplicate marker from
  // authorizing a later field through an otherwise valid peer.
  if (pageSets.some(set => set.pages.length !== 2 || set.unique.length !== 2
    || !set.unique.includes(findingPage))) {
    return { counterparts: [], context: {} };
  }
  const expectedPages = pageSets[0].unique.slice().sort((a, b) => a - b);
  if (pageSets.some(set => set.unique.slice().sort((a, b) => a - b).join(",")
    !== expectedPages.join(","))) {
    return { counterparts: [], context: {} };
  }
  const counterpartPages = expectedPages.filter(page => page !== findingPage);
  if (counterpartPages.length !== 1) return { counterparts: [], context: {} };
  const counterpartPage = counterpartPages[0];
  const targetSource = pageTextAt(pageTexts, findingPage);
  const source = pageTextAt(pageTexts, counterpartPage);
  if (!targetSource || !source) return { counterparts: [], context: {} };
  const quotes = [...new Set(fields.flatMap(value => completeQuotedClauses(value)))];
  const matches = quotes.filter(quote => sourceQuoteBindingCount(source, quote, sourceCache) === 1);
  if (matches.length !== 1) {
    return sameDocumentNumericSourceFallback(f, targetSource, source, counterpartPage, sourceCache)
      || { counterparts: [], context: {} };
  }
  const quote = matches[0];
  // Bind the finding-side quote and every numeric page-labelled canonical
  // field to the extracted rows as well as the counterpart quote.  A
  // status-ok/page match supplied by a model is not enough: a changed source
  // amount, missing target quote, or ambiguous row must leave the finding in
  // the review set.
  if (!sourcePageClaimAmountsMatch(
    f,
    [f.reason, f.model_reason, f.issueSummary, f.issue_summary]
      .map(value => String(value || ""))
      .filter(Boolean),
    targetSource,
    source,
    findingPage,
    counterpartPage,
    quote,
    sourceCache,
  )) {
    return sameDocumentNumericSourceFallback(f, targetSource, source, counterpartPage, sourceCache)
      || { counterparts: [], context: {} };
  }
  const targetMatch = findUniqueNumericSourceContext(targetSource, String(f.quote || ""), { sourceCache });
  const referenceMatch = findUniqueNumericSourceContext(source, quote, { sourceCache });
  const rowContext = targetMatch?.unique && referenceMatch?.unique ? {
    targetRowText: targetMatch.rowText,
    targetRowLines: targetMatch.rowLines || [],
    referenceRowText: referenceMatch.rowText,
    referenceRowLines: referenceMatch.rowLines || [],
    targetRowUnique: true,
    referenceRowUnique: true,
  } : {};
  return {
    counterparts: [{ page: counterpartPage, quote, status: "ok" }],
    context: {
      sameDocumentSourceValidated: true,
      targetText: targetSource,
      targetQuote: String(f.quote || ""),
      referenceText: source,
      referenceQuote: quote,
      referencePage: counterpartPage,
      ...rowContext,
    },
  };
}

// A same-PDF consistency finding often quotes a narrative sentence on the
// current page while its model-authored page claim quotes the authoritative
// table row on the other page.  The display-only validator above deliberately
// rejects that shape when one of the sentence's contextual numbers is not in
// the quoted table row.  For numeric suppression we need a stricter, but
// source-bound, fallback: bind both complete quotes to unique source rows and
// require every numeric page claim to be a signed subset of its corresponding
// row.  This keeps the model's page prose out of the authorization path while
// allowing a narrative's prior-period amount to remain contextual.
function sourceClaimAmountsSubset(segment, rowText) {
  const expected = claimAmountTokens(segment);
  if (!expected.length) return true;
  const available = extractNumericEvidence(rowText)
    .filter(token => !token.rateEvidence && !token.symbol);
  const used = new Set();
  for (const expectedToken of expected) {
    const matches = available
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => !used.has(index)
        && canonicalNumericKey(candidate) === canonicalNumericKey(expectedToken)
        && candidate.negative === expectedToken.negative);
    if (matches.length !== 1) return false;
    const sourceMeasures = sourceRowMeasureKeys(rowText);
    const claimMeasures = [...new Set((expectedToken.measureKeys || [])
      .filter(key => !GENERIC_MEASURE_KEYS.has(key)))];
    if (sourceMeasures.length && claimMeasures.length
        && !claimMeasures.some(key => sourceMeasures.includes(key))) return false;
    used.add(matches[0].index);
  }
  return true;
}

function sameDocumentNumericClaimsSourceBound(finding, targetMatch, referenceMatch,
  findingPage, counterpartPage) {
  const fields = [finding?.reason, finding?.model_reason, finding?.issueSummary,
    finding?.issue_summary, finding?.suggestion]
    .map(value => String(value || ""))
    .filter(Boolean);
  let checked = false;
  const sourceBoundSegment = segment => {
    const clauses = completeQuotedClauses(segment?.text || "");
    if (!clauses.length) return segment;
    return {
      ...segment,
      tokens: clauses.flatMap(clause => extractNumericEvidence(clause)),
    };
  };
  for (const field of fields) {
    const segments = claimPageSegments(field).map(claimSegmentForBinding);
    if (!segments.length) continue;
    // A summary may mention only the counterpart page (for example `P.8と
    // 不一致`) without contributing numeric or quoted evidence.  It is
    // metadata, not an authorization source; the paired canonical fields and
    // unique source rows still have to prove every amount.
    if (segments.length !== 2
        && claimAmountTokens(segments[0]).length === 0
        && completeQuotedClauses(field).length === 0) continue;
    const targetSegment = segments.find(segment => segment.page === findingPage);
    const referenceSegment = segments.find(segment => segment.page === counterpartPage);
    if (!targetSegment || !referenceSegment) return false;
    if (claimAmountTokens(targetSegment).length || claimAmountTokens(referenceSegment).length) {
      checked = true;
      if (!sourceClaimAmountsSubset(sourceBoundSegment(targetSegment), targetMatch.rowText)
          || !sourceClaimAmountsSubset(sourceBoundSegment(referenceSegment), referenceMatch.rowText)) return false;
    }
  }
  return checked;
}

function sameDocumentNumericSourceFallback(finding, targetSource, counterpartSource,
  counterpartPage, sourceCache = null) {
  const targetQuote = String(finding?.quote || "").trim();
  if (!targetQuote || !targetSource || !counterpartSource) return null;
  const targetMatch = findUniqueNumericSourceContext(targetSource, targetQuote, { sourceCache });
  if (!targetMatch?.unique) return null;
  const fields = [finding?.reason, finding?.model_reason, finding?.issueSummary,
    finding?.issue_summary, finding?.suggestion]
    .map(value => String(value || ""))
    .filter(Boolean);
  const quotes = [...new Set(fields.flatMap(value => completeQuotedClauses(value)))]
    .filter(quote => findUniqueNumericSourceContext(counterpartSource, quote, { sourceCache })?.unique);
  if (quotes.length !== 1) return null;
  const referenceQuote = quotes[0];
  const referenceMatch = findUniqueNumericSourceContext(counterpartSource, referenceQuote, { sourceCache });
  if (!targetMatch?.unique || !referenceMatch?.unique) return null;
  const fbClaims = sameDocumentNumericClaimsSourceBound(
    finding,
    targetMatch,
    referenceMatch,
    Number(finding?.page),
    counterpartPage,
  );
  if (!fbClaims) return null;
  return {
    counterparts: [{ page: counterpartPage, quote: referenceQuote, status: "ok" }],
    context: {
      sameDocumentSourceValidated: true,
      targetText: targetSource,
      targetQuote,
      targetRowText: targetMatch.rowText,
      targetRowLines: targetMatch.rowLines || [],
      referenceText: counterpartSource,
      referenceQuote,
      referenceRowText: referenceMatch.rowText,
      referenceRowLines: referenceMatch.rowLines || [],
      referencePage: counterpartPage,
      targetRowUnique: true,
      referenceRowUnique: true,
    },
  };
}

/**
 * Resolve display-only highlights for another page in the same target PDF.
 *
 * This is deliberately separate from validateSameDocumentCounterpartContext:
 * a uniquely source-bound phrase is sufficient to help a person navigate, but
 * it must never authorize numeric contradiction filtering. The current-page
 * quote and every returned phrase must bind to the extracted PDF text, and the
 * model-authored prose must identify exactly one other page.
 */
export function resolveSameDocumentNavigationCounterpart(finding, pageTexts, options = {}) {
  const f = finding || {};
  const findingPage = Number(f.page);
  if (!Number.isInteger(findingPage)) return { counterparts: [], context: {} };
  const fields = [f.reason, f.model_reason, f.issueSummary, f.issue_summary, f.suggestion]
    .map(value => String(value || ""))
    .filter(Boolean);
  const parsedFields = fields.map(value => parsePageMarkers(value));
  if (parsedFields.some(parsed => parsed.malformed.length)) return { counterparts: [], context: {} };
  const mentionedPages = [...new Set(parsedFields
    .flatMap(parsed => parsed.markers.map(marker => Number(marker.page)))
    .filter(page => Number.isInteger(page) && page !== findingPage))];
  if (mentionedPages.length !== 1) return { counterparts: [], context: {} };
  const counterpartPage = mentionedPages[0];
  const targetSource = pageTextAt(pageTexts, findingPage);
  const counterpartSource = pageTextAt(pageTexts, counterpartPage);
  const targetQuote = String(f.quote || "").trim();
  const sourceCache = options?.sourceCache || null;
  if (!targetSource || !counterpartSource || !targetQuote
      || sourceQuoteBindingCount(targetSource, targetQuote, sourceCache) !== 1) {
    return { counterparts: [], context: {} };
  }
  const quotes = [...new Set(fields.flatMap(value => completeQuotedClauses(value)))]
    .filter(quote => !isGenericSourceFragment(quote)
      && sourceQuoteBindingCount(counterpartSource, quote, sourceCache) === 1
      && sourceQuoteBindingCount(targetSource, quote, sourceCache) === 0)
    .slice(0, 6);
  if (!quotes.length) return { counterparts: [], context: {} };
  return {
    counterparts: [{ page: counterpartPage, quote: quotes[0], quotes, status: "ok" }],
    context: {
      displayNavigationSourceValidated: true,
      targetText: targetSource,
      targetQuote,
      referenceText: counterpartSource,
      referenceQuotes: quotes,
      referencePage: counterpartPage,
    },
  };
}

function counterpartRecords(finding) {
  const records = [];
  if (Array.isArray(finding?.counterparts)) records.push(...finding.counterparts);
  if (Array.isArray(finding?.counterParts)) records.push(...finding.counterParts);
  return records;
}

function trustedCounterpartSourceContext(finding, counterpartSegment) {
  const counterparts = counterpartRecords(finding);
  const segmentText = normalizeQuote(counterpartSegment?.text);
  if (!segmentText) return false;
  const pageRecords = counterparts.filter(counterpart =>
    Number(counterpart?.page) === Number(counterpartSegment?.page));
  // Count every status at the expected page.  A verified record paired with
  // a pending/error duplicate (or a second conflicting quote) is ambiguous;
  // exactly one record must exist and it must be verified.
  if (pageRecords.length !== 1
      || String(pageRecords[0]?.status || "").toLowerCase() !== "ok") return false;
  const quote = normalizeQuote(pageRecords[0]?.quote || pageRecords[0]?.text);
  if (!quote) return false;
  // Bind the record to one complete quoted/independent clause.  Substrings
  // such as `financing activities` and repeated occurrences are not proof.
  return canonicalSourceQuoteOccurrenceIndexes(segmentText, quote).length === 1;
}

function sourceBoundScopeContext(context, finding) {
  if (!context?.targetRowUnique || !context?.referenceRowUnique) return false;
  if (!sourceContextIdentityCompatible(context, finding)) return false;
  const sourceSideScopes = side => {
    const row = String(context?.[`${side}RowText`] || context?.[`${side}_row_text`] || "");
    const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "");
    const scopeKeys = clauseScopeKeys(
      `${row}\n${text}`,
      extractNumericEvidence(`${row}\n${text}`),
    );
    return claimCoreScopes({ scopeKeys });
  };
  const targetScopes = sourceSideScopes("target");
  const referenceScopes = sourceSideScopes("reference");
  return targetScopes.length > 0
    && targetScopes.length === referenceScopes.length
    && targetScopes.every(scope => referenceScopes.includes(scope));
}

// These anchors are trusted only when they came from the same-document
// validator. Raw finding/counterpart quotes are model payload and must not
// become an authorization path merely because they look like a source row.
// The validator binds the current finding quote and the single verified
// counterpart record into this context, so require those values to remain
// unchanged before using them as contradiction anchors.
function validatedSameDocumentSourceAnchors(finding, context) {
  if (context?.sameDocumentSourceValidated !== true) return [];
  const targetText = String(context?.targetText || "");
  const referenceText = String(context?.referenceText || "");
  const targetQuote = String(context?.targetQuote || "");
  const referenceQuote = String(context?.referenceQuote || "");
  const referencePage = Number(context?.referencePage);
  if (!targetText || !referenceText || !targetQuote || !referenceQuote
      || !Number.isInteger(referencePage)
      || normalizeQuote(finding?.quote) !== normalizeQuote(targetQuote)) return [];
  const records = counterpartRecords(finding);
  if (records.length !== 1) return [];
  const record = records[0];
  if (Number(record?.page) !== referencePage
      || String(record?.status || "").toLowerCase() !== "ok"
      || normalizeQuote(record?.quote || record?.text) !== normalizeQuote(referenceQuote)) return [];
  return [targetQuote, referenceQuote];
}

function sourceBoundSegmentMatches(segment, rowText, quoteText, options = {}) {
  const segmentAmounts = claimAmountTokens(segment);
  const sourceAmounts = extractNumericEvidence(rowText || quoteText)
    .filter(token => !token.rateEvidence && !token.symbol);
  if (sourceAmounts.length || segmentAmounts.length) {
    if (!sourceAmounts.length || sourceAmounts.length !== segmentAmounts.length) return false;
    return sourceAmounts.every((sourceToken, index) => {
      const segmentToken = segmentAmounts[index];
      if (options.ignoreSign !== true && sourceToken.negative !== segmentToken.negative) return false;
      const comparableSource = options.ignoreSign === true
        ? { ...sourceToken, negative: false }
        : sourceToken;
      const comparableSegment = options.ignoreSign === true
        ? { ...segmentToken, negative: false }
        : segmentToken;
      if (!claimAmountBindingMatches(comparableSource, comparableSegment)) return false;
      const sourceMeasures = sourceToken.measureKeys || [];
      const segmentMeasures = segmentToken.measureKeys || [];
      if (options.requireMeasure === true && sourceMeasures.length && !segmentMeasures.length) return false;
      return !sourceMeasures.length || !segmentMeasures.length
        || sourceMeasures.some(key => segmentMeasures.includes(key));
    });
  }
  const expected = normalizeQuote(quoteText || rowText);
  if (!expected) return false;
  return completeQuotedClauses(segment.text).includes(expected)
    || independentSourceClauses(segment.text).includes(expected);
}

function sourceBoundPageClaimContext(auxiliaryText, finding, context, binding) {
  if (!binding || !sourceBoundScopeContext(context, finding)) return false;
  const targetRow = String(context?.targetRowText || context?.target_row_text || "");
  const referenceRow = String(context?.referenceRowText || context?.reference_row_text || "");
  const targetQuote = String(context?.targetQuote || context?.target_quote || finding?.quote || "");
  const referenceQuote = String(context?.referenceQuote || context?.reference_quote
    || finding?.referenceQuote || finding?.reference_quote || "");
  const requireSigns = completeQuotedClauses(auxiliaryText).length > 0;
  const options = { ignoreSign: !requireSigns, requireMeasure: requireSigns };
  return sourceBoundSegmentMatches(binding.targetSegment, targetRow, targetQuote, options)
    && sourceBoundSegmentMatches(binding.counterpartSegment, referenceRow, referenceQuote, options);
}

function strictPageClaimSegments(value, finding, masker = null) {
  if (claimPageMarkersMalformed(value)) return null;
  const segments = claimPageSegments(value, masker).map(claimSegmentForBinding);
  const findingPage = Number(finding?.page);
  if (segments.length !== 2 || !Number.isInteger(findingPage)) return null;
  const targetSegments = segments.filter(segment => segment.page === findingPage);
  const counterpartSegments = segments.filter(segment => segment.page !== findingPage);
  if (targetSegments.length !== 1 || counterpartSegments.length !== 1) return null;

  const counterparts = counterpartRecords(finding);
  const counterpartPageRecords = counterparts.filter(counterpart =>
    Number(counterpart?.page) === counterpartSegments[0].page);
  if (counterpartPageRecords.length > 1
      || (counterpartPageRecords.length === 1
        && String(counterpartPageRecords[0]?.status || "").toLowerCase() !== "ok")) return null;
  const verified = counterparts.filter(counterpart =>
    String(counterpart?.status || "").toLowerCase() === "ok");
  // A page-bound claim has one expected counterpart page.  Multiple verified
  // records (or one for a different page) leave the source selection
  // ambiguous, even when one record happens to carry a compatible quote.
  if (verified.length > 1
      || (verified.length === 1
        && Number(verified[0]?.page) !== counterpartSegments[0].page)) return null;
  return {
    targetSegment: targetSegments[0],
    counterpartSegment: counterpartSegments[0],
  };
}

function pageClaimSourceAuthorization(auxiliaryText, finding, context = {}) {
  const sourceBoundForText = text => {
    const binding = strictPageClaimSegments(text, finding, contextMasker(context));
    if (!binding) return false;
    // A verified counterpart must bind both the page and the actual quoted
    // clause.  Page/status alone is insufficient: an unrelated quote on the
    // right page must not authorize a page-bound rounding drop.
    return trustedCounterpartSourceContext(finding, binding.counterpartSegment);
  };
  const direct = sourceBoundForText(auxiliaryText);
  const explicitQuotes = completeQuotedClauses(auxiliaryText);
  const binding = strictPageClaimSegments(auxiliaryText, finding, contextMasker(context));
  const source = sourceBoundPageClaimContext(auxiliaryText, finding, context, binding);
  if (direct || source) return true;

  if (context?.allowSuggestionInheritance !== true) return false;
  // Suggestions without a quote may inherit the canonical source binding;
  // once they introduce a quoted clause, that clause must be directly bound.
  if (explicitQuotes.length) return false;

  // A terse suggestion may repeat only the two endpoints and omit the quoted
  // counterpart clause. It can inherit authorization only when the same
  // finding has a canonical page-labelled field whose counterpart quote is
  // exactly verified; an unrelated status-ok quote still fails closed.
  const canonicalFields = [finding?.reason, finding?.model_reason,
    finding?.issueSummary, finding?.issue_summary];
  const current = normalizeQuote(auxiliaryText);
  const inherited = canonicalFields.some(field => {
    const candidate = String(field || "");
    return normalizeQuote(candidate) !== current && sourceBoundForText(candidate);
  });
  return inherited;
}

function pageClaimAuxiliaryPreflight(primaryText, primary, finding, masker = null, context = {}) {
  // Report processing marks a page-bound claim with the counterpart array.
  // Older page-number prose without that metadata belongs to independent
  // legacy proofs and must not be reclassified as a page-bound claim here.
  const hasCounterpartMetadata = Array.isArray(finding?.counterparts)
    || Array.isArray(finding?.counterParts)
    || sourceBoundScopeContext(context, finding);
  if (!hasCounterpartMetadata) return true;
  const canonicalFields = [
    [finding?.reason, false],
    [finding?.model_reason, false],
    [finding?.issueSummary, false],
    [finding?.issue_summary, false],
  ];
  let canonicalPageFieldPassed = false;
  const canonicalBindings = [];
  for (const [field] of canonicalFields) {
    const text = canonicalClaimText(field);
    if (claimPageMarkersMalformed(text)) return false;
    const segments = claimPageSegments(text, masker);
    if (!segments.length) {
      if (claimPageEvidencePresent(text)) return false;
      continue;
    }
    const binding = strictPageClaimSegments(text, finding, masker);
    if (!binding) return false;
    if (!pageClaimSourceAuthorization(text, finding, context)) return false;
    if (!strictClaimPeriodsCompatible(
      binding.targetSegment.text,
      binding.counterpartSegment.text,
    )) return false;
    canonicalPageFieldPassed = true;
    canonicalBindings.push(binding);
  }

    const suggestion = String(finding?.suggestion || "");
    if (claimPageMarkersMalformed(suggestion)) return false;
    const suggestionSegments = claimPageSegments(suggestion, masker);
    if (suggestionSegments.length || claimPageEvidencePresent(suggestion)) {
      if (!suggestionSegments.length) return false;
    // Suggestions can omit the period only after an independently authorized
    // canonical field has established the two endpoints.  A page-labelled
    // suggestion that adds one-sided or conflicting period text is ambiguous.
    if (!canonicalPageFieldPassed) return false;
    const binding = strictPageClaimSegments(suggestion, finding, masker);
    if (!binding) return false;
    const suggestionContext = { ...context, allowSuggestionInheritance: true };
    if (!pageClaimSourceAuthorization(suggestion, finding, suggestionContext)) return false;
    const targetPeriod = claimPeriodDescriptor(binding.targetSegment.text);
    const counterpartPeriod = claimPeriodDescriptor(binding.counterpartSegment.text);
    if (targetPeriod.fiscalYears.size > 1 || counterpartPeriod.fiscalYears.size > 1
        || targetPeriod.completeDates.size > 1 || counterpartPeriod.completeDates.size > 1
        || targetPeriod.quarters.size > 1 || counterpartPeriod.quarters.size > 1) return false;
    const targetHasPeriod = periodDescriptorHasEvidence(targetPeriod);
    const counterpartHasPeriod = periodDescriptorHasEvidence(counterpartPeriod);
    // A terse suggestion can state one shared date only once across the two
    // page labels; canonical fields already supplied the positive period
    // proof.  When both endpoints carry period evidence, require the strict
    // compatibility proof below so an explicit mismatch cannot hide here.
    if (targetHasPeriod && counterpartHasPeriod && !strictClaimPeriodsCompatible(
      binding.targetSegment.text,
      binding.counterpartSegment.text,
    )) return false;
    // A suggestion that supplies only one endpoint's period still has to agree
    // with the independently authorized canonical page claim.  This preserves
    // the attached terse F0003 suggestion while rejecting a lone wrong date or
    // fiscal year that could otherwise inherit the canonical source binding.
    for (const suggestionSegment of [binding.targetSegment, binding.counterpartSegment]) {
      const period = claimPeriodDescriptor(suggestionSegment.text);
      if (!periodDescriptorHasEvidence(period)) continue;
      const canonicalSegment = canonicalBindings
        .map(candidate => [candidate.targetSegment, candidate.counterpartSegment]
          .find(segment => segment.page === suggestionSegment.page))
        .find(Boolean);
      if (!canonicalSegment) return false;
      const canonicalPeriod = claimPeriodDescriptor(canonicalSegment.text);
      for (const key of ["fiscalYears", "completeDates", "quarters"]) {
        const values = period[key];
        if (values.size && [...values].some(value => !canonicalPeriod[key].has(value))) return false;
      }
    }
  }
  return true;
}

function pageClaimHasPrimaryBinding(primaryText, primary, auxiliaryText, finding, masker = null) {
  const segments = claimPageSegments(auxiliaryText, masker).map(claimSegmentForBinding);
  const findingPage = Number(finding?.page);
  if (segments.length !== 2 || !Number.isInteger(findingPage)) return false;
  const targetSegment = segments.find(segment => segment.page === findingPage);
  if (!targetSegment || segments.filter(segment => segment.page !== findingPage).length !== 1) return false;
  const measureKeys = explicitMeasureKeysFromText(primaryText);
  const primaryAmounts = (primary || []).filter(token => !token.rateEvidence && !token.symbol);
  if (!measureKeys.length || !primaryAmounts.length) return false;
  return claimAmountTokens(targetSegment).filter(candidate =>
    primaryAmounts.some(token => claimAmountBindingMatches(token, candidate))).length === 1;
}

function claimPagePeriodScopeCompatible(primaryText, primary, auxiliaryText, finding, masker = null, context = {}) {
  const segments = claimPageSegments(auxiliaryText, masker).map(claimSegmentForBinding);
  const findingPage = Number(finding?.page);
  if (segments.length !== 2 || !Number.isInteger(findingPage)) return null;
  const targetSegment = segments.find(segment => segment.page === findingPage);
  const counterpartSegments = segments.filter(segment => segment.page !== findingPage);
  if (!targetSegment || counterpartSegments.length !== 1) {
    return false;
  }
  const counterpartSegment = counterpartSegments[0];
  const targetPeriod = claimPeriodDescriptor(targetSegment.text);
  const counterpartPeriod = claimPeriodDescriptor(counterpartSegment.text);
  if (!targetPeriod.fiscalYears.size && !counterpartPeriod.fiscalYears.size) return null;
  // Legacy cash-flow reasons sometimes label only one page with a fiscal
  // date, while the other page supplies the same row without a date.  That
  // omission is not evidence of a mismatch; leave the older proof available.
  // Once both page clauses identify a period, however, every explicit date
  // and quarter-end relationship must pass the strict comparison.
  if (targetPeriod.fiscalYears.size && counterpartPeriod.fiscalYears.size
      && !claimPeriodsCompatible(targetSegment.text, counterpartSegment.text)) {
    return false;
  }
  if ((targetPeriod.fiscalYears.size && !counterpartPeriod.fiscalYears.size)
      || (!targetPeriod.fiscalYears.size && counterpartPeriod.fiscalYears.size)) return null;
  const measureKeys = explicitMeasureKeysFromText(primaryText);
  if (!measureKeys.length) return false;
  const roleHint = claimRoleHint(primaryText, measureKeys);
  const primaryAmounts = (primary || []).filter(token => !token.rateEvidence && !token.symbol);
  const preferredMatches = claimAmountTokens(targetSegment).filter(candidate =>
    primaryAmounts.some(token => claimAmountBindingMatches(token, candidate)));
  const selectedTarget = preferredMatches.length === 1
    ? preferredMatches[0]
    : preferredMatches.length === 0 && !primaryAmounts.length
      ? selectClaimPageAmount(targetSegment, measureKeys, null, roleHint)
      : null;
  const selectedCounterpart = selectClaimPageAmount(counterpartSegment, measureKeys, null, roleHint);
  if (!selectedTarget || !selectedCounterpart) return null;
  const compatible = claimScopesCompatible(
    selectedTarget,
    selectedCounterpart,
    pageClaimSourceAuthorization(auxiliaryText, finding, context),
  );
  return compatible;
}

function claimRoleHint(primaryText, measureKeys) {
  if (measureKeys.includes("cash_balance")
      || /(?:end(?:ing)?\s+cash|cash\s+and\s+cash\s+equivalents?.{0,30}(?:end|as\s+of|balance)|期末残高|現金及び現金同等物)/iu.test(String(primaryText || ""))) return "balance";
  if (cashFlowKind(primaryText)) return "cash_flow";
  return "";
}

function selectClaimPageAmount(segment, measureKeys, preferredToken = null, roleHint = "") {
  const all = claimAmountTokens(segment);
  const compatible = all.filter(token => claimTokenMeasureCompatible(token, measureKeys));
  if (!compatible.length || all.some(token => !compatible.includes(token) && !claimAmountIsContextual(segment.text, token))) return null;
  if (preferredToken) {
    const matches = compatible.filter(token => claimAmountBindingMatches(preferredToken, token));
    if (matches.length !== 1) return null;
    if (compatible.some(token => token !== matches[0] && !claimAmountIsContextual(segment.text, token))) return null;
    return matches[0];
  }
  const scored = compatible.map(token => ({ token, score: claimAmountRoleScore(segment.text, token, roleHint) }));
  const max = Math.max(...scored.map(item => item.score));
  const winners = scored.filter(item => item.score === max);
  if (winners.length !== 1 || (compatible.length > 1 && max <= 0)) return null;
  if (compatible.some(token => token !== winners[0].token && !claimAmountIsContextual(segment.text, token))) return null;
  return winners[0].token;
}

function pageBoundRoundingEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, masker = null, context = {}) {
  if (claimPagePeriodScopeCompatible(primaryText, primary, auxiliaryText, finding, masker, context) === false) return false;
  const segments = claimPageSegments(auxiliaryText, masker).map(claimSegmentForBinding);
  const findingPage = Number(finding?.page);
  if (!Number.isInteger(findingPage) || segments.length !== 2) return false;
  const targetSegment = segments.find(segment => segment.page === findingPage);
  const counterpartSegments = segments.filter(segment => segment.page !== findingPage);
  if (!targetSegment || counterpartSegments.length !== 1) return false;
  const counterpartSegment = counterpartSegments[0];
  const measureKeys = explicitMeasureKeysFromText(primaryText);
  if (!measureKeys.length) return false;
  const roleHint = claimRoleHint(primaryText, measureKeys);
  const primaryAmounts = (primary || []).filter(token => !token.rateEvidence && !token.symbol);
  const preferredMatches = claimAmountTokens(targetSegment).filter(candidate =>
    primaryAmounts.some(token => claimAmountBindingMatches(token, candidate)));
  const selectedTarget = preferredMatches.length === 1
    ? preferredMatches[0]
    : preferredMatches.length === 0 && !primaryAmounts.length
      ? selectClaimPageAmount(targetSegment, measureKeys, null, roleHint)
      : null;
  if (!selectedTarget || !claimTokenMeasureCompatible(selectedTarget, measureKeys)) return false;
  const selectedPrimary = primaryAmounts.find(token => claimAmountBindingMatches(token, selectedTarget)) || selectedTarget;
  const selectedCounterpart = selectClaimPageAmount(counterpartSegment, measureKeys, null, roleHint);
  if (!selectedCounterpart || !claimPeriodsCompatible(targetSegment.text, counterpartSegment.text)) return false;

  const targetKind = cashFlowKind(primaryText) || cashFlowKind(targetSegment.text);
  const counterpartKind = cashFlowKind(counterpartSegment.text);
  if (targetKind || counterpartKind) {
    if (!targetKind || targetKind !== counterpartKind) return false;
  }
  if (!claimScopesCompatible(
    selectedTarget,
    selectedCounterpart,
    pageClaimSourceAuthorization(auxiliaryText, finding, context),
  )) {
    return false;
  }
  const targetCurrency = selectedTarget.currencyEvidence || selectedTarget.rowCurrency || "";
  const counterpartCurrency = selectedCounterpart.currencyEvidence || selectedCounterpart.rowCurrency || "";
  if (!targetCurrency || !counterpartCurrency || targetCurrency !== counterpartCurrency) return false;
  if (selectedTarget.negative !== selectedCounterpart.negative
      && !targetKind) return false;
  if (targetKind) {
    const result = cashFlowRoundingPairEquivalent(
    primaryText,
    selectedPrimary,
    counterpartSegment.text,
    selectedCounterpart,
    );
    return result;
  }
  const result = quantityIntervalsOverlap(
    { ...selectedTarget, scaleKnown: true },
    { ...selectedCounterpart, scaleKnown: true },
  );
  return result;
}

function cashFlowSelectedPrimaryPairEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, options = {}) {
  if (!primary?.length || primary.length < 2 || auxiliary?.length < 2) return false;
  const primaryKind = cashFlowKind(primaryText);
  const auxiliaryKind = cashFlowKind(auxiliaryText);
  if (!primaryKind || (!auxiliaryKind && !options.allowMissingAuxiliaryKind)
      || (auxiliaryKind && primaryKind !== auxiliaryKind)) return false;
  const segments = claimPageSegments(auxiliaryText);
  const findingPage = Number(finding?.page);
  if (!Number.isInteger(findingPage) || segments.length !== 2
      || !segments.some(segment => segment.page === findingPage)) return false;
  const counterpartSegments = segments.filter(segment => segment.page !== findingPage);
  if (counterpartSegments.length !== 1) return false;
  const targetSegment = segments.find(segment => segment.page === findingPage);
  const targetPeriod = claimPeriodDescriptor(targetSegment.text);
  const counterpartPeriod = claimPeriodDescriptor(counterpartSegments[0].text);
  const periodCompatible = claimPeriodsCompatible(targetSegment.text, counterpartSegments[0].text);
  const periodOmitted = !targetPeriod.fiscalYears.size && !counterpartPeriod.fiscalYears.size;
  if (!periodCompatible && !(options.allowMissingAuxiliaryKind && periodOmitted)) return false;
  const matches = [];
  for (const token of primary) {
    const candidates = auxiliary.filter(candidate => claimAmountBindingMatches(token, candidate));
    if (candidates.length > 1) return false;
    if (candidates.length === 1) matches.push({ token, candidate: candidates[0] });
  }
  if (matches.length !== 1) return false;
  const rest = auxiliary.filter(token => token !== matches[0].candidate);
  if (rest.length !== 1) return false;
  return cashFlowRoundingPairEquivalent(primaryText, matches[0].token, auxiliaryText, rest[0], options);
}

function cashFlowRoundingEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, masker, options = {}, context = {}) {
  if (!primary?.length || !auxiliary?.length) return false;
  const pageScopeCompatibility = claimPagePeriodScopeCompatible(
    primaryText,
    primary,
    auxiliaryText,
    finding,
    masker,
    context,
  );
  const pageSourceAuthorized = pageClaimSourceAuthorization(auxiliaryText, finding, context);
  if (pageScopeCompatibility === false
      || (pageScopeCompatibility === null
        && pageClaimHasPrimaryBinding(primaryText, primary, auxiliaryText, finding, masker)
        && !pageSourceAuthorized)) return false;
  // A primary quote may contain a prior-period amount beside the asserted
  // current-period amount.  Bind the unique amount repeated in the canonical
  // claim before applying the normal cash-flow rounding proof; otherwise the
  // contextual amount incorrectly makes the candidate look contradictory.
  const pageBoundProof = pageBoundRoundingEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, masker, context);
  if (pageBoundProof) return true;
  if (cashFlowSelectedPrimaryPairEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, options)) return true;
  const primaryKind = cashFlowKind(primaryText);
  const auxiliaryKind = cashFlowKind(auxiliaryText);
  if (!primaryKind || (!auxiliaryKind && !options.allowMissingAuxiliaryKind)
      || (auxiliaryKind && primaryKind !== auxiliaryKind)) return false;
  const primaryCurrencies = currencyCodes(primaryText);
  const auxiliaryCurrencies = currencyCodes(auxiliaryText);
  // A cash-flow sentence may restate the same amount in a different scale,
  // but an explicit currency conflict (or an ambiguous multi-currency clause)
  // is not a rounding proof.
  if (primaryCurrencies.length > 1 || auxiliaryCurrencies.length > 1
      || (primaryCurrencies.length === 1 && auxiliaryCurrencies.length === 1
        && primaryCurrencies[0] !== auxiliaryCurrencies[0])) return false;
  // Keep the legacy no-period cash-flow shape working, while rejecting
  // conflicting fiscal-year labels or a quarter-end date that belongs to a
  // different fiscal year.
  const periodEvidence = cashFlowPeriodYearEvidence(auxiliaryText);
  const fiscalYears = new Set(periodEvidence.fiscalYears);
  if (periodEvidence.fiscalYears.length >= 2 && fiscalYears.size !== 1) return false;
  if (fiscalYears.size && periodEvidence.dateFiscalYears.some(year => !fiscalYears.has(year))) return false;
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
    cashFlowRoundingPairEquivalent(primaryText, left, auxiliaryText, right, options)))) return false;
  return primary.every(left => usable.some(right =>
    cashFlowRoundingPairEquivalent(primaryText, left, auxiliaryText, right, options)));
}

// Suggestions often contain only the two displayed amounts, while the reason
// carries the financing/operating label.  Keep that legacy shape narrow: use
// the primary cash-flow row as context, but still require every suggestion
// candidate to match every primary value under the same rounding proof.
function cashFlowRoundingSuggestionEquivalent(primaryText, primary, suggestionText, suggestion, finding, masker, context = {}) {
  if (!cashFlowKind(primaryText)) return false;
  const suggestionContext = { ...context, allowSuggestionInheritance: true };
  const pages = claimPageSegments(suggestionText, masker).length === 2;
  const authorized = pageClaimSourceAuthorization(suggestionText, finding, suggestionContext);
  if (pages && !authorized) return false;
  const result = cashFlowRoundingEquivalent(
    primaryText,
    primary,
    suggestionText,
    suggestion,
    finding,
    masker,
    { allowMissingAuxiliaryKind: true, inheritPrimarySemanticSign: true },
    suggestionContext,
  );
  return result;
}

function isSectionHeadingNumber(text, token) {
  const raw = String(token?.raw || "").trim();
  const unsigned = raw.replace(/^[△▲+＋−-]/, "").replace(/[(),]/g, "");
  if (!/^\d{1,2}$/.test(unsigned)) return false;
  const src = String(text || "");
  const before = src.slice(0, Number(token?.index) || 0);
  const after = src.slice(Number(token?.end) || 0);
  return /(?:^|[「『"'([{（［])\s*$/u.test(before)
    && /^\s*[.)．。:：）〕］]/u.test(after);
}

function pageUnitEvidence(value) {
  const parsed = parsePageMarkers(value);
  if (parsed.malformed.length) return new Map();
  const src = parsed.source;
  const pages = parsed.markers;
  if (new Set(pages.map(marker => marker.page)).size !== 2) return new Map();
  const evidence = new Map();
  for (let i = 0; i < pages.length; i++) {
    const page = Number(pages[i].page);
    const start = (pages[i].index || 0) + pages[i].raw.length;
    const nextPage = i + 1 < pages.length ? (pages[i + 1].index || src.length) : src.length;
    const remainder = src.slice(start, nextPage);
    const sentenceBreak = remainder.search(/[。.!?]/u);
    const segment = sentenceBreak >= 0 ? remainder.slice(0, sentenceBreak) : remainder;
    const scales = [...segment.matchAll(SCALE_WORD_RE)]
      .map(match => scaleExponent(match[0]))
      .filter(Number.isInteger);
    const currencies = currencyCodes(segment);
    const uniqueScales = [...new Set(scales)];
    if (uniqueScales.length === 1 && currencies.length === 1) {
      evidence.set(page, { scaleExp: uniqueScales[0], currency: currencies[0] });
    }
  }
  return evidence;
}

function scaledAmountWithAdjacentRateEquivalent(primaryText, primary, auxiliaryText, auxiliary) {
  // This is deliberately a single report shape: two primary values where the
  // second is a decimal rate, and two auxiliary amount values whose page-local
  // captions state explicit currency/scales.  Do not generalize this to bare
  // decimal-place equality or pair a rate with an amount.
  if (!primary || primary.length !== 2 || !auxiliary?.length) return false;
  const primaryAmount = primary[0];
  const primaryRate = primary[1];
  if (!primaryAmount || !primaryRate || primaryRate.decimals < 1
      || !primaryAmount.periodKey || primaryAmount.rateEvidence) return false;
  if (!/(?:同一(?:期間|年度|期)|同じ\s*FY|same\s+(?:period|FY|fiscal\s+year))/iu.test(String(auxiliaryText || ""))) return false;
  const primaryYear = String(primaryAmount.periodKey).match(/^fy(\d{4})$/i)?.[1];
  if (!primaryYear || !new RegExp(`(?:FY\\s*${primaryYear}\\b|${primaryYear}\\s*年|\\b${primaryYear}\\b)`, "iu").test(String(auxiliaryText || ""))) return false;

  const candidates = auxiliary.filter(token => !isSectionHeadingNumber(auxiliaryText, token));
  const rateTokens = candidates.filter(token => token.rateEvidence);
  if (rateTokens.length !== 1 || canonicalNumericKey(rateTokens[0]) !== canonicalNumericKey(primaryRate)) return false;
  const amounts = candidates.filter(token => !token.rateEvidence);
  if (amounts.length !== 2) return false;
  if (canonicalNumericKey(primaryAmount) !== canonicalNumericKey(amounts[0])) return false;
  if (!amounts.every(token => token.measureExplicit && token.measureKey)) return false;
  if (amounts[0].measureKey !== amounts[1].measureKey
      || explicitMeasureMismatch(amounts[0], amounts[1])
      || explicitScopeMismatch(amounts[0], amounts[1])
      || explicitPeriodMismatch(amounts[0], amounts[1])
      || amounts[0].negative !== amounts[1].negative
      || primaryAmount.negative !== amounts[0].negative) return false;
  if (!amounts.every(token => token.scopeExplicit)) return false;

  const pageEvidence = pageUnitEvidence(auxiliaryText);
  const leftPage = pageLabelBeforeToken(auxiliaryText, amounts[0]);
  const rightPage = pageLabelBeforeToken(auxiliaryText, amounts[1]);
  const leftEvidence = pageEvidence.get(leftPage);
  const rightEvidence = pageEvidence.get(rightPage);
  if (!leftEvidence || !rightEvidence || leftEvidence.currency !== rightEvidence.currency) return false;
  const left = { ...amounts[0], scaleExp: leftEvidence.scaleExp, rowScaleExp: 0, scaleKnown: true, nonRateUnitEvidence: true };
  const right = { ...amounts[1], scaleExp: rightEvidence.scaleExp, rowScaleExp: 0, scaleKnown: true, nonRateUnitEvidence: true };
  return quantityIntervalsOverlap(left, right);
}

function comparisonClauses(value) {
  // Split only at sentence/semicolon boundaries.  A period in `P.10` or a
  // decimal amount is not a boundary, so page labels and displayed values
  // remain in the same clause as their evidence.  Do not split Japanese
  // commas before a page label: a two-period comparison commonly states
  // P.12 and P.13 in one logical vector, and separating those members breaks
  // the ordered-vector safety proof.
  return String(value || "")
    .split(/(?:[。！？!?]|[.!?](?=\s|$)|[;；])+\s*/u)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function periodYearSequence(value) {
  const years = [];
  const src = String(value || "");
  const pattern = /\bFY\s*(\d{2,4})\b|\b(\d{4})\s*年/giu;
  for (const match of src.matchAll(pattern)) {
    const raw = match[1] || match[2] || "";
    const year = raw.length === 2 ? `20${raw}` : raw;
    if (year) years.push(year);
  }
  return years;
}

function clausePageNumbers(value) {
  const parsed = parsePageMarkers(value);
  if (parsed.malformed.length) return [];
  return [...new Set(parsed.markers.map(marker => marker.page).filter(Number.isInteger))];
}

function clauseScopeKeys(value, tokens) {
  const tokenScopes = (tokens || []).flatMap(token => token.scopeKeys || []);
  const normalizedText = normalizeScopeText(value);
  const textScopes = SCOPE_PATTERNS
    .filter(rule => rule.re.test(normalizedText))
    .map(rule => rule.key);
  return [...new Set([...tokenScopes, ...textScopes])];
}

function clauseMeasureKeys(value, tokens) {
  const statementHeading = /(?:純資産変動表|statement\s+(?:of\s+)?changes\s+in\s+net\s+assets|net\s+assets\s+statement)/iu
    .test(String(value || ""));
  return [...new Set((tokens || []).flatMap(token => token.measureKeys || [])
    // `net assets` in a statement title identifies the source table, not the
    // row being repeated.  Treat only that explicit structural occurrence as
    // non-measure evidence; a row-level Net assets label remains a mismatch.
    .filter(key => !(statementHeading && key === "net_assets")))];
}

function unitFamilyEvidence(value) {
  const src = String(value || "");
  const scales = [...src.matchAll(SCALE_WORD_RE)]
    .map(match => scaleExponent(match[0]))
    .filter(Number.isInteger);
  return {
    scales: [...new Set(scales)],
    currencies: currencyCodes(src),
    hasUnitCue: /(?:\bunit(?:s)?\b|単位|互換性|compatible|same\s+(?:unit|currency|scale))/iu.test(src),
  };
}

function repeatedVectorTautologyEquivalent(primary, auxiliaryText, auxiliary, masker = null) {
  // A vector proof is intentionally narrower than the existing repeated-pair
  // proof: require at least two ordered amounts, two page-labelled clauses,
  // explicit period/scope/unit evidence, and a positive same-indicator cue.
  if (!primary || primary.length < 2 || primary.length > 8 || !auxiliary?.length) return false;
  if (primary.some(token => token.symbol || token.rateEvidence)) return false;
  const primaryKeys = primary.map(canonicalNumericKey);
  if (primaryKeys.some(key => !key)) return false;
  const primaryMeasures = [...new Set(primary.map(token => token.measureKey).filter(Boolean))];
  if (primaryMeasures.length !== 1) return false;

  const source = String(auxiliaryText || "");
  if (!/(?:同じ\s*(?:指標|項目|科目|値|数値)|same\s+(?:indicator|measure|metric|item|line))/iu.test(source)) return false;
  const unit = unitFamilyEvidence(source);
  // Without a caption/currency and a positive compatibility statement, a
  // repeated vector can still be two unrelated displays with equal digits.
  if (!unit.hasUnitCue || unit.scales.length !== 1 || unit.currencies.length !== 1) return false;

  const clauses = comparisonClauses(source);
  const pageClauses = clauses.map(clause => ({
    clause,
    pages: clausePageNumbers(clause),
    tokens: extractNumericEvidence(clause, masker),
  })).filter(item => item.pages.length > 0 && item.tokens.length > 0);
  if (pageClauses.length < 2) return false;
  // Any page-labelled numeric clause is part of the comparison.  Reject an
  // extra/contradictory candidate rather than dropping because two clauses
  // happen to contain the same first pair.
  if (pageClauses.some(item => item.tokens.length !== primary.length)) return false;
  if (auxiliary.length !== pageClauses.length * primary.length) return false;

  const vectors = pageClauses.map(item => item.tokens);
  // The unit caption may be stated once after the two page clauses (for
  // example, "the units in both tables are ...").  The global unit proof
  // above covers that positive restatement; do not require the caption to be
  // duplicated beside every amount token.
  if (vectors.some(tokens => tokens.some(token => token.symbol || token.rateEvidence))) return false;
  if (vectors.some(tokens => tokens.some((token, index) =>
    canonicalNumericKey(token) !== primaryKeys[index]))) return false;

  const periods = pageClauses.map(item => periodYearSequence(item.clause));
  if (periods.some(sequence => sequence.length !== primary.length)
      || periods.some(sequence => sequence.some((year, index) => year !== periods[0][index]))) return false;

  const scopes = pageClauses.map(item => clauseScopeKeys(item.clause, item.tokens));
  if (scopes.some(keys => keys.length !== 1 || keys[0] !== scopes[0][0])) return false;

  const measureKeys = pageClauses.flatMap(item => clauseMeasureKeys(item.clause, item.tokens));
  if (measureKeys.some(key => key !== primaryMeasures[0])) return false;
  return true;
}

function selectedQuotedRowMemberEquivalent(primary, auxiliaryText, auxiliary, masker = null) {
  // A quoted two-period row can contain a second value that is only context
  // when the reason explicitly selects the compared member immediately after
  // the quote (`」の114,079` or the equally strict English `"..." of 114,079`).
  // Keep this proof local: without the selector, the extra value remains a
  // contradictory candidate and the finding must stay visible.
  if (!primary || primary.length < 2 || !auxiliary?.length) return false;
  const primaryKeys = primary.map(canonicalNumericKey);
  if (primaryKeys.some(key => !key) || new Set(primaryKeys).size !== 1) return false;
  const primaryMeasures = [...new Set(primary.map(token => token.measureKey).filter(Boolean))];
  if (primaryMeasures.length !== 1) return false;

  const source = String(auxiliaryText || "");
  const number = String.raw`[△▲+＋−-]?\s*\(?\s*\d[\d,]*(?:\.\d+)?\s*\)?`;
  const matches = [];
  const japanese = new RegExp(String.raw`「([^「」]*\d[^「」]*)」\s*の\s*(${number})`, "gu");
  for (const match of source.matchAll(japanese)) {
    matches.push({ match, rowText: match[1], selectedRaw: match[2], quote: "「" });
  }
  // Restrict English selectors to a direct post-quote construction.  A broad
  // `selected` search could accidentally choose a different value elsewhere
  // in the reason and would not establish which row member was compared.
  const english = new RegExp(String.raw`["']([^"']*\d[^"']*)["']\s*(?:of|with|selected(?:\s+(?:value|amount))?|the\s+selected\s+(?:value|amount)\s*(?:is|:)?|the\s+(?:selected\s+)?(?:value|amount)\s*(?:is|:)?)\s*(${number})`, "giu");
  for (const match of source.matchAll(english)) {
    matches.push({ match, rowText: match[1], selectedRaw: match[2], quote: match[0].slice(0, 1) });
  }
  // More than one selector is ambiguous, even if the selected digits happen
  // to repeat.  A missing selector follows the same fail-closed path.
  if (matches.length !== 1) return false;
  const selectedMatch = matches[0];
  const fullMatch = selectedMatch.match[0];
  const matchStart = selectedMatch.match.index || 0;
  const rowStart = matchStart + fullMatch.indexOf(selectedMatch.quote) + 1;
  const rowEnd = rowStart + selectedMatch.rowText.length;
  const selectedStart = matchStart + fullMatch.lastIndexOf(selectedMatch.selectedRaw);
  const rowValues = extractNumericEvidence(selectedMatch.rowText, masker);
  if (rowValues.length !== 2) return false;
  const rowKeys = rowValues.map(canonicalNumericKey);
  const selectedKey = primaryKeys[0];
  if (!rowKeys.includes(selectedKey) || new Set(rowKeys).size < 2) return false;
  const rowMeasures = [...new Set(rowValues.map(token => token.measureKey).filter(Boolean))];
  if (rowMeasures.length !== 1 || rowMeasures[0] !== primaryMeasures[0]) return false;

  const selectedToken = auxiliary.find(token => token.index >= selectedStart
    && token.index < selectedStart + selectedMatch.selectedRaw.length
    && token.end <= selectedStart + selectedMatch.selectedRaw.length);
  if (!selectedToken || canonicalNumericKey(selectedToken) !== selectedKey) return false;
  if (selectedToken.symbol) return false;

  const rowTokens = auxiliary.filter(token => token.index >= rowStart && token.end <= rowEnd);
  if (rowTokens.length !== rowValues.length
      || rowTokens.some((token, index) => canonicalNumericKey(token) !== rowKeys[index])) return false;
  // Every candidate outside the quoted row must be the selected value.  This
  // explicitly rejects a stale/different amount elsewhere in the reason;
  // only the row's unselected member receives the narrow context exception.
  if (auxiliary.some(token => token.index < rowStart || token.end > rowEnd
      ? canonicalNumericKey(token) !== selectedKey
      : false)) return false;

  const boundaries = [...source.matchAll(/[。.!?;；！？]/gu)].filter(match => {
    if (match[0] !== ".") return true;
    const before = source.slice(0, match.index || 0);
    const after = source.slice((match.index || 0) + 1);
    // A page label (`P.10`) and a decimal amount (`2.0`) are not sentence
    // boundaries.  English full stops remain valid clause separators only
    // when followed by whitespace/end-of-text, not inside `Mil.yen`.
    return after.length === 0 || /^\s/.test(after)
      && !/[Pp]\s*$/.test(before) && !/\d\s*$/.test(before);
  });
  const previousBoundary = boundaries.filter(match => (match.index || 0) < matchStart).at(-1);
  const clauseStart = previousBoundary ? (previousBoundary.index || 0) + 1 : 0;
  const nextBoundary = boundaries.find(match => (match.index || 0) >= matchStart);
  const clauseEnd = nextBoundary ? (nextBoundary.index || source.length) : source.length;
  const clause = source.slice(clauseStart, clauseEnd);
  const clauseValues = extractNumericEvidence(clause, masker);
  const scopeKeys = clauseScopeKeys(clause, clauseValues);
  if (scopeKeys.length !== 1) return false;
  const measureKeys = clauseMeasureKeys(clause, clauseValues);
  if (measureKeys.length !== 1 || measureKeys[0] !== primaryMeasures[0]) return false;
  const unit = unitFamilyEvidence(clause);
  if (unit.scales.length !== 1 || unit.currencies.length !== 1) return false;
  if (!/(?:同じ\s*(?:FY\s*\d{2,4}|期間|年度|期)|same\s+(?:FY|period|fiscal\s+year))/iu.test(clause)) return false;
  const years = periodYearSequence(clause);
  if (!years.length || new Set(years).size !== 1) return false;

  const contextIdentity = { measureExplicit: true, measureKey: primaryMeasures[0], scopeKeys, scopeExplicit: true };
  if (primary.some(token => explicitMeasureMismatch(token, contextIdentity)
      || explicitScopeMismatch(token, contextIdentity)
      || explicitPeriodMismatch(token, selectedToken))) return false;
  const selectedCurrency = selectedToken.currencyEvidence || selectedToken.rowCurrency || "";
  const selectedScale = selectedToken.scaleExp || selectedToken.rowScaleExp || 0;
  if (selectedCurrency !== unit.currencies[0] || !selectedScale || selectedScale !== unit.scales[0]) return false;
  return true;
}

function hasQuotedTwoPeriodRow(value, masker = null) {
  const source = String(value || "");
  const rowTexts = [];
  for (const match of source.matchAll(/「([^「」]*\d[^「」]*)」/gu)) rowTexts.push(match[1]);
  for (const match of source.matchAll(/["']([^"']*\d[^"']*)["']/gu)) rowTexts.push(match[1]);
  return rowTexts.some(rowText => extractNumericEvidence(rowText, masker).length === 2);
}

function contradictoryRepeatedVector(primary, auxiliaryText, auxiliary, masker = null) {
  // If another model field carries a two-period, page-to-page vector that
  // fails the strict proof, it is contradictory evidence.  Do not let a
  // stale model_reason or suggestion make a genuine mismatch disappear just
  // because a different auxiliary field repeats the first pair.  Single-
  // period repeated pairs (the legacy Net income shape) intentionally stay on
  // the older narrow proof path.
  if (!primary || primary.length < 2 || !auxiliary?.length) return false;
  const clauses = comparisonClauses(auxiliaryText);
  const pageClauses = clauses.map(clause => ({
    clause,
    pages: clausePageNumbers(clause),
    tokens: extractNumericEvidence(clause, masker),
  })).filter(item => item.pages.length > 0 && item.tokens.length > 0);
  if (pageClauses.length < 2) return false;
  const periods = pageClauses.map(item => periodYearSequence(item.clause));
  const hasOrderedTwoPeriodVector = periods.some(sequence =>
    sequence.length === primary.length && new Set(sequence).size > 1);
  if (!hasOrderedTwoPeriodVector) return false;
  return !repeatedVectorTautologyEquivalent(primary, auxiliaryText, auxiliary, masker);
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
  const re = /[△▲+＋−-]?\s*\(?\s*\d[\d,]*(?:\.\d+)?\s*\)?/g;
  const matches = [...text.matchAll(re)];
  // Percent is a display marker for the rate column, not quantity evidence
  // for every amount in the same excerpt.  Keep it in `percent` below but do
  // not let it suppress the unit-free amount fallback.
  const directUnitRe = /(?:¥|円|yen\b|dollars?\b|euros?\b|usd\b|jpy\b|trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|(?<![A-Za-z])oku(?![A-Za-z])|(?<![A-Za-z])k\b|vehicles?\b|units?\b|shipments?\b|deliveries?\b|shares?\b|employees?\b|persons?\b|patents?\b|cases?\b|台数|販売台数|生産台数|出荷台数|数量|株式数|株数|持株数|人員数|従業員数|件数)/i;
  const out = [];
  for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
    const match = matches[matchIndex];
    const raw = match[0].trim();
    const index = match.index || 0;
    const before = text.slice(0, index);
    const after = text.slice(index + raw.length);
    const unsignedForContext = raw.replace(/^[△▲−+＋\-]\s*/, "").replace(/[(),]/g, "");
    // Page/fiscal-year/date labels are structure, not compared measure
    // values.  Mirror extractNumericEvidence so a different page label does
    // not prevent an otherwise identical target/reference pair from being
    // recognized as self-consistent.
    if (/(?:\b(?:p|page)\s*[.．]?\s*|\bfy\s*)$/i.test(before)
      || isStructuralPerUnitNumber(text, index + raw.length)
      || isStructuralDateNumber(text, index, index + raw.length, unsignedForContext)) continue;
    const negative = tokenNegative(raw);
    const unsigned = raw
      .replace(/^[△▲−+＋\-]\s*/, "")
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
    const scales = [...unitText.matchAll(/trillions?|billions?|millions?|thousands?|十\s*億|百\s*万|百万|十億|兆|億|万|千|(?<![A-Za-z])oku(?![A-Za-z])|(?<![A-Za-z])k\b/gi)]
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

function hasUnboundDecimalScaleShift(quoteText, referenceText) {
  const quote = looseNumericTokens(quoteText);
  const reference = looseNumericTokens(referenceText);
  if (!quote.length || quote.length !== reference.length) return false;
  return quote.some((left, index) => sameDecimalScaleValue(left, reference[index]));
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

// A translated TARGET/REF finding may have different row labels even though
// the authoritative quote columns are the same.  This is intentionally a
// separate, narrow proof: it is available only for findings that explicitly
// cite the reference document, and it never consults reason/suggestion
// numbers.  The model may hallucinate an extra value in prose; the quote and
// referenceQuote columns remain the only numeric authority here.
function fiscalYearKeys(value) {
  return [...String(value || "").matchAll(/(?:FY\s*(\d{2,4})\b|(?<!\d)(\d{4})\s*年)/giu)]
    .map(match => match[1] || match[2])
    .map(year => year.length === 2 ? `20${year}` : year);
}

function sameFiscalYearEvidence(left, right) {
  const l = new Set(fiscalYearKeys(left));
  const r = new Set(fiscalYearKeys(right));
  return l.size > 0 && r.size > 0 && [...l].some(year => r.has(year));
}

function scaleCueExponent(value) {
  const exponents = [...String(value || "").matchAll(SCALE_WORD_RE)]
    .map(match => scaleExponent(match[0]))
    .filter(Number.isInteger);
  const unique = [...new Set(exponents)];
  return unique.length === 1 ? unique[0] : null;
}

function sourceContextIdentityCompatible(context, finding = null) {
  if (!context?.targetRowUnique || !context?.referenceRowUnique) return false;
  const targetRow = String(context.targetRowText || context.target_row_text || "");
  const referenceRow = String(context.referenceRowText || context.reference_row_text || "");
  if (!targetRow || !referenceRow) return false;
  if (!sourceContextMeasureMatchesQuote(context, finding)) return false;
  const targetMeasures = sourceContextMeasureSequence(targetRow);
  const referenceMeasures = sourceContextMeasureSequence(referenceRow);
  // A source row with no recognized measure, or a column whose TARGET/REF
  // labels do not overlap, cannot prove the conversion.  A multi-measure
  // source line is valid only when every numeric column has a compatible
  // measure in the same position; this avoids treating an arbitrary repeated
  // numeric sequence as one row.
  if (!targetMeasures.length || targetMeasures.length !== referenceMeasures.length) return false;
  let measuredColumn = false;
  for (let index = 0; index < targetMeasures.length; index++) {
    const left = targetMeasures[index];
    const right = referenceMeasures[index];
    if (!left.length && !right.length) continue;
    if (!left.length || !right.length || !left.some(key => right.includes(key))) return false;
    measuredColumn = true;
  }
  return measuredColumn;
}

function hasCommonExplicitMeasure(left, right) {
  const leftMeasures = new Set(left.flatMap(token => token.measureKeys || []).filter(Boolean));
  const rightMeasures = new Set(right.flatMap(token => token.measureKeys || []).filter(Boolean));
  return [...leftMeasures].some(key => rightMeasures.has(key));
}

function orderedNumericVectorMatches(left, right) {
  return left.length >= 2
    && left.length === right.length
    && left.every((token, index) => canonicalNumericKey(token) && canonicalNumericKey(token) === canonicalNumericKey(right[index]));
}

function sourceContextRowLines(context, side) {
  const explicit = context?.[`${side}RowLines`] || context?.[`${side}_row_lines`];
  if (Array.isArray(explicit)) return explicit.map(value => String(value || "")).filter(Boolean);
  // Older callers only supplied the flattened row text.  Do not fabricate a
  // multi-row proof from that string: preserving the fail-closed behaviour is
  // safer than guessing where one metric row ends and the next begins.
  return [];
}

function sourceUnitDescriptor(context, side) {
  const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "");
  const rowLines = sourceContextRowLines(context, side);
  const rows = rowLines.length ? rowLines : [String(context?.[`${side}RowText`] || context?.[`${side}_row_text`] || "")];
  const rowStart = rows[0] ? text.indexOf(rows[0]) : -1;
  const sourceLines = text.split(/\r?\n/);
  const lineIndex = rowStart >= 0 ? text.slice(0, rowStart).split(/\r?\n/).length - 1 : sourceLines.length;
  const candidates = [];
  const add = (line, distance, rowEvidence = false) => {
    const value = String(line || "").trim();
    if (!value) return;
    const scales = [...value.matchAll(SCALE_WORD_RE)].map(match => scaleExponent(match[0])).filter(Number.isInteger);
    const currencies = currencyCodes(value);
    const currencyExplicit = /(?:円|\byen\b|\bjpy\b|\busd\b)/iu.test(value);
    const uniqueScales = [...new Set(scales)];
    if (uniqueScales.length !== 1 || currencies.length !== 1) return;
    // A unit caption is stronger than a data row that happens to repeat a
    // currency/scale.  The latter is still allowed when the row itself is the
    // only evidence available, but is ranked after explicit captions.
    const caption = /(?:\bunit(?:s)?\b|amounts?\s+in|\bin\s+(?:the\s+)?(?:millions?|billions?|thousands?)|単位|\(?(?:in|単位)[^\n)]*[兆億万千円])/iu.test(value);
    candidates.push({ scale: uniqueScales[0], currency: currencies[0], currencyExplicit, distance, caption, rowEvidence });
  };
  const addLine = (line, distance) => {
    // PDF text extraction can flatten two adjacent tables onto one line,
    // e.g. `(単位：億円) ... (単位：千台)`. Treat each parenthesized unit
    // caption as an independent candidate.
    const segments = [...String(line || "").matchAll(/(?:\([^()\n]*\)|（[^（）\n]*）)/gu)]
      .map(match => match[0])
      .filter(segment => {
        SCALE_WORD_RE.lastIndex = 0;
        const matched = SCALE_WORD_RE.test(segment);
        SCALE_WORD_RE.lastIndex = 0;
        return matched;
      });
    SCALE_WORD_RE.lastIndex = 0;
    if (segments.length > 1) segments.forEach(segment => add(segment, distance));
    else add(line, distance);
  };
  const explicitCaption = value => /(?:\bunit(?:s)?\b|amounts?\s+in|\bin\s+(?:the\s+)?(?:millions?|billions?|thousands?)|単位)/iu.test(String(value || ""));
  const tableSection = value => /^(?:営業外収益|営業外費用|特別利益|特別損失|営業活動によるキャッシュ・フロー|投資活動によるキャッシュ・フロー|財務活動によるキャッシュ・フロー|税金等調整前四半期純利益|又は税金等調整前四半期純損失(?:（△）)?|四半期純利益又は四半期純損失(?:（△）)?|親会社株主に帰属する四半期純利益|又は親会社株主に帰属する四半期純損失(?:（△）)?)$/u.test(String(value || "").trim());
  const bridgeIsTableShaped = captionIndex => {
    const bridge = sourceLines.slice(captionIndex + 1, lineIndex).filter(line => String(line || "").trim());
    const evidence = bridge.map(line => ({ line, tokens: extractNumericEvidence(line) }));
    const isStructuralHeader = line => {
      const value = String(line || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
      const quarter = "(?:前|当)?第\\s*[1-4]\\s*四半期(?:連結)?(?:累計|会計)期間";
      if (new RegExp(`^${quarter}(?:\\s+${quarter})*$`, "u").test(value)) return true;
      const japaneseDate = "[（(]?\\s*(?:自|至)\\s*\\d{4}年\\s*\\d{1,2}月\\s*\\d{1,2}日\\s*[）)]?";
      if (new RegExp(`^(?:${japaneseDate}\\s*){1,3}$`, "u").test(value)) return true;
      const englishPeriod = "(?:(?:for\\s+the\\s+)?(?:three|six|nine|twelve)\\s+months?|year|quarter)\\s+ended\\s+[A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4}";
      return new RegExp(`^${englishPeriod}(?:\\s+${englishPeriod})*$`, "iu").test(value);
    };
    const isNumericTableRow = ({ line, tokens }) => {
      if ((tokens.length < 2 && !(tokens.length === 1 && /－/u.test(line))) || /[。！？]/u.test(line)) return false;
      const normalized = String(line || "").replace(/[０-９]/gu, char =>
        String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
      const lastToken = tokens[tokens.length - 1];
      const valueGapsAreTabular = tokens.slice(1).every((token, index) =>
        /^(?:\s|[()（）\[\]［］△▲+＋−-]|円|yen|jpy|usd|%|％)*$/iu
          .test(normalized.slice(tokens[index].end, token.index)));
      // Table rows end at the final value (optionally followed by a unit or
      // closing mark).  Ordinary prose such as `10 から 20 へ増加` must not
      // become a bridge merely because it contains a financial label and two
      // numbers and happens to omit terminal punctuation in the PDF layer.
      return valueGapsAreTabular
        && /^(?:\s|[()（）\[\]［］}%％△▲+＋−－-]|円|yen|jpy|usd)*$/iu.test(normalized.slice(lastToken.end));
    };
    const isTableLike = ({ line, tokens }) =>
      isNumericTableRow({ line, tokens })
      || tableSection(line)
      || isStructuralHeader(line);
    const numericRows = evidence.filter(isNumericTableRow).length;
    const structuralRows = evidence.filter(({ line }) => isStructuralHeader(line)).length;
    const minimumNumericRows = lineIndex - captionIndex <= 8 ? 1 : 3;
    const numericBridge = numericRows >= minimumNumericRows;
    // Some extracted statements place only multi-line period headers between
    // the unit caption and the first data row.  Two independent structural
    // header lines are strong table evidence; ordinary prose, even prose that
    // happens to contain two numbers, is not.
    const headerBridge = lineIndex - captionIndex <= 8 && structuralRows >= 2;
    return bridge.length > 0 && (numericBridge || headerBridge) && evidence.every(isTableLike);
  };
  // A caption on the row itself or immediately above it is local evidence.
  // Anything farther away, including the old eight-line shortcut, must cross
  // the same continuous table bridge required for long statements.
  if (lineIndex >= 0 && lineIndex < sourceLines.length) addLine(sourceLines[lineIndex], 0);
  let borrowedCaptionIndex = -1;
  for (let index = lineIndex - 1; index >= Math.max(0, lineIndex - 64); index--) {
    if (!explicitCaption(sourceLines[index])) continue;
    borrowedCaptionIndex = index;
    break;
  }
  if (borrowedCaptionIndex >= 0
      && (lineIndex - borrowedCaptionIndex === 1 || bridgeIsTableShaped(borrowedCaptionIndex))) {
    addLine(sourceLines[borrowedCaptionIndex], lineIndex - borrowedCaptionIndex);
  }
  // Include a same-row caption when the caller provided a compact context that
  // does not contain line breaks.
  // Only the first cited row is allowed to contribute a same-row unit.  A
  // flattened PDF line can contain two unrelated captions; selecting the
  // first one would turn an ambiguous unit into a false equivalence.
  if (rows[0]) add(rows[0], 0, true);
  if (!candidates.length) return null;
  const rowCandidates = candidates.filter(candidate => candidate.rowEvidence);
  if (rowCandidates.length) {
    const rowDescriptors = new Set(rowCandidates.map(candidate => String(candidate.scale) + ":" + candidate.currency));
    if (rowDescriptors.size !== 1) return { ambiguous: true };
    let currencyExplicit = rowCandidates.some(candidate => candidate.currencyExplicit);
    const captionCandidates = candidates.filter(candidate => candidate.caption && !candidate.rowEvidence);
    if (captionCandidates.length) {
      const nearestDistance = Math.min(...captionCandidates.map(candidate => candidate.distance));
      const nearestCandidates = captionCandidates.filter(candidate => candidate.distance === nearestDistance);
      const nearestDescriptors = new Set(nearestCandidates
        .map(candidate => String(candidate.scale) + ":" + candidate.currency));
      if (nearestDescriptors.size !== 1 || !nearestDescriptors.has([...rowDescriptors][0])) {
        return { ambiguous: true };
      }
      currencyExplicit = currencyExplicit || nearestCandidates.some(candidate => candidate.currencyExplicit);
    }
    return { ...rowCandidates[0], currencyExplicit };
  }
  const captionCandidates = candidates.filter(candidate => candidate.caption);
  const authoritative = captionCandidates.length ? captionCandidates : candidates;
  const nearestDistance = Math.min(...authoritative.map(candidate => candidate.distance));
  const nearest = authoritative.filter(candidate => candidate.distance === nearestDistance);
  const descriptors = new Set(nearest.map(candidate => String(candidate.scale) + ":" + candidate.currency));
  if (descriptors.size !== 1) return { ambiguous: true };
  return nearest[0] || null;
}

function sourceContextQuarterNumbers(context, side) {
  const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "").normalize("NFKC");
  const numbers = [];
  for (const match of text.matchAll(/(?:第\s*)?([1-4])\s*四半期/gu)) numbers.push(Number(match[1]));
  const words = { first: 1, second: 2, third: 3, fourth: 4 };
  for (const match of text.matchAll(/\b(first|second|third|fourth|[1-4](?:st|nd|rd|th))\s+quarter\b/giu)) {
    numbers.push(words[String(match[1]).toLowerCase()] || Number.parseInt(match[1], 10));
  }
  for (const match of text.matchAll(/\bQ\s*([1-4])\b/giu)) numbers.push(Number(match[1]));
  return [...new Set(numbers.filter(number => Number.isInteger(number) && number >= 1 && number <= 4))];
}

function sourceContextFiscalQuarterKeys(context, side, fiscalEndMonth) {
  const precise = sourceContextPrecisePeriodKeys(context, side);
  const quarterHints = sourceContextQuarterNumbers(context, side);
  const keys = [];
  for (const key of precise) {
    if (/^\d{4}-Q[1-4]$/u.test(key)) {
      keys.push(key);
      continue;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(key);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isInteger(year) || month < 1 || month > 12) return [];
    if (day === 0) {
      if (month !== fiscalEndMonth || quarterHints.length !== 1) return [];
      keys.push(`${year}-Q${quarterHints[0]}`);
      continue;
    }
    const step = (month - fiscalEndMonth + 12) % 12;
    const quarter = step === 0 ? 4 : (step % 3 === 0 ? step / 3 : 0);
    if (!quarter || quarter < 1 || quarter > 4) return [];
    const fiscalYear = month <= fiscalEndMonth ? year : year + 1;
    keys.push(`${fiscalYear}-Q${quarter}`);
  }
  const unique = [...new Set(keys)];
  // A narrative page may expose only the current fiscal-quarter header while
  // the bound sentence carries both current and `prior year/前年同期` amounts.
  // Expand that one explicit current quarter to the immediately preceding
  // fiscal year only when the source row itself contains a prior-scoped amount.
  // This is symmetric for English and Japanese and remains source-bound.
  if (unique.length === 1) {
    const rowText = sourceContextRowLines(context, side).join(" ")
      || String(context?.[`${side}RowText`] || context?.[`${side}_row_text`] || "");
    const rowTokens = extractNumericEvidence(rowText);
    const match = /^(\d{4})-Q([1-4])$/u.exec(unique[0]);
    if (match && rowTokens.length >= 2 && rowTokens.some(narrativeTokenIsPrior)) {
      unique.unshift(`${Number(match[1]) - 1}-Q${match[2]}`);
    }
  }
  return unique;
}

function sourceContextFiscalQuarterPeriodsCompatible(context, targetPrecisePeriods, referencePrecisePeriods) {
  const monthOnly = [...targetPrecisePeriods, ...referencePrecisePeriods]
    .map(key => /^(\d{4})-(\d{2})-00$/u.exec(key))
    .filter(Boolean)
    .map(match => Number(match[2]));
  const sourceText = `${String(context?.targetText || context?.target_context || "")}\n${String(context?.referenceText || context?.reference_context || "")}`
    .normalize("NFKC");
  const explicitFiscalEndMonths = [...sourceText.matchAll(/(?<!\d)\d{4}\s*年\s*(\d{1,2})\s*月期/gu)]
    .map(match => Number(match[1]));
  const endMonths = [...new Set([...monthOnly, ...explicitFiscalEndMonths])];
  if (endMonths.length !== 1) return false;
  const targetKeys = sourceContextFiscalQuarterKeys(context, "target", endMonths[0]);
  const referenceKeys = sourceContextFiscalQuarterKeys(context, "reference", endMonths[0]);
  return Boolean(targetKeys.length && referenceKeys.length
    && targetKeys.length === referenceKeys.length
    && targetKeys.every(key => referenceKeys.includes(key)));
}

function sourceContextPeriodsCompatible(context) {
  const targetPrecisePeriods = sourceContextPrecisePeriodKeys(context, "target");
  const referencePrecisePeriods = sourceContextPrecisePeriodKeys(context, "reference");
  // A precise date/quarter on only one cited row is not compatible with a
  // broad FY/year marker on the other side.  Falling through to fiscal-year
  // keys here would turn Q1-vs-FY2026 into a false equivalence proof.
  if (Boolean(targetPrecisePeriods.length) !== Boolean(referencePrecisePeriods.length)) {
    // Some translated note pages carry no period header at all (the attached
    // English loan-note page is one such source), while the Japanese page
    // carries the document's quarter header.  Absence is incomplete evidence,
    // not a period difference; an explicit FY/year/quarter on both sides is
    // still required before treating the periods as contradictory.
    const targetPeriods = sourceContextPeriodKeys(context, "target");
    const referencePeriods = sourceContextPeriodKeys(context, "reference");
    if ((!targetPrecisePeriods.length && !targetPeriods.length)
        || (!referencePrecisePeriods.length && !referencePeriods.length)) return true;
    return false;
  }
  if (targetPrecisePeriods.length && referencePrecisePeriods.length) {
    if (sourceContextFiscalQuarterPeriodsCompatible(context, targetPrecisePeriods, referencePrecisePeriods)) return true;
    return targetPrecisePeriods.length === referencePrecisePeriods.length
      && targetPrecisePeriods.every(period => referencePrecisePeriods.includes(period));
  }
  const targetPeriods = sourceContextPeriodKeys(context, "target");
  const referencePeriods = sourceContextPeriodKeys(context, "reference");
  if (!targetPeriods.length || !referencePeriods.length) return false;
  return targetPeriods.length === referencePeriods.length
    && targetPeriods.every(period => referencePeriods.includes(period));
}

function sourceContextExplicitPeriodMismatch(context) {
  const targetPrecisePeriods = sourceContextPrecisePeriodKeys(context, "target");
  const referencePrecisePeriods = sourceContextPrecisePeriodKeys(context, "reference");
  const targetPeriods = sourceContextPeriodKeys(context, "target");
  const referencePeriods = sourceContextPeriodKeys(context, "reference");
  // A precise marker on only one side is incomplete evidence for the generic
  // authoritative/vector proof.  The rounded-narrative gate separately uses
  // sourceContextPeriodsCompatible, which deliberately rejects this shape;
  // treating it as a global contradiction would regress valid source-row
  // proofs whose neighbouring period header is missing on one side.
  if (Boolean(targetPrecisePeriods.length) !== Boolean(referencePrecisePeriods.length)) {
    // If both sides nevertheless carry explicit, disjoint fiscal/year keys,
    // that is a real contradiction rather than a one-sided omission.  This
    // also covers Japanese full-width month/day text where precise parsing is
    // unavailable but the surrounding fiscal-year headers are source-bound.
    return Boolean(targetPeriods.length && referencePeriods.length)
      && !targetPeriods.some(period => referencePeriods.includes(period));
  }
  if (targetPrecisePeriods.length && referencePrecisePeriods.length) {
    return !targetPrecisePeriods.some(period => referencePrecisePeriods.includes(period));
  }
  // A missing period is incomplete evidence, not an explicit contradiction.
  // Keep this veto for two-sided source-bound rows only; callers that require
  // a positive equivalence proof still use sourceContextPeriodsCompatible.
  if (!targetPeriods.length || !referencePeriods.length) return false;
  // Context windows can legitimately expose extra surrounding periods on one
  // side (for example an English two-year table versus a Japanese table that
  // also includes the preceding-period header).  That is not a contradiction
  // when the two windows still share an explicit period.  Veto only when the
  // explicit period sets are disjoint.
  return !targetPeriods.some(period => referencePeriods.includes(period));
}

function narrativeTokenNegative(text, token, sourceTable = false) {
  const raw = String(token?.raw || "").trim();
  if (/^[+＋]/u.test(raw)) return false;
  if (/^(?:[-−△▲]|\(.*\))/u.test(raw)) return true;
  if (sourceTable) return Boolean(token?.negative);
  // Narrative sentences often put the prior-period amount in a following
  // parenthetical: `328億円(前年同期は461億円の損失)`.  A broad window would
  // leak the later `損失` onto the current 328 and make a valid rounded pair
  // look like a sign mismatch.  Keep the local clause around this token while
  // retaining the preceding context needed for `used ...` cash-flow wording.
  const source = String(text || "");
  const start = Math.max(0, Number(token?.index) || 0);
  const end = Math.max(start, Number(token?.end) || start);
  let left = source.slice(Math.max(0, start - 96), start);
  let right = source.slice(end, Math.min(source.length, end + 96));
  const nextOpening = right.search(/[（(]/u);
  if (nextOpening >= 0) right = right.slice(0, nextOpening);
  const previousClosing = Math.max(left.lastIndexOf("）"), left.lastIndexOf(")"));
  if (previousClosing >= 0) left = left.slice(previousClosing + 1);
  const nearby = `${left} ${right}`;
  if (cashFlowKind(text)) return semanticNegativeCashFlow(text, token);
  return /(?:損失|loss|decrease|decreased|negative|減少|マイナス)/iu.test(nearby)
    || Boolean(token?.negative);
}

function narrativeTokenIsPrior(token) {
  return Boolean(token?.scopeKeys?.includes?.("prior"));
}

function sourceRowMeasureCompatibleWithToken(token, rowKeys, rowKind = "") {
  const tokenKeys = specificMeasureAliasKeys(token);
  const effectiveRows = new Set(rowKeys || []);
  if (rowKind) effectiveRows.add(`${rowKind}_cash_flow`);
  if (!tokenKeys.length || !effectiveRows.size) return true;
  return tokenKeys.some(key => effectiveRows.has(key));
}

function narrativeSourcePairCandidates(finding, left, right, context) {
  const targetText = String(context?.targetQuote || context?.target_quote || finding?.quote || "");
  const referenceText = String(context?.referenceQuote || context?.reference_quote
    || finding?.referenceQuote || finding?.reference_quote || "");
  let targets = left.filter(token => !token.rateEvidence && !token.symbol);
  let references = right.filter(token => !token.rateEvidence && !token.symbol);
  if (!targets.length || !references.length) return [];
  const currentTargets = targets.filter(token => !narrativeTokenIsPrior(token));
  // A narrative often repeats the prior-period amount after the current one.
  // Prefer the unmarked/current token when available; the counterpart table
  // may contain both columns and is selected by quantity + row identity below.
  if (currentTargets.length) targets = currentTargets;
  // Do not assume that the first table column is current.  Financial tables
  // commonly order prior -> current while the narrative puts current first.
  // Keep every source-bound column here and let the shared quantity interval,
  // sign, measure and period gates select exactly one compatible pair.  If two
  // columns remain compatible the caller sees two candidates and fails closed.
  const targetRow = String(context?.targetRowText || context?.target_row_text || "");
  const referenceRow = String(context?.referenceRowText || context?.reference_row_text || "");
  const targetRows = sourceRowMeasureKeys(targetRow);
  const referenceRows = sourceRowMeasureKeys(referenceRow);
  const targetKind = cashFlowKind(targetText);
  const referenceKind = cashFlowKind(referenceText);
  if (targetKind && referenceKind && targetKind !== referenceKind) return [];
  const sourceRowsAgree = Boolean(targetRows.length && referenceRows.length
    && targetRows.some(key => referenceRows.includes(key)));
  if (targetRows.length && referenceRows.length && !sourceRowsAgree) return [];
  return targets.flatMap(target => references.flatMap(reference => {
    if (!sourceRowMeasureCompatibleWithToken(target, targetRows, targetKind)
        || !sourceRowMeasureCompatibleWithToken(reference, referenceRows, referenceKind)) return [];
    if (narrativeTokenNegative(targetText, target)
        !== narrativeTokenNegative(referenceText, reference, true)) return [];
    // PDF token windows can inherit a neighbouring measure from the same
    // narrative sentence (for example pretax income before operating cash
    // flow). Once both unique source rows agree on the specific cash-flow row,
    // their row identity is stronger than that token-local leakage.
    if ((!sourceRowsAgree && explicitMeasureMismatch(target, reference))
        || explicitScopeMismatch(target, reference)
        || explicitPeriodMismatch(target, reference)
        || unknownIdentityLabelMismatch(target, reference)) return [];
    const targetUnit = sourceUnitDescriptor(context, "target");
    const referenceUnit = sourceUnitDescriptor(context, "reference");
    if (!targetUnit || !referenceUnit || targetUnit.currency !== referenceUnit.currency
        || !Number.isInteger(targetUnit.scale) || !Number.isInteger(referenceUnit.scale)) return [];
    const targetScale = target.scaleExp || target.rowScaleExp || 0;
    const referenceScale = reference.scaleExp || reference.rowScaleExp || 0;
    if (target.scaleKnown && targetScale && targetScale !== targetUnit.scale) return [];
    if (reference.scaleKnown && referenceScale && referenceScale !== referenceUnit.scale) return [];
    if (!quantityIntervalsOverlap(
      { ...target, negative: narrativeTokenNegative(targetText, target), scaleExp: targetUnit.scale, rowScaleExp: 0, scaleKnown: true },
      { ...reference, negative: narrativeTokenNegative(referenceText, reference, true), scaleExp: referenceUnit.scale, rowScaleExp: 0, scaleKnown: true },
    )) return [];
    return [{ target, reference }];
  }));
}

// Narrative amount units are sometimes rounded at the displayed unit.  For
// example, 328億円 denotes a range that overlaps 32,836百万円, even though
// their exact displayed values differ.  This proof is deliberately source
// bound: a unique measure row, an explicitly matching period, and a
// currency/unit descriptor on both sides are all required.  It is shared by
// bilingual TARGET/REF findings and same-PDF page counterparts.
function sourceBoundNarrativeAmountEquivalent(finding, left, right, context = {}) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  const sameDocument = Boolean(context?.sameDocumentSourceValidated);
  const allowedScope = /(?:translation_consistency|mistranslation)/.test(scope)
    || (sameDocument && /(?:consistency|value_inconsistency|number_mismatch)/.test(scope));
  if (!allowedScope || !left.length || !right.length
      || !sourceContextPeriodsCompatible(context)) return false;
  const targetUnit = sourceUnitDescriptor(context, "target");
  const referenceUnit = sourceUnitDescriptor(context, "reference");
  if (!targetUnit || !referenceUnit || targetUnit.currency !== referenceUnit.currency
      || !Number.isInteger(targetUnit.scale) || !Number.isInteger(referenceUnit.scale)) return false;
  if (sameDocument) {
    const candidates = narrativeSourcePairCandidates(finding, left, right, context);
    return candidates.length === 1;
  }
  if (left.length !== 1 || right.length !== 1
      || !sourceContextIdentityCompatible(context, finding)) return false;
  const target = left[0];
  const reference = right[0];
  if (!target || !reference || target.negative !== reference.negative
      || target.rateEvidence || reference.rateEvidence
      || explicitMeasureMismatch(target, reference)
      || explicitScopeMismatch(target, reference)
      || explicitPeriodMismatch(target, reference)
      || unknownIdentityLabelMismatch(target, reference)) return false;
  const targetScale = target.scaleExp || target.rowScaleExp || 0;
  const referenceScale = reference.scaleExp || reference.rowScaleExp || 0;
  if (target.scaleKnown && targetScale && targetScale !== targetUnit.scale) return false;
  if (reference.scaleKnown && referenceScale && referenceScale !== referenceUnit.scale) return false;
  return quantityIntervalsOverlap({ ...target, scaleExp: targetUnit.scale, rowScaleExp: 0, scaleKnown: true },
    { ...reference, scaleExp: referenceUnit.scale, rowScaleExp: 0, scaleKnown: true });
}

function sourceBoundNarrativeNeedsBothPrecisePeriods(finding, left, right, context = {}) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  if (!/(?:translation_consistency|mistranslation)/.test(scope)
      || left.length !== 1 || right.length !== 1) return false;
  const targetPrecisePeriods = sourceContextPrecisePeriodKeys(context, "target");
  const referencePrecisePeriods = sourceContextPrecisePeriodKeys(context, "reference");
  if (Boolean(targetPrecisePeriods.length) === Boolean(referencePrecisePeriods.length)) return false;
  const targetPeriods = sourceContextPeriodKeys(context, "target");
  const referencePeriods = sourceContextPeriodKeys(context, "reference");
  // A completely unlabelled counterpart note does not assert a competing
  // period.  Keep the strict veto when the other side carries an explicit
  // broad FY/year marker (or a second precise period), which is the genuine
  // one-sided-period mismatch case.
  if ((!targetPrecisePeriods.length && !targetPeriods.length)
      || (!referencePrecisePeriods.length && !referencePeriods.length)) return false;
  const targetUnit = sourceUnitDescriptor(context, "target");
  const referenceUnit = sourceUnitDescriptor(context, "reference");
  // This additional veto belongs only to the rounded narrative conversion
  // shape.  Generic source-row/vector equality must retain its legacy
  // one-sided-header behaviour (for example F0024's exact `(24)`/`△24` row).
  return Boolean(targetUnit && referenceUnit
    && targetUnit.currency === referenceUnit.currency
    && Number.isInteger(targetUnit.scale)
    && Number.isInteger(referenceUnit.scale)
    && targetUnit.scale !== referenceUnit.scale);
}

function sourceContextPeriodKeys(context, side) {
  const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "");
  const row = sourceContextRowLines(context, side).join(" ")
    || String(context?.[`${side}RowText`] || context?.[`${side}_row_text`] || "");
  return [...new Set([...fiscalYearKeys(`${text} ${row}`), ...sourceVectorPeriodKeys(`${text} ${row}`)])];
}

function precisePeriodMatches(value) {
  const text = String(value || "").normalize("NFKC");
  const matches = [];
  const add = (re, keyForMatch) => {
    for (const match of text.matchAll(re)) {
      const key = keyForMatch(match);
      if (key) matches.push({ index: match.index || 0, key });
    }
  };
  const normalizeYear = value => {
    const year = String(value || "");
    return year.length === 2 ? `20${year}` : year;
  };
  const monthNames = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const englishDate = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{4})\b/giu;
  add(englishDate, match => {
    const month = monthNames[String(match[1]).toLowerCase()];
    return month && `${match[3]}-${String(month).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
  });
  const japaneseDate = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/gu;
  add(japaneseDate, match => `${match[1]}-${String(match[2]).padStart(2, "0")}-${match[3] ? String(match[3]).padStart(2, "0") : "00"}`);
  const isoDate = /\b(\d{4})[-\/]([0-1]?\d)[-\/]([0-3]?\d)\b/g;
  add(isoDate, match => `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`);
  const ordinalNames = { first: 1, second: 2, third: 3, fourth: 4 };
  const ordinalWords = "first|second|third|fourth";
  const ordinalNumbers = "1st|2nd|3rd|4th";
  const fiscalYearPrefix = "(?:FY\\s*|fiscal\\s+(?:year\\s*)?|year\\s*)";
  add(new RegExp(`\\b(${ordinalWords})\\s+quarter(?:\\s+of)?\\s+${fiscalYearPrefix}?(\\d{2,4})\\b`, "giu"), match => `${normalizeYear(match[2])}-Q${ordinalNames[String(match[1]).toLowerCase()]}`);
  add(new RegExp(`\\b(${ordinalNumbers})\\s+quarter(?:\\s+of)?\\s+${fiscalYearPrefix}?(\\d{2,4})\\b`, "giu"), match => `${normalizeYear(match[2])}-Q${Number.parseInt(match[1], 10)}`);
  add(new RegExp(`\\b${fiscalYearPrefix}(\\d{2,4})\\s+(${ordinalWords})\\s+quarter\\b`, "giu"), match => `${normalizeYear(match[1])}-Q${ordinalNames[String(match[2]).toLowerCase()]}`);
  add(new RegExp(`\\b${fiscalYearPrefix}(\\d{2,4})\\s+(${ordinalNumbers})\\s+quarter\\b`, "giu"), match => `${normalizeYear(match[1])}-Q${Number.parseInt(match[2], 10)}`);
  add(new RegExp(`\\bQ\\s*([1-4])(?:\\s+of\\s*)?${fiscalYearPrefix}?(\\d{2,4})\\b`, "giu"), match => `${normalizeYear(match[2])}-Q${match[1]}`);
  add(new RegExp(`\\b${fiscalYearPrefix}(\\d{2,4})\\s*[-\\/]?\\s*Q\\s*([1-4])\\b`, "giu"), match => `${normalizeYear(match[1])}-Q${match[2]}`);
  const quarterPatterns = [
    /\b(?:Q|quarter\s*)([1-4])\s*[-/]?\s*(\d{4})\b/giu,
    /\b(\d{4})\s*[-/]?\s*(?:Q|quarter\s*)([1-4])\b/giu,
    /(?<!\d)(\d{4})\s*年\s*\d{1,2}\s*月期?\s*(?:第\s*)?([1-4])\s*四半期/gu,
    /(?<!\d)(\d{4})\s*年\s*(?:第\s*)?([1-4])\s*四半期/gu,
    /(?:第\s*)?([1-4])\s*四半期\s*(\d{4})\s*年?/gu,
  ];
  for (const pattern of quarterPatterns) {
    for (const match of text.matchAll(pattern)) {
      const year = /^\d{4}$/.test(match[1]) ? match[1] : match[2];
      const quarter = /^\d{4}$/.test(match[1]) ? match[2] : match[1];
      matches.push({ index: match.index || 0, key: year + "-Q" + quarter });
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

// Keep exact month/day and quarter identity on the cited source row. The
// context window also contains preceding rows/headers for unit binding; using
// every date in that window can incorrectly pair a June row with a September
// header. If the cited row has no marker, use only the nearest preceding one.
function sourceContextPrecisePeriodKeys(context, side) {
  const text = String(context?.[side + "Text"] || context?.[side + "_context"] || "");
  const rowLines = sourceContextRowLines(context, side);
  const rowText = String(context?.[side + "RowText"] || context?.[side + "_row_text"] || "");
  const textLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const normalized = value => String(value || "").replace(/[ \t\u00a0]+/g, " ").trim();
  const wantedLines = rowLines.map(normalized).filter(Boolean);
  let rowStart = -1;
  if (wantedLines.length) {
    for (let index = 0; index <= textLines.length - wantedLines.length; index++) {
      if (wantedLines.every((line, offset) => normalized(textLines[index + offset]) === line)) {
        rowStart = index;
        break;
      }
    }
  }
  if (rowStart < 0 && rowText) rowStart = textLines.findIndex(line => normalized(line) === normalized(rowText));
  if (rowStart < 0) rowStart = Math.max(0, textLines.length - Math.max(1, wantedLines.length || 1));
  const citedText = (wantedLines.length ? wantedLines : (rowText ? [rowText] : [])).join("\n");
  const normalizedPeriodKeys = matches => {
    const keys = [...new Set(matches.map(match => match.key))];
    const quarterKeys = keys.filter(key => /-Q[1-4]$/u.test(key));
    return quarterKeys.length
      ? keys.filter(key => !/^\d{4}-\d{2}-00$/u.test(key)
        || !quarterKeys.some(quarter => quarter.startsWith(key.slice(0, 4))))
      : keys;
  };
  const citedMatches = precisePeriodMatches(citedText);
  if (citedMatches.length) {
    // Japanese fiscal-quarter headers commonly expose both the fiscal year
    // end month (`2027年3月期`) and the quarter (`第1四半期`), whereas the
    // translated table says only `FY2027 first quarter`.  The fiscal-month
    // token is a header form of the quarter, not a second reporting period;
    // normalize it when a same-year quarter key is present.  Standalone
    // month/day keys remain precise and continue to veto a mismatch.
    return normalizedPeriodKeys(citedMatches);
  }
  for (let index = rowStart - 1; index >= 0; index--) {
    const precedingMatches = precisePeriodMatches(textLines[index]);
    if (precedingMatches.length) return normalizedPeriodKeys(precedingMatches);
  }
  return [];
}

function sourceRowMeasureKeys(row) {
  const text = String(row || "");
  const tokens = extractNumericEvidence(text);
  const keys = [...new Set(tokens.flatMap(token => token.measureKeys || []).filter(Boolean))];
  // Generic `equity` can come from a statement heading rather than the row;
  // retain the specific aliases whenever one is available.
  const specific = keys.filter(key => !["profit", "loss", "assets", "liabilities", "cost", "cash_flow", "equity"].includes(key));
  return specific.length ? specific : keys;
}

function sourceRowPeriodKeys(row) {
  return [...new Set([...fiscalYearKeys(row), ...sourceVectorPeriodKeys(row)])];
}

function sourceRowsHaveCompatibleIdentity(leftRows, rightRows, leftContext, rightContext) {
  if (!leftRows.length || leftRows.length !== rightRows.length) return false;
  let identified = false;
  for (let index = 0; index < leftRows.length; index++) {
    const left = sourceRowMeasureKeys(leftRows[index]);
    const right = sourceRowMeasureKeys(rightRows[index]);
    if (!left.length || !right.length || !left.some(key => right.includes(key))) return false;
    identified = true;
    const leftPeriods = sourceRowPeriodKeys(leftRows[index]);
    const rightPeriods = sourceRowPeriodKeys(rightRows[index]);
    if (leftPeriods.length && rightPeriods.length
        && !leftPeriods.some(key => rightPeriods.includes(key))) return false;
  }
  // If both documents state periods around the cited rows, they must describe
  // the same period set.  One-sided omission is common in translated tables
  // and is therefore not treated as a mismatch.
  const leftPeriods = sourceContextPeriodKeys(leftContext, "target");
  const rightPeriods = sourceContextPeriodKeys(rightContext, "reference");
  if (leftPeriods.length && rightPeriods.length
      && (leftPeriods.length !== rightPeriods.length
        || leftPeriods.some(key => !rightPeriods.includes(key)))) return false;
  return identified;
}

function sourceBackedMultiRowVectorEquivalent(finding, left, right, context = {}) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  if (!/(?:translation_consistency|mistranslation)/.test(scope)) return false;
  if (!left.length || left.length !== right.length) return false;
  const rowsWithLabels = (side) => {
    const lines = sourceContextRowLines(context, side);
    return lines.map((line, index) => {
      if (!extractNumericEvidence(line).length) return null;
      if (sourceRowMeasureKeys(line).length) return line;
      const previous = index > 0 ? lines[index - 1] : "";
      return [previous, line].filter(Boolean).join(" ");
    }).filter(Boolean);
  };
  const targetRows = rowsWithLabels("target");
  const referenceRows = rowsWithLabels("reference");
  if (targetRows.length < 2 || targetRows.length !== referenceRows.length) return false;
  const targetTokens = targetRows.flatMap(row => extractNumericEvidence(row));
  if (targetTokens.length !== left.length) return false;
  // The target quote must be exactly the source row vector.  The reference PDF
  // may contain a neighbouring table on the same visual line; its cited row is
  // therefore allowed to contain extra cells, but the quoted cells must still
  // occur as a unique ordered subsequence on each corresponding source row.
  if (targetTokens.some((token, index) => canonicalNumericKey(token) !== canonicalNumericKey(left[index]))) return false;
  if (!sourceRowsHaveCompatibleIdentity(targetRows, referenceRows, context, context)) return false;

  const targetUnit = sourceUnitDescriptor(context, "target");
  const referenceUnit = sourceUnitDescriptor(context, "reference");
  if (!targetUnit || !referenceUnit || targetUnit.currency !== referenceUnit.currency) return false;
  let offset = 0;
  for (let rowIndex = 0; rowIndex < targetRows.length; rowIndex++) {
    const targetRowTokens = extractNumericEvidence(targetRows[rowIndex]);
    const referenceRowTokens = extractNumericEvidence(referenceRows[rowIndex]);
    const wantedRight = right.slice(offset, offset + targetRowTokens.length);
    const matchingStarts = [];
    for (let start = 0; start <= referenceRowTokens.length - wantedRight.length; start++) {
      if (wantedRight.every((token, index) => canonicalNumericKey(token)
        && canonicalNumericKey(token) === canonicalNumericKey(referenceRowTokens[start + index]))) matchingStarts.push(start);
    }
    if (matchingStarts.length !== 1) return false;
    const selectedReferenceTokens = referenceRowTokens.slice(matchingStarts[0], matchingStarts[0] + wantedRight.length);
    if (targetRowTokens.length !== wantedRight.length) return false;
    for (let column = 0; column < targetRowTokens.length; column++) {
      const a = left[offset], b = right[offset];
      const sourceA = targetRowTokens[column], sourceB = selectedReferenceTokens[column];
      if (!a || !b || a.negative !== b.negative || sourceA.negative !== a.negative
          || sourceB.negative !== b.negative) return false;
      if (Boolean(a.rateEvidence) !== Boolean(b.rateEvidence)
          || Boolean(sourceA.rateEvidence) !== Boolean(a.rateEvidence)
          || Boolean(sourceB.rateEvidence) !== Boolean(b.rateEvidence)) return false;
      if (a.rateEvidence || b.rateEvidence) {
        if (canonicalNumericKey(a) !== canonicalNumericKey(b)) return false;
      } else if (!scaledNumericValuesEqual(a, b, targetUnit.scale, referenceUnit.scale)) {
        // Amounts must be equal after the source-backed unit conversion.  No
        // tolerance is applied here; the displayed decimals already encode the
        // permitted rounding and the strict value interval is handled by the
        // one-value path.  A true value difference remains a finding.
        return false;
      }
      // A source row's explicit metric must agree with the quote token's
      // identity when both are available.  This catches a swapped metric even
      // when the values and unit conversion happen to match.
      if (sourceA.measureExplicit && a.measureExplicit && sourceA.measureKey !== a.measureKey) return false;
      if (sourceB.measureExplicit && b.measureExplicit && sourceB.measureKey !== b.measureKey) return false;
      offset++;
    }
  }
  return true;
}

// Some exports concatenate several generated candidates into model_reason:
// the first sentence is the canonical claim and every subsequent
// `（同じ箇所の別案: ...）` block is an alternative for the UI.  Alternatives
// are not independent evidence for numeric self-consistency; accepting them as
// such lets a stale value in one candidate override the canonical claim.
function canonicalClaimText(value) {
  const source = String(value || "");
  // Producers may concatenate alternatives directly after the canonical
  // sentence (without a newline), so locate the marker anywhere in the field.
  const marker = source.search(/[（(]\s*同じ箇所の別案\s*:/u);
  return (marker >= 0 ? source.slice(0, marker) : source).trim();
}

function canonicalClaimsCompatible(finding, masker = null) {
  const reason = canonicalClaimText(finding?.reason);
  const modelReason = canonicalClaimText(finding?.model_reason);
  if (!reason || !modelReason) return true;
  const left = extractNumericEvidence(reason, masker);
  const right = extractNumericEvidence(modelReason, masker);
  // A nonnumeric wording difference does not affect the source-backed proof.
  // Once both claims carry numeric evidence, a difference is contradictory and
  // must keep the finding visible rather than choosing one model field.
  if (left.length && right.length) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (canonicalNumericKey(left[index]) !== canonicalNumericKey(right[index])
          || left[index].negative !== right[index].negative
          || Boolean(left[index].rateEvidence) !== Boolean(right[index].rateEvidence)) return false;
    }
    if (hasExplicitIdentityMismatch(left, right)) return false;
  }
  return true;
}

function auxiliaryIdentityEvidence(value, masker = null) {
  const text = canonicalClaimText(value);
  const tokens = extractNumericEvidence(text, masker);
  const periods = claimPeriodDescriptor(text);
  const page = parsePageMarkers(text);
  const signed = new Map();
  for (const token of tokens) {
    const key = canonicalNumericKey(token);
    if (!key) continue;
    const start = Number(token.index) || 0;
    const end = Number(token.end) || start;
    const nearby = text.slice(Math.max(0, start - 14), Math.min(text.length, end + 14));
    const raw = String(token.raw || "");
    const explicit = /^[+＋\-−△▲]/u.test(raw)
      || /^\s*\(/u.test(raw)
      || /(?:\b(?:positive|negative|plus|minus)\b|正(?:の|数)|負(?:の|数)|プラス|マイナス)/iu.test(nearby);
    if (explicit) {
      if (!signed.has(key)) signed.set(key, new Set());
      signed.get(key).add(Boolean(token.negative));
    }
  }
  return {
    text,
    measures: new Set(explicitMeasureKeysFromText(text)),
    scopes: new Set(clauseScopeKeys(text, tokens)),
    currencies: new Set(currencyCodes(text)),
    periods,
    page,
    quotes: new Set(completeQuotedClauses(text)),
    signed,
  };
}

function evidenceSetsConflict(left, right) {
  if (!left?.size || !right?.size) return false;
  return ![...left].some(value => right.has(value));
}

function scopeEvidenceConflicts(left, right) {
  if (!left?.size || !right?.size) return false;
  const alternatives = [
    ["consolidated", "standalone"],
    ["actual", "forecast"],
    ["current", "prior"],
    ["domestic", "overseas"],
  ];
  return alternatives.some(([first, second]) =>
    (left.has(first) && right.has(second)) || (left.has(second) && right.has(first)));
}

function periodEvidenceConflicts(left, right) {
  for (const key of ["fiscalYears", "completeDates", "quarters"]) {
    const leftValues = left?.[key], rightValues = right?.[key];
    // A narrative may legitimately mention both the current and prior period
    // (or several columns).  Treat only two unambiguous, explicit identities
    // as a contradiction.
    if (leftValues?.size === 1 && rightValues?.size === 1
        && evidenceSetsConflict(leftValues, rightValues)) return true;
  }
  return false;
}

// A page-labelled claim has a separate strict preflight, but an unpaginated
// canonical field can still carry an explicit choice between incompatible
// periods.  Do not interpret ordinary current/prior or multi-column prose as
// contradictory; require a textual alternative connector between distinct
// period terms (for example `FY2027またはFY2028`).
function periodEvidenceHasExplicitAlternative(value) {
  const text = String(value || "").normalize("NFKC");
  const descriptor = claimPeriodDescriptor(text);
  const multiple = descriptor.fiscalYears.size > 1
    || descriptor.completeDates.size > 1
    || descriptor.quarters.size > 1;
  if (!multiple) return false;
  const periodTermRe = /(?:\bFY\s*\d{2,4}\b|(?<!\d)\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}\b|\b(?:Q[1-4]|first|second|third|fourth)\s+quarter\b|第\s*[1-4]\s*四半期)/giu;
  const terms = [...text.matchAll(periodTermRe)].map(match => ({
    raw: normalizeQuote(match[0]),
    index: match.index || 0,
    end: (match.index || 0) + match[0].length,
  }));
  const alternative = /(?:\bor\b|either|または|又は|もしくは|あるいは|／|\/)/iu;
  for (let leftIndex = 0; leftIndex < terms.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < terms.length; rightIndex++) {
      if (terms[leftIndex].raw.toLowerCase() === terms[rightIndex].raw.toLowerCase()) continue;
      const between = text.slice(terms[leftIndex].end, terms[rightIndex].index);
      if (alternative.test(between)) return true;
    }
  }
  return false;
}

function sourceQuoteEvidenceCompatible(left, right) {
  const a = normalizeQuote(left), b = normalizeQuote(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function explicitSignPolarity(value) {
  const text = String(value || "");
  const positive = /(?:符号|sign|symbol|記号).{0,20}(?:正|positive|プラス)|(?:正の符号|positive\s+sign)/iu.test(text);
  const negative = /(?:符号|sign|symbol|記号).{0,20}(?:負|negative|マイナス)|(?:負の符号|negative\s+sign)/iu.test(text);
  if (positive && negative) return "ambiguous";
  return positive ? "positive" : negative ? "negative" : "";
}

function canonicalAuxiliaryEvidenceContradiction(finding, masker = null, context = {}) {
  const values = [finding?.reason, finding?.model_reason, finding?.issueSummary,
    finding?.issue_summary, finding?.suggestion]
    .map(value => String(value || ""))
    .filter(value => value.trim());
  const evidence = values.map(value => auxiliaryIdentityEvidence(value, masker));
  const unpaginatedCanonicalValues = [finding?.reason, finding?.model_reason,
    finding?.issueSummary, finding?.issue_summary]
    .map(value => String(value || ""))
    .filter(value => value.trim() && !claimPageEvidencePresent(value));
  // This is deliberately a field-local veto: a matching peer or a verified
  // counterpart cannot authorize a canonical field that explicitly presents
  // two incompatible periods as alternatives.
  if (unpaginatedCanonicalValues.some(periodEvidenceHasExplicitAlternative)) return true;
  const pageEvidence = evidence.filter(item => item.page.markers.length || item.page.malformed.length);
  // A compact summary may mention only the counterpart page without any
  // numeric/quoted source claim.  It is metadata and must not invalidate an
  // independently source-bound two-endpoint amount claim.  Malformed,
  // duplicate, or third-page markers remain hard ambiguity evidence.
  const pageShapeEvidence = pageEvidence.filter(item => item.page.malformed.length
    || item.page.markers.length !== 1
    || extractNumericEvidence(item.text, masker).length
    || item.quotes.size);
  const strictPageEvidence = Array.isArray(finding?.counterparts)
    || Array.isArray(finding?.counterParts)
    || Boolean(context?.targetRowUnique && context?.referenceRowUnique);
  // A validated source pair has exactly the finding page and one counterpart
  // endpoint.  A page-only summary/issue label outside that pair is not
  // harmless metadata: it makes the canonical claim ambiguous and must keep
  // the finding visible.  Derive the pair only from an `ok` counterpart,
  // source-validated context, or a two-endpoint page claim already present in
  // the strict preflight; never invent an endpoint from a lone marker.
  const endpointPages = new Set();
  const findingPage = Number(finding?.page);
  if (Number.isInteger(findingPage)) endpointPages.add(findingPage);
  const verifiedCounterpartPages = counterpartRecords(finding)
    .filter(record => String(record?.status || "").toLowerCase() === "ok")
    .map(record => Number(record?.page))
    .filter(page => Number.isInteger(page));
  if (verifiedCounterpartPages.length === 1) endpointPages.add(verifiedCounterpartPages[0]);
  if (context?.sameDocumentSourceValidated === true && Number.isInteger(Number(context?.referencePage))) {
    endpointPages.add(Number(context.referencePage));
  }
  if (strictPageEvidence && endpointPages.size !== 2) {
    const pairedClaims = pageEvidence
      .map(item => [...new Set(item.page.markers.map(marker => marker.page))])
      .filter(pages => pages.length === 2 && Number.isInteger(findingPage) && pages.includes(findingPage));
    const distinctPairs = new Map(pairedClaims.map(pages => [pages.slice().sort((a, b) => a - b).join(","), pages]));
    if (distinctPairs.size === 1) {
      endpointPages.clear();
      for (const page of [...distinctPairs.values()][0]) endpointPages.add(page);
    }
  }
  if (strictPageEvidence && endpointPages.size === 2
      && pageEvidence.some(item => item.page.markers.length === 1
        && !item.page.malformed.length
        && !extractNumericEvidence(item.text, masker).length
        && !item.quotes.size
        && !endpointPages.has(item.page.markers[0].page))) return true;
  // A page-labelled alias is source evidence, not free-form wording.  Any
  // malformed, missing-side, duplicate, or third marker is an ambiguity veto;
  // the strict page preflight will then keep the finding visible.
  if (strictPageEvidence && pageShapeEvidence.some(item => item.page.malformed.length
    || item.page.markers.length !== 2
    || new Set(item.page.markers.map(marker => marker.page)).size !== 2)) return true;
  if (strictPageEvidence && pageShapeEvidence.length > 1) {
    const firstPages = new Set(pageShapeEvidence[0].page.markers.map(marker => marker.page));
    if (pageShapeEvidence.slice(1).some(item => {
      const pages = new Set(item.page.markers.map(marker => marker.page));
      return pages.size !== firstPages.size || [...pages].some(page => !firstPages.has(page));
    })) return true;
  }
  // A source quote introduced by one alias is not harmless prose.  Compare
  // each populated field with the primary/verified source anchors and with
  // its peers; an unrelated quote in only one reason/summary/suggestion is a
  // contradiction even when every numeric token still repeats the valid pair.
  const verifiedSourceAnchors = validatedSameDocumentSourceAnchors(finding, context);
  const anchoredQuotes = [finding?.quote, finding?.referenceQuote, finding?.reference_quote]
    .flatMap(value => completeQuotedClauses(value))
    .concat(counterpartRecords(finding).flatMap(record => completeQuotedClauses(
      record?.quote || record?.text || "",
    )))
    // A validated source quote is often a bare row label or an un-delimited
    // sentence in the finding payload.  It is safe to use only after the
    // same-document validator has bound both endpoints to extracted text.
    .concat(verifiedSourceAnchors);
  const hasPeerQuoteAnchor = anchoredQuotes.length > 0 || strictPageEvidence
    || Boolean(context?.targetRowUnique && context?.referenceRowUnique);
  for (let fieldIndex = 0; fieldIndex < evidence.length; fieldIndex++) {
    if (!hasPeerQuoteAnchor) continue;
    const ownQuotes = [...evidence[fieldIndex].quotes]
      .filter(quote => /[\p{L}]/u.test(quote) && !isGenericSourceFragment(quote));
    if (!ownQuotes.length) continue;
    const peerQuotes = anchoredQuotes.concat(
      evidence.flatMap((item, index) => index === fieldIndex ? [] : [...item.quotes]),
    ).filter(quote => /[\p{L}]/u.test(quote) && !isGenericSourceFragment(quote));
    if (ownQuotes.some(quote => !peerQuotes.some(peer => sourceQuoteEvidenceCompatible(quote, peer)))) return true;
  }
  // Explicit sign and scope assertions are mismatch evidence, not an
  // authorization shortcut.  Check them per field so a terse summary or
  // suggestion cannot borrow a valid peer's numeric proof.
  const polarities = values.map(value => explicitSignPolarity(value));
  if (polarities.includes("ambiguous")) return true;
  for (let fieldIndex = 0; fieldIndex < evidence.length; fieldIndex++) {
    const polarity = polarities[fieldIndex];
    if (!polarity) continue;
    const ownSigns = new Set([...evidence[fieldIndex].signed.values()].flatMap(signs => [...signs]));
    const expectedNegative = polarity === "negative";
    if (ownSigns.size && [...ownSigns].every(sign => sign !== expectedNegative)) return true;
    for (let peerIndex = 0; peerIndex < evidence.length; peerIndex++) {
      if (peerIndex === fieldIndex) continue;
      for (const [key, signs] of evidence[peerIndex].signed) {
        const own = evidence[fieldIndex].signed.get(key);
        if (own && own.has(!expectedNegative) && signs.has(expectedNegative)) return true;
        if (!own && signs.size === 1 && signs.has(!expectedNegative)) return true;
      }
    }
    if (!ownSigns.size && evidence.some((item, index) => index !== fieldIndex
      && [...item.signed.values()].some(signs => signs.size === 1 && signs.has(!expectedNegative)))) return true;
  }
  if (strictPageEvidence || (context?.targetRowUnique && context?.referenceRowUnique)) {
    const explicitScopes = evidence.map(item => new Set(item.scopes));
    for (let fieldIndex = 0; fieldIndex < explicitScopes.length; fieldIndex++) {
      if (!explicitScopes[fieldIndex].has("standalone")) continue;
      const peerScopes = new Set(explicitScopes.flatMap((scopes, index) => index === fieldIndex ? [] : [...scopes]));
      if (!peerScopes.size || peerScopes.has("consolidated")) return true;
    }
  }
  for (let leftIndex = 0; leftIndex < evidence.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < evidence.length; rightIndex++) {
      const left = evidence[leftIndex], right = evidence[rightIndex];
      const leftSpecificMeasures = new Set([...left.measures].filter(key => !GENERIC_MEASURE_KEYS.has(key)));
      const rightSpecificMeasures = new Set([...right.measures].filter(key => !GENERIC_MEASURE_KEYS.has(key)));
      // A generic `cash flow`/`profit` instruction does not contradict a
      // source-bound operating/investing/financing row. Only two distinct,
      // explicit specific measures are mismatch evidence.
      const singleMeasureConflict = leftSpecificMeasures.size === 1 && rightSpecificMeasures.size === 1
        && evidenceSetsConflict(leftSpecificMeasures, rightSpecificMeasures);
      const singleScopeConflict = scopeEvidenceConflicts(left.scopes, right.scopes);
      const singleCurrencyConflict = left.currencies.size === 1 && right.currencies.size === 1
        && evidenceSetsConflict(left.currencies, right.currencies);
      const leftSourceQuotes = [...left.quotes].filter(quote => /[\p{L}]/u.test(quote));
      const rightSourceQuotes = [...right.quotes].filter(quote => /[\p{L}]/u.test(quote));
      const singleQuoteConflict = leftSourceQuotes.length === 1 && rightSourceQuotes.length === 1
        && !rightSourceQuotes.includes(leftSourceQuotes[0]);
      if (singleMeasureConflict
          || singleScopeConflict
          || singleCurrencyConflict
          || periodEvidenceConflicts(left.periods, right.periods)
          || singleQuoteConflict) return true;
      for (const [key, signs] of left.signed) {
        const other = right.signed.get(key);
        if (other && [...signs].every(sign => !other.has(sign))) return true;
      }
    }
  }
  return false;
}

function numericAuxiliaryRestatesProof(values, provenValues) {
  if (!values?.length || !provenValues?.length || values.length !== provenValues.length) return false;
  const used = new Set();
  for (const value of values) {
    const index = provenValues.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)
          || canonicalNumericKey(value) !== canonicalNumericKey(candidate)
          || value.negative !== candidate.negative
          || Boolean(value.rateEvidence) !== Boolean(candidate.rateEvidence)
          || explicitMeasureMismatch(value, candidate)
          || explicitScopeMismatch(value, candidate)
          || explicitPeriodMismatch(value, candidate)
          || unknownIdentityLabelMismatch(value, candidate)) return false;
      const valueCurrency = value.currencyEvidence || value.rowCurrency || "";
      const candidateCurrency = candidate.currencyEvidence || candidate.rowCurrency || "";
      if (valueCurrency && candidateCurrency && valueCurrency !== candidateCurrency) return false;
      const valueScale = value.scaleExp || value.rowScaleExp || 0;
      const candidateScale = candidate.scaleExp || candidate.rowScaleExp || 0;
      const valueHasScale = Boolean(value.scaleCaption || valueScale);
      const candidateHasScale = Boolean(candidate.scaleCaption || candidateScale);
      if (valueHasScale && candidateHasScale && valueScale !== candidateScale) return false;
      return true;
    });
    if (index < 0) return false;
    used.add(index);
  }
  return used.size === provenValues.length;
}

function tocEntriesShareSemanticAnchor(leftText, rightText) {
  const pairs = [
    [/(?:cash\s*flows?|cashflow)/iu, /キャッシュ[・･\s-]*フロー/iu],
    [/(?:dividend|distribution\s+of\s+profit)/iu, /(?:配当|利益配分)/iu],
    [/(?:financial\s+results?|operating\s+results?)/iu, /(?:決算|業績)/iu],
    [/(?:forecast|outlook)/iu, /(?:予想|見通し)/iu],
    [/(?:net\s+sales|revenue)/iu, /(?:売上|収益)/iu],
    [/(?:shareholders?'?\s+equity|net\s+assets?)/iu, /(?:株主資本|純資産)/iu],
  ];
  if (pairs.some(([english, japanese]) =>
    (english.test(leftText) && japanese.test(rightText))
      || (japanese.test(leftText) && english.test(rightText)))) return true;
  // Same-language comparison remains safe when the nonnumeric title is
  // literally the same after removing the entry marker and leader/page tail.
  const title = value => normalizeQuote(String(value || "")
    .replace(/^\s*[([{（［]\s*[０-９\d]{1,3}\s*[\])}）］]/u, "")
    .replace(/(?:\.{3,}|…{2,}|⋯{2,}|・{3,}|･{3,})[\s０-９\d]*$/u, "")
    .replace(/\b(?:FY\s*)?\d{4}\b|\d{4}\s*年/giu, " ")
    .replace(/[^\p{L}]+/gu, " "));
  const leftTitle = title(leftText), rightTitle = title(rightText);
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

function tocTrailingPageOnlyEquivalent(finding, left, right, masker = null) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  if (!/(?:translation_consistency|mistranslation)/.test(scope)) return false;
  const leftText = String(finding?.quote || "");
  const rightText = String(finding?.referenceQuote ?? finding?.reference_quote ?? "");
  const claim = [finding?.issueSummary, finding?.issue_summary, finding?.reason,
    finding?.model_reason, finding?.suggestion].map(value => String(value || "")).join(" ");
  // The deterministic exception is only for a candidate whose own claim is
  // explicitly about the terminal page number.  A model that cites two
  // unrelated TOC entries must not have their structural numbers erased.
  if (!/(?:page\s*(?:number|no\.?|reference)|(?:掲載|参照)?ページ番号)/iu.test(claim)
      || !tocEntriesShareSemanticAnchor(leftText, rightText)) return false;
  // A TOC entry has a visible leader and a terminal page number.  Requiring a
  // numbered entry heading avoids treating a genuine section-number mismatch
  // such as `(2) Consolidated Cash Flows` vs `（３）...` as a page-only typo.
  const heading = /^\s*[([{（［]\s*[０-９\d]{1,3}\s*[\])}）］]/u;
  if (!heading.test(leftText) || !heading.test(rightText)) return false;
  const leader = /(?:\.{3,}|…{2,}|⋯{2,}|・{3,}|･{3,})/u;
  if (!leader.test(leftText) || !leader.test(rightText)) return false;
  const trailingPage = text => {
    const match = text.match(/(?:\.{3,}|…{2,}|⋯{2,}|・{3,}|･{3,})\s*([０-９\d]{1,3})\s*$/u);
    if (!match) return null;
    const page = Number(match[1].replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)));
    return Number.isInteger(page) && page > 0 && page <= 999 ? page : null;
  };
  const leftPage = trailingPage(leftText), rightPage = trailingPage(rightText);
  if (!leftPage || !rightPage) return false;
  const headingNumber = text => {
    const match = text.match(heading);
    return match ? Number(match[0].replace(/[^0-9０-９]/gu, "").replace(/[０-９]/g,
      char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))) : null;
  };
  // The entry number is structural evidence and must agree.  Other years in
  // the translated heading (F.Y. labels are commonly omitted on the Japanese
  // side) are not treated as a numeric mismatch; any remaining non-year
  // number must agree when both sides state one.
  if (headingNumber(leftText) !== headingNumber(rightText)) return false;
  // Remove only the terminal leader/page suffix.  All remaining numeric
  // evidence (section numbers, years, dates, etc.) must still match exactly;
  // the translated text itself is intentionally not compared.
  const stripPage = text => text.replace(/(?:\.{3,}|…{2,}|⋯{2,}|・{3,}|･{3,})\s*[０-９\d]{1,3}\s*$/u, "");
  const prefixWithoutHeading = text => stripPage(text).replace(/^\s*[([{（［]\s*[０-９\d]{1,3}\s*[\])}）］]/u, "");
  const leftPrefix = extractNumericEvidence(prefixWithoutHeading(leftText), masker);
  const rightPrefix = extractNumericEvidence(prefixWithoutHeading(rightText), masker);
  if (leftPrefix.length && rightPrefix.length) {
    if (leftPrefix.length !== rightPrefix.length) return false;
    if (leftPrefix.some((token, index) => canonicalNumericKey(token) !== canonicalNumericKey(rightPrefix[index])
        || token.negative !== rightPrefix[index].negative
        || Boolean(token.rateEvidence) !== Boolean(rightPrefix[index].rateEvidence))) return false;
  }
  // `extractNumericEvidence` intentionally drops structural/page numbers.
  // Reject a second, non-year numeric claim when it is present on only one
  // translated side; this keeps the page-only exception narrow without
  // requiring literal equality of translated headings.
  const structuralNumbers = text => [...prefixWithoutHeading(text).matchAll(/(?<![\d])\d[\d,]*(?:\.\d+)?/gu)]
    .map(match => match[0].replace(/,/g, ""))
    .filter(value => value.length !== 4);
  const leftStructural = structuralNumbers(leftText), rightStructural = structuralNumbers(rightText);
  if (leftStructural.length && rightStructural.length
      && (leftStructural.length !== rightStructural.length
        || leftStructural.some((value, index) => value !== rightStructural[index]))) return false;
  if ((leftStructural.length > 0) !== (rightStructural.length > 0)
      && (leftStructural.length || rightStructural.length)) return false;
  return true;
}


function explicitAmountTokens(value, masker = null) {
  return extractNumericEvidence(value, masker).filter(token => !token.rateEvidence
    && (token.scaleExp || token.rowScaleExp || token.currencyEvidence || token.rowCurrency));
}

function canonicalScaledClaimEquivalent(primaryText, primary, auxiliaryText, auxiliary, finding, masker = null, context = {}) {
  if (!primary?.length || !auxiliary?.length) return false;
  // Cash-flow page claims are especially prone to a model restating both
  // values in prose.  Do not let this generic scaled proof authorize a
  // page-bound drop without the same verified counterpart/source binding used
  // by the dedicated page-bound proof.
  if (cashFlowKind(primaryText)
      && claimPageSegments(auxiliaryText, masker).length === 2
      && !pageClaimSourceAuthorization(auxiliaryText, finding, context)) return false;
  const clauses = comparisonClauses(auxiliaryText);
  const candidates = clauses.map(clause => ({
    clause,
    amounts: explicitAmountTokens(clause, masker),
    tokens: extractNumericEvidence(clause, masker),
  })).filter(item => item.amounts.length);
  // A canonical two-sided claim is exactly two sentence/clauses with one
  // explicitly scaled/currency-qualified amount each.  Any additional amount
  // is treated as an unbounded competing claim and fails closed.
  if (candidates.length !== 2 || candidates.some(item => item.amounts.length !== 1)) return false;
  const first = candidates[0].amounts[0], second = candidates[1].amounts[0];
  if (first.symbol || second.symbol || first.rateEvidence || second.rateEvidence) return false;
  const firstCurrency = first.currencyEvidence || first.rowCurrency || "";
  const secondCurrency = second.currencyEvidence || second.rowCurrency || "";
  const firstScale = first.scaleExp || first.rowScaleExp || 0;
  const secondScale = second.scaleExp || second.rowScaleExp || 0;
  if (!firstCurrency || firstCurrency !== secondCurrency || !firstScale || !secondScale) return false;

  const firstMeasures = clauseMeasureKeys(candidates[0].clause, candidates[0].tokens);
  const secondMeasures = clauseMeasureKeys(candidates[1].clause, candidates[1].tokens);
  if (firstMeasures.length && secondMeasures.length
      && !firstMeasures.some(key => secondMeasures.includes(key))) return false;
  const firstScopes = clauseScopeKeys(candidates[0].clause, candidates[0].tokens);
  const secondScopes = clauseScopeKeys(candidates[1].clause, candidates[1].tokens);
  if (firstScopes.length && secondScopes.length
      && !firstScopes.some(key => secondScopes.includes(key))) return false;
  const firstKind = cashFlowKind(candidates[0].clause);
  const secondKind = cashFlowKind(candidates[1].clause);
  if (firstKind && secondKind && firstKind !== secondKind) return false;
  const firstYears = [...new Set([...fiscalYearKeys(candidates[0].clause), ...periodYearSequence(candidates[0].clause)])];
  const secondYears = [...new Set([...fiscalYearKeys(candidates[1].clause), ...periodYearSequence(candidates[1].clause)])];
  if (firstYears.length && secondYears.length && !firstYears.some(year => secondYears.includes(year))) return false;

  // Bind the canonical first amount to one amount in the primary quote.  A
  // multi-period table quote may contain later-year values/rates as context;
  // only the amount whose displayed value is named by the canonical claim is
  // eligible for this proof.
  const primaryAmounts = primary.filter(token => !token.rateEvidence && !token.symbol);
  const selected = primaryAmounts.find(token => canonicalNumericKey(token) === canonicalNumericKey(first)
    || quantityIntervalsOverlap({ ...token, scaleExp: token.scaleExp || firstScale, scaleKnown: true }, first));
  if (!selected || selected.negative !== first.negative || selected.negative !== second.negative) return false;
  if (selected.currencyEvidence && selected.currencyEvidence !== firstCurrency) return false;
  // Both explicit auxiliary amounts must be the same underlying quantity after
  // their stated units, with normal displayed-decimal rounding allowed.
  return quantityIntervalsOverlap(first, second);
}

function sourceVectorPeriodKeys(value) {
  const text = String(value || "");
  const keys = [];
  const monthDate = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*(\d{4})\b/giu;
  for (const match of text.matchAll(monthDate)) keys.push(match[1]);
  const japaneseDate = /(?<!\d)(\d{4})\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/gu;
  for (const match of text.matchAll(japaneseDate)) keys.push(match[1]);
  return [...new Set(keys)];
}

function sourceVectorPeriodFor(context, side) {
  const row = String(context?.[`${side}RowText`] || context?.[`${side}_row_text`] || "");
  const text = String(context?.[`${side}Text`] || context?.[`${side}_context`] || "");
  const rowKeys = sourceVectorPeriodKeys(row);
  return rowKeys.length ? rowKeys : sourceVectorPeriodKeys(text);
}

function sourceVectorCurrency(value) {
  const currencies = currencyCodes(value);
  return currencies.length === 1 ? currencies[0] : "";
}

function openingBalanceVectorSourceProof(finding, left, right, context) {
  if (!context?.targetRowUnique || !context?.referenceRowUnique) return false;
  if (!orderedNumericVectorMatches(left, right)) return false;
  if (!sourceContextIdentityCompatible(context, finding)) return false;

  const targetRow = String(context.targetRowText || context.target_row_text || "");
  const referenceRow = String(context.referenceRowText || context.reference_row_text || "");
  const targetRowValues = extractNumericEvidence(targetRow);
  const referenceRowValues = extractNumericEvidence(referenceRow);
  if (!orderedNumericVectorMatches(targetRowValues, left)
      || !orderedNumericVectorMatches(referenceRowValues, right)) return false;

  const targetPeriods = sourceVectorPeriodFor(context, "target");
  const referencePeriods = sourceVectorPeriodFor(context, "reference");
  if (targetPeriods.length !== 1 || referencePeriods.length !== 1
      || targetPeriods[0] !== referencePeriods[0]) return false;

  const targetText = String(context.targetText || context.target_context || "");
  const referenceText = String(context.referenceText || context.reference_context || "");
  const targetScale = scaleCueExponent(targetText);
  const referenceScale = scaleCueExponent(referenceText);
  if (!Number.isInteger(targetScale) || !Number.isInteger(referenceScale)
      || targetScale !== referenceScale) return false;
  const targetCurrency = sourceVectorCurrency(targetText);
  const referenceCurrency = sourceVectorCurrency(referenceText);
  if (!targetCurrency || targetCurrency !== referenceCurrency) return false;
  return true;
}

function isOpeningBalanceVector(finding, left, right) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  if (!/(?:translation_consistency|mistranslation)/.test(scope)) return false;
  if (!orderedNumericVectorMatches(left, right)) return false;
  const leftMeasures = new Set(left.flatMap(token => token.measureKeys || []).filter(Boolean));
  const rightMeasures = new Set(right.flatMap(token => token.measureKeys || []).filter(Boolean));
  return leftMeasures.has("opening_balance") && rightMeasures.has("opening_balance");
}

function unboundTranslationEquality(finding, left, right, context) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  if (!/(?:translation_consistency|mistranslation)/.test(scope)
      || left.length !== right.length || !left.length
      || left.some((token, index) => canonicalNumericKey(token) !== canonicalNumericKey(right[index]))) return false;
  // Equal columns without a recognized common measure or a unique source row
  // are not sufficient to prove that two citations refer to the same row.
  return !sourceContextIdentityCompatible(context, finding) && !hasCommonExplicitMeasure(left, right);
}

function sameAuthoritativeNumericColumns(finding, left, right, context = {}) {
  const scope = String(finding?.issueScope ?? finding?.issue_scope ?? "").toLowerCase();
  if (!/(?:translation_consistency|mistranslation)/.test(scope)) return false;
  if (!left.length || left.length !== right.length) return false;
  if (hasColumnIdentityPermutation(left, right)) return false;
  if (sourceContextIdentityCompatible(context, finding)
      && sourceBoundNarrativeNeedsBothPrecisePeriods(finding, left, right, context)) return false;
  if (sourceContextIdentityCompatible(context, finding)
      && sourceContextExplicitPeriodMismatch(context)) return false;

  const targetContext = String(context.targetText || context.target_context || "");
  const referenceContext = String(context.referenceText || context.reference_context || "");
  const targetScale = scaleCueExponent(targetContext);
  const referenceScale = scaleCueExponent(referenceContext);
  const hasScaleContext = Number.isInteger(targetScale) && Number.isInteger(referenceScale)
    && sourceContextIdentityCompatible(context, finding);
  let hasRowEvidence = false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i], b = right[i];
    if (!a || !b || a.negative !== b.negative) return false;
    if (explicitMeasureMismatch(a, b) || explicitScopeMismatch(a, b)) return false;
    if (explicitPeriodMismatch(a, b) && !sameFiscalYearEvidence(finding?.quote, finding?.referenceQuote ?? finding?.reference_quote)) return false;
    if (unknownIdentityLabelMismatch(a, b)) return false;
    const leftCurrency = a.currencyEvidence || a.rowCurrency || "";
    const rightCurrency = b.currencyEvidence || b.rowCurrency || "";
    if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return false;
    if (a.scaleKnown && b.scaleKnown && (a.scaleExp || a.rowScaleExp || 0) !== (b.scaleExp || b.rowScaleExp || 0)) {
      // A short quote can carry the REF table's explicit unit while the
      // TARGET quote omits it (for example, `630,349 630,779` versus
      // `630,349 630,779 (千株)`).  Treat that one-sided quote scale as
      // compatible only when the unique source rows independently provide
      // the same adjacent scale.  A quote-level unit mismatch remains a
      // finding when the source captions disagree or are absent.
      const quoteScale = token => token.scaleExp || token.rowScaleExp || 0;
      const quoteScalesMatchSource = (!a.scaleCaption || quoteScale(a) === targetScale)
        && (!b.scaleCaption || quoteScale(b) === referenceScale);
      if (!(hasScaleContext && targetScale === referenceScale && quoteScalesMatchSource)) return false;
    }
    if (a.rateEvidence !== b.rateEvidence) return false;
    if (a.rateEvidence && b.rateEvidence) {
      if (canonicalNumericKey(a) !== canonicalNumericKey(b)) return false;
      hasRowEvidence = true;
      continue;
    }
    if (a.family && b.family && a.family !== b.family) return false;
    if (a.measureExplicit && b.measureExplicit && a.measureKey !== b.measureKey) return false;
    const sameKey = canonicalNumericKey(a) === canonicalNumericKey(b);
    if (sameKey) {
      hasRowEvidence = hasRowEvidence || Boolean(a.identityLabelKey || b.identityLabelKey
        || a.measureKey || b.measureKey);
      continue;
    }
    if (!hasScaleContext || a.rateEvidence || b.rateEvidence
        || !scaledNumericValuesEqual(a, b, targetScale, referenceScale)) return false;
    hasRowEvidence = true;
  }
  if (!hasRowEvidence) return false;
  // Bare equal columns such as `Total 48` must stay findings.  A bilingual row
  // label, a recognized measure/family, or an explicit nearby unit caption is
  // required before this reference-scoped proof can suppress the candidate.
  const sameIdentityLabels = left.length === right.length
    && left.every((token, index) => token.identityLabelKey && token.identityLabelKey === right[index].identityLabelKey);
  // A unique source row with compatible measure identities is sufficient even
  // when the quote omits the table caption/unit.  This is the attached
  // employee-count shape: TARGET quotes only `43 48,783 47,144`, while REF
  // retains `従業員数(就業人員) (人)` before the same vector.  The source row
  // proof is deliberately required here; a bare repeated numeric vector still
  // fails closed above.
  return Boolean(hasScaleContext || hasCommonExplicitMeasure(left, right)
    || sameIdentityLabels || sourceContextIdentityCompatible(context, finding));
}

function scaledNumericValuesEqual(a, b, leftScale, rightScale) {
  if (!a || !b || a.negative !== b.negative || a.symbol || b.symbol) return false;
  const rational = (token, scale) => {
    const decimalShift = Number(scale) - (Number(token.decimals) || 0);
    if (decimalShift >= 0) return { numerator: BigInt(token.digits) * (10n ** BigInt(decimalShift)), denominator: 1n };
    return { numerator: BigInt(token.digits), denominator: 10n ** BigInt(-decimalShift) };
  };
  const left = rational(a, leftScale), right = rational(b, rightScale);
  return left.numerator * right.denominator === right.numerator * left.denominator;
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
  const okuGapOnly = isOkuAmountGapOnlyFinding(f);
  const negativeOkuCandidate = isNegativeOkuEquivalenceCandidate(f);
  if (!NUMERIC_CATEGORIES.has(String(f.category || "").toLowerCase())
      && !okuGapOnly && !negativeOkuCandidate) return false;
  const masker = contextMasker(context);
  // Every populated canonical/suggestion alias may carry explicit identity or
  // source evidence.  A contradiction in any one of them vetoes all numeric
  // hard-drop proofs; free-form wording is never positive authorization.
  const canonicalContradiction = canonicalAuxiliaryEvidenceContradiction(f, masker, context);
  if (canonicalContradiction) return false;
  const quote = extractNumericEvidence(f.quote, masker);
  const reference = extractNumericEvidence(f.referenceQuote ?? f.reference_quote, masker);
  if (okuGapOnly || negativeOkuCandidate) {
    const comparisonText = String(f.referenceQuote ?? f.reference_quote ?? f.suggestion ?? "");
    const comparison = extractNumericEvidence(comparisonText, masker);
    const quoteOkuCase = okuUnitSpelling(f.quote);
    const comparisonOkuCase = okuUnitSpelling(comparisonText);
    if (quoteOkuCase && comparisonOkuCase && quoteOkuCase !== comparisonOkuCase) return false;
    if (okuAuxiliaryNumericContradiction(f, quote, comparison, masker)) return false;
    const targetUnitDescriptor = sourceUnitDescriptor(context, "target");
    const referenceUnitDescriptor = sourceUnitDescriptor(context, "reference");
    if (targetUnitDescriptor?.ambiguous || referenceUnitDescriptor?.ambiguous) return false;
    if (partialSourceCaptionContradicts(context, "target", targetUnitDescriptor)
        || partialSourceCaptionContradicts(context, "reference", referenceUnitDescriptor)) return false;
    if ((!targetUnitDescriptor && hasExplicitSourceUnitCaption(context, "target"))
        || (!referenceUnitDescriptor && hasExplicitSourceUnitCaption(context, "reference"))) return false;
    if (negativeOkuCandidate && !okuGapOnly
        && (!targetUnitDescriptor || !referenceUnitDescriptor
          || !targetUnitDescriptor.currency || !referenceUnitDescriptor.currency
          || !targetUnitDescriptor.currencyExplicit || !referenceUnitDescriptor.currencyExplicit)) return false;
    if (targetUnitDescriptor && referenceUnitDescriptor
        && (targetUnitDescriptor.scale !== referenceUnitDescriptor.scale
          || targetUnitDescriptor.currency !== referenceUnitDescriptor.currency)) return false;
    if (context?.targetRowUnique && context?.referenceRowUnique
        && !sourceContextIdentityCompatible(context, f)) return false;
    if (sourceContextExplicitPeriodMismatch(context)) return false;
    if (quote.length && comparison.length && hasExplicitIdentityMismatch(quote, comparison)) return false;
    if (negativeOkuCandidate && !okuGapOnly
        && !(context?.targetRowUnique && context?.referenceRowUnique
          && sourceContextIdentityCompatible(context, f))) return false;
    // The exact whitespace-only form needs no model-authored category to prove
    // equivalence, but only after every source and auxiliary contradiction has
    // had a chance to veto it.  Cross-language negative oku forms continue
    // through the ordinary source-bound numeric proofs below.
    if (okuGapOnly) return true;
  }
  // When both primary citations contain numeric evidence, they alone decide
  // the finding.  A contradictory reason/suggestion must never erase a real
  // quote/reference mismatch.  Auxiliary fields are fallback evidence only
  // when the primary pair is absent on at least one side.
  if (quote.length > 0 && reference.length > 0) {
    const targetUnitDescriptor = sourceUnitDescriptor(context, "target");
    const referenceUnitDescriptor = sourceUnitDescriptor(context, "reference");
    if (targetUnitDescriptor?.ambiguous || referenceUnitDescriptor?.ambiguous) return false;
    // A source row can be unique on both sides while still referring to
    // different reporting periods.  Once the row identity is source-bound,
    // an explicit period mismatch vetoes every later equality shortcut.
    if ((sourceContextIdentityCompatible(context, f)
        || (context?.targetRowUnique && context?.referenceRowUnique))
        && sourceContextExplicitPeriodMismatch(context)) return false;
    // Table-of-contents leaders make the terminal number a page reference,
    // not a measure value.  Suppress only that narrow translation shape; the
    // ordinary numeric gates continue to treat section-number differences as
    // real findings.
    if (tocTrailingPageOnlyEquivalent(f, quote, reference, masker)) return true;
    // Opening-balance rows are ordered vectors, not a single repeated amount.
    // Require the unique source row, matching period, unit, and currency before
    // suppressing one. This keeps an ambiguous row or a model-only claim from
    // turning an identical-looking vector into a false-positive drop.
    if (isOpeningBalanceVector(f, quote, reference)) {
      return openingBalanceVectorSourceProof(f, quote, reference, context);
    }
    // A source-backed citation may span several metric rows (for example a
    // three-row financial-results table).  The single-row column gate below
    // intentionally fails closed for that shape; use the stricter row-wise
    // vector proof only when every source row, unit, sign, period, metric and
    // converted value is independently aligned.
    if (sourceBackedMultiRowVectorEquivalent(f, quote, reference, context)) return true;
    // Rounded narrative amounts (億円/百万円 and equivalent English units)
    // need the stronger unique-row, same-period source proof.  Do not fold
    // this into the generic equality fallback, which would make a bare
    // 328/328 pair or a model reason sufficient authorization.
    if (sourceBoundNarrativeAmountEquivalent(f, quote, reference, context)) return true;
    // Once the rounded-narrative shape has a precise period on only one side,
    // no later generic equality fallback may bypass that source-bound gate.
    if (sourceBoundNarrativeNeedsBothPrecisePeriods(f, quote, reference, context)) return false;
    if (sameAuthoritativeNumericColumns(f, quote, reference, context)) return true;
    if (unboundTranslationEquality(f, quote, reference, context)) return false;
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
    const targetContext = String(context.targetText || context.target_context || "");
    const referenceContext = String(context.referenceText || context.reference_context || "");
    const sourceScaleContext = Number.isInteger(scaleCueExponent(targetContext))
      && Number.isInteger(scaleCueExponent(referenceContext))
      && sourceContextIdentityCompatible(context, f);
    // A decimal-place shift such as 90.0/900 is a scale conversion, not an
    // exact quote match.  Do not infer the conversion from model-shaped text
    // alone: only a unique TARGET/REF source row with compatible adjacent
    // scales can authorize it.  If that proof is unavailable, keep the
    // finding so the reviewer can inspect it.
    if (hasUnboundDecimalScaleShift(f.quote, f.referenceQuote ?? f.reference_quote)
        && !sourceScaleContext) return false;
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
    // A concatenated alternative must not be able to hide a contradictory
    // canonical reason/model_reason pair.  This check is limited to the
    // one-sided-primary fallback where auxiliary text is consulted.
    if (!canonicalClaimsCompatible(f, masker)) return false;
    const primary = quote.length > 0 ? quote : reference;
    const primaryText = quote.length > 0 ? f.quote : (f.referenceQuote ?? f.reference_quote);
    // Same-PDF consistency findings may carry only the narrative TARGET quote;
    // the validated counterpart quote lives in the source-bound context.  Use
    // that quote as the right-hand side of the same canonical interval proof
    // used by bilingual TARGET/REF findings.  The validator has already bound
    // every page-labelled amount to its unique source row, so no model reason
    // or suggestion text is an authorization source here.
    if (context?.sameDocumentSourceValidated) {
      const targetTokens = quote.length > 0
        ? primary
        : extractNumericEvidence(context.targetQuote || context.target_quote, masker);
      const referenceTokens = quote.length > 0
        ? extractNumericEvidence(context.referenceQuote || context.reference_quote, masker)
        : primary;
      if (sourceBoundNarrativeAmountEquivalent(f, targetTokens, referenceTokens, context)) return true;
    }
    // Every populated page-labelled numeric auxiliary field must carry its
    // own period/source authorization before any legacy proof can run.  This
    // prevents a matching peer field from hiding a mutated date/FY or an
    // ambiguously repeated counterpart quote.  The same-document proof above
    // is already source-bound by both unique rows and therefore does not rely
    // on this legacy model-field preflight for positive authorization.
    if (!pageClaimAuxiliaryPreflight(primaryText, primary, f, masker, context)) return false;
    const auxiliaryProofs = [];
    let selectedRowProofFound = false;
    let canonicalPageProofFound = false;
    const selectedRowFields = [];
    for (const [field, isSuggestion] of [
      [f.reason, false],
      [f.model_reason, false],
      [f.issueSummary, false],
      [f.issue_summary, false],
      [f.suggestion, true],
    ]) {
      const canonicalField = isSuggestion ? field : canonicalClaimText(field);
      const values = extractNumericEvidence(canonicalField, masker);
      // Empty/non-numeric summaries are not evidence and must not veto a
      // valid proof.  Once a field does carry numeric evidence, however, a
      // tautology in another field cannot override its mismatch: every
      // populated auxiliary field must independently prove the same narrow
      // equivalence.  This applies uniformly to scaled amount/rate,
      // repeated-vector, selected-row, repeated-claim, and cash-flow proofs.
      if (!values.length) continue;
      const selectedRowShape = hasQuotedTwoPeriodRow(canonicalField, masker);
      const selectedRowProof = selectedQuotedRowMemberEquivalent(primary, canonicalField, values, masker);
      if (selectedRowShape) selectedRowFields.push(selectedRowProof);
      const pageBoundProof = pageBoundRoundingEquivalent(primaryText, primary, canonicalField, values, f, masker, context);
      if (!isSuggestion && pageBoundProof) canonicalPageProofFound = true;
      const suggestionProof = isSuggestion && cashFlowRoundingSuggestionEquivalent(
        primaryText,
        primary,
        canonicalField,
        values,
        f,
        masker,
        context,
      );
      const proven = scaledAmountWithAdjacentRateEquivalent(primaryText, primary, canonicalField, values)
        || repeatedVectorTautologyEquivalent(primary, canonicalField, values, masker)
        || canonicalScaledClaimEquivalent(primaryText, primary, canonicalField, values, f, masker, context)
        || selectedRowProof
        || repeatedClaimMatchesPrimary(primary, canonicalField, masker)
        || pageBoundProof
        || cashFlowRoundingEquivalent(primaryText, primary, canonicalField, values, f, masker, {}, context)
        || (suggestionProof && (canonicalPageProofFound || primary.length < 2));
      if (selectedRowProof) selectedRowProofFound = true;
      auxiliaryProofs.push({ proven, values });
      if (contradictoryRepeatedVector(primary, field, values, masker)) return false;
    }
    // If one auxiliary field proves the narrow selector shape but another
    // numeric field still carries an unproven two-period quoted row, keep the
    // finding. The extra row member may be ignored only when every such field
    // identifies the selected member; otherwise the auxiliary evidence is
    // contradictory rather than context.
    if (selectedRowProofFound && selectedRowFields.some(proven => !proven)) return false;
    const positiveProofs = auxiliaryProofs.filter(item => item.proven).map(item => item.values);
    if (!positiveProofs.length) return false;
    // A terse suggestion often omits the already-proven captions and merely
    // repeats the two displayed endpoints in reverse page order.  It is not a
    // second unit proof, but it is also not contradictory evidence.  Accept
    // only an exact signed multiset restatement of an independently proven
    // field; an extra/stale value, explicit scale/currency conflict, measure,
    // scope or period mismatch still vetoes the drop.
    return auxiliaryProofs.every(item => item.proven
      || positiveProofs.some(proof => numericAuxiliaryRestatesProof(item.values, proof)));
  }
  // With no primary numeric evidence, a repeated value in an auxiliary field
  // is positive evidence of a self-contradictory comparison (e.g. the same
  // financing cash flow copied three times).  Do not let a tautological
  // reason override a populated contradictory model_reason/summary: every
  // populated numeric auxiliary field must independently prove the same
  // narrow equivalence.  Empty/non-numeric summaries remain out of scope.
  // Even without a numeric primary quote, a verified page-bound finding must
  // validate every canonical page claim before repeated-value fallbacks can
  // suppress it.  This is the same global veto used by the one-sided path.
  if (!pageClaimAuxiliaryPreflight(f.quote, [], f, masker, context)) return false;
  const auxiliaryProofs = [];
  for (const field of [f.reason, f.model_reason, f.issueSummary, f.issue_summary, f.suggestion]) {
    const values = extractNumericEvidence(field, masker);
    if (!values.length) continue;
    auxiliaryProofs.push(
      pageBoundRoundingEquivalent(f.quote, [], field, values, f, masker, context)
      || (isSafeEqualEitherOrClaim(field) && allNumericCandidatesSameIdentity(field, masker))
      || repeatedNumericClaim(field, masker)
      || fieldPairsProveFalsePositive(values, masker),
    );
  }
  if (auxiliaryProofs.length) return auxiliaryProofs.every(Boolean);
  // Keep the legacy fallback for a suggestion shape whose numeric extractor
  // intentionally yields no candidates; populated numeric suggestions above
  // already participate in the all-auxiliary every(Boolean) proof.
  if (isSafeEqualEitherOrClaim(f.suggestion)
      && allNumericCandidatesSameIdentity(f.suggestion, masker)) return true;
  if (fieldPairsProveFalsePositive(extractNumericEvidence(f.suggestion, masker), masker)) return true;
  return false;
}

function normalizedSignedNumber(value) {
  let s = String(value || "").replace(/,/g, "").trim();
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);
  s = s.replace(/^[△▲−]/, "-").replace(/^[+＋]/, "");
  return s;
}

function hasEqualEitherOrNumbers(value) {
  const text = String(value || "");
  const number = String.raw`[△▲+＋−-]?\(?\d[\d,]*(?:\.\d+)?\)?`;
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
  const parsed = parsePageMarkers(value);
  const pageNumbers = parsed.markers.map(marker => marker.page);
  if (parsed.malformed.length || pageNumbers.length !== 2 || new Set(pageNumbers).size !== 2) return false;
  const text = parsed.source;
  const number = String.raw`[△▲+＋−-]?\(?\d[\d,]*(?:\.\d+)?\)?`;
  const page = String.raw`(?:P\s*[.．]?\s*\d{1,4}|Page\s+\d{1,4})`;
  const match = text.match(new RegExp(
    String.raw`${page}[^\d。]{0,80}(${number})\s*と\s*${page}[^\d。]{0,80}(${number})[^。]*どちら`,
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
  const parsed = parsePageMarkers(value);
  if (parsed.malformed.length) return String(value || "");
  return parsed.source
    .replace(/(?:\bP\s*[.．]?\s*\d{1,4}\b|\bPage\s+\d{1,4}\b)/giu, " ")
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
  const normalizedScopeText = normalizeScopeText(text);
  const scopes = [...new Set(SCOPE_PATTERNS.filter(rule => rule.re.test(normalizedScopeText)).map(rule => rule.key))];
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
  const re = /[△▲+＋−-]?\(?\d[\d,]*(?:\.\d+)?\)?/g;
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
  for (const match of String(value || "").matchAll(/trillions?|billions?|millions?|thousands?|十\s*億|千\s*万|百\s*万|十\s*万|百万|十億|兆|億|万|千|(?<![A-Za-z])oku(?![A-Za-z])/gi)) {
    const word = match[0].toLowerCase().replace(/\s+/g, "").replace(/s$/, "");
    out.push(word === "trillion" || word === "兆" ? 12
      : word === "billion" || word === "十億" ? 9
      : word === "億" ? 8
      : word === "oku" ? 8
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
    const extra = typeof context.forFinding === "function" ? (context.forFinding(finding) || {}) : {};
    const proven = isConclusiveNumericFalsePositive(finding, { ...context, ...extra, masker });
    (proven ? dropped : kept).push(finding);
  }
  return { kept, dropped };
}

// Keep the browser's masked -> restored numeric filtering sequence in one
// place.  The document-specific callbacks are injected by index.html (and by
// the tracked replay test), while this helper owns the ordering and context
// merge contract.  In particular, source contexts are rebuilt after restore;
// a context validated against masked text must never authorize the restored
// quote.
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

  const validatedCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    items, targetTextFor, sourceCache,
  );
  const numericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(items, numericContextOptions),
    validatedCounterpartContexts,
  );
  const contextForFinding = finding => numericContexts.get(String(finding?.id || "")) || {};
  const compatibleNumericDropped = items.filter(finding =>
    isMaskerCompatibleNumericFinding(finding, contextForFinding(finding)));
  const maskedNumericFilter = partitionNumericFalsePositives(
    items.filter(finding => !isMaskerCompatibleNumericFinding(finding, contextForFinding(finding))),
    { masker: options.masker || null, forFinding: contextForFinding },
  );

  const restoredFindings = await restoreMaskedFindings(maskedNumericFilter.kept);
  // Quote-variant selection is the final source-backed surface.  Validate
  // counterpart rows only after that selection; validating the first
  // restored spelling would cache an empty context and let the corrected
  // variant bypass the source-bound numeric gate.
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
