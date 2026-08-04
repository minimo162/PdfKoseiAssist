// report-to-run.mjs — 指摘ZIPの「指摘.json」を score.mjs が読める run.json に変換する。
//
//   node docs/benchmarks/report-to-run.mjs <指摘.json> --out docs/benchmarks/runs/<名前>.json \
//        [--note "幅25・重ね3・4pass"]
//
// これまで run.json は画面の出力を手で書き写して作っていた。43件の planted に対して
// 指摘が数十件出る規模になると、書き写しの誤りが測定誤差と区別できなくなる。
// 指摘ZIPには機械可読な「指摘.json」がそのまま入っているので、それを使う。
//
// 対応付け:
//   needs_human_review = false → findings（strict recall / findings precision の対象）
//   needs_human_review = true  → uncertain_candidates（assisted recall の対象）
//   excluded_reason あり       → 既定では除外（体裁指摘。レポート画面でも既定で非表示）
//                                --include-excluded で findings 側に含める

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const opts = { "--out": "", "--note": "", "--packet-id": "ALL" };
const flags = new Set(["--include-excluded"]);
const files = [];
for (let i = 0; i < args.length; i++) {
  if (Object.prototype.hasOwnProperty.call(opts, args[i])) { opts[args[i]] = args[++i] ?? ""; continue; }
  if (flags.has(args[i])) { opts[args[i]] = true; continue; }
  if (args[i].startsWith("--")) { console.error(`不明なオプション: ${args[i]}`); process.exit(2); }
  files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node docs/benchmarks/report-to-run.mjs <指摘.json> --out <run.json> [--note "..."] [--include-excluded]');
  process.exit(2);
}

const src = JSON.parse(readFileSync(files[0], "utf8"));
const all = Array.isArray(src.findings) ? src.findings : [];
if (!all.length) console.error("警告: findings が空です（指摘0件の run か、ファイルが違う可能性があります）");

const pick = r => ({ page: Number(r.page), quote: String(r.quote || "") });
const excluded = all.filter(r => r.excluded_reason);
const live = opts["--include-excluded"] ? all : all.filter(r => !r.excluded_reason);
const findings = live.filter(r => !r.needs_human_review).map(pick);
const uncertain = live.filter(r => r.needs_human_review).map(pick);

const noQuote = [...findings, ...uncertain].filter(f => !f.quote || !Number.isInteger(f.page));
if (noQuote.length) {
  // quote が無い指摘は page+quote 方式では採点できない。件数を出して人が判断できるようにする。
  console.error(`警告: page または quote が欠けた指摘が ${noQuote.length} 件あります（採点では外れます）`);
}

const out = {
  note: opts["--note"] || `${src.file_name || ""} ${src.exported_at_local || ""}`.trim(),
  source: { file_name: src.file_name || "", exported_at: src.exported_at || "", app_version: src.app_version || "" },
  counts: { total: all.length, findings: findings.length, uncertain: uncertain.length, excluded: excluded.length },
  packets: [{ packet_id: opts["--packet-id"], findings, uncertain_candidates: uncertain }],
};

const dest = opts["--out"];
if (dest) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log(`${dest}: findings ${findings.length} / uncertain ${uncertain.length} / 体裁除外 ${excluded.length}`);
} else {
  console.log(JSON.stringify(out, null, 2));
}
