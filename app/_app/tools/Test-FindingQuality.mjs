import { assessFindingEvidence, chooseSourceBackedFragment, chooseUniqueBlockFragment as chooseUniqueBlockFragmentPure, hasClaimedMissingStructureNumber, isContradictedMissingStructureFinding, mapFindingPage, mapReturnedPageWithPacketMap } from "../js/finding-quality.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { REPORT2_LAYOUT_FIXTURES, normalizeReport2Locator } from "./report2-layout-fixture.mjs";

let failures = 0;
const t = (name, condition) => { if (condition) console.log(`  ok   ${name}`); else { failures++; console.error(`  FAIL ${name}`); } };
const chooseUniqueBlockFragment = (normalized, blockRanges, needle, options = {}) =>
  chooseUniqueBlockFragmentPure(normalized, blockRanges, needle, { ...options, locationAidOnly: true });
t("cross-block fragment helperはlocationAidOnly指定なしでfail closed", chooseUniqueBlockFragmentPure(
  "revenue\u0000999999consolidated",
  [{ start: 0, end: 7 }, { start: 8, end: 25 }],
  "revenue999999consolidated",
) === null);

const allowed = new Set([7, 8, 9]);
t("対象ページの絶対番号を保持", mapFindingPage(8, allowed, 200) === 8);
t("小数ページを丸めず拒否", mapFindingPage(7.4, allowed, 200) === null);
t("packet相対番号を対象ページへ偽装しない", mapFindingPage(2, allowed, 200) === null);
t("欠損・0・NaN・範囲外を拒否", [null, 0, "N/A", 999].every(value => mapFindingPage(value, allowed, 200) === null));

const packetMap = [
  { outputPage: 1, role: "FRONT_MATTER", sourceKind: "packet", sourcePage: null },
  { outputPage: 2, role: "FRONT_MATTER", sourceKind: "packet", sourcePage: null },
  { outputPage: 14, role: "TARGET_CONTEXT", sourceKind: "target", sourcePage: 12 },
  { outputPage: 15, role: "TARGET_CHECK", sourceKind: "target", sourcePage: 13 },
  { outputPage: 16, role: "TARGET_CHECK", sourceKind: "target", sourcePage: 14 },
  { outputPage: 17, role: "REF1_CANDIDATE", sourceKind: "reference:ref1", sourcePage: 1 },
];
t("確認用PDF P.15をTARGET_CHECK元P.13へ補正", (() => {
  const r = mapReturnedPageWithPacketMap(15, new Set([13, 14]), 27, packetMap);
  return r.page === 13 && r.mappedFrom === 15 && r.role === "TARGET_CHECK";
})());
t("有効な対象元ページはpacket mapより直値を優先", mapReturnedPageWithPacketMap(
  14, new Set([13, 14]), 27, packetMap).page === 14
);
t("TARGET_CONTEXT/REF_CANDIDATEへは補正しない", (() => {
  const context = mapReturnedPageWithPacketMap(14, new Set([13]), 27, packetMap);
  const reference = mapReturnedPageWithPacketMap(17, new Set([13]), 27, packetMap);
  const frontMatter = mapReturnedPageWithPacketMap(2, new Set([13]), 27, packetMap);
  return context.page === null && context.nonActionable === true
    && reference.page === null && reference.nonActionable === true
    && frontMatter.page === null && frontMatter.nonActionable === true;
})());
t("known non-TARGET packet page is fail-closed even when quote exists on TARGET", (() => {
  const context = mapReturnedPageWithPacketMap(14, new Set([13]), 27, packetMap);
  const reference = mapReturnedPageWithPacketMap(17, new Set([13]), 27, packetMap);
  const frontMatter = mapReturnedPageWithPacketMap(1, new Set([13]), 27, packetMap);
  return [context, reference, frontMatter].every(result => result.page === null && result.nonActionable);
})());
t("allowed source page wins an output-page role collision", (() => {
  const collision = mapReturnedPageWithPacketMap(14, new Set([14]), 27, packetMap);
  return collision.page === 14 && collision.mappedFrom === null && !collision.nonActionable;
})());
t("unknown packet page remains a quote-resolver candidate", (() => {
  const unknown = mapReturnedPageWithPacketMap(27, new Set([13]), 27, packetMap);
  return unknown.page === 27 && unknown.source === "raw-candidate" && !unknown.nonActionable;
})());

const makeCharBoxes = (source, ranges, lineYs, { height = 10 } = {}) => {
  const boxes = Array.from({ length: String(source || "").length }, () => null);
  for (const [index, range] of ranges.entries()) {
    const y = Number(lineYs[index]);
    for (let offset = range.start; offset < range.end; offset++) {
      boxes[offset] = { x: (offset - range.start) * 6, y, w: 6, h: height };
    }
  }
  return boxes;
};

