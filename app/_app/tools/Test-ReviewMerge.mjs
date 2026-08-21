// Test-ReviewMerge.mjs — review-merge.mjs の検証（node tools/Test-ReviewMerge.mjs）
import fs from "node:fs";
import {
  exactDedupe, groupSimilar, integrateFindings, partitionNumericFalsePositives, runNumericImportTwoPass, isConclusiveNumericFalsePositive, hasEquivalentScaledNumbers, findUniqueNumericSourceContext,
  parsePageMarkers, validateSameDocumentCounterpartContext, resolveSameDocumentNavigationCounterpart,
  isLikelyTableRowIndexOmission, shouldWarnMissingLens,
} from "../js/review-merge.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { Masker, unmaskFragment } from "../js/number-mask.mjs";

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

{
  const finding = {
    page: 13,
    quote: "The impact sentence on the current page.",
    reason: "P.12では「the Subordinated Loan」と「the Existing Subordinated Loan」、P.13では「this subordinated loan」と表記している。",
  };
  const pages = new Map([
    [12, "Defined terms: the Subordinated Loan; the Existing Subordinated Loan."],
    [13, "The impact sentence on the current page. It refers to this subordinated loan."],
  ]);
  const resolved = resolveSameDocumentNavigationCounterpart(finding, pages);
  t("非数値の同一PDF別ページ引用を表示専用にsource-bindする",
    resolved.context.displayNavigationSourceValidated === true
      && resolved.counterparts.length === 1
      && resolved.counterparts[0].page === 12
      && resolved.counterparts[0].quotes.length === 2);
  t("表示専用counterpartは数値抑制の検証済みcontextへ昇格しない",
    resolved.context.sameDocumentSourceValidated !== true);
  const duplicate = resolveSameDocumentNavigationCounterpart(finding, new Map([
    [12, "the Subordinated Loan; the Subordinated Loan; the Existing Subordinated Loan."],
    [13, pages.get(13)],
  ]));
  t("別ページ引用が重複する場合はその引用をハイライト根拠にしない",
    duplicate.counterparts.length === 1
      && duplicate.counterparts[0].quotes.length === 1
      && duplicate.counterparts[0].quotes[0] === "the existing subordinated loan");
  const multiplePages = resolveSameDocumentNavigationCounterpart({
    ...finding,
    reason: `${finding.reason} P.11にも同様の記載がある。`,
  }, pages);
  t("表示用でも別ページ候補が複数ならfail closed", multiplePages.counterparts.length === 0);
}

// 完全重複（page/category/quote/suggestion 一致）は1件へ
{
  const f = [
    { page: 7, category: "numbers", quote: "12,345", suggestion: "12,346", reason: "a", pass_id: "p1" },
    { page: 7, category: "numbers", quote: "12,345", suggestion: "12,346", reason: "b（別pass同一指摘）", pass_id: "p2" },
  ];
  const d = exactDedupe(f);
  t("完全重複は1件", d.length === 1);
}

{
  t("百万／十億の丸め表記を同量と判定", hasEquivalentScaledNumbers("P.5では4,918.2、P.1では4,918,172"));
  t("51.6と51,579も同量と判定", hasEquivalentScaledNumbers("P.5では51.6、P.1では51,579"));
  t("48 thousandと48 millionは本物なので落とさない", !hasEquivalentScaledNumbers("48 thousand yen と 48 million yen"));
  t("桁prefixだけの近似はsuspect候補でもhard dropしない",
    partitionNumericFalsePositives([{ category:"value_inconsistency", reason:"同じ単位でP.1は123、P.2は1,234" }]).kept.length === 1);
  t("別指標の桁prefixもhard dropしない",
    partitionNumericFalsePositives([{ category:"value_inconsistency", reason:"売上123、利益1,234" }]).kept.length === 1);
}

{
  const sequential = "Row No.\nユーロ 18 140 160 150 155\nユーロ 19 150 170 160 165\nユーロ 20 164 185 175 180\nユーロ 21 170 190 180 185\nユーロ 22 180 200 190 195";
  t("前後の連番行で立証できる先頭数値だけ表行番号と判定",
    isLikelyTableRowIndexOmission({ category: "omission", quote: "EUR 164 185 175 180", referenceQuote: "ユーロ 20 164 185 175 180" }, sequential));
  t("孤立した追加20は実値かもしれないため残す",
    !isLikelyTableRowIndexOmission({ category: "omission", quote: "Margin 5 10", referenceQuote: "利益率 20 5 10" }, "利益率 20 5 10"));
  t("20%を行番号扱いしない",
    !isLikelyTableRowIndexOmission({ category: "omission", quote: "Margin 5 10", referenceQuote: "利益率 20% 5 10" }, "利益率 20% 5 10"));
  const fiveValueRows = "Margin 18 1 2\nMargin 19 3 4\nMargin 20 5 10\nMargin 21 6 7\nMargin 22 8 9";
  t("5行連続する年度・年齢・実値も明示的な行番号見出しがなければ残す",
    !isLikelyTableRowIndexOmission({ category: "omission", quote: "Margin 5 10", referenceQuote: "Margin 20 5 10" }, fiveValueRows));
  t("通常英文のbare noを行番号見出しと誤認しない",
    !isLikelyTableRowIndexOmission({ category: "omission", quote: "Margin 5 10", referenceQuote: "Margin 20 5 10" },
      `There is no material change.\n${fiveValueRows}`));
  t("途中の値が違う訳抜け候補は残す",
    !isLikelyTableRowIndexOmission({ category: "omission", quote: "EUR 164 185 175 180", referenceQuote: "ユーロ 20 164 999 175 180" }, sequential));
}

// 区切り文字を含む別指摘を、同じキーとして誤削除しない。
{
  const d = exactDedupe([
    { page: 1, category: "a|b", quote: "c", suggestion: "d" },
    { page: 1, category: "a", quote: "b|c", suggestion: "d" },
  ]);
  t("区切り文字を含む別指摘を保持", d.length === 2);
}

