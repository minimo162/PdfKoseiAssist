// Test-PassSchedule.mjs — pass-schedule.mjs の検証（node tools/Test-PassSchedule.mjs）
import { resolvePassSchedule } from "../js/pass-schedule.mjs";

let failures = 0;
const t = (name, cond) => { if (!cond) { failures++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };
const lensesOf = r => r.passes.map(p => p.lens);

// quick: broad のみ（gap 無効時）
{
  const r = resolvePassSchedule({ profile: "quick", gapPass: false });
  t("quick(gap off) = [broad]", JSON.stringify(lensesOf(r)) === JSON.stringify(["broad"]));
}

// quick + gap: broad → gap（§8.2 の2ターン構成）
{
  const r = resolvePassSchedule({ profile: "quick", gapPass: true });
  t("quick(gap on) = [broad,gap]", JSON.stringify(lensesOf(r)) === JSON.stringify(["broad", "gap"]));
}

// standard: broad → numbers → names → gap
{
  const r = resolvePassSchedule({ profile: "standard", gapPass: true });
  t("standard = [broad,numbers,names,gap]", JSON.stringify(lensesOf(r)) === JSON.stringify(["broad", "numbers", "names", "gap"]));
  t("1passは New+attach", r.passes[0].chat_mode === "New" && r.passes[0].attach === true);
  t("2pass以降は Reuse+no attach", r.passes[1].chat_mode === "Reuse" && r.passes[1].attach === false);
}

// thorough with REF: translation を含む
{
  const r = resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: true, maxPasses: 8 });
  t("thorough(REF) に translation", lensesOf(r).includes("translation"));
}

// thorough without REF: translation を skip
{
  const r = resolvePassSchedule({ profile: "thorough", hasRef: false, gapPass: true, maxPasses: 20 });
  t("thorough(no REF) は translation 無し", !lensesOf(r).includes("translation"));
  t("skipped に translation:no-ref", r.skipped.some(s => s.lens === "translation" && s.reason === "no-ref"));
}

// review_max_passes 超過 → skip + warning
{
  const r = resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: true, maxPasses: 4 });
  t("max=4 で4passに制限", r.passes.length === 4);
  t("超過分が skipped", r.skipped.some(s => s.reason === "max-passes-exceeded"));
  t("warning あり", r.warnings.length > 0);
}

// 未知 profile → quick + warning
{
  const r = resolvePassSchedule({ profile: "bogus", gapPass: false });
  t("未知profileは quick", JSON.stringify(lensesOf(r)) === JSON.stringify(["broad"]));
  t("未知profile warning", r.warnings.some(w => w.includes("未知")));
}

// 先頭は必ず broad
{
  const r = resolvePassSchedule({ profile: "standard", gapPass: true });
  t("先頭 kind=broad", r.passes[0].kind === "broad");
}

if (failures > 0) { console.error(`\nTest-PassSchedule: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-PassSchedule: PASS");
