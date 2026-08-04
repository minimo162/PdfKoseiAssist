// Test-LongFixture.mjs — 長尺フィクスチャの gold が本文とずれていないかを検証する。
//
//   node tools/Test-LongFixture.mjs
//
// build-long-fixture.mjs は生成時に自己検証するが、生成物（HTML / gold-long.json）は
// リポジトリにコミットされるため、片方だけ手で触れば黙ってずれる。gold がずれると
// 「幅を変えたら recall が落ちた」のか「gold が本文と合っていない」のか区別できなくなる。
// そこで**生成物どうしを突き合わせる**独立のチェックを置く。
//
// 併せて、この文書が幅の実験の計器として成立していることも確認する:
//   - 距離統制ペアが各距離2件ずつあること（1件だと recall が 0/100 しか取らない）
//   - 訳語の揺れの用語が文書全体で anchor と error の2箇所にしか出ないこと
//     （近い別ページに漏れていると、その幅でも拾えてしまい距離が測れない）
//   - 行レベル誤りが全編に等間隔で散っていること
//   - 引用が文書全体で一意であること（ページ単位の採点が成立する条件）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DRIFT_PAIRS, NUMBER_PAIRS, LINE_ERRORS } from "../docs/benchmarks/fixtures/long-fixture-content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "..", "docs", "benchmarks", "fixtures");
const read = f => readFileSync(join(fx, f), "utf8");

let failures = 0;
const t = (name, cond, detail) => {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); if (detail) console.error(`       ${detail}`); }
  else console.log(`  ok   ${name}`);
};

const gold = JSON.parse(read("gold-long.json"));
const planted = gold.packets[0].planted;

const norm = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const splitPages = html => html.split(/<div class="page"/).slice(1).map(norm);
const enPages = splitPages(read("aoi-long_en_TARGET.html"));
const jaPages = splitPages(read("aoi-long_ja_REF.html"));
const enText = enPages.join(" ");
const jaText = jaPages.join(" ");
const countOf = (hay, needle) => { let n = 0, i = 0; for (;;) { const k = hay.indexOf(needle, i); if (k < 0) break; n++; i = k + 1; } return n; };

// --- 1. gold と本文が一致している -------------------------------------
{
  t(`TARGET のページ数が gold と一致（${enPages.length}）`, enPages.length === gold.target_pages);
  t(`REF のページ数が gold と一致（${jaPages.length}）`, jaPages.length === gold.ref_pages);
  t("REF のほうが1ページ多い（【表紙】が英訳に無い）", jaPages.length === enPages.length + 1);

  const offPage = planted.filter(p => !(enPages[p.page - 1] || "").includes(norm(p.quote)));
  t("すべての引用が gold のページに実在する", offPage.length === 0, offPage.map(p => p.id).join(", "));

  const notUnique = planted.filter(p => countOf(enText, norm(p.quote)) !== 1);
  t("すべての引用が文書全体で一意（ページ単位の採点が成立する）", notUnique.length === 0,
    notUnique.map(p => `${p.id}×${countOf(enText, norm(p.quote))}`).join(", "));

  const altBad = planted.filter(p => (p.alt || []).some(a => !(enPages[a.page - 1] || "").includes(norm(a.quote))));
  t("跨ぎの alt（相手方ページの引用）も実在する", altBad.length === 0);
}

// --- 2. 距離の計器として成立している -----------------------------------
{
  const drift = planted.filter(p => p.kind === "drift");
  t(`訳語の揺れペアが ${DRIFT_PAIRS.length} 件`, drift.length === DRIFT_PAIRS.length);

  const byDist = new Map();
  for (const d of drift) byDist.set(d.distance, (byDist.get(d.distance) || 0) + 1);
  t("距離は 3/10/20/40/60/80/100/120 の8段",
    JSON.stringify([...byDist.keys()].sort((a, b) => a - b)) === JSON.stringify([3, 10, 20, 40, 60, 80, 100, 120]));
  t("各距離に2件ずつある（1件だと recall が 0% か 100% しか取らない）",
    [...byDist.values()].every(v => v === 2));
  t("距離が anchor と error の実ページ差と一致",
    drift.every(d => d.page - d.anchor_page === d.distance));

  // 用語が他ページに漏れていると実効距離が縮み、実験が壊れる
  const leaked = DRIFT_PAIRS.filter(d => countOf(jaText, d.jaTerm) !== 2);
  t("日本語用語は anchor と error のちょうど2箇所だけ", leaked.length === 0,
    leaked.map(d => `${d.id}(${d.jaTerm})×${countOf(jaText, d.jaTerm)}`).join(", "));
  const enLeaked = DRIFT_PAIRS.filter(d => countOf(enText, norm(d.enAnchor)) !== 1 || countOf(enText, norm(d.enError)) !== 1);
  t("2つの英訳語はそれぞれ1回だけ", enLeaked.length === 0, enLeaked.map(d => d.id).join(", "));

  t("訳語の揺れはローカルでは検出できない扱い（local_hint=false）",
    drift.every(d => d.local_hint === false));
}

