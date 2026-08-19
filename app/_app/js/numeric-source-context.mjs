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
  // The browser owns the PDF.js document/page count.  Keep the count as an
  // injected option so this pure module does not depend on a DOM/PDF.js
  // global; callers may provide either a number or a resolver.
  referencePageCount,
  referenceTotalPages,
  referencePageCountFor,
  referenceTotalPagesFor,
  pageCountFor,
} = {}) {
  const contexts = new Map();
  const targetPages = new Map();
  const referencePages = new Map();
  const referenceDocumentScans = new Map();
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

  const referenceKey = ref => String(ref?.id || ref?.fileName || ref?.originalFileName || ref?.name || "");
  const readPageCount = async (ref, finding) => {
    const resolvers = [referencePageCountFor, referenceTotalPagesFor, pageCountFor]
      .filter(value => typeof value === "function");
    for (const resolver of resolvers) {
      try {
        const value = await resolver(ref, finding);
        const count = Number(value);
        if (Number.isFinite(count) && count > 0) return Math.floor(count);
      } catch {}
    }
    const direct = [
      referencePageCount,
      referenceTotalPages,
      ref?.pageCount,
      ref?.totalPages,
      ref?.numPages,
      ref?.doc?.numPages,
      ref?.page_count,
      finding?.reference_total_pages,
      finding?.referenceTotalPages,
    ];
    for (const value of direct) {
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) return Math.floor(count);
    }
    return 0;
  };

  const contextFromMatches = (targetMatch, referenceMatch, finding, referenceQuote) => ({
    targetText: targetMatch.text,
    referenceText: referenceMatch.text,
    targetRowText: targetMatch.rowText,
    referenceRowText: referenceMatch.rowText,
    targetRowLines: targetMatch.rowLines || [],
    referenceRowLines: referenceMatch.rowLines || [],
    targetQuote: finding.quote,
    referenceQuote,
    targetRowUnique: true,
    referenceRowUnique: true,
  });

  const findReferenceMatch = async (ref, finding, referenceQuote, reportedPages) => {
    if (!ref || typeof referenceTextFor !== "function") return null;
    const key = `${referenceKey(ref)}|${referenceQuote.normalize("NFKC")}`;
    // A reported page is authoritative when it contains a unique quote.  The
    // expensive document scan is deliberately a fallback only for a missing
    // or stale page annotation.
    for (const page of reportedPages) {
      const source = await readReference(ref, page);
      const match = findUniqueNumericSourceContext(source, referenceQuote);
      if (match?.unique) return match;
    }
    if (referenceDocumentScans.has(key)) return referenceDocumentScans.get(key);
    const scan = (async () => {
      const pageCount = await readPageCount(ref, finding);
      if (!pageCount) return null;
      const matches = [];
      for (let page = 1; page <= pageCount; page++) {
        if (reportedPages.includes(page)) continue;
        const source = await readReference(ref, page);
        const match = findUniqueNumericSourceContext(source, referenceQuote);
        // Document-wide uniqueness means every page-level occurrence counts.
        // Do not discard a second occurrence merely because PDF extraction
        // spreads it over more lines; doing so could bind the finding to the
        // wrong table and authorize a false-negative numeric suppression.
        if (match?.unique) matches.push({ page, match });
        // More than one page-level source match is not authoritative.  Keep
        // scanning only when a single match is still possible; the break saves
        // work but does not weaken the uniqueness requirement.
        if (matches.length > 1) return null;
      }
      return matches.length === 1 ? matches[0].match : null;
    })();
    referenceDocumentScans.set(key, scan);
    return scan;
  };

  for (const finding of findingsToCheck || []) {
    const referenceQuote = referenceQuoteForFinding(finding);
    if (!numericCategory(finding?.category)
        || !String(finding?.quote || "").trim()
        || !referenceQuote) continue;
    const targetSource = await readTarget(finding.page);
    const reference = typeof referenceSourceFor === "function" ? referenceSourceFor(finding) : null;
    const targetMatch = findUniqueNumericSourceContext(targetSource, finding.quote);
    if (!targetMatch?.unique) continue;
    const reportedPages = referencePagesForFinding(finding);
    const referenceMatch = await findReferenceMatch(reference, finding, referenceQuote, reportedPages);
    if (targetMatch?.unique && referenceMatch?.unique) {
      contexts.set(String(finding.id || ""), contextFromMatches(targetMatch, referenceMatch, finding, referenceQuote));
    }
  }
  return contexts;
}
