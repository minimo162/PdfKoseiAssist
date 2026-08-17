// Pure reference-document selection helpers for the PDF viewer.

function hasPositiveReferencePage(value) {
  if (Array.isArray(value)) return value.some(hasPositiveReferencePage);
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  return (value.match(/\d+(?:\.\d+)?/g) || []).some(token => Number(token) > 0);
}

export function hasReferenceEvidence(finding) {
  if (!finding) return false;
  const pageFields = [
    finding.referencePage,
    finding.reference_page,
    finding.referencePages,
    finding.reference_pages,
    finding.refPage,
    finding.ref_page,
    finding.refPages,
    finding.ref_pages,
    finding.referenceHighlightPage,
    finding.reference_highlight_page,
    finding.referenceHighlightPages,
    finding.reference_highlight_pages,
  ];
  if (pageFields.some(hasPositiveReferencePage)) return true;
  return [finding.referenceQuote, finding.reference_quote]
    .some(value => String(value ?? "").trim().length > 0);
}

export function resolveReferenceSelector(referenceList, value) {
  const refs = Array.isArray(referenceList) ? referenceList : [];
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "reference") return null;
  const id = raw.replace(/^reference:/i, "");
  return refs.find((item, index) => item?.id === id
    || item?.fileName === id
    || `REF${index + 1}_${item?.fileName}` === id) || null;
}

export function resolveReferenceForFinding(referenceList, finding) {
  const refs = Array.isArray(referenceList) ? referenceList : [];
  const named = String(finding?.referenceFile || finding?.reference_file || "").trim();
  if (named) return resolveReferenceSelector(refs, named);
  return refs.length === 1 ? refs[0] : null;
}

export function sourceForFinding(referenceList, finding, fallback = "target") {
  if (String(fallback || "target") === "target") return "target";
  if (finding && !hasReferenceEvidence(finding)) return "target";
  const named = String(finding?.referenceFile || finding?.reference_file || "").trim();
  // A named reference is an assertion about which document must be shown.
  // Never silently reuse the currently selected REF when that assertion cannot
  // be resolved (for example, after the file was removed).
  if (named) {
    const ref = resolveReferenceForFinding(referenceList, finding);
    return ref ? `reference:${ref.id}` : "target";
  }
  const ref = resolveReferenceForFinding(referenceList, finding);
  return ref ? `reference:${ref.id}` : fallback;
}

export function sourceForComparisonToggle(referenceList, rememberedId, finding) {
  if (finding && !hasReferenceEvidence(finding)) return "target";
  const remembered = resolveReferenceSelector(referenceList, rememberedId);
  // An explicit manual REF choice wins over the active finding's
  // referenceFile when the user returns from TARGET to comparison mode.
  return remembered
    ? `reference:${remembered.id}`
    : sourceForFinding(referenceList, finding, "reference");
}

export function referenceSelectionAfterRemoval(referenceList, source, selectedId) {
  const refs = Array.isArray(referenceList) ? referenceList : [];
  const selected = resolveReferenceSelector(refs, selectedId);
  if (String(source || "target") === "target") {
    return { source: "target", referenceId: selected?.id || refs[0]?.id || "", changed: false };
  }
  const current = resolveReferenceSelector(refs, source);
  return current
    ? { source: `reference:${current.id}`, referenceId: current.id, changed: false }
    : { source: "target", referenceId: "", changed: true };
}
