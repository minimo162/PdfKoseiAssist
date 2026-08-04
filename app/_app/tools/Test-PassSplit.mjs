// Test-PassSplit.mjs — 整合性レビューと校正パケットの「分担」が配線として通っているかを検証する。
//
//   node tools/Test-PassSplit.mjs
//
// 2026-08-03 の実測で、整合性セクション（約25p・現物添付）は跨ぎ・数値・会計連動をほぼ取り切る一方、
// 訳語の揺れ・日本語の省略の逐語訳・綴り・文法を broad では素通りすることが分かった。
// そこで観点を pass に切り出して分担させる。ここで見るのは「規則」と「配線」の2つ:
//   1) js/pass-schedule.mjs が kind/REF有無に応じた正しい pass 列を返すか
//   2) index.html が kind / has_ref をジョブへ載せ、src/ReviewJob.ps1 がそれで profile を選ぶか
// （Copilot の実際の歩留まりは実機で測る。ここは配線が切れていないことの保証。）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePassSchedule } from "../js/pass-schedule.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, "..", f), "utf8");
const indexHtml = read("index.html");
const reviewJob = read("src/ReviewJob.ps1");
const server = read("src/Server.ps1");
const settings = read("src/Settings.ps1");
const template = read("config/settings.template.json");

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };
const lensesOf = r => r.passes.map(p => p.lens);

// --- 1. 規則 -----------------------------------------------------------
{
  const cons = lensesOf(resolvePassSchedule({ profile: "consistency", hasRef: true, gapPass: true }));
  const proof = lensesOf(resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: true, maxPasses: 99 }));
  t("整合性は 訳語の揺れ/省略 を担当", cons.includes("wording") && cons.includes("ellipsis"));
  t("整合性は 綴り/文法 を担当しない（各行精読が要るため）",
    !cons.includes("spelling") && !cons.includes("grammar"));
  t("校正パケットは 綴り/文法/訳抜け を担当", ["spelling", "grammar", "translation"].every(x => proof.includes(x)));
  t("どちらも broad で始まり gap で終わる",
    cons[0] === "broad" && cons[cons.length - 1] === "gap" && proof[0] === "broad" && proof[proof.length - 1] === "gap");
  t("追撃passは再添付しない（Reuse・attach=false）",
    resolvePassSchedule({ profile: "consistency", hasRef: true }).passes.slice(1)
      .every(p => p.chat_mode === "Reuse" && p.attach === false));
}

