// review-merge.mjs — Phase 4/§11 finding統合
//
// 計画書 §11 / 改善原則5「重複は即削除せず、まず束ねる」:
//   - exact dedupe: page | category | normalized_quote | normalized_suggestion が完全一致
//     したものだけを自動削除する。
//   - similar group: page | category | normalized_quote が一致するものは削除せず、同一箇所の
//     候補として束ねる。異なる suggestion を失わない（V2 の過剰削除バグの是正）。
//
// 純関数。ブラウザ／Node の両方から import 可能。

export function normalizeQuote(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s 　]+/g, " ")
    .trim();
}

function exactKey(f) {
  return [f.page, f.category, normalizeQuote(f.quote), normalizeQuote(f.suggestion)]
    .map(v => String(v == null ? "" : v)).join("|");
}

function groupKey(f) {
  return [f.page, f.category, normalizeQuote(f.quote)]
    .map(v => String(v == null ? "" : v)).join("|");
}

// 完全重複だけを除去する（順序保持、最初の1件を残す）。
export function exactDedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings || []) {
    const k = exactKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// exact dedupe 後に、同一箇所（page|category|normalized_quote）を候補として束ねる。
// 代表は先頭、others に別案を保持する。異なる suggestion は失わない。
export function groupSimilar(findings) {
  const map = new Map();
  for (const f of findings || []) {
    const k = groupKey(f);
    if (!map.has(k)) {
      map.set(k, { key: k, representative: f, members: [f] });
    } else {
      map.get(k).members.push(f);
    }
  }
  return [...map.values()].map(g => ({
    key: g.key,
    page: g.representative.page,
    category: g.representative.category,
    quote: g.representative.quote,
    representative: g.representative,
    count: g.members.length,
    candidates: g.members.map(m => ({
      suggestion: m.suggestion,
      reason: m.reason,
      pass_id: m.pass_id ?? m.passId ?? null,
      pass_lens: m.pass_lens ?? m.passLens ?? null,
      confidence: m.confidence ?? null,
      evidence_quality: m.evidence_quality ?? m.evidenceQuality ?? null,
    })),
  }));
}

// 統合パイプライン: exact dedupe → similar group。集計値も返す。
export function integrateFindings(findings) {
  const input = Array.isArray(findings) ? findings : [];
  const deduped = exactDedupe(input);
  const groups = groupSimilar(deduped);
  return {
    findings_new: deduped.length,
    findings_exact_dup: input.length - deduped.length,
    finding_groups: groups.length,
    deduped,
    groups,
  };
}
