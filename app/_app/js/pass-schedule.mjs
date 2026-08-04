// pass-schedule.mjs — §7.2/§9.2 profile → pass スケジュール解決
//
// profile とパケット条件（REF有無・gap有効・上限）から、実行する pass 列を決定する純関数。
// ReviewJob（PowerShell）が同じ規則で pass ループを回す（Get-KoseiPassSchedule が PS 版）。
//
//   quick       : broad
//   standard    : broad → numbers → names → gap
//   thorough    : broad → translation※ → numbers → names → wording → ellipsis※ → spelling → grammar → structure → gap
//   consistency : broad → wording → ellipsis※ → gap   （整合性セクション用）
//   complement  : broad                               （整合性レビューと併用する校正パケット用・1pass）
//   ※ REF が無いパケットでは translation / ellipsis を skip（原文が無いと判定できない）。
//
// 分担（2026-08-03 の実測に基づく）:
//   整合性セクション（約25p・現物添付）は、跨ぎ・数値・会計連動をほぼ取り切る一方、
//   散文の言い回し（訳語の揺れ・日本語の省略の逐語訳・綴り・文法）は broad では素通りした。
//   そこで wording / ellipsis を独立passとして切り出し、整合性側は同じ添付のまま Reuse turn で
//   追撃する。綴り・文法は各行精読が要るので校正パケット（約10p）側の thorough に置く。
//
//   gap は review_gap_pass に従う（quick でも gap を有効化できる, §8.2）。
//   review_max_passes を超える分は skip し warning を残す。ただし gap は歩留まりが高いので
//   上限の1枠を予約して必ず残す。

const PROFILES = {
  quick: ["broad"],
  standard: ["broad", "numbers", "names", "gap"],
  thorough: ["broad", "translation", "numbers", "names", "wording", "ellipsis", "spelling", "grammar", "structure", "gap"],
  consistency: ["broad", "wording", "ellipsis", "gap"],
  // 整合性レビューと併用する前提の最小プロファイル。**追撃passを持たない**。
  //
  // 実測（2026-08-04, 26ページ・3パケット）:
  //   整合性 + パケットbroadのみ(1pass×3) = 27/30
  //   整合性 + パケットthorough(10pass×3) = 28/30
  // thorough は27ターン余計に使って e33（表頭の単位欠落）1件しか上乗せできなかった。
  // 一方、整合性レビューが原理的に取れない e18(綴り) と e32(主述不一致) は、
  // **10ページ単位の broad だけで両方とも検出できている**。
  // 各行精読に効いているのはページ幅（10p）であって、観点passの数ではない。
  //
  // なお thorough の grammar pass は歩留まり6件に対し誤検知2件
  // （`owners of parent` → `owners of the parent` 等の過剰修正）を出しており、
  // 入れるほど良いわけでもない。
  complement: ["broad"],
};

// REF（日本語原文）が無いと成立しない観点。
const REF_REQUIRED_LENSES = ["translation", "ellipsis"];

// gap を付けないプロファイル。review_gap_pass は全プロファイル共通のフラグなので、
// これが無いと「パケット側の無駄な gap を切る」つもりで整合性側の gap まで消えてしまう。
// 整合性側の gap は注記の見落とし（e05 / e23）を回収している重要なpassで、消してはいけない。
// 一方パケット側の gap は実測で 0件/2パケット（既出の再掲のみ）だった。
const NO_GAP_PROFILES = ["complement"];

export function resolvePassSchedule({ profile = "standard", hasRef = false, gapPass = true, maxPasses = 8 } = {}) {
  const warnings = [];
  const skipped = [];
  let base = PROFILES[profile];
  if (!base) { warnings.push(`未知の profile "${profile}" のため quick を使用`); base = PROFILES.quick; }

  // gap は profile 内の位置に依らず review_gap_pass で最後に付ける／外す。
  let lenses = base.filter(x => x !== "gap");

  // translation / ellipsis は REF が無ければ skip。
  lenses = lenses.filter(x => {
    if (REF_REQUIRED_LENSES.includes(x) && !hasRef) { skipped.push({ lens: x, reason: "no-ref" }); return false; }
    return true;
  });

  // プロファイル自体が gap を持たない場合はフラグに関わらず付けない。
  const wantGap = gapPass && !NO_GAP_PROFILES.includes(profile);

  // review_max_passes 上限（総pass数）。broad を含む先頭から詰め、超過分は skip。
  // gap は既出以外を探す歩留まりの高いpassなので、有効なら1枠を予約して必ず残す。
  const cap = Number.isFinite(maxPasses) && maxPasses > 0 ? maxPasses : lenses.length + 1;
  const lensCap = wantGap ? Math.max(1, cap - 1) : cap;
  let kept = lenses;
  if (lenses.length > lensCap) {
    kept = lenses.slice(0, lensCap);
    for (const x of lenses.slice(lensCap)) skipped.push({ lens: x, reason: "max-passes-exceeded" });
    warnings.push(`pass数 ${lenses.length + (wantGap ? 1 : 0)} が上限 ${cap} を超過。${lenses.length - lensCap} 件を skip`);
  }
  kept = kept.slice();
  if (wantGap) kept.push("gap");

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
