// Regression coverage for issue #151: import filters must not move genuine
// findings to the excluded side.
//
//   node tools/Test-Issue151Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNoOpSuggestionFinding } from "../js/finding-quality.mjs";
import { scopeOrCategoryRequiresReferenceEvidence } from "../js/auto-import-evidence.mjs";
import { normalizeQuote } from "../js/review-merge.mjs";
import { reconstructTextContentDetailed } from "../js/pdf-text-reconstruct.mjs";

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
const constLine = name => {
  const match = indexHtml.match(new RegExp(`const ${name} = .*;`));
  if (!match) throw new Error(`${name} not found`);
  return match[0];
};

const failures = [];
const check = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}`); failures.push(name); }
};

// --- 1. no-op: review instructions quote text that is already in the quote ---
check("「値」のどちらが正しいか確認する指示はno-opにしない", !isNoOpSuggestionFinding({
  quote: "Total current assets 3,860",
  suggestion: "「3,860」と内訳合計のどちらが正しいか確認してください。",
}));
check("伏字のまま判定される確認指示もno-opにしない", !isNoOpSuggestionFinding({
  quote: "Total current assets ⟦#ABC⟧",
  suggestion: "「⟦#ABC⟧」と内訳合計（⟦#DEF⟧）のどちらが正しいか確認してください。",
}));
check("見直し指示はno-opにしない", !isNoOpSuggestionFinding({
  quote: "Net sales increased 5.2%",
  suggestion: "「increased」の訳を原文に合わせて見直してください。",
}));
check("原文にあるAを別のBへ統一する指示はno-opにしない", !isNoOpSuggestionFinding({
  quote: "Revenue rose, while Net sales in Q2 fell",
  suggestion: "「Revenue」を「Net sales」に統一してください。",
}));
check("入れ替え指示はno-opにしない", !isNoOpSuggestionFinding({
  quote: "Q1 results were weaker than Q2 results",
  suggestion: "「Q1」を「Q2」に、「Q2」を「Q1」に修正してください。",
}));
check("四半期表記だけが違う統一指示は従来どおりno-op", isNoOpSuggestionFinding({
  quote: "第1四半期の売上",
  suggestion: "「第1四半期」を「Q1」に統一してください",
}));
check("既にある語へ直す指示は従来どおりno-op", isNoOpSuggestionFinding({
  quote: "Net sales for Q1 were",
  suggestion: "「Q1」に修正してください。",
}));

// --- 2/3. REF claim wording and model-declared "consistency" scope ---
const requiresReferenceEvidence = new Function("scopeOrCategoryRequiresReferenceEvidence", `
  let autoImportingPacketId = "";
  const lastAutoPayloadByPacket = new Map();
  ${constLine("EXPLICIT_REFERENCE_CLAIM_RE")}
  ${constLine("AMBIGUOUS_REFERENCE_CLAIM_RE")}
  ${constLine("ENGLISH_INTERNAL_CATEGORIES")}
  const TARGET_ONLY_REFERENCE_CATEGORIES = new Set(["typo", "grammar", "terminology", "formatting", "note_mismatch", "prose_inconsistency", "omission", "number_mismatch", "name_mismatch", "date_mismatch"]);
  ${extractFunction("hasExplicitReferenceClaim")}
  ${extractFunction("isTargetOnlyFindingWithoutReferenceClaim")}
  ${extractFunction("requiresReferenceEvidence")};
  return requiresReferenceEvidence;
