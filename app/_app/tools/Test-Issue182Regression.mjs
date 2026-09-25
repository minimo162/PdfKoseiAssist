// Regression coverage for issue #182: the Send-To tray must get a structured
// progress object from __koseiAutomation.status(), built from the state that
// renders the progress card — not from the card's screen text.
//
//   node tools/Test-Issue182Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
function extractFunction(name) {
  const start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  // 引数の既定値 `ctx = {}` を本体の始まりと取り違えないよう、") {" から数える。
  for (let i = indexHtml.indexOf(") {", start) + 2; i < indexHtml.length; i++) {
    if (indexHtml[i] === "{") depth++;
    else if (indexHtml[i] === "}" && --depth === 0) return indexHtml.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); failures.push(name); }
};

const context = vm.createContext({});
vm.runInContext(`${extractFunction("formatDuration")}\n${extractFunction("autoProgressSnapshot")}\nthis.autoProgressSnapshot = autoProgressSnapshot;`, context);
const snap = (st, ctx) => JSON.parse(JSON.stringify(context.autoProgressSnapshot(st, ctx)));
const now = Date.parse("2026-09-25T10:00:00Z");
const running = { running: true, jobId: "job", startedAt: now - 8 * 20_000, now };

// --- 1. running with a remaining estimate ---
{
  const p = snap({ mode: "running", packets_done: 8, packets_total: 12, current_stage_index: 3, current_stage_total: 3,
    current_stage_label: "原稿との突き合わせ（3/3）" }, running);
  check("実行中の段階・番号・件数", p.phase === "running" && p.stage_label === "原稿との突き合わせ"
    && p.stage_index === 3 && p.stage_total === 3 && p.done === 8 && p.total === 12, JSON.stringify(p));
  check("残り80秒は「約1分」", p.remaining_label === "約1分" && p.remaining_ms === 80_000, JSON.stringify(p));
}
{
  const p = snap({ mode: "running", packets_done: 8, packets_total: 12 }, { ...running, startedAt: now - 40_000 });
  check("残り20秒は「1分未満」", p.remaining_label === "1分未満" && p.remaining_ms === 20_000, JSON.stringify(p));
}
{
  const p = snap({ mode: "running", packets_done: 4, packets_total: 12, current_stage_index: 1, current_stage_total: 3,
    current_stage_label: "文書全体の整合性（1/3）" }, { ...running, startedAt: now - 4 * 60_000 });
  check("残り8分は「約8分」", p.remaining_label === "約8分" && p.stage_label === "文書全体の整合性", JSON.stringify(p));
}
// --- 2. no estimate yet (only one packet done) ---
{
  const p = snap({ mode: "running", packets_done: 1, packets_total: 12, current_stage_index: 3, current_stage_total: 3,
    current_stage_label: "原稿との突き合わせ（3/3）" }, running);
  check("1件完了では残りを出さない", p.remaining_label === "" && p.remaining_ms === null && p.done === 1, JSON.stringify(p));
}
// --- 3. stage label falls back to the screen-side stage (fullRunStage) ---
{
  const p = snap({ mode: "queued", packets_done: 0, packets_total: 5 }, { ...running, stageLabel: "原稿との突き合わせ" });
  check("サーバーの段階名が無ければ画面側の段階名", p.phase === "running" && p.stage_label === "原稿との突き合わせ"
    && p.stage_index === 0 && p.stage_total === 0, JSON.stringify(p));
}
{
  const p = snap({ mode: "running", current_stage_index: 2, current_stage_total: 3, current_stage_label: "文書全体の再確認（1/3）" }, running);
  check("番号が一致しない末尾は外さない", p.stage_label === "文書全体の再確認（1/3）", JSON.stringify(p));
}
// --- 4. other phases ---
check("ジョブ作成前は preparing", snap(null, { running: true, jobId: "", stageLabel: "Copilot準備中…" }).phase === "preparing");
check("Copilot画面の確認待ち", snap({ mode: "needs_user_visibility" }, { running: false, jobId: "job", needsUserVisibility: true }).phase === "needs_user_visibility");
check("サーバー完了後の取り込み中は importing", snap({ mode: "done", packets_done: 5, packets_total: 5 }, running).phase === "importing");
check("終了後は done", snap({ mode: "done", packets_done: 5, packets_total: 5 }, { running: false, jobId: "job" }).phase === "done");
check("何も始まっていなければ idle", snap(null, {}).phase === "idle");
{
  const p = snap({ mode: "running", packets_done: 8, packets_total: 12 }, { running: true, jobId: "job", now });
  check("開始時刻が無ければ残りを出さない", p.remaining_label === "", JSON.stringify(p));
}

// --- 5. status() keeps existing keys and adds progress from internal state ---
{
  const start = indexHtml.indexOf("      status() {\n        return {");
  const body = indexHtml.slice(start, indexHtml.indexOf("\n      },\n", start));
  for (const key of ["needs_user_visibility", "running", "full_run", "stage", "findings", "job_id", "last_error", "card", "detail"]) {
    check(`status() に既存のキー ${key} が残っている`, new RegExp(`\\n\\s+${key}:`).test(body));
  }
  check("status().progress は autoProgressSnapshot(lastAutoJobState, …) から作る",
    /progress:\s*autoProgressSnapshot\(lastAutoJobState,/.test(body));
  const progressSrc = body.slice(body.indexOf("progress:"));
  check("progress は画面の文字（textContent）を読まない", !/textContent|innerText|els\./.test(progressSrc));
  check("autoProgressSnapshot は画面の文字を読まない", !/textContent|innerText|els\./.test(extractFunction("autoProgressSnapshot")));
}

if (failures.length) {
  console.error(`FAIL Issue182Regression: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("PASS Issue182Regression");
