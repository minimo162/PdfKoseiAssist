// Stable finding selection helpers.
//
// Finding ids are assigned when a response is parsed, so the same location can
// receive a different id when a later, better candidate replaces a dedupe
// representative.  Keep the user selection anchored to the source location
// instead of treating that transient id as identity.

export function normalizeSelectionText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    // Match dedupeFindings: PDF extraction may add/drop footnote markers
    // around the same quoted location (e.g. `...Yen)3` vs `...Yen)*3`).
    .replace(/[*＊†‡※§]/g, "")
    .replace(/[\s\u00a0\u3000]+/g, " ")
    .trim()
    .toLowerCase();
}

export function selectionAnchorForFinding(finding) {
  const f = finding || {};
  const referencePages = Array.isArray(f.referencePages)
    ? f.referencePages
    : (Number(f.referencePage) > 0 ? [f.referencePage] : []);
  return {
    id: String(f.id || ""),
    page: Number(f.page) || 0,
    quote: normalizeSelectionText(f.quote),
    area: normalizeSelectionText(f.areaHint || f.area_hint),
    category: normalizeSelectionText(f.category || f.displayCategory),
    referenceFile: normalizeSelectionText(f.referenceFile || f.reference_file),
    referencePages: referencePages.map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    referenceQuote: normalizeSelectionText(f.referenceQuote || f.reference_quote),
  };
}

function sameOrContained(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return Math.min(left.length, right.length) >= 12
    && (left.includes(right) || right.includes(left));
}

export function selectionMatchesAnchor(finding, anchor) {
  if (!finding || !anchor || (Number(finding.page) || 0) !== Number(anchor.page || 0)) return false;
  const quote = normalizeSelectionText(finding.quote);
  if (anchor.quote || quote) return sameOrContained(anchor.quote, quote);

  // Quote-less findings cannot be located by text.  Use the remaining stable
  // location fields, while allowing a representative to gain a better REF
  // citation during dedupe.
  const category = normalizeSelectionText(finding.category || finding.displayCategory);
  if (anchor.category && category && anchor.category !== category) return false;
  const area = normalizeSelectionText(finding.areaHint || finding.area_hint);
  if (anchor.area && area && anchor.area !== area) return false;
  const referenceFile = normalizeSelectionText(finding.referenceFile || finding.reference_file);
  if (anchor.referenceFile && referenceFile && anchor.referenceFile !== referenceFile) return false;
  if (anchor.referencePages.length) {
    const pages = (Array.isArray(finding.referencePages)
      ? finding.referencePages
      : (Number(finding.referencePage) > 0 ? [finding.referencePage] : []))
      .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (pages.length && JSON.stringify(pages) !== JSON.stringify(anchor.referencePages)) return false;
  }
  const referenceQuote = normalizeSelectionText(finding.referenceQuote || finding.reference_quote);
  return !anchor.referenceQuote || !referenceQuote || sameOrContained(anchor.referenceQuote, referenceQuote);
}

export function resolveSelectedFinding(findings, activeFindingId, anchor) {
  const list = Array.isArray(findings) ? findings : [];
  const byId = list.find(f => String(f?.id || "") === String(activeFindingId || ""));
  if (byId) return byId;
  return list.find(f => selectionMatchesAnchor(f, anchor)) || null;
}
