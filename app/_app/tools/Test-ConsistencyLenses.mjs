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

// --- 3. 指示にベンチマークの答えが混ざっていないか ------------------------
//
// ⚠️ これが今日いちばん効く検査である。実測（2026-08-05）: 観点の指示に具体例として
//    フィクスチャの表記揺れ4件をそのまま書いていたため、その4件は 4/4 で検出され、
//    例に無い20件は 17/20 だった。**答えを見せた状態で測っていた**ことになる。
//    指示に書いてよいのは「どういう形の違いを探すか」だけで、素材の中身は書かない。
const psTerms = ps.slice(ps.indexOf("terms       = @{"), ps.indexOf("gap         = @{"));
{
  const gold = JSON.parse(readFileSync(join(app, "docs", "benchmarks", "fixtures", "gold-long.json"), "utf8"));
  const planted = gold.packets[0].planted;
  // 素材の「答え」に当たる文字列: 引用と、跨ぎの相手方の引用。
  const secrets = [];
  for (const p of planted) {
    for (const q of [p.quote, ...(p.alt || []).map(a => a.quote)]) {
      // 短すぎる断片はどこにでも現れるので、意味のある長さのものだけ見る
      for (const frag of String(q).match(/[A-Za-z][A-Za-z&.,'’ -]{14,60}/g) || []) {
        const f = frag.trim();
        if (f.length >= 15) secrets.push({ id: p.id, frag: f });
      }
    }
  }
  const leaked = secrets.filter(s2 => block.includes(s2.frag) || psTerms.includes(s2.frag));
  t(`観点の指示に素材の答えが入っていない（${secrets.length}断片を照合）`, leaked.length === 0,
    leaked.slice(0, 5).map(x => `${x.id}: ${x.frag}`).join(" / "));
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
  /const idSuffix = \(lens \? "_" \+ lens\.toUpperCase\(\) : ""\)/.test(html) &&
  /packet_id: effectivePacket\.packetId \+ idSuffix/.test(html));
t("観点で分けたパケットは追撃を持たない（1パケット1ターン）",
  /profile: lens \? "consistency1"/.test(html));
t("未知の観点は例外にする（黙って観点なしで走らせない）",
  /未知の観点です/.test(html));
// ⚠️ 添付ファイル名も観点ごとに変えること。
//    実測（2026-08-05）: 同名のまま3パケットを並列に投げたら、同じジョブディレクトリの
//    同じ名前へ同時に書く形になり、「添付完了を80秒以内に確認できませんでした」で
//    観点パケットが落ちた。落ち方が静かで、結果だけ見ると「その観点は何も出さなかった」に見える。
// --- 6. ラウンド2（既出以外を探す） --------------------------------------
{
  // ⚠️ 既出一覧は**マスクし直してから**渡すこと。画面上の findings は記号を実値へ戻した後の姿で、
  //    そのまま送ると「伏せた数値を自分で送り返す」ことになり、マスキングが無意味になる。
  //    §4.5 と同じく、伏せきれないなら渡さない（警告ではなく不採用）。
  t("既出一覧をマスクし直してから渡している",
    /function priorFindingsDigest[\s\S]{0,900}jobMasker\.mask\(body, "en"\)/.test(html));
  t("伏せきれない既出一覧は渡さない（平文の数値を送り返さない）",
    /function priorFindingsDigest[\s\S]{0,1200}verifyMask\(masked\)[\s\S]{0,300}return "";/.test(html));
  t("既出一覧は「報告禁止リスト」として渡す（参考として渡すと言い換えて再掲される）",
    /報告禁止リスト/.test(html));
  t("ラウンド2は 0件でも正しいと明示する（無理に絞り出させない）",
    /0件が正しい答えになりえます/.test(html));
  t("ラウンド間だけ直列にする（ラウンド1の結果に依存するため）",
    /for \(let round = 1; round <= rounds; round\+\+\)/.test(html));
  t("ラウンド2のパケットIDとファイル名を分ける（同名だと結果が上書きされ、添付も競合する）",
    /"_R" \+ round/.test(html));
  // ⚠️ ラウンド2で同じ指示を出すと、同じものが見つかり、それは報告禁止リストに載っているので
  //    出力が0件になる（実測 2026-08-05: numbers のラウンド2がちょうどこれで0件だった）。
  t("ラウンド2は専用の指示に切り替える（同じ探し方を繰り返さない）",
    /CONSISTENCY_LENS_PROMPTS\[lens \+ "_r2"\]/.test(html));
  // 観点ごとに「1回目とは別の探し方」を用意する。numbers だけ変えても他が同じでは、
  // 他の観点のラウンド2は同じ結果を出して報告禁止リストに弾かれるだけになる。
  for (const lens of ["numbers", "terms", "structure"]) {
    t(`${lens} にラウンド2の指示がある`, new RegExp(`^\\s{6}${lens}_r2:`, "m").test(block));
  }
  t("ラウンド2はどれも「探し方を変える」と明示している",
    (block.match(/1回目とは\*\*探し方を変えてください/g) || []).length >= 3);
  t("gap は「報告禁止リストに出てこないページ」から見るよう指示している",
    /出てこないページ/.test(block));
  t("ラウンド2の数値は「指標名を列挙してから記号を突き合わせる」手順で書いてある",
    /指標名・科目名・項目名で、2箇所以上に出てくるもの/.test(block) && /記号が違う組だけ/.test(block));
}

// --- 7. 指示文と出力ひな型が食い違っていないか ----------------------------
//
// ⚠️ 実測（2026-08-05）: 整合性プロンプトは「needs_human_review の区別は使いません」と
//    書いておきながら、直下の出力JSONひな型に "needs_human_review": true が残っていた。
//    モデルはひな型を写すので、写した run では 47件中37件に旗が付いて strict 12.5%、
//    写さなかった run では 50件中7件で strict 76.8%。同じ構成なのに strict だけが振れる。
//    採点側（report-to-run.mjs）はこの旗で findings と uncertain_candidates を分けるため、
//    ひな型に1行残っているだけで「何を測っているか」が run ごとに変わってしまう。
{
  const start = html.indexOf("function buildConsistencyPromptText");
  const consistencyPrompt = html.slice(start, html.indexOf("\n    function ", start + 10));
  t("整合性プロンプトを切り出せている", consistencyPrompt.length > 1000 && consistencyPrompt.includes("\"packet_id\""));
  t("整合性プロンプトは needs_human_review を使わないと明記している",
    /needs_human_review の区別は使いません/.test(consistencyPrompt));
  t("整合性プロンプトの出力ひな型に needs_human_review が残っていない（指示文と食い違わせない）",
    !/"needs_human_review"/.test(consistencyPrompt));

  // ⚠️ omitted_uncertain_findings も同じ型の食い違いだった。この箱の使い方を書いた指示は
  //    校正パケット側にしか無く、整合性のひな型には**説明なしで欄だけ**あった。
  //    「指摘はすべて要確認候補」と言っているモードで「確信が持てないものを入れる箱」を
  //    渡すのは、recall で測る側から見れば黙って落としてよい置き場を渡すのと同じ。
  t("整合性プロンプトの出力ひな型に omitted_uncertain_findings が無い",
    !/omitted_uncertain_findings/.test(consistencyPrompt));
  // 校正パケット側は弁として残す。ただし返ってきた件数を捨てないこと。
  t("校正パケット側は omitted_uncertain_findings を使い続けている",
    /omitted_uncertain_findings に件数だけ入れてください/.test(html));
  t("取り込み時に omitted_uncertain_findings の件数を画面へ出す（黙って捨てない）",
    /data\?\.omitted_uncertain_findings/.test(html) && /報告せず件数だけ返しました/.test(html));
}

t("添付ファイル名も観点ごとに分けている（並列で同名だと添付が競合する）",
  /prompt_name: withLens\(/.test(html) && /text_name: withLens\(/.test(html) &&
  /pdf_name: pdf_base64 \? withLens\(/.test(html));

if (bad) { console.error(`\nTest-ConsistencyLenses: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-ConsistencyLenses: PASS");
