// review-merge.mjs — compatibility facade for numeric-width-safe review logic
//
// The established review implementation remains in review-merge-core.mjs.
// This facade normalizes only compatibility-width numeric glyphs and explicit
// March fiscal-year labels before deterministic numeric comparison. It
// deliberately does NOT use NFKC: U+FF0D `－` is a table missing-value dash in
// PDF extraction and must never become an ASCII negative sign.
import {
  findUniqueNumericSourceContext as coreFindUniqueNumericSourceContext,
  isConclusiveNumericFalsePositive as coreIsConclusiveNumericFalsePositive,
  isDeterministicReviewNoise as coreIsDeterministicReviewNoise,
  hasMalformedNumericSignEvidence as coreHasMalformedNumericSignEvidence,
} from "./review-merge-core.mjs";

export * from "./review-merge-core.mjs";

const NUMERIC_REVIEW_FIELDS = [
  "quote", "referenceQuote", "reference_quote", "suggestion",
  "reason", "model_reason", "issueSummary", "issue_summary",
];
const SOURCE_CONTEXT_TEXT_FIELDS = [
  "targetText", "target_context", "referenceText", "reference_context",
  "targetRowText", "target_row_text", "referenceRowText", "reference_row_text",
  "targetQuote", "target_quote", "referenceQuote", "reference_quote",
];
const SOURCE_CONTEXT_LINE_FIELDS = [
  "targetRowLines", "target_row_lines", "referenceRowLines", "reference_row_lines",
];
const MARCH_FISCAL_YEAR_MARK = "\uE101";
const MARCH_FISCAL_YEAR_RE = /\bFY\s+March\s+((?:19|20)\d{2})\b/giu;
const MARKED_MARCH_FISCAL_YEAR_RE = new RegExp(
  `\\bFY((?:19|20)\\d{2})${MARCH_FISCAL_YEAR_MARK}`,
  "gu",
);
const JAPANESE_FISCAL_YEAR_RE = /(?<!\d)((?:19|20)\d{2})\s*年度/gu;

export function normalizeNumericWidthForReview(value) {
  return String(value ?? "")
    .replace(/[０-９]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/．/gu, ".");
}

/**
 * `FY March 2025` is a fiscal-period label, not the numeric value 2025.
 * Canonicalize the label to the already-supported `FY2025` surface. This is
 * safe without knowing the issuer's year-end because the year itself is not
 * changed. Japanese `YYYY年度` is shifted separately and only after a trusted
 * TARGET/REF source pair proves that it is the corresponding March fiscal year.
 */
export function normalizeMarchFiscalYearLabelsForReview(value) {
  MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  return String(value ?? "").replace(
    MARCH_FISCAL_YEAR_RE,
    (_all, year) => `FY${year}`,
  );
}

function markMarchFiscalYearLabels(value) {
  MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  return normalizeNumericWidthForReview(value).replace(
    MARCH_FISCAL_YEAR_RE,
    (_all, year) => `FY${year}${MARCH_FISCAL_YEAR_MARK}`,
  );
}

function stripMarchFiscalYearMarks(value) {
  return String(value ?? "").replaceAll(MARCH_FISCAL_YEAR_MARK, "");
}

function markedMarchFiscalYears(value) {
  MARKED_MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  const years = [];
  for (const match of String(value ?? "").matchAll(MARKED_MARCH_FISCAL_YEAR_RE)) {
    years.push(Number(match[1]));
  }
  return [...new Set(years.filter(Number.isInteger))];
}

function stripMarchMarksFromSourceMatch(match) {
  if (!match || typeof match !== "object") return match;
  const markedText = [
    match.text,
    match.rowText,
    ...(Array.isArray(match.rowLines) ? match.rowLines : []),
  ].join("\n");
  return {
    ...match,
    text: stripMarchFiscalYearMarks(match.text),
    rowText: stripMarchFiscalYearMarks(match.rowText),
    rowLines: Array.isArray(match.rowLines)
      ? match.rowLines.map(stripMarchFiscalYearMarks)
      : match.rowLines,
    marchFiscalYears: markedMarchFiscalYears(markedText),
  };
}