// --- 2b. 数値の食い違いが「原文と英訳の両方」に入っている ----------------
{
  // ここが本命の条件。後続ページの日英が一致していれば、そのページだけを
  // REF と突き合わせても何も出ない。跨ぎでしか出ない計器になる。
  // EN p1 は JA p1、EN p2以降は JA では1ページ後ろ（【表紙】が英訳に無いため）。
  const jaOf = enPage => (enPage >= 2 ? enPage + 1 : enPage);
  const both = NUMBER_PAIRS.filter(n => (n.side || "both") === "both");
  t(`数値ペアのうち ${both.length} 件が原文＋英訳の両方に食い違いを持つ`, both.length === 3);

  for (const n of both) {
    const enErr = enPages[n.errorEnPage - 1] || "";
    const jaErr = jaPages[jaOf(n.errorEnPage) - 1] || "";
    const enAnc = enPages[n.anchorEnPage - 1] || "";
    const jaAnc = jaPages[jaOf(n.anchorEnPage) - 1] || "";
    t(`${n.id}: 後続ページは日英とも ${n.wrong}（ローカルでは矛盾しない）`,
      enErr.includes(n.wrong) && jaErr.includes(n.wrong));
    t(`${n.id}: 先行ページは日英とも ${n.correct}`,
      enAnc.includes(n.correct) && jaAnc.includes(n.correct));
    t(`${n.id}: 後続ページに ${n.correct} が現れない（同一ページ内で完結させない）`,
      !enErr.includes(n.correct) && !jaErr.includes(n.correct));
  }

  const ctrl = planted.filter(p => p.kind === "number-local");
  t("対照群が1件だけある（EN のみ誤り・ローカルでも気づける）",
    ctrl.length === 1 && ctrl[0].local_hint === true);
  t("本体の数値ペアはローカルでは気づけない扱い（local_hint=false）",
    planted.filter(p => p.kind === "number").every(p => p.local_hint === false && p.side === "both"));
}

// --- 3. 行レベル誤りが全編に散っている ---------------------------------
{
  const line = planted.filter(p => ["spelling", "grammar", "omission"].includes(p.kind));
  t(`行レベル誤りが ${LINE_ERRORS.length} 件`, line.length === LINE_ERRORS.length);
  const pages = line.map(p => p.page).sort((a, b) => a - b);
  t("6ページ間隔で並んでいる", pages.every((p, i) => i === 0 || p - pages[i - 1] === 6));
  t("先頭付近から末尾付近まで届いている", pages[0] <= 6 && pages[pages.length - 1] >= enPages.length - 6);
  const kinds = new Set(line.map(p => p.kind));
  t("綴り・文法・訳抜けの3種類が揃っている", kinds.size === 3);
  t("同じ文面を使い回していない（1件にまとめられて件数が測れなくなる）",
    new Set(line.map(p => p.quote)).size === line.length);
}

// --- 4. 1ページに2件を詰め込んでいない ---------------------------------
{
  // 同一ページに複数の planted があると、どちらを取ったのか切り分けられない。
  // anchor 側も含めて1ページ1件にしてある。
  const occupied = [];
  for (const d of DRIFT_PAIRS) occupied.push(d.anchorEnPage, d.errorEnPage);
  for (const n of NUMBER_PAIRS) occupied.push(n.anchorEnPage, n.errorEnPage);
  for (const l of LINE_ERRORS) occupied.push(l.enPage);
  t("埋め込み先のページが重複していない", new Set(occupied).size === occupied.length);
  t("表紙（p1）には埋め込んでいない", !occupied.includes(1));
}

if (failures) { console.error(`\nTest-LongFixture: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-LongFixture: PASS");
