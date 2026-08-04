// Test-SettingsError.mjs — settings.json の読み込み失敗が画面まで届くかを検証する。
//
//   node tools/Test-SettingsError.mjs
//
// 実測: settings.json に構文エラー（カンマ落ち）があり、PS 側は既定値へ黙って戻って
// 動き続けていた。review_engine が legacy のままだったため、校正パケットの測定は
// thorough ではなく broad 1pass で走っており、ベンチマーク3回分が無駄になった。
// 警告はログファイルにしか出ておらず、画面上は正常に見えていた。
//
// PowerShell を実行できない環境向けに、記録→API→画面の配線を静的に検査する。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, "..", f), "utf8");
const settings = read("src/Settings.ps1");
const server = read("src/Server.ps1");
const indexHtml = read("index.html");
const template = read("config/settings.template.json");

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

// --- 記録 ---
t("読み込み失敗の理由を保持する", /\$script:KoseiSettingsError = \('settings\.json を読み込めないため既定値で動作しています/.test(settings));
t("外から取り出せる", /function Get-KoseiSettingsError \{ return \[string\]\$script:KoseiSettingsError \}/.test(settings));
t("読み込みに成功したらクリアする", /\$loaded = \$raw \| ConvertFrom-Json\s*\n\s*\$script:KoseiSettingsError = ''/.test(settings));
t("ログにも残す", /Write-KoseiLog \$script:KoseiSettingsError 'WARN'/.test(settings));

// --- API ---
t("ready-state に settings_error を載せる", /\$payload\['settings_error'\] = \$settingsError/.test(server));
t("warmup の既存フィールドを落とさない", /foreach \(\$prop in \$warmup\.PSObject\.Properties\) \{ \$payload\[\$prop\.Name\] = \$prop\.Value \}/.test(server));
t("関数が無い環境でも落ちない（存在チェック）", /Get-Command Get-KoseiSettingsError -ErrorAction SilentlyContinue/.test(server));

// --- 画面 ---
t("ready-state のポーリングでバナーを更新する", /showSettingsErrorBanner\(String\(data\.settings_error \|\| ""\)\)/.test(indexHtml));
t("バナーを描画する関数がある", /function showSettingsErrorBanner\(message\)/.test(indexHtml));
t("空文字なら消える", /if \(!message\) \{ if \(el\) el\.remove\(\); return; \}/.test(indexHtml));
t("エラー文言を本文に出す", /el\.textContent = "設定エラー: " \+ message/.test(indexHtml));

// --- テンプレート自体が壊れていないこと（配布物の前提） ---
{
  let ok = true;
  try { JSON.parse(template.replace(/^﻿/, "")); } catch { ok = false; }
  t("settings.template.json が妥当なJSON", ok);
}

if (failures) { console.error(`\nTest-SettingsError: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-SettingsError: PASS");
