// Regression coverage for issue #153: wrong content must not be displayed
// (suggestion scale, recovery masking, instruction replacement, report reason,
// page correction).
//
//   node tools/Test-Issue153Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Masker, unmaskFragment, maskSidecarByRole } from "../js/number-mask.mjs";
import { normalizeSuggestionIntegrityFinding } from "../js/finding-quality.mjs";
import { normalizeQuote } from "../js/review-merge.mjs";
import { reconstructTextContentDetailed } from "../js/pdf-text-reconstruct.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
function extractFunction(name) {
  let start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (indexHtml.slice(start - 6, start) === "async ") start -= 6;
  // Start at the body brace: parameters may use destructuring (`({ page, … })`).
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
const symbols = text => text.match(/⟦#[A-Z]{3}⟧/g) || [];

// --- 1. suggestions are restored with the scale word next to the placeholder ---
{
  const sidecar = "===== PDF P.1 / TARGET_CHECK / 元PDF P.1 / en.pdf =====\n"
    + "(Millions of yen)\nNet sales 386,012\nOperating income 51,201\n"
    + "Net sales were ¥386.0 billion and operating income was ¥52.1 billion.\n"
    + "===== PDF P.1 / REF1_CANDIDATE / 元PDF P.1 / ja.pdf =====\n"
    + "（単位：百万円）\n売上高 386,012\n営業利益 51,201\n売上高は3,860億円、営業利益は512億円となりました。\n";
  const masker = new Masker(2026);
  const lines = maskSidecarByRole(sidecar, masker).split("\n");
  const quote = lines.find(line => line.startsWith("Net sales were"));
  const reference = lines.find(line => line.startsWith("売上高は"));
  const [, wrong] = symbols(quote);
  const [, right] = symbols(reference);
  const restored = unmaskFragment(quote.replace(wrong, right), masker, "en");
  check("修正案の金額を billion の桁で復元する", restored === "Net sales were ¥386.0 billion and operating income was ¥51.2 billion.", restored);
  const ja = unmaskFragment(`営業利益は${right}円です。`, masker, "ja");
  check("日本語の「円」の前は桁の語を含む表記で復元する", ja === "営業利益は512億円です。", ja);
  check("桁の語が無い位置は従来どおり最初の表記", unmaskFragment(`Operating income ${right}`, masker, "en") === "Operating income 51,201");
}
{
  const sidecar = "===== PDF P.1 / TARGET_CHECK / 元PDF P.1 / en.pdf =====\n"
    + "Net sales were ¥1,285.7 billion, up 16.9% year on year.\n"
    + "===== PDF P.5 / TARGET_CHECK / 元PDF P.5 / en.pdf =====\nNet sales amounted to 1,285,760 million yen.\n"
    + "===== PDF P.5 / REF1_CANDIDATE / 元PDF P.5 / ja.pdf =====\n売上高は1,285,706百万円となりました。\n";
  const masker = new Masker(2026);
  const lines = maskSidecarByRole(sidecar, masker).split("\n");
  const quote = lines[3], reference = lines[5];
  const suggestion = quote.replace(symbols(quote)[0], symbols(reference)[0]);
  const restored = unmaskFragment(suggestion, masker, "en");
  check("million の前は百万円単位の正確な値で復元する", restored === "Net sales amounted to 1,285,706 million yen.", restored);
}

// --- 2. recovery re-masks with the base packet id ---
{
  const recoveryMaskingPacketId = new Function(`${extractFunction("recoveryMaskingPacketId")}; return recoveryMaskingPacketId;`)();
  check("観点・巡回の接尾辞を外して基パケットIDを得る",
    recoveryMaskingPacketId("SEC_001_GAP_R2", { recoveryLens: "gap", recoveryRound: 2 }) === "SEC_001"
    && recoveryMaskingPacketId("SEC_001_NUMBERS", { recoveryLens: "numbers", recoveryRound: 1 }) === "SEC_001"
    && recoveryMaskingPacketId("SEC_002_R2", { recoveryLens: "", recoveryRound: 2 }) === "SEC_002");
  check("サンプリングの接尾辞を外す", recoveryMaskingPacketId("PACKET_001_S3", {}) === "PACKET_001");
  check("保存された伏字化IDを優先する", recoveryMaskingPacketId("SEC_001_GAP_R2", { maskingPacketId: "SEC_009" }) === "SEC_009");
  // The header line is part of the masked text: an extra digit in the id shifts every later symbol.
  const body = "\n===== PDF P.1 / TARGET_CHECK / 元PDF P.1 / en.pdf =====\nOperating income was 32,836 million yen.\n";
  const sent = maskSidecarByRole(`抽出テキスト: SEC_001${body}`, new Masker(424242));
  const recovered = maskSidecarByRole(`抽出テキスト: ${recoveryMaskingPacketId("SEC_001_GAP_R2", { recoveryLens: "gap", recoveryRound: 2 })}${body}`, new Masker(424242));
  const shifted = maskSidecarByRole(`抽出テキスト: SEC_001_GAP_R2${body}`, new Masker(424242));
  check("基パケットIDで作り直すと送信時と同じ伏字テキストになる", recovered === sent);
  check("観点付きIDのまま作り直すと伏字がずれる（旧挙動）", shifted !== sent);
  const recoverySource = indexHtml.slice(indexHtml.indexOf("async function prepareRecoverableSourceBinding"));
  check("復旧は伏字テキストのハッシュが一致しなければ取り込まない",
    recoverySource.includes("expectedSha !== await sha256HexBytes(encodeUtf8(text))"));
  check("観点別・サンプリングのパケットは伏字化IDとハッシュを復旧定義に残す",
    /maskingPacketId: effectivePacket\.packetId, maskedTextSha256 \}/.test(indexHtml)
    && /maskingPacketId: effectivePacket\.packetId,\s*maskedTextSha256,/.test(indexHtml)
    && /maskingPacketId: String\(packet\?\.maskingPacketId/.test(indexHtml));
}

// --- 3. Japanese instructions and note/name corrections are not replaced ---
{
  const quote = "The Group had 3,241 employees as of March 31, 2026.";
  for (const [category, suggestion, q] of [
    ["translation_consistency", "従業員数を原文どおり3,214名に揃えてください。", quote],
    ["mistranslation", "従業員数を日本語版の3,214名に合わせてください。", quote],
    ["prose_inconsistency", "3,241名と3,214名のどちらが正しいかご確認ください。", quote],
    ["translation_consistency", "従業員数を3,214名に修正すべきです。", quote],
    ["note_mismatch", "Profit per share (Yen)*2", "Profit per share (Yen)*3"],
    ["name_mismatch", "CX-30", "CX-3"],
  ]) {
    const out = normalizeSuggestionIntegrityFinding({ quote: q, referenceQuote: "", category, suggestion });
    check(`修正案を定型文に置き換えない（${category}: ${suggestion}）`, out.suggestion === suggestion, out.suggestion);
  }
  const english = normalizeSuggestionIntegrityFinding({ quote, referenceQuote: "", category: "grammar",
    suggestion: "The Group had 3,999 employees as of March 31, 2026." });
  check("原文に無い数値へ変える英文の置き換えは従来どおり作り直しを求める", english.suggestion !== "The Group had 3,999 employees as of March 31, 2026.");
}

// --- 4. merged alternatives reach the exported report reason ---
{
  const dedupeFindings = new Function("normalizeQuote", `${extractFunction("dedupeFindings")}; return dedupeFindings;`)(normalizeQuote);
  const q = "Net sales were 1,234 million yen and operating income rose 5.2% due to cost reductions.";
  const a = { id: "F0001", page: 5, category: "number_mismatch", quote: q, suggestion: "売上高を1,243に修正する。",
    issueSummary: "売上高がREFと不一致", reason: "REFでは1,243百万円。", displayReason: "REFでは1,243百万円。", confidence: 0.95 };
  const b = { id: "F0002", page: 5, category: "terminology", quote: q, suggestion: "operating incomeをordinary profitに修正する。",
    issueSummary: "経常利益の誤訳", reason: "REFは経常利益。", displayReason: "REFは経常利益。", confidence: 0.80 };
  let [card] = dedupeFindings([a, b]);
  check("束ねた指摘をレポートが使う表示用の理由にも残す", String(card.displayReason).includes("経常利益の誤訳"), card.displayReason);
  [card] = dedupeFindings([card]);
  check("再統合しても表示用の理由の注記は重複しない",
    (String(card.displayReason).match(/同じ箇所の別案/g) || []).length === 1, card.displayReason);
}

// --- 5. page correction does not treat a repeated quote as unique ---
{
  const pdfjsLib = { Util: { transform(m1, m2) {
    return [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];
  } } };
  const makeDoc = pages => ({
    numPages: pages.length,
    async getPage(p) {
      const lines = pages[p - 1];
      return {
        getViewport: () => ({ width: 595, height: 842, rotation: 0, transform: [1, 0, 0, -1, 0, 842] }),
        getTextContent: async () => ({
          items: lines.map((str, i) => ({ str, dir: "ltr", width: Array.from(str).length * 5, height: 10,
            transform: [10, 0, 0, 10, 72, 700 - i * 40], fontName: "F1", hasEOL: false })),
          styles: { F1: { vertical: false } },
        }),
      };
    },
  });
  const sentence = "operating profit fell 3.1% to 1,234 million yen";
  const pages = [["p1"], ["p2"], ["p3"], ["p4"],
    ["Overview", "Consolidated results are summarised on the following pages."],
    ["Segment information", `Automotive: ${sentence}.`, `Other: ${sentence}.`],
    ["p7"],
    ["Outlook", `Operating profit fell 3.1% to 1,234 million yen in the prior forecast.`],
    ["p9"]];
  const run = async pagesForDoc => new Function("pdfjsLib", "reconstructPdfTextContentDetailed", "pdfDocArg", `
    const pdfDoc = pdfDocArg, totalPages = pdfDocArg.numPages, targetPages = [5, 6, 7, 8, 9];
    const activeImportAllowedPages = new Set(targetPages);
    const reportTextLayerCache = new Map();
    const REPORT_TEXT_CACHE_LIMIT = 96;
    const reportDocumentCacheKey = () => "target";
    const locateQuoteHighlightBoxes = async () => null;
    const targetPageCandidatesForFinding = () => [];
    ${extractFunction("reportCacheGet")}
    ${extractFunction("reportCacheSet")}
    ${extractFunction("textItemBoxForViewport")}
    ${extractFunction("normalizeHighlightLocatorText")}
    ${extractFunction("stripOuterQuotePair")}
    ${extractFunction("removeQuoteLineBreakAnnotations")}
    ${extractFunction("quoteRawCandidatesForHighlight")}
    ${extractFunction("findNormalizedMatches")}
    ${extractFunction("scoreFindingPageCandidate")}
    ${extractFunction("chooseFindingPageCorrection")}
    ${extractFunction("getReportLayoutTextIndex")}
    ${extractFunction("findUniqueQuotePageForCorrection")}
    const HIGHLIGHT_MATCH_PROFILES = [{ key: "strict", normalize: normalizeHighlightLocatorText }];
    return findUniqueQuotePageForCorrection({ page: 5, quote: ${JSON.stringify(sentence)} });
  `)(pdfjsLib, reconstructTextContentDetailed, makeDoc(pagesForDoc));
  check("あるページで複数回出る引用は、1回だけ出る別ページへ補正しない", await run(pages) === null);
  const unique = pages.map((lines, i) => (i === 5 ? ["Segment information", "No figures."] : lines));
  check("本当に一意な引用は従来どおり補正する", await run(unique) === 8);
}

if (failures.length) {
  console.error(`\nTest-Issue153Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue153Regression: PASS");