// 数値記号を同じ記号同士で不一致とした、モデルの自己矛盾だけを落とす。
{
  const same = { category: "value_inconsistency", quote: "売上 ⟦#ABC⟧", referenceQuote: "Sales ⟦#ABC⟧" };
  const signMismatch = { category: "number_mismatch", quote: "損失 △⟦#ABC⟧", referenceQuote: "Loss ⟦#ABC⟧" };
  const repeatedReason = { category: "accounting_inconsistency", reason: "合計は ⟦#XYZ⟧ ですが記載も ⟦#XYZ⟧ です" };
  const repeatedSuggestion = { category: "number_mismatch", suggestion: "⟦#XYZ⟧ と ⟦#XYZ⟧ の数値を確認する" };
  const signMismatchRepeated = { category: "number_mismatch", reason: "⟦#XYZ⟧ と △⟦#XYZ⟧ が不一致" };
  const restoredTautology = { category: "value_inconsistency", suggestion: "304と304のどちらであるか確認する" };
  const labelledTautology = { category: "value_inconsistency", suggestion: "P.4の304とP.15の304のどちらが正しいか確認する" };
  const summaryTautology = { category: "value_inconsistency", issueSummary: "世界販売台数がP.4の304とP.15の304で不一致" };
  const quotedTautology = { category: "number_mismatch", suggestion: "増減率の「1」を日本語版の「1」に対応する数値へ修正する" };
  const restoredSameRows = { category: "number_mismatch", quote: "Other 65 56 (9) (14.0)", referenceQuote: "その他 65 56 △9 △14.0%" };
  const realUnitMismatch = { category: "number_mismatch", quote: "5 million yen", referenceQuote: "5 billion yen" };
  const different = { category: "number_mismatch", quote: "⟦#ABC⟧", referenceQuote: "⟦#XYZ⟧" };
  const prose = { category: "prose_inconsistency", quote: "⟦#ABC⟧", referenceQuote: "⟦#ABC⟧" };
  const sameMoney = { category: "number_mismatch", quote: "Net sales 48 million yen", referenceQuote: "Net sales 48 million yen" };
  const sameScaled = { category: "number_mismatch", quote: "Net sales 1 billion yen", referenceQuote: "Net sales 1,000 million yen" };
  const crossVehicle = { category: "number_mismatch", quote: "Net sales 48 million yen", referenceQuote: "Vehicle sales 48 thousand vehicles" };
  const crossCount = { category: "number_mismatch", quote: "Net sales 48 million yen", referenceQuote: "48 thousand employees" };
  const crossRate = { category: "number_mismatch", quote: "Net sales 48 million yen", referenceQuote: "Rate 48%" };
  const rounded = { category: "value_inconsistency", quote: "Net sales 4,918.2 billion yen", referenceQuote: "Net sales 4,918,172 million yen" };
  const roundedReason = { category: "value_inconsistency", reason: "P.1 4,918.2 billion yen と P.2 4,918,172 million yen が不一致" };
  const okuNoSpace = { category: "number_mismatch", quote: "Net sales 12000oku", referenceQuote: "Net sales 12000 oku" };
  const okuComma = { category: "number_mismatch", quote: "Net sales 12000oku", referenceQuote: "Net sales 12,000 oku" };
  const okuValueMismatch = { category: "number_mismatch", quote: "Net sales 12000oku", referenceQuote: "Net sales 12001oku" };
  const okuUnitMismatch = { category: "number_mismatch", quote: "Net sales 12000oku", referenceQuote: "Net sales 12000 million yen" };
  const sameFamilyMismatch = { category: "number_mismatch", quote: "Net sales 48 thousand yen", referenceQuote: "Net sales 48 million yen" };
  const ambiguousUnits = { category: "number_mismatch", quote: "Total 48 thousand", referenceQuote: "Total 48 million" };
  const untyped = { category: "number_mismatch", quote: "Total 48", referenceQuote: "Total 48" };
  const spacedDelta = { category: "number_mismatch", quote: "Net sales △ 48 million yen", referenceQuote: "Net sales 48 million yen" };
  const spacedParentheses = { category: "number_mismatch", quote: "Net sales ( 48 ) million yen", referenceQuote: "Net sales 48 million yen" };
  const sameSpacedNegative = { category: "number_mismatch", quote: "Net sales ( 48 ) million yen", referenceQuote: "Net sales △ 48 million yen" };
  const spacedPlus = { category: "number_mismatch", quote: "Net sales + 48 million yen", referenceQuote: "Net sales 48 million yen" };
  const japaneseManMismatch = { category: "number_mismatch", quote: "売上 48万円", referenceQuote: "売上 48円" };
  const japaneseMillionSpacedMismatch = { category: "number_mismatch", quote: "売上 48百 万円", referenceQuote: "売上 48円" };
  const japaneseMillionEquivalent = { category: "number_mismatch", quote: "売上 48百 万円", referenceQuote: "Net sales 48 million yen" };
  const japaneseBillionEquivalent = { category: "number_mismatch", quote: "売上 48十 億円", referenceQuote: "Net sales 48 billion yen" };
  const primaryMismatchWithAuxEquality = {
    category: "number_mismatch",
    quote: "Net sales 48 million yen",
    referenceQuote: "Net sales 49 million yen",
    reason: "P.1 48 million yen と P.2 48 million yen を確認する",
    suggestion: "48 million yen と 48 million yen のどちらが正しいか確認する",
  };
  const outerPlaceholderParentheses = {
    category: "number_mismatch",
    quote: "Net sales (P.2: ⟦#ABC⟧ million yen)",
    referenceQuote: "Net sales △⟦#ABC⟧ million yen",
  };
  const simplePlaceholderParentheses = {
    category: "number_mismatch",
    quote: "Net sales ( ⟦#ABC⟧ ) million yen",
    referenceQuote: "Net sales △⟦#ABC⟧ million yen",
  };
  const result = partitionNumericFalsePositives([
    same, signMismatch, repeatedReason, repeatedSuggestion, signMismatchRepeated,
    restoredTautology, labelledTautology, summaryTautology,
    quotedTautology, restoredSameRows, realUnitMismatch, different, prose,
    sameMoney, sameScaled, crossVehicle, crossCount, crossRate, rounded, roundedReason, sameFamilyMismatch,
    ambiguousUnits, untyped, spacedDelta, spacedParentheses, sameSpacedNegative,
  ]);
  t("同一placeholder・明示単位で同じ実量・丸め差の誤検出を除外", result.dropped.length === 9
    && [same, repeatedReason, repeatedSuggestion, restoredSameRows, sameMoney, sameScaled, rounded, roundedReason, sameSpacedNegative].every(f => result.dropped.includes(f)));
  t("符号差・空白付き符号/括弧・同family単位差・異種family・曖昧/非数値分類を保持", result.kept.length === 17
    && [signMismatch, signMismatchRepeated, sameFamilyMismatch, ambiguousUnits, untyped,
      crossVehicle, crossCount, crossRate, spacedDelta, spacedParentheses, prose].every(f => result.kept.includes(f)));
  t("両側が同じ空白付き負数の等値はhard drop", result.dropped.includes(sameSpacedNegative));
  t("空白付き正号は負数扱いしない", partitionNumericFalsePositives([spacedPlus]).dropped.length === 1);
  t("48万円と48円は単位差を保持", partitionNumericFalsePositives([japaneseManMismatch]).kept.length === 1);
  t("空白分割された百万円と円は単位差を保持", partitionNumericFalsePositives([japaneseMillionSpacedMismatch]).kept.length === 1);
  t("空白分割された百万円とmillionは同量としてdrop", partitionNumericFalsePositives([japaneseMillionEquivalent]).dropped.length === 1);
  t("空白分割された十億とbillionは同量としてdrop", partitionNumericFalsePositives([japaneseBillionEquivalent]).dropped.length === 1);
  t("12000oku と 12000 oku は同量としてdrop", partitionNumericFalsePositives([okuNoSpace]).dropped.length === 1);
  t("12000oku と 12,000 oku は同量としてdrop", partitionNumericFalsePositives([okuComma]).dropped.length === 1);
  t("12000oku と 12001oku は実値差として保持", partitionNumericFalsePositives([okuValueMismatch]).kept.length === 1);
  t("oku と incompatible million yen は単位差として保持", partitionNumericFalsePositives([okuUnitMismatch]).kept.length === 1);

  const negativeOkuGapOnly = {
    category: "formatting",
    quote: "Net income (100)oku",
    referenceQuote: "Net income (100) oku",
    suggestion: "Net income (100) oku",
  };
  const negativeOkuSuggestionOnly = {
    category: "terminology",
    quote: "Net income (100)oku",
    suggestion: "Net income (100) oku",
  };
  const maskedNegativeOkuGapOnly = {
    category: "formatting",
    quote: "Net income (⟦#ABC⟧)oku",
    referenceQuote: "Net income (⟦#ABC⟧) oku",
  };
  t("(100)oku と (100) oku の空白差はformattingでもdrop",
    partitionNumericFalsePositives([negativeOkuGapOnly]).dropped.length === 1);
  t("referenceQuoteなしでも修正案がoku空白だけならdrop",
    partitionNumericFalsePositives([negativeOkuSuggestionOnly]).dropped.length === 1);
  t("マスク中の括弧負数oku空白差もdrop",
    partitionNumericFalsePositives([maskedNegativeOkuGapOnly]).dropped.length === 1);
  t("同じ大文字表記の (100)OKU / (100) OKU 空白差もdrop",
    partitionNumericFalsePositives([{
      ...negativeOkuGapOnly,
      quote: "Net income (100)OKU",
      referenceQuote: "Net income (100) OKU",
    }]).dropped.length === 1);

  // Signed oku spellings must remain equivalent even when Copilot classifies
  // the surface change as formatting or terminology.  This is deliberately
  // source-shaped so the signed normalizer cannot bypass the existing measure,
  // scale, currency, period, and row-identity gates.
  const signedOkuContext = (quote, referenceQuote, overrides = {}) => ({
    targetRowUnique: true,
    referenceRowUnique: true,
    targetRowText: quote,
    referenceRowText: referenceQuote,
    targetText: `FY2025\nUnit: oku yen\n${quote}`,
    referenceText: `FY2025\nUnit: oku yen\n${referenceQuote}`,
    ...overrides,
  });
  const signedOkuPairs = [
    ["parentheses/minus", "Net income (100)oku", "Net income -100 oku"],
    ["parentheses/unicode-minus", "Net income (100)oku", "Net income −100 oku"],
    ["parentheses/delta", "Net income (100)oku", "Net income △100oku"],
    ["parentheses/black-delta", "Net income (100)oku", "Net income ▲100 oku"],
    ["unsigned/ascii-plus", "Net income 100oku", "Net income +100 oku"],
    ["unsigned/fullwidth-plus", "Net income 100oku", "Net income ＋100 oku"],
  ];
  for (const [name, quote, referenceQuote] of signedOkuPairs) {
    for (const category of ["number_mismatch", "formatting", "terminology"]) {
      t(`signed oku ${name} drops ${category}`,
        partitionNumericFalsePositives([{ category, quote, referenceQuote }],
          signedOkuContext(quote, referenceQuote)).dropped.length === 1);
    }
  }
  for (const [name, quote, referenceQuote] of [
    ["negative sign change", "Net income (100)oku", "Net income -100 oku"],
    ["positive sign change", "Net income 100oku", "Net income +100 oku"],
  ]) {
    t(`unbound ${name} stays KEEP`,
      partitionNumericFalsePositives([{ category: "formatting", quote, referenceQuote }]).kept.length === 1);
    t(`duplicate-row ${name} stays KEEP`,
      partitionNumericFalsePositives([{ category: "formatting", quote, referenceQuote }],
        signedOkuContext(quote, referenceQuote, { targetRowUnique: false })).kept.length === 1);
  }
  const maskedSignedOkuPairs = [
    ["masked parentheses/minus", "Net income (⟦#ABC⟧)oku", "Net income -⟦#ABC⟧ oku"],
    ["masked parentheses/delta", "Net income (⟦#ABC⟧)oku", "Net income △⟦#ABC⟧ oku"],
    ["masked unsigned/ascii-plus", "Net income ⟦#ABC⟧oku", "Net income +⟦#ABC⟧ oku"],
    ["masked unsigned/fullwidth-plus", "Net income ⟦#ABC⟧oku", "Net income ＋⟦#ABC⟧ oku"],
  ];
  for (const [name, quote, referenceQuote] of maskedSignedOkuPairs) {
    for (const category of ["number_mismatch", "formatting", "terminology"]) {
      t(`${name} drops ${category}`,
        partitionNumericFalsePositives([{ category, quote, referenceQuote }],
          signedOkuContext(quote, referenceQuote)).dropped.length === 1);
    }
  }
  const signedOkuKeepCases = [
    ["positive/negative sign mismatch", "Net income (100)oku", "Net income +100 oku"],
    ["negative/positive sign mismatch", "Net income -100oku", "Net income 100 oku"],
    ["value mismatch", "Net income (101)oku", "Net income -100 oku"],
    ["unit mismatch", "Net income (100)oku", "Net income -100 million"],
    ["oku case mismatch", "Net income 100oku", "Net income 100 OKU"],
    ["Japanese currency suffix mismatch", "Net income 100億", "Net income 100億円"],
  ];
  for (const [name, quote, referenceQuote] of signedOkuKeepCases) {
    t(`signed oku ${name} stays KEEP`,
      partitionNumericFalsePositives([{ category: "formatting", quote, referenceQuote }],
        signedOkuContext(quote, referenceQuote)).kept.length === 1);
  }
  for (const [name, quote, referenceQuote] of [
    ["explicit plus inside parentheses", "Net income (+100)oku", "Net income 100 oku"],
    ["masked explicit plus inside parentheses", "Net income (+⟦#ABC⟧)oku", "Net income ⟦#ABC⟧oku"],
    ["negative sign plus parentheses", "Net income -(100)oku", "Net income -100 oku"],
    ["triangle plus parentheses", "Net income △(100)oku", "Net income △100 oku"],
  ]) {
    let result = null;
    let threw = false;
    try {
      result = partitionNumericFalsePositives([{ category: "number_mismatch", quote, referenceQuote }],
        signedOkuContext(quote, referenceQuote));
    } catch (_) {
      threw = true;
    }
    t(`ambiguous ${name} fails closed without parser crash`, !threw && result?.kept.length === 1);
  }

  const fullWidthSignedOkuPairs = [
    ["full-width parentheses", "Net income （100）oku", "Net income -100 oku"],
    ["full-width comma", "Net income （100，000）oku", "Net income -100,000 oku"],
    ["masked full-width parentheses", "Net income （⟦#ABC⟧）oku", "Net income -⟦#ABC⟧ oku"],
  ];
  for (const [name, quote, referenceQuote] of fullWidthSignedOkuPairs) {
    for (const category of ["number_mismatch", "formatting", "terminology"]) {
      t(`${name} drops ${category}`,
        partitionNumericFalsePositives([{ category, quote, referenceQuote }],
          signedOkuContext(quote, referenceQuote)).dropped.length === 1);
    }
  }
  for (const [name, quote, referenceQuote] of [
    ["full-width plus inside parentheses", "Net income （＋100）oku", "Net income 100oku"],
    ["masked full-width plus inside parentheses", "Net income （＋⟦#ABC⟧）oku", "Net income ⟦#ABC⟧oku"],
  ]) {
    let result = null;
    let threw = false;
    try {
      result = partitionNumericFalsePositives([{ category: "number_mismatch", quote, referenceQuote }],
        signedOkuContext(quote, referenceQuote));
    } catch (_) {
      threw = true;
    }
    t(`${name} stays KEEP without parser crash`, !threw && result?.kept.length === 1);
  }

  const pairwiseSignedOkuPairs = [
    ["raw two-value row", "Net income (100)oku; (200)oku", "Net income -100 oku; -200 oku"],
    ["masked two-value row", "Net income (⟦#ABC⟧)oku; (⟦#DEF⟧)oku", "Net income -⟦#ABC⟧ oku; -⟦#DEF⟧ oku"],
  ];
  for (const [name, quote, referenceQuote] of pairwiseSignedOkuPairs) {
    for (const category of ["number_mismatch", "formatting", "terminology"]) {
      t(`${name} drops ${category} only after pairwise proof`,
        partitionNumericFalsePositives([{ category, quote, referenceQuote }],
          signedOkuContext(quote, referenceQuote)).dropped.length === 1);
    }
  }
  for (const [name, quote, referenceQuote] of [
    ["second value mismatch", "Net income (100)oku; (200)oku", "Net income -100 oku; -201 oku"],
    ["second sign mismatch", "Net income (100)oku; (200)oku", "Net income -100 oku; +200 oku"],
    ["second unit mismatch", "Net income (100)oku; (200)oku", "Net income -100 oku; -200 million"],
  ]) {
    t(`pairwise ${name} stays KEEP`,
      partitionNumericFalsePositives([{
        category: "formatting",
        quote,
        referenceQuote,
      }], signedOkuContext(quote, referenceQuote)).kept.length === 1);
  }
  for (const [name, quote, referenceQuote] of [
    ["raw malformed first member", "Net income (+100)oku; 200oku", "Net income 200oku"],
    ["raw malformed minus first member", "Net income -(100)oku; 200oku", "Net income 200oku"],
    ["masked malformed first member", "Net income (+⟦#ABC⟧)oku; ⟦#DEF⟧oku", "Net income ⟦#DEF⟧oku"],
    ["masked malformed minus first member", "Net income -(⟦#ABC⟧)oku; ⟦#DEF⟧oku", "Net income ⟦#DEF⟧oku"],
  ]) {
    t(`pairwise ${name} stays KEEP`,
      partitionNumericFalsePositives([{
        category: "number_mismatch",
        quote,
        referenceQuote,
      }], signedOkuContext(quote, referenceQuote)).kept.length === 1);
  }
  t("ambiguous combined sign in suggestion vetoes the whole hard-drop",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "Net income 200oku",
      referenceQuote: "Net income 200oku",
      suggestion: "Net income (+100)oku; Net income 200oku",
    }], signedOkuContext("Net income 200oku", "Net income 200oku")).kept.length === 1);
  const auxiliaryCombinedSignCases = [
    ["ascii plus-minus", "Net income +-100oku"],
    ["ascii double-minus", "Net income --100oku"],
    ["triangle-minus", "Net income △-100oku"],
    ["full-width mixed signs", "Net income ＋−⟦#ABC⟧oku"],
    ["masked external-parentheses sign", "Net income -(⟦#ABC⟧)%"],
    ["masked triangle-parentheses percent", "Net income △(⟦#ABC⟧％)"],
    ["masked plus-parentheses percent", "Net income ＋(⟦#ABC⟧)％"],
  ];
  for (const [name, evidence] of auxiliaryCombinedSignCases) {
    for (const field of ["reason", "model_reason", "issueSummary", "issue_summary", "suggestion"]) {
      t(`auxiliary ${name} in ${field} vetoes hard-drop`,
        partitionNumericFalsePositives([{
          category: "number_mismatch",
          quote: "Net income 200oku",
          referenceQuote: "Net income 200oku",
          [field]: evidence,
        }], signedOkuContext("Net income 200oku", "Net income 200oku")).kept.length === 1);
    }
  }
  for (const [name, evidence] of [
    ["ASCII", "P.1 (△71.6％)"],
    ["full-width", "P.1 （△71.6％）"],
  ]) {
    for (const field of ["reason", "model_reason"]) {
      t(`unbound ${name} rate wrapper in ${field} stays KEEP`,
        partitionNumericFalsePositives([{
          category: "number_mismatch",
          quote: "Net income 200oku",
          referenceQuote: "Net income 200oku",
          [field]: evidence,
      }], signedOkuContext("Net income 200oku", "Net income 200oku")).kept.length === 1);
    }
  }
  const runProductionShapedNumericFilter = async (finding, targetQuote, referenceQuote) => {
    const sourceContext = {
      targetText: "FY2025\nUnit: oku yen\n" + targetQuote,
      referenceText: "FY2025\nUnit: oku yen\n" + referenceQuote,
      targetRowText: targetQuote,
      referenceRowText: referenceQuote,
      targetQuote,
      referenceQuote,
      targetRowUnique: true,
      referenceRowUnique: true,
    };
    const result = await runNumericImportTwoPass([finding], {
      prepareValidatedSameDocumentCounterparts: async () => new Map(),
      collectNumericFindingContexts: async items => new Map(
        items.map(item => [String(item.id), sourceContext]),
      ),
      targetTextFor: async () => "",
      referenceTextFor: async () => "",
      restoreMaskedFindings: async list => list,
      chooseSourceBackedQuoteVariants: async () => {},
      masker: null,
    });
    return result.maskedNumericFilter;
  };
  const mixedBracketCases = [
    ["raw ASCII-open/full-width-close", "Net income (100）oku; 200oku", "Net income 200oku"],
    ["raw full-width-open/ASCII-close", "Net income （100)oku; 200oku", "Net income 200oku"],
    ["raw signed ASCII-open/full-width-close", "Net income - (100）oku; 200oku", "Net income 200oku"],
    ["masked ASCII-open/full-width-close", "Net income (⟦#ABC⟧）oku; ⟦#DEF⟧oku", "Net income ⟦#DEF⟧oku"],
    ["masked full-width-open/ASCII-close", "Net income （⟦#ABC⟧)oku; ⟦#DEF⟧oku", "Net income ⟦#DEF⟧oku"],
    ["masked signed full-width-open/ASCII-close", "Net income ＋（⟦#ABC⟧)oku; ⟦#DEF⟧oku", "Net income ⟦#DEF⟧oku"],
  ];
  const mixedBracketEvidenceFields = [
    "quote", "referenceQuote", "reference_quote", "suggestion",
    "reason", "model_reason", "issueSummary", "issue_summary",
  ];
  for (const [caseName, malformed, valid] of mixedBracketCases) {
    for (const field of mixedBracketEvidenceFields) {
      const finding = {
        id: "mixed-bracket-" + caseName + "-" + field,
        page: 1,
        category: "number_mismatch",
        quote: valid,
      };
      if (field === "quote") {
        finding.quote = malformed;
        finding.referenceQuote = valid;
      } else if (field === "referenceQuote") {
        finding.referenceQuote = malformed;
      } else if (field === "reference_quote") {
        finding.reference_quote = malformed;
      } else {
        finding.referenceQuote = valid;
        finding[field] = malformed;
      }
      const referenceQuote = finding.referenceQuote ?? finding.reference_quote;
      const filtered = await runProductionShapedNumericFilter(
        finding,
        finding.quote,
        referenceQuote,
      );
      t("production mixed brackets in " + field + " (" + caseName + ") stay KEEP",
        filtered.kept.length === 1 && filtered.dropped.length === 0);
    }
  }
  for (const [caseName, quote, referenceQuote] of [
    ["matched ASCII parentheses", "Net income (100)oku", "Net income -100 oku"],
    ["matched full-width parentheses", "Net income （100）oku", "Net income -100 oku"],
    ["matched masked ASCII parentheses", "Net income (⟦#ABC⟧)oku", "Net income -⟦#ABC⟧ oku"],
    ["matched masked full-width parentheses", "Net income （⟦#ABC⟧）oku", "Net income -⟦#ABC⟧ oku"],
  ]) {
    const finding = {
      id: "matched-bracket-" + caseName,
      page: 1,
      category: "number_mismatch",
      quote,
      referenceQuote,
    };
    const filtered = await runProductionShapedNumericFilter(finding, quote, referenceQuote);
    t("production " + caseName + " remains DROP",
      filtered.kept.length === 0 && filtered.dropped.length === 1);
  }
  t("ordinary prose mixed brackets do not veto a valid DROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "Net income 200oku",
      referenceQuote: "Net income 200oku",
      reason: "ordinary prose (note）",
    }], signedOkuContext("Net income 200oku", "Net income 200oku")).dropped.length === 1);
  const japaneseSignedOkuPairs = [
    ["Japanese negative", "Net sales -100oku", "売上高 △100億円"],
    ["Japanese positive", "Net sales +100oku", "売上高 100億円"],
  ];
  for (const [name, quote, referenceQuote] of japaneseSignedOkuPairs) {
    for (const category of ["number_mismatch", "formatting", "terminology"]) {
      t(`source-bound ${name} drops ${category}`,
        partitionNumericFalsePositives([{ category, quote, referenceQuote }], {
          targetRowUnique: true,
          referenceRowUnique: true,
          targetRowText: quote,
          referenceRowText: referenceQuote,
          targetText: `FY2025\nUnit: oku yen\n${quote}`,
          referenceText: `FY2025\n単位: 億円\n${referenceQuote}`,
        }).dropped.length === 1);
    }
  }
  for (const [name, context] of [
    ["period conflict", signedOkuContext("Net income (100)oku", "Net income -100 oku", {
      referenceText: "FY2024\nUnit: oku yen\nNet income -100 oku",
    })],
    ["currency conflict", signedOkuContext("Net income (100)oku", "Net income -100 oku", {
      referenceText: "FY2025\nUnit: oku USD\nNet income -100 oku",
    })],
    ["measure conflict", signedOkuContext("Net income (100)oku", "Net income -100 oku", {
      referenceRowText: "Net sales -100 oku",
      referenceText: "FY2025\nUnit: oku yen\nNet sales -100 oku",
    })],
    ["ambiguous source caption", signedOkuContext("Net income (100)oku", "Net income -100 oku", {
      targetText: "FY2025\nUnit: oku yen / million yen\nNet income (100)oku",
    })],
  ]) {
    t(`signed oku ${name} stays KEEP`,
      partitionNumericFalsePositives([{
        category: "formatting",
        quote: "Net income (100)oku",
        referenceQuote: "Net income -100 oku",
      }], context).kept.length === 1);
  }
  // The browser's first pass can classify a raw signed-oku finding as
  // masker-compatible before partitionNumericFalsePositives runs.  Build the
  // context through the real numeric-source collector so scope labels that
  // are present in the source window but omitted from rowText still veto both
  // the early and restored DROP paths.
  const runCollectedSignedOku = async (targetScope, referenceScope, options = {}) => {
    const targetQuote = String(options.targetQuote || "Net income (100)oku");
    const referenceQuote = String(options.referenceQuote || "Net income -100 oku");
    const targetLine = options.targetLine
      || [targetScope, targetQuote].filter(Boolean).join(" ");
    const referenceLine = options.referenceLine
      || [referenceScope, referenceQuote].filter(Boolean).join(" ");
    const targetText = options.targetText
      || `${options.targetPrefixBeforeHeader || ""}FY2025\nUnit: oku yen\n${options.targetPrefix || ""}${targetLine}`;
    const referenceText = options.referenceText
      || `${options.referencePrefixBeforeHeader || ""}FY2025\nUnit: oku yen\n${options.referencePrefix || ""}${referenceLine}`;
    const finding = {
      id: `collected-signed-oku-${targetScope}-${referenceScope}`,
      page: 1,
      category: options.category || "number_mismatch",
      quote: targetQuote,
      referenceQuote,
      referenceFile: "scope-ref",
      referencePages: [1],
    };
    const referenceSource = { id: "scope-ref", fileName: "scope-ref", totalPages: 1 };
    return runNumericImportTwoPass([finding], {
      prepareValidatedSameDocumentCounterparts: async () => new Map(),
      collectNumericFindingContexts: (items, contextOptions) => collectNumericFindingContexts(items, {
        ...contextOptions,
        referenceSourceFor: () => options.disableSourceBinding ? null : referenceSource,
        referencePageCountFor: () => 1,
      }),
      targetTextFor: async () => targetText,
      referenceTextFor: async () => referenceText,
      restoreMaskedFindings: async list => list,
      chooseSourceBackedQuoteVariants: async () => {},
      isMaskerCompatibleNumericFinding: options.disableEarlyRoute
        ? () => false
        : (item, context) => Boolean(isConclusiveNumericFalsePositive(item, context)),
    });
  };
  for (const [name, targetScope, referenceScope] of [
    ["English consolidated-vs-standalone", "Consolidated", "Standalone"],
    ["Japanese 連結-vs-単体", "連結", "単体"],
    ["actual-vs-forecast", "Actual", "Forecast"],
  ]) {
    const result = await runCollectedSignedOku(targetScope, referenceScope);
    t(`production collector ${name} blocks early signed-oku DROP`,
      result.compatibleNumericDropped.length === 0
        && result.maskedNumericFilter.kept.length === 1
        && result.maskedNumericFilter.dropped.length === 0
        && result.restoredNumericFilter.kept.length === 1
        && result.restoredNumericFilter.dropped.length === 0);
  }
  const sameScopeCollected = await runCollectedSignedOku("Consolidated", "Consolidated");
  t("production collector compatible same-scope signed-oku still DROPs early",
    sameScopeCollected.compatibleNumericDropped.length === 1
      && sameScopeCollected.maskedNumericFilter.kept.length === 0
      && sameScopeCollected.restoredFindings.length === 0
      && sameScopeCollected.restoredNumericFilter.dropped.length === 0);
  for (const category of ["number_mismatch", "formatting", "terminology"]) {
    const sameScopeCategory = await runCollectedSignedOku("Consolidated", "Consolidated", { category });
    const sameScopeCategoryNormal = await runCollectedSignedOku("Consolidated", "Consolidated", {
      category,
      disableEarlyRoute: true,
    });
    t(`production collector ${category} same-scope signed-oku DROPs in early/normal routes`,
      sameScopeCategory.compatibleNumericDropped.length === 1
        && sameScopeCategory.maskedNumericFilter.kept.length === 0
        && sameScopeCategoryNormal.compatibleNumericDropped.length === 0
        && sameScopeCategoryNormal.maskedNumericFilter.kept.length === 0
        && sameScopeCategoryNormal.maskedNumericFilter.dropped.length === 1);
    const conflictCategory = await runCollectedSignedOku("Consolidated", "Standalone", { category });
    const conflictCategoryNormal = await runCollectedSignedOku("Consolidated", "Standalone", {
      category,
      disableEarlyRoute: true,
    });
    t(`production collector ${category} conflicting scopes stay KEEP in early/normal routes`,
      conflictCategory.compatibleNumericDropped.length === 0
        && conflictCategory.maskedNumericFilter.kept.length === 1
        && conflictCategoryNormal.maskedNumericFilter.kept.length === 1
        && conflictCategoryNormal.maskedNumericFilter.dropped.length === 0);
    const unboundCategory = await runCollectedSignedOku("", "", {
      category,
      disableSourceBinding: true,
    });
    const unboundCategoryNormal = await runCollectedSignedOku("", "", {
      category,
      disableSourceBinding: true,
      disableEarlyRoute: true,
    });
    t(`production collector ${category} unbound signed-oku stays KEEP in early/normal routes`,
      unboundCategory.compatibleNumericDropped.length === 0
        && unboundCategory.maskedNumericFilter.kept.length === 1
        && unboundCategoryNormal.maskedNumericFilter.kept.length === 1
        && unboundCategoryNormal.maskedNumericFilter.dropped.length === 0);
    const mismatchCategory = await runCollectedSignedOku("Consolidated", "Consolidated", {
      category,
      referenceQuote: "Net income (101) oku",
    });
    const mismatchCategoryNormal = await runCollectedSignedOku("Consolidated", "Consolidated", {
      category,
      referenceQuote: "Net income (101) oku",
      disableEarlyRoute: true,
    });
    t(`production collector ${category} signed-oku value mismatch stays KEEP in early/normal routes`,
      mismatchCategory.compatibleNumericDropped.length === 0
        && mismatchCategory.maskedNumericFilter.kept.length === 1
        && mismatchCategoryNormal.maskedNumericFilter.kept.length === 1
        && mismatchCategoryNormal.maskedNumericFilter.dropped.length === 0);
  }
  for (const category of ["formatting", "terminology"]) {
    const semanticSurfaceCategory = await runCollectedSignedOku("Consolidated", "Consolidated", {
      category,
      targetQuote: "Net income (100)oku before tax",
      referenceQuote: "Net income -100 oku after tax",
    });
    const semanticSurfaceCategoryNormal = await runCollectedSignedOku("Consolidated", "Consolidated", {
      category,
      targetQuote: "Net income (100)oku before tax",
      referenceQuote: "Net income -100 oku after tax",
      disableEarlyRoute: true,
    });
    t(`production collector ${category} before/after-tax signed-oku wording stays KEEP in early/normal routes`,
      semanticSurfaceCategory.compatibleNumericDropped.length === 0
        && semanticSurfaceCategory.maskedNumericFilter.kept.length === 1
        && semanticSurfaceCategoryNormal.maskedNumericFilter.kept.length === 1
        && semanticSurfaceCategoryNormal.maskedNumericFilter.dropped.length === 0);
  }
  for (const [name, targetQuote, referenceQuote] of [
    ["double-space residual", "Net  income (100)oku", "Net income -100 oku"],
    ["tab residual", "Net income (100)oku", "Net\tincome -100 oku"],
  ]) {
    for (const category of ["formatting", "terminology"]) {
      const whitespaceSurfaceCategory = await runCollectedSignedOku("Consolidated", "Consolidated", {
        category,
        targetQuote,
        referenceQuote,
      });
      const whitespaceSurfaceCategoryNormal = await runCollectedSignedOku("Consolidated", "Consolidated", {
        category,
        targetQuote,
        referenceQuote,
        disableEarlyRoute: true,
      });
      t(`production collector ${category} ${name} valid surface-only form DROPs in early/normal routes`,
        whitespaceSurfaceCategory.compatibleNumericDropped.length === 1
          && whitespaceSurfaceCategory.maskedNumericFilter.kept.length === 0
          && whitespaceSurfaceCategoryNormal.compatibleNumericDropped.length === 0
          && whitespaceSurfaceCategoryNormal.maskedNumericFilter.kept.length === 0
          && whitespaceSurfaceCategoryNormal.maskedNumericFilter.dropped.length === 1);
    }
  }
  for (const [name, targetQuote, referenceQuote] of [
    ["U+FF0D vs unsigned", "Net income －100oku", "Net income 100 oku"],
    ["U+FF0D vs explicit plus", "Net income －100oku", "Net income +100 oku"],
  ]) {
    const dashResult = await runCollectedSignedOku("Consolidated", "Consolidated", {
      targetQuote,
      referenceQuote,
    });
    t(`production collector ${name} stays KEEP in the early oku route`,
      dashResult.compatibleNumericDropped.length === 0
        && dashResult.maskedNumericFilter.kept.length === 1
        && dashResult.restoredNumericFilter.kept.length === 1);
  }
  const unrelatedPriorScope = await runCollectedSignedOku("Consolidated", "Consolidated", {
    targetPrefixBeforeHeader: "Standalone note for another table\n",
  });
  t("production collector ignores unrelated prior Standalone note for same Consolidated row",
    unrelatedPriorScope.compatibleNumericDropped.length === 1
      && unrelatedPriorScope.maskedNumericFilter.kept.length === 0);
  for (const [name, preceding] of [
    ["Standalone narrative results", "Standalone results were discussed above."],
    ["Standalone other-table heading", "Standalone Statement of Cash Flows"],
  ]) {
    const adversarialOptions = {
      targetPrefixBeforeHeader: `${preceding}\n`,
    };
    const early = await runCollectedSignedOku("Consolidated", "Consolidated", adversarialOptions);
    const normal = await runCollectedSignedOku("Consolidated", "Consolidated", {
      ...adversarialOptions,
      disableEarlyRoute: true,
    });
    t(`production collector ${name} does not override explicit Consolidated row in early/normal routes`,
      early.compatibleNumericDropped.length === 1
        && early.maskedNumericFilter.kept.length === 0
        && normal.compatibleNumericDropped.length === 0
        && normal.maskedNumericFilter.kept.length === 0
        && normal.maskedNumericFilter.dropped.length === 1);
  }
  const captionScopeConflict = await runCollectedSignedOku("", "", {
    targetPrefix: "Consolidated Statement of Income\n",
    referencePrefix: "Standalone Statement of Income\n",
  });
  const captionScopeConflictNormal = await runCollectedSignedOku("", "", {
    targetPrefix: "Consolidated Statement of Income\n",
    referencePrefix: "Standalone Statement of Income\n",
    disableEarlyRoute: true,
  });
  t("production collector bound caption scope conflict stays KEEP in early/normal routes",
    captionScopeConflict.compatibleNumericDropped.length === 0
      && captionScopeConflict.maskedNumericFilter.kept.length === 1
      && captionScopeConflictNormal.maskedNumericFilter.kept.length === 1
      && captionScopeConflictNormal.maskedNumericFilter.dropped.length === 0);
  const distantCaptionConflict = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Statement of Income\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Statement of Income\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
  });
  const distantCaptionConflictNormal = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Statement of Income\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Statement of Income\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector associated four-line caption scope conflict stays KEEP in early/normal routes",
    distantCaptionConflict.compatibleNumericDropped.length === 0
      && distantCaptionConflict.maskedNumericFilter.kept.length === 1
      && distantCaptionConflictNormal.maskedNumericFilter.kept.length === 1
      && distantCaptionConflictNormal.maskedNumericFilter.dropped.length === 0);
  const distantCaptionSameScope = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Statement of Income\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Consolidated Statement of Income\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
  });
  t("production collector associated four-line same-scope caption still DROPs",
    distantCaptionSameScope.compatibleNumericDropped.length === 1
      && distantCaptionSameScope.maskedNumericFilter.kept.length === 0);
  const forFyCaptionConflict = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Financial Results for FY2025\nAudited\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Financial Results for FY2025\nAudited\nUnit: oku yen\nNet income -100 oku",
  });
  const forFyCaptionConflictNormal = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Financial Results for FY2025\nAudited\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Financial Results for FY2025\nAudited\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector Financial Results for FY caption conflict stays KEEP in early/normal routes",
    forFyCaptionConflict.compatibleNumericDropped.length === 0
      && forFyCaptionConflict.maskedNumericFilter.kept.length === 1
      && forFyCaptionConflictNormal.maskedNumericFilter.kept.length === 1
      && forFyCaptionConflictNormal.maskedNumericFilter.dropped.length === 0);
  const noteCaptionConflict = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Financial Results (Note)\nAudited\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Financial Results (Note)\nAudited\nUnit: oku yen\nNet income -100 oku",
  });
  const noteCaptionConflictNormal = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Financial Results (Note)\nAudited\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Financial Results (Note)\nAudited\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector Financial Results (Note) caption conflict stays KEEP in early/normal routes",
    noteCaptionConflict.compatibleNumericDropped.length === 0
      && noteCaptionConflict.maskedNumericFilter.kept.length === 1
      && noteCaptionConflictNormal.maskedNumericFilter.kept.length === 1
      && noteCaptionConflictNormal.maskedNumericFilter.dropped.length === 0);
  for (const [name, targetCaption, referenceCaption] of [
    ["Financial Results are as follows", "Consolidated Financial Results are as follows", "Standalone Financial Results are as follows"],
    ["Statement of Income is presented below", "Consolidated Statement of Income is presented below", "Standalone Statement of Income is presented below"],
  ]) {
    const copulaCaptionConflict = await runCollectedSignedOku("", "", {
      targetText: `${targetCaption}\nAudited\nUnit: oku yen\nNet income (100)oku`,
      referenceText: `${referenceCaption}\nAudited\nUnit: oku yen\nNet income -100 oku`,
    });
    const copulaCaptionConflictNormal = await runCollectedSignedOku("", "", {
      targetText: `${targetCaption}\nAudited\nUnit: oku yen\nNet income (100)oku`,
      referenceText: `${referenceCaption}\nAudited\nUnit: oku yen\nNet income -100 oku`,
      disableEarlyRoute: true,
    });
    t(`production collector ${name} caption conflict stays KEEP in early/normal routes`,
      copulaCaptionConflict.compatibleNumericDropped.length === 0
        && copulaCaptionConflict.maskedNumericFilter.kept.length === 1
        && copulaCaptionConflictNormal.maskedNumericFilter.kept.length === 1
        && copulaCaptionConflictNormal.maskedNumericFilter.dropped.length === 0);
  }
  const ordinaryNarrativeCaption = await runCollectedSignedOku("", "", {
    targetText: "Standalone results were discussed above.\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Consolidated results were discussed above.\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
  });
  const ordinaryNarrativeCaptionNormal = await runCollectedSignedOku("", "", {
    targetText: "Standalone results were discussed above.\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Consolidated results were discussed above.\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector ordinary narrative caption is ignored in early/normal routes",
    ordinaryNarrativeCaption.compatibleNumericDropped.length === 1
      && ordinaryNarrativeCaption.maskedNumericFilter.kept.length === 0
      && ordinaryNarrativeCaptionNormal.maskedNumericFilter.kept.length === 0
      && ordinaryNarrativeCaptionNormal.maskedNumericFilter.dropped.length === 1);
  const summarizedNarrativeCaption = await runCollectedSignedOku("", "", {
    targetText: "Standalone results were summarized above.\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Consolidated results were summarized above.\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
  });
  const summarizedNarrativeCaptionNormal = await runCollectedSignedOku("", "", {
    targetText: "Standalone results were summarized above.\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Consolidated results were summarized above.\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector summarized narrative caption is ignored in early/normal routes",
    summarizedNarrativeCaption.compatibleNumericDropped.length === 1
      && summarizedNarrativeCaption.maskedNumericFilter.kept.length === 0
      && summarizedNarrativeCaptionNormal.maskedNumericFilter.kept.length === 0
      && summarizedNarrativeCaptionNormal.maskedNumericFilter.dropped.length === 1);
  const summarizedBelowCaptionConflict = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Financial Results are summarized below\nAudited\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Financial Results are summarized below\nAudited\nUnit: oku yen\nNet income -100 oku",
  });
  const summarizedBelowCaptionConflictNormal = await runCollectedSignedOku("", "", {
    targetText: "Consolidated Financial Results are summarized below\nAudited\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Standalone Financial Results are summarized below\nAudited\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector Financial Results summarized below caption conflict stays KEEP in early/normal routes",
    summarizedBelowCaptionConflict.compatibleNumericDropped.length === 0
      && summarizedBelowCaptionConflict.maskedNumericFilter.kept.length === 1
      && summarizedBelowCaptionConflictNormal.maskedNumericFilter.kept.length === 1
      && summarizedBelowCaptionConflictNormal.maskedNumericFilter.dropped.length === 0);
  const japaneseBelowCaptionConflict = await runCollectedSignedOku("", "", {
    targetText: "連結財務諸表は下記のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "単体財務諸表は下記のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income -100 oku",
  });
  const japaneseBelowCaptionConflictNormal = await runCollectedSignedOku("", "", {
    targetText: "連結財務諸表は下記のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "単体財務諸表は下記のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector Japanese 下記 caption conflict stays KEEP in early/normal routes",
    japaneseBelowCaptionConflict.compatibleNumericDropped.length === 0
      && japaneseBelowCaptionConflict.maskedNumericFilter.kept.length === 1
      && japaneseBelowCaptionConflictNormal.maskedNumericFilter.kept.length === 1
      && japaneseBelowCaptionConflictNormal.maskedNumericFilter.dropped.length === 0);
  for (const [name, word] of [["上記", "上記"], ["前述", "前述"]]) {
    const japaneseRetrospectiveCaption = await runCollectedSignedOku("", "", {
      targetText: `連結財務諸表は${word}のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income (100)oku`,
      referenceText: `単体財務諸表は${word}のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income -100 oku`,
    });
    const japaneseRetrospectiveCaptionNormal = await runCollectedSignedOku("", "", {
      targetText: `連結財務諸表は${word}のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income (100)oku`,
      referenceText: `単体財務諸表は${word}のとおり\n監査済み\nFY2025\nUnit: oku yen\nNet income -100 oku`,
      disableEarlyRoute: true,
    });
    t(`production collector Japanese ${name} retrospective caption is ignored in early/normal routes`,
      japaneseRetrospectiveCaption.compatibleNumericDropped.length === 1
        && japaneseRetrospectiveCaption.maskedNumericFilter.kept.length === 0
        && japaneseRetrospectiveCaptionNormal.maskedNumericFilter.kept.length === 0
        && japaneseRetrospectiveCaptionNormal.maskedNumericFilter.dropped.length === 1);
  }
  const labeledNoteNarrative = await runCollectedSignedOku("", "", {
    targetText: "Note: Standalone results are listed below.\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Note: Consolidated results are listed below.\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
  });
  const labeledNoteNarrativeNormal = await runCollectedSignedOku("", "", {
    targetText: "Note: Standalone results are listed below.\nAudited\nFY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "Note: Consolidated results are listed below.\nAudited\nFY2025\nUnit: oku yen\nNet income -100 oku",
    disableEarlyRoute: true,
  });
  t("production collector labeled Note prose is ignored in early/normal routes",
    labeledNoteNarrative.compatibleNumericDropped.length === 1
      && labeledNoteNarrative.maskedNumericFilter.kept.length === 0
      && labeledNoteNarrativeNormal.maskedNumericFilter.kept.length === 0
      && labeledNoteNarrativeNormal.maskedNumericFilter.dropped.length === 1);
  const ambiguousScopeCollected = await runCollectedSignedOku(
    "Consolidated Standalone", "Consolidated",
  );
  t("production collector ambiguous source scope blocks early signed-oku DROP",
    ambiguousScopeCollected.compatibleNumericDropped.length === 0
      && ambiguousScopeCollected.maskedNumericFilter.kept.length === 1);
  for (const [name, finding] of [
    ["負数と正数の符号差", { ...negativeOkuGapOnly, referenceQuote: "Net income 100 oku" }],
    ["負数の値差", { ...negativeOkuGapOnly, referenceQuote: "Net income (101) oku" }],
    ["負数の単位差", { ...negativeOkuGapOnly, referenceQuote: "Net income (100) million" }],
    ["oku大文字小文字の差", { ...negativeOkuGapOnly, referenceQuote: "Net income (100) Oku" }],
    ["REF値差をsuggestionの空白修正で隠さない", { ...negativeOkuGapOnly, referenceQuote: "Net income (101) oku", suggestion: "Net income (100) oku" }],
    ["理由欄の値差を空白差で隠さない", { ...negativeOkuGapOnly, reason: "Net income (100) oku と Net income (101) oku が不一致" }],
  ]) {
    t(`${name}はoku空白だけの差ではないため保持`, partitionNumericFalsePositives([finding]).kept.length === 1);
  }
  const negativeOkuContextBase = {
    targetRowUnique: true,
    referenceRowUnique: true,
    targetRowText: "Net income (100)oku",
    referenceRowText: "Net income (100) oku",
    targetText: "FY2025\nUnit: oku yen\nNet income (100)oku",
    referenceText: "FY2025\nUnit: oku yen\nNet income (100) oku",
  };
  for (const [name, context] of [
    ["出典年度差", { ...negativeOkuContextBase, referenceText: "FY2024\nUnit: oku yen\nNet income (100) oku" }],
    ["出典通貨差", { ...negativeOkuContextBase, referenceText: "FY2025\nUnit: oku USD\nNet income (100) oku" }],
    ["出典指標差", { ...negativeOkuContextBase, referenceRowText: "Net sales (100) oku", referenceText: "FY2025\nUnit: oku yen\nNet sales (100) oku" }],
  ]) {
    t(`${name}がある空白差は保持`, partitionNumericFalsePositives([negativeOkuGapOnly], context).kept.length === 1);
  }
  t("cross-language negative oku with one-sided unresolved currency stays visible",
    partitionNumericFalsePositives([{
      category: "formatting",
      quote: "Net sales (100)oku",
      referenceQuote: "売上高 △100億円",
    }], {
      sameDocumentSourceValidated: true,
      targetRowUnique: true,
      referenceRowUnique: true,
      targetRowText: "Net sales (100)oku",
      referenceRowText: "売上高 △100億円",
      targetText: "FY2025\nNet sales (100)oku",
      referenceText: "FY2025\n単位: 億円\n売上高 △100億円",
    }).kept.length === 1);

  // Production-shaped same-document evidence uses the nearest unit header
  // when binding a counterpart row.  `oku` must participate in that header
  // vocabulary just like the Japanese 億 equivalent; the old parser omitted
  // it from explicitUnitExponents, so this source-bound case failed closed.
  const okuJapaneseSourceFinding = {
    id: "oku-japanese-source",
    page: 1,
    category: "number_mismatch",
    quote: "Net sales 12000oku",
    referenceQuote: "売上高 12000億円",
    reason: "P.1では「Net sales 12000oku」、P.2では「売上高 12000億円」が不一致。",
    issueSummary: "P.1では「Net sales 12000oku」、P.2では「売上高 12000億円」が不一致。",
  };
  const okuJapaneseSourcePages = new Map([
    [1, "Unit: oku\nNet sales 12000oku"],
    [2, "単位: 億円\n売上高 12000億円"],
  ]);
  const okuJapaneseValidated = validateSameDocumentCounterpartContext(
    okuJapaneseSourceFinding,
    okuJapaneseSourcePages,
  );
  t("Japanese-equivalent oku row is source-bound", okuJapaneseValidated.counterparts.length === 1
    && okuJapaneseValidated.counterparts[0].page === 2);
  const okuJapaneseTwoPass = await runNumericImportTwoPass(
    [{ ...okuJapaneseSourceFinding }],
    {
      prepareValidatedSameDocumentCounterparts: async (items, targetTextFor, sourceCache) => {
        const contexts = new Map();
        for (const item of items) {
          const pages = new Map([
            [1, await targetTextFor(1)],
            [2, await targetTextFor(2)],
          ]);
          const validated = validateSameDocumentCounterpartContext(item, pages, { sourceCache });
          item.counterparts = validated.counterparts;
          if (Object.keys(validated.context).length) {
            contexts.set(String(item.id), validated.context);
          }
        }
        return contexts;
      },
      collectNumericFindingContexts: async () => new Map(),
      targetTextFor: async page => String(okuJapaneseSourcePages.get(page) || ""),
      referenceTextFor: async () => "",
      restoreMaskedFindings: async list => list,
      chooseSourceBackedQuoteVariants: async () => {},
      masker: null,
    },
  );
  t("Japanese-equivalent oku source binding survives the two-pass import",
    okuJapaneseTwoPass.validatedCounterpartContexts.has("oku-japanese-source")
      && okuJapaneseTwoPass.maskedNumericFilter.dropped.length === 1);
  const negativeOkuJapanesePages = new Map([
    [1, "FY2025\nUnit: oku yen\nNet sales (100)oku"],
    [2, "FY2025\n単位: 億円\n売上高 △100億円"],
  ]);
  t("unbound negative oku Japanese formatting stays visible",
    partitionNumericFalsePositives([{
      category: "formatting",
      quote: "Net sales (100)oku",
      referenceQuote: "売上高 △100億円",
    }]).kept.length === 1);
  const runNegativeOkuJapaneseTwoPass = async (category, pages, suffix,
    targetQuote = "Net sales (100)oku") => {
    const finding = {
      id: `negative-oku-japanese-${category}-${suffix}`,
      page: 1,
      category,
      quote: targetQuote,
      referenceQuote: "売上高 △100億円",
      reason: `P.1の「${targetQuote}」とP.2の「売上高 △100億円」が不一致。`,
      issueSummary: `P.1の「${targetQuote}」とP.2の「売上高 △100億円」が不一致。`,
    };
    const twoPass = await runNumericImportTwoPass(
      [finding],
      {
        prepareValidatedSameDocumentCounterparts: async (items, targetTextFor, sourceCache) => {
          const contexts = new Map();
          for (const item of items) {
            const pages = new Map([
              [1, await targetTextFor(1)],
              [2, await targetTextFor(2)],
            ]);
            const validated = validateSameDocumentCounterpartContext(item, pages, { sourceCache });
            item.counterparts = validated.counterparts;
            if (Object.keys(validated.context).length) contexts.set(String(item.id), validated.context);
          }
          return contexts;
        },
        collectNumericFindingContexts: async () => new Map(),
        targetTextFor: async page => String(pages.get(page) || ""),
        referenceTextFor: async () => "",
        restoreMaskedFindings: async list => list,
        chooseSourceBackedQuoteVariants: async () => {},
        masker: null,
      },
    );
    return { finding, twoPass };
  };
  for (const category of ["formatting", "terminology"]) {
    const { finding, twoPass } = await runNegativeOkuJapaneseTwoPass(
      category,
      negativeOkuJapanesePages,
      "compatible",
    );
    t(`source-bound negative oku Japanese equivalence drops ${category}`,
      twoPass.validatedCounterpartContexts.has(finding.id)
        && twoPass.maskedNumericFilter.dropped.length === 1);
  }
  const mixedCaptionNegativeOkuPages = new Map([
    [1, "FY2025\nUnit: oku yen\nNet sales (100)oku"],
    [2, "FY2025\n連結業績 (単位：億円) グローバル販売台数 (単位：千台)\n売上高 △100億円"],
  ]);
  const mixedCaptionNegativeOku = await runNegativeOkuJapaneseTwoPass(
    "formatting",
    mixedCaptionNegativeOkuPages,
    "mixed-side-by-side-caption",
  );
  t("source-bound negative oku selects matching scale from mixed side-by-side captions",
    mixedCaptionNegativeOku.twoPass.validatedCounterpartContexts.has(mixedCaptionNegativeOku.finding.id)
      && mixedCaptionNegativeOku.twoPass.maskedNumericFilter.dropped.length === 1);
  for (const [name, targetCaption, targetQuote = "Net sales (100)oku"] of [
    ["currency conflict", "Unit: oku USD"],
    ["scale conflict", "Unit: million yen"],
    ["scale-only conflict", "Unit: million", "Net sales (100)oku yen"],
    ["ambiguous captions", "Unit: oku yen / million yen"],
  ]) {
    const pages = new Map([
      [1, `FY2025\n${targetCaption}\n${targetQuote}`],
      [2, "FY2025\n単位: 億円\n売上高 △100億円"],
    ]);
    const { finding, twoPass } = await runNegativeOkuJapaneseTwoPass(
      "formatting",
      pages,
      name.replace(/\s+/g, "-"),
      targetQuote,
    );
    t(`source-bound negative oku ${name} stays visible`,
      twoPass.validatedCounterpartContexts.has(finding.id)
        && twoPass.maskedNumericFilter.kept.length === 1);
  }
  const inlineCaptionConflictPages = new Map([
    [1, "FY2025\nUnit: oku USD\nNet sales (100)oku yen"],
    [2, "FY2025\n単位: 億円\n売上高 △100億円"],
  ]);
  const inlineCaptionConflict = await runNegativeOkuJapaneseTwoPass(
    "formatting",
    inlineCaptionConflictPages,
    "inline-caption-conflict",
    "Net sales (100)oku yen",
  );
  t("source-bound negative oku inline unit versus caption conflict stays visible",
    inlineCaptionConflict.twoPass.validatedCounterpartContexts.has(inlineCaptionConflict.finding.id)
      && inlineCaptionConflict.twoPass.maskedNumericFilter.kept.length === 1);
  const oneSidedCurrencyPages = new Map([
    [1, "FY2025\nNet sales (100)oku"],
    [2, "FY2025\n単位: 億円\n売上高 △100億円"],
  ]);
  const oneSidedCurrency = await runNegativeOkuJapaneseTwoPass(
    "formatting",
    oneSidedCurrencyPages,
    "one-sided-currency",
  );
  t("source-bound negative oku one-sided unresolved currency stays visible",
    !oneSidedCurrency.twoPass.validatedCounterpartContexts.has(oneSidedCurrency.finding.id)
      && oneSidedCurrency.twoPass.maskedNumericFilter.kept.length === 1);
  t("億円とbillionは同量としてdrop", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 5,500.0 billion yen",
    referenceQuote: "売上高 55,000 億円",
  }]).dropped.length === 1);
  t("百万円とmillionは同量としてdrop", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 5,500.0 million yen",
    referenceQuote: "売上高 5,500 百万円",
  }]).dropped.length === 1);
  t("明示単位がある12.3 million対123百万円は実値差として保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 12.3 million yen",
    referenceQuote: "売上高 123 百万円",
  }]).kept.length === 1);
  t("明示単位がある1.23 billion対123十億円は実値差として保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 1.23 billion yen",
    referenceQuote: "売上高 123 十億円",
  }]).kept.length === 1);
  t("明示通貨がある12.3 yen対123円は実値差として保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 12.3 yen",
    referenceQuote: "売上高 123 円",
  }]).kept.length === 1);
  t("明示通貨がある12.3 USD対123 USDは実値差として保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 12.3 USD",
    referenceQuote: "売上高 123 USD",
  }]).kept.length === 1);
  t("primary quote/referenceの不一致はauxiliary同値でdropしない", partitionNumericFalsePositives([primaryMismatchWithAuxEquality]).kept.length === 1);
  t("primary片側だけ数値がある場合はauxiliary同値でdropしない", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales were not disclosed",
    referenceQuote: "Net sales 50,000 million yen",
    suggestion: "P.22の60,132とP.25の60,132のどちらが正しいか確認する",
  }]).kept.length === 1);
  t("説明用外括弧のplaceholderは負数扱いせず符号差を保持", partitionNumericFalsePositives([outerPlaceholderParentheses]).kept.length === 1);
  t("placeholderを空白だけで囲む括弧は負数としてdrop", partitionNumericFalsePositives([simplePlaceholderParentheses]).dropped.length === 1);
  t("曖昧/無型の比較はconclusive proofにならない",
    !isConclusiveNumericFalsePositive(ambiguousUnits) && !isConclusiveNumericFalsePositive(untyped));

  const compatibleMasker = {
    compareSymbolUnitFamilies() { return { status: "unknown" }; },
    areSymbolsCompatible(a, b) { return a === b; },
  };
  t("同一placeholderはunit不明・maskerなしでもhard drop",
    partitionNumericFalsePositives([same]).dropped.length === 1);
  t("同一placeholderはunit不明・maskerありでもhard drop",
    partitionNumericFalsePositives([same], { masker: compatibleMasker }).dropped.length === 1);
  t("同一placeholderの符号違いはmaskerありでも保持",
    partitionNumericFalsePositives([signMismatch], { masker: compatibleMasker }).kept.length === 1);
}

