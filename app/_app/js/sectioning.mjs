// sectioning.mjs — 整合性レビュー用のセクション分割（文書非依存）
//
// 校正パケット（約10p・各行精読）とは別に、跨ぎ整合を見るための大きめ「セクション」を作る。
// 文書の種類に依存しない：既定は等幅ウィンドウ＋重ね、手動の区切りページ指定で上書き可能。
// REF（日本語原文）範囲はセクションごとに比率マッピング＋広めバッファで対応（ページズレ吸収）。
// 上限は設けない（Copilot が破綻しうる巨大セクションはソフト警告で知らせる方針）。
//
// 純関数。ブラウザ／Node 両用。node tools/Test-Sectioning.mjs で検証。

function normalizedStarts(values, total) {
  return [...new Set([1, ...(Array.isArray(values) ? values : [])]
    .map(value => Math.floor(Number(value)))
    .filter(value => Number.isFinite(value) && value >= 1 && value <= total))]
    .sort((a, b) => a - b);
}

// 総ページ → セクション配列 [{ index, startPage, endPage, pageCount }]
export function computeSections(totalPages, opts = {}) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const width = Math.max(1, Math.floor(Number(opts.sectionWidth) || 25));
  const overlap = Math.max(0, Math.min(width - 1, Math.floor(Number(opts.overlap ?? 3))));
  const breakpoints = Array.isArray(opts.breakpoints) ? opts.breakpoints : null;
  const sections = [];

  if (breakpoints && breakpoints.length) {
    // 手動: 区切りページ（各セクションの開始ページ）を尊重。重ねは付けない（指定どおり）。
    const uniq = normalizedStarts(breakpoints, total);
    for (let i = 0; i < uniq.length; i++) {
      const start = uniq[i];
      const end = i + 1 < uniq.length ? uniq[i + 1] - 1 : total;
      if (end < start) continue;
      sections.push({ index: sections.length, startPage: start, endPage: end, pageCount: end - start + 1 });
    }
    return sections;
  }

  // 既定: 等幅ウィンドウ＋重ね（境界跨ぎの整合を落とさないため前セクションと overlap ページ共有）。
  let start = 1;
  while (start <= total) {
    const end = Math.min(total, start + width - 1);
    sections.push({ index: sections.length, startPage: start, endPage: end, pageCount: end - start + 1 });
    if (end >= total) break;
    start = end - overlap + 1;
  }

  // 末尾が極端に短いセクションは前へ畳む。
  // 例: 26p を width25/overlap3 で割ると 1-25 と 23-26 になり、たった4ページのために
  // Copilot への往復が1回増え、重ね合わせ区間 P23-25 で同じ誤りが二重に出る（実測で発生）。
  // 少しだけ幅を超えても1セクションにまとめたほうが速く、重複も出ない。
  const minTail = Math.max(1, Math.floor(Number(opts.minLastSection ?? Math.ceil(width * 0.4))));
  if (sections.length > 1) {
    const last = sections[sections.length - 1];
    const prev = sections[sections.length - 2];
    // 前セクションに畳み込んでも「元の幅＋末尾の長さ」で済む場合だけ実施する。
    const maxMergedPages = Math.max(width, Math.floor(Number(opts.maxMergedSection ?? width + last.pageCount)));
    if (last.pageCount < minTail && last.endPage - prev.startPage + 1 <= maxMergedPages) {
      sections.pop();
      prev.endPage = last.endPage;
      prev.pageCount = prev.endPage - prev.startPage + 1;
    }
  }
  return sections;
}

// セクションに対応する REF（原文）ページ範囲を求める。
// 既定: TARGET総ページ→REF総ページの比率で線形マッピング＋バッファ（ページズレ吸収、上限なし）。
// refBreakpoints（TARGET区切りと並行なREF区切り）が与えられれば、その区間対応を優先（比率より正確）。
export function mapRefRange(section, opts = {}) {
  const targetTotal = Math.max(1, Math.floor(Number(opts.targetTotal) || 1));
  const refTotal = Math.max(1, Math.floor(Number(opts.refTotal) || 1));
  const buffer = Math.max(0, Math.floor(Number(opts.buffer ?? 5)));

  // 手動REF区切り（targetBreakpoints と 1:1 対応）があれば、その区間を使う。
  const tb = Array.isArray(opts.targetBreakpoints) ? opts.targetBreakpoints : null;
  const rb = Array.isArray(opts.refBreakpoints) ? opts.refBreakpoints : null;
  let breakpointMismatch = false;
  if (tb && rb && tb.length && rb.length) {
    const tStarts = normalizedStarts(tb, targetTotal);
    const rStarts = normalizedStarts(rb, refTotal);
    breakpointMismatch = tStarts.length !== rStarts.length;
    if (!breakpointMismatch) {
    const intervalAt = page => tStarts.findIndex((s, idx) => page >= s && (idx + 1 >= tStarts.length || page < tStarts[idx + 1]));
    const first = intervalAt(section.startPage);
    const last = intervalAt(section.endPage);
    if (first >= 0 && last >= first && last < rStarts.length) {
      const refStart = Math.max(1, rStarts[first] - buffer);
      const refEnd = Math.min(refTotal, (last + 1 < rStarts.length ? rStarts[last + 1] - 1 : refTotal) + buffer);
      return { refStart, refEnd, refPageCount: refEnd - refStart + 1, mode: 'manual' };
    }
    }
  }

  // 比率マッピング＋バッファ。
  const rawStart = 1 + Math.floor((section.startPage - 1) * refTotal / targetTotal);
  const rawEnd = Math.ceil(section.endPage * refTotal / targetTotal);
  const refStart = Math.max(1, rawStart - buffer);
  const refEnd = Math.min(refTotal, rawEnd + buffer);
  return {
    refStart, refEnd, refPageCount: refEnd - refStart + 1, mode: 'ratio',
    ...(breakpointMismatch ? { breakpointWarning: 'breakpoint-count-mismatch' } : {}),
  };
}

// ソフト警告: 巨大セクションは Copilot が破綻しうる。閾値超過を検知して呼び出し側で警告する。
export function sectionWarnings(section, refRange, opts = {}) {
  const softMax = Math.floor(Number(opts.softMaxPages) || 40);
  const warnings = [];
  const combined = section.pageCount + (refRange && refRange.refPageCount ? refRange.refPageCount : 0);
  if (section.pageCount > softMax) warnings.push(`section ${section.index}: TARGET ${section.pageCount}p が目安 ${softMax}p を超過`);
  if (combined > softMax * 2) warnings.push(`section ${section.index}: TARGET+REF ${combined}p が大きすぎる可能性（Copilotが破綻しうる）`);
  return warnings;
}
