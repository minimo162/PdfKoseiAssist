// Test-BenchmarkDriver.mjs — 自動実行スクリプトとアプリ側の入口が食い違っていないか検証する。
//
//   node tools/Test-BenchmarkDriver.mjs
//
// Run-Benchmark.ps1 は CDP 越しに window.__koseiBenchmark を呼ぶ。両者は別ファイルなので、
// 片方の名前を変えても静かに壊れ、しかも壊れたことは**実機で40分走らせて初めて分かる**。
// PowerShell はこのコンテナで実行できないため、せめて次の対応関係は機械で押さえておく。
//
//   1. 使っているメソッドがアプリ側に実在するか
//   2. async のメソッドを .then() で包んでいるか
//      （包まないと JSON.stringify(Promise) が "{}" になり、読み込み失敗に気づけない）
//   3. -Config の候補と実際の構成表が一致しているか
//   4. 読み込む PDF が実在し、静的配信の対象（src/config/tools 以外）か

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const driver = readFileSync(join(root, "tools", "Run-Benchmark.ps1"), "utf8");

let failures = 0;
const t = (name, cond, detail) => {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); if (detail) console.error(`       ${detail}`); }
  else console.log(`  ok   ${name}`);
};

// --- 1. アプリ側の入口を読み取る ---------------------------------------
const hookStart = indexHtml.indexOf("window.__koseiBenchmark = {");
t("index.html に window.__koseiBenchmark がある", hookStart > 0);
const hookBody = indexHtml.slice(hookStart, indexHtml.indexOf("\n    };", hookStart));
const methods = new Map();   // name -> isAsync
for (const m of hookBody.matchAll(/^\s{6}(async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)) {
  methods.set(m[2], Boolean(m[1]));
}
t(`入口のメソッドを ${methods.size} 個検出`, methods.size >= 8, [...methods.keys()].join(", "));
for (const need of ["loadTarget", "loadReference", "selectAllPages", "setChunkSize",
                    "startProofread", "startConsistency", "status", "report"]) {
  t(`入口に ${need}() がある`, methods.has(need));
}
t("loadTarget / loadReference は async", methods.get("loadTarget") === true && methods.get("loadReference") === true);
t("status / report は同期（ポーリングを待たせない）",
  methods.get("status") === false && methods.get("report") === false);

// --- 2. 使い方が合っているか -------------------------------------------
{
  const used = [...driver.matchAll(/window\.__koseiBenchmark\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]);
  const unknown = [...new Set(used)].filter(n => !methods.has(n));
  t("使っているメソッドがすべて実在する", unknown.length === 0, unknown.join(", "));

  // async のものは .then(...) で包まないと Promise が "{}" になって静かに壊れる
  for (const line of driver.split(/\r?\n/)) {
    const m = line.match(/window\.__koseiBenchmark\.([A-Za-z][A-Za-z0-9_]*)/);
    if (!m || !methods.get(m[1])) continue;
    t(`${m[1]}() の戻りを .then() で受けている`, /\.then\(/.test(line), line.trim().slice(0, 100));
  }
  t("同期メソッドは JSON.stringify で直接包んでいる",
    /JSON\.stringify\(window\.__koseiBenchmark\.status\(\)\)/.test(driver) &&
    /JSON\.stringify\(window\.__koseiBenchmark\.report\(\)\)/.test(driver));
}

// --- 3. -Config の候補と構成表 -----------------------------------------
{
  const validate = (driver.match(/\[ValidateSet\(([^)]*)\)\]/) || [])[1] || "";
  const allowed = [...validate.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(x => x !== "all");
  const defined = [...driver.matchAll(/@\{\s*name\s*=\s*'([^']+)'/g)].map(m => m[1]);
  t("-Config の候補と構成表が一致",
    JSON.stringify([...allowed].sort()) === JSON.stringify([...defined].sort()),
    `ValidateSet=${allowed.join(",")} / 構成表=${defined.join(",")}`);
  t("整合性2本・校正2本の4構成", defined.length === 4);

  // 重ねが揃っていないと到達可能なペアが変わり、幅どうしを比較できなくなる
  const overlaps = [...driver.matchAll(/kind\s*=\s*'consistency';\s*width\s*=\s*\d+;\s*overlap\s*=\s*(\d+)/g)].map(m => m[1]);
  t("整合性の重ねが全構成で揃っている", overlaps.length === 2 && new Set(overlaps).size === 1, overlaps.join(","));
}

// --- 4. 読み込む PDF -----------------------------------------------------
{
  const paths = [...driver.matchAll(/\$(?:TargetPath|ReferencePath)\s*=\s*'([^']+)'/g)].map(m => m[1]);
  t("校正対象と比較資料の既定パスがある", paths.length === 2, paths.join(" / "));
  for (const p of paths) {
    t(`${p} が実在する`, existsSync(join(root, p.replace(/^\//, ""))));
    // Server.ps1 は src/ config/ tools/ を配信しない
    t(`${p} は静的配信の対象`, !/^\/(src|config|tools)\//i.test(p));
  }
}

// --- 5. run ごとに読み込み直しているか ----------------------------------
{
  // findings は画面に溜まる。読み込み直さないと前の run の指摘が次に混ざり、
  // 「幅を広げたら増えた」ように見えてしまう。
  t("run ごとに Page.navigate で読み込み直す", /Page\.navigate/.test(driver));
  t("読み込み直しのあと入口の再出現を待つ", /Reset-Page[\s\S]{0,400}Wait-Hook/.test(driver));
}

if (failures) { console.error(`\nTest-BenchmarkDriver: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-BenchmarkDriver: PASS");
