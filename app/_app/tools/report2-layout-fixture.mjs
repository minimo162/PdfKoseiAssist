// Extracted anchors from the attached report2 target PDF.
//
// The report quotes were emitted as a flat table-row string while the PDF text
// extractor keeps the row label and numeric cells in separate layout blocks.
// Keep this small fixture in source control so the location-aid-only helper
// can be tested without checking in the 27-page customer PDF.  Production
// quote validation deliberately rejects these cross-block quotes.
export const REPORT2_LAYOUT_FIXTURES = Object.freeze([
  {
    id: "F0017",
    packetPage: 15,
    sourcePage: 13,
    quote: "Balance at March 31, 143,459 137,450 66,601 407,675 339.8 19,051 1,924,950 2026",
    // The extracted row label and numeric cells are separate blocks, but the
    // corresponding PDF glyphs share one visual baseline.  Tests synthesize
    // per-character boxes from these measured-equivalent y coordinates.
    blockLineY: [100, 100, 100],
    blocks: [
      "Total changes during the period Balance at March 31 2026",
      "143,459 137,450 66,601 407,675 339.8 19,051",
      "1,924,950",
    ],
  },
  {
    id: "F0023",
    packetPage: 26,
    sourcePage: 24,
    quote: "Balance at March 31, 57,034 143,459 200,493 339.8 1,144,757 2026",
    blockLineY: [100, 100, 100],
    blocks: [
      "Total changes during the period Balance at March 31 2026",
      "57,034 143,459 200,493 339.8",
      "1,144,757",
    ],
  },
]);

export function normalizeReport2Locator(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