// ユーザー実測の誤検出回帰。短い引用では単位見出しが落ちるため、
// 数値の符号・小数桁・金融行ラベルを使った決定的な正規化で除外する。
{
  const supplied = [
    {
      name: "括弧負数と△、億/十億の同量",
      finding: {
        category: "number_mismatch",
        quote: "Net sales 5,018.9 4,918.2 (100.7) (2.0)%",
        referenceQuote: "売上高 50,189 49,182 △1,007 △2.0%",
      },
    },
    {
      name: "予想表の小数表示と整数表示の同量",
      finding: {
        category: "number_mismatch",
        quote: "Net Sales 5,500.0 11.8 % Operating Income 150.0 190.8 % Ordinary Income 140.0 6.2 % Net Income Attributable 90.0 156.5 %",
        referenceQuote: "売上高 55,000 +11.8% 営業利益 1,500 +190.8% 経常利益 1,400 +6.2% 親会社株主に帰属する 900 +156.5%",
      },
    },
    {
      name: "欠落したダッシュを含む同一金額",
      finding: {
        category: "number_mismatch",
        quote: "Loss on valuation of credit assets 33,424",
        referenceQuote: "クレジット資産評価損 － 33,424",
      },
    },
    {
      name: "同一プレースホルダー風の二重記載",
      finding: {
        category: "value_inconsistency",
        quote: "Net income attributable 114,079 114,079 to owners of the parent",
        referenceQuote: "親会社株主に帰属する当期純利益 114,079 114,079",
      },
    },
  ];
  for (const { name, finding } of supplied) {
    const sourceContext = name === "括弧負数と△、億/十億の同量"
      ? {
        targetText: "In billions of yen\nNet sales 5,018.9 4,918.2 (100.7) (2.0)%",
        referenceText: "単位: 億円\n売上高 50,189 49,182 △1,007 △2.0%",
        targetRowText: "Net sales 5,018.9 4,918.2 (100.7) (2.0)%",
        referenceRowText: "売上高 50,189 49,182 △1,007 △2.0%",
        targetQuote: finding.quote,
        referenceQuote: finding.referenceQuote,
        targetRowUnique: true,
        referenceRowUnique: true,
      }
      : name === "予想表の小数表示と整数表示の同量"
        ? {
          targetText: "In billions of yen\nNet Sales 5,500.0 11.8 % Operating Income 150.0 190.8 % Ordinary Income 140.0 6.2 % Net Income Attributable 90.0 156.5 %",
          referenceText: "単位: 億円\n売上高 55,000 +11.8% 営業利益 1,500 +190.8% 経常利益 1,400 +6.2% 親会社株主に帰属する 900 +156.5%",
          targetRowText: "Net Sales 5,500.0 11.8 % Operating Income 150.0 190.8 % Ordinary Income 140.0 6.2 % Net Income Attributable 90.0 156.5 %",
          referenceRowText: "売上高 55,000 +11.8% 営業利益 1,500 +190.8% 経常利益 1,400 +6.2% 親会社株主に帰属する 900 +156.5%",
          targetQuote: finding.quote,
          referenceQuote: finding.referenceQuote,
          targetRowUnique: true,
          referenceRowUnique: true,
        }
        : {};
    t(`ユーザー実測: ${name}`, partitionNumericFalsePositives([finding], sourceContext).dropped.length === 1);
  }
  t("遠い同一行の百万単位キャプションがある実値差は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Millions of yen — Consolidated net sales attributable to owners 12.3",
    referenceQuote: "百万円 — 親会社株主に帰属する連結売上高その他の金額について 123",
  }]).kept.length === 1);
  t("遠い同一行のUSD単位キャプションがある実値差は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "USD amounts for consolidated net sales attributable to owners 12.3",
    referenceQuote: "USD amounts for consolidated net sales attributable to owners 123",
  }]).kept.length === 1);
  t("異なる通貨キャプションの同値表示は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "In billions of yen Consolidated net sales 5,500.0",
    referenceQuote: "In billions of USD Consolidated net sales 5,500.0",
  }]).kept.length === 1);
  t("前行の表単位キャプションがある実値差は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Millions of yen\nConsolidated net sales attributable to owners 12.3",
    referenceQuote: "百万円\n親会社株主に帰属する連結売上高その他の金額について 123",
  }]).kept.length === 1);
  t("同一行の共有単位で複数金額と率を対応付けてdrop", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "In billions of yen Net Sales 5,500.0 11.8% Operating Income 150.0 190.8% Ordinary Income 140.0 6.2% Net Income Attributable 90.0 156.5%",
    referenceQuote: "単位: 億円 売上高 55,000 +11.8% 営業利益 1,500 +190.8% 経常利益 1,400 +6.2% 親会社株主に帰属する 900 +156.5%",
  }]).dropped.length === 1);
  t("前行の共有単位で複数金額と率を対応付けてdrop", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "In billions of yen\nNet Sales 5,500.0 11.8% Operating Income 150.0 190.8% Ordinary Income 140.0 6.2% Net Income Attributable 90.0 156.5%",
    referenceQuote: "単位: 億円\n売上高 55,000 +11.8% 営業利益 1,500 +190.8% 経常利益 1,400 +6.2% 親会社株主に帰属する 900 +156.5%",
  }]).dropped.length === 1);
  t("負号が異なる実値差は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 5,018.9 (100.7)",
    referenceQuote: "売上高 50,189 +1,007",
  }]).kept.length === 1);
  t("同じ桁列でも明示単位が違う実値差は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 48 thousand yen",
    referenceQuote: "Net sales 48 million yen",
  }]).kept.length === 1);
  t("全角の「1株当たり」は列値ではなく、同値の株式数2列をdrop", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Number of common stock used in the calculation of net assets per share 630,349 630,779 (Thousands of shares)",
    referenceQuote: "１株当たり純資産額の算定に用いられた (千株) 630,349 630,779 期末の普通株式の数",
  }]).dropped.length === 1);
  const stockShape = "Number of common stock used in the calculation of net assets per share 630,349 630,779 (Thousands of shares)";
  t("同じ文型で2列目が異なる数値は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: stockShape,
    referenceQuote: "１株当たり純資産額の算定に用いられた (千株) 630,349 630,778 期末の普通株式の数",
  }]).kept.length === 1);
  t("同じ文型で片側だけ負号の数値は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: stockShape,
    referenceQuote: "１株当たり純資産額の算定に用いられた (千株) △630,349 630,779 期末の普通株式の数",
  }]).kept.length === 1);
  t("同じ文型で千株と百万株の単位差は保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: stockShape,
    referenceQuote: "１株当たり純資産額の算定に用いられた (百万株) 630,349 630,779 期末の普通株式の数",
  }]).kept.length === 1);
}

