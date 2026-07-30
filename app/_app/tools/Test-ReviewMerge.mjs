// Test-ReviewMerge.mjs — review-merge.mjs の検証（node tools/Test-ReviewMerge.mjs）
import { exactDedupe, groupSimilar, integrateFindings } from "../js/review-merge.mjs";

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
