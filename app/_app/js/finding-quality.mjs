export function mapFindingPage(rawPage, allowedPages, totalPages = 0) {
  const raw = Number(rawPage);
  if (!Number.isInteger(raw) || raw <= 0) return null;
  const page = raw;
  const allowed = allowedPages instanceof Set ? allowedPages : new Set(allowedPages || []);
  if (!allowed.has(page)) return null;
  if (Number(totalPages) > 0 && page > Number(totalPages)) return null;
  return page;
}

const parseProbability = raw => {
  if (raw === null || raw === undefined || raw === "") return { value: null, invalid: false };
  const value = Number(raw);
  return { value: Number.isFinite(value) && value >= 0 && value <= 1 ? value : null, invalid: !Number.isFinite(value) || value < 0 || value > 1 };
};

export function assessFindingEvidence({ confidence, readingConfidence, evidenceQuality, requireComplete = false } = {}) {
  const overall = parseProbability(confidence);
  const reading = parseProbability(readingConfidence);
  const quality = String(evidenceQuality || "").trim().toLowerCase();
  let excludedReason = "";
  if (overall.invalid || reading.invalid) excludedReason = "invalid-confidence";
  else if (quality && quality !== "clear") excludedReason = "low-evidence";
  else if (reading.value !== null && reading.value < 0.75) excludedReason = "low-reading-confidence";
  const missingEvidence = overall.value === null || reading.value === null || !quality;
  if (!excludedReason && requireComplete && missingEvidence) excludedReason = "missing-evidence";
  return {
    confidence: overall.value,
    readingConfidence: reading.value,
    evidenceQuality: quality,
    excludedReason,
    needsHumanReview: missingEvidence,
    warning: missingEvidence ? "根拠の確信度が欠けているため、人による確認が必要です。" : "",
  };
}

function normalizeSourceFragment(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")
    .replace(/[−‐‑‒–—―﹣－]/g, "-")
    .replace(/[“”„‟〝〟]/g, '"')
    .replace(/[‘’‚‛＇`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueOccurrenceIndex(haystack, needle) {
  if (!haystack || !needle) return -1;
  const first = haystack.indexOf(needle);
  if (first < 0) return -1;
  return haystack.indexOf(needle, first + Math.max(1, needle.length)) < 0 ? first : -1;
}

/**
 * マスク済みquoteをPDF本文へ戻す。
 * 復元済み候補が本文に一意にある場合はそれを優先し、数値ワイルドカードが
 * 複数行に当たる場合は最初の行を選ばずfail-closedにする。
 */
export function chooseSourceBackedFragment(masked, candidates, source) {
  const normalizedSource = normalizeSourceFragment(source);
  if (!normalizedSource) return "";
  const exact = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const normalized = normalizeSourceFragment(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const index = uniqueOccurrenceIndex(normalizedSource, normalized);
    if (index >= 0) exact.push({ candidate: String(candidate), normalized, index });
  }
  if (exact.length) {
    exact.sort((a, b) => b.normalized.length - a.normalized.length);
    const best = exact[0];
    const bestEnd = best.index + best.normalized.length;
    if (exact.every(item => item.index >= best.index && item.index + item.normalized.length <= bestEnd)) {
      return best.candidate;
    }
    return "";
  }

  const normalizedMasked = normalizeSourceFragment(masked);
  if (!normalizedMasked) return "";
  const parts = normalizedMasked.split(/(⟦#[A-Z]{3}⟧)/gi);
  const pattern = parts.map(part => /^⟦#[A-Z]{3}⟧$/i.test(part)
    ? String.raw`\d[\d,]*(?:\.\d+)?`
    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  let matches = [];
  try { matches = [...normalizedSource.matchAll(new RegExp(pattern, "gi"))].map(match => match[0]); }
  catch (_) { return ""; }
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : "";
}

function claimedMissingStructureNumbers(finding) {
  const text = [finding?.issueSummary, finding?.reason].map(String).join(" ");
  const numbers = new Set();
  const patterns = [
    /(?:項番|見出し番号|番号)\s*(?:が|の|は)?\s*(\d{1,3})\s*(?:を)?\s*(?:欠|抜|欠落|存在しな|見当たら|ない|ありません)/gi,
    /(?:missing|omitted|skipped|absent)\s+(?:item|section|number|no\.?\s*)?(\d{1,3})/gi,
    /(?:item|section|number|no\.?)\s*(\d{1,3})\s+(?:is\s+)?(?:missing|omitted|skipped|absent)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) numbers.add(Number(match[1]));
  }
  return numbers;
}

export function hasClaimedMissingStructureNumber(finding) {
  return claimedMissingStructureNumbers(finding).size > 0;
}

function normalizeStructureBody(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\s\-‐‑‒–—―•・*]+/, "")
    .replace(/^[\s(\[]*\d{1,3}\s*[)\].．:：-]\s*/, "")
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[^a-z0-9ぁ-んァ-ヶー一-龠々〆〇]+/g, "");
}

function quotedStructureBodies(value) {
  const text = String(value || "");
  const bodies = [];
  for (const pattern of [/「([^」]{6,240})」/g, /『([^』]{6,240})』/g, /“([^”]{6,240})”/g, /"([^"\r\n]{6,240})"/g]) {
    for (const match of text.matchAll(pattern)) bodies.push(match[1]);
  }
  return bodies;
}

function structureBodyCandidates(finding) {
  const raw = [finding?.quote];
  for (const value of [finding?.issueSummary, finding?.reason, finding?.suggestion]) {
    raw.push(...quotedStructureBodies(value));
  }
  return Array.from(new Set(raw.map(normalizeStructureBody).filter(body => body.length >= 12)));
}

/**
 * 「項番Nが無い」という主張を、同じ見出し本文を持つ実在の番号付き行で反証する。
 * ページ内の無関係な項番Nだけでは除外しない。
 */
export function isContradictedMissingStructureFinding(finding, pageText) {
  const missing = claimedMissingStructureNumbers(finding);
  if (!missing.size) return false;
  const candidateBodies = structureBodyCandidates(finding);
  if (!candidateBodies.length) return false;
  for (const line of String(pageText || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[([]?\s*(\d{1,3})\s*[)\].．:：]\s*(.+)$/);
    if (!match || !missing.has(Number(match[1]))) continue;
    const lineBody = normalizeStructureBody(match[2]);
    if (lineBody.length < 12) continue;
    if (candidateBodies.some(body => lineBody === body || lineBody.includes(body) || body.includes(lineBody))) return true;
  }
  return false;
}