`)(scopeOrCategoryRequiresReferenceEvidence);
const typo = { category: "typo", issueScope: "english_proofreading", quote: "will recieve the dividend", suggestion: "will receive the dividend" };
for (const [label, extra] of [
  ["原文には", { reason: "原文には「recieve」とあるが、正しい綴りは「receive」。" }],
  ["訳文", { reason: "訳文中の「recieve」は綴り誤り。" }],
  ["翻訳", { issueSummary: "翻訳文のスペルミス", reason: "「recieve」は「receive」の誤り。" }],
]) {
  check(`英文単体の誤字は理由の「${label}」だけでREF引用必須にしない`, !requiresReferenceEvidence({ ...typo, ...extra }));
}
check("REF・日本語原文を明示した訳抜けは従来どおりREF引用必須", requiresReferenceEvidence({
  category: "omission", issueScope: "english_proofreading", reason: "REFの日本語原文には記載があるが訳文にない",
}));
check("誤訳カテゴリで「原文には」と書いた指摘は従来どおりREF引用必須", requiresReferenceEvidence({
  category: "mistranslation", issueScope: "translation_consistency", reason: "原文には減少とある。",
}));
check("coerceFindingsはモデルが返した元のissue_scopeを残す",
  /modelIssueScope: issueScopeRaw,/.test(indexHtml));
check("モデルが consistency と申告した文書内整合はREF証拠を要求しない",
  !scopeOrCategoryRequiresReferenceEvidence({ issueScope: "translation_consistency", modelIssueScope: "consistency", category: "number_mismatch" }));
check("consistency 申告でも誤訳・翻訳整合カテゴリはREF証拠を要求する",
  scopeOrCategoryRequiresReferenceEvidence({ issueScope: "translation_consistency", modelIssueScope: "consistency", category: "mistranslation" })
  && scopeOrCategoryRequiresReferenceEvidence({ issueScope: "translation_consistency", modelIssueScope: "consistency", category: "translation_consistency" }));
check("モデルが translation_consistency と申告した指摘は従来どおりREF証拠を要求する",
  scopeOrCategoryRequiresReferenceEvidence({ issueScope: "translation_consistency", modelIssueScope: "translation_consistency", category: "number_mismatch" }));

// --- 4. hyphen filters must not hide digit, sign and decimal errors ---
const { isLineEndHyphen, isHyphenSpaceOnly } = new Function(`
  ${extractFunction("normalizeHyphenationComparisonText")}
  ${extractFunction("citedFormsInReason")}
  ${extractFunction("isHyphenSpaceOnlyVariantClaim")}
  ${extractFunction("isLikelyLineEndHyphenFalsePositive")}
  return { isLineEndHyphen: isLikelyLineEndHyphenFalsePositive, isHyphenSpaceOnly: isHyphenSpaceOnlyVariantClaim };
