// Exact F0017 raw fixture (REF1) -> old UI-equivalent coerce/mask/context baseline -> canonical aliases.
// The baseline intentionally preserves the production snake_case shape. It proves whether
// the reported F0017/REF1 path was already GREEN before this change.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalizeReferenceFinding, referencePageForFinding, resolveReferenceIndex } from "../js/finding-reference-context.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { findUniqueNumericSourceContext, partitionNumericFalsePositives } from "../js/review-merge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const rawFixture = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-proofread-f0017.json"), "utf8"));
const pageText = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-0840-page-text.json"), "utf8"));
const raw = rawFixture.findings[0];
const rawResponse = { ...rawFixture, findings: [raw] };
const rawFinding = rawResponse.findings[0];
const refs = [{ id: "ref-ja", fileName: "mazda_fy2026_ja.pdf" }];
const sourceForRef = (ref, page) => ref?.id === "ref-ja"
  ? pageText.pages.reference[String(page)] || ""
  : "";
const t = (name, condition) => {
  if (!condition) { console.error("  FAIL " + name); process.exitCode = 1; }
  else console.log("  ok   " + name);
};

const snakeKeys = ["reference_pages", "reference_page", "reference_file", "reference_quote"];
const finding = canonicalizeReferenceFinding(rawFinding);
t("raw responseからcanonical-only findingを作る", snakeKeys.every(key => !(key in finding))
  && Object.keys(finding).every(key => !key.includes("_")));
t("exact F0017のcanonical REFページはP.18", finding.referencePages.length === 1 && finding.referencePages[0] === 18);
t("exact F0017のcanonical REFファイルはREF1", finding.referenceFile === "REF1_mazda_fy2026_ja.pdf");
t("exact F0017のcanonical REF引用は630,349/630,779", finding.referenceQuote.includes("630,349 630,779"));
t("canonical REFページ解決はP.18", referencePageForFinding(finding) === 18);

