// Test-ReviewMerge.mjs — review-merge.mjs の検証（node tools/Test-ReviewMerge.mjs）
import {
  exactDedupe, groupSimilar, integrateFindings, partitionNumericFalsePositives, isConclusiveNumericFalsePositive, hasEquivalentScaledNumbers,
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
  t("同一placeholder・明示単位で同じ実量・丸め差・異種familyの誤検出を除外", result.dropped.length === 13
    && [same, repeatedReason, repeatedSuggestion, restoredSameRows, sameMoney, sameScaled, crossVehicle, crossCount, crossRate, rounded, roundedReason, untyped, sameSpacedNegative].every(f => result.dropped.includes(f)));
  t("符号差・空白付き符号/括弧・同family単位差・別記号・曖昧/非数値分類を保持", result.kept.length === 13
    && [signMismatch, signMismatchRepeated, sameFamilyMismatch, ambiguousUnits, spacedDelta, spacedParentheses, prose].every(f => result.kept.includes(f)));
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
  t("説明用外括弧のplaceholderは負数扱いせず符号差を保持", partitionNumericFalsePositives([outerPlaceholderParentheses]).kept.length === 1);
  t("placeholderを空白だけで囲む括弧は負数としてdrop", partitionNumericFalsePositives([simplePlaceholderParentheses]).dropped.length === 1);
  t("曖昧/無型の比較はconclusive proofにならない",
    !isConclusiveNumericFalsePositive(ambiguousUnits) && isConclusiveNumericFalsePositive(untyped));

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
    t(`ユーザー実測: ${name}`, partitionNumericFalsePositives([finding]).dropped.length === 1);
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