/**
 * Keep source binding and numeric extraction on the same canonical surface.
 * The private marker lets the caller retain proof that `FY2025` originated
 * from the explicit `FY March 2025` form, while it is removed from every value
 * returned to the rest of the application.
 */
export function findUniqueNumericSourceContext(source, quote, options = {}) {
  const match = coreFindUniqueNumericSourceContext(
    markMarchFiscalYearLabels(source),
    markMarchFiscalYearLabels(quote),
    options,
  );
  return stripMarchMarksFromSourceMatch(match);
}

function normalizeFindingBase(finding) {
  if (!finding || typeof finding !== "object") return finding;
  const normalized = { ...finding };
  for (const field of NUMERIC_REVIEW_FIELDS) {
    if (typeof finding[field] === "string") {
      normalized[field] = normalizeMarchFiscalYearLabelsForReview(
        normalizeNumericWidthForReview(finding[field]),
      );
    }
  }
  return normalized;
}

function normalizeFindingNumericWidthOnly(finding) {
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
  return (Array.isArray(findings) ? findings : []).map(normalizeFindingNumericWidthOnly);
}

function normalizeContextBase(context) {
  if (!context || typeof context !== "object") return context || {};
  const normalized = { ...context };
  for (const field of SOURCE_CONTEXT_TEXT_FIELDS) {
    if (typeof context[field] === "string") {
      normalized[field] = normalizeMarchFiscalYearLabelsForReview(
        normalizeNumericWidthForReview(context[field]),
      );
    }
  }
  for (const field of SOURCE_CONTEXT_LINE_FIELDS) {
    if (Array.isArray(context[field])) {
      normalized[field] = context[field].map(value =>
        normalizeMarchFiscalYearLabelsForReview(normalizeNumericWidthForReview(value)));
    }
  }
  return normalized;
}

function sideSourceText(finding, context, side) {
  const target = side === "target";
  const values = target
    ? [
      finding?.quote,
      context?.targetText,
      context?.target_context,
      context?.targetRowText,
      context?.target_row_text,
      context?.targetQuote,
      context?.target_quote,
      ...(Array.isArray(context?.targetRowLines) ? context.targetRowLines : []),
      ...(Array.isArray(context?.target_row_lines) ? context.target_row_lines : []),
    ]
    : [
      finding?.referenceQuote,
      finding?.reference_quote,
      context?.referenceText,
      context?.reference_context,
      context?.referenceRowText,
      context?.reference_row_text,
      context?.referenceQuote,
      context?.reference_quote,
      ...(Array.isArray(context?.referenceRowLines) ? context.referenceRowLines : []),
      ...(Array.isArray(context?.reference_row_lines) ? context.reference_row_lines : []),
    ];
  return values.map(value => String(value ?? "")).filter(Boolean).join("\n");
}

function japaneseMarchFiscalYears(value) {
  JAPANESE_FISCAL_YEAR_RE.lastIndex = 0;
  const years = [];
  for (const match of normalizeNumericWidthForReview(value).matchAll(JAPANESE_FISCAL_YEAR_RE)) {
    years.push(Number(match[1]) + 1);
  }
  return [...new Set(years.filter(Number.isInteger))];
}

function explicitMarchFiscalYears(value) {
  MARCH_FISCAL_YEAR_RE.lastIndex = 0;
  const years = [];
  for (const match of normalizeNumericWidthForReview(value).matchAll(MARCH_FISCAL_YEAR_RE)) {
    years.push(Number(match[1]));
  }
  return [...new Set(years.filter(Number.isInteger))];
}

function contextMarchFiscalYears(context, side, fallbackText) {
  const direct = context?.[`${side}MarchFiscalYears`]
    || context?.[`${side}_march_fiscal_years`];
  const supplied = Array.isArray(direct)
    ? direct.map(Number).filter(Number.isInteger)
    : [];
  return [...new Set([...supplied, ...explicitMarchFiscalYears(fallbackText)])];
}

function relationForMarchAndJapaneseYears(marchYears, japaneseYears) {
  if (!marchYears.length || !japaneseYears.length) return "none";
  const march = new Set(marchYears);
  const japanese = new Set(japaneseYears);
  const exact = march.size === japanese.size
    && [...march].every(year => japanese.has(year));
  // Positive authorization requires the complete bounded period set to agree.
  // A partial overlap may come from an adjacent table/header and is therefore
  // ambiguity, not permission to shift every Japanese fiscal-year label.
  return exact ? "equivalent" : "conflict";
}

