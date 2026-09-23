// Regression coverage for issue #155: user input and automatic detection must
// not silently change what gets proofread.
//
//   node tools/Test-Issue155Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocumentLanguage } from "../js/review-settings.mjs";
import { detectNumberOfAgreementCandidate } from "../js/structural-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
function extractFunction(name) {
  const start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = indexHtml.indexOf(") {", start) + 2; i < indexHtml.length; i++) {
    if (indexHtml[i] === "{") depth++;
    else if (indexHtml[i] === "}" && --depth === 0) return indexHtml.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); failures.push(name); }
};

// --- 1. page ranges typed with a Japanese IME ---
{
  const names = ["normalizeAsciiInput", "stripRangeLabels", "extractRangeTokens", "parsePageRange", "pagesToRangeText"];
  const { parsePageRange, pagesToRangeText } = new Function(
    `${names.map(extractFunction).join("\n")}; return { parsePageRange, pagesToRangeText };`)();
  const parse = value => { try { return pagesToRangeText(parsePageRange(value, 60)); } catch (e) { return `ERR ${e.message}`; } };
  for (const input of ["２１ー４０", "21ｰ40", "21 to 40", "21から40", "２１－４０", "21〜40"]) {
    check(`「${input}」を P.21-40 として読む`, parse(input) === "21-40", parse(input));
  }
  for (const [input, expected] of [["1-5, 8", "1-5, 8"], ["P.3, P.5", "3, 5"], ["1-3と7", "1-3, 7"], ["TARGET_CHECK: P.1-10", "1-10"]]) {
    check(`従来の書き方「${input}」はそのまま`, parse(input) === expected, parse(input));
  }
  check("読めない区切りは単ページ2つにせずエラーにする", parse("21?40").startsWith("ERR"), parse("21?40"));
}

// --- 2. English PDFs with a bullet or a long-vowel mark ---
{
  const en = "Consolidated results for the fiscal year. Net sales increased by 5.2% year on year to 1,285.7 billion yen. ".repeat(12);
  check("行頭の「・」が1個ある英文は英語", detectDocumentLanguage(`・${en}`) === "英語");
  check("「ー」を含む英文は英語", detectDocumentLanguage("Net sales 2025ー2026 were higher than expected in all segments of the Group.") === "英語");
  check("カタカナの社名が少しだけある英文は英語", detectDocumentLanguage(`${en}トヨタ自動車`) === "英語");
  check("日本語の本文は従来どおり日本語", detectDocumentLanguage("売上高は前年同期比5.2%増の1兆2,857億円となりました。") === "日本語");
  check("略語の多い日本語の表も日本語", detectDocumentLanguage("売上高 営業利益 経常利益 IFRS EBITDA ROE ROIC の推移について") === "日本語");
}

// --- 3. compound subjects with "the number of" ---
{
  for (const sentence of [
    "Net sales and the number of units sold were both higher than in the previous fiscal year.",
    "The number of shares issued and the number of treasury shares were as follows.",
    "The number of employees and the average number of temporary employees are shown in parentheses.",
  ]) check(`複合主語に単数形を提案しない: ${sentence}`, !detectNumberOfAgreementCandidate(sentence, 1));
  for (const sentence of [
    "The results are final and the number of items are ten.",
    "The number of employees were 1,200 at year end.",
  ]) check(`単独の主語は従来どおり指摘する: ${sentence}`, !!detectNumberOfAgreementCandidate(sentence, 1));
}

if (failures.length) {
  console.error(`\nTest-Issue155Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue155Regression: PASS");
