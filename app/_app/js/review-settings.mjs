// UI state contract for the optional reference range and always-available review settings.

export function reviewControlState(hasReference) {
  const referenceEnabled = Boolean(hasReference);
  return Object.freeze({
    referenceRangeDisabled: !referenceEnabled,
    autoReferenceRangeDisabled: !referenceEnabled,
    reviewSettingsDisabled: false,
  });
}

export function applyReferenceBufferSetting(references, value, min = 0, max = 8) {
  const numeric = Number(value);
  const fallback = Number.isFinite(Number(min)) ? Number(min) : 0;
  const lower = Math.min(fallback, Number(max));
  const upper = Math.max(fallback, Number(max));
  const bufferPages = Number.isFinite(numeric)
    ? Math.min(upper, Math.max(lower, Math.round(numeric)))
    : lower;
  return Object.freeze({
    bufferPages,
    references: Object.freeze(Array.from(references || [], ref => ref && ({ ...ref, bufferPages }))),
  });
}