function sourceBoundMarchFiscalYearRelation(finding, context) {
  if (!context?.targetRowUnique || !context?.referenceRowUnique) return "none";
  const targetText = sideSourceText(finding, context, "target");
  const referenceText = sideSourceText(finding, context, "reference");
  const targetMarch = contextMarchFiscalYears(context, "target", targetText);
  const referenceMarch = contextMarchFiscalYears(context, "reference", referenceText);
  const targetJapanese = japaneseMarchFiscalYears(targetText);
  const referenceJapanese = japaneseMarchFiscalYears(referenceText);
  const relations = [
    relationForMarchAndJapaneseYears(targetMarch, referenceJapanese),
    relationForMarchAndJapaneseYears(referenceMarch, targetJapanese),
  ].filter(relation => relation !== "none");
  if (relations.includes("conflict")) return "conflict";
  return relations.includes("equivalent") ? "equivalent" : "none";
}

function shiftJapaneseFiscalYearsForMarch(value) {
  JAPANESE_FISCAL_YEAR_RE.lastIndex = 0;
  return normalizeNumericWidthForReview(value).replace(
    JAPANESE_FISCAL_YEAR_RE,
    (_all, year) => `FY${Number(year) + 1}`,
  );
}

function shiftFindingJapaneseFiscalYears(finding) {
  if (!finding || typeof finding !== "object") return finding;
  const normalized = { ...finding };
  for (const field of NUMERIC_REVIEW_FIELDS) {
    if (typeof normalized[field] === "string") {
      normalized[field] = shiftJapaneseFiscalYearsForMarch(normalized[field]);
    }
  }
  return normalized;
}

function shiftContextJapaneseFiscalYears(context) {
  const normalized = { ...context };
  for (const field of SOURCE_CONTEXT_TEXT_FIELDS) {
    if (typeof normalized[field] === "string") {
      normalized[field] = shiftJapaneseFiscalYearsForMarch(normalized[field]);
    }
  }
  for (const field of SOURCE_CONTEXT_LINE_FIELDS) {
    if (Array.isArray(normalized[field])) {
      normalized[field] = normalized[field].map(shiftJapaneseFiscalYearsForMarch);
    }
  }
  return normalized;
}

function prepareNumericReviewInput(finding, context = {}) {
  const normalizedFinding = normalizeFindingBase(finding);
  const normalizedContext = normalizeContextBase(context);
  const relation = sourceBoundMarchFiscalYearRelation(finding, context);
  if (relation === "conflict") {
    return {
      finding: normalizedFinding,
      context: { ...normalizedContext, marchFiscalYearConflict: true },
      marchFiscalYearConflict: true,
    };
  }
  if (relation !== "equivalent") {
    return { finding: normalizedFinding, context: normalizedContext, marchFiscalYearConflict: false };
  }
  return {
    finding: shiftFindingJapaneseFiscalYears(normalizedFinding),
    context: shiftContextJapaneseFiscalYears(normalizedContext),
    marchFiscalYearConflict: false,
  };
}

// 実測 2026-08-22(夜間ジョブ): 「compared to FY March 2014」vs「2013年度比」のような
// 会計年度ラベル違いだけの date_mismatch が high で残った。カテゴリゲートにより
// coreの数値証明は date_mismatch に到達しないため、quote同士の明示年度で
// 完全な1対1対応が取れる場合に限り確定dropする。部分一致・曖昧はKEEP（fail-closed）。
function explicitMarchFiscalYearDateMismatchEquivalent(finding) {
  if (String(finding?.category || "").toLowerCase() !== "date_mismatch") return false;
  const targetText = `${finding?.quote || ""} ${finding?.suggestion || ""} ${finding?.reason || ""}`;
  const referenceText = String(finding?.referenceQuote || finding?.reference_quote || "");
  const marchYears = explicitMarchFiscalYears(targetText);
  const japaneseYears = japaneseMarchFiscalYears(referenceText);
  if (!marchYears.length || !japaneseYears.length) return false;
  // 参照quoteは「2030年度目標…（2013年度比）」のように複数年度を含み得るため
  // 完全一致ではなく、EN側が単一年の明示FY Marchで、その年度(+1)がREF側の
  // 年度ラベルとして実在するときだけ対応とみなす。
  if (marchYears.length !== 1) return false;
  if (!japaneseYears.includes(marchYears[0])) return false;
  // #128: 会計年度ラベル以外の日付(年・月日)が引用同士で食い違うなら、年度ラベル
  // だけが差ではないので残す(fail-closed)。
  return residualDateKeysEqual(
    normalizeNumericWidthForReview(finding?.quote || "").replace(MARCH_FISCAL_YEAR_RE, " "),
    normalizeNumericWidthForReview(referenceText).replace(JAPANESE_FISCAL_YEAR_RE, " "),
  );
}

