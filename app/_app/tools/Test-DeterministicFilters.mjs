// Test-DeterministicFilters.mjs
//
// Phase 1 (§6.1) の前提ゲート: プロンプトから抑止ルールを削除する前に、
// コード側の決定的フィルタが「除外すべき例」を除外し、かつ「似ているが
// 除外してはいけない例」を除外しないことを保証する。
//
// このテストは index.html から実際の関数ソースを抽出して評価する。
// 再実装ではなく現物を検証するため、index.html 側の変更と乖離しない。
//
// 実行: node tools/Test-DeterministicFilters.mjs
// 依存: なし（Node.js 標準のみ）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");

// --- index.html から現物の関数を抽出する -------------------------------

function extractFunction(name) {
  // function <name>(...) { ... } を波括弧の対応で切り出す。
  const startMarker = `function ${name}(`;
  const start = indexHtml.indexOf(startMarker);
  if (start < 0) throw new Error(`index.html に ${name} が見つかりません`);
  const braceStart = indexHtml.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < indexHtml.length; i++) {
    const ch = indexHtml[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return indexHtml.slice(start, i + 1);
    }
  }
  throw new Error(`${name} の波括弧が閉じていません`);
}

const src = [
  extractFunction("normalizeHyphenationComparisonText"),
  extractFunction("isLikelyLineEndHyphenFalsePositive"),
].join("\n");

// safeText 等の依存を持たないよう、抽出2関数だけを評価する。
// isLikelyLineEndHyphenFalsePositive は f.issueSummary/reason/category/quote/suggestion のみ参照。
const factory = new Function(`${src}\nreturn { normalizeHyphenationComparisonText, isLikelyLineEndHyphenFalsePositive };`);
const { normalizeHyphenationComparisonText, isLikelyLineEndHyphenFalsePositive } = factory();

// whitespaceOnlyDiff は buildFindings 内のインライン式。ロジックを index.html の
// compact 定義（正規表現）から抽出して同一性を保つ。
const compactRe = (() => {
  const m = indexHtml.match(/const compact = value => String\(value \|\| ""\)\.replace\((\/[^/]+\/[a-z]*), ""\)/);
  if (!m) throw new Error("index.html の compact 定義（whitespaceOnlyDiff 用）が見つかりません");
  return m[1];
})();
const compact = value => {
  // 抽出した正規表現リテラルを安全に再構築する。
  const body = compactRe.slice(1, compactRe.lastIndexOf("/"));
  const flags = compactRe.slice(compactRe.lastIndexOf("/") + 1);
  return String(value || "").replace(new RegExp(body, flags), "");
};
const whitespaceOnlyDiff = (quote, suggestion) =>
  !!quote && !!suggestion && quote !== suggestion && compact(quote) === compact(suggestion);

// --- fixtures ----------------------------------------------------------
// exclude=true  : フィルタが除外する（体裁/誤認識として落とす）べき
// exclude=false : 除外してはいけない（実指摘として残す）べき

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`  FAIL ${name}: expected=${expected} actual=${actual}`); }
  else console.log(`  ok   ${name}`);
};

// (1) whitespaceOnlyDiff — 空白のみ差分は体裁として除外
console.log("[whitespaceOnlyDiff] 除外すべき（空白のみ差分）");
check("spaces '( (71.6) %)'→'((71.6)%)'", whitespaceOnlyDiff("( (71.6) %)", "((71.6)%)"), true);
check("fullwidth-space 'A\\u3000B'→'AB'", whitespaceOnlyDiff("A　B", "AB"), true);
check("zero-width 'A\\u200bB'→'AB'", whitespaceOnlyDiff("A​B", "AB"), true);

console.log("[whitespaceOnlyDiff] 除外してはいけない（意味のある差分）");
// 数値内の空白差ではなく、桁が変わる=文字差 → 除外してはいけない
check("digit change '1 000'→'10000'", whitespaceOnlyDiff("1 000", "10000"), false);
// 大文字小文字差は空白ではない → 除外してはいけない
check("case 'Other'→'other'", whitespaceOnlyDiff("Other", "other"), false);
// ソフトハイフン除去は空白ではない → whitespaceOnlyDiff では除外しない
check("soft-hyphen 'availab\\u00adle'→'available'", whitespaceOnlyDiff("availab­le", "available"), false);
// 完全同一は whitespaceOnlyDiff=false（exactSame 側で扱う）
check("exact-same 'AB'→'AB'", whitespaceOnlyDiff("AB", "AB"), false);

// (2) isLikelyLineEndHyphenFalsePositive — 行末ハイフン誤認識を除外
console.log("[isLikelyLineEndHyphenFalsePositive] 除外すべき（行末ハイフン誤認識）");
check(
  "North Rhine-Westphalia 連結誤認",
  isLikelyLineEndHyphenFalsePositive({
    quote: "North Rhine-\nWestphalia",
    suggestion: "North RhineWestphalia",
    reason: "行末ハイフンで連結され、ハイフン抜けに見える",
    category: "typo",
  }),
  true
);
check(
  "available-for-sale ハイフン抜け誤認",
  isLikelyLineEndHyphenFalsePositive({
    quote: "available-for-\nsale",
    suggestion: "available-forsale",
    reason: "line-end hyphen, compound word",
    category: "spelling",
  }),
  true
);

console.log("[isLikelyLineEndHyphenFalsePositive] 除外してはいけない（実際の綴り誤り等）");
// 正規化後に別語 → 実指摘。除外してはいけない
check(
  "genuine typo 'recieve'→'receive'",
  isLikelyLineEndHyphenFalsePositive({
    quote: "recieve",
    suggestion: "receive",
    reason: "スペルミス",
    category: "typo",
  }),
  false
);
// minus と hyphen の混同（符号が変わる財務数値）→ 正規化で同一化されるが
// ハイフン文脈の言及も既知パターンも無いので除外しない
check(
  "minus/hyphen sign '-5'→'\\u22125' without hyphen-context",
  isLikelyLineEndHyphenFalsePositive({
    quote: "-5",
    suggestion: "−5",
    reason: "符号の記号が異なる",
    category: "number_mismatch",
  }),
  false
);
// 正しい複合語だが、正規化後に別語（ハイフン以外の差）→ 除外しない
check(
  "compound but real diff 'available-for-sale'→'available-for-sail'",
  isLikelyLineEndHyphenFalsePositive({
    quote: "available-for-sale",
    suggestion: "available-for-sail",
    reason: "綴り誤り sale/sail",
    category: "typo",
  }),
  false
);

if (failures > 0) {
  console.error(`\nTest-DeterministicFilters: FAIL (${failures} case(s))`);
  process.exit(1);
}
console.log("\nTest-DeterministicFilters: PASS");
