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
//   - 距離統制ペアが各距離に十分あること（drift 2件 / number 3件。1件だと recall が 0/100 しか取らない）
//   - 訳語の揺れの用語が文書全体で anchor と error の2箇所にしか出ないこと
//     （近い別ページに漏れていると、その幅でも拾えてしまい距離が測れない）
//   - 行レベル誤りが全編に等間隔で散っていること
//   - 引用が文書全体で一意であること（ページ単位の採点が成立する条件）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DRIFT_PAIRS, NUMBER_PAIRS, LINE_ERRORS, LOCAL_ERRORS, TERM_PAIRS }
  from "../docs/benchmarks/fixtures/long-fixture-content.mjs";

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
// 柱（走りヘッダ）とノンブルはページの体裁であって本文ではない。
// 英語の柱だけ "March 31, 2026" と日付が入るので、本文比較からは外す。
const stripFurniture = s => s
  .replace(/^[^>]*>/, " ")                                      // 分割で残る data-n="10"> の断片
  .replace(/<div class="hdr">[\s\S]*?<\/div>/g, " ")
  .replace(/<div class="pgnum">[\s\S]*?<\/div>/g, " ");
const splitPages = html => html.split(/<div class="page"/).slice(1).map(x => norm(stripFurniture(x)));
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
  // ⚠️ 2026-08-06（素材v3）に 10/60/120 の3組を term へ転用した。drift は担当外の対照群で、
  //    8件も要らない。term のほうは「種別語は同じで修飾語だけが違う」型が1件しか無く、
  //    観点を直したかどうかを測れなかったので、対照群からページを回した。
  t("距離は 3/20/40/80/100 の5段（10/60/120 は term へ転用）",
    JSON.stringify([...byDist.keys()].sort((a, b) => a - b)) === JSON.stringify([3, 20, 40, 80, 100]),
    [...byDist.keys()].sort((a, b) => a - b).join(","));
  // ⚠️ drift は各距離1件。訳語の揺れは REF が無いと原理的に判定できない層なので、
  //    主計器は term（形式の揺れ）に譲り、drift は対照群として残してある。
  t("各距離1件ずつある（対照群）", [...byDist.values()].every(v => v === 1));
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
  t(`数値ペアのうち ${both.length} 件が原文＋英訳の両方に食い違いを持つ`, both.length === 24);

  // drift と同じ水準の計器になっているか（3件は「当たり外れ」と「届かない」を分ける最小）
  const numByDist = new Map();
  for (const n of both) numByDist.set(n.distance, (numByDist.get(n.distance) || 0) + 1);
  t("跨ぎ数値の距離は 5/15/30/50/70/90/110/130 の8段",
    JSON.stringify([...numByDist.keys()].sort((a, b) => a - b)) === JSON.stringify([5, 15, 30, 50, 70, 90, 110, 130]),
    [...numByDist.keys()].sort((a, b) => a - b).join(","));
  t("各距離に3件ずつある（1・2件では単発runの振れと区別できない）",
    [...numByDist.values()].every(v => v === 3), [...numByDist.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  // 幅100を超える帯が無いと「幅100で足りる」が言えない（届かない誤りが素材に無いだけになる）
  t("幅100を超える距離の帯がある（110/130）",
    [110, 130].every(d => (numByDist.get(d) || 0) >= 3));

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
  t("対照群が2件ある（EN のみ誤り・ローカルでも気づける）",
    ctrl.length === 2 && ctrl.every(c => c.local_hint === true));
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

// --- 3b. 意図しない日英不一致が無いか -----------------------------------
{
  // 乱数を日英で別々に計算すると全ページに意図しない数値不一致が入る。
  // 実測: 全139ページ（当時）が該当し、Copilot の指摘115件はほぼ全部その巻き添えで、
  // precision も recall も測れなかった。生成物の側でも見張る。
  const jaOf = enPage => (enPage >= 2 ? enPage + 1 : enPage);
  const numsOf = txt => [...txt.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
    .map(m => m[0].replace(/,+$/, "")).filter(x => x.replace(/[-,.]/g, "").length >= 2);
  const counted = list => { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return m; };
  const planned = new Set([
    ...NUMBER_PAIRS.flatMap(n => [n.correct, n.wrong]),
    ...LOCAL_ERRORS.flatMap(t2 => t2.diffNums || []),   // 数値誤訳は意図して食い違わせている
  ]);
  // 訳し分け・言語ごとの実ページで正当に数字が変わるページ（builder の KNOWN と同じ）。
  //   2 = 目次（各言語の実ページを載せるので【表紙】のぶんだけずれる）
  const known = new Set([1, 2, 21, 87]);
  const bad = [];
  for (let p = 1; p <= enPages.length; p++) {
    if (known.has(p)) continue;
    const ja = counted(numsOf(jaPages[jaOf(p) - 1] || ""));
    const en = counted(numsOf(enPages[p - 1] || ""));
    const extra = [...en.keys()].filter(v => !planned.has(v) && (ja.get(v) || 0) < en.get(v));
    const missing = [...ja.keys()].filter(v => !planned.has(v) && (en.get(v) || 0) < ja.get(v));
    if (extra.length || missing.length) bad.push(`p${p}(EN:${extra} JA:${missing})`);
  }
  t("意図しない日英の数値不一致が無い", bad.length === 0, bad.slice(0, 6).join(" / "));
}

// --- 3c. 翻訳校正(A)の観点が揃っている ---------------------------------
{
  // 「日本語が数字を含めてきちんと英訳されているか」が実務の第一関心なのに、
  // 当初のフィクスチャには同一ページの数値誤訳が1件も無かった。
  const kinds = new Map();
  for (const p of planted) kinds.set(p.kind, (kinds.get(p.kind) || 0) + 1);
  for (const [k, min] of [["num-tr", 8], ["name-tr", 5], ["supply", 5], ["over", 3]]) {
    t(`${k} が ${min} 件ある`, (kinds.get(k) || 0) === min, `実際 ${kinds.get(k) || 0} 件`);
  }
  t("A の誤りは同一ページで完結する（distance=0）",
    planted.filter(p => ["num-tr", "name-tr", "supply", "over"].includes(p.kind)).every(p => p.distance === 0));
  t("A の誤りはローカルで気づける扱い（local_hint=true）",
    planted.filter(p => ["num-tr", "name-tr", "supply", "over"].includes(p.kind)).every(p => p.local_hint === true));

  // 数値誤訳は日英で数字が食い違うのが本体。食い違っていなければ誤りになっていない。
  const jaOf = enPage => (enPage >= 2 ? enPage + 1 : enPage);
  // 数値はトークンで比べる（"26" は "2026" の部分文字列なので includes では誤判定する）
  const tokens = txt => new Set([...txt.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map(m => m[0].replace(/,+$/, "")));
  for (const e of LOCAL_ERRORS.filter(x => (x.diffNums || []).length === 2)) {
    const [correct, wrong] = e.diffNums;
    const ja = tokens(jaPages[jaOf(e.enPage) - 1] || ""), en = tokens(enPages[e.enPage - 1] || "");
    t(`${e.id}: REF に ${correct}、英訳に ${wrong}`, ja.has(correct) && en.has(wrong));
    t(`${e.id}: 英訳に正しい値 ${correct} が残っていない`, !en.has(correct));
  }
}

// --- 3d. 形式の揺れ(B4)が「英語だけで分かる」形になっている ------------
{
  // drift との違いが計器の肝である。term は**同じものを指しているのが英語だけで分かる**組
  // でなければならない。原文を知らないと分からない組を入れてしまうと drift と同じになり、
  // 「REFなしでも取れる層」を測れなくなる。
  const term = planted.filter(p => p.kind === "term");
  t(`形式の揺れが ${TERM_PAIRS.length} 件`, term.length === TERM_PAIRS.length);

  // 揺れの型で分ける。
  //   default  … 修飾語が同じで種別語が違う（Plant→Factory）／純粋な形の違い（複数形・記号）
  //   modifier … 種別語は同じで修飾語だけが違う（Production→Manufacturing Engineering Division）
  // ⚠️ 観点の判断基準（2026-08-06）は default 側しか覆っていない。modifier 側は m070 の1件しか
  //    無く、8回測って8回とも未検出だった。**直したかどうかを測れない**ので分母を足した。
  const base = term.filter(x => (x.variant || "default") === "default");
  const modifier = term.filter(x => x.variant === "modifier");
  const byDist = new Map();
  for (const x of base) byDist.set(x.distance, (byDist.get(x.distance) || 0) + 1);
  t("既定の型は距離 5/15/30/50/70/90/110/130 の8段",
    JSON.stringify([...byDist.keys()].sort((a, b) => a - b)) === JSON.stringify([5, 15, 30, 50, 70, 90, 110, 130]),
    [...byDist.keys()].sort((a, b) => a - b).join(","));
  t("既定の型は各距離に3件ずつある", [...byDist.values()].every(v => v === 3),
    [...byDist.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  t("modifier 型が4件ある（1件では単発runの振れと区別できない）", modifier.length === 4, String(modifier.length));
  t("modifier 型は距離が散っている（近い・中くらい・遠い）",
    new Set(modifier.map(x => x.distance)).size >= 3,
    modifier.map(x => x.distance).join(","));
  t("距離が anchor と error の実ページ差と一致", term.every(x => x.page - x.anchor_page === x.distance));
  t("ローカルでは検出できない扱い（local_hint=false）", term.every(x => x.local_hint === false));

  // 一方が他方の一部になる組（Standard / Standards）は素直に数えると2回に見える。
  // 包含を除いて数え、それぞれ1回であることを見る。
  const countExcluding = (hay, needle, other) => {
    const spans = [];
    for (let i = 0; other && (i = hay.indexOf(other, i)) >= 0; i++) spans.push([i, i + other.length]);
    let n = 0;
    for (let i = 0; (i = hay.indexOf(needle, i)) >= 0; i++) {
      if (!spans.some(([a, b]) => a <= i && i + needle.length <= b)) n++;
    }
    return n;
  };
  const leaked = TERM_PAIRS.filter(x => countOf(jaText, x.jaTerm) !== 2);
  t("日本語の呼称は anchor と error のちょうど2箇所だけ", leaked.length === 0,
    leaked.map(x => `${x.id}(${x.jaTerm})×${countOf(jaText, x.jaTerm)}`).join(", "));
  const enLeaked = TERM_PAIRS.filter(x =>
    countExcluding(enText, norm(x.enAnchor), norm(x.enError)) !== 1 ||
    countExcluding(enText, norm(x.enError), norm(x.enAnchor)) !== 1);
  t("2つの英語表記はそれぞれ1回だけ（包含を除いて数える）", enLeaked.length === 0,
    enLeaked.map(x => x.id).join(", "));

  // 「英語だけで同じものと分かる」ことの機械的な代用: 2つの表記が十分に似ていること。
  // まったく別語（drift のような組）が紛れ込んでいないかを見る。
  const share = (a, b) => {
    const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
    const wb = b.toLowerCase().split(/\W+/).filter(Boolean);
    return wb.filter(w => wa.has(w)).length / Math.max(wa.size, wb.length);
  };
  const tooFar = TERM_PAIRS.filter(x => share(x.enAnchor, x.enError) < 0.5);
  t("2つの表記は語の半分以上を共有している（同じものと英語だけで分かる）", tooFar.length === 0,
    tooFar.map(x => `${x.id}(${x.enAnchor} / ${x.enError})`).join(", "));
}

// --- 4. 1ページに2件を詰め込んでいない ---------------------------------
{
  // 同一ページに複数の planted があると、どちらを取ったのか切り分けられない。
  // anchor 側も含めて1ページ1件にしてある。
  const occupied = [];
  for (const d of DRIFT_PAIRS) occupied.push(d.anchorEnPage, d.errorEnPage);
  for (const n of NUMBER_PAIRS) occupied.push(n.anchorEnPage, n.errorEnPage);
  for (const l of LINE_ERRORS) occupied.push(l.enPage);
  for (const t2 of LOCAL_ERRORS) occupied.push(t2.enPage);
  for (const x of TERM_PAIRS) occupied.push(x.anchorEnPage, x.errorEnPage);
  t("埋め込み先のページが重複していない", new Set(occupied).size === occupied.length);
  t("表紙（p1）には埋め込んでいない", !occupied.includes(1));
}

if (failures) { console.error(`\nTest-LongFixture: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-LongFixture: PASS");
