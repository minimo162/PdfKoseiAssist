import assert from "node:assert/strict";
import {
  findUniqueNumericSourceContext,
  isConclusiveNumericFalsePositive,
  normalizeMarchFiscalYearLabelsForReview,
  normalizeNumericWidthForReview,
  partitionNumericFalsePositives,
} from "../js/review-merge.mjs";
import {
  isConclusiveNumericFalsePositive as coreIsConclusiveNumericFalsePositive,
} from "../js/review-merge-core.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";

// Exact fiscal-year spelling from the attached English securities report.
assert.equal(
  normalizeMarchFiscalYearLabelsForReview("FY March\n2025"),
  "FY2025",
  "FY March YYYY must become the existing structural FY token",
);
assert.equal(
  normalizeMarchFiscalYearLabelsForReview("For the year ended March 31, 2025"),
  "For the year ended March 31, 2025",
  "ordinary calendar dates must remain unchanged",
);
assert.equal(
  normalizeMarchFiscalYearLabelsForReview("当事業年度"),
  "当事業年度",
  "anaphoric fiscal-year wording must not be invented or shifted",
);
assert.equal(
  normalizeNumericWidthForReview("FY March ２０２５ / － / △１００．５"),
  "FY March 2025 / － / △100.5",
  "numeric width normalization must continue to preserve the U+FF0D table dash",
);

// The attached GHG table prints FY March labels above an otherwise exact
// numeric row. The wrapper must bind the row without treating 2021..2025 as
// five extra measured amounts, and must retain bounded March-year provenance.
const ghgSource = [
  "Progress in GHG emissions of Scope 1, 2 and 3 (global)",
  "(1,000 t-CO2e)",
  "FY March 2021 FY March 2022 FY March 2023 FY March 2024 FY March 2025",
  "Scope 1 (direct emissions) 97 97 113 112 119",
].join("\n");
const ghgQuote = "Scope 1 (direct emissions) 97 97 113 112 119";
const ghgMatch = findUniqueNumericSourceContext(ghgSource, ghgQuote);
assert.equal(ghgMatch?.unique, true, "the attached GHG row must bind uniquely");
assert.deepEqual(
  ghgMatch?.marchFiscalYears,
  [2021, 2022, 2023, 2024, 2025],
  "bounded source context must remember which FY labels explicitly said March",
);
assert.equal(
  String(ghgMatch?.text || "").includes("FY March"),
  false,
  "the numeric review context must expose the canonical structural FY surface",
);

const japaneseGhgSource = [
  "温室効果ガス（GHG）排出量 Scope1、2、3の実績（グローバル）",
  "(千t-CO2e)",
  "2020年度 2021年度 2022年度 2023年度 2024年度",
  "Scope1（直接排出） 97 97 113 112 119",
].join("\n");
const ghgFinding = {
  id: "attached-ghg-vector",
  page: 26,
  category: "number_mismatch",
  quote: ghgQuote,
  referenceQuote: "Scope1（直接排出） 97 97 113 112 119",
  reference_pages: [21],
};
const ghgContexts = await collectNumericFindingContexts([ghgFinding], {
  targetTextFor: async () => ghgSource,
  referenceTextFor: async () => japaneseGhgSource,
  referenceSourceFor: () => ({ id: "ja-report", pageCount: 21 }),
});
assert.deepEqual(
  ghgContexts.get(ghgFinding.id)?.targetMarchFiscalYears,
  [2021, 2022, 2023, 2024, 2025],
  "the collector must carry bounded March-year provenance into the numeric gate",
);
assert.deepEqual(
  ghgContexts.get(ghgFinding.id)?.referenceMarchFiscalYears,
  [],
  "Japanese YYYY年度 rows must not be relabeled until both source rows are trusted",
);

// Combined fixture from the attached report's reporting period and cash-flow
// values:
//   Japanese report period: 2025年度; operating cash flow: 2億円
//   English report period : FY March 2026; operating cash flow: 0.2 billion yen
// The core sees 2025 and 2026 as conflicting raw period keys. The facade may
// align them only because the collector uniquely binds both rows and retains
// proof that the English source explicitly used the March fiscal-year form.
const cashFlowFinding = {
  id: "attached-operating-cash-flow",
  page: 34,
  category: "number_mismatch",
  issueScope: "translation_consistency",
  quote: "Cash flows from operating activities 0.2",
  referenceQuote: "営業活動によるキャッシュ・フロー 2",
  reference_pages: [1],
};
const englishCashFlowSource = [
  "FY March 2026",
  "(Billions of yen)",
  cashFlowFinding.quote,
].join("\n");
const japaneseCashFlowSource = [
  "2025年度",
  "(単位：億円)",
  cashFlowFinding.referenceQuote,
].join("\n");
const cashFlowContexts = await collectNumericFindingContexts([cashFlowFinding], {
  targetTextFor: async () => englishCashFlowSource,
  referenceTextFor: async () => japaneseCashFlowSource,
  referenceSourceFor: () => ({ id: "ja-cash-flow", pageCount: 1 }),
});
const cashFlowContext = cashFlowContexts.get(cashFlowFinding.id);
assert.equal(cashFlowContext?.targetRowUnique, true);
assert.deepEqual(
  cashFlowContext?.targetMarchFiscalYears,
  [2026],
  "collector must prove that the English source used FY March 2026",
);
assert.equal(
  coreIsConclusiveNumericFalsePositive(cashFlowFinding, cashFlowContext),
  false,
  "the raw core fixture must reproduce the March fiscal-year offset gap",
);
assert.equal(
  isConclusiveNumericFalsePositive(cashFlowFinding, cashFlowContext),
  true,
  "source-bound 2025年度 and FY March 2026 must authorize the existing scale proof",
);