// 添付された実レポート（140120260508520693.pdf / REF）で再現した16件。
// referenceQuote が空の候補も含め、quote・reason・日英同一行を実データの形で
// 検証する。self_check は入力に含めても判定根拠には使わない。
{
  const measured = [
    {
      id: "F0006", category: "value_inconsistency",
      page: 6,
      quote: "Net cash used in investing activities was ¥0.9 billion, mainly reflecting capital expenditure for the purchase of property, plant and equipment and the net change in time deposit.",
      quote_variants: [
        "Net cash used in investing activities was ¥906 billion, mainly reflecting capital expenditure for the purchase of property, plant and equipment and the net change in time deposit.",
        "Net cash used in investing activities was ¥0.9 billion, mainly reflecting capital expenditure for the purchase of property, plant and equipment and the net change in time deposit.",
      ],
      reason: "P.1の「Consolidated Cash Flows」では、March 31, 2026のCash Flows from Investing Activitiesが「(868)」ですが、P.6では同じ連結会計年度の投資活動による使用額が「¥906 billion」と記載されており、実量を示す記号が一致しません。",
    },
    {
      id: "F0008", category: "value_inconsistency",
      quote: "Balance at March 31, 143,459 68,336 40,734 295,208 398 17,349 1,810,029 2025",
      reason: "P.12の2025年3月期連結株主資本等変動計算書では、2025年3月31日のTotal Net Assetsが1,810,029ですが、P.9の連結貸借対照表では同日付のTotal Net Assetsが1,810,029です。",
    },
    {
      id: "F0014", category: "value_inconsistency",
      quote: "Net income attributable 114,079 114,079 to owners of the parent",
      reason: "P.10の連結損益計算書では、FY2025の「Net income attributable to owners of the parent」は114,079だが、P.12の連結株主資本等変動計算書では同じ年度・指標が114,079となっている。",
      self_check: "suspect",
    },
    {
      id: "F0037", category: "number_mismatch",
      quote: "Balance at April 1, 2024 283,957 263,007 875,629 (1,873) 1,420,720 77,407 135",
      referenceQuote: "当期首残高 283,957 263,007 875,629 △1,873 1,420,720 77,407 135",
      reason: "同じ2025年3月期の連結株主資本等変動計算書における期首残高について、資本金から繰延ヘッジ損益までの各プレースホルダーがREFと一致していない。",
    },
    {
      id: "F0038", category: "number_mismatch",
      quote: "Purchase of treasury (2) (2) stock",
      referenceQuote: "自己株式の取得 △2 △2",
      reason: "同じ連結株主資本等変動計算書の自己株式取得について、TARGETの「2.0」および「2」はREFの「2」と一致していない。",
      self_check: "suspect",
    },
    {
      id: "F0007", category: "value_inconsistency",
      quote: "Net income attributable 35,086 35,086 to owners of the parent",
      reason: "P.13の2026年3月期連結株主資本等変動計算書では「Net income attributable to owners of the parent」が35,086ですが、P.1のFY2026連結業績、P.10の2026年3月期連結損益計算書およびP.19の1株当たり情報では同じ項目がいずれも35,086です。",
    },
    {
      id: "F0009", category: "value_inconsistency",
      quote: "Balance at March 31, 143,459 137,450 66,601 407,675 340 19,051 1,924,950 2026",
      reason: "P.13の2026年3月期連結株主資本等変動計算書では、2026年3月31日のTotal Net Assetsが1,924,950ですが、P.9の連結貸借対照表では同日付のTotal Net Assetsが1,924,950です。",
    },
    {
      id: "F0039", category: "number_mismatch",
      quote: "Balance at April 1, 2025 283,957 263,059 951,634 (1,576) 1,497,074 42,375 304",
      referenceQuote: "当期首残高 283,957 263,059 951,634 △1,576 1,497,074 42,375 304",
      reason: "同じ2026年3月期の連結株主資本等変動計算書における期首残高について、資本金から繰延ヘッジ損益までの各プレースホルダーがREFと一致していない。",
    },
    {
      id: "F0017", category: "value_inconsistency",
      quote: "Balance at March 31, 143,459 137,450 66,601 407,675 339.8 19,051 1,924,950 2026",
      reason: "P.9の連結貸借対照表では、March 31, 2026の「Total Net Assets」は1,924,950だが、P.13の連結株主資本等変動計算書では同じ期末の「Total Net Assets」が1,924,950となっている。",
      self_check: "suspect",
    },
    {
      id: "F0018", category: "value_inconsistency",
      quote: "Net cash provided by/(used in) financing activities",
      reason: "P.1の「Consolidated Cash Flows」ではMarch 31, 2026の「Cash Flows from Financing Activities」は104,969であり、P.6本文でもFY2026の同指標は104,969である。一方、P.15のFY2026列の「Net cash provided by/(used in) financing activities」は104,969となっている。",
      self_check: "suspect",
    },
    {
      id: "F0019", category: "value_inconsistency",
      quote: "Cash and cash equivalents at end of the period",
      reason: "P.1の「Consolidated Cash Flows」ではMarch 31, 2026の「Ending Cash & Cash Equivalents」は1,293,162であり、P.6本文でも同日付の残高は1,293,162である。一方、P.15のFY2026列の「Cash and cash equivalents at end of the period」は1,293,162となっている。",
      self_check: "suspect",
    },
    {
      id: "F0012", category: "value_inconsistency",
      quote: "Balance at March 31, 40,959 143,459 184,418 398 1,266,466 2025",
      reason: "P.23の2025年3月期単体株主資本等変動計算書では、2025年3月31日のTotal Net Assetsが1,266,466ですが、P.21の単体貸借対照表では同日付のTotal Net Assetsが1,266,466です。",
    },
    {
      id: "F0020", category: "value_inconsistency",
      quote: "Net income 60,132 60,132",
      reason: "P.22の単体損益計算書では、FY2025の「Net income/(loss)」は60,132だが、P.23の単体株主資本等変動計算書では同じ年度の「Net income」が60,132となっている。",
      self_check: "suspect",
    },
    {
      id: "F0013", category: "value_inconsistency",
      quote: "Balance at March 31, 57,034 143,459 200,493 340 1,144,757 2026",
      reason: "P.24の2026年3月期単体株主資本等変動計算書では、2026年3月31日のTotal Net Assetsが1,144,757ですが、P.21の単体貸借対照表では同日付のTotal Net Assetsが1,144,757です。",
    },
    {
      id: "F0021", category: "value_inconsistency",
      quote: "Net income (103,408) (103,408)",
      reason: "P.22の単体損益計算書では、FY2026の「Net income/(loss)」は(103,408)だが、P.24の単体株主資本等変動計算書では同じ年度の「Net income」が(103,408)となっている。符号はいずれも負だが、実量を示す記号が異なる。",
      self_check: "suspect",
    },
    {
      id: "F0023", category: "value_inconsistency",
      quote: "Balance at March 31, 57,034 143,459 200,493 339.8 1,144,757 2026",
      reason: "P.21の単体貸借対照表では、March 31, 2026の「Total Net Assets」は1,144,757だが、P.24の単体株主資本等変動計算書では同じ期末の「Total Net Assets」が1,144,757となっている。",
      self_check: "suspect",
    },
  ];
  const result = partitionNumericFalsePositives(measured);
  t("添付実測の数値16件はすべてDROP", result.dropped.length === measured.length && result.kept.length === 0);
  for (const finding of measured) {
    t(`添付実測 ${finding.id} はDROP`, result.dropped.includes(finding));
  }

  // 保存済みFY2026実行の実形状: referenceQuoteなしで、quoteの括弧負数と
  // 理由文の「負の」表現が同じNet income/純損失を指す。純損失はnet lossの
  // 明示的な別名であり、generic lossやOperating incomeとの混同は許さない。
  const savedRuntimeNetLoss = {
    category: "value_inconsistency",
    quote: "Net income (103,408) (103,408)",
    reason: "P.24の単体株主資本等変動計算書では、2026年3月期のNet incomeが負の103,408である。一方、P.22の単体損益計算書では、同じ2026年3月期・単体・純損失が負の103,408であり、単位はいずれもMillions of Yenのため不一致。",
    suggestion: "P.22とP.24のFY2026数値のどちらが正しいか確認し、統一する。",
  };
  t("保存済みFY2026のNet income/純損失同量はDROP",
    partitionNumericFalsePositives([savedRuntimeNetLoss]).dropped.length === 1);

  const saved2211Findings = [
    {
      id: "F0009", category: "value_inconsistency",
      quote: "Net income attributable 114,079 114,079 to owners of the parent",
      reason: "P.12の連結純資産変動計算書では2025年3月期のNet income attributable to owners of the parentが114,079ですが、P.10の連結損益計算書では同じFY2025の値が114,079です。",
      suggestion: "P.10とP.12のFY2025親会社株主帰属利益の正しい値を確認してください。",
    },
    {
      id: "F0010", category: "value_inconsistency",
      quote: "Net income attributable 35,086 35,086 to owners of the parent",
      reason: "P.13の連結純資産変動計算書では2026年3月期のNet income attributable to owners of the parentが35,086ですが、P.10の連結損益計算書では同じFY2026の値が35,086です。",
      suggestion: "P.10とP.13のFY2026親会社株主帰属利益の正しい値を確認してください。",
    },
    {
      id: "F0011", category: "value_inconsistency",
      quote: "Net income 60,132 60,132",
      reason: "P.23の非連結純資産変動計算書では2025年3月期のNet incomeが60,132ですが、P.22の非連結損益計算書では同じFY2025のNet income/(loss)が60,132です。",
      suggestion: "P.22とP.23のFY2025非連結純利益の正しい値を確認してください。",
    },
    {
      id: "F0012", category: "value_inconsistency",
      quote: "Net income (103,408) (103,408)",
      reason: "P.24の非連結純資産変動計算書では2026年3月期のNet incomeが負の103,408ですが、P.22の非連結損益計算書では同じFY2026のNet income/(loss)が負の103,408です。符号は同じですがプレースホルダーが異なります。",
      suggestion: "P.22とP.24のFY2026非連結純損失の正しい値を確認してください。",
    },
  ];
  const saved2211Result = partitionNumericFalsePositives(saved2211Findings);
  t("保存済み2211の数値4件はすべてDROP",
    saved2211Result.dropped.length === saved2211Findings.length && saved2211Result.kept.length === 0);
  for (const finding of saved2211Findings) {
    t(`保存済み2211 ${finding.id} はDROP`, saved2211Result.dropped.includes(finding));
  }

  // 保存済みEdge iteration 2251の実形状。理由文は二期間のquoted rowを
  // 含むが、「」直後の選択値だけが比較対象で、もう一方の列値は文脈。
  // 選択・単位・指標・scope・期間が一意に立証できる場合だけDROPする。
  // Keep this live shape in a tracked fixture; CI must not depend on ignored
  // docs/benchmarks/runs/raw exports that exist only in a developer checkout.
  const raw2251 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-2251.json", import.meta.url),
    "utf8",
  ));
  const expected2251Ids = ["F0005", "F0004", "F0007", "F0006"];
  const saved2251SelectedRows = raw2251.findings
    .filter(finding => expected2251Ids.includes(finding.id))
    .sort((left, right) => expected2251Ids.indexOf(left.id) - expected2251Ids.indexOf(right.id));
  t("保存済み2251の正確な4 findingをraw exportから読み込み", saved2251SelectedRows.length === expected2251Ids.length
    && saved2251SelectedRows.every((finding, index) => finding.id === expected2251Ids[index]));
  const saved2251Result = partitionNumericFalsePositives(saved2251SelectedRows);
  t("保存済み2251の選択済みquoted-row数値4件はDROP",
    saved2251Result.dropped.length === saved2251SelectedRows.length && saved2251Result.kept.length === 0);
  for (const finding of saved2251SelectedRows) {
    t(`保存済み2251 ${finding.id} はDROP`, saved2251Result.dropped.includes(finding));
  }
  const raw2251Result = partitionNumericFalsePositives(raw2251.findings);
  const expected2251KeptIds = ["F0002", "F0009", "F0001", "F0010"];
  t("raw 2251 replayは対象4件だけDROP", JSON.stringify(raw2251Result.dropped.map(finding => finding.id))
    === JSON.stringify(expected2251Ids));
  t("raw 2251 replayは genuine nonnumeric finding をKEEP", JSON.stringify(raw2251Result.kept.map(finding => finding.id))
    === JSON.stringify(expected2251KeptIds));
  const selectedRowBase = saved2251SelectedRows[0];
  const selectedRowGuards = [
    ["selectorが別のrow member", selectedRowBase.reason.replace("」の114,079（Millions", "」の35,086（Millions")],
    ["selectorの値差", selectedRowBase.reason.replace("」の114,079（Millions", "」の114,080（Millions")],
    ["selectorの符号差", selectedRowBase.reason.replace("」の114,079（Millions", "」の(114,079)（Millions")],
    ["指標差", selectedRowBase.reason.replace("「Net income attributable to owners of the parent 114,079 35,086」", "「Operating income 114,079 35,086」")],
    ["scope差", selectedRowBase.reason.replace("同じFY2025・連結", "同じFY2025・非連結")],
    ["期間差", selectedRowBase.reason.replace("ではFY2025", "ではFY2024")],
    ["単位差", selectedRowBase.reason.replace("Millions of Yen", "Billions of Yen")],
    ["通貨差", selectedRowBase.reason.replace("Millions of Yen", "Millions of USD")],
    ["selectorなし", selectedRowBase.reason.replace("」の114,079（Millions of Yen）", "」（Millions of Yen）")],
    ["selectorが曖昧", `${selectedRowBase.reason} さらに「Net income attributable to owners of the parent 114,079 35,086」の114,079（Millions of Yen）。`],
    ["quoted row外の矛盾値", `${selectedRowBase.reason} 別の比較値999（Millions of Yen）。`],
  ];
  for (const [label, reason] of selectedRowGuards) {
    t(`保存済み2251選択rowの安全境界（${label}）はKEEP`,
      partitionNumericFalsePositives([{ ...selectedRowBase, reason }]).kept.length === 1);
  }
  t("英語の直後selectorもquoted rowの選択値としてDROP",
    partitionNumericFalsePositives([{
      category: "value_inconsistency",
      quote: "Net income 114,079 114,079",
      reason: "P.12 consolidated FY2025 Net income is 114,079 (Millions of Yen), while P.10 has the same FY2025 consolidated measure in \"Net income 114,079 35,086\" of 114,079 (Millions of Yen).",
    }]).dropped.length === 1);
  t("英語のsingle-quote selectorもquoted rowの選択値としてDROP",
    partitionNumericFalsePositives([{
      category: "value_inconsistency",
      quote: "Net income 114,079 114,079",
      reason: "P.12 consolidated FY2025 Net income is 114,079 (Millions of Yen), while P.10 has the same FY2025 consolidated measure in 'Net income 114,079 35,086' of 114,079 (Millions of Yen).",
    }]).dropped.length === 1);
  t("selected-rowのstale model_reasonは別reasonのselector値差をKEEP",
    partitionNumericFalsePositives([{
      ...selectedRowBase,
      reason: selectedRowBase.reason.replace("」の114,079（Millions", "」の114,080（Millions"),
    }]).kept.length === 1);

  // 保存済みEdge iteration 2311のFY2027 Q1実形状。財務活動の27.5 billion
  // と27,506 millionは、検証済みcounterpart/source bindingがないためKEEPする。
  const raw2311 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-2311.json", import.meta.url),
    "utf8",
  ));
  const saved2311Financing = raw2311.findings.find(finding => finding.id === "F0003");
  const raw2311Result = partitionNumericFalsePositives(raw2311.findings);
  t("raw 2311 replayはF0003/F0008/F0006をKEEP", raw2311Result.dropped.length === 0
    && JSON.stringify(raw2311Result.kept.map(finding => finding.id))
      === JSON.stringify(["F0003", "F0008", "F0006"]));
  const financingReason = saved2311Financing?.reason || "";
  const financingGuards = [
    ["27.6 billion対27,506 millionの丸め差", financingReason.replace("¥27.5 billion", "¥27.6 billion")],
    ["符号差", financingReason.replace("Net cash used in financing activities was", "Net cash provided in financing activities was")],
    ["営業対財務の指標差", financingReason.replaceAll("financing activities", "operating activities")],
    ["期間差", financingReason.replace("FY2027", "FY2026")],
    ["四半期末日差", financingReason.replace("June 30, 2026", "June 30, 2025")],
    ["通貨差", financingReason.replace("Millions of Yen", "Millions of USD")],
    ["quoted reason外の矛盾値", `${financingReason} 別の比較値999（Millions of Yen）。`],
  ];
  for (const [label, reason] of financingGuards) {
    const finding = { ...saved2311Financing, reason, model_reason: reason };
    t(`保存済み2311財務cash-flowの安全境界（${label}）はKEEP`,
      partitionNumericFalsePositives([finding]).kept.length === 1);
  }
  const explicitPlusSuggestion = {
    ...saved2311Financing,
    suggestion: saved2311Financing.suggestion
      .replace("27.5", "+27.5")
      .replace("27,506", "+27,506"),
  };
  t("raw 2311のexplicit + suggestionはsemantic usedに負けずKEEP",
    partitionNumericFalsePositives([explicitPlusSuggestion]).kept.length === 1);
  const fullWidthPlus = (value, field) => field === "suggestion"
    ? String(value || "").replace("27.5", "＋27.5").replace("27,506", "＋27,506")
    : String(value || "").replace("¥27.5", "¥＋27.5").replace("(27,506)", "＋27,506");
  for (const field of ["reason", "model_reason", "suggestion"]) {
    t(`raw 2311のfull-width + ${field}はsemantic usedに負けずKEEP`,
      partitionNumericFalsePositives([{
        ...saved2311Financing,
        [field]: fullWidthPlus(saved2311Financing[field], field),
      }]).kept.length === 1);
  }
  t("raw 2311のunsigned suggestionは検証済みbindingなしでKEEP",
    partitionNumericFalsePositives([{ ...saved2311Financing }]).kept.length === 1);
  t("raw 2311のexplicit matching negative suggestionも検証済みbindingなしでKEEP",
    partitionNumericFalsePositives([{
      ...saved2311Financing,
      suggestion: saved2311Financing.suggestion
        .replace("27.5", "(27.5)")
        .replace("27,506", "(27,506)"),
    }]).kept.length === 1);
  const verified2311Financing = {
    ...saved2311Financing,
    // The raw reason repeats page prose in a shape that is intentionally
    // ambiguous under the strict page-claim contract.  Keep that raw replay
    // above, then use the same known source clauses in a clean two-page
    // canonical field for the positive verified-counterpart regression.
    reason: "P.5では2027年3月期第1四半期の「Net cash used in financing activities was ¥27.5 billion」と記載されている。一方、P.11のFY2027、June 30, 2026の「Net cash provided by/(used in) financing activities」が「(27,506)」である。",
    model_reason: "P.5では2027年3月期第1四半期の「Net cash used in financing activities was ¥27.5 billion」と記載されている。一方、P.11のFY2027、June 30, 2026の「Net cash provided by/(used in) financing activities」が「(27,506)」である。",
    issue_summary: "",
    counterparts: [{
      page: 11,
      quote: "Net cash provided by/(used in) financing activities",
      status: "ok",
    }],
  };
  t("raw 2311 F0003はverified counterpart bindingがあればDROP",
    partitionNumericFalsePositives([verified2311Financing]).dropped.length === 1);
  const clean2311Reason = verified2311Financing.reason;
  const sourceBound2311Context = {
    targetText: "Consolidated Cash Flows (In billion yen)\nNet cash used in financing activities was ¥27.5 billion",
    referenceText: "Quarterly Consolidated Statements of Cash Flows (Millions of Yen)\nConsolidated Net cash provided by/(used in) financing activities (27,506)",
    targetRowText: "Net cash used in financing activities was ¥27.5 billion",
    referenceRowText: "Net cash provided by/(used in) financing activities (27,506)",
    targetQuote: saved2311Financing.quote,
    referenceQuote: "Net cash provided by/(used in) financing activities (27,506)",
    targetRowUnique: true,
    referenceRowUnique: true,
  };
  t("raw 2311 F0003はsource-bound quote/reference contextがあればDROP",
    partitionNumericFalsePositives([{ ...saved2311Financing, reason: clean2311Reason,
      model_reason: clean2311Reason, issue_summary: "", counterparts: [] }], {
      forFinding: () => sourceBound2311Context,
    }).dropped.length === 1);
  const sourceBoundWrongQuote2311 = clean2311Reason
    .replace("Net cash used in financing activities was", "Unrelated source row was");
  t("raw 2311 source-bound unrelated quoted row is KEEP",
    partitionNumericFalsePositives([{ ...saved2311Financing, reason: sourceBoundWrongQuote2311,
      model_reason: sourceBoundWrongQuote2311, issue_summary: "", counterparts: [] }], {
      forFinding: () => sourceBound2311Context,
    }).kept.length === 1);
  t("cash-flowのstale model_reasonは別reasonの丸め値差をKEEP",
    partitionNumericFalsePositives([{
      ...saved2311Financing,
      reason: financingReason.replace("¥27.5 billion", "¥27.6 billion"),
      model_reason: financingReason,
    }]).kept.length === 1);

  const saved2218F0002 = {
    id: "F0002", category: "value_inconsistency",
    quote: "FY2027 Full Year 5,500,000 11.8",
    quote_variants: ["FY2027 Full Year 5,500,000 11.8", "FY2027 Full Year 5,500,000 12"],
    reason: "P.1の「3. Consolidated Financial Forecast (April 1, 2026 through March 31, 2027)」ではNet Salesが5,500,000ですが、P.7の同一期間・連結・通期予想表では「Net Sales 5,500.0 11.8 %」です。単位はP.1がmillions of yen、P.7がbillion yenですが、プレースホルダーは実量基準のため、同じ予想値なら同じ記号になるはずです。",
    suggestion: "P.1とP.7のFY2027通期連結売上高を照合し、正しい値に統一してください。",
  };
  t("保存済み2218 F0002の百万/十億同量と隣接率はDROP",
    partitionNumericFalsePositives([saved2218F0002]).dropped.length === 1);

  const scaledRateGuards = [
    ["丸め差", { ...saved2218F0002, reason: saved2218F0002.reason.replace("5,500.0", "5,500.1") }],
    ["同じ表示桁の百万/十億", { ...saved2218F0002, reason: saved2218F0002.reason.replace("5,500.0", "5,500,000") }],
    ["指標差", { ...saved2218F0002, reason: saved2218F0002.reason.replace("「Net Sales 5,500.0", "「Operating income 5,500.0") }],
    ["scope差", { ...saved2218F0002, reason: saved2218F0002.reason.replace("同一期間・連結・通期予想表", "同一期間・非連結・通期予想表") }],
    ["期間差", { ...saved2218F0002, reason: saved2218F0002.reason.replace("March 31, 2027", "March 31, 2028").replace("同一期間", "異なる期間") }],
    ["符号差", { ...saved2218F0002, reason: saved2218F0002.reason.replace("5,500.0", "△5,500.0") }],
    ["通貨差", { ...saved2218F0002, reason: saved2218F0002.reason.replace("billion yen", "billion USD") }],
    ["隣接率なし", { ...saved2218F0002, reason: saved2218F0002.reason.replace("11.8 %", "") }],
    ["率の値を金額位置へ置換", { ...saved2218F0002, reason: saved2218F0002.reason.replace("5,500.0 11.8 %", "11.8 11.8 %") }],
  ];
  for (const [label, finding] of scaledRateGuards) {
    t(`百万/十億と隣接率の安全境界（${label}）はKEEP`,
      partitionNumericFalsePositives([finding]).kept.length === 1);
  }
  t("scaled amount/rateはstale model_reasonの同値proofがあっても別reasonの値差をKEEP",
    partitionNumericFalsePositives([{
      ...saved2218F0002,
      reason: saved2218F0002.reason.replace("5,500.0", "5,500.1"),
      model_reason: saved2218F0002.reason,
    }]).kept.length === 1);
  t("空のsummary・非数値summaryは有効なscaled proofを拒否しない",
    partitionNumericFalsePositives([{
      ...saved2218F0002,
      issueSummary: "同じ予想値の単位換算を確認する",
      issue_summary: "",
    }]).dropped.length === 1);

  // 保存済みEdge iteration 3の実形状。F0002〜F0005は、跨ぎ先の単位
  // captionをquote/reasonに再掲していないため、桁だけから同量と推測せず
  // KEEPする。prompt側でこの形の報告を禁止し、単位が明示された将来形だけ
  // を換算対象にする。F0012は既存のquote-not-found除外を救済しない。
  const saved2228UnitMissing = [
    {
      id: "F0002", category: "value_inconsistency",
      quote: "Net sales 5,018.9 4,918.2 (100.7) (2.0)%",
      reason: "P.5の連結財務実績表ではFY2026 Full YearのNet salesが4,918.2だが、P.1のConsolidated Financial Resultsでは同じFY2026のNet Salesが4,918,172であり、実量記号が一致しない。",
      model_reason: "P.5の連結財務実績表ではFY2026 Full YearのNet salesが4,918.2だが、P.1のConsolidated Financial Resultsでは同じFY2026のNet Salesが4,918,172であり、実量記号が一致しない。",
      reference_quote: "",
    },
    {
      id: "F0003", category: "value_inconsistency",
      quote: "Operating income 186.1 51.6 (134.5) (72.3)%",
      reason: "P.5の連結財務実績表ではFY2026 Full YearのOperating incomeが51.6だが、P.1のConsolidated Financial Resultsでは同じFY2026のOperating Incomeが51,579であり、実量記号が一致しない。",
      model_reason: "P.5の連結財務実績表ではFY2026 Full YearのOperating incomeが51.6だが、P.1のConsolidated Financial Resultsでは同じFY2026のOperating Incomeが51,579であり、実量記号が一致しない。",
      reference_quote: "",
    },
    {
      id: "F0004", category: "value_inconsistency",
      quote: "Ordinary income 189.0 131.8 (57.2) (30.2)%",
      reason: "P.5の連結財務実績表ではFY2026 Full YearのOrdinary incomeが131.8だが、P.1のConsolidated Financial Resultsでは同じFY2026のOrdinary Incomeが131,835であり、実量記号が一致しない。",
      model_reason: "P.5の連結財務実績表ではFY2026 Full YearのOrdinary incomeが131.8だが、P.1のConsolidated Financial Resultsでは同じFY2026のOrdinary Incomeが131,835であり、実量記号が一致しない。",
      reference_quote: "",
    },
    {
      id: "F0005", category: "value_inconsistency",
      quote: "Net income attributable 114.1 35.1 (79.0) (69.2)% to owners of the parent",
      reason: "P.5の連結財務実績表ではFY2026 Full YearのNet income attributable to owners of the parentが35.1だが、P.1のConsolidated Financial Resultsでは同じFY2026の値が35,086であり、実量記号が一致しない。",
      model_reason: "P.5の連結財務実績表ではFY2026 Full YearのNet income attributable to owners of the parentが35.1だが、P.1のConsolidated Financial Resultsでは同じFY2026の値が35,086であり、実量記号が一致しない。",
      reference_quote: "",
    },
  ];
  const saved2228F0012 = {
    id: "F0012", category: "value_inconsistency",
    quote: "Consolidated Financial Forecast (April 1, 2026 through March 31, 2027) (In billion yen) Full Year vs. Prior Year Net Sales 5,500.0 11.8 % Operating Income 150.0 190.8 % Ordinary Income 140.0 6.2 % Net Income Attributable 90.0 156.5 % to Owners of the parent",
    reason: "いずれも2026年4月1日から2027年3月31日までの連結通期予想である。P.1ではNet Salesが5,500,000、Operating Incomeが150,000、Ordinary Incomeが140,000、その増減率が6.2、Net Income Attributable to Owners of the Parentが90,000であり、P.7の5,500.0、150.0、140.0、6.2、90.0と一致しない。",
    excluded_reason: "quote-not-found",
    reference_quote: "",
  };
  const saved2228MissingResult = partitionNumericFalsePositives([...saved2228UnitMissing, saved2228F0012]);
  for (const finding of saved2228UnitMissing) {
    t(`保存済み2228 ${finding.id}はunit caption欠落のため桁推測でDROPしない`,
      saved2228MissingResult.kept.includes(finding));
  }
  t("保存済み2228 F0012のquote-not-found除外を救済しない",
    saved2228MissingResult.kept.includes(saved2228F0012)
      && saved2228F0012.excluded_reason === "quote-not-found");

  const saved2228VectorBase = {
    id: "F0013", category: "value_inconsistency",
    quote: "Net income attributable to owners of the parent 114,079 35,086",
    reason: "P.10の連結損益計算書ではFY2025が114,079、FY2026が35,086である。一方、同じ指標についてP.12の2025年3月期連結純資産変動表は114,079、P.13の2026年3月期連結純資産変動表は35,086としており、両年度とも一致しない。各表の単位はMillions of YenまたはMil.yenで互換性がある。",
    model_reason: "P.10の連結損益計算書ではFY2025が114,079、FY2026が35,086である。一方、同じ指標についてP.12の2025年3月期連結純資産変動表は114,079、P.13の2026年3月期連結純資産変動表は35,086としており、両年度とも一致しない。各表の単位はMillions of YenまたはMil.yenで互換性がある。",
    reference_quote: "",
  };
  const saved2228VectorNegative = {
    id: "F0014", category: "value_inconsistency",
    quote: "Net income/(loss) 60,132 (103,408)",
    reason: "P.22の非連結損益計算書ではFY2025が60,132、FY2026が負の103,408である。一方、同じ指標についてP.23の2025年3月期非連結純資産変動表は60,132、P.24の2026年3月期非連結純資産変動表は負の103,408としており、両年度とも一致しない。各表の単位はMillions of YenまたはMil.yenで互換性がある。",
    model_reason: "P.22の非連結損益計算書ではFY2025が60,132、FY2026が負の103,408である。一方、同じ指標についてP.23の2025年3月期非連結純資産変動表は60,132、P.24の2026年3月期非連結純資産変動表は負の103,408としており、両年度とも一致しない。各表の単位はMillions of YenまたはMil.yenで互換性がある。",
    reference_quote: "",
  };
  t("保存済み2228 F0013の同順二年ベクトルはDROP",
    partitionNumericFalsePositives([saved2228VectorBase]).dropped.length === 1);
  t("保存済み2228 F0014の負数を含む同順二年ベクトルはDROP",
    partitionNumericFalsePositives([saved2228VectorNegative]).dropped.length === 1);
  t("Mil.yenの略記も百万単位の同順ベクトルとしてDROP",
    partitionNumericFalsePositives([{
      ...saved2228VectorBase,
      reason: saved2228VectorBase.reason.replace("Millions of YenまたはMil.yen", "Mil.yenまたはMil.yen"),
      model_reason: saved2228VectorBase.model_reason.replace("Millions of YenまたはMil.yen", "Mil.yenまたはMil.yen"),
    }]).dropped.length === 1);
  const vectorGuards = [
    ["値の順序差", saved2228VectorBase.reason
      .replace("P.12の2025年3月期連結純資産変動表は114,079", "P.12の2025年3月期連結純資産変動表は35,086")
      .replace("P.13の2026年3月期連結純資産変動表は35,086", "P.13の2026年3月期連結純資産変動表は114,079")],
    ["年度の順序差", saved2228VectorBase.reason
      .replace("P.12の2025年3月期", "P.12の2026年3月期")
      .replace("P.13の2026年3月期", "P.13の2025年3月期")],
    ["一値差", saved2228VectorBase.reason.replace("P.13の2026年3月期連結純資産変動表は35,086", "P.13の2026年3月期連結純資産変動表は35,087")],
    ["符号差", saved2228VectorBase.reason.replace("P.13の2026年3月期連結純資産変動表は35,086", "P.13の2026年3月期連結純資産変動表は負の35,086")],
    ["指標差", saved2228VectorBase.reason
      .replace("連結純資産変動表は114,079", "連結営業利益は114,079")
      .replace("連結純資産変動表は35,086", "連結営業利益は35,086")],
    ["scope差", saved2228VectorBase.reason.replace("P.13の2026年3月期連結純資産変動表", "P.13の2026年3月期非連結純資産変動表")],
    ["unit差", saved2228VectorBase.reason.replace("Millions of YenまたはMil.yen", "Millions of YenまたはBillions of Yen")],
    ["通貨差", saved2228VectorBase.reason.replace("Millions of YenまたはMil.yen", "Millions of YenまたはMillions of USD")],
  ];
  for (const [label, reason] of vectorGuards) {
    const finding = { ...saved2228VectorBase, reason, model_reason: reason };
    t(`保存済み2228二年ベクトルの安全境界（${label}）はKEEP`,
      partitionNumericFalsePositives([finding]).kept.length === 1);
  }
  t("二年ベクトルにcontradictoryな別auxiliaryがあればKEEP",
    partitionNumericFalsePositives([{
      ...saved2228VectorBase,
      reason: vectorGuards[2][1],
      model_reason: saved2228VectorBase.reason,
    }]).kept.length === 1);

  const periodAnaphoraGuard = {
    ...saved2211Findings[0],
    reason: "P.12の連結純資産変動計算書では2025年3月期のNet income attributable to owners of the parentが114,079ですが、P.10の連結損益計算書ではFY2025の値が114,079です。",
  };
  t("同じを伴わないFY2025と2025年3月期はKEEP",
    partitionNumericFalsePositives([periodAnaphoraGuard]).kept.length === 1);

  // 実行時の片側quote形状では、括弧負数と理由文の日本語による明示的な
  // 「負の」表現を同じ符号として扱う。referenceQuote が無くても、両側の
  // FY・scope・単位が同じで、同じ値が2回ずつ現れる自己矛盾はDROPする。
  const semanticNegativeWithoutReference = {
    category: "value_inconsistency",
    quote: "Net income (103,408) (103,408)",
    reason: "P.22の単体損益計算書ではFY2026のNet incomeは負の103,408（単位: million yen）であり、P.24の単体株主資本等変動計算書でも同じFY2026・単位・scopeのNet incomeは負の103,408となっている。",
  };
  t("片側quoteの括弧負数と日本語の「負の」同量はDROP",
    partitionNumericFalsePositives([semanticNegativeWithoutReference]).dropped.length === 1);

  // Semantic wording alone must not erase a real mismatch.  Each guard keeps
  // the same repeated-value shape while changing exactly one identity/sign
  // dimension, so the auxiliary proof remains fail-closed.
  const semanticNegativeGuards = [
    ["正負の符号差", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは負の103,408だが、P.24の単体FY2026 Net incomeは正の103,408である。",
    }],
    ["値の差", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは負の103,408だが、P.24の単体FY2026 Net incomeは負の103,409である。",
    }],
    ["指標の差", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは負の103,408だが、P.24の単体FY2026 Operating incomeは負の103,408である。",
    }],
    ["scopeの差", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは負の103,408だが、P.24の連結FY2026 Net incomeは負の103,408である。",
    }],
    ["期間の差", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは負の103,408だが、P.24の単体FY2025 Net incomeは負の103,408である。",
    }],
    ["通貨の差", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは負の103,408 million yenだが、P.24の単体FY2026 Net incomeは負の103,408 million USDである。",
    }],
    ["遠いsemantic語だけでは符号を変えない", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net incomeは103,408である。別の説明にlossという語はあるが、P.24の単体FY2026 Net incomeも103,408である。",
    }],
    ["decrease byは正の減少額であり符号を変えない", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net income has a decrease by 103,408, and P.24の単体FY2026 Net income has a decrease by 103,408。",
    }],
    ["not negativeは非負の説明", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net income is not negative 103,408であり、P.24の単体FY2026 Net income is not negative 103,408である。",
    }],
    ["non-negativeは非負の説明", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net income is non-negative 103,408であり、P.24の単体FY2026 Net income is non-negative 103,408である。",
    }],
    ["nonnegativeは非負の説明", {
      ...semanticNegativeWithoutReference,
      reason: "P.22の単体FY2026 Net income is nonnegative 103,408であり、P.24の単体FY2026 Net income is nonnegative 103,408である。",
    }],
  ];
  for (const [label, finding] of semanticNegativeGuards) {
    t(`日本語semantic符号の安全境界（${label}）はKEEP`,
      partitionNumericFalsePositives([finding]).kept.length === 1);
  }

  // 明示的な不一致は、同じ桁列でも安全境界を越えて保持する。
  const trueMismatches = [
    { category: "number_mismatch", quote: "Net income 60,132 million yen", referenceQuote: "Operating income 60,132 million yen" },
    { category: "number_mismatch", quote: "Net income 60,132 million yen consolidated actual", referenceQuote: "Net income 60,132 million yen standalone forecast" },
    { category: "number_mismatch", quote: "連結 Net income 60,132 million yen", referenceQuote: "非連結 Net income 60,132 million yen" },
    { category: "number_mismatch", quote: "consolidated Net income 60,132 million yen", referenceQuote: "non-consolidated Net income 60,132 million yen" },
    { category: "number_mismatch", quote: "Net income 60,132 million yen", referenceQuote: "Net income 60,132 billion yen" },
    { category: "number_mismatch", quote: "Net income 60,132 million yen", referenceQuote: "Net income △60,132 million yen" },
    { category: "number_mismatch", quote: "Net cash used in investing activities was ¥0.9 billion", referenceQuote: "投資活動によるキャッシュ・フロー △906 百万円" },
  ];
  const mismatchResult = partitionNumericFalsePositives(trueMismatches);
  t("実測回帰の安全境界（指標・scope・単位・符号）はKEEP", mismatchResult.kept.length === trueMismatches.length && mismatchResult.dropped.length === 0);
  t("full-width dash（－）は明示負号へ正規化しない",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "Net income －60,132 million yen",
      referenceQuote: "Net income △60,132 million yen",
    }]).kept.length === 1);
  const splitScopeMismatches = [
    {
      category: "number_mismatch",
      quote: "連結\nNet income 60,132 103,408 million yen",
      referenceQuote: "非\n連結\nNet income 60,132 103,408 million yen",
    },
    {
      category: "number_mismatch",
      quote: "連結\nNet income 60,132 103,408 million yen",
      referenceQuote: "非連\n結\nNet income 60,132 103,408 million yen",
    },
    {
      category: "number_mismatch",
      quote: "consolidated\nNet income 60,132 103,408 million yen",
      referenceQuote: "non\nconsolidated\nNet income 60,132 103,408 million yen",
    },
  ];
  t("newline分割された連結/非連結scope差はKEEP", partitionNumericFalsePositives(splitScopeMismatches).kept.length === 3);
  t("前の別rowのscopeはcurrent rowへ漏らさない",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "連結\nStatement header\nNet income 60,132 103,408 million yen",
      referenceQuote: "非連結\nStatement header\nNet income 60,132 103,408 million yen",
    }]).dropped.length === 1);
  t("後ろの別rowのscopeはcurrent rowへ漏らさない",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "Net income 60,132 103,408 million yen\n連結",
      referenceQuote: "Net income 60,132 103,408 million yen\n非連結",
    }]).dropped.length === 1);
  t("compact/spaced 非連結は同じstandalone scopeとしてDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "非連結 Net income 60,132 million yen",
      referenceQuote: "非 連結 Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("multiple-spaced 非連結も同じstandalone scopeとしてDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "非  連結 Net income 60,132 million yen",
      referenceQuote: "非\t連  結 Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("連結とspaced 非連結のscope差はKEEP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "連結 Net income 60,132 million yen",
      referenceQuote: "非 連 結 Net income 60,132 million yen",
    }]).kept.length === 1);
  t("consolidatedとunconsolidatedのscope差はKEEP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "consolidated Net income 60,132 million yen",
      referenceQuote: "unconsolidated Net income 60,132 million yen",
    }]).kept.length === 1);
  t("unconsolidatedとstandaloneの同一scopeはDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "unconsolidated Net income 60,132 million yen",
      referenceQuote: "standalone Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("unconsolidatedとnon-consolidatedの同一scopeはDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "unconsolidated Net income 60,132 million yen",
      referenceQuote: "non-consolidated Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("改行分割unconsolidatedもstandaloneと同じscopeとしてDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "un\nconsolidated\nNet income 60,132 million yen",
      referenceQuote: "standalone Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("内部空白分割unconsolidatedもnon-consolidatedと同じscopeとしてDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "un  consolidated Net income 60,132 million yen",
      referenceQuote: "non-consolidated Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("non-改行consolidatedもstandaloneと同じscopeとしてDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "non-\nconsolidated\nNet income 60,132 million yen",
      referenceQuote: "standalone Net income 60,132 million yen",
    }]).dropped.length === 1);
  t("row外のun consolidated proseはscopeを広げない",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "un consolidated wording 60,132 million yen",
      referenceQuote: "standalone wording 60,132 million yen",
    }]).kept.length === 1);
  t("compact/spaced 非連結の同一two-value rowはDROP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "非連結 Net income 60,132 103,408 million yen",
      referenceQuote: "非  連結 Net income 60,132 103,408 million yen",
    }]).dropped.length === 1);
  t("compact/spaced 非連結のtwo-value row値差はKEEP",
    partitionNumericFalsePositives([{
      category: "number_mismatch",
      quote: "非連結 Net income 60,132 103,408 million yen",
      referenceQuote: "非  連結 Net income 60,132 103,409 million yen",
    }]).kept.length === 1);

  const hostileMeasureAlias = {
    category: "number_mismatch",
    quote: "Revenue 60,132 million yen",
    referenceQuote: "Operating income 60,132 million yen",
  };
  const hostilePeriodSwap = {
    category: "number_mismatch",
    quote: "FY2025 Net sales 60,132 million yen; FY2026 Net sales 1,266,466 million yen",
    referenceQuote: "FY2026 Net sales 60,132 million yen; FY2025 Net sales 1,266,466 million yen",
  };
  const hostileFamilySwap = {
    category: "number_mismatch",
    quote: "Revenue 60,132 million yen; vehicles 1,266,466 units",
    referenceQuote: "vehicles 60,132 units; Revenue 1,266,466 million yen",
  };
  const hostilePartialAuxiliary = {
    category: "number_mismatch",
    quote: "Net income 50,000 million yen",
    reason: "Net income 50,000 vs 50,000, but Operating income 60,132 vs 70,000",
  };
  const hostileNoPrimaryPartial = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Net income is 50,000 on P.1 and 50,000 on P.2, but operating income is 60,132 on P.1 and 70,000 on P.2.",
  };
  const hostileNoPrimaryStaleModelReason = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Net income is 50,000 million yen on P.1 and Net income is 50,000 million yen on P.2.",
    model_reason: "Net income is 50,000 million yen on P.1 but Net income is 60,000 million yen on P.2.",
  };
  const hostileOnePrimarySuggestion = {
    category: "number_mismatch",
    quote: "Net income 50,000 million yen",
    reason: "Net income is 50,000 million yen on P.1 and Net income is 50,000 million yen on P.2.",
    suggestion: "Net income is 50,000 million yen on P.1 but Net income is 60,000 million yen on P.2.",
  };
  const hostileNoPrimarySuggestion = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Net income is 50,000 million yen on P.1 and Net income is 50,000 million yen on P.2.",
    suggestion: "Net income is 50,000 million yen on P.1 but Net income is 60,000 million yen on P.2.",
  };
  const hostileAuxiliaryMeasureIdentity = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Net income is 50,000 million yen, but Operating income is 50,000 million yen",
  };
  const hostileAuxiliaryScopeIdentity = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Consolidated Net income 50,000 million yen vs Standalone Net income 50,000 million yen",
  };
  const hostileOneSidedMeasureIdentity = {
    category: "number_mismatch",
    quote: "Net income 50,000 million yen",
    reason: "Net income 50,000 million yen vs Operating income 50,000 million yen",
  };
  const hostileOneSidedScopeIdentity = {
    category: "number_mismatch",
    quote: "Consolidated Net income 50,000 million yen",
    reason: "Consolidated Net income 50,000 million yen vs Standalone Net income 50,000 million yen",
  };
  const hostileUnknownLabelSwap = {
    category: "number_mismatch",
    quote: "Goodwill 60,132 million yen; Inventory 1,266,466 million yen",
    referenceQuote: "Inventory 60,132 million yen; Goodwill 1,266,466 million yen",
  };
  const hostileUnknownLabelMismatchNoPrimary = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Goodwill is 50,000 million yen, but Inventory is 50,000 million yen.",
  };
  const hostileUnknownLabelMismatchOnePrimary = {
    category: "number_mismatch",
    quote: "Goodwill 50,000 million yen",
    reason: "Goodwill is 50,000 million yen, but Inventory is 50,000 million yen.",
  };
  const sameUnknownLabelNoPrimary = {
    category: "value_inconsistency",
    quote: "Consolidated results",
    reason: "Goodwill is 50,000 million yen, and Goodwill is 50,000 million yen.",
  };
  const hostileUnknownLabelAlignedMismatch = {
    category: "number_mismatch",
    quote: "Goodwill 60,132 million yen; Inventory 1,266,466 million yen",
    referenceQuote: "Patent assets 60,132 million yen; Inventory 1,266,466 million yen",
  };
  const hostileSpecificUnknownMulti = {
    category: "number_mismatch",
    quote: "Net sales 60,132 million yen; Net income 1,266,466 million yen",
    referenceQuote: "Inventory 60,132 million yen; Net income 1,266,466 million yen",
  };
  const hostileUnknownSpecificMulti = {
    category: "number_mismatch",
    quote: "Inventory 60,132 million yen; Net income 1,266,466 million yen",
    referenceQuote: "Net sales 60,132 million yen; Net income 1,266,466 million yen",
  };
  const hostileSpecificUnknownOnePrimary = {
    category: "number_mismatch",
    quote: "Inventory 50,000 million yen",
    reason: "Net sales is 50,000 million yen on P.1 and Net sales is 50,000 million yen on P.2.",
  };
  const sameMeasureAlias = {
    category: "number_mismatch",
    quote: "Revenue 50,000 million yen",
    referenceQuote: "Net sales 50,000 million yen",
  };
  const barePrimaryAuxiliary = {
    category: "number_mismatch",
    quote: "50,000 million yen",
    reason: "Net sales is 50,000 million yen on P.1 and Net sales is 50,000 million yen on P.2.",
  };
  const hostileQuarterSwap = {
    category: "number_mismatch",
    quote: "First quarter Net sales 60,132; Second quarter Net sales 1,266,466",
    referenceQuote: "Second quarter Net sales 60,132; First quarter Net sales 1,266,466",
  };
  const hostileYearEndedSwap = {
    category: "number_mismatch",
    quote: "Year ended March 31, 2025 Net sales 60,132 million yen",
    referenceQuote: "Year ended March 31, 2026 Net sales 60,132 million yen",
  };
  const hostileJapaneseYearEndedSwap = {
    category: "number_mismatch",
    quote: "2025年12月期 売上高 60,132 百万円",
    referenceQuote: "2026年12月期 売上高 60,132 百万円",
  };
  const hostileJapaneseJuneSwap = {
    category: "number_mismatch",
    quote: "2025年6月期 売上高 60,132 百万円",
    referenceQuote: "2026年6月期 売上高 60,132 百万円",
  };
  const hostileSixMonthsSwap = {
    category: "number_mismatch",
    quote: "Six months ended June 30, 2025 Net sales 60,132 million yen",
    referenceQuote: "Six months ended June 30, 2026 Net sales 60,132 million yen",
  };
  t("Revenue aliasとOperating incomeの同値はKEEP", partitionNumericFalsePositives([hostileMeasureAlias]).kept.length === 1);
  t("FY列identityの入替えはKEEP", partitionNumericFalsePositives([hostilePeriodSwap]).kept.length === 1);
  t("quarter列identityの入替えはKEEP", partitionNumericFalsePositives([hostileQuarterSwap]).kept.length === 1);
  t("Year ended決算日のidentity差はKEEP", partitionNumericFalsePositives([hostileYearEndedSwap]).kept.length === 1);
  t("日本語12月期のidentity差はKEEP", partitionNumericFalsePositives([hostileJapaneseYearEndedSwap]).kept.length === 1);
  t("日本語6月期のidentity差はKEEP", partitionNumericFalsePositives([hostileJapaneseJuneSwap]).kept.length === 1);
  t("Six months ended決算日のidentity差はKEEP", partitionNumericFalsePositives([hostileSixMonthsSwap]).kept.length === 1);
  t("Revenue/vehiclesのcross-family列入替えはKEEP", partitionNumericFalsePositives([hostileFamilySwap]).kept.length === 1);
  t("片側quoteのauxiliary一部一致＋別比較不一致はKEEP", partitionNumericFalsePositives([hostilePartialAuxiliary]).kept.length === 1);
  t("no-primaryのauxiliary一部一致＋別比較不一致はKEEP", partitionNumericFalsePositives([hostileNoPrimaryPartial]).kept.length === 1);
  t("no-primaryのstale model_reasonの値差はKEEP", partitionNumericFalsePositives([hostileNoPrimaryStaleModelReason]).kept.length === 1);
  t("one-primaryのcontradictory suggestionはKEEP", partitionNumericFalsePositives([hostileOnePrimarySuggestion]).kept.length === 1);
  t("no-primaryのcontradictory suggestionはKEEP", partitionNumericFalsePositives([hostileNoPrimarySuggestion]).kept.length === 1);
  t("no-primaryのmeasure identity差はKEEP", partitionNumericFalsePositives([hostileAuxiliaryMeasureIdentity]).kept.length === 1);
  t("no-primaryのscope identity差はKEEP", partitionNumericFalsePositives([hostileAuxiliaryScopeIdentity]).kept.length === 1);
  t("片側quoteのmeasure identity差はKEEP", partitionNumericFalsePositives([hostileOneSidedMeasureIdentity]).kept.length === 1);
  t("片側quoteのscope identity差はKEEP", partitionNumericFalsePositives([hostileOneSidedScopeIdentity]).kept.length === 1);
  t("unknown explicit labelのmulti-column入替えはKEEP", partitionNumericFalsePositives([hostileUnknownLabelSwap]).kept.length === 1);
  t("no-primaryのunknownラベル差はKEEP", partitionNumericFalsePositives([hostileUnknownLabelMismatchNoPrimary]).kept.length === 1);
  t("片側quoteのunknownラベル差はKEEP", partitionNumericFalsePositives([hostileUnknownLabelMismatchOnePrimary]).kept.length === 1);
  t("同一unknownラベルの反復同値はDROP", partitionNumericFalsePositives([sameUnknownLabelNoPrimary]).dropped.length === 1);
  t("multi-columnのunknownラベル対応差はKEEP", partitionNumericFalsePositives([hostileUnknownLabelAlignedMismatch]).kept.length === 1);
  t("multi-columnのspecific/unknown片側差はKEEP", partitionNumericFalsePositives([hostileSpecificUnknownMulti]).kept.length === 1);
  t("multi-columnのunknown/specific片側差もKEEP", partitionNumericFalsePositives([hostileUnknownSpecificMulti]).kept.length === 1);
  t("片側quoteのspecific/unknown差はKEEP", partitionNumericFalsePositives([hostileSpecificUnknownOnePrimary]).kept.length === 1);
  t("同一measureKey aliasのraw label差はDROP", partitionNumericFalsePositives([sameMeasureAlias]).dropped.length === 1);
  t("真にラベルなしprimaryのspecific auxiliary一致はDROP", partitionNumericFalsePositives([barePrimaryAuxiliary]).dropped.length === 1);
  t("EBITDAとNet incomeの同値はKEEP", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "EBITDA 60,132 million yen",
    referenceQuote: "Net income 60,132 million yen",
  }]).kept.length === 1);
  t("Net assetsとTotal assetsの同値はKEEP", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net assets 60,132 million yen",
    referenceQuote: "Total assets 60,132 million yen",
  }]).kept.length === 1);
  t("Operating/Investing cash flowの同値はKEEP", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Operating cash flow 60,132 million yen",
    referenceQuote: "Investing cash flow 60,132 million yen",
  }]).kept.length === 1);
  const vocabularyTraps = [
    ["Gross profit/Operating profit", "Gross profit 60,132 million yen", "Operating profit 60,132 million yen"],
    ["Current/Non-current assets", "Current assets 60,132 million yen", "Non-current assets 60,132 million yen"],
    ["Retained earnings/Shareholders equity", "Retained earnings 60,132 million yen", "Shareholders' equity 60,132 million yen"],
    ["Cost of sales/SG&A", "Cost of sales 60,132 million yen", "SG&A expenses 60,132 million yen"],
    ["EPS/Dividend per share", "Earnings per share 60,132 yen", "Dividend per share 60,132 yen"],
  ];
  for (const [label, quote, referenceQuote] of vocabularyTraps) {
    t(`${label}の同値はKEEP`, partitionNumericFalsePositives([{ category: "number_mismatch", quote, referenceQuote }]).kept.length === 1);
  }
  t("cash-flowのquote_variantsにない別額はKEEP", partitionNumericFalsePositives([{
    category: "value_inconsistency",
    quote: "Net cash used in investing activities was ¥0.9 billion",
    reason: "P.1 cash flows from investing activities were (868), but P.6 says ¥906 billion.",
  }]).kept.length === 1);
  t("stale variantでも他ページの同額はKEEP", partitionNumericFalsePositives([{
    category: "value_inconsistency",
    page: 6,
    quote: "Net cash used in investing activities was ¥0.9 billion",
    quote_variants: [
      "Net cash used in investing activities was ¥906 billion",
      "Net cash used in investing activities was ¥0.9 billion",
    ],
    reason: "P.1 says ¥906 billion, but P.6 says ¥0.9 billion.",
  }]).kept.length === 1);
}

