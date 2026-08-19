import { findUniqueNumericSourceContext } from "./review-merge.mjs";
import { referencePagesForFinding, referenceQuoteForFinding } from "./finding-reference-context.mjs";

const NUMERIC_CATEGORIES = new Set([
  "number_mismatch", "value_inconsistency", "accounting_inconsistency", "numbers",
]);

function numericCategory(value) {
  return NUMERIC_CATEGORIES.has(String(value || "").toLowerCase());
}

export async function collectNumericFindingContexts(findingsToCheck, {
  targetTextFor,
  referenceTextFor,
  referenceSourceFor,
} = {}) {
  const contexts = new Map();
  const targetPages = new Map();
  const referencePages = new Map();
  const readTarget = async page => {
    const key = Number(page) || 0;
    if (!key || typeof targetTextFor !== "function") return "";
    if (!targetPages.has(key)) targetPages.set(key, Promise.resolve().then(() => targetTextFor(key)).catch(() => ""));
    return targetPages.get(key);
  };
  const readReference = async (ref, page) => {
    const key = String(ref?.id || ref?.fileName || "") + "|" + (Number(page) || 0);
    if (!ref || !Number(page) || typeof referenceTextFor !== "function") return "";
    if (!referencePages.has(key)) referencePages.set(key, Promise.resolve().then(() => referenceTextFor(ref, Number(page))).catch(() => ""));
    return referencePages.get(key);
  };
  for (const finding of findingsToCheck || []) {
    const referenceQuote = referenceQuoteForFinding(finding);
    if (!numericCategory(finding?.category)
        || !String(finding?.quote || "").trim()
        || !referenceQuote) continue;
    const targetSource = await readTarget(finding.page);
    const reference = typeof referenceSourceFor === "function" ? referenceSourceFor(finding) : null;
    const referencePage = referencePagesForFinding(finding)[0] || null;
    const referenceSource = await readReference(reference, referencePage);
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
