// Test-ReviewMerge.mjs — review-merge.mjs の検証（node tools/Test-ReviewMerge.mjs）
import {
  exactDedupe, groupSimilar, integrateFindings, partitionNumericFalsePositives, hasEquivalentScaledNumbers,
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
  const restoredTautology = { category: "value_inconsistency", suggestion: "304と304のどちらであるか確認する" };
  const labelledTautology = { category: "value_inconsistency", suggestion: "P.4の304とP.15の304のどちらが正しいか確認する" };
  const summaryTautology = { category: "value_inconsistency", issueSummary: "世界販売台数がP.4の304とP.15の304で不一致" };
  const quotedTautology = { category: "number_mismatch", suggestion: "増減率の「1」を日本語版の「1」に対応する数値へ修正する" };
  const restoredSameRows = { category: "number_mismatch", quote: "Other 65 56 (9) (14.0)", referenceQuote: "その他 65 56 △9 △14.0%" };
  const realUnitMismatch = { category: "number_mismatch", quote: "5 million yen", referenceQuote: "5 billion yen" };
  const different = { category: "number_mismatch", quote: "⟦#ABC⟧", referenceQuote: "⟦#XYZ⟧" };
  const prose = { category: "prose_inconsistency", quote: "⟦#ABC⟧", referenceQuote: "⟦#ABC⟧" };
  const result = partitionNumericFalsePositives([same, signMismatch, repeatedReason, restoredTautology, labelledTautology, summaryTautology, quotedTautology, restoredSameRows, realUnitMismatch, different, prose]);
  t("同じ記号・同じ復元値の数値誤検出を除外", result.dropped.length === 7);
  t("符号差・単位差・別記号・非数値分類を保持", result.kept.length === 4);
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