// Q4 の独立サンプル3本で実際に出た「同じ数値を不一致とする」候補。
// 判定は reason の幻覚値ではなく、TARGET quote / REF referenceQuote の
// 数値列と符号を使う。issueScope は翻訳整合であることの境界として使う。
{
  const realQ4PageText = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0840-page-text.json", import.meta.url),
    "utf8",
  ));
  const realTargetP1 = realQ4PageText.pages.target["1"];
  const realReferenceP1 = realQ4PageText.pages.reference["1"];
  const realTargetP11 = realQ4PageText.pages.target["11"];
  const realReferenceP10 = realQ4PageText.pages.reference["10"];
  const realTargetP23 = realQ4PageText.pages.target["23"];
  const realReferenceP22 = realQ4PageText.pages.reference["22"];
  const realTargetP24 = realQ4PageText.pages.target["24"];
  const realReferenceP23 = realQ4PageText.pages.reference["23"];
  const q4Finding = (quote, referenceQuote, extra = {}) => ({
    category: "number_mismatch",
    issueScope: "translation_consistency",
    issueSummary: "同じ指標・期間・表の同じ項目です",
    quote, referenceQuote,
    reason: "同じ値を不一致としています。モデルが補足した 630,626,146 / 90,000 は判定に使わない。",
    ...extra,
  });
  const sameValueRows = [
    q4Finding("Provision for loss on production termination 1,020", "生産終了損失引当金 － 1,020"),
    q4Finding("Reserve for loss on business of subsidiaries and affiliates 8,649", "関係会社事業損失引当金 8,649 －"),
    q4Finding("Gain on sales of investment securities 235", "投資有価証券売却益 － 235"),
    q4Finding("Reversal of provision for environmental measures 60", "環境対策引当金戻入益 － 60"),
    q4Finding("Loss on valuation of investments in capital of subsidiaries and affiliates 3,531", "関係会社出資金評価損 － 3,531"),
    q4Finding("Provision for loss on production termination 24,294", "生産終了損失引当金繰入額 24,294 －"),
    q4Finding("Average number of shares outstanding during the period (Thousands of 630,263 630,626 shares)", "普通株式の期中平均株式数 (千株) 630,263 630,626"),
    q4Finding("FY2025 94,339 millions of yen ( (71.6) %)", "2025年３月期 94,339百万円( △71.6％)"),
  ];
  const sameRowsContext = {
    forFinding: finding => finding.quote.startsWith("FY2025 94,339") ? {
      ...(() => {
        const targetMatch = findUniqueNumericSourceContext(realTargetP1, finding.quote);
        const referenceMatch = findUniqueNumericSourceContext(realReferenceP1, finding.referenceQuote);
        return {
          targetText: targetMatch?.text || "",
          referenceText: referenceMatch?.text || "",
          targetRowText: targetMatch?.rowText || "",
          referenceRowText: referenceMatch?.rowText || "",
          targetRowUnique: Boolean(targetMatch?.unique),
          referenceRowUnique: Boolean(referenceMatch?.unique),
        };
      })(),
    } : {},
  };
  const sameRowsResult = partitionNumericFalsePositives(sameValueRows, sameRowsContext);
  t("Q4の同値列8件はreasonの余計な数字に関係なくDROP", sameRowsResult.kept.length === 0 && sameRowsResult.dropped.length === 8);

  const rawQ4 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-proofread-f0023.json", import.meta.url),
    "utf8",
  ));
  const rawF0023 = (rawQ4.findings || []).find(finding => finding.id === "F0023");
  const rawF0023Result = rawF0023 ? partitionNumericFalsePositives([rawF0023]) : { kept: [null], dropped: [] };
  t("実export F0023のsnake_case・summary・幻覚reason形状もDROP", Boolean(rawF0023)
    && rawF0023Result.kept.length === 0 && rawF0023Result.dropped.length === 1);

  // The two remaining Q4 x2 false positives are kept as tracked fixtures so
  // this regression does not depend on ignored benchmark output.  Their
  // model-authored explanations contain extra numbers, but only the source
  // quote/reference row binding may authorize a drop.
  const rawF0029 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-proofread-f0029.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0017 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-proofread-f0017.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0024 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-proofread-f0024.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0002 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0840-f0002.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0024Page11 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0840-f0024.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0040 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0840-f0040.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0041 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0840-f0041.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0009 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0832-f0009.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  t("F0024/F0029/F0017の実export fixtureをtracked入力から読む",
    rawF0024?.id === "F0024" && rawF0029?.id === "F0029" && rawF0017?.id === "F0017"
      && rawF0024?.reason?.includes("TARGETは71.6、REFは71.6")
      && rawF0029?.quote === "FY2025 94,339 millions of yen ( (71.6) %)"
      && rawF0017?.reference_quote?.includes("630,349 630,779"));
  t("実export F0009のF0024同一quote fixtureをtracked入力から読む",
    rawF0009?.id === "F0009"
      && rawF0009?.quote === rawF0024?.quote
      && rawF0009?.reference_quote === rawF0024?.reference_quote
      && rawF0009?.category === rawF0024?.category
      && rawF0009?.page === rawF0024?.page);
  t("0840 F0002/F0024/F0040/F0041のexact fixtureと実page textを読む",
    rawF0002?.id === "F0002" && rawF0024Page11?.id === "F0024"
      && rawF0040?.id === "F0040" && rawF0041?.id === "F0041"
      && realTargetP1.includes(rawF0002?.quote || "")
      && realReferenceP1.includes(rawF0002?.reference_quote || "")
      && realTargetP11.includes(rawF0024Page11?.quote || "")
      && realReferenceP10.includes(rawF0024Page11?.reference_quote || "")
      && realTargetP23.includes(rawF0040?.quote || "")
      && realReferenceP22.includes(rawF0040?.reference_quote || "")
      && realTargetP24.includes(rawF0041?.quote || "")
      && realReferenceP23.includes(rawF0041?.reference_quote || ""));

  const sourceContextFor = (finding, targetSource, referenceSource) => {
    const targetMatch = findUniqueNumericSourceContext(targetSource, finding.quote);
    const referenceMatch = findUniqueNumericSourceContext(
      referenceSource,
      finding.referenceQuote || finding.reference_quote,
    );
    return {
      targetText: targetMatch?.text || "",
      referenceText: referenceMatch?.text || "",
      targetRowText: targetMatch?.rowText || "",
      referenceRowText: referenceMatch?.rowText || "",
      targetQuote: finding.quote,
      referenceQuote: finding.referenceQuote || finding.reference_quote,
      targetRowUnique: Boolean(targetMatch?.unique),
      referenceRowUnique: Boolean(referenceMatch?.unique),
    };
  };
  const f0029TargetSource = realTargetP1;
  const f0029ReferenceSource = realReferenceP1;
  const f0029SourceContext = sourceContextFor(rawF0029, f0029TargetSource, f0029ReferenceSource);
  const f0029Result = partitionNumericFalsePositives([rawF0029], { forFinding: () => f0029SourceContext });
  t("実export F0029の包括利益行はunique source scaleでDROP",
    f0029SourceContext.targetRowUnique && f0029SourceContext.referenceRowUnique
      && f0029Result.kept.length === 0 && f0029Result.dropped.length === 1);
  for (const [name, wrapper] of [
    ["ASCII", "(△71.6％)"],
    ["full-width", "（△71.6％）"],
  ]) {
    for (const field of ["reason", "model_reason"]) {
      const rateWrapperFinding = { ...rawF0029, [field]: wrapper };
      const rateWrapperResult = partitionNumericFalsePositives(
        [rateWrapperFinding],
        { forFinding: () => f0029SourceContext },
      );
      t("established " + name + " rate wrapper in " + field + " preserves hard-drop",
        rateWrapperResult.kept.length === 0 && rateWrapperResult.dropped.length === 1);
    }
  }

  const f0029ReasonChanged = {
    ...rawF0029,
    reason: "同じ指標・同じ行・同じ期間なので一致しています。幻覚補足値 94,339,999。",
    model_reason: "TARGETとREFの対応値は一致する。モデル補足値 123,456。",
    issue_summary: "同じ包括利益行の値です。",
  };
  const f0029ReasonResult = partitionNumericFalsePositives(
    [f0029ReasonChanged],
    { forFinding: () => f0029SourceContext },
  );
  t("F0029のreason/model_reason/summary変更はDROP判定を変えない",
    f0029ReasonResult.kept.length === 0 && f0029ReasonResult.dropped.length === 1);

  const f0024TargetSource = realTargetP1;
  const f0024ReferenceSource = realReferenceP1;
  const f0024SourceContext = sourceContextFor(rawF0024, f0024TargetSource, f0024ReferenceSource);
  const f0024Result = partitionNumericFalsePositives([rawF0024], { forFinding: () => f0024SourceContext });
  t("実export F0024の括弧負数/△と94,339はunique source rowでDROP",
    f0024SourceContext.targetRowUnique && f0024SourceContext.referenceRowUnique
      && f0024Result.kept.length === 0 && f0024Result.dropped.length === 1);
  t("F0024はsource contextなしでは推測DROPしない",
    partitionNumericFalsePositives([rawF0024]).kept.length === 1);
  const f0009Result = partitionNumericFalsePositives(
    [rawF0009],
    { forFinding: () => f0024SourceContext },
  );
  t("実export F0009は同一の権威quote/source rowでDROP",
    f0009Result.kept.length === 0 && f0009Result.dropped.length === 1);
  const maskedF0009 = {
    ...rawF0009,
    quote: rawF0009.quote.replace("94,339", "⟦#ABC⟧"),
    reference_quote: rawF0009.reference_quote.replace("94,339", "⟦#DEF⟧"),
  };
  const maskedF0009Context = sourceContextFor(maskedF0009, realTargetP1, realReferenceP1);
  const restoredF0009Context = sourceContextFor(rawF0009, realTargetP1, realReferenceP1);
  const restoredF0009Result = partitionNumericFalsePositives(
    [rawF0009],
    { forFinding: () => restoredF0009Context },
  );
  t("F0009はraw masked contextなしから復元後source contextでDROP",
    !maskedF0009Context.targetRowUnique && !maskedF0009Context.referenceRowUnique
      && restoredF0009Context.targetRowUnique && restoredF0009Context.referenceRowUnique
      && restoredF0009Result.kept.length === 0 && restoredF0009Result.dropped.length === 1);
  const f0009MetadataVariants = [
    { id: "F0009_CHANGED", no: 999 },
    { confidence: 0.01, reading_confidence: 0.01 },
    { issue_summary: "別のsummary wording。", display_summary: "別のdisplay wording。", model_summary: "別のmodel wording。" },
    { reason: "別のreason wording。", model_reason: "別のmodel_reason wording。", suggestion: "別のsuggestion wording。" },
    {
      reason: "期間が異なる、単位が異なる、scope mismatch、measure mismatchとモデルが説明する。",
      model_reason: "同じquoteを別の説明で再掲する。",
      suggestion: "比較資料と異なるとモデルが説明する。",
    },
  ];
  t("F0009のID/no/timestamp/confidence/summary/reason/suggestion揺れはDROP不変",
    f0009MetadataVariants.every(changes => {
      const candidate = { ...rawF0009, ...changes };
      return partitionNumericFalsePositives([candidate], { forFinding: () => f0024SourceContext }).dropped.length === 1;
    }));
  const f0024ReasonChanged = {
    ...rawF0024,
    reason: "同じ行の同じ値です。モデル補足値 999,999。",
    model_reason: "括弧と△は同じ負数表記です。補足値 123,456。",
    issue_summary: "同じ包括利益行です。",
  };
  const f0024ReasonResult = partitionNumericFalsePositives(
    [f0024ReasonChanged],
    { forFinding: () => f0024SourceContext },
  );
  t("F0024のreason/model_reason/summaryは判定根拠にならない",
    f0024ReasonResult.kept.length === 0 && f0024ReasonResult.dropped.length === 1);
  const f0024Negative = (quote, referenceQuote, targetSource, referenceSource) => {
    const finding = { ...rawF0024, quote, reference_quote: referenceQuote };
    const context = sourceContextFor(finding, targetSource, referenceSource);
    return partitionNumericFalsePositives([finding], { forFinding: () => context });
  };
  t("F0024の率の符号差はKEEP", f0024Negative(
    "FY2025 94,339 millions of yen ( 71.6 %)",
    rawF0024.reference_quote,
    "Unit: millions of yen\nComprehensive income FY2025 94,339 71.6 %",
    f0024ReferenceSource,
  ).kept.length === 1);
  t("F0024の率の値差はKEEP", f0024Negative(
    rawF0024.quote,
    "2025年３月期 94,339百万円( △71.7％)",
    f0024TargetSource,
    "単位: 百万円\n包括利益 94,339 △71.7％",
  ).kept.length === 1);
  t("F0024の金額の値差はKEEP", f0024Negative(
    rawF0024.quote,
    "2025年３月期 94,340百万円( △71.6％)",
    f0024TargetSource,
    "単位: 百万円\n包括利益 94,340 △71.6％",
  ).kept.length === 1);
  t("F0024の期間差はKEEP", f0024Negative(
    "FY2026 94,339 millions of yen ( (71.6) %)",
    rawF0024.reference_quote,
    "Unit: millions of yen\nComprehensive income FY2026 94,339 (71.6) %",
    f0024ReferenceSource,
  ).kept.length === 1);
  t("F0024の単位差はKEEP", f0024Negative(
    "FY2025 94,339 yen ( (71.6) %)",
    rawF0024.reference_quote,
    "Unit: yen\nComprehensive income FY2025 94,339 (71.6) %",
    f0024ReferenceSource,
  ).kept.length === 1);
  t("F0024の指標差はKEEP", f0024Negative(
    rawF0024.quote,
    rawF0024.reference_quote,
    "Unit: millions of yen\nOperating income FY2025 94,339 (71.6) %",
    f0024ReferenceSource,
  ).kept.length === 1);
  const f0024AmbiguousSource = {
    forFinding: () => ({
      targetText: "Unit: millions of yen\nComprehensive income FY2025 94,339 (71.6) %\nOperating income FY2025 94,339 (71.6) %",
      referenceText: f0024ReferenceSource,
      targetRowUnique: false,
      referenceRowUnique: true,
    }),
  };
  t("F0024の曖昧source rowはKEEP", partitionNumericFalsePositives([rawF0024], f0024AmbiguousSource).kept.length === 1);
  const f0024SeparateRow = f0024Negative(
    rawF0024.quote,
    "2025年３月期 営業利益 94,339百万円( △71.6％)",
    f0024TargetSource,
    "単位: 百万円\n営業利益 94,339 △71.6％",
  );
  t("F0024の別行（営業利益）はKEEP", f0024SeparateRow.kept.length === 1);

  const f0002SourceContext = sourceContextFor(rawF0002, realTargetP1, realReferenceP1);
  const f0002Result = partitionNumericFalsePositives([rawF0002], { forFinding: () => f0002SourceContext });
  t("実export F0002は実PDF.js page textの包括利益行でDROP",
    f0002SourceContext.targetRowUnique && f0002SourceContext.referenceRowUnique
      && f0002Result.kept.length === 0 && f0002Result.dropped.length === 1);
  const f0024Page11Context = sourceContextFor(rawF0024Page11, realTargetP11, realReferenceP10);
  const f0024Page11Result = partitionNumericFalsePositives(
    [rawF0024Page11],
    { forFinding: () => f0024Page11Context },
  );
  t("実export F0024 page11の(24)/△24－は実PDF.js source rowでDROP",
    f0024Page11Context.targetRowUnique && f0024Page11Context.referenceRowUnique
      && f0024Page11Result.kept.length === 0 && f0024Page11Result.dropped.length === 1);
  const f0024Page11MissingTargetPeriodContext = {
    ...f0024Page11Context,
    // The selected source row is still unique and source-bound, but the
    // surrounding TARGET window no longer exposes a period header.  Missing
    // one-sided period evidence is incomplete, not an explicit contradiction.
    targetText: f0024Page11Context.targetText.replace(/\b(?:FY\s*\d{4}|March 31,?\s*\d{4})\b/giu, ""),
  };
  t("F0024 page11の片側期間欠落は明示不一致にせずDROP",
    partitionNumericFalsePositives([rawF0024Page11], {
      forFinding: () => f0024Page11MissingTargetPeriodContext,
    }).dropped.length === 1);
  const f0024Page11DisjointPeriodContext = {
    ...f0024Page11Context,
    // Both windows have explicit periods, but no common period.  This remains
    // a real source-bound contradiction and must stay KEEP.
    targetText: f0024Page11Context.targetText.replace(/2025/g, "2027").replace(/2026/g, "2028"),
  };
  t("F0024 page11の両側明示期間が不一致ならKEEP",
    partitionNumericFalsePositives([rawF0024Page11], {
      forFinding: () => f0024Page11DisjointPeriodContext,
    }).kept.length === 1);
  const f0024Page11ReasonChanged = {
    ...rawF0024Page11,
    issue_summary: "モデル説明だけを変えた繰延ヘッジ損益候補。",
    reason: "source quoteは同じだが、モデルの説明に補足値 999,999 を追加した。",
    model_reason: "source quoteは同じだが、モデルの説明を変更した。",
    suggestion: "モデル説明は判定根拠にしない。",
  };
  t("F0024 page11のreason/summary/suggestion揺れはDROP不変",
    partitionNumericFalsePositives([f0024Page11ReasonChanged], { forFinding: () => f0024Page11Context }).dropped.length === 1);
  const f0024Page11Negative = (quote, referenceQuote, targetSource = realTargetP11, referenceSource = realReferenceP10) => {
    const candidate = { ...rawF0024Page11, quote, reference_quote: referenceQuote };
    const context = sourceContextFor(candidate, targetSource, referenceSource);
    return partitionNumericFalsePositives([candidate], { forFinding: () => context });
  };
  t("F0024 page11の値差はKEEP", f0024Page11Negative(
    rawF0024Page11.quote,
    rawF0024Page11.reference_quote.replace("△24", "△25"),
    realTargetP11,
    realReferenceP10.replace("繰延ヘッジ損益 △24", "繰延ヘッジ損益 △25"),
  ).kept.length === 1);
  t("F0024 page11の符号差はKEEP", f0024Page11Negative(
    rawF0024Page11.quote.replace("(24)", "24"),
    rawF0024Page11.reference_quote,
    realTargetP11.replace("Deferred gains/(losses) on hedges (24)", "Deferred gains/(losses) on hedges 24"),
    realReferenceP10,
  ).kept.length === 1);
  t("F0024 page11の別行はKEEP", f0024Page11Negative(
    rawF0024Page11.quote.replace("Deferred gains/(losses) on hedges", "Land revaluation"),
    rawF0024Page11.reference_quote.replace("繰延ヘッジ損益", "土地再評価差額金"),
    realTargetP11.replace("Deferred gains/(losses) on hedges (24)", "Land revaluation (24)"),
    realReferenceP10.replace("繰延ヘッジ損益 △24", "土地再評価差額金 △24"),
  ).kept.length === 1);
  const f0040Context = sourceContextFor(rawF0040, realTargetP23, realReferenceP22);
  const f0041Context = sourceContextFor(rawF0041, realTargetP24, realReferenceP23);
  t("実export F0040/F0041は先頭列同値でも実source vector差をKEEP",
    f0040Context.targetRowUnique && f0040Context.referenceRowUnique
      && f0041Context.targetRowUnique && f0041Context.referenceRowUnique
      && partitionNumericFalsePositives([rawF0040], { forFinding: () => f0040Context }).kept.length === 1
      && partitionNumericFalsePositives([rawF0041], { forFinding: () => f0041Context }).kept.length === 1);

  const rawF0022Vector = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0820-f0022.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  const rawF0023Vector = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-q4-0820-f0023.json", import.meta.url),
    "utf8",
  )).findings?.[0];
  t("実export F0022/F0023 ordered-vector fixtureをtracked入力から読む",
    rawF0022Vector?.id === "F0022" && rawF0023Vector?.id === "F0023"
      && rawF0022Vector?.quote.includes("Balance at April 1, 2024")
      && rawF0023Vector?.reference_quote.includes("42,375 304"));

  const vectorSourceFor = (finding, year, targetRow = finding.quote, referenceRow = finding.reference_quote,
    targetUnit = "Millions of yen", referenceUnit = "百万円", referenceYear = year) => sourceContextFor(
    finding,
    `連結株主資本等変動計算書\n${targetUnit}\n${year}年4月1日\n${targetRow}`,
    `連結株主資本等変動計算書\n単位: ${referenceUnit}\n${referenceYear}年4月1日\n${referenceRow}`,
  );
  const f0022VectorContext = vectorSourceFor(rawF0022Vector, 2024);
  const f0023VectorContext = vectorSourceFor(rawF0023Vector, 2025);
  t("実export F0022の括弧負数/△ ordered vectorはunique source rowでDROP",
    f0022VectorContext.targetRowUnique && f0022VectorContext.referenceRowUnique
      && partitionNumericFalsePositives([rawF0022Vector], { forFinding: () => f0022VectorContext }).dropped.length === 1);
  t("実export F0023の括弧負数/△ ordered vectorはunique source rowでDROP",
    f0023VectorContext.targetRowUnique && f0023VectorContext.referenceRowUnique
      && partitionNumericFalsePositives([rawF0023Vector], { forFinding: () => f0023VectorContext }).dropped.length === 1);
  t("F0022/F0023のordered vectorはsource contextなしではKEEP",
    partitionNumericFalsePositives([rawF0022Vector]).kept.length === 1
      && partitionNumericFalsePositives([rawF0023Vector]).kept.length === 1);
  const vectorReasonChanged = {
    ...rawF0022Vector,
    reason: "モデル補足値 2024, 135, 999,999 は判定に使わない。",
    model_reason: "全列が同じ列順であるという説明だけを変更する。",
    issue_summary: "モデル説明を変更した数値候補。",
  };
  t("ordered vector DROPはreason/model_reason/summaryを根拠にしない",
    partitionNumericFalsePositives([vectorReasonChanged], { forFinding: () => f0022VectorContext }).dropped.length === 1);
  const vectorNegative = (finding, quote, referenceQuote, options = {}) => {
    const candidate = { ...finding, quote, reference_quote: referenceQuote };
    const targetYear = options.year ?? 2024;
    const referenceYear = options.referenceYear ?? targetYear;
    const context = vectorSourceFor(
      candidate,
      targetYear,
      options.targetRow || quote,
      options.referenceRow || referenceQuote,
      options.targetUnit || "Millions of yen",
      options.referenceUnit || "百万円",
      referenceYear,
    );
    return partitionNumericFalsePositives([candidate], { forFinding: () => context });
  };
  t("ordered vectorの1列値差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    rawF0022Vector.reference_quote.replace("77,407 135", "77,407 136"),
  ).kept.length === 1);
  t("ordered vectorの符号差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote.replace("(1,873)", "1,873"),
    rawF0022Vector.reference_quote,
  ).kept.length === 1);
  t("ordered vectorの列数差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    rawF0022Vector.reference_quote.replace(" 135", ""),
  ).kept.length === 1);
  t("ordered vectorの列順差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    rawF0022Vector.reference_quote.replace("77,407 135", "135 77,407"),
  ).kept.length === 1);
  t("ordered vectorの期間差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    rawF0022Vector.reference_quote,
    { year: 2024, referenceYear: 2025 },
  ).kept.length === 1);
  t("ordered vectorの単位scale差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    rawF0022Vector.reference_quote,
    { referenceUnit: "十億円" },
  ).kept.length === 1);
  t("ordered vectorの通貨差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    rawF0022Vector.reference_quote,
    { referenceUnit: "million USD" },
  ).kept.length === 1);
  t("ordered vectorの指標差はKEEP", vectorNegative(
    rawF0022Vector,
    rawF0022Vector.quote,
    "利益剰余金 283,957 263,007 875,629 △1,873 1,420,720 77,407 135",
    { referenceRow: "利益剰余金 283,957 263,007 875,629 △1,873 1,420,720 77,407 135" },
  ).kept.length === 1);
  const ambiguousVectorSource = `連結株主資本等変動計算書\nMillions of yen\n2024年4月1日\n${rawF0022Vector.quote}\n${rawF0022Vector.quote}`;
  const ambiguousVectorReference = `連結株主資本等変動計算書\n単位: 百万円\n2024年4月1日\n${rawF0022Vector.reference_quote}`;
  const ambiguousVectorContext = {
    forFinding: () => {
      const targetMatch = findUniqueNumericSourceContext(ambiguousVectorSource, rawF0022Vector.quote);
      const referenceMatch = findUniqueNumericSourceContext(ambiguousVectorReference, rawF0022Vector.reference_quote);
      return {
        targetText: targetMatch?.text || "",
        referenceText: referenceMatch?.text || "",
        targetRowText: targetMatch?.rowText || "",
        referenceRowText: referenceMatch?.rowText || "",
        targetQuote: rawF0022Vector.quote,
        referenceQuote: rawF0022Vector.reference_quote,
        targetRowUnique: Boolean(targetMatch?.unique),
        referenceRowUnique: Boolean(referenceMatch?.unique),
      };
    },
  };
  t("ordered vectorの曖昧source rowはKEEP", partitionNumericFalsePositives([rawF0022Vector], ambiguousVectorContext).kept.length === 1);

  const f0017TargetSource = "Unit: thousands of shares\nNumber of common stock used in the calculation of net assets per share 630,349 630,779";
  const f0017ReferenceSource = "単位: 千株\n１株当たり純資産額の算定に用いられた (千株) 630,349 630,779 期末の普通株式の数";
  const f0017SourceContext = sourceContextFor(rawF0017, f0017TargetSource, f0017ReferenceSource);
  const f0017Result = partitionNumericFalsePositives([rawF0017], { forFinding: () => f0017SourceContext });
  t("実export F0017の純資産算定用株式数はsource scale一致でDROP",
    f0017SourceContext.targetRowUnique && f0017SourceContext.referenceRowUnique
      && f0017Result.kept.length === 0 && f0017Result.dropped.length === 1);

  const f0017ReasonChanged = {
    ...rawF0017,
    reason: "同じ指標・同じ行・同じ期間なので一致しています。幻覚補足値 630,626,146。",
    model_reason: "対応する引用値は一致する。モデル補足値 777,777。",
    issue_summary: "同じ株式数行の値です。",
  };
  const f0017ReasonResult = partitionNumericFalsePositives(
    [f0017ReasonChanged],
    { forFinding: () => f0017SourceContext },
  );
  t("F0017のreason/model_reason/summary変更はDROP判定を変えない",
    f0017ReasonResult.kept.length === 0 && f0017ReasonResult.dropped.length === 1);

  const f0029Negative = (quote, referenceQuote, targetSource, referenceSource) => {
    const finding = { ...rawF0029, quote, reference_quote: referenceQuote };
    const context = sourceContextFor(finding, targetSource, referenceSource);
    return partitionNumericFalsePositives([finding], { forFinding: () => context });
  };
  t("F0029の真の1値差はKEEP", f0029Negative(
    rawF0029.quote,
    "2025年３月期 94,340百万円( △71.6％)",
    f0029TargetSource,
    "単位: 百万円\n包括利益 94,340 △71.6％",
  ).kept.length === 1);
  t("F0029の符号差はKEEP", f0029Negative(
    "FY2025 94,339 millions of yen ( 71.6 %)",
    rawF0029.reference_quote,
    "Unit: millions of yen\nComprehensive income FY2025 94,339 (71.6) %",
    f0029ReferenceSource,
  ).kept.length === 1);
  t("F0029の期間差はKEEP", f0029Negative(
    "FY2026 94,339 millions of yen ( (71.6) %)",
    rawF0029.reference_quote,
    "Unit: millions of yen\nComprehensive income FY2026 94,339 (71.6) %",
    f0029ReferenceSource,
  ).kept.length === 1);
  t("F0029のscope差はKEEP", f0029Negative(
    "Consolidated FY2025 94,339 millions of yen ( (71.6) %)",
    rawF0029.reference_quote,
    "Unit: millions of yen\nConsolidated comprehensive income FY2025 94,339 (71.6) %",
    "単位: 百万円\n単体包括利益 94,339 △71.6％",
  ).kept.length === 1);
  t("F0029の単位差はKEEP", f0029Negative(
    "FY2025 94,339 yen ( (71.6) %)",
    rawF0029.reference_quote,
    "Unit: yen\nComprehensive income FY2025 94,339 (71.6) %",
    f0029ReferenceSource,
  ).kept.length === 1);

  const f0017Negative = (quote, referenceQuote, targetSource, referenceSource) => {
    const finding = { ...rawF0017, quote, reference_quote: referenceQuote };
    const context = sourceContextFor(finding, targetSource, referenceSource);
    return partitionNumericFalsePositives([finding], { forFinding: () => context });
  };
  t("F0017の真の1値差はKEEP", f0017Negative(
    rawF0017.quote,
    "１株当たり純資産額の算定に用いられた (千株) 630,349 630,780 期末の普通株式の数",
    f0017TargetSource,
    "単位: 千株\n１株当たり純資産額の算定に用いられた (千株) 630,349 630,780 期末の普通株式の数",
  ).kept.length === 1);
  t("F0017の符号差はKEEP", f0017Negative(
    "Number of common stock used in the calculation of net assets per share -630,349 630,779",
    rawF0017.reference_quote,
    "Unit: thousands of shares\nNumber of common stock used in the calculation of net assets per share -630,349 630,779",
    f0017ReferenceSource,
  ).kept.length === 1);
  t("F0017の期間差はKEEP", f0017Negative(
    "FY2026 Number of common stock used in the calculation of net assets per share 630,349 630,779",
    "FY2025 １株当たり純資産額の算定に用いられた (千株) 630,349 630,779 期末の普通株式の数",
    "Unit: thousands of shares\nFY2026 Number of common stock used in the calculation of net assets per share 630,349 630,779",
    "単位: 千株\nFY2025 １株当たり純資産額の算定に用いられた (千株) 630,349 630,779 期末の普通株式の数",
  ).kept.length === 1);
  t("F0017のscope差はKEEP", f0017Negative(
    "Consolidated Number of common stock used in the calculation of net assets per share 630,349 630,779",
    "単体 １株当たり純資産額の算定に用いられた (千株) 630,349 630,779 期末の普通株式の数",
    "Unit: thousands of shares\nConsolidated Number of common stock used in the calculation of net assets per share 630,349 630,779",
    "単位: 千株\n単体 １株当たり純資産額の算定に用いられた (千株) 630,349 630,779 期末の普通株式の数",
  ).kept.length === 1);
  t("F0017の単位差はKEEP", f0017Negative(
    "Number of common stock used in the calculation of net assets per share (Millions of shares) 630,349 630,779",
    rawF0017.reference_quote,
    "Unit: thousands of shares\nNumber of common stock used in the calculation of net assets per share (Millions of shares) 630,349 630,779",
    f0017ReferenceSource,
  ).kept.length === 1);
  t("F0017の期末普通株式数という別行はKEEP", f0017Negative(
    rawF0017.quote,
    "期末の普通株式の数 (千株) 630,349 630,779",
    f0017TargetSource,
    "単位: 千株\n期末の普通株式の数 (千株) 630,349 630,779",
  ).kept.length === 1);

  const f0023Boundary = {
    ...rawF0023,
    issue_summary: rawF0023?.issue_summary,
    reason: rawF0023?.reason,
  };
  const unknownLabels = {
    ...f0023Boundary,
    quote: "Unrelated metric 630,263 630,626",
    reference_quote: "別の指標 630,263 630,626",
  };
  const separateRow = {
    ...f0023Boundary,
    quote: "Average number of shares outstanding during the period (Thousands of 630,263 630,626 shares)",
    reference_quote: "普通株式の期末株式数 (千株) 630,263 630,626",
  };
  const oneValueDifferenceRaw = {
    ...f0023Boundary,
    reference_quote: "普通株式の期中平均株式数 (千株) 630,263 630,627",
  };
  const signDifferenceRaw = {
    ...f0023Boundary,
    quote: "Average number of shares outstanding during the period (Thousands of 630,263 (630,626) shares)",
  };
  const periodDifferenceRaw = {
    ...f0023Boundary,
    quote: "FY2025 Average number of shares outstanding during the period (Thousands of 630,263 630,626 shares)",
    reference_quote: "FY2026 普通株式の期中平均株式数 (千株) 630,263 630,626",
  };
  const scopeDifferenceRaw = {
    ...f0023Boundary,
    quote: "Average number of shares outstanding during the period (Thousands, consolidated, 630,263 630,626 shares)",
    reference_quote: "普通株式の期中平均株式数 (千株、単体) 630,263 630,626",
  };
  const unitDifferenceRaw = {
    ...f0023Boundary,
    quote: "Average number of shares outstanding during the period (Millions of 630,263 630,626 shares)",
  };
  t("未知ラベルの同値列はF0023の明示reasonでもKEEP", partitionNumericFalsePositives([unknownLabels]).kept.length === 1);
  t("別行ラベルの同値列はKEEP", partitionNumericFalsePositives([separateRow]).kept.length === 1);
  t("F0023形状の真の1値差はKEEP", partitionNumericFalsePositives([oneValueDifferenceRaw]).kept.length === 1);
  t("F0023形状の符号差はKEEP", partitionNumericFalsePositives([signDifferenceRaw]).kept.length === 1);
  t("F0023形状の期間差はKEEP", partitionNumericFalsePositives([periodDifferenceRaw]).kept.length === 1);
  t("F0023形状のscope差はKEEP", partitionNumericFalsePositives([scopeDifferenceRaw]).kept.length === 1);
  t("F0023形状の単位差はKEEP", partitionNumericFalsePositives([unitDifferenceRaw]).kept.length === 1);

  const union = [
    q4Finding("Provision for loss on production termination 1,020", "生産終了損失引当金 － 1,020", { id: "S1" }),
    q4Finding("Provision for loss on production termination 1,020", "生産終了損失引当金 － 1,020", { id: "S2" }),
    q4Finding("Provision for loss on production termination 1,020", "生産終了損失引当金 － 1,020", { id: "S3" }),
    q4Finding("Net sales 1,020", "売上高 1,021", { id: "real" }),
  ];
  const filteredUnion = partitionNumericFalsePositives(union).kept;
  const mergedUnion = integrateFindings(filteredUnion);
  t("Q4 x3 unionは同値誤検出を全て除外し真の1値差を保持", filteredUnion.length === 1 && filteredUnion[0].id === "real" && mergedUnion.findings_new === 1);

  const negativeSame = q4Finding("FY2025 Net income (71.6)", "2025年３月期 Net income △71.6");
  const negativeDifferent = q4Finding("FY2025 Net income 71.6", "2025年３月期 Net income △71.6");
  t("括弧負数と△は同値としてDROP", partitionNumericFalsePositives([negativeSame]).dropped.length === 1);
  t("同じ数字でも符号差はKEEP", partitionNumericFalsePositives([negativeDifferent]).kept.length === 1);

  const scaled = q4Finding("90.0 156.5 %", "900 +156.5％", {
    reason: "同じ2027年3月期予想の同じ指標ですが、90.0 と 900 が不一致です。",
  });
  t("90.0/900はquote単体では単位不明なのでKEEP", partitionNumericFalsePositives([scaled]).kept.length === 1);
  const scaledContext = {
    forFinding: () => ({
      targetText: "Consolidated Financial Forecast (In billion yen)\nNet Income Attributable 90.0 156.5 %",
      referenceText: "単位: 億円\n親会社株主に帰属する当期純利益 900 +156.5％",
      targetRowText: "Net Income Attributable 90.0 156.5 %",
      referenceRowText: "親会社株主に帰属する当期純利益 900 +156.5％",
      targetRowUnique: true,
      referenceRowUnique: true,
    }),
  };
  t("近接表頭のbillion/億円がある90.0/900だけDROP", partitionNumericFalsePositives([scaled], scaledContext).dropped.length === 1);
  const wrongMeasureContext = {
    forFinding: () => ({
      targetText: "In billion yen\nNet Income Attributable 90.0 156.5 %",
      referenceText: "単位: 億円\nOperating income 900 +156.5％",
      targetRowText: "Net Income Attributable 90.0 156.5 %",
      referenceRowText: "Operating income 900 +156.5％",
      targetQuote: scaled.quote,
      referenceQuote: scaled.referenceQuote,
      targetRowUnique: true,
      referenceRowUnique: true,
    }),
  };
  t("90.0/900のsource row指標差はKEEP", partitionNumericFalsePositives([scaled], wrongMeasureContext).kept.length === 1);
  const boundReasonBase = {
    ...scaled,
    reason: "数値の対応を確認する。",
    issue_summary: "数値差を確認する。",
  };
  const boundReasonChanged = {
    ...boundReasonBase,
    reason: "同じ指標・同じ行・同じ期間なので一致しています。モデル補足値999。",
    issue_summary: "同じ行の同値です。",
  };
  const boundReasonResults = [boundReasonBase, boundReasonChanged]
    .map(finding => partitionNumericFalsePositives([finding], scaledContext).dropped.length === 1);
  t("source-backed DROPはreason/summaryだけで変わらない", boundReasonResults.every(Boolean));

  const sameRowReason = {
    ...q4Finding("Unrelated metric 1,020 8,649", "別の指標 1,020 8,649"),
    reason: "同じ指標・同じ行・同じ期間なので一致しています。",
    issue_summary: "同じ指標の同じ行です。",
  };
  t("別行の同値列はhallucinated same-row reasonでもKEEP", partitionNumericFalsePositives([sameRowReason]).kept.length === 1);
  const reasonInvariantBase = {
    ...q4Finding("Unrelated metric 1,020 8,649", "別の指標 1,020 8,649"),
    issue_summary: "数値が一致しない。",
    reason: "値が違うため確認する。",
  };
  const reasonInvariantChanged = {
    ...reasonInvariantBase,
    issue_summary: "同じ指標・同じ行・同じ期間です。",
    reason: "同じ指標なので問題ない。モデル補足値 999。",
  };
  const reasonInvariantResults = [reasonInvariantBase, reasonInvariantChanged]
    .map(finding => partitionNumericFalsePositives([finding]).kept.length === 1);
  t("reason/summaryだけの変更でKEEP/DROPが変わらない", reasonInvariantResults.every(Boolean));
  const duplicateSource = findUniqueNumericSourceContext(
    "In billion yen\nNet income 90.0 156.5 %\nOperating income 90.0 156.5 %",
    "90.0 156.5 %",
  );
  t("同じnumeric rowが複数あるsource contextは曖昧でnull", duplicateSource === null);
  const ambiguousScaled = {
    ...scaled,
    reason: "同じ指標・同じ行・同じ期間です。",
  };
  const ambiguousScaledContext = {
    forFinding: () => ({
      targetText: "In billion yen\nNet income 90.0 156.5 %\nOperating income 90.0 156.5 %",
      referenceText: "単位: 億円\n親会社株主に帰属する当期純利益 900 +156.5％",
      targetRowUnique: false,
      referenceRowUnique: true,
    }),
  };
  t("ambiguous source rowはsame-row reasonがあっても90/900をDROPしない",
    partitionNumericFalsePositives([ambiguousScaled], ambiguousScaledContext).kept.length === 1);

  const oneValueDifference = q4Finding("Net sales 1,020", "売上高 1,021");
  const unitDifference = q4Finding("Net sales 48 thousand yen", "売上高 48 million yen");
  const periodDifference = q4Finding("FY2025 Net sales 48", "FY2026 売上高 48");
  const scopeDifference = q4Finding("Net income 48 consolidated", "純利益 48 standalone");
  t("値が1つでも違う候補はKEEP", partitionNumericFalsePositives([oneValueDifference]).kept.length === 1);
  t("単位差は既存unit gateでKEEP", partitionNumericFalsePositives([unitDifference]).kept.length === 1);
  t("期間差は既存period gateでKEEP", partitionNumericFalsePositives([periodDifference]).kept.length === 1);
  t("scope差は既存scope gateでKEEP", partitionNumericFalsePositives([scopeDifference]).kept.length === 1);
}

