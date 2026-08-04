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

// --- 分担（consistency profile）: 整合性セクションは wording / ellipsis を Reuse で追撃する ---
{
  const r = resolvePassSchedule({ profile: "consistency", hasRef: true, gapPass: true });
  t("consistency = [broad,wording,ellipsis,gap]",
    JSON.stringify(lensesOf(r)) === JSON.stringify(["broad", "wording", "ellipsis", "gap"]));
  t("consistency の2pass目以降は Reuse・添付なし",
    r.passes.slice(1).every(p => p.chat_mode === "Reuse" && p.attach === false));
}
{
  // 省略(ellipsis)は原文が無いと「何が省略されたか」を判定できないので REF 必須。
  const r = resolvePassSchedule({ profile: "consistency", hasRef: false, gapPass: true });
  t("REFなしで ellipsis を skip", !lensesOf(r).includes("ellipsis"));
  t("REFなしでも wording は残る", lensesOf(r).includes("wording"));
  t("skipped に ellipsis:no-ref", r.skipped.some(s => s.lens === "ellipsis" && s.reason === "no-ref"));
}

// --- thorough は校正パケット側の担当（綴り・文法・訳抜けを各行精読で拾う） ---
{
  const r = resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: true, maxPasses: 99 });
  const lenses = lensesOf(r);
  t("thorough に wording/ellipsis を追加", lenses.includes("wording") && lenses.includes("ellipsis"));
  t("thorough に spelling/grammar が残る", lenses.includes("spelling") && lenses.includes("grammar"));
  t("thorough の先頭2つは broad→translation", lenses[0] === "broad" && lenses[1] === "translation");
}

// --- 上限超過でも gap は落とさない（既出以外を探す歩留まりが高いため1枠を予約） ---
{
  const r = resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: true, maxPasses: 4 });
  const lenses = lensesOf(r);
  t("上限4でも4pass", r.passes.length === 4);
  t("上限超過でも gap が残る", lenses[lenses.length - 1] === "gap");
  t("gap 以外が skip される", r.skipped.some(s => s.reason === "max-passes-exceeded" && s.lens !== "gap"));
}
{
  const r = resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: false, maxPasses: 4 });
  t("gap 無効なら4枠すべて観点に使う", r.passes.length === 4 && !lensesOf(r).includes("gap"));
}

// --- complement: 整合性レビューと併用する軽量プロファイル ---
// 実測で校正パケットが整合性に上乗せできたのは綴りと文法の2件だけだった。
{
  const r = resolvePassSchedule({ profile: "complement", hasRef: true, gapPass: false });
  t("complement = [broad,spelling,grammar]",
    JSON.stringify(lensesOf(r)) === JSON.stringify(["broad", "spelling", "grammar"]));
  t("complement は3passで済む（thoroughは10pass）",
    r.passes.length === 3 &&
    resolvePassSchedule({ profile: "thorough", hasRef: true, gapPass: true, maxPasses: 99 }).passes.length === 10);
}
{
  // 歩留まりゼロだった names / gap を含まない（gapは明示的に有効化したときだけ付く）
  const r = resolvePassSchedule({ profile: "complement", hasRef: true, gapPass: false });
  t("complement に names を入れない", !lensesOf(r).includes("names"));
  t("complement に gap を入れない", !lensesOf(r).includes("gap"));
}
{
  // 整合性側と担当が重ならない（重なると同じ指摘を2回作って時間を捨てる）
  const cons = lensesOf(resolvePassSchedule({ profile: "consistency", hasRef: true, gapPass: true }));
  const comp = lensesOf(resolvePassSchedule({ profile: "complement", hasRef: true, gapPass: false }));
  const overlap = comp.filter(x => x !== "broad" && cons.includes(x));
  t("complement と consistency の観点が重ならない（broadを除く）", overlap.length === 0);
}
{
  // REF が無くても成立する（綴り・文法は原文を要しない）
  const r = resolvePassSchedule({ profile: "complement", hasRef: false, gapPass: false });
  t("REFなしでも complement は3pass", r.passes.length === 3);
}

if (failures > 0) { console.error(`\nTest-PassSchedule: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-PassSchedule: PASS");
