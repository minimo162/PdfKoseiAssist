export function isReferenceFreeConsistencyPacket(packet) {
  if (!packet || typeof packet !== "object") return false;
  return String(packet.kind || "").toLowerCase() === "consistency"
    && packet.has_ref === false;
}

export function scopeOrCategoryRequiresReferenceEvidence(finding, packet = null) {
  const f = finding || {};
  const scope = String(f.issueScope || f.issue_scope || "").toLowerCase();
  const category = String(f.category || "").toLowerCase();
  const referenceFreeConsistency = isReferenceFreeConsistencyPacket(packet);

  // A same-document consistency packet deliberately has no REF. Its
  // translation_consistency scope is a family label, not evidence that the
  // model compared a reference document. TARGET quote verification remains
  // mandatory in the caller. Explicit REF claims are checked separately.
  if (referenceFreeConsistency) return category === "mistranslation";
  // The importer rewrites a model-declared "consistency" scope to the
  // translation_consistency family for the numeric filters.  That rewrite is
  // not a REF claim: the proofreading prompt itself allows "consistency" for
  // TARGET-only document-internal findings (#151).
  const modelScope = String(f.modelIssueScope || f.model_issue_scope || "").toLowerCase();
  if (modelScope === "consistency") return ["translation_consistency", "mistranslation"].includes(category);
  return scope === "translation_consistency"
    || ["translation_consistency", "mistranslation"].includes(category);
}

export function shouldCommitExcludedOnlyPacket({
  isAutoImport = false,
  readError = "",
  candidateCount = 0,
  acceptedCount = 0,
} = {}) {
  return Boolean(
    isAutoImport
    && !String(readError || "").trim()
    && Number(candidateCount) > 0
    && Number(acceptedCount) === 0
  );
}
