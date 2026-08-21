// Focused regression for full-width signed-oku handling.
// Run manually with:
//   node app/_app/tools/SignedOkuWidthRegression.mjs
//
// This file intentionally does not use the Test-*.mjs prefix. The August 2026
// change was verified locally and must not start GitHub Actions automatically.

import {
  findUniqueNumericSourceContext,
  isConclusiveNumericFalsePositive,
  partitionNumericFalsePositives,
  runNumericImportTwoPass,
} from "../js/review-merge.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import {
  hasUnsupportedFullwidthDashOkuEvidence,
  isSignedOkuSurfaceCandidate,
  normalizeSignedOkuFinding,
} from "../js/signed-oku-surface.mjs";

let failures = 0;
const t = (name, condition) => {
  if (!condition) {
    failures++;
    console.error(`  FAIL ${name}`);
  }
};

const sourceContext = (quote, referenceQuote) => ({
  targetRowUnique: true,
  referenceRowUnique: true,
  targetRowText: quote,
  referenceRowText: referenceQuote,
  targetRowLines: [quote],
  referenceRowLines: [referenceQuote],
  targetText: `FY2025\nUnit: oku yen\n${quote}`,
  referenceText: `FY2025\nUnit: oku yen\n${referenceQuote}`,
  targetQuote: quote,
  referenceQuote,
});

const dropCases = [
  ["full-width parentheses/digits/latin", "Net income （１００）ｏｋｕ", "Net income -100 oku"],
  ["triangle and full-width decimal", "Net income △１００．５ oku", "Net income (100.5) oku"],
  ["black triangle", "Net income ▲１００ oku", "Net income −100 oku"],
  ["ASCII plus", "Net income １００oku", "Net income +100 oku"],
  ["full-width plus", "Net income １００oku", "Net income ＋100 oku"],
  ["full-width comma", "Net income （１００，０００）oku", "Net income -100,000 oku"],
];
for (const [name, quote, referenceQuote] of dropCases) {
  for (const category of ["number_mismatch", "formatting", "terminology"]) {
    const finding = { category, quote, referenceQuote };
    const result = partitionNumericFalsePositives([finding], sourceContext(quote, referenceQuote));
    t(`${name} drops ${category}`, result.dropped.length === 1 && result.dropped[0] === finding);
    t(`${name} keeps exact source quote ${category}`, finding.quote === quote);
  }
}

const keepCases = [
  ["negative/positive mismatch", "Net income （１００）oku", "Net income +100 oku"],
  ["U+FF0D missing-value dash", "Net income －１００oku", "Net income +100 oku"],
  ["U+FF0D before parentheses", "Net income －（１００）oku", "Net income (100) oku"],
  ["U+FF0D inside parentheses", "Net income （－１００）oku", "Net income (100) oku"],
  ["triangle plus parentheses", "Net income △（１００）oku", "Net income △100 oku"],
  ["plus inside parentheses", "Net income （＋１００）oku", "Net income 100 oku"],
  ["mixed parentheses", "Net income （１００)oku", "Net income -100 oku"],
  ["romanized case mismatch", "Net income １００ＯＫＵ", "Net income 100 oku"],
  ["Japanese currency suffix mismatch", "純利益 １００億", "純利益 100億円"],
];
for (const [name, quote, referenceQuote] of keepCases) {
  const finding = { category: "formatting", quote, referenceQuote };
  const result = partitionNumericFalsePositives([finding], sourceContext(quote, referenceQuote));
  t(`${name} stays KEEP`, result.kept.length === 1 && result.kept[0] === finding);
}

t("source collector admits full-width signed oku formatting",
  isSignedOkuSurfaceCandidate({
    category: "formatting",
    quote: "Net income （１００）ｏｋｕ",
  }, "Net income -100 oku"));
t("source collector admits explicit plus surface",
  isSignedOkuSurfaceCandidate({
    category: "terminology",
    quote: "Net income １００oku",
  }, "Net income ＋100 oku"));
for (const [name, quote] of [
  ["U+FF0D", "Net income －１００oku"],
  ["U+FF0D before parentheses", "Net income －（１００）oku"],
  ["U+FF0D inside parentheses", "Net income （－１００）oku"],
  ["combined triangle/parentheses", "Net income △（１００）oku"],
  ["plus inside parentheses", "Net income （＋１００）oku"],
  ["mixed parentheses", "Net income （１００)oku"],
]) {
  t(`source collector rejects ${name}`,
    !isSignedOkuSurfaceCandidate({ category: "formatting", quote }, "Net income -100 oku"));
}
t("U+FF0D parenthesized evidence is explicitly detected",
  hasUnsupportedFullwidthDashOkuEvidence({ quote: "Net income －（１００）oku" }));

const unchanged = {
  category: "formatting",
  quote: "Net income （１００）ｏｋｕ",
  referenceQuote: "Net income -100 oku",
  quoteVariants: ["Net income △１００ oku"],
  counterparts: [{ quote: "Net income （１００）ｏｋｕ" }],
};
const proofCopy = normalizeSignedOkuFinding(unchanged);
t("proof normalization returns a clone", proofCopy !== unchanged);
t("proof normalization converts only width variants",
  proofCopy.quote === "Net income （100）oku" && proofCopy.referenceQuote === unchanged.referenceQuote);
t("proof normalization covers quote variants",
  proofCopy.quoteVariants[0] === "Net income △100 oku");
t("proof normalization covers counterpart quotes",
  proofCopy.counterparts[0].quote === "Net income （100）oku");
