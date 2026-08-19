// Test-ReviewMerge.mjs — review-merge.mjs の検証（node tools/Test-ReviewMerge.mjs）
import fs from "node:fs";
import {
  exactDedupe, groupSimilar, integrateFindings, partitionNumericFalsePositives, isConclusiveNumericFalsePositive, hasEquivalentScaledNumbers, findUniqueNumericSourceContext,
  isLikelyTableRowIndexOmission, shouldWarnMissingLens,
} from "../js/review-merge.mjs";

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

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
  // と27,506 millionは、符号をそろえた丸め同量だけDROPする。
  const raw2311 = JSON.parse(fs.readFileSync(
    new URL("./fixtures/review-merge-live-2311.json", import.meta.url),
    "utf8",
  ));
  const saved2311Financing = raw2311.findings.find(finding => finding.id === "F0003");
  const raw2311Result = partitionNumericFalsePositives(raw2311.findings);
  t("raw 2311 replayはF0003だけDROP", JSON.stringify(raw2311Result.dropped.map(finding => finding.id))
    === JSON.stringify(["F0003"]));
  t("raw 2311 replayはF0008/F0006をKEEP", JSON.stringify(raw2311Result.kept.map(finding => finding.id))
    === JSON.stringify(["F0008", "F0006"]));
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
  t("raw 2311のunsigned suggestionは丸め同量としてDROP",
    partitionNumericFalsePositives([{ ...saved2311Financing }]).dropped.length === 1);
  t("raw 2311のexplicit matching negative suggestionはDROP",
    partitionNumericFalsePositives([{
      ...saved2311Financing,
      suggestion: saved2311Financing.suggestion
        .replace("27.5", "(27.5)")
        .replace("27,506", "(27,506)"),
    }]).dropped.length === 1);
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
