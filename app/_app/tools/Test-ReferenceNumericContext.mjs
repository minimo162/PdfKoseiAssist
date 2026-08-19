// F0017: raw snake_case finding -> UI normalization/source resolution -> PDF.js text context -> review-merge.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeReferenceFinding, referencePageForFinding, resolveReferenceIndex } from "../js/finding-reference-context.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { partitionNumericFalsePositives } from "../js/review-merge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const rawFixture = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-proofread-f0017.json"), "utf8"));
const pageText = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-0840-page-text.json"), "utf8"));
const raw = rawFixture.findings[0];
const refs = [{ id: "ref-ja", fileName: "mazda_fy2026_ja.pdf" }];
const normalized = normalizeReferenceFinding(raw);
const finding = { ...raw, ...normalized, id: raw.id || "F0017" };
const t = (name, condition) => {
  if (!condition) { console.error("  FAIL " + name); process.exitCode = 1; }
  else console.log("  ok   " + name);
};

t("snake_case finding のREFページを18へ正規化", normalized.referencePages.length === 1 && normalized.referencePages[0] === 18);
t("snake_case finding のREFファイルを保持", normalized.referenceFile === "REF1_mazda_fy2026_ja.pdf");
t("snake_case finding のREF引用を保持", normalized.referenceQuote.includes("630,349 630,779"));
t("camel/ref aliasも同じ契約へ正規化", (() => {
  const alias = normalizeReferenceFinding({
    referencePages: "18", referenceFile: "REF1_mazda_fy2026_ja.pdf",
    referenceQuote: "１株当たり純資産額の算定に用いられた 630,349 630,779",
  });
  return alias.referencePages[0] === 18 && alias.referenceFile.startsWith("REF1_") && alias.referenceQuote.includes("630,779");
})());
t("UI側REFファイル解決はREF1へ到達", resolveReferenceIndex(finding, refs) === 0);
t("UI側REFページ解決はP.18へ到達", referencePageForFinding(finding) === 18);

const contexts = await collectNumericFindingContexts([finding], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (_ref, page) => pageText.pages.reference[String(page)] || "",
  referenceSourceFor: () => refs[0],
});
const context = contexts.get(finding.id);
t("PDF.js本文のTARGET P.19とREF P.18が一意に照合", Boolean(context?.targetRowUnique && context?.referenceRowUnique));
const filtered = partitionNumericFalsePositives([finding], { forFinding: () => context || {} });
t("同値F0017はreview-mergeで除外", filtered.kept.length === 0 && filtered.dropped.length === 1);

const oneValueDifference = { ...finding, referenceQuote: finding.referenceQuote.replace("630,779", "630,780") };
const oneValueContexts = await collectNumericFindingContexts([oneValueDifference], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (_ref, page) => pageText.pages.reference[String(page)] || "",
  referenceSourceFor: () => refs[0],
});
const oneValue = partitionNumericFalsePositives([oneValueDifference], {
  forFinding: () => oneValueContexts.get(finding.id) || {},
});
t("真の1値差は保持", oneValue.kept.length === 1 && oneValue.dropped.length === 0);

const signDifference = { ...finding, quote: finding.quote.replace("630,349", "-630,349") };
const signContexts = await collectNumericFindingContexts([signDifference], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (_ref, page) => pageText.pages.reference[String(page)] || "",
  referenceSourceFor: () => refs[0],
});
const sign = partitionNumericFalsePositives([signDifference], {
  forFinding: () => signContexts.get(finding.id) || {},
});
t("符号差は保持", sign.kept.length === 1 && sign.dropped.length === 0);

const missingPage = { ...finding, reference_pages: [999], referencePages: undefined, referencePage: null };
const missingContexts = await collectNumericFindingContexts([missingPage], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (_ref, page) => pageText.pages.reference[String(page)] || "",
  referenceSourceFor: () => refs[0],
});
const missing = partitionNumericFalsePositives([missingPage], {
  forFinding: () => missingContexts.get(finding.id) || {},
});
t("REF本文が取得できない場合はfail-closedで保持", missing.kept.length === 1 && missing.dropped.length === 0);

if (process.exitCode) {
  console.error("\nTest-ReferenceNumericContext: FAIL");
  process.exit(1);
}
console.log("\nTest-ReferenceNumericContext: PASS");
