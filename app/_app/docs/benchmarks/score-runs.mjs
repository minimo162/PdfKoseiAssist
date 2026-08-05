// score-runs.mjs — Run-Benchmark.ps1 が保存した生の指摘JSONを、構成ごとに正しい分母で採点する。
//
//   node docs/benchmarks/score-runs.mjs docs/benchmarks/runs/raw/2026-08-05_*.json
//   node docs/benchmarks/score-runs.mjs docs/benchmarks/runs/raw          # ディレクトリでもよい
//
// 幅の比較で最も間違えやすいのは**分母の取り違え**である。
//   - `--reachable` を run の幅に合わせないと、その幅では原理的に届かない誤りまで分母に入る
//   - `--scope` を付けないと、そのモードの担当外の観点が偶然一致して数字を持ち上げる
//     （実測: 幅100・REFなしの run が omission 100% と出た。理由がまったく違う指摘だった）
// ファイル名の構成名（combined25 / proofread10 …）から幅と担当範囲を決め、
// report-to-run → score を通して1行にまとめる。手で打つ機会を無くすためのものである。
//
// 出力は構成ごとに1行と、距離別 recall の表。複数runを並べれば中央値が読める（§2.2）。

import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GOLD = join(here, "fixtures", "gold-long.json");

// 構成名 → (幅, 担当範囲)。整合性は REF を添付しないので scope=consistency で担当外を外す。
const CONFIGS = [
  [/combined(\d+)/, (m) => ({ width: Number(m[1]), scope: "consistency" })],
  [/consistency(\d+)/, (m) => ({ width: Number(m[1]), scope: "consistency" })],
  [/proofread(\d+)/, (m) => ({ width: Number(m[1]), scope: "proofread" })],
];
function configOf(file) {
  const name = basename(file, ".json");
  for (const [re, f] of CONFIGS) { const m = name.match(re); if (m) return { name, ...f(m) }; }
  return null;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node docs/benchmarks/score-runs.mjs <raw>.json... | <dir>");
  process.exit(2);
}
const files = args.flatMap(a => {
  const s = statSync(a, { throwIfNoEntry: false });
  if (s?.isDirectory()) return readdirSync(a).filter(f => f.endsWith(".json")).map(f => join(a, f));
  return [a];
});

const outDir = join(here, "runs");
mkdirSync(outDir, { recursive: true });
const node = process.execPath;
const rows = [];
const dists = new Map();      // 構成 → 距離 → "n/m"

for (const raw of files) {
  const cfg = configOf(raw);
  if (!cfg) { console.error(`（飛ばす）構成名を判別できません: ${raw}`); continue; }
  const runFile = join(outDir, basename(raw));
  execFileSync(node, [join(here, "report-to-run.mjs"), raw, "--out", runFile,
    "--note", `${cfg.name} / reachable=${cfg.width} / scope=${cfg.scope}`], { stdio: ["ignore", "ignore", "inherit"] });
  const out = execFileSync(node, [join(here, "score.mjs"), GOLD, runFile,
    "--reachable", String(cfg.width), "--scope", cfg.scope, "--by", "kind,distance"], { encoding: "utf8" });
  const s = JSON.parse(out);
  rows.push({
    構成: cfg.name, 幅: cfg.width, 担当: cfg.scope,
    分母: s.planted_total,
    recall: s.strict_planted_recall_pct, 補助込み: s.assisted_planted_recall_pct,
    precision: s.findings_precision_pct,
    未検出: (s.missed_ids || []).length,
  });
  const d = new Map();
  for (const [k, v] of Object.entries(s.per_distance || {})) d.set(k, `${Math.round(v.strict_recall_pct * v.planted / 100)}/${v.planted}`);
  dists.set(cfg.name, d);
  // 種類別は幅の議論に直結するので、そのまま出す
  const kinds = Object.entries(s.per_kind || {})
    .map(([k, v]) => `${k} ${v.strict_recall_pct}%(${v.planted})`).join(" / ");
  rows[rows.length - 1].観点別 = kinds;
}

if (!rows.length) process.exit(1);
console.table(rows.map(({ 観点別, ...r }) => r));
for (const r of rows) console.log(`${r.構成}: ${r.観点別}`);

// 距離別（跨ぎの計器の本体）。分母はその幅で到達可能な件数。
const allDist = [...new Set([...dists.values()].flatMap(d => [...d.keys()]))]
  .sort((a, b) => Number(a) - Number(b));
if (allDist.length) {
  console.log("\n距離別 recall（分母はその幅で到達可能な planted）");
  console.log("| 構成 | " + allDist.map(d => `d=${d}`).join(" | ") + " |");
  console.log("|---" .repeat(allDist.length + 1) + "|");
  for (const [name, d] of dists) {
    console.log(`| ${name} | ` + allDist.map(x => d.get(x) ?? "—").join(" | ") + " |");
  }
}