// 復元後の利用者表示が同じでも、指標・scope・単位が違う実不一致は残す。
// 逆に、同じ表の重複列やP.22/P.25の同値比較は hard drop する。
{
  const tableDuplicate = {
    category: "value_inconsistency",
    quote: "Net income 60,132 60,132",
    referenceQuote: "Net income 60,132 60,132",
  };
  const largeTableDuplicate = {
    category: "number_mismatch",
    quote: "Net income 1,266,466 1,266,466",
    referenceQuote: "Net income 1,266,466 1,266,466",
  };
  const pageLabelOnly = {
    category: "value_inconsistency",
    suggestion: "P.22の60,132とP.25の60,132のどちらが正しいか確認する",
  };
  const differentMeasure = {
    category: "number_mismatch",
    quote: "Net sales 60,132 million yen",
    referenceQuote: "Operating income 60,132 million yen",
  };
  const differentScope = {
    category: "number_mismatch",
    quote: "Net income 60,132 million yen consolidated actual",
    referenceQuote: "Net income 60,132 million yen standalone forecast",
  };
  const differentUnit = {
    category: "number_mismatch",
    quote: "Net income 60,132 million yen",
    referenceQuote: "Net income 60,132 billion yen",
  };
  const differentSign = {
    category: "number_mismatch",
    quote: "Net income 60,132 million yen",
    referenceQuote: "Net income △60,132 million yen",
  };
  t("表内Net incomeの連続同値60,132はdrop", partitionNumericFalsePositives([tableDuplicate]).dropped.length === 1);
  t("表内Net incomeの連続同値1,266,466もdrop", partitionNumericFalsePositives([largeTableDuplicate]).dropped.length === 1);
  t("P.22/P.25の復元同値表示はdrop", partitionNumericFalsePositives([pageLabelOnly]).dropped.length === 1);
  t("同じ表示数値でも指標が違う比較は保持", partitionNumericFalsePositives([differentMeasure]).kept.length === 1);
  t("同じ表示数値でもactual/forecast・連結範囲が違う比較は保持", partitionNumericFalsePositives([differentScope]).kept.length === 1);
  t("同じ表示数値でも単位が違う比較は保持", partitionNumericFalsePositives([differentUnit]).kept.length === 1);
  t("同じ表示数値でも符号が違う比較は保持", partitionNumericFalsePositives([differentSign]).kept.length === 1);
  t("複数指標の列入替えは同値桁でも保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Net sales 60,132; Operating income 1,266,466",
    referenceQuote: "Operating income 60,132; Net sales 1,266,466",
  }]).kept.length === 1);
  t("Actual/Forecastの列入替えは同値桁でも保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "Actual 60,132; Forecast 1,266,466",
    referenceQuote: "Forecast 60,132; Actual 1,266,466",
  }]).kept.length === 1);
  t("営業利益と当期純利益はgeneric利益の重複でも保持", partitionNumericFalsePositives([{
    category: "number_mismatch",
    quote: "営業利益 60,132 百万円",
    referenceQuote: "当期純利益 60,132 百万円",
  }]).kept.length === 1);
}

