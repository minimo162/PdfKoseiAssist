// Regression coverage for issue #154: packet import and range validation must
// not fail on page numbers and response shapes that the run itself tolerates.
//
//   node tools/Test-Issue154Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReferencePages } from "../js/finding-reference-context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
const reviewJob = readFileSync(join(here, "..", "src", "ReviewJob.ps1"), "utf8");
const copilotClient = readFileSync(join(here, "..", "src", "CopilotClient.ps1"), "utf8");
function extractFunction(name) {
  const start = indexHtml.search(new RegExp(`(?:async )?function ${name}\\(`));
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

// --- 1. REF page numbers outside the REF PDF never reach pdf.js ---
{
  check("配列の reference_pages でも総ページ数を超える番号を捨てる",
    JSON.stringify(normalizeReferencePages({ reference_pages: [3, 57] }, { maxPage: 25 })) === "[3]");
  check("単一値の reference_page でも総ページ数を超える番号を捨てる",
    normalizeReferencePages({ reference_page: 57 }, { maxPage: 25 }).length === 0);

  const requested = [];
  const choose = new Function("scope", `with (scope) { ${extractFunction("chooseSourceBackedQuoteVariants")}; return chooseSourceBackedQuoteVariants; }`)({
    totalPages: 10, pdfDoc: {},
    referenceList: [{ fileName: "ja.pdf", totalPages: 25, doc: {} }],
    extractTextLayerText: async (doc, pageNo) => {
      requested.push(pageNo);
      if (pageNo > 25) throw new Error("Invalid page request.");
      return "売上高は1,285,706百万円でした。";
    },
    chooseSourceBackedFragment: (masked, candidates, source) => candidates.find(c => source.includes(c)) || "",
  });
  const findings = [
    { page: 1, quote: "a", referenceFile: "ja.pdf", referencePage: 57,
      referenceQuote: "x", referenceQuoteVariants: ["1,285,706百万円"], maskedReferenceQuote: "⟦#ABC⟧" },
    { page: 1, quote: "b", referenceFile: "ja.pdf", referencePages: [3],
      referenceQuote: "y", referenceQuoteVariants: ["1,285,706百万円"], maskedReferenceQuote: "⟦#ABC⟧" },
  ];
  let error = null;
  try { await choose(findings); } catch (e) { error = e; }
  check("範囲外の referencePage で取込全体を落とさない", !error, error?.message);
  check("範囲外の REF ページを pdf.js に要求しない", !requested.includes(57), JSON.stringify(requested));
  check("範囲内の指摘は従来どおり REF 本文から引用を選ぶ", findings[1].referenceQuote === "1,285,706百万円", findings[1].referenceQuote);
}

// --- 2. a split-and-merged packet with no findings still has a no-findings reason ---
{
  const merge = reviewJob.slice(reviewJob.indexOf("$mergedSummaries"), reviewJob.indexOf("$mergedSummaries") + 4000);
  check("分割マージ結果に no_findings_reason を入れる", /\$merged=\[ordered\]@\{[^\n]*no_findings_reason=/.test(merge));
  check("分割マージで null の指摘・ページ要約を除く", /\$null -ne \$_/.test(merge));
}

// --- 3. schema check tolerates the page-summary shapes Copilot actually returns ---
{
  check("ページ要約のページ番号を共通関数で読む", /function Get-KoseiSummaryPageValues/.test(copilotClient)
    && (copilotClient.match(/Get-KoseiSummaryPageValues /g) || []).length >= 2);
}

// --- 4. the TEXT attachment agrees with the prompt ---
{
  const sidecar = extractFunction("buildPacketTextSidecar");
  check("TEXT添付でもページ要約の配列を要求しない", !sidecar.includes("TARGET_CHECK全ページの checked_page_summaries"));
  check("TEXT添付の空指摘の指示は checked_pages と no_findings_reason", sidecar.includes("checked_pages または checked_pages_all"));
  check("伏字（PDFなし）ではTEXT添付でPDF表示の確認を求めない", /MASKING_ENABLED \? "- quote は TARGET_CHECK抽出テキストから完全一致でコピーしてください。"/.test(sidecar));
  check("REFページが無い節では比較資料を載せない", sidecar.includes("referenceSectionsWithPages.length ? `REF_CANDIDATE"));
}

// --- 5. range validation uses the packets that the run actually builds ---
{
  const refresh = extractFunction("refreshRangeFromInput");
  check("範囲入力は全ページ1パケットではなく実行時の分割で検証する",
    !refresh.includes("makeCurrentPacket()") && refresh.includes("makeAllPackets()"));
}

if (failures.length) {
  console.error(`\nTest-Issue154Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue154Regression: PASS");