const crossBlockQuote = "BalanceatMarch31,143,459137,45066,601,924,9502026";
const crossBlockSource = `headingBalanceatMarch31,143,459\u0000targetvalues137,45066,601,924,9502026`;
const crossBlockSeparator = crossBlockSource.indexOf("\u0000");
const crossBlockRanges = [
  { start: 0, end: crossBlockSeparator },
  { start: crossBlockSeparator + 1, end: crossBlockSource.length },
];
const crossBlockAnchor = chooseUniqueBlockFragment(crossBlockSource, crossBlockRanges, crossBlockQuote, {
  charBoxes: makeCharBoxes(crossBlockSource, crossBlockRanges, [100, 100]),
});
t("blockをまたぐF0017型quoteから十分長い一意anchorを選ぶ", Boolean(crossBlockAnchor)
  && crossBlockAnchor.length >= 16
  && crossBlockSource.slice(crossBlockAnchor.start, crossBlockAnchor.start + crossBlockAnchor.length) === crossBlockAnchor.fragment);
t("geometryなしの独立label/numeric blockはfail closed", chooseUniqueBlockFragment(
  "revenue\u0000headcount999999consolidated",
  (() => { const source = "revenue\u0000headcount999999consolidated"; const separator = source.indexOf("\u0000"); return [{ start: 0, end: separator }, { start: separator + 1, end: source.length }]; })(),
  "revenue999999consolidated",
  { minLength: 16 },
) === null);
t("隣接別行の同scope・同数値はgeometryでfail closed", (() => {
  const source = "revenue\u0000headcount999999consolidated";
  const ranges = [{ start: 0, end: 7 }, { start: 8, end: source.length }];
  return chooseUniqueBlockFragment(source, ranges, "revenue999999consolidated", {
    minLength: 16,
    charBoxes: makeCharBoxes(source, ranges, [100, 120]),
  }) === null;
})());
t("欠損/異常charBoxesはpartial anchorをfail closed", (() => {
  const source = "revenue\u0000999999999999";
  const ranges = [{ start: 0, end: 7 }, { start: 8, end: source.length }];
  const boxes = makeCharBoxes(source, ranges, [100, 100]);
  boxes[9] = null;
  return chooseUniqueBlockFragment(source, ranges, "revenue999999999999", {
    minLength: 16,
    charBoxes: boxes,
  }) === null;
})());
t("短いanchorはfail closed", chooseUniqueBlockFragment("abcabc\u0000abcabc", [
  { start: 0, end: 6 }, { start: 7, end: 13 },
], "abcabc", { minLength: 16 }) === null);
t("曖昧なanchorはfail closed", chooseUniqueBlockFragment("sharedcontext\u0000sharedcontext", [
  { start: 0, end: 13 }, { start: 14, end: 27 },
], "sharedcontext-plus-values", { minLength: 12 }) === null);
t("定型文だけのanchorは数値quoteの意味を満たさずfail closed", chooseUniqueBlockFragment(
  "longboilerplateexpectedmetricheadcount42\u0000longboilerplateexpectedmetricheadcount42",
  [{ start: 0, end: 38 }, { start: 39, end: 78 }],
  "longboilerplateexpectedmetricrevenue999999",
  { minLength: 16 },
) === null);
t("同じ単一数値でも別指標のanchorはfail closed", chooseUniqueBlockFragment(
  "longboilerplateexpectedmetricheadcount999999",
  [{ start: 0, end: 45 }],
  "longboilerplateexpectedmetricrevenue999999",
  { minLength: 16 },
) === null);
t("scope語だけでは主要labelの代わりにならない", [
  ["headcount999999consolidated", "revenue999999consolidated"],
  ["headcount999999forecast", "revenue999999forecast"],
  ["operatingincome999999fy2026", "netsales999999fy2026"],
].every(([source, quote]) => chooseUniqueBlockFragment(source, [{ start: 0, end: source.length }], quote, { minLength: 16 }) === null));
t("同一measureでもquoteのscope語が本文に無ければfail closed", chooseUniqueBlockFragment(
  "revenue999999forecast",
  [{ start: 0, end: 21 }],
  "revenue999999consolidated",
  { minLength: 16 },
) === null);
t("labelが重複するnumeric rowはfail closed", chooseUniqueBlockFragment(
  "revenue999999\u0000revenue888888",
  [{ start: 0, end: 13 }, { start: 14, end: 27 }],
  "revenue999999more",
  { minLength: 16 },
) === null);
t("labelとnumericが遠いblockならfail closed", chooseUniqueBlockFragment(
  "revenue\u0000x\u0000x\u0000x\u0000999999",
  [{ start: 0, end: 7 }, { start: 8, end: 9 }, { start: 10, end: 11 }, { start: 12, end: 13 }, { start: 14, end: 20 }],
  "revenue999999",
  { minLength: 16 },
) === null);
t("数値を含む短い一意table fragmentは許可", Boolean(chooseUniqueBlockFragment(
  "revenue423000\u0000headcount42",
  [{ start: 0, end: 13 }, { start: 14, end: 25 }],
  "revenue423000andmore",
  { minLength: 16 },
)));