`)();
for (const [label, quote, suggestion, reason] of [
  ["小数点", "Consolidated net sales increased 125% year on year.", "Consolidated net sales increased 12.5% year on year.", "連結売上高は前年同期比12.5%増であり、125%は誤りです。"],
  ["括弧負数", "Profit attributable to owners of parent 1,234", "Profit attributable to owners of parent (1,234)", "連結損益計算書では△1,234（損失）です。"],
  ["マイナス", "Operating margin was −5.2%.", "Operating margin was 5.2%.", "連結営業利益率は5.2%（プラス）です。"],
]) {
  check(`理由に「連結」があっても${label}の誤りを行末ハイフン扱いにしない`,
    !isLineEndHyphen({ category: "number_mismatch", quote, suggestion, reason }));
}
check("行末ハイフンの連結誤認は従来どおり除外", isLineEndHyphen({
  category: "typo", quote: "North Rhine-\nWestphalia", suggestion: "North RhineWestphalia", reason: "行末ハイフンで連結され、ハイフン抜けに見える",
}));
check("桁の欠落をハイフン・空白の揺れにしない", !isHyphenSpaceOnly({
  reason: "連結貸借対照表では「234,567」だが本文では「1,234,567」とハイフン・空白が揺れている。",
}));
check("non-current と current をハイフン・空白の揺れにしない", !isHyphenSpaceOnly({
  reason: "P.3では「non-current assets」、P.8では「current assets」とハイフンの有無が揺れている。",
}));
check("括弧負数と正数をハイフン・空白の揺れにしない", !isHyphenSpaceOnly({
  reason: "P.3では「(1,234)」、P.8では「1,234」と空白が揺れている。",
}));
check("空白区切りの接頭語だけの揺れは従来どおり除外（Mazda EZ‑60 ⇔ EZ 60）", isHyphenSpaceOnly({
  reason: "P.4では「Mazda EZ‑60」、P.5では「EZ 60」と表記され、ハイフンの有無が揺れている。",
}));
check("会計用語の「連結」だけではハイフン・空白の話とみなさない", !isHyphenSpaceOnly({
  reason: "連結子会社の「CX 5」と「CX‑5」の台数が一致しない。",
}));

// --- 5. dedupe must not lose an alternative on a later import ---
const dedupeFindings = new Function("normalizeQuote",
  `${extractFunction("dedupeFindings")}; return dedupeFindings;`)(normalizeQuote);
{
  const mk = (id, quote, suggestion, issueSummary, confidence) => ({
    id, page: 5, category: "number_mismatch", quote, suggestion, issueSummary,
    reason: `${issueSummary}（根拠）`, displayReason: `${issueSummary}（根拠）`, confidence, excludedReason: "",
  });
  const sentence = "Net sales were 1,234 million yen and operating income rose 5.2% due to cost reductions.";
  let findings = [];
  const importRound = incoming => {
    findings = dedupeFindings([...findings, ...incoming]).sort((a, b) => a.page - b.page || a.id.localeCompare(b.id));
  };
  importRound([
    mk("F0001", "Net sales were 1,234 million yen", "Net sales were 1,243 million yen", "売上高が原文1,243と不一致", 0.80),
    mk("F0002", "operating income rose 5.2% due to cost reductions", "operating income rose 2.5% due to cost reductions", "営業利益増加率が原文2.5%と不一致", 0.95),
    mk("F0003", sentence, `${sentence.slice(0, -1)} and higher volume.`, "要因の訳抜け", 0.90),
  ]);
  importRound([{ id: "F0009", page: 40, category: "typo", quote: "unrelated finding elsewhere", suggestion: "x", reason: "", confidence: 0.9 }]);
  importRound([]);
  check("後続の取込でも別案として束ねた指摘が状態から消えない", JSON.stringify(findings).includes("Net sales were 1,243 million yen"));
}

// --- 6. half-width voiced kana / combining marks must match a verbatim quote ---
{
  const pdfjsLib = { Util: { transform(m1, m2) {
    return [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];
  } } };
  const makeDoc = lines => ({
    async getPage() {
      return {
        getViewport: () => ({ width: 595, height: 842, rotation: 0, transform: [1, 0, 0, -1, 0, 842] }),
        getTextContent: async () => ({
          items: lines.map((str, i) => ({ str, dir: "ltr", width: Array.from(str).length * 5, height: 10,
            transform: [10, 0, 0, 10, 72, 700 - i * 14], fontName: "F1", hasEOL: false })),
          styles: { F1: { vertical: false } },
        }),
      };
    },
  });
  const { layoutIndex, textLayerIndex, normalize } = new Function("pdfjsLib", "reconstructPdfTextContentDetailed", `
    let pdfDoc = null;
    const reportTextLayerCache = new Map();
    ${constLine("REPORT_TEXT_CACHE_LIMIT")}
    const reportDocumentCacheKey = (doc, source) => String(source?.key || "target");
    ${extractFunction("reportCacheGet")}
    ${extractFunction("reportCacheSet")}
    ${extractFunction("textItemBoxForViewport")}
    ${extractFunction("normalizeHighlightLocatorText")}
    ${extractFunction("getReportLayoutTextIndex")}
    ${extractFunction("getReportTextLayerIndex")}
    return { layoutIndex: getReportLayoutTextIndex, textLayerIndex: getReportTextLayerIndex, normalize: normalizeHighlightLocatorText };
  `)(pdfjsLib, reconstructTextContentDetailed);
  const profile = { key: "strict", normalize };
  const line = "当社ｸﾞﾙｰﾌﾟのｾｸﾞﾒﾝﾄ別売上高は前年同期比で増加しました。";
  const accented = "The arranger was Société Générale.";
  const needleJa = normalize(line), needleAccent = normalize(accented);
  const layoutJa = await layoutIndex(1, profile, { doc: makeDoc([line]), key: "ja-layout" });
  const layerJa = await textLayerIndex(1, profile, { doc: makeDoc([line]), key: "ja-layer" });
  const layoutAccent = await layoutIndex(1, profile, { doc: makeDoc([accented]), key: "en-layout" });
  check("半角カナの濁点を含む引用がレイアウト索引で一致する", layoutJa.normalized.includes(needleJa));
  check("半角カナの濁点を含む引用がテキスト層索引で一致する", layerJa.normalized.includes(needleJa));
  check("合成用アクセントを含む引用が一致する", layoutAccent.normalized.includes(needleAccent));
  check("索引の文字数と位置情報の数が一致する", layoutJa.normalized.length === layoutJa.charBoxes.length
    && layerJa.normalized.length === layerJa.charBoxes.length);
}

if (failures.length) {
  console.error(`\nTest-Issue151Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue151Regression: PASS");