const MONTH_NAME_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/giu;
const MONTH_INDEX = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function residualDateKeys(text) {
  const source = String(text || "");
  const years = new Set();
  for (const match of source.matchAll(/(?<![\d.])((?:19|20)\d{2})(?![\d.])/gu)) years.add(match[1]);
  const monthDays = new Set();
  for (const match of source.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/gu)) {
    monthDays.add(`${Number(match[1])}-${Number(match[2])}`);
  }
  MONTH_NAME_RE.lastIndex = 0;
  for (const match of source.matchAll(MONTH_NAME_RE)) {
    const month = MONTH_INDEX.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) monthDays.add(`${month}-${Number(match[2])}`);
  }
  return { years, monthDays };
}

function residualDateKeysEqual(left, right) {
  const a = residualDateKeys(left);
  const b = residualDateKeys(right);
  const sameSet = (x, y) => x.size === y.size && [...x].every(value => y.has(value));
  return sameSet(a.years, b.years) && sameSet(a.monthDays, b.monthDays);
}

const NUMERIC_MISMATCH_CATEGORIES = new Set([
  "number_mismatch", "value_inconsistency", "accounting_inconsistency",
]);

// #128: 理由文の TARGET/REF ラベル区間。最初の TARGET ラベルから次のラベルまで、
// 最初の REF ラベルから次のラベルまでをそれぞれの主張区間とする。
const CLAIM_LABEL_RE = /(TARGET|対象原文|原文)|(REF(?:ERENCE)?|比較資料|参照(?:資料)?)/giu;

function labeledClaimSegment(text, label) {
  const source = normalizeNumericWidthForReview(text);
  const labels = [...source.matchAll(CLAIM_LABEL_RE)].map(match => ({
    kind: match[1] ? "target" : "reference",
    start: match.index,
    end: match.index + match[0].length,
  }));
  const own = labels.find(item => item.kind === label);
  if (!own) return "";
  const next = labels.find(item => item.start > own.start);
  return source.slice(own.end, next ? next.start : source.length);
}

// 理由文中の金額表現(符号・括弧・数値・単位語)。年・月・日・年度・FY・ページ・
// 四半期などの構造ラベルに付いた数字は金額ではないので除外する。
const CLAIM_AMOUNT_RE = /([△▲－−+＋-]?)\s*(\(?)\s*(\d[\d,]*(?:\.\d+)?)\s*(\)?)\s*(%|％|兆円?|十億円?|億円?|千万円?|百万円?|万円?|千円?|円|yen|trillions?|billions?|millions?|thousands?|mil\.?|oku|k(?![a-z])|千株|株)?/giu;
const CLAIM_STRUCTURAL_BEFORE_RE = /(?:FY|年度|第|P\.?|page|頁|No\.?|Q)\s*$/iu;
const CLAIM_STRUCTURAL_AFTER_RE = /^\s*(?:年|月|日|期|四半期|Q\b|ページ|頁|\/|-\d)/iu;

function claimUnitKey(unit) {
  const key = String(unit || "").toLowerCase().replace(/\.$/u, "").replace(/s$/u, "");
  if (!key) return "";
  if (key === "%" || key === "％") return "pct";
  if (key === "株") return "share";
  if (key === "千株") return "share:3";
  const currency = /(?:円|yen)/u.test(key) ? "yen" : "";
  const scale = key.replace(/(?:円|yen)/u, "");
  const exp = scale === "兆" || scale === "trillion" ? 12
    : scale === "十億" || scale === "billion" ? 9
    : scale === "億" || scale === "oku" ? 8
    : scale === "千万" ? 7
    : scale === "百万" || scale === "million" || scale === "mil" ? 6
    : scale === "万" ? 4
    : scale === "千" || scale === "thousand" || scale === "k" ? 3
    : scale === "" ? 0 : null;
  if (exp === null) return "?";
  return `${currency}:${exp}`;
}

