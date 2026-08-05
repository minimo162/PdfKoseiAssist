// Test-ConsistencyLenses.mjs — 観点を分けて投げる仕組みが、両側で食い違っていないかを見る。
//
//   node tools/Test-ConsistencyLenses.mjs
//
// 観点を1つに絞る指示文は2箇所にある。
//   - index.html の CONSISTENCY_LENS_PROMPTS … パケットとして**並列に**投げるとき
//   - src/ReviewJob.ps1 の $script:KoseiReviewLenses … 同じチャットで**直列に**追撃するとき
// 同じ観点なのに片方だけ直すと、構成を変えたときに測っているものが変わってしまう。
//
// ⚠️ なぜ2経路あるのか（消さないこと）:
//    追撃（Reuse turn）は前のターンに依存するので直列にしか流せない。gap のように
//    「既出以外を探す」観点はこれが要る。一方 terms / numbers は既出一覧を渡さないので
//    独立に投げられ、パケットに分ければ review_max_workers でそのまま並列になる。
//    実測（2026-08-05・200ページ）: 1ターンに詰め込むと出力の枠を数値の照合が食い切り、
//    表記の揺れ（term）が 2/24 まで落ちた。観点を分けると 11/24 に戻る。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePassSchedule } from "../js/pass-schedule.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const html = readFileSync(join(app, "index.html"), "utf8");
const ps = readFileSync(join(app, "src", "ReviewJob.ps1"), "utf8");
const driver = readFileSync(join(app, "tools", "Run-Benchmark.ps1"), "utf8");

let bad = 0;
const t = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name);
  else { bad++; console.error("  FAIL " + name); if (detail) console.error("       " + detail); }
};

// --- 1. 並列側（index.html）の差し込み文 --------------------------------
const block = html.slice(html.indexOf("const CONSISTENCY_LENS_PROMPTS = {"),
  html.indexOf("};", html.indexOf("const CONSISTENCY_LENS_PROMPTS = {")));
t("index.html に観点の差し込み文がある", block.length > 100);
for (const lens of ["terms", "numbers", "structure"]) {
  t(`並列側に ${lens} の指示がある`, new RegExp(`^\\s{6}${lens}:`, "m").test(block));
}
t("観点を1つに絞ると明記している", /観点を1つに絞ります/.test(block));
t("当てはまらない指摘を出さないよう指示している",
  (block.match(/この観点に当てはまらない指摘は出さないでください/g) || []).length >= 2);
// マスクした状態で数値を比べる唯一の方法。ここが抜けると記号を値として読もうとする。
t("数値の観点は記号どうしの照合だと明記している", /記号が同じかどうか\S*で判定/.test(block));

// --- 2. 直列側（ReviewJob.ps1）の観点定義 -------------------------------
for (const lens of ["terms", "numbers", "structure"]) {
  t(`直列側に ${lens} の観点定義がある`, new RegExp(`^\\s{4}${lens}\\s*=\\s*@\\{`, "m").test(ps));
}

// --- 3. 例が両側で揃っているか -------------------------------------------
// 具体例は指示の効きどころなので、片側だけに入っていると挙動が変わる。
const psTerms = ps.slice(ps.indexOf("terms       = @{"), ps.indexOf("gap         = @{"));
for (const example of ["AOI Quality Standard", "Aoi Advanced Material", "Nagoya Branch", "Whistle"]) {
  t(`例「${example}」が両側にある`, block.includes(example) && psTerms.includes(example));
}
t("どちらも「訳の当否は問わない」と言っている",
  /訳が正しいかどうかは問いません/.test(block) && /訳が正しいかどうかは問わない/.test(psTerms));

// --- 4. プロファイルと構成 ------------------------------------------------
const sched = resolvePassSchedule({ profile: "consistency2", hasRef: false, gapPass: true, maxPasses: 8 });
t("consistency2 は broad → terms → numbers",
  JSON.stringify(sched.passes.map(p => p.lens)) === JSON.stringify(["broad", "terms", "numbers"]),
  sched.passes.map(p => p.lens).join(","));
t("consistency2 は gap を持たない（既出一覧に依存しない観点だけで構成する）",
  !sched.passes.some(p => p.kind === "gap"));

t("Run-Benchmark に並列構成（lenses 指定）がある", /lenses = @\('broad','terms','numbers','structure'\)/.test(driver));
t("並列構成は startConsistency へ lenses を渡す", /", lenses: "/.test(driver));
t("直列版（split200）は既定の -Config all から外してある（比較用）",
  /name = 'split200'[^\n]*inAll = \$false/.test(driver));

// --- 5. パケット展開 ------------------------------------------------------
// 観点ごとに packet_id を分けないと、取り込み側で同じIDの結果が上書きされる。
t("観点ごとに packet_id を分けている",
  /packet_id: lens \? effectivePacket\.packetId \+ "_" \+ lens\.toUpperCase\(\)/.test(html));
t("観点で分けたパケットは追撃を持たない（1パケット1ターン）",
  /profile: lens \? "consistency1"/.test(html));
t("未知の観点は例外にする（黙って観点なしで走らせない）",
  /未知の観点です/.test(html));
// ⚠️ 添付ファイル名も観点ごとに変えること。
//    実測（2026-08-05）: 同名のまま3パケットを並列に投げたら、同じジョブディレクトリの
//    同じ名前へ同時に書く形になり、「添付完了を80秒以内に確認できませんでした」で
//    観点パケットが落ちた。落ち方が静かで、結果だけ見ると「その観点は何も出さなかった」に見える。
t("添付ファイル名も観点ごとに分けている（並列で同名だと添付が競合する）",
  /prompt_name: withLens\(/.test(html) && /text_name: withLens\(/.test(html) &&
  /pdf_name: pdf_base64 \? withLens\(/.test(html));

if (bad) { console.error(`\nTest-ConsistencyLenses: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-ConsistencyLenses: PASS");