// 2026-08-19 attached result replay.  The primary quote may contain a
// prior-period amount (F0002), and F0003 quotes only the row label while the
// canonical claim names the current end balance.  The page-labelled claim
// must bind the asserted amount before allowing a rounded billion/million
// equivalence; contextual or contradictory counterpart amounts stay visible.
{
  const attached = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-20260819-attached-source.json", import.meta.url),
    "utf8",
  ));
  const attachedFindings = attached.findings || [];
  const pageMarkerVariants = ["P.5", "P．5", "Ｐ．5", "Page 5"]
    .map(value => parsePageMarkers(value));
  const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  t("production counterpart validation shares bounded import cache across both passes",
    (indexHtml.match(/const sameDocumentSourceCache = \{/g) || []).length === 1
      && (indexHtml.match(/runNumericImportTwoPass\(rawFindings/g) || []).length === 1
      && indexHtml.includes("sourceCache: sameDocumentSourceCache,")
      && indexHtml.includes("validateSameDocumentCounterpartContext(finding, pageTexts, { sourceCache });"));
  t("page marker parser accepts ASCII/fullwidth P and Page forms",
    pageMarkerVariants.every(parsed => parsed.malformed.length === 0
      && parsed.markers.length === 1 && parsed.markers[0].page === 5));
  t("page marker parser rejects malformed P-dash form",
    parsePageMarkers("P-5").markers.length === 0 && parsePageMarkers("P-5").malformed.length === 1);
  const attachedReplay = partitionNumericFalsePositives(attachedFindings);
  t("2026-08-19 attached replay reads only the two numeric findings",
    attachedFindings.length === 2 && attachedFindings.every(finding => ["F0002", "F0003"].includes(finding.id)));
  t("2026-08-19 attached replay drops F0002/F0003", JSON.stringify(attachedReplay.dropped.map(finding => finding.id))
    === JSON.stringify(["F0002", "F0003"]) && attachedReplay.kept.length === 0);

  const attachedF0002 = attachedFindings.find(finding => finding.id === "F0002");
  const attachedF0003 = attachedFindings.find(finding => finding.id === "F0003");
  const targetPages = attached.source_pages || {};
  const coerceShape = (finding, changes = {}) => {
    const coercedShape = {
      ...finding,
      ...changes,
      // coerceFindings emits issueSummary and does not carry model_reason,
      // issue_summary, or trusted counterpart records.
      issueSummary: changes.issueSummary || finding.issueSummary
        || finding.issue_summary || "同一行の数値を照合する。",
      counterparts: [],
      counterParts: [],
    };
    delete coercedShape.model_reason;
    delete coercedShape.issue_summary;
    return coercedShape;
  };
  const prepareReplayCounterparts = async (items, targetTextFor, sourceCache) => {
    const contexts = new Map();
    for (const finding of items) {
      const pages = new Set([Number(finding?.page)]);
      for (const value of [finding?.reason, finding?.model_reason, finding?.issueSummary,
        finding?.issue_summary, finding?.suggestion]) {
        const parsed = parsePageMarkers(value);
        for (const marker of parsed.markers) pages.add(Number(marker.page));
      }
      const pageTexts = new Map();
      for (const page of pages) {
        if (Number.isInteger(page)) pageTexts.set(page, await targetTextFor(page));
      }
      const validated = validateSameDocumentCounterpartContext(finding, pageTexts, { sourceCache });
      finding.counterparts = validated.counterparts;
      delete finding.counterParts;
      if (validated.context && Object.keys(validated.context).length) {
        contexts.set(String(finding?.id || ""), validated.context);
      }
    }
    return contexts;
  };
  const replayOptions = {
    prepareValidatedSameDocumentCounterparts: prepareReplayCounterparts,
    collectNumericFindingContexts: async () => new Map(),
    targetTextFor: async page => String(targetPages[String(page)] || ""),
    referenceTextFor: async () => "",
    referenceSourceFor: null,
    chooseSourceBackedQuoteVariants: async () => {},
  };
  const exactReplay = await runNumericImportTwoPass(
    [attachedF0002, attachedF0003].map(finding => coerceShape(finding)),
    {
      ...replayOptions,
      restoreMaskedFindings: async list => list,
      masker: null,
    },
  );
  t("production-shaped coerce/source validation/partition drops F0002/F0003",
    exactReplay.compatibleNumericDropped.length === 0
      && exactReplay.maskedNumericFilter.dropped.map(finding => finding.id).join(",") === "F0002,F0003"
      && exactReplay.restoredFindings.length === 0
      && exactReplay.restoredNumericFilter.dropped.length === 0);

  // Exercise the same helper with a real Masker-compatible masked quote. The
  // first pass cannot bind the masked quote to source text; the injected
  // restoreMaskedFindings callback returns the exact quote, after which the
  // helper rebuilds counterpart context and drops it on the second pass.
  const replayMasker = new Masker(20260820);
  const maskedQuote = replayMasker.mask(attachedF0002.quote, "en").text;
  let restoreCallCount = 0;
  const maskedReplay = await runNumericImportTwoPass(
    [coerceShape(attachedF0002, { quote: maskedQuote })],
    {
      ...replayOptions,
      masker: replayMasker,
      isMaskerCompatibleNumericFinding: (finding, context) =>
        Boolean(isConclusiveNumericFalsePositive(finding, { masker: replayMasker, ...context })),
      restoreMaskedFindings: async list => {
        restoreCallCount += 1;
        return list.map(finding => ({
          ...finding,
          quote: unmaskFragment(finding.quote, replayMasker, "en"),
        }));
      },
    },
  );
  t("production masked -> restore -> revalidate is a real two-pass DROP",
    restoreCallCount === 1
      && maskedReplay.maskedNumericFilter.kept.length === 1
      && maskedReplay.restoredNumericFilter.dropped.length === 1
      && maskedReplay.coerced.length === 0);
  // A restore callback may initially expose a layout-derived but wrong quote
  // surface.  The source-backed variant callback must repair that surface
  // before counterpart validation; otherwise the final numeric filter would
  // never receive the verified row context.
  const wrongFirstSurface = "Net cash provided by/(used in) financing activities";
  let restoreSawMaskedSurface = false;
  let variantSawWrongSurface = false;
  let variantCallbackCount = 0;
  const wrongFirstReplay = await runNumericImportTwoPass(
    [coerceShape(attachedF0002, { quote: maskedQuote })],
    {
      ...replayOptions,
      masker: replayMasker,
      isMaskerCompatibleNumericFinding: (finding, context) =>
        Boolean(isConclusiveNumericFalsePositive(finding, { masker: replayMasker, ...context })),
      restoreMaskedFindings: async list => {
        restoreSawMaskedSurface = list.length === 1 && list[0].quote === maskedQuote;
        return list.map(finding => ({
          ...finding,
          quote: wrongFirstSurface,
          quoteVariants: [attachedF0002.quote],
        }));
      },
      chooseSourceBackedQuoteVariants: async list => {
        variantCallbackCount++;
        variantSawWrongSurface = list.length === 1 && list[0].quote === wrongFirstSurface;
        for (const finding of list) {
          if (Array.isArray(finding.quoteVariants) && finding.quoteVariants.length === 1) {
            finding.quote = finding.quoteVariants[0];
          }
        }
      },
    },
  );
  t("production wrong-first restored quote is corrected before counterpart validation",
    restoreSawMaskedSurface
      && variantSawWrongSurface
      && variantCallbackCount === 1
      && wrongFirstReplay.compatibleNumericDropped.length === 0
      && wrongFirstReplay.maskedNumericFilter.dropped.length === 0
      && wrongFirstReplay.maskedNumericFilter.kept.map(finding => finding.id).join(",") === "F0002"
      && wrongFirstReplay.restoredFindings.map(finding => finding.id).join(",") === "F0002"
      && wrongFirstReplay.restoredFindings[0].quote === attachedF0002.quote
      && wrongFirstReplay.restoredFindings[0].counterparts?.length === 1
      && wrongFirstReplay.restoredNumericFilter.dropped.map(finding => finding.id).join(",") === "F0002"
      && wrongFirstReplay.restoredNumericFilter.kept.length === 0
      && wrongFirstReplay.coerced.length === 0
      && wrongFirstReplay.numericFilteredCount === 1);
  // The browser receives all four page-label spellings after PDF extraction;
  // exercise the same coerce -> source validation -> partition boundary for
  // each spelling, including full-width P and full-width punctuation.
  const productionShapeFor = (finding, pages) => {
    const coercedShape = { ...finding };
    delete coercedShape.counterparts;
    delete coercedShape.counterParts;
    const validated = validateSameDocumentCounterpartContext(coercedShape, pages);
    return {
      validated,
      finding: { ...coercedShape, counterparts: validated.counterparts },
    };
  };
  for (const marker of ["P.5", "P．5", "Ｐ．5", "Page 5"]) {
    const marker11 = marker.replace(/5$/u, "11");
    for (const finding of [attachedF0002, attachedF0003]) {
      const reason = finding.reason
        .replaceAll("P.5", marker)
        .replaceAll("P.11", marker11);
      const { validated, finding: productionShape } = productionShapeFor({
        ...finding,
        reason,
        model_reason: reason,
      }, targetPages);
      t(`production page-marker form ${marker} source-binds ${finding.id}`,
        validated.counterparts.length === 1
          && partitionNumericFalsePositives([productionShape]).dropped.length === 1);
    }
  }
  const sourceBoundF0002 = productionShapeFor(attachedF0002, targetPages);
  const wrongCounterpartAmountPages = {
    ...targetPages,
    "11": String(targetPages["11"]).replace("(27,506)", "(28,000)"),
  };
  const wrongCounterpartAmount = productionShapeFor(attachedF0002, wrongCounterpartAmountPages);
  t("production source counterpart amount mismatch keeps F0002",
    wrongCounterpartAmount.validated.counterparts.length === 0
      && partitionNumericFalsePositives([wrongCounterpartAmount.finding]).kept.length === 1);
  const cacheShape = finding => {
    const shape = {
      ...finding,
      issueSummary: finding.issueSummary || finding.issue_summary || "同一行の数値を照合する。",
      counterparts: [],
      counterParts: [],
    };
    delete shape.model_reason;
    delete shape.issue_summary;
    return shape;
  };
  const validationCache = { sources: new Map(), maxSources: 64 };
  const cachedExact = validateSameDocumentCounterpartContext(
    cacheShape(attachedF0002), targetPages, { sourceCache: validationCache },
  );
  const cachedMismatch = validateSameDocumentCounterpartContext(
    cacheShape(attachedF0002), wrongCounterpartAmountPages, { sourceCache: validationCache },
  );
  t("production source cache is keyed by source text and does not leak an exact binding",
    cachedExact.counterparts.length === 1 && cachedMismatch.counterparts.length === 0);
  const missingTargetQuotePages = {
    ...targetPages,
    "5": String(targetPages["5"]).replace(
      "Net cash used in financing activities was",
      "Net cash provided in financing activities was",
    ),
  };
  const missingTargetQuote = productionShapeFor(attachedF0002, missingTargetQuotePages);
  t("production missing target quote keeps F0002",
    missingTargetQuote.validated.counterparts.length === 0
      && partitionNumericFalsePositives([missingTargetQuote.finding]).kept.length === 1);
  const missingCounterpartQuotePages = {
    ...targetPages,
    "11": String(targetPages["11"]).replace(
      "Net cash provided by/(used in) financing activities",
      "Cash flow financing activities",
    ),
  };
  const missingCounterpartQuote = productionShapeFor(attachedF0002, missingCounterpartQuotePages);
  t("production missing counterpart quote keeps F0002",
    missingCounterpartQuote.validated.counterparts.length === 0
      && partitionNumericFalsePositives([missingCounterpartQuote.finding]).kept.length === 1);
  const wrongTargetAmountPages = {
    ...targetPages,
    "11": String(targetPages["11"]).replace("1,214,803", "1,214,804"),
  };
  const wrongTargetAmount = productionShapeFor(attachedF0003, wrongTargetAmountPages);
  t("production source target amount mismatch keeps F0003",
    wrongTargetAmount.validated.counterparts.length === 0
      && partitionNumericFalsePositives([wrongTargetAmount.finding]).kept.length === 1);
  t("production exact source binding remains DROP after mismatch guards",
    sourceBoundF0002.validated.counterparts.length === 1
      && partitionNumericFalsePositives([sourceBoundF0002.finding]).dropped.length === 1);
  const hostilePeriodClaim = attachedF0002.reason
    .replace("2027年3月期第1四半期", "FY2026 first quarter")
    .replace("2026年6月30日終了の同期間の表", "June 30, 2025 for the same period table");
  const hostilePeriodNote = "Unrelated note: FY2026 first quarter ended June 30, 2025.";
  const hostilePeriodPages = {
    ...targetPages,
    // These notes are deliberately outside the quoted rows.  The old
    // whole-page period scan could borrow them to authorize the mutation.
    "5": `${targetPages["5"]}\n${hostilePeriodNote}`,
    "11": `${targetPages["11"]}\n${hostilePeriodNote}`,
  };
  const hostilePrependedPeriodPages = {
    ...targetPages,
    "5": `${hostilePeriodNote}\n${targetPages["5"]}`,
    "11": `${hostilePeriodNote}\n${targetPages["11"]}`,
  };
  const hostilePeriodFinding = {
    ...attachedF0002,
    reason: hostilePeriodClaim,
    model_reason: hostilePeriodClaim,
  };
  const hostilePeriods = [hostilePeriodPages, hostilePrependedPeriodPages]
    .map(pages => productionShapeFor(hostilePeriodFinding, pages));
  t("production far unrelated period notes cannot authorize F0002",
    hostilePeriods.every(hostilePeriod => hostilePeriod.validated.counterparts.length === 0
      && partitionNumericFalsePositives([hostilePeriod.finding]).kept.length === 1));
  const nearRowHostilePeriodPages = {
    ...targetPages,
    // A conflicting period note directly above the unique target row must not
    // become a replacement header for the real cash-flow section context.
    "5": String(targetPages["5"]).replace(
      "Net cash used in financing activities was",
      `${hostilePeriodNote}\nNet cash used in financing activities was`,
    ),
  };
  const nearRowHostilePeriod = productionShapeFor(hostilePeriodFinding, nearRowHostilePeriodPages);
  t("production near-row conflicting period note cannot authorize F0002",
    nearRowHostilePeriod.validated.counterparts.length === 0
      && partitionNumericFalsePositives([nearRowHostilePeriod.finding]).kept.length === 1);
  const blockedNearRowHostilePeriodPages = {
    ...targetPages,
    "5": String(targetPages["5"]).replace(
      "Net cash used in financing activities was",
      `Unrelated data row: ¥999.9 billion.\n${hostilePeriodNote}\nNet cash used in financing activities was`,
    ),
  };
  const blockedNearRowHostilePeriod = productionShapeFor(
    hostilePeriodFinding, blockedNearRowHostilePeriodPages,
  );
  t("production period-only note after a numeric row cannot replace the section header",
    blockedNearRowHostilePeriod.validated.counterparts.length === 0
      && partitionNumericFalsePositives([blockedNearRowHostilePeriod.finding]).kept.length === 1);
  const bracketBlockedNearRowPages = {
    ...targetPages,
    "5": String(targetPages["5"]).replace(
      "Net cash used in financing activities was",
      `Unrelated data row: ¥999.9 billion.\n(FY2026 first quarter ended June 30, 2025)\nNet cash used in financing activities was`,
    ),
  };
  const bracketBlockedNearRow = productionShapeFor(
    hostilePeriodFinding, bracketBlockedNearRowPages,
  );
  t("production bracket-leading period-only note cannot replace the section header",
    bracketBlockedNearRow.validated.counterparts.length === 0
      && partitionNumericFalsePositives([bracketBlockedNearRow.finding]).kept.length === 1);
  const sourceScopeConflictPages = {
    ...targetPages,
    "5": `Consolidated ${targetPages["5"]}`,
    "11": `Standalone ${targetPages["11"]}`,
  };
  const sourceScopeConflict = productionShapeFor(attachedF0002, sourceScopeConflictPages);
  t("production source consolidated-vs-standalone scope conflict keeps F0002",
    sourceScopeConflict.validated.counterparts.length === 0
      && partitionNumericFalsePositives([sourceScopeConflict.finding]).kept.length === 1);
  const ambiguousSourceScopePages = {
    ...targetPages,
    "5": `Consolidated Standalone ${targetPages["5"]}`,
  };
  const ambiguousSourceScope = productionShapeFor(attachedF0002, ambiguousSourceScopePages);
  t("production ambiguous source scope keeps F0002",
    ambiguousSourceScope.validated.counterparts.length === 0
      && partitionNumericFalsePositives([ambiguousSourceScope.finding]).kept.length === 1);
  const duplicateTargetQuote = productionShapeFor(attachedF0002, {
    ...targetPages,
    "5": `${targetPages["5"]} ${attachedF0002.quote}`,
  });
  t("production duplicate normalized target quote keeps F0002",
    duplicateTargetQuote.validated.counterparts.length === 0
      && partitionNumericFalsePositives([duplicateTargetQuote.finding]).kept.length === 1);
  const duplicateCounterpartQuote = productionShapeFor(attachedF0003, {
    ...targetPages,
    "5": `${targetPages["5"]} ${attachedF0003.counterparts[0].quote}`,
  });
  t("production duplicate normalized counterpart quote keeps F0003",
    duplicateCounterpartQuote.validated.counterparts.length === 0
      && partitionNumericFalsePositives([duplicateCounterpartQuote.finding]).kept.length === 1);
  const pairedClaim = (finding, reason) => ({
    ...finding,
    reason,
    model_reason: reason,
  });
  const attachedGuards = [
    ["27.6 billion vs 27,506 million", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replace("27.5 billion", "27.6 billion"),
    )],
    ["1,214.7 billion vs 1,214,803 million", pairedClaim(
      attachedF0003,
      attachedF0003.reason.replace("1,214.8 billion", "1,214.7 billion"),
    )],
    ["explicit sign mismatch", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replace("(27,506)", "27,506"),
    )],
    ["operating-vs-financing metric mismatch", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replaceAll("financing activities", "operating activities"),
    )],
    ["period/date mismatch", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replace("2026年6月30日", "2025年6月30日"),
    )],
    ["wrong Japanese quarter date (May 31 instead of Q1 end)", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replace("2026年6月30日", "2026年5月31日"),
    )],
    ["wrong English quarter date (May 31 instead of Q1 end)", pairedClaim(
      attachedF0002,
      attachedF0002.reason
        .replace("2027年3月期第1四半期", "FY2027 first quarter")
        .replace("2026年6月30日終了の同期間の表", "May 31, 2026 for the same period table"),
    )],
    ["currency mismatch", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replace("27,506) million yen", "27,506) million USD"),
    )],
    ["extra contradictory counterpart amount", pairedClaim(
      attachedF0002,
      attachedF0002.reason.replace(
        "実量を示す記号が一致しない。",
        "実量を示す記号が一致しない。P.11の同じ指標に(28,000) million yenという別の値もある。",
      ),
    )],
  ];
  for (const [label, finding] of attachedGuards) {
    t(`2026-08-19 attached numeric safety boundary (${label}) keeps`,
      partitionNumericFalsePositives([finding]).kept.length === 1);
  }
  t("2026-08-19 attached missing positive scope evidence keeps",
    partitionNumericFalsePositives([{
      ...attachedF0002,
      counterparts: [],
    }]).kept.length === 1);
  t("2026-08-19 attached F0003 without counterpart binding keeps",
    partitionNumericFalsePositives([{
      ...attachedF0003,
      counterparts: [],
    }]).kept.length === 1);
  t("2026-08-19 attached F0002 wrong counterpart quote keeps",
    partitionNumericFalsePositives([{
      ...attachedF0002,
      counterparts: attachedF0002.counterparts.map(counterpart => ({
        ...counterpart,
        quote: "Unrelated verified quote on page 11",
      })),
    }]).kept.length === 1);
  t("2026-08-19 attached F0003 wrong counterpart quote keeps",
    partitionNumericFalsePositives([{
      ...attachedF0003,
      counterparts: attachedF0003.counterparts.map(counterpart => ({
        ...counterpart,
        quote: "Unrelated verified quote on page 5",
      })),
    }]).kept.length === 1);
  const attachedCounterpartSafetyCases = [
    ["F0002", attachedF0002, 11, "Net cash provided by/(used in) financing activities",
      "financing activities", "P.11の「Net cash provided by/(used in) financing activities」も確認する。"],
    ["F0003", attachedF0003, 5,
      "Cash and cash equivalent as of June 30, 2026 decreased by ¥78.4 billion from the end of the previous fiscal year to ¥1,214.8 billion.",
      "Cash and cash equivalent", "P.5の「Cash and cash equivalent as of June 30, 2026 decreased by ¥78.4 billion from the end of the previous fiscal year to ¥1,214.8 billion.」も確認する。"],
  ];
  for (const [id, finding, counterpartPage, exactQuote, partialQuote, duplicateQuote] of attachedCounterpartSafetyCases) {
    const duplicateRecord = {
      ...finding,
      counterparts: [...finding.counterparts, { ...finding.counterparts[0] }],
    };
    t(`2026-08-19 ${id} duplicate verified counterpart record keeps`,
      partitionNumericFalsePositives([duplicateRecord]).kept.length === 1);
    const duplicateOccurrence = pairedClaim(
      finding,
      `${finding.reason} ${duplicateQuote}`,
    );
    t(`2026-08-19 ${id} duplicate compatible quote occurrence keeps`,
      partitionNumericFalsePositives([duplicateOccurrence]).kept.length === 1);
    const partial = {
      ...finding,
      counterparts: finding.counterparts.map(counterpart => ({
        ...counterpart,
        quote: partialQuote,
      })),
    };
    t(`2026-08-19 ${id} partial/generic counterpart quote keeps`,
      partitionNumericFalsePositives([partial]).kept.length === 1);
    const wrongPage = {
      ...finding,
      counterparts: finding.counterparts.map(counterpart => ({
        ...counterpart,
        page: counterpartPage + 1,
        quote: exactQuote,
      })),
    };
    t(`2026-08-19 ${id} wrong counterpart page keeps`,
      partitionNumericFalsePositives([wrongPage]).kept.length === 1);
    for (const status of ["pending", "error"]) {
      const duplicateUnverified = {
        ...finding,
        counterparts: [...finding.counterparts, {
          ...finding.counterparts[0],
          status,
        }],
      };
      t(`2026-08-19 ${id} ok+${status} duplicate counterpart keeps`,
        partitionNumericFalsePositives([duplicateUnverified]).kept.length === 1);
    }
    const duplicateConflictingQuote = {
      ...finding,
      counterparts: [...finding.counterparts, {
        ...finding.counterparts[0],
        quote: `Unrelated quote on page ${counterpartPage}`,
      }],
    };
    t(`2026-08-19 ${id} duplicate counterpart with conflicting quote keeps`,
      partitionNumericFalsePositives([duplicateConflictingQuote]).kept.length === 1);
    const counterPartsOnly = { ...finding, counterparts: undefined, counterParts: [...finding.counterparts] };
    t(`2026-08-19 ${id} counterParts alias alone remains supported`,
      partitionNumericFalsePositives([counterPartsOnly]).dropped.length === 1);
    const dualAlias = { ...finding, counterParts: [...finding.counterparts] };
    t(`2026-08-19 ${id} dual counterpart aliases are ambiguous`,
      partitionNumericFalsePositives([dualAlias]).kept.length === 1);
    const aliasConflict = {
      ...finding,
      counterParts: [{ ...finding.counterparts[0], status: "pending" }],
    };
    t(`2026-08-19 ${id} verified plus pending counterParts is ambiguous`,
      partitionNumericFalsePositives([aliasConflict]).kept.length === 1);
  }
  const attachedPagePeriodMutations = [
    ["reason", attachedF0002.reason.replace("2026年6月30日", "2026年5月31日")],
    ["model_reason", attachedF0002.model_reason.replace("2026年6月30日", "2026年5月31日")],
    ["suggestion", "P.5の2026年3月期第1四半期27.5とP.11の2026年6月30日27,506を確認する。"],
  ];
  for (const [field, value] of attachedPagePeriodMutations) {
    t(`2026-08-19 attached single-field page-period mutation (${field}) keeps`,
      partitionNumericFalsePositives([{
        ...attachedF0002,
        [field]: value,
      }]).kept.length === 1);
  }
  for (const field of ["reason", "model_reason"]) {
    t(`2026-08-19 attached single-field duplicate quote (${field}) keeps`,
      partitionNumericFalsePositives([{
        ...attachedF0002,
        [field]: `${attachedF0002[field]} 「Net cash provided by/(used in) financing activities」`,
      }]).kept.length === 1);
  }
  const attachedCanonicalAliases = ["reason", "model_reason", "issueSummary", "issue_summary"];
  const attachedCanonicalAmbiguityCases = [
    ["missing counterpart period", attachedF0002.reason.replace(
      "2026年6月30日終了の同期間の表", "同期間の表",
    )],
    ["contradictory and valid dates", attachedF0002.reason.replace(
      "2026年6月30日終了の同期間の表", "2026年5月31日または2026年6月30日終了の同期間の表",
    )],
    ["third page marker", `${attachedF0002.reason} P.99の別資料では27,506 million yenを参照する。`],
    ["duplicate page markers", `${attachedF0002.reason} P.5の補助引用とP.11の補助引用も確認する。`],
  ];
  for (const alias of attachedCanonicalAliases) {
    for (const [label, value] of attachedCanonicalAmbiguityCases) {
      t(`2026-08-19 ${alias} ${label} is a global KEEP veto`,
        partitionNumericFalsePositives([{
          ...attachedF0002,
          [alias]: value,
        }]).kept.length === 1);
      }
  }
  for (const marker of ["Page 99", "Ｐ．99", "P-99"]) {
    const candidate = {
      ...attachedF0002,
      reason: `${attachedF0002.reason} ${marker}の別資料では27,506 million yenを参照する。`,
      model_reason: `${attachedF0002.model_reason} ${marker}の別資料では27,506 million yenを参照する。`,
    };
    t(`2026-08-19 malformed/additional page marker ${marker} keeps`,
      partitionNumericFalsePositives([candidate]).kept.length === 1);
  }
  for (const alias of ["issueSummary", "issue_summary", "suggestion"]) {
    const candidate = {
      ...attachedF0002,
      [alias]: "営業活動の非連結データをFY2028のUSD値として参照する。符号は正である。",
    };
    t(`2026-08-19 ${alias} no-amount scope/measure/period/currency/source contradiction keeps`,
      partitionNumericFalsePositives([candidate]).kept.length === 1);
  }
  const unpaginatedContradictoryPeriodCases = [
    ["FY alternatives", "FY2027またはFY2028"],
    ["date alternatives", "2026年6月30日または2025年6月30日"],
  ];
  for (const alias of attachedCanonicalAliases) {
    for (const [label, value] of unpaginatedContradictoryPeriodCases) {
      const candidate = {
        ...attachedF0002,
        quote: "",
        referenceQuote: "",
        reference_quote: "",
        reason: "",
        model_reason: "",
        issueSummary: "",
        issue_summary: "",
        suggestion: "",
        counterparts: [],
        counterParts: [],
        [alias]: value,
      };
      t(`2026-08-19 unpaginated no-amount ${alias} ${label} is a global KEEP veto`,
        partitionNumericFalsePositives([candidate]).kept.length === 1);
    }
  }
  const isolatedNonnumericContradictions = [
    ["reason", `${attachedF0002.reason} 符号は正で、非連結の範囲として「Unrelated source quote」を参照する。`],
    ["issueSummary", "符号は正で、非連結の範囲として「Unrelated source quote」を参照する。"],
    ["suggestion", `${attachedF0002.suggestion} 符号は正で、非連結の範囲として「Unrelated source quote」を参照する。`],
  ];
  for (const [field, value] of isolatedNonnumericContradictions) {
    t(`2026-08-19 isolated nonnumeric contradiction in ${field} keeps`,
      partitionNumericFalsePositives([{
        ...attachedF0002,
        [field]: value,
      }]).kept.length === 1);
  }
  const attachedF0002NoAmount = attachedF0002.reason
    .replace("27.5 billion yen", "the stated amount")
    .replace("(27,506) million yen", "the stated amount");
  const attachedF0003NoAmount = attachedF0003.reason
    .replace("1,214,803 million yen", "the stated amount")
    .replace("1,214.8 billion", "the stated amount")
    .replace("78.4 billion", "the change amount");
  const noAmountCanonicalBases = [
    ["F0002", attachedF0002, attachedF0002NoAmount],
    ["F0003", attachedF0003, attachedF0003NoAmount],
  ];
  const noAmountCanonicalMutations = (base, id) => [
    ["missing counterpart period", id === "F0002"
      ? base.replace("2026年6月30日終了の同期間の表", "同期間の表")
      : base.replace("June 30, 2026", "")],
    ["conflicting and valid dates", id === "F0002"
      ? base.replace("2026年6月30日終了の同期間の表", "2026年5月31日または2026年6月30日終了の同期間の表")
      : base.replace("June 30, 2026", "May 31, 2026 or June 30, 2026")],
    ["third page marker", `${base} P.99の別資料を参照する。`],
    ["duplicate page markers", `${base} P.5の補助引用とP.11の補助引用も確認する。`],
    ["partial counterpart quote", id === "F0002"
      ? base.replace("「Net cash provided by/(used in) financing activities」", "「financing activities」")
      : base.replace("「Cash and cash equivalent as of June 30, 2026 decreased by ¥78.4 billion from the end of the previous fiscal year to ¥1,214.8 billion.」", "「Cash and cash equivalent」")],
  ];
  for (const [id, finding, base] of noAmountCanonicalBases) {
    for (const alias of attachedCanonicalAliases) {
      for (const [label, value] of noAmountCanonicalMutations(base, id)) {
        t(`2026-08-19 ${id} no-amount ${alias} ${label} keeps`,
          partitionNumericFalsePositives([{
            ...finding,
            [alias]: value,
          }]).kept.length === 1);
      }
    }
  }
  const noAmountSuggestionBases = [
    ["F0002", attachedF0002,
      attachedF0002.suggestion
        .replace("27.5", "the stated amount")
        .replace("27,506", "the stated amount")],
    ["F0003", attachedF0003, attachedF0003.suggestion],
  ];
  const noAmountSuggestionMutations = (id, base) => [
    ["conflicting dates/FY", id === "F0002"
      ? "P.5のFY2027 first quarterの値とP.11のMay 31, 2026 or June 30, 2026の値を確認する。"
      : "P.5とP.11の2026年5月31日または2026年6月30日の現金及び現金同等物を確認してください。"],
    ["wrong explicit quote", "P.5の「wrong source quote」とP.11の「wrong source quote」を確認する。"],
    ["third page marker", `${base} P.99の補助引用を確認する。`],
    ["duplicate page markers", `${base} P.5の補助引用とP.11の補助引用を確認する。`],
  ];
  for (const [id, finding, base] of noAmountSuggestionBases) {
    for (const [label, suggestion] of noAmountSuggestionMutations(id, base)) {
      t(`2026-08-19 ${id} no-amount page-labelled suggestion ${label} keeps`,
        partitionNumericFalsePositives([{
          ...finding,
          suggestion,
        }]).kept.length === 1);
    }
  }
  const attachedF0003CanonicalAmbiguityCases = [
    ["missing side period", attachedF0003.reason.replace("June 30, 2026", "")],
    ["conflicting and valid dates", attachedF0003.reason.replace(
      "June 30, 2026", "May 31, 2026 or June 30, 2026",
    )],
    ["third page marker", `${attachedF0003.reason} P.99の別資料では1,214,803 million yenを参照する。`],
    ["duplicate page markers", `${attachedF0003.reason} P.11の補助引用とP.5の補助引用も確認する。`],
  ];
  for (const alias of attachedCanonicalAliases) {
    for (const [label, value] of attachedF0003CanonicalAmbiguityCases) {
      t(`2026-08-19 F0003 no-primary ${alias} ${label} is a global KEEP veto`,
        partitionNumericFalsePositives([{
          ...attachedF0003,
          [alias]: value,
        }]).kept.length === 1);
    }
  }
  t("2026-08-19 F0003 page-labelled suggestion cannot bypass no-primary preflight",
    partitionNumericFalsePositives([{
      ...attachedF0003,
      reason: "",
      model_reason: "",
      issueSummary: "",
      issue_summary: "",
      suggestion: "P.11の1,214,803とP.5の1,214,803のどちらが正しいか確認する。",
    }]).kept.length === 1);
  const attachedF0002FreeformScopeOnly = {
    ...attachedF0002,
    counterparts: [],
    reason: `${attachedF0002.reason} 両方とも連結の同じ範囲である。`,
    model_reason: `${attachedF0002.model_reason} 両方とも連結の同じ範囲である。`,
  };
  t("2026-08-19 attached F0002 free-form consolidated prose is not scope proof",
    partitionNumericFalsePositives([attachedF0002FreeformScopeOnly]).kept.length === 1);
  t("2026-08-19 attached unverified counterpart scope evidence keeps",
    partitionNumericFalsePositives([{
      ...attachedF0002,
      counterparts: attachedF0002.counterparts.map(counterpart => ({
        ...counterpart,
        status: "pending",
      })),
    }]).kept.length === 1);
}

