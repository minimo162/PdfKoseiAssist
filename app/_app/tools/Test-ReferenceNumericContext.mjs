// F0017-shaped raw response -> canonical coerce boundary -> REF2 resolution -> PDF.js context -> review-merge.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalizeReferenceFinding, referencePageForFinding, resolveReferenceIndex } from "../js/finding-reference-context.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { partitionNumericFalsePositives } from "../js/review-merge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const rawFixture = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-proofread-f0017.json"), "utf8"));
const pageText = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-0840-page-text.json"), "utf8"));
const raw = rawFixture.findings[0];
const rawResponse = {
  ...rawFixture,
  findings: [{
    ...raw,
    // Use a non-first REF to expose the canonical-only resolver boundary.
    reference_file: "REF2_mazda_fy2026_ja.pdf",
  }],
};
const rawFinding = rawResponse.findings[0];
const refs = [
  { id: "ref-other", fileName: "other-reference.pdf" },
  { id: "ref-ja", fileName: "mazda_fy2026_ja.pdf" },
];
const finding = canonicalizeReferenceFinding(rawFinding);
const normalized = finding;
const t = (name, condition) => {
  if (!condition) { console.error("  FAIL " + name); process.exitCode = 1; }
  else console.log("  ok   " + name);
};
const snakeKeys = ["reference_pages", "reference_page", "reference_file", "reference_quote"];
const sourceForRef = (ref, page) => ref?.id === "ref-ja"
  ? pageText.pages.reference[String(page)] || ""
  : "";

t("raw responseからcanonical-only findingを作る", snakeKeys.every(key => !(key in finding))
  && Object.keys(finding).every(key => !key.includes("_")));
t("canonical REFページはP.18", normalized.referencePages.length === 1 && normalized.referencePages[0] === 18);
t("canonical REFファイルはREF2指定を保持", normalized.referenceFile === "REF2_mazda_fy2026_ja.pdf");
t("canonical REF引用は630,349/630,779を保持", normalized.referenceQuote.includes("630,349 630,779"));
t("canonical REFページ解決はP.18", referencePageForFinding(finding) === 18);

// RED: the pre-fix UI resolver only read reference_file. A canonical-only
// finding therefore fell back to REF1, so REF2's PDF.js text was never read.
function oldReferenceIndex(record, references) {
  const wanted = String(record?.reference_file || "");
  const matched = references.findIndex((ref, i) =>
    wanted === ref.fileName || wanted === "REF" + (i + 1) + "_" + ref.fileName);
  return matched >= 0 ? matched : 0;
}
const oldIndex = oldReferenceIndex(finding, refs);
const oldReferenceCalls = [];
const oldContexts = await collectNumericFindingContexts([finding], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (ref, page) => {
    oldReferenceCalls.push({ id: ref?.id || "", page });
    return sourceForRef(ref, page);
  },
  referenceSourceFor: () => refs[oldIndex],
});
t("RED:旧resolverはcanonical REF2を先頭REFへ誤fallback", oldIndex === 0);
t("RED:旧経路はREF2の本文readerを呼べずcontextなし",
  oldReferenceCalls.some(call => call.id === "ref-other" && call.page === 18)
    && !oldReferenceCalls.some(call => call.id === "ref-ja")
    && !oldContexts.has(finding.id));

// GREEN: the shared resolver uses canonical referenceFile and reaches REF2.
const targetCalls = [];
const referenceCalls = [];
const contexts = await collectNumericFindingContexts([finding], {
  targetTextFor: page => {
    targetCalls.push(page);
    return pageText.pages.target[String(page)] || "";
  },
  referenceTextFor: (ref, page) => {
    referenceCalls.push({ id: ref?.id || "", page });
    return sourceForRef(ref, page);
  },
  referenceSourceFor: record => refs[resolveReferenceIndex(record, refs)],
});
const context = contexts.get(finding.id);
t("GREEN: TARGET P.19/REF2 P.18のreaderを呼ぶ",
  targetCalls.includes(19) && referenceCalls.some(call => call.id === "ref-ja" && call.page === 18));
t("GREEN: TARGET/REF本文行が双方一意", Boolean(context?.targetRowUnique && context?.referenceRowUnique));
const filtered = partitionNumericFalsePositives([finding], { forFinding: () => context || {} });
t("GREEN: 同値F0017-shaped findingをreview-mergeで除外",
  filtered.kept.length === 0 && filtered.dropped.length === 1);

// Negative fixtures change the source text as well as the citation. Both sides
// must still bind uniquely before the fail-closed filter can make a decision.
const oneValueCase = pageText.negative_cases.f0017_one_value_difference;
const oneValueFinding = {
  ...finding,
  quote: rawFinding.quote.replace("630,779", "630,780"),
};
const oneValueContexts = await collectNumericFindingContexts([oneValueFinding], {
  targetTextFor: page => page === oneValueCase.target_page ? oneValueCase.target : "",
  referenceTextFor: (ref, page) => ref.id === "ref-ja" && page === oneValueCase.reference_page ? oneValueCase.reference : "",
  referenceSourceFor: () => refs[1],
});
const oneValueContext = oneValueContexts.get(finding.id);
t("真の1値差もTARGET/REF双方一意", Boolean(oneValueContext?.targetRowUnique && oneValueContext?.referenceRowUnique));
const oneValue = partitionNumericFalsePositives([oneValueFinding], {
  forFinding: () => oneValueContext || {},
});
t("真の1値差はKEEP", oneValue.kept.length === 1 && oneValue.dropped.length === 0);

const signCase = pageText.negative_cases.f0017_sign_difference;
const signFinding = {
  ...finding,
  referenceQuote: rawFinding.reference_quote.replace("630,349", "△630,349"),
};
const signContexts = await collectNumericFindingContexts([signFinding], {
  targetTextFor: page => page === signCase.target_page ? signCase.target : "",
  referenceTextFor: (ref, page) => ref.id === "ref-ja" && page === signCase.reference_page ? signCase.reference : "",
  referenceSourceFor: () => refs[1],
});
const signContext = signContexts.get(finding.id);
t("符号差もTARGET/REF双方一意", Boolean(signContext?.targetRowUnique && signContext?.referenceRowUnique));
const sign = partitionNumericFalsePositives([signFinding], {
  forFinding: () => signContext || {},
});
t("符号差はKEEP", sign.kept.length === 1 && sign.dropped.length === 0);

const missingPage = { ...finding, referencePages: [999], referencePage: 999 };
const missingContexts = await collectNumericFindingContexts([missingPage], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (ref, page) => sourceForRef(ref, page),
  referenceSourceFor: () => refs[1],
});
const missingContext = missingContexts.get(finding.id);
const missing = partitionNumericFalsePositives([missingPage], {
  forFinding: () => missingContext || {},
});
t("REF本文が取得できない場合はcontextなし", !missingContext);
t("REF本文欠落時はfail-closedでKEEP", missing.kept.length === 1 && missing.dropped.length === 0);

if (process.exitCode) {
  console.error("\nTest-ReferenceNumericContext: FAIL");
  process.exit(1);
}
console.log("\nTest-ReferenceNumericContext: PASS");
