// Pure reference-document selection helpers for the PDF viewer.

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
