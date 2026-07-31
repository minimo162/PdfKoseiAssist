// sectioning.mjs — 整合性レビュー用のセクション分割（文書非依存）
//
// 校正パケット（約10p・各行精読）とは別に、跨ぎ整合を見るための大きめ「セクション」を作る。
// 文書の種類に依存しない：既定は等幅ウィンドウ＋重ね、手動の区切りページ指定で上書き可能。
// REF（日本語原文）範囲はセクションごとに比率マッピング＋広めバッファで対応（ページズレ吸収）。
// 上限は設けない（Copilot が破綻しうる巨大セクションはソフト警告で知らせる方針）。
//
// 純関数。ブラウザ／Node 両用。node tools/Test-Sectioning.mjs で検証。

// 総ページ → セクション配列 [{ index, startPage, endPage, pageCount }]
export function computeSections(totalPages, opts = {}) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const width = Math.max(1, Math.floor(Number(opts.sectionWidth) || 25));
  const overlap = Math.max(0, Math.min(width - 1, Math.floor(Number(opts.overlap ?? 3))));
  const breakpoints = Array.isArray(opts.breakpoints) ? opts.breakpoints : null;
  const sections = [];

  if (breakpoints && breakpoints.length) {
    // 手動: 区切りページ（各セクションの開始ページ）を尊重。重ねは付けない（指定どおり）。
    const starts = [1, ...breakpoints]
      .map(n => Math.floor(Number(n)))
      .filter(n => Number.isFinite(n) && n >= 1 && n <= total);
    const uniq = [...new Set(starts)].sort((a, b) => a - b);
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
  if (tb && rb && tb.length && rb.length) {
    const tStarts = [1, ...tb].map(Number).filter(n => n >= 1).sort((a, b) => a - b);
    const rStarts = [1, ...rb].map(Number).filter(n => n >= 1).sort((a, b) => a - b);
    const i = tStarts.findIndex((s, idx) =>
      section.startPage >= s && (idx + 1 >= tStarts.length || section.startPage < tStarts[idx + 1]));
    if (i >= 0 && i < rStarts.length) {
      const refStart = Math.max(1, rStarts[i] - buffer);
      const refEnd = Math.min(refTotal, (i + 1 < rStarts.length ? rStarts[i + 1] - 1 : refTotal) + buffer);
      return { refStart, refEnd, refPageCount: refEnd - refStart + 1, mode: 'manual' };
    }
  }

  // 比率マッピング＋バッファ。
  const rawStart = 1 + Math.floor((section.startPage - 1) * refTotal / targetTotal);
  const rawEnd = Math.ceil(section.endPage * refTotal / targetTotal);
  const refStart = Math.max(1, rawStart - buffer);
  const refEnd = Math.min(refTotal, rawEnd + buffer);
  return { refStart, refEnd, refPageCount: refEnd - refStart + 1, mode: 'ratio' };
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
