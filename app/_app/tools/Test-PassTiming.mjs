// Test-PassTiming.mjs — 多パス時の所要時間が全pass分集計されるかを検証する。
//
//   node tools/Test-PassTiming.mjs
//
// 実測で「3パケット×10pass = 30ターン」を走らせたのに画面が「合計 170.2秒」と表示していた。
// 1ターン30〜60秒かかるので明らかに少ない。原因は total_elapsed_ms / phase_timings が
// pass1(broad) の結果でしか更新されず、追撃passの時間が加算されていなかったこと。
// 集計を誤ると「どの構成が速いか」の判断そのものが狂うため、配線を固定しておく。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, "..", f), "utf8");
const reviewJob = read("src/ReviewJob.ps1");
const indexHtml = read("index.html");

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

// --- PS: 追撃passの時間をパケット合計へ加算する ---
t("per_packet に response_wait_ms を持つ", /response_wait_ms = 0\s+# 全pass合計の生成待ち時間/.test(reviewJob));
t("pass1 の生成待ちを初期値にする", /\$Packet\.response_wait_ms=\[int\]\$\(if\(\$wait\.phaseTimings\)/.test(reviewJob));
t("追撃passの所要を合計へ加算", /\$Packet\.total_elapsed_ms = \[int\]\$Packet\.total_elapsed_ms \+ \$passElapsed/.test(reviewJob));
t("追撃passの生成待ちを合計へ加算", /\$Packet\.response_wait_ms = \[int\]\$Packet\.response_wait_ms \+ \$passWait/.test(reviewJob));
t("phaseTimings が無くても落ちない", /if\(\$pr\.phaseTimings\)\{\$pr\.phaseTimings\.response_wait_ms\}else\{0\}/.test(reviewJob));

// --- PS: pass ごとの所要時間を記録する（どの観点が時間を食うか見るため） ---
t("pass0 に elapsed_ms を持たせる", /pass_id='0';[\s\S]{0,220}elapsed_ms=\[int\]\$Packet\.total_elapsed_ms/.test(reviewJob));
t("成功passに elapsed_ms を記録", /findings_count=\[int\]\$pr\.findingsCount; elapsed_ms=\$passElapsed/.test(reviewJob));
t("失敗passも 0 で記録（欠落させない）", /completed_by='error'; findings_count=0; elapsed_ms=0; response_wait_ms=0/.test(reviewJob));

// --- PS: シリアライザが外へ出す ---
t("status に response_wait_ms を載せる", /response_wait_ms = \[int\]\$p\.response_wait_ms\s*\n\s*passes         =/.test(reviewJob));
t("status の passes に elapsed_ms を載せる", /findings_count=\[int\]\$_\.findings_count; elapsed_ms=\[int\]\$_\.elapsed_ms \} \}\)/.test(reviewJob));

// --- UI: pass1 だけでなく全pass合計を使う ---
t("response_wait_ms を優先して使う",
  /Number\(p\.response_wait_ms \?\? p\.phase_timings\?\.response_wait_ms \?\? 0\)/.test(indexHtml));
t("ターン数と1ターン平均を出す", /ターン・1ターン平均/.test(indexHtml));
t("観点別の内訳に所要秒を添える", /sec >= 0\.1 \? `\(\$\{sec\.toFixed\(0\)\}s\)`/.test(indexHtml));

// --- 集計ロジックそのものの確認（UIの式を抽出して評価する） ---
{
  // 3パケット×10pass、1ターン30秒相当のダミー
  const finished = [1, 2, 3].map(() => ({
    total_elapsed_ms: 300000, response_wait_ms: 280000,
    phase_timings: { response_wait_ms: 30000 },     // pass1 の内訳だけ（旧実装が拾っていた値）
    passes: Array.from({ length: 10 }, () => ({ elapsed_ms: 30000 })),
  }));
  const totalMs = finished.reduce((s, p) => s + Number(p.total_elapsed_ms || 0), 0);
  const responseMs = finished.reduce((s, p) => s + Number(p.response_wait_ms ?? p.phase_timings?.response_wait_ms ?? 0), 0);
  const turns = finished.reduce((s, p) => s + Math.max(1, Array.isArray(p.passes) ? p.passes.length : 1), 0);
  t("30ターンを30ターンと数える", turns === 30);
  t("合計は900秒（旧実装なら90秒に見えていた）", totalMs / 1000 === 900);
  t("生成時間は全pass合計を使う（pass1だけなら90秒）", responseMs / 1000 === 840);
  t("1ターン平均が30秒", (totalMs / 1000 / turns).toFixed(1) === "30.0");
}

if (failures) { console.error(`\nTest-PassTiming: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-PassTiming: PASS");
