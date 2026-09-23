// Regression coverage for issue #163: a short reference_quote (e.g. a Japanese
// table label such as 「営業外費用」) must still be verified against the REF
// when it is unique, so genuine translation findings are not excluded as
// reference-quote-not-found.
//
//   node tools/Test-Issue163Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");

function extractFunction(name) {
  let start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (indexHtml.slice(start - 6, start) === "async ") start -= 6;
  let depth = 0;
  for (let i = indexHtml.indexOf("{", start); i < indexHtml.length; i++) {
    if (indexHtml[i] === "{") depth++;
    else if (indexHtml[i] === "}" && --depth === 0) return indexHtml.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}

const failures = [];
const check = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}`); failures.push(name); }
};

// REF: 3 pages. 「営業外費用」 appears once on P.2; 「売上高」 appears on P.1 and P.3.
const refPages = [
  "売上高 100 営業利益 20",
  "営業外収益 受取利息 5 営業外費用 支払利息 △3",
  "売上高 110 経常利益 22",
];
// TARGET: one page containing both quotes.
const targetText = "Non-operating income Interest income 5 Non-operating income Interest expenses 3";

const build = new Function("refPages", "targetText", `
  const referenceList = [{ id: "r1", fileName: "ref.pdf", doc: {}, totalPages: refPages.length }];
  const pdfDoc = {};
  const targetPages = [1];
  const activeImportAllowedPages = new Set([1]);
  const count = (hay, needle) => needle ? hay.split(needle).length - 1 : 0;
  const locateQuoteHighlightBoxes = async (pageNo, quote, source = null) => {
    const hay = normalizeHighlightLocatorText(source ? refPages[pageNo - 1] : targetText);
    const matchCount = count(hay, normalizeHighlightLocatorText(quote));
    if (!matchCount) throw new Error("not found");
    return { matchCount, crossesLineBoundary: false, crossesBlockBoundary: false, blockRole: "table" };
  };
  const extractTextLayerText = async () => targetText;
  const isOverreachingLocalEditSuggestion = () => false;
  const requiresReferenceEvidence = finding => Boolean(String(finding.referenceQuote || "").trim());
  const hasClaimedMissingStructureNumber = () => false;
  const isContradictedMissingStructureFinding = () => false;
  const markNoOpSuggestionFindings = () => 0;
  ${extractFunction("normalizeHighlightLocatorText")}
  ${extractFunction("annotateReferenceQuoteLayout")}
  ${extractFunction("validateFindingQuoteEvidence")}
  return async findings => {
    await annotateReferenceQuoteLayout(findings);
    await validateFindingQuoteEvidence(findings);
    return findings;
  };
`);
const run = build(refPages, targetText);
const finding = (referenceQuote, referencePages = [2]) => ({
  page: 1,
  quote: "Non-operating income Interest expenses",
  suggestion: "Non-operating expenses Interest expenses",
  category: "mistranslation",
  issueScope: "translation_consistency",
  reason: "REFでは営業外費用の区分見出し。",
  referenceFile: "ref.pdf",
  referenceQuote,
  referencePages,
});

{
  const [f] = await run([finding("営業外費用")]);
  check("宣言ページ内で一意な短いREF引用（営業外費用）は照合成功", f.referenceQuoteVerified === true);
  check("短いREF引用の翻訳指摘を reference-quote-not-found で除外しない", !f.excludedReason);
  check("短いREF引用でも「短すぎる」警告を付けない", !/短すぎる/.test(f.referenceQuoteLayoutWarning || ""));
}
{
  const [f] = await run([finding("営業外費用", [])]);
  check("宣言ページが無くても全ページで一意なら照合成功", f.referenceQuoteVerified === true && !f.excludedReason);
}
{
  const [f] = await run([finding("売上高", [3])]);
  check("複数ページに出る短い引用も宣言ページ内で一意なら照合成功", f.referenceQuoteVerified === true && !f.excludedReason);
}
{
  const [f] = await run([finding("売上高", [])]);
  check("宣言ページが無く複数ページに出る短い引用は照合失敗", f.referenceQuoteVerified === false && f.excludedReason === "reference-quote-not-found");
}
{
  const [f] = await run([finding("特別損失")]);
  check("REFに無い短い引用は照合失敗", f.referenceQuoteVerified === false);
  check("REFに無い短い引用の翻訳指摘は従来どおり除外", f.excludedReason === "reference-quote-not-found");
}
{
  const [f] = await run([finding("△")]);
  check("記号だけの引用は照合失敗・除外", f.referenceQuoteVerified === false && f.excludedReason === "reference-quote-not-found");
}
{
  const [f] = await run([{ ...finding(""), referenceQuoteVariants: [] }]);
  check("空のREF引用は照合失敗", f.referenceQuoteVerified === false);
}

if (failures.length) {
  console.error(`\nTest-Issue163Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue163Regression: PASS");
