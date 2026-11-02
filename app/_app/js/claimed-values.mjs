// claimed-values.mjs — 指摘文（自由文）が挙げる値の対を取り出し、同じ量かを比べる。
//
// finding-quality.mjs（除外一覧へ移すゲート）と review-merge.mjs（数値の同値証明）の両方が使う。
// 片方からもう片方を import すると循環するため、独立したモジュールに置く。
// docs/plans/誤指摘_同一数値_改善案_2026-11-02.md P1/P3。

// 値として数えない構造番号（年・年度・ページ・四半期・月日）。review-merge.mjs の
// CLAIM_STRUCTURAL_BEFORE_RE / CLAIM_STRUCTURAL_AFTER_RE と同じ語を、抽出前に記号へ置き換える。
const CLAIM_SCALE_WORD_AHEAD = "(?:\\s*(?:兆|億|万|千|百|円|%|million|billion|thousand|trillion|oku|k(?![A-Za-z])))";
const STRUCTURAL_NUMBER_RES = [
  /(?<![A-Za-z])(?:FY|CY|P\.?|pp?\.|page|No\.?|Q)\s*\d+(?:\.\d+)?/giu,
  /第\s*\d+/gu,
  /\d+(?:\.\d+)?\s*(?:年度?|月|日|期|四半期|Q(?![A-Za-z])|ページ|頁|行目|列目)/gu,
  /(?<![A-Za-z])(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?![\d,])/gu,
  new RegExp(`(?<![\\d,.])(?:19|20)\\d{2}(?![\\d,.]|${CLAIM_SCALE_WORD_AHEAD})`, "gu"),
];

function claimComparableText(value) {
  // U+FF0D `－` は表の欠損値ダッシュ。NFKC で ASCII の負号にしてはいけない（review-merge.mjs と同じ方針）。
  let text = String(value ?? "").replace(/－/gu, " ").normalize("NFKC");
  for (const re of STRUCTURAL_NUMBER_RES) text = text.replace(re, "§");
  return text;
}

// 数値1個: 符号（△▲・-・+）、通貨記号、括弧の負値、伏字記号、単位（スケール語）。
const CLAIM_UNIT_SRC = "(兆円?|十億円?|億円?|千万円?|百万円?|万円?|千円?|円|%|(?:\\s*(?:trillions?|billions?|millions?|thousands?|oku)\\b|k(?![A-Za-z]))(?:\\s*yen\\b)?|\\s*yen\\b)?";
const CLAIM_NUMBER_SRC = `((?:(?<![A-Za-z0-9.])[+\\-−]|[△▲])?)\\s*[¥$€]?\\s*(\\(?)\\s*(⟦#[A-Z]{3}⟧|\\d[\\d,]*(?:\\.\\d+)?)\\s*(\\)?)\\s*${CLAIM_UNIT_SRC}`;
const CLAIM_GROUPS = 5;
const CLAIM_OPEN = "[「『\"“]?";
const CLAIM_CLOSE = "[」』\"”]?";
// 2つ目の数値の前の場所の修飾句（表の・日本語版の・§の・本文の営業利益）。数字と句読点は含まない。
const CLAIM_MODIFIER = "[^\\d、。；;\\n]{0,20}?";
const CLAIM_PAIR_RE = new RegExp(
  `${CLAIM_NUMBER_SRC}${CLAIM_CLOSE}\\s*(?:と|vs\\.?|versus|and)\\s*${CLAIM_MODIFIER}${CLAIM_OPEN}${CLAIM_NUMBER_SRC}`,
  "giu",
);
// 「A」を（日本語版の）「B」と照合／統一…
const CLAIM_COLLATE_RE = new RegExp(
  `${CLAIM_NUMBER_SRC}${CLAIM_CLOSE}\\s*を\\s*${CLAIM_MODIFIER}${CLAIM_OPEN}${CLAIM_NUMBER_SRC}${CLAIM_CLOSE}\\s*と\\s*(?:照合|比較|整合|統一|揃え|そろえ|合わせ|突合|一致)`,
  "giu",
);
const CLAIM_VALUE_RE = new RegExp(CLAIM_NUMBER_SRC, "giu");

function claimUnitInfo(unit) {
  const key = String(unit || "").trim().toLowerCase().replace(/\s*yen$/u, "円").replace(/\s+/gu, "").replace(/s(?=円?$)/u, "");
  if (!key) return { kind: "", exp: null };
  if (key === "%") return { kind: "pct", exp: 0 };
  const scale = key.replace(/円$/u, "");
  const exp = scale === "兆" || scale === "trillion" ? 12
    : scale === "十億" || scale === "billion" ? 9
    : scale === "億" || scale === "oku" ? 8
    : scale === "千万" ? 7
    : scale === "百万" || scale === "million" ? 6
    : scale === "万" ? 4
    : scale === "千" || scale === "thousand" || scale === "k" ? 3
    : 0;
  return { kind: "amount", exp };
}