// 全体実行の2段目（proofread）を、直前の consistency と取り違えないための判定。
{
  t("観点パケットなら警告しない", !shouldWarnMissingLens("consistency", [{ status: "done", packet_id: "C1_NUMBERS" }]));
  t("追撃passがあれば警告しない", !shouldWarnMissingLens("consistency", [{ status: "done", packet_id: "C1", passes: [{}, {}] }]));
  t("観点情報の無い整合性だけ警告", shouldWarnMissingLens("consistency", [{ status: "done", packet_id: "C1" }]));
  t("校正では観点警告を出さない", !shouldWarnMissingLens("proofread", [{ status: "done", packet_id: "P1" }]));
}

// 同一箇所・別 suggestion は削除しない（fix #6）。group にまとまり、両案を保持
{
  const f = [
    { page: 8, category: "grammar", quote: "the datas", suggestion: "the data", reason: "単複", pass_id: "p1", pass_lens: "grammar" },
    { page: 8, category: "grammar", quote: "the datas", suggestion: "the dataset", reason: "語彙", pass_id: "p2", pass_lens: "spelling" },
  ];
  const d = exactDedupe(f);
  t("別suggestionは dedupe されない", d.length === 2);
  const g = groupSimilar(d);
  t("同一箇所は1グループ", g.length === 1);
  t("グループ内に2候補（別案を保持）", g[0].candidates.length === 2);
  const suggestions = g[0].candidates.map(c => c.suggestion).sort();
  t("両 suggestion が残る", JSON.stringify(suggestions) === JSON.stringify(["the data", "the dataset"]));
}

// 引用の空白・全半角差は正規化して同一グループに
{
  const f = [
    { page: 9, category: "names", quote: "Acme  Holdings", suggestion: "ACME Holdings" },
    { page: 9, category: "names", quote: "Acme Holdings", suggestion: "ACME Holdings" },
  ];
  const d = exactDedupe(f);
  t("空白差の完全重複は1件（normalize）", d.length === 1);
}

// 別ページ／別カテゴリは別グループ
{
  const f = [
    { page: 7, category: "numbers", quote: "x", suggestion: "y" },
    { page: 8, category: "numbers", quote: "x", suggestion: "y" },
    { page: 7, category: "names", quote: "x", suggestion: "y" },
  ];
  const g = groupSimilar(f);
  t("page/category違いは別グループ", g.length === 3);
}

// integrateFindings の集計
{
  const f = [
    { page: 7, category: "numbers", quote: "12,345", suggestion: "12,346" },
    { page: 7, category: "numbers", quote: "12,345", suggestion: "12,346" }, // exact dup
    { page: 7, category: "numbers", quote: "12,345", suggestion: "12,300" }, // 別案 → group同一・別候補
  ];
  const r = integrateFindings(f);
  t("findings_new=2", r.findings_new === 2);
  t("findings_exact_dup=1", r.findings_exact_dup === 1);
  t("finding_groups=1", r.finding_groups === 1);
}

if (failures > 0) { console.error(`\nTest-ReviewMerge: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-ReviewMerge: PASS");