// ラベル区間内の金額表現がちょうど 1 つのときだけ、その正規化キーを返す。
// 複数・ゼロ・未知単位は fail-closed で空文字(=同値主張として扱わない)。
function labeledClaimValue(text, label) {
  const segment = labeledClaimSegment(text, label);
  if (!segment) return "";
  const amounts = [];
  for (const match of segment.matchAll(CLAIM_AMOUNT_RE)) {
    const before = segment.slice(Math.max(0, match.index - 6), match.index);
    const after = segment.slice(match.index + match[0].length);
    if (CLAIM_STRUCTURAL_BEFORE_RE.test(before) || CLAIM_STRUCTURAL_AFTER_RE.test(after)) continue;
    const unitKey = claimUnitKey(match[5]);
    if (unitKey === "?") return "";
    const negative = Boolean(match[1] && /[△▲－−-]/u.test(match[1])) || Boolean(match[2] && match[4]);
    amounts.push(`${negative ? "-" : ""}${match[3].replace(/,/gu, "")}|${unitKey}`);
  }
  return amounts.length === 1 ? amounts[0] : "";
}

// 引用に数字があるなら、主張値が同じ符号で引用内に現れなければならない。
// 引用が数字を持たない(理由文だけの指摘)ときは検証不能なので通す。
function claimValueAppearsIn(text, claim) {
  const source = normalizeNumericWidthForReview(text).replace(/[,，]/gu, "");
  if (!/\d/u.test(source)) return true;
  const value = String(claim || "").split("|")[0];
  const negative = value.startsWith("-");
  const digits = value.replace(/^-/u, "");
  if (!digits) return false;
  const re = new RegExp(`([△▲－−-]\\s*)?(\\(\\s*)?(?<![\\d.])${digits.replace(/\./gu, "\\.")}(?![\\d.])(\\s*\\))?`, "gu");
  for (const match of source.matchAll(re)) {
    const found = Boolean(match[1]) || Boolean(match[2] && match[3]);
    if (found === negative) return true;
  }
  return false;
}

// 出典本文・行が結び付いている指摘は、後段の source-bound 拒否ゲート(期間・
// 指標・単位・符号)が判定の権威。理由文の同値主張はそれらを迂回できない。
function hasSourceBoundContext(context) {
  return SOURCE_CONTEXT_TEXT_FIELDS.some(field => typeof context?.[field] === "string" && context[field].trim())
    || SOURCE_CONTEXT_LINE_FIELDS.some(field => Array.isArray(context?.[field]) && context[field].length);
}

// モデル理由が TARGET/REF の同じ値を「不一致」と明記する自己矛盾だけを除外する。
// ラベルのない数字の反復や単位差は証明にならないため fail-closed で残す。
// #128: ラベル直後の最初の数字列(年・FY 等)ではなく、区間内で唯一の金額表現を
// 単位込みで比較する。引用側に数字があるのに主張値(符号込み)が現れない場合、
// および出典が結び付いていて後段ゲートが判定できる場合は残す。
export function isExplicitTargetReferenceSameValueClaim(finding, context = {}) {
  if (!NUMERIC_MISMATCH_CATEGORIES.has(String(finding?.category || "").toLowerCase())) return false;
  if (hasSourceBoundContext(context)) return false;
  // 壊れた・曖昧な符号表記を含む指摘は理由文だけで落とさない（fail-closed）。
  if (coreHasMalformedNumericSignEvidence(normalizeFindingBase(finding))) return false;
  const text = `${finding?.reason || ""} ${finding?.model_reason || ""}`;
  if (!/(?:一致していな|不一致|異な|mismatch|different)/iu.test(text)) return false;
  const target = labeledClaimValue(text, "target");
  const reference = labeledClaimValue(text, "reference");
  if (!target || !reference || target !== reference) return false;
  return claimValueAppearsIn(finding?.quote, target)
    && claimValueAppearsIn(finding?.referenceQuote ?? finding?.reference_quote, reference);
}

