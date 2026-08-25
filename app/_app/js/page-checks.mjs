// page-checks.mjs — Phase 5 (§10) 網羅マトリクスの厳密検証
//
// 新形式 page_checks（圧縮形式）を検証し、対象ページを 100% 覆うかを判定する。
//   { "ok_pages": "7,10-13,15", "exceptions": [ { "page": 8, "verdict": "finding" }, ... ] }
//
// 設計（計画書 §10.2）:
//   - 許可文字 / 昇順・降順range / 重複 / 対象外page / ok_pages と exceptions の重複
//   - 不正verdict / finding page に対応する finding があるか / 極端に長い range 文字列
//   - 空文字・null
//   - complete 条件は 100%: covered == expected（95% は表示用のみ）
//
// 純関数。ブラウザ／Node の両方から import 可能。

export const PAGE_CHECK_VERDICTS = ["finding", "unreadable", "skipped", "ok"];
const MAX_RANGE_STR = 2000; // 極端に長い range 文字列を拒否
const MAX_RANGE_EXPANSION = 10000;
const MAX_PAGE_NUMBER = 1000000;

// "7,10-13,15" → { pages:Set<number>, errors:[] }
export function parseOkPages(raw, expectedSet, errors) {
  const pages = new Set();
  if (raw === null || raw === undefined) return pages; // 空は許容（exceptions 側で全ページ説明もあり得る）
  const s = String(raw);
  if (s.length > MAX_RANGE_STR) { errors.push(`ok_pages が長すぎます（${s.length}文字）`); return pages; }
  if (s.trim() === "") return pages;
  if (!/^[0-9,\s\-]+$/.test(s)) { errors.push(`ok_pages に不正な文字があります: "${s}"`); return pages; }
  for (const tokenRaw of s.split(",")) {
    const token = tokenRaw.trim();
    if (token === "") continue;
    const m = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a > b) { errors.push(`range が降順です: "${token}"（昇順で記載してください）`); continue; }
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b > MAX_PAGE_NUMBER || b - a + 1 > MAX_RANGE_EXPANSION) {
        errors.push(`range が大きすぎます: "${token}"`); continue;
      }
      if (expectedSet?.size && (a < Math.min(...expectedSet) || b > Math.max(...expectedSet))) {
        errors.push(`対象外ページを含む range です: "${token}"`); continue;
      }
      for (let p = a; p <= b; p++) addPage(p, pages, expectedSet, errors);
    } else if (/^\d+$/.test(token)) {
      const page = Number(token);
      if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE_NUMBER) errors.push(`ページ番号が大きすぎます: "${token}"`);
      else addPage(page, pages, expectedSet, errors);
    } else {
      errors.push(`ok_pages のトークンが不正です: "${token}"`);
    }
  }
  return pages;
}

function addPage(p, pages, expectedSet, errors) {
  if (expectedSet && !expectedSet.has(p)) { errors.push(`対象外ページです: ${p}`); return; }
  if (pages.has(p)) { errors.push(`ok_pages にページ重複: ${p}`); return; }
  pages.add(p);
}

// findings は当該 pass の finding 配列（{page} を持つ）。verdict=finding の裏取りに使う。
export function validatePageChecks(pageChecks, expectedPages, findings = []) {
  const errors = [];
  const expectedSet = new Set((expectedPages || []).map(Number));
  if (pageChecks === null || pageChecks === undefined || typeof pageChecks !== "object") {
    return { ok: false, complete: false, covered: [], coverage: 0, errors: ["page_checks がありません"] };
  }
  const okPages = parseOkPages(pageChecks.ok_pages, expectedSet, errors);

  const covered = new Set(okPages);
  const findingPages = new Set((findings || []).map(f => Number(f.page)));
  const exceptions = Array.isArray(pageChecks.exceptions) ? pageChecks.exceptions : [];
  for (const ex of exceptions) {
    const p = Number(ex && ex.page);
    if (!Number.isInteger(p)) { errors.push(`exceptions.page が不正です: ${JSON.stringify(ex && ex.page)}`); continue; }
    if (expectedSet.size && !expectedSet.has(p)) { errors.push(`対象外ページの exception: ${p}`); continue; }
    const verdict = String(ex && ex.verdict || "");
    if (!PAGE_CHECK_VERDICTS.includes(verdict)) { errors.push(`不正な verdict: "${verdict}"（page ${p}）`); continue; }
    if (okPages.has(p)) { errors.push(`ok_pages と exceptions が重複: ${p}`); }
    if (verdict === "finding" && !findingPages.has(p)) {
      errors.push(`verdict=finding だが page ${p} に対応する finding がありません`);
    }
    covered.add(p);
  }

  const expectedCount = expectedSet.size || covered.size;
  const coverage = expectedCount ? covered.size / expectedCount : 1;
  // complete は 100% のみ（§10.2）。coverage_warning_threshold は表示用で complete には使わない。
  const complete = expectedSet.size > 0 && covered.size === expectedSet.size &&
    [...expectedSet].every(p => covered.has(p)) && errors.length === 0;
  return {
    ok: errors.length === 0,
    complete,
    covered: [...covered].sort((a, b) => a - b),
    missing: [...expectedSet].filter(p => !covered.has(p)).sort((a, b) => a - b),
    coverage,
    errors,
  };
}
