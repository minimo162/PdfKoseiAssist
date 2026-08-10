import { assessFindingEvidence, chooseSourceBackedFragment, hasClaimedMissingStructureNumber, isContradictedMissingStructureFinding, mapFindingPage } from "../js/finding-quality.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const t = (name, condition) => { if (condition) console.log(`  ok   ${name}`); else { failures++; console.error(`  FAIL ${name}`); } };

const allowed = new Set([7, 8, 9]);
t("対象ページの絶対番号を保持", mapFindingPage(8, allowed, 200) === 8);
t("小数ページを丸めず拒否", mapFindingPage(7.4, allowed, 200) === null);
t("packet相対番号を対象ページへ偽装しない", mapFindingPage(2, allowed, 200) === null);
t("欠損・0・NaN・範囲外を拒否", [null, 0, "N/A", 999].every(value => mapFindingPage(value, allowed, 200) === null));

t("reading confidence 0.74を除外", assessFindingEvidence({ readingConfidence: 0.74, evidenceQuality: "clear" }).excludedReason === "low-reading-confidence");
t("reading confidence 0.75を許可", assessFindingEvidence({ readingConfidence: 0.75, evidenceQuality: "clear" }).excludedReason === "");
t("unclearを除外", assessFindingEvidence({ readingConfidence: 1, evidenceQuality: "unclear" }).excludedReason === "low-evidence");
t("範囲外・NaNを除外", [-1, 1.01, NaN].every(value => assessFindingEvidence({ readingConfidence: value, evidenceQuality: "clear" }).excludedReason === "invalid-confidence"));
t("文字列0.8を正規化", assessFindingEvidence({ readingConfidence: "0.8", evidenceQuality: "clear" }).readingConfidence === 0.8);
t("欠損は互換のため通常表示しつつ要確認", (() => { const r=assessFindingEvidence({}); return !r.excludedReason && r.needsHumanReview; })());
t("overall confidenceだけ欠損でも要確認", assessFindingEvidence({ readingConfidence: 0.9, evidenceQuality: "clear" }).needsHumanReview);
t("自動取込は欠損evidenceを除外", assessFindingEvidence({ readingConfidence: 0.9, evidenceQuality: "clear", requireComplete: true }).excludedReason === "missing-evidence");

const duplicatedLabelSource = `Total non-current liabilities 940,927 869,273
Total non-current liabilities 1,924,950 1,937,617`;
t("復元済み数値候補をワイルドカードより優先", chooseSourceBackedFragment(
  "Total non-current liabilities ⟦#AAA⟧ ⟦#BBB⟧",
  ["Total non-current liabilities 1,924,950 1,937,617"],
  duplicatedLabelSource
) === "Total non-current liabilities 1,924,950 1,937,617");
t("復元候補なしで複数行に当たるmasked quoteはfail-closed", chooseSourceBackedFragment(
  "Total non-current liabilities ⟦#AAA⟧ ⟦#BBB⟧", [], duplicatedLabelSource
) === "");
t("一意のmasked quoteだけは本文から復元", chooseSourceBackedFragment(
  "Net assets ⟦#AAA⟧", [], "Net assets 19,179"
) === "net assets 19,179");
t("15と15.0の候補が同じ位置に重なるときは長い本文一致を選ぶ", chooseSourceBackedFragment(
  "Rate ⟦#AAA⟧", ["Rate 15", "Rate 15.0"], "Rate 15.0"
) === "Rate 15.0");

const missingOne = {
  issueSummary: "追加情報の項番が1を欠き、2と3から始まっている",
  reason: "項番1が見当たらない",
  quote: "- Overview of the Subordinated Loan",
};
t("同じ見出し本文の項番1が実在すれば欠番指摘を反証", isContradictedMissingStructureFinding(
  missingOne, "Additional Information\n1. Overview of the Subordinated Loan\n2. Details"
));
t("別見出しの項番1だけでは欠番指摘を反証しない", !isContradictedMissingStructureFinding(
  missingOne, "1. Overview of Consolidated Results\n2. Details of Early Repayment"
));
t("実際に項番1が無い場合は指摘を残す", !isContradictedMissingStructureFinding(
  missingOne, "2. Details of Early Repayment\n3. Impact on Financial Results"
));
const mazdaMissingOne = {
  issueSummary: "追加情報の項番が1を欠き、2から開始している",
  reason: "P.12では先行項目が「- Overview of the Subordinated Loan」と無番号で記載されている",
  quote: "2. Details of Early Repayment of Existing Subordinated Loan",
};
t("Mazda実測: reason中の見出し本文を使い別ページの項番1で反証", isContradictedMissingStructureFinding(
  mazdaMissingOne,
  "1. Overview of the Subordinated Loan\n2. Details of Early Repayment of Existing Subordinated Loan"
));
t("欠番主張を事前に判別できる", hasClaimedMissingStructureNumber(mazdaMissingOne));

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}
const requiresReferenceEvidence = new Function(`${extractFunction("requiresReferenceEvidence")}; return requiresReferenceEvidence;`)();
const references = [
  { id:"r1", fileName:"ref-a.pdf", totalPages:3, doc:{} },
  { id:"r2", fileName:"ref-b.pdf", totalPages:2, doc:{} },
];
const refHits = new Map([
  ["reference:r1|verified reference quote|2", 1],
  ["reference:r1|duplicate reference quote|1", 1],
  ["reference:r1|duplicate reference quote|2", 1],
]);
const locateMock = async (page, quote, source) => ({
  matchCount: refHits.get(`${source?.key || "target"}|${String(quote).toLowerCase()}|${page}`) || (source ? 0 : 1),
});
const normalizeLocator = value => String(value || "").trim().toLowerCase();
const asyncSource = name => extractFunction(name).replace(/^function\s+/, "async function ");
const annotateReferenceQuoteLayout = new Function("referenceList", "normalizeHighlightLocatorText", "locateQuoteHighlightBoxes",
  `${asyncSource("annotateReferenceQuoteLayout")}; return annotateReferenceQuoteLayout;`)(references, normalizeLocator, locateMock);