const unboundContext = {
  ...cashFlowContext,
  targetRowUnique: false,
};
assert.equal(
  isConclusiveNumericFalsePositive(cashFlowFinding, unboundContext),
  false,
  "the March-year shift must remain unavailable without a unique TARGET row",
);

const truePeriodMismatch = {
  ...cashFlowContext,
  targetText: String(cashFlowContext.targetText).replace("FY2026", "FY2025"),
  targetMarchFiscalYears: [2025],
};
assert.equal(
  isConclusiveNumericFalsePositive(cashFlowFinding, truePeriodMismatch),
  false,
  "2025年度 and FY March 2025 are not the same March fiscal year",
);

const partiallyOverlappingPeriods = {
  ...cashFlowContext,
  targetText: `FY2025\n${cashFlowContext.targetText}`,
  targetMarchFiscalYears: [2025, 2026],
};
assert.equal(
  isConclusiveNumericFalsePositive(cashFlowFinding, partiallyOverlappingPeriods),
  false,
  "an adjacent extra March period must fail closed rather than authorize a global shift",
);

// A real date mismatch found in the same annual-report comparison is not a
// numeric false positive and must remain visible.
const realDateFinding = {
  id: "real-audit-committee-year",
  page: 75,
  category: "date_mismatch",
  quote: "Below are major activities performed during the fiscal year ended March 31, 2025.",
  referenceQuote: "当事業年度の主な活動は以下のとおりであります。",
};
assert.equal(
  isConclusiveNumericFalsePositive(realDateFinding, {}),
  false,
  "an actual 2025/2026 reporting-period error must not be suppressed",
);

const partitioned = partitionNumericFalsePositives(
  [cashFlowFinding, realDateFinding],
  { forFinding: finding => finding.id === cashFlowFinding.id ? cashFlowContext : {} },
);
assert.deepEqual(partitioned.dropped.map(finding => finding.id), [cashFlowFinding.id]);
assert.deepEqual(partitioned.kept.map(finding => finding.id), [realDateFinding.id]);


// --- 実測 2026-08-22: 整合性レンズの誤指摘が取込フィルタを生き残る経路の回帰 ---

// (C) 会計年度ラベル違いだけの date_mismatch は確定dropする。
//     「FY March 2014」と「2013年度比」は同じ期間（2013年度 = 2013-04〜2014-03）。
const fyEquivalentDateFinding = {
  id: "fy-march-label-only-date-mismatch",
  page: 25,
  category: "date_mismatch",
  issue_scope: "translation_consistency",
  quote: "Reducing non-consolidated CO2 emissions by 46% or more compared to FY March 2014",
  referenceQuote: "2030年度目標 国内自社工場・事業所でのCO2排出量を46％以上削減（2013年度比）",
};
assert.equal(
  isConclusiveNumericFalsePositive(fyEquivalentDateFinding, {}),
  true,
  "a March-fiscal-year label difference alone must drop date_mismatch",
);

// 対応しない年度ペアは従来どおり残す（fail-closed）。
const fyConflictDateFinding = {
  ...fyEquivalentDateFinding,
  id: "fy-real-date-mismatch",
  quote: "compared to FY March 2015",
};
assert.equal(
  isConclusiveNumericFalsePositive(fyConflictDateFinding, {}),
  false,
  "an unmatched fiscal-year pair must stay visible",
);

// (A) 翻訳一貫性スコープでも、同一保護記号・同符号のpairwise一致は自己矛盾としてdropする。
//     復元後は「Japan 22,857 vs 日本 22,857」のように同値だと分かる種類の誤指摘。
const sameSymbolFinding = {
  id: "same-symbol-self-contradiction",
  page: 81,
  category: "number_mismatch",
  issue_scope: "translation_consistency",
  quote: "Japan \u27E6#CRB\u27E7 million yen",
  referenceQuote: "日本 \u27E6#CRB\u27E7円",
  reason: "数値記号が不一致",
};
assert.equal(
  isConclusiveNumericFalsePositive(sameSymbolFinding, {}),
  true,
  "identical protected symbols with equal signs must drop in translation scope",
);

// 記号が異なる（実値差の可能性）場合は従来どおり残す。
const differentSymbolFinding = {
  ...sameSymbolFinding,
  id: "different-symbol-kept",
  referenceQuote: "日本 \u27E6#XYZ\u27E7円",
};
assert.equal(
  isConclusiveNumericFalsePositive(differentSymbolFinding, {}),
  false,
  "different protected symbols must stay visible",
);

console.log("March fiscal-year normalization regression: OK");