export function isMaskedPlaceholderOnlyMismatchFinding(finding) {
  if (!NUMERIC_MISMATCH_CATEGORIES.has(String(finding?.category || "").toLowerCase())) return false;
  const text = `${finding?.issueSummary || finding?.issue_summary || ""} ${finding?.reason || ""} ${finding?.model_reason || ""}`;
  const withoutPlaceholders = text.replace(/⟦#[A-Z0-9]+⟧/giu, "");
  return /(?:伏字|マスク|placeholder|⟦#[A-Z0-9]+⟧)/iu.test(text)
    && /(?:記号|placeholder|⟦#[A-Z0-9]+⟧)/iu.test(text)
    && /(?:一致していな|不一致|異な|mismatch|different)/iu.test(text)
    && !/[0-9]/u.test(withoutPlaceholders);
}

export function downgradeSuspectNumericSeverity(finding) {
  if (!NUMERIC_MISMATCH_CATEGORIES.has(String(finding?.category || "").toLowerCase())) return finding;
  if (String(finding?.severity || "").toLowerCase() !== "high") return finding;
  return { ...finding, severity: "medium", displaySeverity: "medium" };
}

export function isConclusiveNumericFalsePositive(finding, context = {}) {
  const prepared = prepareNumericReviewInput(finding, context);
  // #128: 確定 drop の入口(理由文同値・FY March 等価・決定的ノイズ)はすべて
  // 出典の年度衝突の拒否ゲートの後に置く。理由文は肯定的な authorization では
  // ないので、拒否ゲートを迂回させない。壊れた符号の veto は各入口が自分で
  // 評価する（base の同一数列ゲートは左右対称の曖昧符号を許容するため、
  // ここで一律に拒否してはいけない）。
  if (prepared.marchFiscalYearConflict) return false;
  if (isExplicitTargetReferenceSameValueClaim(finding, prepared.context)) return true;
  if (explicitMarchFiscalYearDateMismatchEquivalent(finding)) return true;
  // このファサードは `export *` の後に同名関数を再定義するため、review-merge-core.mjs
  // 側の決定的ノイズ判定を明示的に呼ばないと本番経路だけ素通りする。
  // （回帰テストは core を直接importしていたため、この欠落を検知できなかった。）
  if (coreIsDeterministicReviewNoise(prepared.finding, prepared.context)) return true;
  return coreIsConclusiveNumericFalsePositive(prepared.finding, prepared.context);
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

// Keep the original masked -> restored pipeline, but evaluate normalized
// clones at deterministic numeric gates while returning untouched findings to
// the UI. Source matching itself is handled by the wrapper above, so `FY March
// YYYY` is not misread as a numeric table value.
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
  const maskerCompatible = (finding, findingContext) => {
    const prepared = prepareNumericReviewInput(finding, findingContext);
    return !prepared.marchFiscalYearConflict
      && isMaskerCompatibleNumericFinding(prepared.finding, prepared.context);
  };

  const normalizedItems = normalizeFindingList(items);
  const validatedCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    items, targetTextFor, sourceCache,
  );
  const numericContexts = mergeValidatedContexts(
    await collectNumericFindingContexts(normalizedItems, numericContextOptions),
    validatedCounterpartContexts,
  );
  const contextForFinding = finding => numericContexts.get(String(finding?.id || "")) || {};
  const compatibleNumericDropped = items.filter(finding =>
    maskerCompatible(finding, contextForFinding(finding)));
  const maskedNumericFilter = partitionNumericFalsePositives(
    items.filter(finding => !maskerCompatible(finding, contextForFinding(finding))),
    { masker: options.masker || null, forFinding: contextForFinding },
  );

  const restoredFindings = await restoreMaskedFindings(maskedNumericFilter.kept);
  await chooseSourceBackedQuoteVariants(restoredFindings);
  const normalizedRestoredFindings = normalizeFindingList(restoredFindings);
  const restoredCounterpartContexts = await prepareValidatedSameDocumentCounterparts(
    restoredFindings, targetTextFor, sourceCache,
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