const validateFindingQuoteEvidence = new Function(
  "extractTextLayerText", "pdfDoc", "activeImportAllowedPages", "targetPages", "locateQuoteHighlightBoxes",
  "requiresReferenceEvidence", "hasClaimedMissingStructureNumber", "isContradictedMissingStructureFinding",
  `${asyncSource("validateFindingQuoteEvidence")}; return validateFindingQuoteEvidence;`
)(async () => "target source text", {}, new Set([1]), [1], locateMock,
  requiresReferenceEvidence, () => false, () => false);

const importEvidenceCases = [
  { name:"verified", finding:{ page:1, quote:"valid target quote", category:"mistranslation",
      referenceQuote:"verified reference quote", referenceFile:"ref-a.pdf", referencePages:[2] }, accepted:true },
  { name:"missing quote", finding:{ page:1, quote:"valid target quote", category:"mistranslation",
      referenceQuote:"", referenceFile:"ref-a.pdf", referencePages:[2] }, accepted:false },
  { name:"unknown file", finding:{ page:1, quote:"valid target quote", category:"mistranslation",
      referenceQuote:"verified reference quote", referenceFile:"unknown.pdf", referencePages:[2] }, accepted:false },
  { name:"empty page is uniquely corrected", finding:{ page:1, quote:"valid target quote", category:"mistranslation",
      referenceQuote:"verified reference quote", referenceFile:"ref-a.pdf", referencePages:[] }, accepted:true, corrected:2 },
  { name:"multiple-page match", finding:{ page:1, quote:"valid target quote", category:"mistranslation",
      referenceQuote:"duplicate reference quote", referenceFile:"ref-a.pdf", referencePages:[] }, accepted:false },
];
for (const testCase of importEvidenceCases) {
  const finding = structuredClone(testCase.finding);
  await annotateReferenceQuoteLayout([finding]);
  await validateFindingQuoteEvidence([finding]);
  t(`REF引用の取込採否: ${testCase.name}`,
    testCase.accepted ? !finding.excludedReason : finding.excludedReason === "reference-quote-not-found");
  if (testCase.corrected) t("REFページ空欄を一意一致ページへ補正", finding.referencePage === testCase.corrected);
}
t("自動回答にpacket_idを渡して対象ページを限定", /applyAutoAnswer\(ans, rp\.packet_id\)/.test(html) && /activeImportAllowedPages = new Set/.test(html));
t("自動packetのread_errorはpacket先頭ページへ置く", /const fallbackPage = activeImportAllowedPages \? \[\.\.\.activeImportAllowedPages\]/.test(html));
t("ページ補正も対象ページ内だけを探索", /const pagesToSearch = activeImportAllowedPages[\s\S]{0,180}for \(const pageNo of pagesToSearch\)/.test(html));
t("取込時にTARGET quoteを検証", /await validateFindingQuoteEvidence\(incoming\)/.test(html) && /quote-not-found/.test(html));
t("翻訳指摘はREF quoteを一意照合し、必要ならページ補正", /const declaredPages = \(finding\.referencePages \|\| \[\]\)/.test(html) && /referencePageCorrectionNote/.test(html) && /reference-quote-not-found/.test(html));
t("未知のreference_fileを先頭資料へfallbackしない", /if \(!ref\) \{[\s\S]{0,180}指定された比較資料を特定できません/.test(html));
t("TARGET単体の英文欠語はREF quoteを要求しない", !requiresReferenceEvidence({
  category: "omission", issueScope: "english_proofreading", reason: "英文で冠詞が欠落している",
}));
t("REFを根拠にしたomissionはcategory偽装でもREF quote必須", requiresReferenceEvidence({
  category: "omission", issueScope: "english_proofreading", reason: "REFの日本語原文には記載があるが訳文にない",
}));
t("reference情報を1項目でも主張した候補はREF quote必須", requiresReferenceEvidence({
  category: "omission", referenceFile: "source.pdf",
}));
t("REFなしtranslationとmistranslationはfail-closed", /\["translation_consistency", "mistranslation"\]/.test(html) && /if \(translationFinding && !finding\.referenceQuoteVerified\)/.test(html));
t("緩いquoteの複数一致を拒否", (html.match(/profile\.loose\s*&&\s*hits\.length\s*>\s*1/g) || []).length >= 2);
t("ハイフン誤認も監査可能な除外候補として保存", /f\.excludedReason = "line-end-hyphen"/.test(html) && !/coerced\.filter\(f => !isLikelyLineEndHyphenFalsePositive/.test(html));
t("補助PDFは除外候補表示チェックに依存しない", /const numbered = findings\.filter\(f => !f\.excludedReason\)/.test(html));
t("除外理由を日本語表示", /const EXCLUDED_REASON_LABELS/.test(html) && /除外理由:.*excludedReasonLabel/.test(html));
t("欠番主張はpacket全TARGETページの本文で反証", /hasClaimedMissingStructureNumber\(finding\)[\s\S]{0,100}await getStructureCorpus\(\)/.test(html) && /structure-claim-contradicted/.test(html));
t("structure promptは欠番報告前の再検索を要求", (html.match(/欠番を報告する直前に/g) || []).length >= 2);

console.log(`\nTest-FindingQuality: ${failures ? `FAIL (${failures})` : "PASS"}`);
process.exit(failures ? 1 : 0);
