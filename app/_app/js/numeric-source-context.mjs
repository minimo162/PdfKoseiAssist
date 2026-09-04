import { findUniqueNumericSourceContext, numericQuoteOccursInSource } from "./review-merge.mjs";
import { referencePagesForFinding, referenceQuoteForFinding } from "./finding-reference-context.mjs";

const NUMERIC_CATEGORIES = new Set([
  "number_mismatch", "value_inconsistency", "accounting_inconsistency", "numbers",
]);

function numericCategory(value) {
  return NUMERIC_CATEGORIES.has(String(value || "").toLowerCase());
}

// Formatting/terminology findings normally do not enter the numeric source
// collector.  Admit only the narrow signed-oku surface shape handled by the
// review merge normalizer; ordinary prose formatting/terminology findings
// must remain outside this source-binding path.
const SIGNED_OKU_SURFACE_CORE = "(?:⟦#[A-Z]{3}⟧|\\d[\\d,，]*(?:\\.\\d+)?)";
const SIGNED_OKU_SURFACE_RE = new RegExp(
  `(?:[△▲+＋−-]\\s*)?(?:\\(\\s*${SIGNED_OKU_SURFACE_CORE}\\s*\\)|（\\s*${SIGNED_OKU_SURFACE_CORE}\\s*）|${SIGNED_OKU_SURFACE_CORE})\\s*(?:oku|億(?:円)?)(?![A-Za-z])`,
  "iu",
);
const SIGNED_OKU_SURFACE_GLOBAL_RE = new RegExp(SIGNED_OKU_SURFACE_RE.source, "giu");

function signedOkuSurfaceRemainder(value) {
  SIGNED_OKU_SURFACE_GLOBAL_RE.lastIndex = 0;
  return String(value || "")
    .normalize("NFKC")
    .replace(SIGNED_OKU_SURFACE_GLOBAL_RE, "__SIGNED_OKU_AMOUNT__")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function signedOkuSurfaceCandidate(finding, referenceQuote) {
  const category = String(finding?.category || "").toLowerCase();
  if (category !== "formatting" && category !== "terminology") return false;
  const quote = String(finding?.quote || "").trim();
  const reference = String(referenceQuote || "").trim();
  return Boolean(quote && reference
    && SIGNED_OKU_SURFACE_RE.test(quote)
    && SIGNED_OKU_SURFACE_RE.test(reference)
    && signedOkuSurfaceRemainder(quote) === signedOkuSurfaceRemainder(reference));
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
    // Preserve bounded proof that a canonical FY token came from the explicit
    // `FY March YYYY` source spelling.  The review facade uses this only after
    // both rows have been uniquely bound, when matching Japanese `YYYY年度`.
    targetMarchFiscalYears: targetMatch.marchFiscalYears || [],
    referenceMarchFiscalYears: referenceMatch.marchFiscalYears || [],
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
    let reportedMatch = null;
    for (const page of reportedPages) {
      const source = await readReference(ref, page);
      const match = findUniqueNumericSourceContext(source, referenceQuote);
      if (match?.unique) {
        if (reportedMatch) return null;
        reportedMatch = match;
        continue;
      }
      // The reported page contains the quote but cannot bind it uniquely
      // (for example the same row twice).  That page is the model's own
      // claim; skipping it to bind a different page's table would authorize
      // a numeric suppression from the wrong source.  Fail closed (#130).
      if (numericQuoteOccursInSource(source, referenceQuote)) return null;
    }
    if (reportedMatch) return reportedMatch;
    if (referenceDocumentScans.has(key)) return referenceDocumentScans.get(key);
    const scan = (async () => {
      const pageCount = await readPageCount(ref, finding);
      if (!pageCount) return reportedMatch;
      const matches = [];
      const compact = value => String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
      const needle = compact(referenceQuote);
      let literalOccurrences = 0;
      for (let page = 1; page <= pageCount; page++) {
        const source = await readReference(ref, page);
        const haystack = compact(source);
        if (needle) {
          let offset = 0;
          while ((offset = haystack.indexOf(needle, offset)) >= 0) {
            literalOccurrences += 1;
            if (literalOccurrences > 1) return null;
            offset += Math.max(1, needle.length);
          }
        }
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
    if (!(numericCategory(finding?.category) || signedOkuSurfaceCandidate(finding, referenceQuote))
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