// These helpers mirror the pre-fix main/index.html contracts exactly at the
// relevant boundary: snake-only page/quote normalization and reference resolver.
function oldNormalizeReferencePages(item) {
  const rawPages = item?.reference_pages ?? item?.ref_pages ?? item?.reference_page ?? item?.ref_page;
  if (Array.isArray(rawPages)) {
    return [...new Set(rawPages.map(Number).filter(n => Number.isFinite(n) && n > 0)
      .map(n => Math.round(n)))].sort((a, b) => a - b);
  }
  if (typeof rawPages === "string" && rawPages.trim()) {
    return [...new Set((rawPages.match(/\d+/g) || []).map(Number)
      .filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  }
  const n = Number(rawPages);
  return Number.isFinite(n) && n > 0 ? [Math.round(n)] : [];
}
function oldCoerceReferenceFinding(item) {
  const pages = oldNormalizeReferencePages(item);
  return {
    id: item.id || "F0017",
    page: Number(item.page),
    category: item.category,
    issueScope: item.issue_scope ?? item.issueScope ?? "",
    quote: item.quote || "",
    referencePages: pages,
    referencePage: pages[0] || null,
    referenceFile: item.reference_file ?? item.referenceFile ?? "",
    referenceQuote: item.reference_quote ?? item.ref_quote ?? "",
  };
}
function oldRestoreMaskedFindings(list) {
  // F0017 has no mask token. This is the old restore boundary's no-op result.
  return (list || []).map(item => ({ ...item }));
}
function oldReferenceIndex(record, references) {
  const wanted = String(record?.reference_file || "");
  const matched = references.findIndex((ref, i) =>
    wanted === ref.fileName || wanted === "REF" + (i + 1) + "_" + ref.fileName);
  return matched >= 0 ? matched : 0;
}
async function collectWithOldResolver(findings, calls) {
  // This is the old inline index.html collector: no shared alias helper.
  const contexts = new Map();
  const numericCategories = new Set(["number_mismatch", "value_inconsistency", "accounting_inconsistency", "numbers"]);
  for (const finding of findings || []) {
    const referenceQuote = String(finding?.referenceQuote || finding?.reference_quote || "");
    if (!numericCategories.has(String(finding?.category || "").toLowerCase())
        || !String(finding?.quote || "").trim() || !referenceQuote.trim()) continue;
    const targetSource = pageText.pages.target[String(finding.page)] || "";
    const ref = refs[oldReferenceIndex(finding, refs)];
    const referencePage = (finding.referencePages || []).map(Number).find(page => page >= 1)
      || Number(finding.referencePage) || 0;
    calls.push({ id: ref?.id || "", page: referencePage });
    const referenceSource = sourceForRef(ref, referencePage);
    const targetMatch = findUniqueNumericSourceContext(targetSource, finding.quote);
    const referenceMatch = findUniqueNumericSourceContext(referenceSource, referenceQuote);
    if (targetMatch?.unique && referenceMatch?.unique) {
      contexts.set(String(finding.id || ""), {
        targetText: targetMatch.text,
        referenceText: referenceMatch.text,
        targetRowText: targetMatch.rowText,
        referenceRowText: referenceMatch.rowText,
        targetQuote: finding.quote,
        referenceQuote,
        targetRowUnique: true,
        referenceRowUnique: true,
      });
    }
  }
  return contexts;
}

// A: exact production-shaped F0017/REF1 through old coerce -> mask restore ->
// PDF.js page text context -> review-merge. This is an explicit old GREEN baseline.
const oldSnakeCoerced = oldCoerceReferenceFinding(rawFinding);
const oldSnakeRestored = oldRestoreMaskedFindings([oldSnakeCoerced]);
const oldBaselineCalls = [];
const oldBaselineContexts = await collectWithOldResolver(oldSnakeRestored, oldBaselineCalls);
const oldBaselineContext = oldBaselineContexts.get(oldSnakeCoerced.id);
const oldBaseline = partitionNumericFalsePositives(oldSnakeRestored, {
  forFinding: () => oldBaselineContext || {},
});
t("旧coerceはexact F0017/REF1のP.18を保持", oldSnakeCoerced.referencePages[0] === 18
  && oldSnakeCoerced.referenceQuote.includes("630,779"));
t("旧mask restore相当は未マスク引用を保持", oldSnakeRestored[0].quote === raw.quote
  && oldSnakeRestored[0].referenceQuote === raw.reference_quote);
t("修正前baseline: exact F0017/REF1は本文reader→unique context→DROP",
  oldBaselineCalls.some(call => call.id === "ref-ja" && call.page === 18)
    && Boolean(oldBaselineContext?.targetRowUnique && oldBaselineContext?.referenceRowUnique)
    && oldBaseline.kept.length === 0 && oldBaseline.dropped.length === 1);

// B/C: exact values and REF1 are unchanged, but a canonical camel-only intake
// crosses the alias boundary that old main/index.html did not normalize.
const camelRaw = { ...raw };
for (const key of snakeKeys) delete camelRaw[key];
Object.assign(camelRaw, {
  referencePages: [18],
  referencePage: 18,
  referenceFile: "REF1_mazda_fy2026_ja.pdf",
  referenceQuote: raw.reference_quote,
});
const oldCamelCoerced = oldCoerceReferenceFinding(camelRaw);
const oldCamelCalls = [];
const oldCamelContexts = await collectWithOldResolver([oldCamelCoerced], oldCamelCalls);
const oldCamel = partitionNumericFalsePositives([oldCamelCoerced], {
  forFinding: () => oldCamelContexts.get(oldCamelCoerced.id) || {},
});
t("修正前RED: camel-only intakeは旧normalizerでREFページ/引用を失う",
  oldCamelCoerced.referencePages.length === 0
    && !oldCamelCoerced.referenceQuote
    && oldCamelCalls.length === 0
    && !oldCamelContexts.has(oldCamelCoerced.id)
    && oldCamel.kept.length === 1 && oldCamel.dropped.length === 0);

const camelFinding = canonicalizeReferenceFinding(camelRaw);
const camelCalls = [];
const camelContexts = await collectNumericFindingContexts([camelFinding], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (ref, page) => {
    camelCalls.push({ id: ref?.id || "", page });
    return sourceForRef(ref, page);
  },
  referenceSourceFor: record => refs[resolveReferenceIndex(record, refs)],
});
const camelContext = camelContexts.get(camelFinding.id);
const camelFiltered = partitionNumericFalsePositives([camelFinding], {
  forFinding: () => camelContext || {},
});
t("GREEN: camel-only aliasesをcanonical化しREF1 P.18 readerへ到達",
  camelFinding.referencePages[0] === 18
    && camelFinding.referenceFile === "REF1_mazda_fy2026_ja.pdf"
    && camelFinding.referenceQuote.includes("630,779")
    && camelCalls.some(call => call.id === "ref-ja" && call.page === 18));
t("GREEN: canonical camel-only exact値はunique context→DROP",
  Boolean(camelContext?.targetRowUnique && camelContext?.referenceRowUnique)
    && camelFiltered.kept.length === 0 && camelFiltered.dropped.length === 1);

// New shared path on the exact production snake_case fixture must remain GREEN,
// while the baseline above prevents claiming it was previously broken.
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
t("GREEN: exact F0017/REF1 TARGET P.19/REF P.18 readerを呼ぶ",
  targetCalls.includes(19) && referenceCalls.some(call => call.id === "ref-ja" && call.page === 18));
t("GREEN: exact F0017/REF1本文行が双方一意", Boolean(context?.targetRowUnique && context?.referenceRowUnique));
const filtered = partitionNumericFalsePositives([finding], { forFinding: () => context || {} });
t("GREEN: exact F0017/REF1をreview-mergeで除外",
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
  referenceSourceFor: () => refs[0],
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
  referenceSourceFor: () => refs[0],
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
  referenceSourceFor: () => refs[0],
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
