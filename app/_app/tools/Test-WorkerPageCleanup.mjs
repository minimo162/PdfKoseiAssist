// Test-WorkerPageCleanup.mjs — ワーカー用Edgeウィンドウを作ったら必ず閉じる、を静的に守る。
//
//   node tools/Test-WorkerPageCleanup.mjs
//
// ⚠️ 実測（2026-08-05）: New-KoseiCopilotWorkerPages は newWindow=$true で
//    （ワーカー数−1）個の**別ウィンドウ**を作るのに、コードのどこにも Target.closeTarget が
//    無かった。ベンチマークを6本回した時点で専用プロファイルのEdgeウィンドウが32個、
//    msedge.exe が62プロセスになり、利用者からは「アプリを使うほど画面が増える」に見えた。
//    通常利用でもレビュー1回ごとに3個増える（review_max_workers=4 のとき）。
//
//    この型は静かに壊れる（機能は動くので誰も気づかない）ので、対で呼ぶことを検査で縛る。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const client = readFileSync(join(app, "src", "CopilotClient.ps1"), "utf8");
const job = readFileSync(join(app, "src", "ReviewJob.ps1"), "utf8");
const measure = readFileSync(join(app, "tools", "Measure-Concurrency.ps1"), "utf8");

let bad = 0;
const t = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name);
  else { bad++; console.error("  FAIL " + name); if (detail) console.error("       " + detail); }
};

// --- 1. 後始末の関数がある ------------------------------------------------
t("Close-KoseiCopilotWorkerPages が定義されている",
  /function Close-KoseiCopilotWorkerPages/.test(client));

const closeFn = (() => {
  const s = client.indexOf("function Close-KoseiCopilotWorkerPages");
  if (s < 0) return "";
  const e = client.indexOf("\nfunction ", s + 10);
  return client.slice(s, e < 0 ? client.length : e);
})();

// 先頭は既存のウォームアップ済み画面。閉じるとアプリが次のジョブで掴む先を失う。
t("後始末は $Pages[0]（既存画面）を閉じない（ループが1から始まる）",
  /for \(\$w = 1; \$w -lt \$list\.Count; \$w\+\+\)/.test(closeFn));
// アプリ画面を閉じると beforeunload が /__page-closed を送りサーバーが止まる。
t("後始末はアプリ画面(127.0.0.1/localhost)を弾く",
  /127\.0\.0\.1/.test(closeFn) && /localhost/.test(closeFn));
t("後始末は閉じた数をログに残す（黙って何もしないと気づけない）",
  /Write-KoseiLog[^\n]*closed=/.test(closeFn));

// --- 2. 作る側は途中で失敗しても作りかけを残さない ------------------------
const newFn = (() => {
  const s = client.indexOf("function New-KoseiCopilotWorkerPages");
  const e = client.indexOf("\nfunction Close-KoseiCopilotWorkerPages", s);
  return s < 0 ? "" : client.slice(s, e < 0 ? client.length : e);
})();
t("作る側は作ったtargetIdを控えている", /\$createdIds/.test(newFn));
t("作る側は例外時に自分が作った窓を閉じてから投げ直す",
  /catch \{[\s\S]{0,400}json\/close[\s\S]{0,200}throw/.test(newFn));

// --- 3. 作る側を呼ぶ場所は、必ず閉じる側も呼ぶ ----------------------------
for (const [name, text] of [["ReviewJob.ps1", job], ["Measure-Concurrency.ps1", measure]]) {
  if (!/New-KoseiCopilotWorkerPages/.test(text)) continue;
  t(`${name} は作ったら閉じている`, /Close-KoseiCopilotWorkerPages/.test(text),
    "New-KoseiCopilotWorkerPages を呼ぶファイルは Close-KoseiCopilotWorkerPages も呼ぶこと");
}

// ジョブは中止・失敗・正常終了のどれでも後始末を通る必要がある。
// 並列ブロックの外（mode を決める前）と、致命エラーの catch の2箇所。
t("ReviewJob は後始末を2箇所（正常系と致命エラーの catch）で呼ぶ",
  (job.match(/Close-KoseiCopilotWorkerPages/g) || []).length >= 2);
t("ReviewJob は後始末のあと $workerPages を空にする（二重に閉じない）",
  /Close-KoseiCopilotWorkerPages[\s\S]{0,300}\$workerPages = \$null/.test(job));

if (bad) { console.error(`\nTest-WorkerPageCleanup: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-WorkerPageCleanup: PASS");