t("proof normalization preserves the original", unchanged.quote === "Net income （１００）ｏｋｕ");

const targetSource = "FY2025\nUnit: ｏｋｕ yen\nNet income △１００．５ ｏｋｕ";
const targetQuote = "Net income △１００．５ ｏｋｕ";
const referenceSource = "FY2025\nUnit: oku yen\nNet income (100.5) oku";
const referenceQuote = "Net income (100.5) oku";
const directMatch = findUniqueNumericSourceContext(targetSource, targetQuote);
t("source-row binding recognizes full-width decimal/latin oku",
  directMatch?.unique === true && directMatch.rowText.includes("100.5 oku"));

const collectedFinding = {
  id: "full-width-source-context",
  page: 1,
  category: "formatting",
  quote: targetQuote,
  referenceQuote,
  referencePages: [1],
};
const collected = await collectNumericFindingContexts([collectedFinding], {
  targetTextFor: async () => targetSource,
  referenceTextFor: async () => referenceSource,
  referenceSourceFor: () => ({ id: "ref-1" }),
  referencePageCount: 1,
});
t("formatting finding reaches numeric source collector",
  collected.has(collectedFinding.id));
const collectedFilter = partitionNumericFalsePositives([collectedFinding], {
  forFinding: finding => collected.get(String(finding.id || "")) || {},
});
t("source-collected full-width decimal finding is dropped",
  collectedFilter.dropped.length === 1 && collectedFilter.dropped[0] === collectedFinding);

const runOptions = contextFor => ({
  prepareValidatedSameDocumentCounterparts: async () => new Map(),
  collectNumericFindingContexts: async items => new Map(items.map(item => [
    String(item.id || ""), contextFor(item),
  ])),
  targetTextFor: async () => "",
  referenceTextFor: async () => "",
  restoreMaskedFindings: async list => list,
  chooseSourceBackedQuoteVariants: async () => {},
});

const normalFinding = {
  id: "full-width-normal-route",
  page: 1,
  category: "formatting",
  quote: "Net income （１００）ｏｋｕ",
  referenceQuote: "Net income -100 oku",
};
const normalResult = await runNumericImportTwoPass([normalFinding], {
  ...runOptions(item => sourceContext(item.quote, item.referenceQuote)),
  isMaskerCompatibleNumericFinding: () => false,
});
t("normal two-pass route drops full-width signed oku",
  normalResult.maskedNumericFilter.dropped.length === 1
    && normalResult.maskedNumericFilter.dropped[0] === normalFinding);
t("normal two-pass route preserves highlight quote",
  normalFinding.quote === "Net income （１００）ｏｋｕ");

const earlyFinding = {
  id: "full-width-early-route",
  page: 1,
  category: "formatting",
  quote: "Net income １００oku",
  referenceQuote: "Net income ＋100 oku",
};
const earlyResult = await runNumericImportTwoPass([earlyFinding], {
  ...runOptions(item => sourceContext(item.quote, item.referenceQuote)),
  isMaskerCompatibleNumericFinding: (item, context) =>
    isConclusiveNumericFalsePositive(item, context),
});
t("early two-pass route drops full-width explicit-plus equivalence",
  earlyResult.compatibleNumericDropped.length === 1
    && earlyResult.compatibleNumericDropped[0] === earlyFinding);
t("early route returns original object", earlyResult.compatibleNumericDropped[0] === earlyFinding);

const unsafeEarlyFinding = {
  id: "full-width-dash-early-route",
  page: 1,
  category: "formatting",
  quote: "Net income －（１００）oku",
  referenceQuote: "Net income (100) oku",
};
const unsafeEarlyResult = await runNumericImportTwoPass([unsafeEarlyFinding], {
  ...runOptions(item => sourceContext(item.quote, item.referenceQuote)),
  isMaskerCompatibleNumericFinding: () => true,
});
t("early route cannot bypass U+FF0D guard",
  unsafeEarlyResult.compatibleNumericDropped.length === 0
    && unsafeEarlyResult.maskedNumericFilter.kept[0] === unsafeEarlyFinding);

const maskedFinding = {
  id: "full-width-restored-route",
  page: 1,
  category: "formatting",
  quote: "Net income (⟦#ABC⟧)oku",
  referenceQuote: "Net income -⟦#ABC⟧ oku",
};
const restoredFinding = {
  ...maskedFinding,
  quote: "Net income （１００）ｏｋｕ",
  referenceQuote: "Net income -100 oku",
};
let collectionPass = 0;
const restoredResult = await runNumericImportTwoPass([maskedFinding], {
  prepareValidatedSameDocumentCounterparts: async () => new Map(),
  collectNumericFindingContexts: async items => {
    collectionPass++;
    if (collectionPass === 1) return new Map();
    return new Map(items.map(item => [String(item.id), sourceContext(item.quote, item.referenceQuote)]));
  },
  targetTextFor: async () => "",
  referenceTextFor: async () => "",
  restoreMaskedFindings: async () => [restoredFinding],
  chooseSourceBackedQuoteVariants: async () => {},
  isMaskerCompatibleNumericFinding: () => false,
});
t("restored route drops full-width signed oku after rebuilding source context",
  restoredResult.restoredNumericFilter.dropped.length === 1
    && restoredResult.restoredNumericFilter.dropped[0] === restoredFinding);
t("restored route preserves restored highlight quote",
  restoredFinding.quote === "Net income （１００）ｏｋｕ");

if (failures) {
  console.error(`Signed oku width tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("Signed oku width tests: PASS");