const perfSource = Array.from({ length: 80 }, (_, index) => `block${index} ` + "x".repeat(590)).join("\u0000");
const perfRanges = [];
let perfOffset = 0;
for (let index = 0; index < 80; index++) {
  const end = perfOffset + 596;
  perfRanges.push({ start: perfOffset, end });
  perfOffset = end + 1;
}
const perfStarted = performance.now();
const perfResult = chooseUniqueBlockFragment(perfSource, perfRanges, "missingmetric999999".repeat(8), { minLength: 16 });
const perfElapsed = performance.now() - perfStarted;
t(`600字×80block no-matchは候補budget内で高速（${perfElapsed.toFixed(2)}ms）`, perfResult === null && perfElapsed < 50);

for (const fixture of REPORT2_LAYOUT_FIXTURES) {
  let source = "";
  const ranges = [];
  for (const block of fixture.blocks) {
    if (source) source += "\u0000";
    const start = source.length;
    source += normalizeReport2Locator(block);
    ranges.push({ start, end: source.length });
  }
  const quote = normalizeReport2Locator(fixture.quote);
  const anchor = chooseUniqueBlockFragment(source, ranges, quote, {
    minLength: 16,
    charBoxes: makeCharBoxes(source, ranges, fixture.blockLineY),
  });
  const mapped = mapReturnedPageWithPacketMap(fixture.packetPage, new Set([fixture.sourcePage]), 27, [
    { outputPage: fixture.packetPage, role: "TARGET_CHECK", sourceKind: "target", sourcePage: fixture.sourcePage },
  ]);
  t(`${fixture.id}:location aid専用helperは全文をblock連結せずanchorを返す`, Boolean(anchor)
    && anchor.length >= 16
    && anchor.tokenKind === "number"
    && anchor.evidence?.numericHit
    && anchor.labelAnchor?.tokenKind === "major-label"
    && anchor.labelAnchor.blockIndex !== anchor.blockIndex
    && !source.includes(quote)
    && source.slice(anchor.start, anchor.start + anchor.length) === anchor.fragment
    && ranges.some(range => anchor.blockStart === range.start)
    && mapped.page === fixture.sourcePage
    && mapped.mappedFrom === fixture.packetPage);
}

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
  const signatureEnd = html.indexOf(")", start);
  let depth = 0;
  for (let i = html.indexOf("{", signatureEnd); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}
const scoreFindingPageCandidate = new Function(`${extractFunction("scoreFindingPageCandidate")}; return scoreFindingPageCandidate;`)();
const chooseFindingPageCorrection = new Function(`${extractFunction("chooseFindingPageCorrection")}; return chooseFindingPageCorrection;`)();
const targetPageHelperStart = html.indexOf("const TARGET_COMPARE_PAGE_LIMIT");
const targetPageHelperEnd = html.indexOf("function updateResultsPresentation", targetPageHelperStart);
const targetPageCandidatesForFinding = new Function("referenceList", "originalFileName", "totalPages",
  `${html.slice(targetPageHelperStart, targetPageHelperEnd)}; return targetPageCandidatesForFinding;`)(
    [{ fileName: "REF1.pdf", totalPages: 30 }], "target.pdf", 40,
  );
const targetPageCandidatesWithoutReference = new Function("referenceList", "originalFileName", "totalPages",
  `${html.slice(targetPageHelperStart, targetPageHelperEnd)}; return targetPageCandidatesForFinding;`)(
    [], "target.pdf", 40,
  );
