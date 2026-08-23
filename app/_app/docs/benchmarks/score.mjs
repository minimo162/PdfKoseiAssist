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
// 跨ぎの誤りは「どちらのページを主たる箇所として報告するか」が指摘側の自由になる
// （26ページ版の e14 で実際に取りこぼした）。そこで planted は `alt` に相手方の
// (page, quote) を持てる。primary と alt のどちらで報告されても検出とみなす。
//
// 実行:
//   node docs/benchmarks/score.mjs <gold.json> <run.json> [--match-window 0] [--by kind,distance]
//
//   --by <field,...>   planted の任意のフィールドで recall を分類して per_<field> に出す。
//                      長尺フィクスチャの「距離別 recall」「種類別 recall」はこれで見る。
//   --reachable <幅>   その幅では原理的に検出できない planted を分母から外す
//   --no-ref           REFを渡していない run 用。原文が無いと判定できない観点を分母から外す。
//   --scope <モード>   そのモードが担当する観点だけを分母にする（consistency / proofread）。
//                      「原文が要るか」と「そのモードの担当か」は別の軸なので、--no-ref とは別に要る。
//                      例: spelling は REF 無しでも判定できるが、整合性モードの担当ではない。
//
// 入力スキーマ:
//   gold.json: { "packets": [ { "packet_id": "P1",
//                 "planted": [ { "id":"e1", "page":7, "lens":"numbers", "quote":"12,345",
//                                "alt": [ { "page":22, "quote":"..." } ] }, ... ] } ] }
//   run.json : { "packets": [ { "packet_id": "P1",
//                 "findings": [ { "page":7, "quote":"12,345" }, ... ],
//                 "uncertain_candidates": [ { "page":8, "quote":"..." }, ... ] } ] }

import { readFileSync } from "node:fs";
import { buildCalibrationReport } from "./calibration.mjs";

// 照合用の正規化。
// ⚠️ 脚注記号（* ※ †）は落とす。指摘側が `*3` を `3` と書き写すのは頻繁に起きる
//    （26ページ版の e26、200ページ版の sl02 で実際に取りこぼした）。
//    記号の有無だけで「未検出」と数えると、実力より低く出る。
//    数値・句読点は落とさない（それ自体が指摘対象になりうるため）。
function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s ]/g, "")
    .replace(/[,　]/g, "")
    .replace(/[*※†]/g, "");
}

function quoteMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// planted が「これで報告されたら検出とみなす」位置の一覧。alt は跨ぎの相手方。
function targetsOf(planted) {
  const list = [{ page: planted.page, quote: planted.quote }];
  for (const a of planted.alt || []) list.push({ page: a.page, quote: a.quote });
  return list;
}

function hits(target, cand, win) {
  return Math.abs((Number(cand.page) || -999) - (Number(target.page) || 999)) <= win &&
    quoteMatch(target.quote, cand.quote);
}

// planted 1件が、与えた候補配列のいずれかで検出されたか（page一致＋quote部分一致、±window）
function detected(planted, candidates, win) {
  return targetsOf(planted).some(t => candidates.some(c => hits(t, c, win)));
}

// 候補1件が、いずれかの planted に対応したか（precision の分子判定）
function isValid(cand, planted, win) {
  return planted.some(p => targetsOf(p).some(t => hits(t, cand, win)));
}

function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 1000) / 10; }