// --- 2. 配線: ブラウザ → サーバー → ジョブ -----------------------------
{
  // index.html: 2種類のパケットとも kind / has_ref を積んでいる
  const kindLines = [...indexHtml.matchAll(/kind: effectivePacket\.kind \|\| "(proofread|consistency)"/g)].map(m => m[1]);
  t("index.html が proofread / consistency の両方に kind を積む",
    kindLines.includes("proofread") && kindLines.includes("consistency"));
  t("index.html が has_ref を積む（REFページが実在するときだけ真）",
    (indexHtml.match(/has_ref: \(effectivePacket\.referenceSections \|\| \[\]\)\.some\(sec => sec\.pages\?\.length > 0\)/g) || []).length === 2);

  // Server.ps1: 受理して per-packet へ渡す（未知 kind は proofread へ寄せる）
  t("Server.ps1 が kind を allowlist で受理", /'proofread',\s*'consistency'\s*\)\s*-notcontains \$kind/.test(server));
  t("Server.ps1 が kind / has_ref を保存", /kind\s*=\s*\$kind/.test(server) && /has_ref\s*=\s*\[bool\]\$p\.has_ref/.test(server));

  // ReviewJob.ps1: per_packet に保持し、profile 選択と REF 判定に使う
  t("ReviewJob が per_packet に kind / has_ref を持つ",
    /kind\s*=\s*\$\(if \(@\('proofread','consistency'\)/.test(reviewJob) && /has_ref\s*=\s*\[bool\]\$p\.has_ref/.test(reviewJob));
  t("ReviewJob が kind=consistency で consistency プロファイルを選ぶ",
    /\[string\]\$p\.kind -eq 'consistency'[\s\S]{0,120}review_profile_consistency/.test(reviewJob));
  t("ReviewJob が HasRef をパケットから渡す（以前は $false 固定だった）",
    /Get-KoseiPassSchedule -Profile \$reviewProfile -HasRef \(\[bool\]\$p\.has_ref\)/.test(reviewJob));
  t("観点追撃文にも HasRef を渡す", /New-KoseiLensFollowupPrompt[^\n]*-HasRef \(\[bool\]\$p\.has_ref\)/.test(reviewJob));

  // 整合性レビューは観点passが前提の新機能なので、review_engine の既定(legacy)に左右されない。
  // 実測1・2回目はこの取りこぼしで観点passが一度も走っていなかった。
  t("kind=consistency は multipass を強制する",
    /\$packetEngine = if \(\[string\]\$p\.kind -eq 'consistency'\) \{ 'multipass' \}/.test(reviewJob));
  t("proofread は従来どおり flag に従う（K34）",
    /else \{ \[string\]\$reviewFlags\.review_engine \}/.test(reviewJob));
  t("multipass 判定は packetEngine を見る",
    /if \(\$packetEngine -eq 'multipass' -and/.test(reviewJob));
}

// --- 3. PS 側の profile 定義が JS と一致している ------------------------
{
  const psProfiles = {};
  for (const m of reviewJob.matchAll(/^\s{8}(quick|standard|thorough|consistency|complement)\s*=\s*@\(([^)]*)\)/gm)) {
    psProfiles[m[1]] = m[2].split(",").map(x => x.trim().replace(/^'|'$/g, ""));
  }
  for (const name of ["quick", "standard", "thorough", "consistency", "complement"]) {
    // JS 側の PROFILES を resolvePassSchedule 経由で復元（REFあり・上限なし＝定義そのまま）。
    // gap は profile の定義に含まれるかどうかで決まるので、PS のリテラルに合わせて渡す。
    const ps = psProfiles[name] || [];
    const js = lensesOf(resolvePassSchedule({ profile: name, hasRef: true, gapPass: ps.includes("gap"), maxPasses: 99 }));
    t(`profile "${name}" が PS と JS で一致`, JSON.stringify(ps) === JSON.stringify(js));
  }
  t("REF必須観点が PS と JS で一致（translation / ellipsis）",
    /\$refRequired = @\('translation', 'ellipsis'\)/.test(reviewJob));
}

// --- 4. 観点の定義とラベルが揃っている ---------------------------------
{
  for (const lens of ["wording", "ellipsis"]) {
    t(`${lens} の観点定義が ReviewJob にある`, new RegExp(`^\\s+${lens}\\s+= @\\{ label =`, "m").test(reviewJob));
    t(`${lens} の表示ラベルが index.html にある`, new RegExp(`${lens}: "`).test(indexHtml));
  }
  t("整合性プロンプトが 訳語の揺れ/省略 を後続passへ引き渡す",
    /訳語の揺れ・日本語特有の省略の逐語訳は、\s*\n?\s*このあと同じ資料に対して観点を絞って追加で質問します/.test(indexHtml));
}

// --- 5. 設定 -----------------------------------------------------------
{
  t("settings 既定に review_profile_consistency", /review_profile_consistency = 'consistency'/.test(settings));
  t("allowlist に consistency / complement", /review_profile_consistency = @\('quick', 'standard', 'thorough', 'consistency', 'complement'\)/.test(settings));
  t("検証済みflagに含める", /review_profile_consistency\s+= & \$resolve 'review_profile_consistency'/.test(settings));
  const json = JSON.parse(template.replace(/^\uFEFF/, ""));
  t("settings.template.json に review_profile_consistency", json.review_profile_consistency === "consistency");
}

if (failures) { console.error(`\nTest-PassSplit: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-PassSplit: PASS");