function claimValueFromGroups(groups) {
  const [signMark, open, body, close, unit] = groups;
  const negative = /[△▲\-−]/u.test(signMark || "") || Boolean(open && close);
  const symbol = body.startsWith("⟦") ? body : "";
  let digits = symbol ? "" : body.replace(/,/gu, "");
  if (digits.includes(".")) digits = digits.replace(/0+$/u, "").replace(/\.$/u, "");
  const { kind, exp } = claimUnitInfo(unit);
  return { negative, symbol, digits, kind, exp, text: `${signMark || ""}${open || ""}${body}${close || ""}${unit || ""}` };
}

function scaledMagnitude(value) {
  return Number(value.digits) * 10 ** (value.exp || 0);
}

/**
 * 2つの値が同じ量を表すか。符号の表記差（(579) と △579）は同値、符号の有無の差は別値。
 * 単位（スケール語）が片側だけに付いている組（584億円 と 584）は、伏字の段階で
 * 片側の単位を読み取れなかった（maskedScaleUncertain）と分かっているときだけ同値とする。
 */
function claimValuesEqual(a, b, { scaleUncertain = false } = {}) {
  if (a.negative !== b.negative) return false;
  if (a.symbol || b.symbol) {
    if (a.symbol !== b.symbol) return false;
    return a.kind === b.kind || !a.kind || !b.kind ? (a.exp === b.exp || a.exp === null || b.exp === null) : false;
  }
  if (a.kind && b.kind) {
    if (a.kind !== b.kind) return false;
    if (a.kind === "pct") return a.digits === b.digits;
    const left = scaledMagnitude(a), right = scaledMagnitude(b);
    return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * 1e-9;
  }
  if (a.digits !== b.digits) return false;
  const scaled = [a, b].find(v => v.kind === "amount" && v.exp > 0);
  return !scaled || scaleUncertain;
}

// review-merge.mjs の claimValueAppearsIn が読む「-579」形式（伏字の記号は空文字）。
function claimValueKey(value) {
  return value.symbol ? "" : `${value.negative ? "-" : ""}${value.digits}`;
}

/** 自由文から「AとB」「AをBと照合」の値の対を取り出す。 */
export function extractClaimedValuePairs(text, options = {}) {
  const source = claimComparableText(text);
  const pairs = [];
  for (const re of [CLAIM_PAIR_RE, CLAIM_COLLATE_RE]) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const left = claimValueFromGroups(match.slice(1, 1 + CLAIM_GROUPS));
      const right = claimValueFromGroups(match.slice(1 + CLAIM_GROUPS, 1 + 2 * CLAIM_GROUPS));
      pairs.push({ left: left.text, right: right.text, leftKey: claimValueKey(left), rightKey: claimValueKey(right),
        identical: claimValuesEqual(left, right, options) });
    }
  }
  return pairs;
}

export function claimValues(text) {
  const source = claimComparableText(text);
  CLAIM_VALUE_RE.lastIndex = 0;
  return [...source.matchAll(CLAIM_VALUE_RE)].map(match => claimValueFromGroups(match.slice(1, 1 + CLAIM_GROUPS)));
}

// 「USA (413)、Japan (307) … 要約文の USA (413)、Japan (307) とすべて異なる」型: 前半と後半の値列が同じ。
export function isRepeatedValueSequence(text) {
  const values = claimValues(text).map(v => `${v.negative ? "-" : ""}${v.symbol || v.digits}`);
  if (values.length < 4 || values.length % 2) return false;
  const half = values.length / 2;
  return values.slice(0, half).every((value, index) => value === values[index + half]);
}

/**
 * 数値列ガード: quote と reference_quote（出典行があればそちら）の両方に数値があり、
 * 同じ規則で1対1に対応づけられない値が残るなら「差がある」。片側だけなら検査しない。
 */
export function numericVectorsDiffer(left, right, options = {}) {
  const a = claimValues(left), b = claimValues(right);
  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return true;
  const used = new Array(b.length).fill(false);
  for (const value of a) {
    const index = b.findIndex((candidate, i) => !used[i] && claimValuesEqual(value, candidate, options));
    if (index < 0) return true;
    used[index] = true;
  }
  return false;
}