function main() {
  const args = process.argv.slice(2);
  const opts = { "--match-window": "0", "--by": "", "--reachable": "", "--no-ref": false, "--scope": "" };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (Object.prototype.hasOwnProperty.call(opts, args[i])) {
      // 真偽値のフラグは値を取らない（次の引数を食うとファイル名が消える）。
      if (typeof opts[args[i]] === "boolean") { opts[args[i]] = true; continue; }
      opts[args[i]] = args[++i] ?? ""; continue;
    }
    if (args[i].startsWith("--")) continue;
    files.push(args[i]);
  }
  const win = Number(opts["--match-window"]) || 0;
  const byFields = opts["--by"].split(",").map(s => s.trim()).filter(Boolean);
  if (files.length < 2) {
    console.error("usage: node docs/benchmarks/score.mjs <gold.json> <run.json> [--match-window N] [--by kind,distance]");
    process.exit(2);
  }
  const gold = JSON.parse(readFileSync(files[0], "utf8"));
  const run = JSON.parse(readFileSync(files[1], "utf8"));

  // --reachable <幅>: その幅では原理的に検出できない planted を分母から外す。
  // 跨ぎの誤りは両ページが同じセクションに入らないと取りようがないので、
  // これを外さないと「幅を広げたら悪くなった」のか「そもそも届いていない」のか区別できない。
  let reachableNote = null;
  if (opts["--reachable"]) {
    const key = String(opts["--reachable"]);
    const ids = (gold.reachability || {})[key];
    if (!ids) {
      console.error(`--reachable ${key}: gold に reachability["${key}"] が無い（利用可能: ${Object.keys(gold.reachability || {}).join(", ") || "なし"}）`);
      process.exit(2);
    }
    const keep = new Set(ids);
    let dropped = 0;
    for (const gp of gold.packets || []) {
      // 絞り込むのは recall の分母だけ。precision の判定には全 planted を使う。
      // 届かないはずの誤りを正しく拾えた場合、それを誤検知に数えては話が逆になる。
      gp.planted_all = gp.planted || [];
      gp.planted = gp.planted_all.filter(p => keep.has(p.id));
      dropped += gp.planted_all.length - gp.planted.length;
    }
    reachableNote = { width: Number(key) || key, overlap: gold.reachability_overlap ?? null, excluded: dropped };
  }

  // --no-ref: 日本語原文(REF)を渡していない run を採点するときに使う。
  //
  // ⚠️ 原文が無ければ判定できない観点を分母に残してはいけない。担当範囲外だからである。
  //    さらに悪いことに、**残すと数字が正しく見えてしまう**。実測（幅100・REFなし）で
  //    omission が 100% と出たが、中身を見るとモデルは
  //    「These figures are calculated based on internal management materials」を
  //    「指示対象が不明瞭」として指摘していた。planted は同じ文の後続節が落ちたものなので、
  //    ページも引用も一致し、採点器は「訳抜けを検出した」と数える。
  //    **理由がまったく違うのに、quote 一致では区別できない。**
  //    そのまま幅の比較に使うと、担当外の観点の偶然の一致で幅を決めてしまう。
  let scopeNote = null;
  if (opts["--no-ref"]) {
    const REF_REQUIRED_KINDS = ["omission", "supply", "over", "num-tr", "name-tr"];
    const drop = new Set(REF_REQUIRED_KINDS);
    let dropped = 0;
    for (const gp of gold.packets || []) {
      gp.planted_all = gp.planted_all || gp.planted || [];
      const before = (gp.planted || []).length;
      gp.planted = (gp.planted || []).filter(p => !drop.has(p.kind));
      dropped += before - gp.planted.length;
    }
    scopeNote = { mode: "no-ref", excluded_kinds: REF_REQUIRED_KINDS, excluded: dropped };
  }

  // --scope <モード>: そのモードが担当する観点だけを分母にする。
  //
  // 「原文が要るか」（--no-ref）と「そのモードの担当か」は別の軸である。
  // 例えば spelling / grammar は REF が無くても判定できるので --no-ref では残るが、
  // 26ページ版の実測どおり**整合性モードの担当ではない**（各行精読が要る＝校正10pの担当）。
  // 担当外を分母に残したまま幅を比べると、幅の効果ではなく分担のずれを見てしまう。
  const SCOPES = {
    // 整合性: 離れた2箇所を突き合わせないと出ないものだけ。REFは添付していない。
    // accounting（会計連動）は廃止した。マスクした状態では記号を足すことになり成立しない。
    // drift（訳語の揺れ）は外す。原文が同じことを知らないと判定できない層で、
    // REF を添付しない整合性モードでは原理的に取れない。校正パケット(10p)も跨げないので、
    // **どちらのモードも担当しない**。素材には残してあるが、担当範囲の分母には入れない。
    consistency: ["term", "number", "number-local", "structure", "structure-local"],
    // 校正パケット: 1ページ〜10ページの窓で完結するもの。REFを添付する。
    proofread: ["spelling", "grammar", "omission", "supply", "over", "num-tr", "name-tr"],
  };
  if (opts["--scope"]) {
    const name = String(opts["--scope"]);
    const keepKinds = SCOPES[name];
    if (!keepKinds) {
      console.error(`--scope ${name}: 未知のモード（利用可能: ${Object.keys(SCOPES).join(", ")}）`);
      process.exit(2);
    }
    const keep = new Set(keepKinds);
    let dropped = 0;
    for (const gp of gold.packets || []) {
      gp.planted_all = gp.planted_all || gp.planted || [];
      const before = (gp.planted || []).length;
      gp.planted = (gp.planted || []).filter(p => keep.has(p.kind));
      dropped += before - gp.planted.length;
    }
    scopeNote = { ...(scopeNote || {}), mode: scopeNote ? `${scopeNote.mode}+${name}` : name,
      scope_kinds: keepKinds, excluded: (scopeNote?.excluded || 0) + dropped };
  }

  const runByPacket = new Map((run.packets || []).map(p => [p.packet_id, p]));

  let plantedTotal = 0, strictHit = 0, assistedHit = 0;
  let findingsTotal = 0, findingsValid = 0;
  let candTotal = 0, candValid = 0;
  let combinedTotal = 0, combinedValid = 0;
  const burdenPerPacket = [];
  const perLens = new Map();
  const perField = new Map(byFields.map(f => [f, new Map()]));   // field -> 値 -> {total,strict,assisted}
  let ignoredHits = 0;
  const missed = [];

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
      for (const f of byFields) {
        const key = String(planted[f] ?? "unknown");
        const m = perField.get(f);
        const v = m.get(key) || { total: 0, strict: 0, assisted: 0 };
        v.total++; if (s) v.strict++; if (a) v.assisted++;
        m.set(key, v);
      }
      if (!a) missed.push(planted.id || `${planted.page}:${planted.quote}`.slice(0, 40));
    }

    const forPrecision = gp.planted_all || gp.planted || [];
    // gold.ignored: 正しいが誤りではない指摘（例: 英訳版に無いのが正しいページの指摘）。
    // 誤検知に数えると precision が実態より低く出るので、分母から外す。
    // 読む手間は残るので review_burden からは外さない。
    const isIgnored = c => (gold.ignored || []).some(g =>
      Math.abs((Number(c.page) || -999) - (Number(g.page) || 999)) <= win && quoteMatch(g.quote, c.quote));
    const liveF = findings.filter(f => !isIgnored(f));
    const liveC = uncertain.filter(c => !isIgnored(c));
    ignoredHits += (findings.length - liveF.length) + (uncertain.length - liveC.length);
    findingsTotal += liveF.length;
    for (const f of liveF) if (isValid(f, forPrecision, win)) findingsValid++;
    candTotal += liveC.length;
    for (const c of liveC) if (isValid(c, forPrecision, win)) candValid++;
    combinedTotal += liveF.length + liveC.length;
    for (const x of [...liveF, ...liveC]) if (isValid(x, forPrecision, win)) combinedValid++;
  }

  const avg = a => a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : 0;
  const p90 = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };

  const calibrationRecords = (run.packets || []).flatMap(packet => {
    const sources = [
      ...(packet.findings || []).map(finding => ({ ...finding, record_kind: "finding" })),
      ...(packet.uncertain_candidates || []).map(candidate => ({ ...candidate, record_kind: "candidate" })),
      ...((packet.candidate_ledger?.candidates || []).map(candidate => ({ ...candidate, record_kind: "ledger_candidate" }))),
      ...((packet.candidate_ledger?.suppressions || []).map(suppression => ({ ...suppression, state: "suppressed", record_kind: "suppression" }))),
    ];
    return sources.map(finding => ({
      ...finding,
      category: finding.category || finding.lens || finding.kind || "unknown",
      prompt_version: finding.prompt_version || packet.prompt_version || run.prompt_version || "unknown",
      model_label: finding.model_label || packet.model_label || run.model_label || "unknown",
      independent_agreement: finding.independent_agreement ?? packet.independent_agreement,
      holdout: finding.holdout === true || packet.holdout === true || run.holdout === true || finding.split === "holdout" || packet.split === "holdout" || run.split === "holdout",
    }));
  });
  const calibration = calibrationRecords.some(record => record.confidence !== undefined && record.confidence !== null)
    ? buildCalibrationReport(calibrationRecords)
    : null;
  const out = {
    ...(calibration ? { calibration } : {}),
    ...(reachableNote ? { reachable_only: reachableNote } : {}),
    ...(scopeNote ? { scope: scopeNote } : {}),
    planted_total: plantedTotal,
    strict_planted_recall_pct: pct(strictHit, plantedTotal),
    assisted_planted_recall_pct: pct(assistedHit, plantedTotal),
    findings_precision_pct: pct(findingsValid, findingsTotal),
    candidate_precision_pct: pct(candValid, candTotal),
    combined_precision_pct: pct(combinedValid, combinedTotal),
    ...(ignoredHits ? { ignored_hits: ignoredHits } : {}),
    review_burden: { avg: avg(burdenPerPacket), p90: p90(burdenPerPacket), max: burdenPerPacket.length ? Math.max(...burdenPerPacket) : 0 },
    per_lens: Object.fromEntries([...perLens.entries()].map(([k, v]) => [k, {
      strict_recall_pct: pct(v.strict, v.total),
      assisted_recall_pct: pct(v.assisted, v.total),
      planted: v.total,
    }])),
    missed_ids: missed,
  };
  // 数値キーは数値順、それ以外は辞書順（距離別を読みやすくするため）
  const sortKeys = ks => ks.every(k => /^\d+$/.test(k))
    ? ks.sort((a, b) => Number(a) - Number(b)) : ks.sort();
  for (const [field, m] of perField) {
    out[`per_${field}`] = Object.fromEntries(sortKeys([...m.keys()]).map(k => {
      const v = m.get(k);
      return [k, { strict_recall_pct: pct(v.strict, v.total), assisted_recall_pct: pct(v.assisted, v.total), planted: v.total }];
    }));
  }
  console.log(JSON.stringify(out, null, 2));
}

main();
