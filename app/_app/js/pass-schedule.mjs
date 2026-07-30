// pass-schedule.mjs — §7.2/§9.2 profile → pass スケジュール解決
//
// profile とパケット条件（REF有無・gap有効・上限）から、実行する pass 列を決定する純関数。
// ReviewJob（PowerShell）が同じ規則で pass ループを回す（Get-KoseiPassSchedule が PS 版）。
//
//   quick    : broad
//   standard : broad → numbers → names → gap
//   thorough : broad → spelling → grammar → numbers → names → translation※ → structure → gap
//   ※ REF が無いパケットでは translation を skip。
//   gap は review_gap_pass に従う（quick でも gap を有効化できる, §8.2）。
//   review_max_passes を超える分は skip し warning を残す。

const PROFILES = {
  quick: ["broad"],
  standard: ["broad", "numbers", "names", "gap"],
  thorough: ["broad", "spelling", "grammar", "numbers", "names", "translation", "structure", "gap"],
};

export function resolvePassSchedule({ profile = "standard", hasRef = false, gapPass = true, maxPasses = 8 } = {}) {
  const warnings = [];
  const skipped = [];
  let base = PROFILES[profile];
  if (!base) { warnings.push(`未知の profile "${profile}" のため quick を使用`); base = PROFILES.quick; }

  // gap は profile 内の位置に依らず review_gap_pass で最後に付ける／外す。
  let lenses = base.filter(x => x !== "gap");

  // translation は REF が無ければ skip。
  lenses = lenses.filter(x => {
    if (x === "translation" && !hasRef) { skipped.push({ lens: "translation", reason: "no-ref" }); return false; }
    return true;
  });

  if (gapPass) lenses.push("gap");

  // review_max_passes 上限（総pass数）。broad を含む先頭から詰め、超過分は skip。
  const cap = Number.isFinite(maxPasses) && maxPasses > 0 ? maxPasses : lenses.length;
  let kept = lenses;
  if (lenses.length > cap) {
    kept = lenses.slice(0, cap);
    for (const x of lenses.slice(cap)) skipped.push({ lens: x, reason: "max-passes-exceeded" });
    warnings.push(`pass数 ${lenses.length} が上限 ${cap} を超過。${lenses.length - cap} 件を skip`);
  }

  const passes = kept.map((x, i) => {
    const kind = i === 0 ? "broad" : (x === "gap" ? "gap" : "lens");
    return {
      pass_index: i,
      kind,
      lens: kind === "lens" ? x : kind, // broad/gap は kind をそのまま lens 名に
      chat_mode: i === 0 ? "New" : "Reuse",
      attach: i === 0,
    };
  });

  return { passes, skipped, warnings };
}
