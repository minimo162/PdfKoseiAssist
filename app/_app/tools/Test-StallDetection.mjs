// Test-StallDetection.mjs — 生成停滞（「詳細を収集しています…」で固まる状態）の検知が
// 配線として成立しているかを検証する。
//
//   node tools/Test-StallDetection.mjs
//
// 実測: SEC_002 が「受信 496文字」のまま 351秒進まず、Copilot は
// 「詳細を収集しています…」を表示し続けた。この状態では停止ボタンが出たままなので
// Test-KoseiCopilotGenerating が true を返し続け、既存の no-json-idle
// （generating=false が条件）は永久に発火しない。結果、本文が1文字も伸びないまま
// タイムアウト（既定600秒）まで待ち続ける。
//
// PowerShell を実行できない環境向けに、条件式と配線が揃っていることを静的に検査する。
// 実際の打ち切り挙動は PS 5.1 実機での確認が必要。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, "..", f), "utf8");
const client = read("src/CopilotClient.ps1");
const reviewJob = read("src/ReviewJob.ps1");
const settings = read("src/Settings.ps1");
const template = read("config/settings.template.json");

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

// --- 停滞検知そのもの ---
t("停滞判定は generating を条件にしない（generating=true でも打ち切る）",
  /if\(\$responseSeen -and \$stableSec -ge \$stallSec\)\{/.test(client));
// 打ち切る直前に停止ボタンを押す（救済ブロックを挟むので窓は広めに取る）
t("停滞時は生成を止めてから返す",
  /Invoke-KoseiClickStop[\s\S]{0,200}生成停滞を検出[\s\S]{0,200}completedBy='generation-stalled'/.test(client));
t("completedBy=generation-stalled を返す", /completedBy='generation-stalled'/.test(client));
t("停滞をログに残す", /生成停滞を検出/.test(client));
t("途中まで受信した本文を salvageText に残す",
  /completedBy='generation-stalled'[\s\S]{0,160}salvageText=\$longestResponseSnapshot/.test(client));

// --- 既存の no-json-idle を壊していない（generating=false 側の経路は残す） ---
t("no-json-idle は generating=false の条件のまま",
  /\$responseSeen -and \$stableSec -ge 90 -and -not \$generating/.test(client));

// --- 停滞は上位のリトライ対象 ---
t("generation-stalled が recoverable に入っている",
  /\$recoverable=@\([^)]*'generation-stalled'\)/.test(reviewJob));

// --- 閾値は設定可能で、下限を割る値は既定へ戻す ---
t("stallSec を設定から読む", /\$stallSec = \[int\]\$Settings\.response_stall_seconds/.test(client));
t("不正値は既定180へ戻す", /if \(\$stallSec -lt 30\) \{ \$stallSec = 180 \}/.test(client));
t("既定値が Settings.ps1 にある", /response_stall_seconds = 180/.test(settings));
const json = JSON.parse(template.replace(/^﻿/, ""));
t("settings.template.json に response_stall_seconds", json.response_stall_seconds === 180);
t("停滞閾値 < タイムアウト（先に停滞で打ち切れる）", json.response_stall_seconds < json.request_timeout);

// --- 完成した回答を「生成中の申告」で取りこぼさない ---
// 実測: Copilot は marker 付きの完全な回答を返したのに、アプリは待機中のままだった。
//   - marker 経路: 応答末尾に marker 以外の文字が続くと EndsWith 判定が成立しない
//   - json-stable 経路: 生成停止の2回連続確認が条件で、停止ボタンが出たままだと永久に満たされない
// 両方が同じ原因で塞がるため、完成JSONが一定時間変化しなければ受理する。
t("json-stable に stable-timeout の受理経路がある",
  /\$acceptReason = if \(\$notGeneratingPolls -ge 2\) \{ 'not-generating' \} elseif \(\$stableSec -ge \$stableAcceptSec\) \{ 'stable-timeout' \}/.test(client));
t("受理条件は complete かつ acceptReason", /if \(\$info\.complete -and \$acceptReason\) \{/.test(client));
t("どちらの経路で受理したかログに残す", /completedBy=json-stable accept=\$acceptReason/.test(client));
t("受理閾値を設定から読む", /\$stableAcceptSec = \[int\]\$Settings\.response_stable_accept_seconds/.test(client));
t("不正値は既定45へ戻す", /if \(\$stableAcceptSec -lt 10\) \{ \$stableAcceptSec = 45 \}/.test(client));
t("既定値が Settings.ps1 にある", /response_stable_accept_seconds = 45/.test(settings));
t("settings.template.json に response_stable_accept_seconds", json.response_stable_accept_seconds === 45);
t("受理は停滞打ち切りより先に起きる（回答を捨てない）",
  json.response_stable_accept_seconds < json.response_stall_seconds);

// --- 停滞打ち切りの直前にも救済する ---
t("停滞打ち切り前に完成回答を確認する",
  /打ち切る前に、すでに完成した回答が来ていないか確認する/.test(client));
t("完成していれば成功として返す",
  /停滞中に完成回答を検出[\s\S]{0,320}ok=\$true;completedBy='json-stable'/.test(client));

if (failures) { console.error(`\nTest-StallDetection: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-StallDetection: PASS");
