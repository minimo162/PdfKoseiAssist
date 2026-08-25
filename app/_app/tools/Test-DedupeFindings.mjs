// Test-DedupeFindings.mjs — index.html の dedupeFindings を現物のまま検証する。
//
//   node tools/Test-DedupeFindings.mjs
//
// 整合性レビューはセクションを重ねて分割するため、重ね合わせ区間のページは2回読まれる。
// 実測（合成フィクスチャ, sectionWidth=25/overlap=3）では、重ね合わせ区間 P23-25 の
// 5件が二重にカード化された。Copilot が同じ誤りを別の言い回し・別カテゴリで返すため、
// 旧キー（page|category|quote|suggestion|reason の完全一致）では落ちなかった。
// ここでは実際に二重化した組をそのまま入力にして、1枚にまとまることを確認する。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeQuote } from "../js/review-merge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");

function extractFunction(name) {
  const start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html に ${name} が見つかりません`);
  let depth = 0;
  for (let i = indexHtml.indexOf("{", start); i < indexHtml.length; i++) {
    if (indexHtml[i] === "{") depth++;
    else if (indexHtml[i] === "}" && --depth === 0) return indexHtml.slice(start, i + 1);
  }
  throw new Error(`${name} の波括弧が閉じていません`);
}

const dedupeFindings = new Function("normalizeQuote",
  `${extractFunction("dedupeFindings")}; return dedupeFindings;`)(normalizeQuote);

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

// --- 実測で二重化した組（SEC_001 と SEC_002 が同じ誤りを別表現で返した） ---
const observed = [
  { page: 23, category: "translation_consistency", quote: "Profit per share (Yen)3 128.20 147.24",
    issueSummary: "1株当たり利益の脚注番号が3となり対応脚注が存在しない", suggestion: "脚注番号を2に修正する。", reason: "" },
  { page: 23, category: "translation_consistency", quote: "Profit per share (Yen)3 128.20 147.24",
    issueSummary: "1株当たり利益の脚注番号が原文および対応脚注と不一致", suggestion: "脚注番号「3」を「2」に修正する。", reason: "" },
  { page: 24, category: "translation_consistency", quote: "Record date March 31, 2025",
    issueSummary: "基準日が2025年", suggestion: "March 31, 2025をMarch 31, 2026に修正する。", reason: "" },
  { page: 24, category: "translation_consistency", quote: "Record date March 31, 2025",
    issueSummary: "基準日が2025年", suggestion: "「Record date March 31, 2026」に修正する。", reason: "" },
  // カテゴリまで食い違った組（旧キーでは page も quote も同じなのに残っていた）
  { page: 25, category: "value_inconsistency", quote: "The number of employees ... was 3,241, an increase of 74",
    issueSummary: "従業員数3,241がP.4の3,214と不一致", suggestion: "3,241を3,214に修正する。", reason: "" },
  { page: 25, category: "translation_consistency", quote: "The number of employees ... was 3,241, an increase of 74",
    issueSummary: "従業員数が原文の3,214人ではない", suggestion: "従業員数を「3,214」に修正する。", reason: "" },
];
const merged = dedupeFindings(observed);
t("重ね合わせ区間の二重検出が1件ずつに束ねられる (6→3)", merged.length === 3);
t("カテゴリが違っても同一箇所として束ねる", merged.filter(f => f.page === 25).length === 1);
t("別案を捨てずに reason へ残す", /同じ箇所の別案/.test(String(merged.find(f => f.page === 23)?.reason || "")));
t("同品質候補も逆順で同じ代表になる",
  dedupeFindings([...observed].reverse()).find(f => f.page === 23)?.suggestion
    === merged.find(f => f.page === 23)?.suggestion);

// --- 脚注記号の有無だけが違う組（2回目の実測で残った重複） ---
const footnote = [
  { page: 23, category: "translation_consistency", quote: "Profit per share (Yen)3 128.20 147.24",
    issueSummary: "脚注番号が3で脚注2と不一致", suggestion: "脚注番号3を2に修正する。", reason: "" },
  { page: 23, category: "translation_consistency", quote: "Profit per share (Yen)*3 128.20 147.24",
    issueSummary: "脚注番号がREFと不一致", suggestion: "脚注番号をREFに合わせて「2」に修正する。", reason: "" },
  { page: 23, category: "translation_consistency", quote: "*2 Diluted profit per share is not presented because there are no dilutive shares.",
    issueSummary: "株式報酬の但し書きが訳抜け", suggestion: "但し書きを追記する。", reason: "" },
  { page: 23, category: "translation_consistency", quote: "2 Diluted profit per share is not presented because there are no dilutive shares.",
    issueSummary: "株式報酬を含めない旨が訳抜け", suggestion: "脚注2に対応英文を追加する。", reason: "" },
];
t("脚注記号(*)の有無だけの差は同一箇所とみなす (4→2)", dedupeFindings(footnote).length === 2);

// --- 引用の切り取り幅が違うだけの組（3回目の実測で5組出た） ---
const partial = [
  { page: 3, category: "translation_consistency",
    quote: "The Company was established in Osaka Prefecture in March 1935 for the purpose of manufacturing and selling precision components.",
    issueSummary: "設立年が1935", suggestion: "March 1935をMarch 1953に修正する。", reason: "" },
  { page: 3, category: "translation_consistency",
    quote: "The Company was established in Osaka Prefecture in March 1935 for the purpose of manufacturing",
    issueSummary: "会社設立年が1935", suggestion: "March 1935をMarch 1953に修正する。", reason: "" },
  { page: 11, category: "translation_consistency", quote: "The effect is minor.",
    issueSummary: "当該影響が曖昧", suggestion: "何の影響かを明示する。", reason: "" },
  { page: 11, category: "translation_consistency",
    quote: "In addition, no serious quality problems occurred in the current consolidated fiscal year. The effect is minor.",
    issueSummary: "影響の対象が不明瞭", suggestion: "影響の対象を明示する。", reason: "" },
  { page: 16, category: "accounting_inconsistency",
    quote: "Shareholders' equity at the end of the current consolidated fiscal year was 247,510 million yen",
    issueSummary: "自己資本と株主資本の混同", suggestion: "適切な用語へ修正する。", reason: "" },
  { page: 16, category: "accounting_inconsistency",
    quote: "Shareholders' equity at the end of the current consolidated fiscal year was 247,510 million yen, an increase of 18,610 million yen from the end of the previous consolidated fiscal year.",
    issueSummary: "247,510がBSの239,300と不一致", suggestion: "equity attributable to owners of parent へ修正する。", reason: "" },
];
t("一方が他方を含む引用は同一箇所とみなす (6→3)", dedupeFindings(partial).length === 3);
t("包含で束ねても別案は残す",
  /同じ箇所の別案/.test(String(dedupeFindings(partial).find(f => f.page === 16)?.reason || "")));

// --- ごく短い引用は包含で巻き込まない（無関係な文にも含まれてしまうため） ---
const shortQuote = [
  { page: 40, category: "numbers", quote: "the Group", suggestion: "s1", reason: "" },
  { page: 40, category: "grammar", quote: "the Group has posted the briefing materials on its website", suggestion: "s2", reason: "" },
];
t("11文字以下の引用は包含判定に使わない", dedupeFindings(shortQuote).length === 2);

// --- ただし数値や句読点は潰さない（それ自体が指摘対象になりうる） ---
const punctuation = [
  { page: 30, category: "numbers", quote: "1234", suggestion: "桁区切りを入れる", reason: "" },
  { page: 30, category: "numbers", quote: "1,234", suggestion: "別の誤り", reason: "" },
];
t("句読点・桁区切りの違いは別の指摘として残す", dedupeFindings(punctuation).length === 2);

// --- 完全に同一の指摘は黙って落とす（reason を汚さない） ---
const same = [
  { page: 5, category: "x", quote: "abc", suggestion: "fix", reason: "r" },
  { page: 5, category: "x", quote: "ABC", suggestion: "FIX", reason: "r" },   // 正規化で一致
];
const sameOut = dedupeFindings(same);
t("正規化して同一の指摘は1件に", sameOut.length === 1);
t("同一なら reason に別案を足さない", !/同じ箇所の別案/.test(String(sameOut[0].reason || "")));

// --- 別の箇所は束ねない ---
const distinct = [
  { page: 7, category: "a", quote: "alpha", suggestion: "s1", reason: "" },
  { page: 7, category: "a", quote: "beta", suggestion: "s2", reason: "" },
  { page: 8, category: "a", quote: "alpha", suggestion: "s3", reason: "" },
];
t("quote が違えば残す / ページが違えば残す", dedupeFindings(distinct).length === 3);

// --- quote が無い指摘は箇所を特定できないので従来どおりの扱い ---
const noQuote = [
  { page: 9, category: "a", quote: "", suggestion: "s1", reason: "r1" },
  { page: 9, category: "a", quote: "", suggestion: "s2", reason: "r2" },   // 別の指摘。潰してはいけない
  { page: 9, category: "a", quote: "", suggestion: "s1", reason: "r1" },   // 完全重複
];
t("quote なしは全項目一致のときだけ重複扱い", dedupeFindings(noQuote).length === 2);

// --- 除外済みpassが後続の有効候補を潰さない ---
for (const [name, pair] of [
  ["完全一致 excluded→valid", [
    { id:"old", page:10, quote:"same quote long enough", suggestion:"fix", reason:"", excludedReason:"missing-evidence" },
    { id:"new", page:10, quote:"same quote long enough", suggestion:"fix", reason:"", excludedReason:"" },
  ]],
  ["完全一致 valid→excluded", [
    { id:"new", page:10, quote:"same quote long enough", suggestion:"fix", reason:"", excludedReason:"" },
    { id:"old", page:10, quote:"same quote long enough", suggestion:"fix", reason:"", excludedReason:"missing-evidence" },
  ]],
  ["包含 excluded→valid", [
    { id:"old", page:11, quote:"same quote long enough with trailing context", suggestion:"fix", reason:"", excludedReason:"quote-not-found" },
    { id:"new", page:11, quote:"same quote long enough", suggestion:"fix2", reason:"", excludedReason:"" },
  ]],
]) {
  const result = dedupeFindings(pair);
  t(`${name}: 代表は有効候補`, result.length === 1 && result[0].id === "new" && !result[0].excludedReason);
  t(`${name}: 除外候補を監査用alternativeへ保持`, result[0].alternatives?.some(x => x.id === "old"));
}
const excludedOnly = dedupeFindings([
  { id:"x1", page:12, quote:"excluded quote", suggestion:"a", excludedReason:"low-evidence" },
  { id:"x2", page:12, quote:"excluded quote", suggestion:"b", excludedReason:"quote-not-found" },
]);
t("除外候補しかない箇所は除外代表を維持", excludedOnly.length === 1 && Boolean(excludedOnly[0].excludedReason));

// verified REF / evidence completeness / confidence を含む品質順位が全順列で不変。
const ranked = [
  { id:"low", page:20, quote:"deterministic quote location", category:"omission", suggestion:"low",
    evidenceQuality:"clear", readingConfidence:0.76, confidence:0.8, needsHumanReview:true },
  { id:"verified", page:20, quote:"deterministic quote location", category:"translation_consistency", suggestion:"verified",
    evidenceQuality:"clear", readingConfidence:0.95, confidence:0.95, referenceQuoteVerified:true,
    referenceQuote:"検証済み引用", referenceFile:"ref.pdf", referencePages:[2] },
  { id:"excluded", page:20, quote:"deterministic quote location", suggestion:"excluded",
    evidenceQuality:"clear", readingConfidence:1, confidence:1, excludedReason:"missing-evidence" },
];
const permutations = values => values.length < 2 ? [values] : values.flatMap((value, i) =>
  permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest]));
for (const order of permutations(ranked)) {
  const result = dedupeFindings(order);
  const alternativeIds = new Set((result[0]?.alternatives || []).map(x => x.id));
  t(`品質順位は順序非依存: ${order.map(x => x.id).join("→")}`,
    result.length === 1 && result[0].id === "verified"
      && alternativeIds.has("low") && alternativeIds.has("excluded"));
}

const equalQuality = [
  { id:"A", page:21, quote:"same immutable place quote", suggestion:"a", reason:"" },
  { id:"B", page:21, quote:"same immutable place quote", suggestion:"a", reason:"a" },
  { id:"C", page:21, quote:"same immutable place quote", suggestion:"b", reason:"" },
];
const signatures = permutations(equalQuality).map(order => {
  const result = dedupeFindings(structuredClone(order))[0];
  return JSON.stringify({ id:result.id, reason:result.reason, alternatives:result.alternatives });
});
t("同品質3候補も加工済みreasonに影響されず全順列で同じ結果", new Set(signatures).size === 1);

// 累積 findings へ何度再適用しても、表示用の別案行は増殖しない。
let repeated = structuredClone(observed.slice(0, 2));
for (let round = 0; round < 12; round++) repeated = dedupeFindings(repeated);
const repeatedReason = String(repeated[0]?.reason || "");
t("12ラウンド再適用しても同じ別案は1回だけ",
  (repeatedReason.match(/同じ箇所の別案/g) || []).length === 1);

if (failures) { console.error(`\nTest-DedupeFindings: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-DedupeFindings: PASS");