t("ページ補正の採点は対象packet P.23をclaimed P.25より優先", scoreFindingPageCandidate({
  page: 23, claimedPage: 25, inTargetRange: true, matchStrength: 3, matchLength: 42, preferred: false,
}) > scoreFindingPageCandidate({
  page: 25, claimedPage: 25, inTargetRange: false, matchStrength: 3, matchLength: 42, preferred: true,
}));
t("P.25→P.23の一意候補を採用", chooseFindingPageCorrection([
  { page: 23, score: scoreFindingPageCandidate({ page: 23, claimedPage: 25, inTargetRange: true, matchStrength: 3, matchLength: 42, preferred: false }) },
], 25) === 23);
t("P.22/P.23同点候補は補正しない", chooseFindingPageCorrection([
  { page: 22, score: 100 }, { page: 23, score: 100 },
], 25) === null);
t("本文profile/長さが同点なら距離・reason preferredで補正しない", chooseFindingPageCorrection([
  { page: 23, score: scoreFindingPageCandidate({ page: 23, claimedPage: 25, inTargetRange: true, matchStrength: 3, matchLength: 42, preferred: false }) },
  { page: 25, score: scoreFindingPageCandidate({ page: 25, claimedPage: 25, inTargetRange: true, matchStrength: 3, matchLength: 42, preferred: true }) },
], 25) === null);
t("REFページラベルは対象PDFの比較候補へ混ぜない", (() => {
  const pages = targetPageCandidatesForFinding({ page: 22, reference_pages_label: "REF1 P.25", referencePagesLabel: "P.9" });
  return pages.length === 1 && pages[0] === 22;
})());
t("明示target sourceのreference_pagesだけ対象候補へ追加", (() => {
  const pages = targetPageCandidatesForFinding({ page: 22, reference_pages: [25], reference_pages_source: "target" });
  return pages.includes(22) && pages.includes(25);
})());
t("比較資料未添付でも未明示reference_pagesは対象候補へ追加しない", (() => {
  const pages = targetPageCandidatesWithoutReference({ page: 22, reference_pages: [25] });
  return pages.length === 1 && pages[0] === 22;
})());
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
const productionStrictNormalize = value => normalizeLocator(value).replace(/\s+/g, "");
const productionProfiles = [
  { key: "strict", label: "通常照合", normalize: productionStrictNormalize, loose: false },
  { key: "dashless", label: "ハイフン差吸収", normalize: value => productionStrictNormalize(value).replace(/-/g, ""), loose: true },
  { key: "punct-loose", label: "句読点差吸収", normalize: value => productionStrictNormalize(value).replace(/[!\"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]/g, ""), loose: true },
];
const productionFindMatches = (haystack, needle, limit = 3) => {
  const hits = [];
  let at = String(haystack || "").indexOf(String(needle || ""));
  while (at >= 0 && hits.length < limit) { hits.push(at); at = String(haystack || "").indexOf(String(needle || ""), at + 1); }
  return hits;
};
const productionLocateFactory = (normalized, blockRanges, charBoxes = null) => new Function(
  "quoteRawCandidatesForHighlight", "HIGHLIGHT_MATCH_PROFILES", "isUsefulLooseHighlightNeedle",
  "getReportLayoutTextIndex", "findNormalizedMatches", "pctHighlightBoxes", "mergeHighlightTextBoxes",
  "chooseUniqueBlockFragment",
  // locateQuoteHighlightBoxes は同一block内トークン並べ替えフォールバックを
  // locateReorderedTokensWithinBlock に委譲している。ここで一緒に持ち込まないと
  // production抽出が ReferenceError で全滅し、fail-closedを検査できているように
  // 見えて実は「例外で落ちただけ」になる（実測 2026-08-18）。
  `${extractFunction("locateReorderedTokensWithinBlock")}
   ${extractFunction("locateSplitAnchorWithinBlocks")}
   ${asyncSource("locateQuoteHighlightBoxes")}; return locateQuoteHighlightBoxes;`,
)(
  quote => [String(quote || "")],
  productionProfiles,
  () => true,
  async () => ({
    layout: { version: "layout-v2" },
    normalized,
    charBoxes: charBoxes || Array.from({ length: String(normalized).length }, (_, index) =>
      (normalized[index] === "\u0000" ? null : { x: index, y: 100, w: 1, h: 10 })),
    // ⚠️ blockRangesを空配列のまま返すと、並べ替えフォールバックの
    //    for(const block of index.blockRanges) が一度も回らず、新フォールバックの
    //    中身を一切検査できていないのに「fail closedのテストがPASSした」ように
    //    見えてしまう。既定では正規化済み文字列全体を1つのblockとして与える。
    blockRanges: blockRanges || [{ start: 0, end: String(normalized).length }],
    viewport: { width: 1000, height: 1000 },
  }),
  productionFindMatches,
  boxes => boxes,
  boxes => boxes,
  chooseUniqueBlockFragmentPure,
);
// ⚠️ haystackを正規化せずに渡すと、quoteとhaystackが本当は同一表記でも
//    strict profileの空白除去とズレて絶対に一致しなくなり、「fail closedのテスト」が
//    実際には何も検証していない見かけ倒しになる。ここで productionStrictNormalize を
//    通してから渡す。呼び出し側のテスト文字列に書く半角スペースは「blockの区切り」を
//    表すテスト内DSLで、実際に組み立てるhaystackの区切り文字は本番
//    getReportLayoutTextIndex（index.html）と同じNUL文字（U+0000）にする。
//    実測 2026-08-18: 以前はここを実際の半角スペース文字で継いでいたため、
//    production の normalized には絶対に現れない文字（空白は正規化時に全部
//    落とす設計）を挟んだ状態で「fail closed」を検査していた見かけ倒しだった。
//    productionLocateFactory 側の charBoxes 生成はNUL文字の位置だけ null を積む
//    （本番の charBoxes.push(null) を再現）ので、combined charBoxes を
//    .filter(Boolean) で落とす経路もここで初めて意味のある形で検査される。
//    既定は allowReordered:true —— このヘルパーは主に並べ替えフォールバック込みで
//    「それでも数値の意味が変わる差はfail closedのまま」を確かめるために使う。
const assertProductionQuoteNotLocated = async (haystackText, quote, opts = { allowReordered: true }) => {
  const rawParts = String(haystackText).split(" ");
  const parts = rawParts.map(part => productionStrictNormalize(part));
  const haystack = parts.join("\u0000");
  let cursor = 0;
  const blockRanges = parts.map(part => {
    const range = { start: cursor, end: cursor + part.length };
    cursor += part.length + 1;
    return range;
  });
  try {
    await productionLocateFactory(haystack, blockRanges)(1, quote, null, opts);
    return false;
  } catch (error) {
    return /単一レイアウトblock内/.test(String(error?.message || error));
  }
};
// 健全性チェック: assertProductionQuoteNotLocated の正規化パイプラインが壊れていないこと
// そのものを確かめる。これが無いと、上のfail-closedテスト群は「そもそも一致するはずの
// 表記」でもフォーマットの不一致だけで常にfail-closedになる見かけ倒しの危険がある。
t("健全性チェック: haystackを正規化すれば同一quoteは照合できる", await (async () => {
  const haystack = productionStrictNormalize("Net income 100 million");
  try {
    const located = await productionLocateFactory(haystack)(1, "Net income 100 million");
    return located?.matchProfile === "layout-strict";
  } catch (_) { return false; }
})());
t("左右別表を同じY座標にしてもcross-block quoteはproductionでfail closed", await assertProductionQuoteNotLocated(
  "revenue headcount999999consolidated", "revenue 999999 consolidated"));
t("非数値のcross-block quoteもproductionでfail closed", await assertProductionQuoteNotLocated(
  "BalanceatMarch31 TotalNetAssets1924950", "Balance at March 31 Total Net Assets 1,924,950"));
t("符号差はdashless profileへ逃がさずfail closed", await assertProductionQuoteNotLocated(
  "Net income 100 million", "Net income -100 million"));
t("小数点差はpunct-loose profileへ逃がさずfail closed", await assertProductionQuoteNotLocated(
  "Revenue 123 million", "Revenue 1.23 million"));
t("EPSの小数/桁意味差はfail closed", await assertProductionQuoteNotLocated(
  "EPS 123", "EPS 1.23"));
t("率記号差はfail closed", await assertProductionQuoteNotLocated(
  "Operating margin 12%", "Operating margin 12"));
t("桁区切り差はfail closed", await assertProductionQuoteNotLocated(
  "Total assets 1234", "Total assets 1,234"));
// --- 並べ替えフォールバックが数値トークンを部分文字列で当てたり
//     block内の離れたセルを繋いだりしないことを、production抽出そのもので固定する。
t("実測再現: 本文-100の中の100をquote「100」で拾わない（符号境界）", await assertProductionQuoteNotLocated(
  "Net income -100 million", "Net income 100 million"));
t("実測再現: 本文1,235の中の235をquote「235」で拾わない（桁区切り境界）", await assertProductionQuoteNotLocated(
  "Gain on sales of investment securities 1,235", "Gain on sales of investment securities 235"));
t("実測再現: 本文(37,812)の中の37,812をquote「37,812」で拾わない（括弧境界）", await assertProductionQuoteNotLocated(
  "Dividends paid (37,812)", "Dividends paid 37,812"));
t("実測再現: 本文△37,812の中の37,812をquote「37,812」で拾わない（△境界）", await assertProductionQuoteNotLocated(
  "剰余金の配当 △37,812 △37,812", "剰余金の配当 37,812 37,812"));
t("実測再現: block内の離れたセルを繋ぐ単語袋一致を拒否（Net sales 250）", await assertProductionQuoteNotLocated(
  "Net sales 1,000 2,000 Operating income 300 400 Ordinary income 500 600 Net income 200 250",
  "Net sales 250"));
t("単語袋拒否はスパン制限そのものでも効く（短すぎる引用ゲートに頼らない別例）", await assertProductionQuoteNotLocated(
  "Net sales total revenue figures 1,000 2,000 Operating income 300 400 Ordinary income 500 600 Net income 200 250",
  "Net sales total revenue 250"));
t("実測再現: 語を落とした引用（末尾の数字も別セルの部分文字列）を拒否", await assertProductionQuoteNotLocated(
  "Net income attributable to owners of parent 35,086",
  "Net income attributable owners parent 5,08"));
// ⚠️ 「隙間なく隣接した別セルの数値」の横取り。実測 2026-08-18: 表の読み順では、ある科目の
//    数値セルの直後に隙間なく次の行のラベルが続くことがある。トークン**間**の隙間だけを
//    見る従来のforeign-digitチェックは、一致スパンの**外縁**が裸の数字で終わっている
//    横取りを検出できなかった（本Function-under-testに major fix として外縁チェックを追加）。
t("実測再現: 隣接科目の数値を横取りしない（Operating income 2,000 は売上高の前期値）", await assertProductionQuoteNotLocated(
  "netsales1,0002,000operatingincome300400ordinaryincome500600",
  "Operating income 2,000"));
t("実測再現: 隣接科目の数値を横取りしない（Ordinary income 400 は営業利益の当期値）", await assertProductionQuoteNotLocated(
  "netsales1,0002,000operatingincome300400ordinaryincome500600",
  "Ordinary income 400"));
t("実測再現: 隣接科目の数値を横取りしない（Net income 350 は経常利益の値）", await assertProductionQuoteNotLocated(
  "ordinaryprofit350netincome200",
  "Net income 350"));
t("単一block全文quoteはproductionで照合できる", await (async () => {
  try {
    const located = await productionLocateFactory("revenue999999consolidated")(1, "revenue 999999 consolidated");
    return located?.matchProfile === "layout-strict" && located?.matchMode;
  } catch (_) { return false; }
})());

// --- 同一block内トークン並べ替えフォールバック ---
// 実測 2026-08-18: モデルの quote は「読みやすい語順」に並べ替えるため、表セルの実際の
// 読み順（送信TEXTと同じ語順）と食い違うことがある。値そのものは変わらないので、
// 同一block内で全トークンが一意に見つかる場合だけ受理してよい。
const productionLocateFactoryWithBlocks = (normalized, blockRanges) => new Function(
  "quoteRawCandidatesForHighlight", "HIGHLIGHT_MATCH_PROFILES", "isUsefulLooseHighlightNeedle",
  "getReportLayoutTextIndex", "findNormalizedMatches", "pctHighlightBoxes", "mergeHighlightTextBoxes",
  "chooseUniqueBlockFragment",
  `${extractFunction("locateReorderedTokensWithinBlock")}
   ${extractFunction("locateSplitAnchorWithinBlocks")}
   ${asyncSource("locateQuoteHighlightBoxes")}; return locateQuoteHighlightBoxes;`,
)(
  quote => [String(quote || "")],
  productionProfiles,
  () => true,
  async () => ({
    layout: { version: "layout-v2" },
    normalized,
    charBoxes: Array.from({ length: String(normalized).length }, (_, index) =>
      (normalized[index] === "\u0000" ? null : { x: index, y: 100, w: 1, h: 10 })),
    blockRanges,
    viewport: { width: 1000, height: 1000 },
  }),
  productionFindMatches,
  boxes => boxes,
  boxes => boxes,
  chooseUniqueBlockFragmentPure,
);
for (const fixture of REPORT2_LAYOUT_FIXTURES) {
  let normalized = "";
  const blockRanges = [];
  for (const block of fixture.blocks) {
    if (normalized) normalized += "\u0000";
    const start = normalized.length;
    normalized += normalizeReport2Locator(block);
    blockRanges.push({ start, end: normalized.length });
  }
  const charBoxes = makeCharBoxes(normalized, blockRanges, fixture.blockLineY);
  const located = await productionLocateFactory(normalized, blockRanges, charBoxes)(
    1, fixture.quote, null, { allowSplitAnchor: true },
  );
  t(`${fixture.id}:表示専用split-anchorはlabel/numericの厳密boxだけ返す`, Boolean(located)
    && located.matchProfile === "layout-split-anchor"
    && located.matchMode === "同一行・分割blockアンカー"
    && located.splitAnchor?.label?.blockIndex !== located.splitAnchor?.numeric?.blockIndex
    && located.splitAnchor?.geometry?.sameBlock === false
    && located.boxes.length >= 2);
  t(`${fixture.id}:証拠照合はsplit-anchorを採用しない`, await (async () => {
    try {
      await productionLocateFactory(normalized, blockRanges, charBoxes)(1, fixture.quote);
      return false;
    } catch (error) { return /単一レイアウトblock内/.test(String(error?.message || error)); }
  })());
}
// PDFの実テキスト順（実測: 表のセル配置で数値と単位語がセル境界を跨いで入れ替わる）。
const sharesBlockText = "averagenumberofsharesoutstandingduringtheperiod(thousandsof630,263630,626shares)";
const sharesQuoteModelOrder = "Average number of shares outstanding during the period (Thousands of shares) 630,263 630,626";
// ⚠️ 並べ替えフォールバックはlocateQuoteHighlightBoxes側でopt-in（既定false）に
//    なった。ここで検証しているのはフォールバック機構そのものなので、全呼び出しで
//    明示的に { allowReordered: true } を渡す（渡し忘れると常にfail-closedへ落ちて、
//    フォールバックの中身を一切検査できていないのに全部PASSする見かけ倒しになる）。
t("実測: モデルの並べ替えquoteを同一block内トークン一致で救う", await (async () => {
  try {
    const located = await productionLocateFactoryWithBlocks(
      sharesBlockText, [{ start: 0, end: sharesBlockText.length }],
    )(1, sharesQuoteModelOrder, null, { allowReordered: true });
    return located?.matchProfile === "layout-strict-reordered" && located?.matchMode === "段組み・語順ゆらぎ";
  } catch (_) { return false; }
})());
t("並べ替えフォールバックはblockを跨いだ結合を受理しない", await (async () => {
  // "shares)" だけを別blockへ分ける（区切り文字はどちらのblockにも属さない）。
  // 全トークンが単一block内に収まらないので、fail-closedのまま
  // 単一レイアウトblockエラーになるべき。
  const part1 = "averagenumberofsharesoutstandingduringtheperiod(thousandsof630,263630,626";
  const part2 = "shares)";
  const splitNormalized = part1 + "\u0000" + part2;
  try {
    await productionLocateFactoryWithBlocks(splitNormalized, [
      { start: 0, end: part1.length },
      { start: part1.length + 1, end: part1.length + 1 + part2.length },
    ])(1, sharesQuoteModelOrder, null, { allowReordered: true });
    return false;
  } catch (error) { return /単一レイアウトblock内/.test(String(error?.message || error)); }
})());
t("並べ替えフォールバックは数値が違えば一致させない", await (async () => {
  const wrongQuote = "Average number of shares outstanding during the period (Thousands of shares) 630,263 630,624";
  try {
    await productionLocateFactoryWithBlocks(
      sharesBlockText, [{ start: 0, end: sharesBlockText.length }],
    )(1, wrongQuote, null, { allowReordered: true });
    return false;
  } catch (error) { return /単一レイアウトblock内/.test(String(error?.message || error)); }
})());
t("並べ替えフォールバックは短すぎる引用を対象にしない（誤ハイライト防止）", await (async () => {
  try {
    await productionLocateFactoryWithBlocks("35086", [{ start: 0, end: 5 }])(1, "35,086", null, { allowReordered: true });
    return false;
  } catch (error) { return /単一レイアウトblock内/.test(String(error?.message || error)); }
})());
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
  { name:"F0082 row-number-only REF quote", finding:{ page:1, quote:"Operating income 4 1,861", category:"number_mismatch",
      issueScope:"translation_consistency", referenceQuote:"営業利益 4", referenceFile:"ref-a.pdf", referencePages:[2] }, accepted:false },
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
t("ページ補正も対象packet範囲内だけを探索", /const targetPagesForCorrection = \[\.\.\.allowedSet\][\s\S]{0,2400}for \(const pageNo of targetPagesForCorrection\)/.test(html));
t("P.25返却でもTARGET_CHECKのP.23一致を優先", /scoreFindingPageCandidate/.test(html) && /inTargetRange \? 1000000/.test(html));
t("ページ補正の同点候補は決定的に保留", /function chooseFindingPageCorrection/.test(html) && /ranked\[1\]\.score === ranked\[0\]\.score/.test(html));
t("取込時にTARGET quoteを検証", /await validateFindingQuoteEvidence\(incoming\)/.test(html) && /quote-not-found/.test(html));
t("cross-block partialは証拠照合・ページ補正へ使わず表示専用split-anchorだけ許可", /chooseUniqueBlockFragment/.test(html)
  && /function locateSplitAnchorWithinBlocks/.test(html)
  && /mode: "split-anchor"/.test(html)
  && /allowSplitAnchor/.test(html)
  && /r\.highlight_match_profile = located\.matchProfile/.test(html)
  && /単一レイアウトblock内の全文/.test(html)
  && /hits\.length !== 1\) continue/.test(html)
  && /locateQuoteHighlightBoxes\(finding\.page, candidate\)/.test(html));
t("productionのquote検証・ページ補正はstrict profileだけ", (html.match(/const strictProfile = HIGHLIGHT_MATCH_PROFILES\.find/g) || []).length >= 2
  && /for \(const profile of \[strictProfile\]\)/.test(html)
  && /rawCandidates\.map\(strictProfile\.normalize\)/.test(html));
t("TARGET/REFのPDF.js cache keyは文書identityを含む", /reportDocumentCacheKey\(doc, source\)/.test(html)
  && (html.match(/reportDocumentCacheKey\(doc\s*,\s*source\)/g) || []).length >= 3);
t("packet page mapはTARGET_CHECKだけをsource pageへ変換", /mapReturnedPageWithPacketMap\(rawPageValue, allowed, totalPages, activeImportPacketPageMap/.test(html)
  && /role === \"TARGET_CHECK\"/.test(html)
  && /if \(mapped\.nonActionable\) return mapped/.test(html)
  && /packetPageNonActionable/.test(html));
t("手動packet_id importも既知packetのallowed/mapを一時適用し未知idは推測しない", /resolveManualImportPacketContext/.test(html)
  && /buildClientPacketPageMapRows\(packet\)/.test(html)
  && /activeImportAllowedPages = manualContext\.allowedPages/.test(html)
  && /if \(!payload && !packet\) return null/.test(html)
  && /activeImportAllowedPages = previousImportAllowedPages/.test(html));
t("数値16件はimport後のquote/highlight検証へ進めない", (() => {
  const importStart = html.indexOf("async function importResponse");
  const importEnd = html.indexOf("async function buildReportDataWithHighlights");
  const importSource = html.slice(importStart, importEnd);
  const rawAt = importSource.indexOf("const rawFindings = coerceFindings(data)");
  const filterAt = importSource.indexOf("partitionNumericFalsePositives(");
  const variantAt = importSource.indexOf("chooseSourceBackedQuoteVariants");
  const validateAt = importSource.indexOf("await validateFindingQuoteEvidence(incoming)");
  const reportStart = html.indexOf("async function buildReportDataWithHighlights");
  const exportSource = html.slice(reportStart, html.indexOf("async function exportHtmlReportZip"));
  return rawAt >= 0 && filterAt > rawAt && variantAt > filterAt && validateAt > variantAt
    && /for \(const r of data\.findings\)/.test(exportSource);
})());
t("warning理由はカード・toast・ariaへ同じ純helperから配線", /autoReviewWarningSummary/.test(html)
  && /autoReviewWarningUiSummary\(st\)/.test(html)
  && /autoReviewWarningUiSummary\(displayState\)\.toast/.test(html)
  && /message = `校正は要確認の状態で終了しました。\$\{warningSummary\.message\}`/.test(html)
  && /整合性が要確認で終了しました。/.test(html)
  && /warningSummary\.nextAction/.test(html));
t("warning banner/toastはlocal import pending/error中に終了扱いしない", /terminalPacketCount === Number\(st\.packets_total \|\| 0\)[\s\S]{0,180}&& !pending && !importError/.test(html)
  && /displayState\.mode === "done" && !importPending && !importError/.test(html)
  && /importedFindings: imported\.length/.test(html)
  && /importedPages: importedPages\.size/.test(html));
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
t("緩いquoteの複数一致を拒否", (html.match(/profile\.loose\s*&&\s*hits\.length\s*>\s*1/g) || []).length >= 1);
t("ハイフン誤認も監査可能な除外候補として保存", /f\.excludedReason = "line-end-hyphen"/.test(html) && !/coerced\.filter\(f => !isLikelyLineEndHyphenFalsePositive/.test(html));
t("補助PDFは除外候補表示チェックに依存しない", /const numbered = findings\.filter\(f => !f\.excludedReason\)/.test(html));
t("除外理由を日本語表示", /const EXCLUDED_REASON_LABELS/.test(html) && /除外理由:.*excludedReasonLabel/.test(html));
t("quote未照合の除外候補は通常一覧から除外済み・場所不明と表示", /quote-not-found":\s*"通常一覧から除外済み・場所を特定できない/.test(html)
  && /const excludedLocation = r\.excluded_reason === "quote-not-found"/.test(html)
  && /通常一覧から除外済み・場所を特定できません/.test(html)
  && /r\.highlight_status === "error" && !excludedLocation/.test(html));
t("欠番主張はpacket全TARGETページの本文で反証", /hasClaimedMissingStructureNumber\(finding\)[\s\S]{0,100}await getStructureCorpus\(\)/.test(html) && /structure-claim-contradicted/.test(html));
t("structure promptは欠番報告前の再検索を要求", (html.match(/欠番を報告する直前に/g) || []).length >= 2);

console.log(`\nTest-FindingQuality: ${failures ? `FAIL (${failures})` : "PASS"}`);
process.exit(failures ? 1 : 0);
