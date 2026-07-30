// score.mjs — Phase 0 ベンチマークスコアラ
//
// gold set（埋め込んだ既知誤り）と、あるrunの出力（findings / uncertain_candidates）を
// 突き合わせ、修正計画書 §2.1 の指標を算出する。
//
//   strict planted recall   : findings で検出できた planted の割合
//   assisted planted recall : findings ∪ uncertain_candidates で検出できた割合
//   findings precision      : findings のうち planted に対応した割合
//   candidate precision     : uncertain_candidates のうち planted に対応した割合
//   combined precision      : (findings ∪ uncertain) のうち planted に対応した割合
//   review burden           : packetあたり uncertain_candidates 件数
//
// マッチングは (page 一致) かつ (正規化 quote の部分一致) を既定とする。人手ラベリングを
// 補助する決定的な一次近似であり、最終判定は人が確認する前提（§10.4）。
//
// 実行:
//   node docs/benchmarks/score.mjs <gold.json> <run.json> [--match-window 0]
//
// 入力スキーマ:
//   gold.json: { "packets": [ { "packet_id": "P1",
//                 "planted": [ { "id":"e1", "page":7, "lens":"numbers", "quote":"12,345" }, ... ] } ] }
//   run.json : { "packets": [ { "packet_id": "P1",
//                 "findings": [ { "page":7, "quote":"12,345" }, ... ],
//                 "uncertain_candidates": [ { "page":8, "quote":"..." }, ... ] } ] }

import { readFileSync } from "node:fs";

function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s ]/g, "")
    .replace(/[,　]/g, "");
}

function quoteMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// planted 1件が、与えた候補配列のいずれかで検出されたか（page一致＋quote部分一致、±window）
function detected(planted, candidates, win) {
  return candidates.some(c =>
    Math.abs((Number(c.page) || -999) - (Number(planted.page) || 999)) <= win &&
    quoteMatch(planted.quote, c.quote)
  );
}

// 候補1件が、いずれかの planted に対応したか（precision の分子判定）
function isValid(cand, planted, win) {
  return planted.some(p =>
    Math.abs((Number(cand.page) || -999) - (Number(p.page) || 999)) <= win &&
    quoteMatch(p.quote, cand.quote)
  );
}

function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 1000) / 10; }

function main() {
  const args = process.argv.slice(2);
  const win = (() => {
    const i = args.indexOf("--match-window");
    return i >= 0 ? Number(args[i + 1]) || 0 : 0;
  })();
  const files = args.filter(a => !a.startsWith("--") && !/^\d+$/.test(a));
  if (files.length < 2) {
    console.error("usage: node docs/benchmarks/score.mjs <gold.json> <run.json> [--match-window N]");
    process.exit(2);
  }
  const gold = JSON.parse(readFileSync(files[0], "utf8"));
  const run = JSON.parse(readFileSync(files[1], "utf8"));

  const runByPacket = new Map((run.packets || []).map(p => [p.packet_id, p]));

  let plantedTotal = 0, strictHit = 0, assistedHit = 0;
  let findingsTotal = 0, findingsValid = 0;
  let candTotal = 0, candValid = 0;
  let combinedTotal = 0, combinedValid = 0;
  const burdenPerPacket = [];
  const perLens = new Map();

  for (const gp of gold.packets || []) {
    const rp = runByPacket.get(gp.packet_id) || {};
    const findings = rp.findings || [];
    const uncertain = rp.uncertain_candidates || [];
    const all = [...findings, ...uncertain];
    burdenPerPacket.push(uncertain.length);

    for (const planted of gp.planted || []) {
      plantedTotal++;
      const s = detected(planted, findings, win);
      const a = s || detected(planted, uncertain, win);
      if (s) strictHit++;
      if (a) assistedHit++;
      const lens = planted.lens || "unknown";
      const cur = perLens.get(lens) || { total: 0, strict: 0, assisted: 0 };
      cur.total++; if (s) cur.strict++; if (a) cur.assisted++;
      perLens.set(lens, cur);
    }

    findingsTotal += findings.length;
    for (const f of findings) if (isValid(f, gp.planted || [], win)) findingsValid++;
    candTotal += uncertain.length;
    for (const c of uncertain) if (isValid(c, gp.planted || [], win)) candValid++;
    combinedTotal += all.length;
    for (const x of all) if (isValid(x, gp.planted || [], win)) combinedValid++;
  }

  const avg = a => a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : 0;
  const p90 = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };

  const out = {
    planted_total: plantedTotal,
    strict_planted_recall_pct: pct(strictHit, plantedTotal),
    assisted_planted_recall_pct: pct(assistedHit, plantedTotal),
    findings_precision_pct: pct(findingsValid, findingsTotal),
    candidate_precision_pct: pct(candValid, candTotal),
    combined_precision_pct: pct(combinedValid, combinedTotal),
    review_burden: { avg: avg(burdenPerPacket), p90: p90(burdenPerPacket), max: burdenPerPacket.length ? Math.max(...burdenPerPacket) : 0 },
    per_lens: Object.fromEntries([...perLens.entries()].map(([k, v]) => [k, {
      strict_recall_pct: pct(v.strict, v.total),
      assisted_recall_pct: pct(v.assisted, v.total),
      planted: v.total,
    }])),
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
