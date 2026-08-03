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
t("代表は先頭の指摘", merged[0].suggestion === "脚注番号を2に修正する。");

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

if (failures) { console.error(`\nTest-DedupeFindings: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-DedupeFindings: PASS");
