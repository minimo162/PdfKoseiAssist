import assert from "node:assert/strict";
import {
  isConclusiveNumericFalsePositive,
  normalizeNumericWidthForReview,
  partitionNumericFalsePositives,
} from "../js/review-merge.mjs";

function sourceContext(finding) {
  const quote = normalizeNumericWidthForReview(finding.quote);
  const reference = normalizeNumericWidthForReview(
    finding.referenceQuote ?? finding.reference_quote ?? "",
  );
  return {
    targetText: `Unit: oku yen\n${quote}`,
    referenceText: `Unit: oku yen\n${reference}`,
    targetRowText: quote,
    referenceRowText: reference,
    targetRowLines: [quote],
    referenceRowLines: [reference],
    targetQuote: quote,
    referenceQuote: reference,
    targetRowUnique: true,
    referenceRowUnique: true,
  };
}

const sameTriangleWidth = {
  id: "fullwidth-triangle",
  page: 1,
  category: "formatting",
  quote: "Net sales △１００ oku yen",
  referenceQuote: "Net sales △100 oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(sameTriangleWidth),
  true,
  "full-width digits must not create a false oku mismatch",
);

const sameParenthesizedDecimal = {
  id: "fullwidth-parenthesized",
  page: 1,
  category: "formatting",
  quote: "Net sales （１００．５）oku yen",
  referenceQuote: "Net sales (100.5) oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(sameParenthesizedDecimal),
  true,
  "full-width digits/decimal with accounting parentheses must compare by value",
);

const sameExplicitPlus = {
  id: "fullwidth-plus",
  page: 1,
  category: "formatting",
  quote: "Net sales ＋１００ oku yen",
  referenceQuote: "Net sales +100 oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(sameExplicitPlus, sourceContext(sameExplicitPlus)),
  true,
  "ASCII/full-width plus are both explicit positive signs once the source row is bound",
);

const sameNegativeSurface = {
  id: "triangle-vs-parens",
  page: 1,
  category: "formatting",
  quote: "Net sales △１００ oku yen",
  referenceQuote: "Net sales (100) oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(sameNegativeSurface, sourceContext(sameNegativeSurface)),
  true,
  "triangle and accounting parentheses must remain equivalent negative surfaces",
);

const fullwidthMissingDash = {
  id: "fullwidth-dash",
  page: 1,
  category: "numbers",
  quote: "Net sales －１００ oku yen",
  referenceQuote: "Net sales -100 oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(fullwidthMissingDash, sourceContext(fullwidthMissingDash)),
  false,
  "U+FF0D table dash must never be normalized into a negative sign",
);

const realSignMismatch = {
  id: "real-sign-mismatch",
  page: 1,
  category: "numbers",
  quote: "Net sales △１００ oku yen",
  referenceQuote: "Net sales +100 oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(realSignMismatch, sourceContext(realSignMismatch)),
  false,
  "negative vs positive is a real mismatch",
);

const malformedCombinedSign = {
  id: "malformed-sign",
  page: 1,
  category: "numbers",
  quote: "Net sales （＋１００）oku yen",
  referenceQuote: "Net sales +100 oku yen",
};
assert.equal(
  isConclusiveNumericFalsePositive(malformedCombinedSign, sourceContext(malformedCombinedSign)),
  false,
  "combined plus-plus-parenthesis syntax must continue to fail closed",
);

assert.equal(
  normalizeNumericWidthForReview("△１２３．４５ / ＋６ / －７"),
  "△123.45 / ＋6 / －7",
  "only numeric compatibility width is normalized; sign glyph policy stays intact",
);

const partition = partitionNumericFalsePositives(
  [sameTriangleWidth, fullwidthMissingDash, realSignMismatch],
  { forFinding: finding => sourceContext(finding) },
);
assert.deepEqual(
  partition.dropped.map(item => item.id),
  ["fullwidth-triangle"],
);
assert.deepEqual(
  partition.kept.map(item => item.id),
  ["fullwidth-dash", "real-sign-mismatch"],
);

console.log("Signed oku width regression: OK");
