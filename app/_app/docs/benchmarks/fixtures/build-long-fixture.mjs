// build-long-fixture.mjs — 長尺フィクスチャ（200ページ）と gold set を生成する。
//
//   node docs/benchmarks/fixtures/build-long-fixture.mjs
//
// 目的は「整合性レビューは何ページ幅、校正パケットは何ページ幅が適切か。そもそも
// 2つを分ける必要があるか」を実測で決めること。26ページの既存フィクスチャでは、
// 末尾セクションの畳み込みにより幅を何にしても1セクションになるため測定できない。
//
// 200ページなのは、跨ぎの計器を「1距離あたり3件・距離5〜130」で1ページ1件に置くため。
// 139ページでは空きページが足りず、距離130の帯は anchor が p9 以前にしか置けなかった。
//
// 出力:
//   aoi-long_ja_REF.pdf     日本語原文（正）
//   aoi-long_en_TARGET.pdf  英訳（既知の誤りを埋め込み済み）
//   gold-long.json          score.mjs 互換の正解セット（distance / kind 付き）
//   gold-long.md            人が読むための誤り一覧と、幅ごとの検出可能性の予測
//
// 生成前に次を機械検証し、1つでも破れたら中断する（gold と本文がずれるのを防ぐ）:
//   - planted の quote が該当ページの英文に実在し、かつ文書全体で一意であること
//   - 訳語の揺れペアの日本語用語が文書全体でちょうど2回（anchor と error だけ）出ること
//   - 対応する英訳語がそれぞれ1回だけ出ること（他ページに漏れると実効距離が縮む）
//   - 数値ペアの正・誤の数値がそれぞれ一意であること
//   - 1つの .page が印刷1ページに収まり、PDFの総ページ数が想定と一致すること

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PAGES, DRIFT_PAIRS, NUMBER_PAIRS, LINE_ERRORS, LOCAL_ERRORS, TERM_PAIRS, STRUCTURE_PAIRS, STRUCTURE_LOCAL, DOC } from "./long-fixture-content.mjs";
import { computeSections } from "../../../js/sectioning.mjs";

async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch { /* fallthrough */ }
  try {
    const { execSync } = await import("node:child_process");
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    // Windows の生パス（c:\...）は import できない。file:// へ直す。
    return (await import(pathToFileURL(join(root, "playwright", "index.js")).href)).chromium;
  } catch { return null; }
}

// playwright が無い実機（Windows）でも作り直せるようにする。
// 実機に必ずある Edge/Chrome を headless で叩いて印刷する。中身は同じ Chromium なので
// 改ページは playwright と一致する（既存の139/140ページで一致を確認済み）。
// 生成物の正しさは「.page の数と PDF のページ数が一致するか」で最終判定するので、
// どちらの経路で刷ったかに関わらず、ずれれば中断する。
function findBrowserExe() {
  const cands = [
    process.env.KOSEI_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  return cands.find(p => existsSync(p)) || null;
}

async function printWithBrowserExe(exe, htmlPath, pdfPath) {
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const profile = join(tmpdir(), `kosei-fixture-${process.pid}`);
  execFileSync(exe, [
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    `--user-data-dir=${profile}`,             // 利用者の常用プロファイルを触らない
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ], { stdio: "ignore", timeout: 180000 });
}

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

// score.mjs の突き合わせが小文字化して行うので、検証もそれに合わせる
// （文頭に来て大文字になった用語を「存在しない」と誤判定しないため）。
const norm = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const countOf = (hay, needle) => {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const k = hay.indexOf(needle, i); if (k < 0) break; n++; i = k + 1; }
  return n;
};

// needle の出現のうち、other の出現に含まれるものを除いて数える。
// 「the Nagoya Branch」は「the Nagoya Branch Office」の一部なので、素直に数えると2回に見える。
function countExcluding(hay, needle, other) {
  if (!needle) return 0;
  const spans = [];
  for (let i = 0; other && (i = hay.indexOf(other, i)) >= 0; i++) spans.push([i, i + other.length]);
  let n = 0;
  for (let i = 0; (i = hay.indexOf(needle, i)) >= 0; i++) {
    if (!spans.some(([a, b]) => a <= i && i + needle.length <= b)) n++;
  }
  return n;
}

const problems = [];
const fail = msg => problems.push(msg);

// ---- ページ配列（jaOnly は英語ページを持たない＝日英でページがずれる） ----
const pages = PAGES.map(p => ({ chapter: p.chapter, ja: p.ja, en: p.en, jaOnly: !!p.jaOnly }));
const enOrder = pages.filter(p => !p.jaOnly);
const enPageOf = new Map(enOrder.map((p, i) => [p, i + 1]));
const jaPageOf = new Map(pages.map((p, i) => [p, i + 1]));
const byEnPage = new Map(enOrder.map((p, i) => [i + 1, p]));

// ---- 埋め込み ----
const claimed = new Map();   // enPage -> 誰が使ったか（衝突検出）
function inject(enPage, who, jaHtml, enHtml) {
  const target = byEnPage.get(enPage);
  if (!target) { fail(`${who}: 英語ページ ${enPage} が存在しない（全 ${enOrder.length}ページ）`); return null; }
  if (enPage <= 1) { fail(`${who}: 表紙（p1）には埋め込まない`); return null; }
  const prev = claimed.get(enPage);
  if (prev) { fail(`${who}: 英語ページ ${enPage} は既に ${prev} が使っている（1ページ1件にする）`); return null; }
  claimed.set(enPage, who);
  if (jaHtml) target.ja += `\n${jaHtml}`;
  if (enHtml) target.en += `\n${enHtml}`;
  return target;
}

const gold = [];

for (const d of DRIFT_PAIRS) {
  if (d.errorEnPage - d.anchorEnPage !== d.distance) {
    fail(`${d.id}: distance=${d.distance} だが ${d.anchorEnPage}→${d.errorEnPage} は ${d.errorEnPage - d.anchorEnPage}`);
  }
  inject(d.anchorEnPage, `${d.id}(anchor)`, `<p>${d.ja1}</p>`, `<p>${d.en1}</p>`);
  const errPage = inject(d.errorEnPage, `${d.id}(error)`, `<p>${d.ja2}</p>`, `<p>${d.en2}</p>`);
  if (!errPage) continue;
  gold.push({
    id: d.id, page: d.errorEnPage, lens: "wording", quote: d.enError,
    kind: "drift", distance: d.distance, anchor_page: d.anchorEnPage,
    // 揺れはどちらのページを主たる箇所として報告してもよい。相手方を alt に持たせる。
    alt: [{ page: d.anchorEnPage, quote: d.enAnchor }],
    ref_page: jaPageOf.get(errPage), local_hint: false,
    why: `「${d.jaTerm}」の英訳が p${d.anchorEnPage} では ${d.enAnchor}、p${d.errorEnPage} では ${d.enError} と揺れている`,
  });
}

for (const n of NUMBER_PAIRS) {
  if (n.errorEnPage - n.anchorEnPage !== n.distance) {
    fail(`${n.id}: distance=${n.distance} だが ${n.anchorEnPage}→${n.errorEnPage} は ${n.errorEnPage - n.anchorEnPage}`);
  }
  inject(n.anchorEnPage, `${n.id}(anchor)`, `<p>${n.ja1}</p>`, `<p>${n.en1}</p>`);
  const errPage = inject(n.errorEnPage, `${n.id}(error)`, `<p>${n.ja2}</p>`, `<p>${n.en2}</p>`);
  if (!errPage) continue;
  const both = (n.side || "both") === "both";
  gold.push({
    id: n.id, page: n.errorEnPage, lens: "numbers", quote: n.quote,
    kind: both ? "number" : "number-local", distance: n.distance, anchor_page: n.anchorEnPage,
    alt: [{ page: n.anchorEnPage, quote: n.correct }],
    ref_page: jaPageOf.get(errPage), local_hint: !both, side: both ? "both" : "target",
    why: both
      ? `${n.label}が p${n.anchorEnPage} で ${n.correct}、p${n.errorEnPage} で ${n.wrong} と食い違う。原文にも同じ食い違いがあるため、そのページだけを REF と突き合わせても出ない`
      : `${n.label}は p${n.anchorEnPage} で ${n.correct}。p${n.errorEnPage} の英訳だけが ${n.wrong} と書いている（REF は数値を繰り返していない）。対照群`,
  });
}

// A: 同一ページで完結する翻訳の誤り（数値・固有名詞・省略の補完・補い過ぎ）
for (const t of LOCAL_ERRORS) {
  const target = inject(t.enPage, t.id, `<p>${t.ja}</p>`, `<p>${t.en}</p>`);
  if (!target) continue;
  gold.push({
    id: t.id, page: t.enPage, lens: t.lens, quote: t.quote,
    kind: t.kind, distance: 0, anchor_page: null,
    ref_page: jaPageOf.get(target), local_hint: true, why: t.why,
  });
}

// B4: 形式の揺れ（固有名詞・制度名・規程名の表記が2箇所で食い違う）
// drift と違い、**英語だけを読んでも同じものを指していると分かる**組にしてある。
// gold の quote は表記そのものではなく、それを含む一意な断片を持たせる
// （Standard / Standards のように一方が他方の一部になる組があるため）。
for (const t of TERM_PAIRS) {
  if (t.errorEnPage - t.anchorEnPage !== t.distance) {
    fail(`${t.id}: distance=${t.distance} だが ${t.anchorEnPage}→${t.errorEnPage} は ${t.errorEnPage - t.anchorEnPage}`);
  }
  inject(t.anchorEnPage, `${t.id}(anchor)`, `<p>${t.ja1}</p>`, `<p>${t.en1}</p>`);
  const errPage = inject(t.errorEnPage, `${t.id}(error)`, `<p>${t.ja2}</p>`, `<p>${t.en2}</p>`);
  if (!errPage) continue;
  gold.push({
    id: t.id, page: t.errorEnPage, lens: "wording", quote: t.quote,
    kind: "term", distance: t.distance, anchor_page: t.anchorEnPage,
    // 揺れの型。既定（印なし）は「修飾語が同じで種別語が違う」か純粋な形の違い。
    // "modifier" は「種別語は同じで修飾語だけが違う」型で、2026-08-06 に足した層。
    // 観点の判断基準はいまのところ前者しか覆っていない（引き継ぎ書 §7.11 / §7.12）。
    variant: t.variant || "default",
    alt: [{ page: t.anchorEnPage, quote: t.altQuote }],
    ref_page: jaPageOf.get(errPage), local_hint: false,
    why: `「${t.jaTerm}」の表記が p${t.anchorEnPage} では ${t.enAnchor}、p${t.errorEnPage} では ${t.enError} と揺れている（同じ固有名詞・制度名は表記を揃えるのが規範）`,
  });
}

// B5: 番号と参照の整合（項番・注記番号・表番号・相互参照）。
// term と同じく英語だけで判定できるが、機構が違う（語の一致ではなく番号の指す先）。
for (const t of STRUCTURE_PAIRS) {
  if (t.errorEnPage - t.anchorEnPage !== t.distance) {
    fail(`${t.id}: distance=${t.distance} だが ${t.anchorEnPage}→${t.errorEnPage} は ${t.errorEnPage - t.anchorEnPage}`);
  }
  inject(t.anchorEnPage, `${t.id}(anchor)`, `<p>${t.ja1}</p>`, `<p>${t.en1}</p>`);
  const errPage = inject(t.errorEnPage, `${t.id}(error)`, `<p>${t.ja2}</p>`, `<p>${t.en2}</p>`);
  if (!errPage) continue;
  gold.push({
    id: t.id, page: t.errorEnPage, lens: "structure", quote: t.quote,
    kind: "structure", distance: t.distance, anchor_page: t.anchorEnPage,
    alt: [{ page: t.anchorEnPage, quote: t.altQuote }],
    ref_page: jaPageOf.get(errPage), local_hint: false, why: t.why,
  });
}

// 同一ページで完結する番号の誤り（項番の欠番・脚注記号の孤立）。
for (const t of STRUCTURE_LOCAL) {
  const target = inject(t.enPage, t.id, `<p>${t.ja}</p>`, `<p>${t.en}</p>`);
  if (!target) continue;
  gold.push({
    id: t.id, page: t.enPage, lens: "structure", quote: t.quote,
    kind: "structure-local", distance: 0, anchor_page: null,
    ref_page: jaPageOf.get(target), local_hint: true, why: t.why,
  });
}

for (const l of LINE_ERRORS) {
  const target = inject(l.enPage, l.id, l.jaAdd, l.enAdd);
  if (!target) continue;
  gold.push({
    id: l.id, page: l.enPage, lens: l.kind === "omission" ? "translation" : l.kind, quote: l.quote,
    kind: l.kind, distance: 0, anchor_page: null,
    ref_page: jaPageOf.get(target), local_hint: true, why: l.why,
  });
}

// ---- 検証 ----
const jaText = norm(pages.map(p => p.ja).join(" "));
const enText = norm(enOrder.map(p => p.en).join(" "));

for (const g of gold) {
  const target = byEnPage.get(g.page);
  if (!target) continue;
  const body = norm(target.en);
  if (!body.includes(norm(g.quote))) fail(`${g.id}: quote が p${g.page} の英文に無い → ${g.quote}`);
  const c = countOf(enText, norm(g.quote));
  if (c !== 1) fail(`${g.id}: quote が文書全体で ${c} 回出る（1回でないとページ単位の採点ができない） → ${g.quote}`);
}

for (const d of DRIFT_PAIRS) {
  // 用語が他ページにも出ると「もっと近いページ同士で気づける」ことになり、実効距離が縮む。
  const jc = countOf(jaText, d.jaTerm);
  if (jc !== 2) fail(`${d.id}: 日本語用語「${d.jaTerm}」が文書全体で ${jc} 回（anchor と error のちょうど2回である必要がある）`);
  for (const [label, term] of [["anchor訳", d.enAnchor], ["error訳", d.enError]]) {
    const ec = countOf(enText, norm(term));
    if (ec !== 1) fail(`${d.id}: ${label}「${term}」が英文全体で ${ec} 回（1回である必要がある）`);
  }
  if (norm(d.en1).includes(norm(d.enError)) || norm(d.en2).includes(norm(d.enAnchor))) {
    fail(`${d.id}: anchor訳と error訳が互いに部分文字列になっている（別語にすること）`);
  }
}

for (const n of NUMBER_PAIRS) {
  // side="both" は原文にも同じ食い違いを入れるので、REF 側にも誤った数値が1回出るのが正しい。
  // これが 0 回だと「そのページの REF と突き合わせれば分かる」形に戻ってしまい、距離の計器にならない。
  const wantJaWrong = (n.side || "both") === "both" ? 1 : 0;
  for (const [label, hay, term, want] of [
    ["英文の先行ページの数値", enText, n.correct, 1], ["英文の後続ページの数値", enText, n.wrong, 1],
    ["REFの先行ページの数値", jaText, n.correct, 1], ["REFの後続ページの数値", jaText, n.wrong, wantJaWrong],
  ]) {
    const c = countOf(hay, term);
    if (c !== want) fail(`${n.id}(side=${n.side || "both"}): ${label}「${term}」が ${c} 回（期待 ${want} 回）`);
  }
  // side="both" の肝は「そのページ内で日英が一致している」こと。ここが崩れるとローカルで出てしまう。
  if (wantJaWrong === 1 && !(norm(n.ja2).includes(n.wrong) && norm(n.en2).includes(n.wrong))) {
    fail(`${n.id}: side=both なのに後続ページの日英どちらかに ${n.wrong} が無い`);
  }
}

// 形式の揺れ: 日本語の呼称は文書全体でちょうど2回、2つの英語表記はそれぞれ1回。
// ⚠️ 一方が他方の一部になる組（Standard / Standards、Branch / Branch Office）を
//    わざと入れてあるので、**包含を除いて**数える。素直に数えると anchor が2回に見え、
//    「表記が漏れている」と誤って中断する。
for (const t of TERM_PAIRS) {
  const jc = countOf(jaText, t.jaTerm);
  if (jc !== 2) fail(`${t.id}: 日本語の呼称「${t.jaTerm}」が文書全体で ${jc} 回（anchor と error のちょうど2回である必要がある）`);
  const a = norm(t.enAnchor), b = norm(t.enError);
  if (a === b) fail(`${t.id}: 2つの表記が同じ`);
  const ac = countExcluding(enText, a, b), bc = countExcluding(enText, b, a);
  if (ac !== 1) fail(`${t.id}: 表記「${t.enAnchor}」が英文全体で ${ac} 回（1回である必要がある）`);
  if (bc !== 1) fail(`${t.id}: 表記「${t.enError}」が英文全体で ${bc} 回（1回である必要がある）`);
  // quote / altQuote は採点の足場。それぞれの表記を含んでいなければ、
  // 「表記の揺れを指摘した」ことを採点で確かめられない。
  if (!norm(t.quote).includes(b)) fail(`${t.id}: quote に error 側の表記が入っていない`);
  if (!norm(t.altQuote).includes(a)) fail(`${t.id}: altQuote に anchor 側の表記が入っていない`);
}

// ---- 意図しない日英不一致がないか ----
// 乱数から作る値を日本語側と英語側で別々に計算すると、全ページに意図しない数値不一致が入る。
// 実測: 全139ページ（当時）が該当し、Copilot の指摘115件はほぼ全部その巻き添えだった。
// gold に無い誤りが本文中に大量にあると、precision も recall も測れない。
{
  const jaOf = enPage => (enPage >= 2 ? enPage + 1 : enPage);   // 【表紙】の分だけ日本語が1ページ後ろ
  const numsOf = html => [...norm(html).matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
    .map(m => m[0].replace(/,+$/, ""))
    .filter(x => x.replace(/[-,.]/g, "").length >= 2);
  const counted = list => { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return m; };
  // 意図して片側にだけ置いた数値（数値ペアの誤り側・正側）は除く
  const planned = new Set();
  for (const n of NUMBER_PAIRS) { planned.add(n.correct); planned.add(n.wrong); }
  for (const t of LOCAL_ERRORS) for (const v of t.diffNums || []) planned.add(v);

  // 訳し分けで正当に数字が変わる箇所。理由を書いて明示的に許可する（黙って閾値を緩めない）。
  const KNOWN = new Map([
    [1, "英語の期表記に March 31, 2026 が入る（日本語は「2026年3月期」）"],
    [2, "目次は各言語の実ページを載せる。【表紙】が英訳に無いぶん日本語が1ページ後ろになる"],
    [21, "5,200億円 → 520.0 billion yen（単位の書き換え）"],
    [87, "約4割 → approximately 40%（割合の表記）"],
  ]);

  const offenders = [];
  const unusedKnown = new Set(KNOWN.keys());
  for (let p = 1; p <= enOrder.length; p++) {
    const ja = counted(numsOf(pages[jaOf(p) - 1].ja));
    const en = counted(numsOf(enOrder[p - 1].en));
    const extra = [...en.keys()].filter(v => !planned.has(v) && (ja.get(v) || 0) < en.get(v));
    const missing = [...ja.keys()].filter(v => !planned.has(v) && (en.get(v) || 0) < ja.get(v));
    if (extra.length || missing.length) {
      if (KNOWN.has(p)) { unusedKnown.delete(p); continue; }
      offenders.push(`p${p}: EN側のみ[${extra.slice(0, 6)}] JA側のみ[${missing.slice(0, 6)}]`);
    }
  }
  if (offenders.length) {
    fail(`意図しない日英の数値不一致が ${offenders.length} ページにある（乱数を日英で別々に計算していないか確認）:\n      `
      + offenders.slice(0, 10).join("\n      "));
  }
  // 許可リストが古くなっていたら知らせる（黙って例外を積み残さない）
  if (unusedKnown.size) {
    console.warn(`注意: 数値差の許可リストに、もう差が無いページが残っています: ${[...unusedKnown].join(", ")}`);
  }
}

if (problems.length) {
  console.error("埋め込みの検証に失敗:\n" + problems.map(s => "  - " + s).join("\n"));
  process.exit(1);
}

// ---- HTML 組み立て（26ページ版と同じ体裁） ----
// 日本語のフォント指定は**PDFから抽出される文字**を左右する。
// Windows で Yu Gothic / Meiryo / Noto Sans JP に落ちると、Chromium が
// 「月」「高」「人」「水」「用」「立」「方」「子」「目」「十」を
// **康熙部首（⽉ ⾼ ⼈ …）の符号位置**で ToUnicode に書く。見た目は同じだが、
// 抽出テキストは別の文字になり、REFとの引用照合も数値マスクの単位語判定も狂う。
// MS Gothic / MS PGothic / BIZ UDGothic / MS Mincho では起きない（実測で確認）。
// IPAGothic を先頭に残してあるのは、playwright（Linux）で刷ったときの体裁を変えないため。
const CSS = lang => `
  @page { size: A4; margin: 16mm 15mm; }
  body { margin: 0; font-family: ${lang === "ja" ? '"IPAGothic","IPAPGothic","BIZ UDGothic","MS Gothic",sans-serif' : '"DejaVu Serif","Liberation Serif",serif'};
         font-size: ${lang === "ja" ? "10.5pt" : "10pt"}; line-height: 1.7; color: #111; }
  .page { min-height: 245mm; position: relative; }
  .page + .page { break-before: page; }
  .pgnum { position: absolute; bottom: 0; width: 100%; text-align: center; font-size: 8.5pt; color: #666; }
  .hdr { border-bottom: 1px solid #999; padding-bottom: 3px; margin-bottom: 10px; font-size: 8.5pt; color: #555; }
  h1 { font-size: 20pt; margin: 0 0 8mm; padding-top: 40mm; text-align: center; }
  h2 { font-size: 13pt; margin: 0 0 8px; border-left: 5px solid #234; padding-left: 8px; }
  h3 { font-size: 11.5pt; margin: 14px 0 6px; }
  h4 { font-size: 10.5pt; margin: 10px 0 4px; }
  p { margin: 0 0 8px; text-align: justify; }
  .lead { text-align: center; font-size: 12pt; }
  .note { font-size: 8.5pt; color: #444; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: ${lang === "ja" ? "9pt" : "8.5pt"}; }
  th, td { border: 1px solid #999; padding: 3px 5px; }
  th { background: #eef1f4; text-align: left; }
  td { text-align: right; }
  td:first-child, th:first-child { text-align: left; }
  table.toc, table.toc td, table.toc th { border: none; }
  table.toc td:last-child { text-align: right; }
`;

function buildHtml(lang, list) {
  const hdr = lang === "ja" ? `${DOC.companyJa}　${DOC.fiscalJa}` : `${DOC.companyEn} — ${DOC.fiscalEn}`;
  const body = list.map((p, i) => `
    <div class="page" data-n="${i + 1}">
      ${i === 0 ? "" : `<div class="hdr">${hdr}</div>`}
      ${lang === "ja" ? p.ja : p.en}
      ${i === 0 ? "" : `<div class="pgnum">- ${i + 1} -</div>`}
    </div>`).join("\n");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
    <title>${lang === "ja" ? DOC.companyJa : DOC.companyEn}</title>
    <style>${CSS(lang)}</style></head><body>${body}</body></html>`;
}

const jaHtml = buildHtml("ja", pages);
const enHtml = buildHtml("en", enOrder);
writeFileSync(join(OUT, "aoi-long_ja_REF.html"), jaHtml);
writeFileSync(join(OUT, "aoi-long_en_TARGET.html"), enHtml);

// ---- PDF 化とページ数の検証 ----
// 1つの .page が印刷1ページに収まらないと、gold のページ番号が全部ずれる。
// PDFの実ページ数を数えるのが最終判定。ずれたときに原因を探せるよう、
// 印刷幅で組んだときの各 .page の高さも測っておく。
function pdfPageCount(buf) {
  const s = buf.toString("latin1");
  const byType = (s.match(/\/Type\s*\/Page(?![s])/g) || []).length;
  const counts = [...s.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map(m => Number(m[1]));
  return { byType, byCount: counts.length ? Math.max(...counts) : null };
}

const targets = [
  ["aoi-long_ja_REF", jaHtml, pages.length],
  ["aoi-long_en_TARGET", enHtml, enOrder.length],
];
const chromium = await loadChromium();
const results = [];
if (chromium) {
  const browser = await chromium.launch();
  try {
    for (const [name, html, expected] of targets) {
      // 印刷時の本文幅は A4(210mm) - 左右余白(15mm×2) = 180mm ≒ 680px。
      const page = await browser.newPage({ viewport: { width: 680, height: 1000 } });
      await page.emulateMedia({ media: "print" });
      await page.setContent(html, { waitUntil: "load" });
      const tall = await page.evaluate(() => [...document.querySelectorAll(".page")]
        .map(el => ({ n: Number(el.dataset.n), h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h > 1000).slice(0, 10));
      const path = join(OUT, `${name}.pdf`);
      await page.pdf({ path, format: "A4", printBackground: true });
      await page.close();
      results.push({ name, expected, got: pdfPageCount(readFileSync(path)), tall });
    }
  } finally {
    await browser.close();
  }
} else {
  const exe = findBrowserExe();
  if (!exe) {
    console.error("PDF を刷れません: playwright も Edge/Chrome も見つかりません。\n" +
      "  npm i -g playwright（＋ npx playwright install chromium）を入れるか、\n" +
      "  KOSEI_BROWSER に Chromium 系ブラウザの実行ファイルを指定してください。");
    process.exit(1);
  }
  console.log(`playwright が無いので ${exe.split(/[\\/]/).pop()} で印刷します`);
  for (const [name, , expected] of targets) {
    const path = join(OUT, `${name}.pdf`);
    await printWithBrowserExe(exe, join(OUT, `${name}.html`), path);
    // はみ出し候補（各 .page の高さ）はブラウザCLIでは測れない。ページ数がずれたときは
    // playwright を入れて刷り直すと、どのページが溢れているかまで出る。
    results.push({ name, expected, got: pdfPageCount(readFileSync(path)), tall: [] });
  }
}

const overflow = [];
for (const r of results) {
  const actual = r.got.byCount ?? r.got.byType;
  if (actual !== r.expected) {
    overflow.push(`${r.name}: PDF ${actual}ページ / 想定 ${r.expected}ページ` +
      (r.tall.length ? `（はみ出し候補: ${r.tall.map(x => `p${x.n}=${x.h}px`).join(", ")}）` : ""));
  }
}
if (overflow.length) {
  console.error("ページ数が想定と一致しない（gold のページ番号がずれるため中断）:\n" +
    overflow.map(s => "  - " + s).join("\n"));
  process.exit(1);
}

// ---- gold 出力 ----
const OVERLAP = 3;
const WIDTHS = [10, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200];
// 幅を上げれば単調に増える、とは限らない。境界がどこに落ちるかで、距離が短いペアでも
// 分断されることがある（幅30が幅25より少ない、など）。したがって実測 recall は
// 「その幅で原理的に到達可能な集合」を分母に読む必要がある。その集合をここで出しておく。
const reachability = {};
const widthRows = WIDTHS.map(w => {
  const secs = computeSections(enOrder.length, { sectionWidth: w, overlap: OVERLAP });
  const inSameSection = pair => secs.some(s =>
    s.startPage <= pair.anchorEnPage && pair.errorEnPage <= s.endPage);
  const drift = DRIFT_PAIRS.filter(inSameSection);
  const num = NUMBER_PAIRS.filter(inSameSection);
  const term = TERM_PAIRS.filter(inSameSection);
  // 行レベル誤りと同一ページの翻訳誤りは単ページで完結するので、どの幅でも到達可能。
  const struct = STRUCTURE_PAIRS.filter(inSameSection);
  reachability[String(w)] = [...drift, ...num, ...term, ...struct].map(x => x.id)
    .concat(LINE_ERRORS.map(l => l.id)).concat(LOCAL_ERRORS.map(t => t.id))
    .concat(STRUCTURE_LOCAL.map(t => t.id)).sort();
  // term（形式の揺れ）/ number（跨ぎ数値）/ drift（訳語の揺れ）は別の機構なので、届く件数も別に出す。
  const numBoth = num.filter(n => (n.side || "both") === "both");
  const dists = [...new Set([...term, ...numBoth].map(d => d.distance))].sort((a, b) => a - b);
  return `| ${w} | ${secs.length} | ${term.length}/${TERM_PAIRS.length} | ${numBoth.length}/${
    NUMBER_PAIRS.filter(n => (n.side || "both") === "both").length} | ${drift.length}/${DRIFT_PAIRS.length} | ${dists.join(", ") || "—"} |`;
}).join("\n");

const byKind = {};
for (const g of gold) byKind[g.kind] = (byKind[g.kind] || 0) + 1;
const numBothCount = NUMBER_PAIRS.filter(n => (n.side || "both") === "both").length;
const numDistances = [...new Set(NUMBER_PAIRS.filter(n => (n.side || "both") === "both").map(n => n.distance))]
  .sort((a, b) => a - b);
const sorted = [...gold].sort((a, b) => a.page - b.page);

writeFileSync(join(OUT, "gold-long.json"), JSON.stringify({
  note: "長尺合成文書（架空企業）。セクション幅の実験用。page は TARGET(英訳) のページ番号。",
  // 素材の版。**planted を増減したら必ず上げること。**
  // 版が違う run どうしは分母が違うので比較してはいけない（採点時に score-runs.mjs が表示する）。
  //   v1: 200p / gold 118件（整合性の担当範囲 56件）
  //   v2: 200p / gold 128件（担当範囲 66件）。structure 4→8・structure-local 2→8。
  //       ページ番号は据え置きで、空きページにだけ追加している。
  //   v3: 200p / gold 129件（担当範囲 70件）。term 24→28（「種別語は同じで修飾語だけが違う」型を追加）。
  //       drift 8→5 に減らし、そのページを term へ転用した（対照群にページを使いすぎていた）。
  //   v4: 件数は v3 と同じ。**m120 の中身を差し替えた**（Safety→Security は別概念で、
  //       同一性の手がかりも無く、指摘しないほうが正しい項目だった＝素材の不当）。
  //       修飾語が同義語の組にし、両方の文に同じ適用範囲を書いて根拠を持たせた。
  //       ⚠️ 件数が同じでも中身を変えたら版を上げる。v3 の run と比べてはいけない。
  fixture_version: 4,
  target_pdf: "aoi-long_en_TARGET.pdf",
  ref_pdf: "aoi-long_ja_REF.pdf",
  target_pages: enOrder.length,
  ref_pages: pages.length,
  // 正しいが誤りではない指摘。precision の分母から外す。
  // 日本語 p2 の【表紙】は EDINET 様式で、英訳版には存在しないのが正しい。
  // まともなレビューなら必ず「訳抜け」として挙げるので、これを誤検知に数えると
  // 毎回 precision が実態より低く出る。読む手間は残るので review_burden には残す。
  ignored: [{ page: 1, quote: "Annual Securities Report",
              why: "日本語 p2 の【表紙】が英訳に無いのは EDINET 様式どおりで、誤りではない" }],
  // 幅ごとに「両ページが同じセクションに入る＝原理的に検出しうる」planted の id。
  // 重ね合わせは3ページ固定。score.mjs --reachable <幅> でこの集合を分母にできる。
  reachability_overlap: OVERLAP,
  reachability,
  packets: [{
    packet_id: "ALL",
    // ⚠️ ここは項目を明示列挙している。gold に新しい項目を足したら**この行にも足すこと**。
    //    実測（2026-08-06）: variant を gold.details には出していたのに planted に出しておらず、
    //    Test-LongFixture の「modifier 型が4件ある」が 0 件と出た（素材は正しかった）。
    planted: sorted.map(({ id, page, lens, quote, kind, distance, anchor_page, local_hint, side, variant, alt }) =>
      ({ id, page, lens, quote, kind, distance, anchor_page, local_hint,
        ...(side ? { side } : {}), ...(variant && variant !== "default" ? { variant } : {}), ...(alt ? { alt } : {}) })),
  }],
  details: sorted,
}, null, 2) + "\n");

// 幅 W のセクションで、ペアの両ページが同じセクションに入るか。
// 「距離 < 幅」の近似ではなく、実際の分割規則（等幅＋重ね＋末尾畳み込み）で数える。
// 境界をまたぐ位置に置かれたペアは距離が幅より短くても取れないので、近似より厳しくなる。

const rows = sorted.map(g =>
  `| ${g.id} | ${g.page} | ${g.anchor_page ?? "—"} | ${g.distance || "—"} | ${g.kind} | ${g.side === "both" ? "原文＋英訳" : "英訳のみ"} | ${g.local_hint ? "○" : "×"} | \`${g.quote.slice(0, 52)}\` | ${g.why} |`).join("\n");

writeFileSync(join(OUT, "gold-long.md"), `# 長尺フィクスチャ gold set（${gold.length}件）

架空企業「${DOC.companyJa} / ${DOC.companyEn}」${DOC.fiscalJa}。
TARGET(英訳) ${enOrder.length}ページ / REF(日本語原文) ${pages.length}ページ。
**REFは正**。誤りはすべて TARGET 側に埋め込んである。
日本語 p2 の【表紙】は英訳版に存在しないため、p3 以降は日英でページが1ずれる（誤りではない）。

内訳: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}件`).join(" / ")}

## 何を測るための文書か

| 問い | 使う誤り |
|------|----------|
| Q1 整合性レビューは何ページ幅が要るか | 距離統制ペア（drift ${DRIFT_PAIRS.length}件 / number ${NUMBER_PAIRS.length}件） |
| Q2 校正パケットは何ページ幅が要るか | 行レベル誤り（${LINE_ERRORS.length}件、6ページ間隔） |
| Q3 2つを分ける必要があるか | 同じ幅で両方の recall を見る |

**drift（訳語の揺れ）が距離の主計器**である。同じ日本語用語の英訳が2ページで食い違うだけで、
どちらの訳語も単独では正しく読める。つまり **1ページだけを REF と突き合わせても検出できない**。
両ページが同じセクションに入って初めて検出しうる。
生成時に「日本語用語は文書全体でちょうど2回」「各英訳語は1回」を検証しているので、
より近い別ページで気づけてしまうことはない。

**number（数値の食い違い）も距離の計器**である（${numBothCount}件・距離 ${numDistances.join("/")} × 各3件）。
こちらは**原文と英訳の両方に同じ食い違い**を入れてある。先行ページは日英とも ${NUMBER_PAIRS[0].correct}、
後続ページは日英とも ${NUMBER_PAIRS[0].wrong}。そのページだけを見れば日英は完全に一致しているので、
REF との突き合わせでは何も出ない。文書自身が2箇所で違うことを言っている矛盾だけが残る。
実務でも「原文の数値が古いまま残り、翻訳者は忠実に訳した」という形で普通に起きる。

> number と number-local は「REFは正」の前提から外れる（「誤りの側」列が「原文＋英訳」）。
> 整合性レビューのプロンプトは A: TARGET内部の跨ぎ整合 / B: REFとの照合 の二本立てで、
> これは **A の担当**である。どちらのページが正しいかは原理的に決まらないが、
> 採点は「矛盾を指摘したか」だけを見るので支障はない。

**term（形式の揺れ）が、REFなしの整合性レビューにとっての主計器**である
（${TERM_PAIRS.length}件・距離 ${[...new Set(TERM_PAIRS.map(t => t.distance))].sort((a, b) => a - b).join("/")} × 各3件）。
固有名詞・制度名・規程名が2箇所で違う表記になっている（\`the AOI Quality Standard\` と
\`the AOI Quality Standards\`、\`the Nagoya Branch\` と \`the Nagoya Branch Office\`）。
drift と違って**英語だけを読んでも同じものを指していると分かる**ので、原文が無くても判定できる。

> 会計連動（内訳の合計と総計の不一致）は**廃止した**。マスクした状態では記号を足すことになり、
> 原理的に成立しない（実測でも幅25/50/100/200 のすべてで 0/6 だった）。

**number-local は対照群**（${NUMBER_PAIRS.filter(n => n.side === "target").length}件、距離 ${
  NUMBER_PAIRS.filter(n => n.side === "target").map(n => n.distance).join("/")}）。
こちらは EN だけが誤りで REF はその数値を書いていないため、
ローカルでも「原文にない数値」として気づける余地がある。
**対照が取れて本体が取れないなら、モデルは跨ぎを見ておらずローカルなREF比較しかしていない**と分かる。

## 幅ごとの検出可能性（単純近似）

実際の分割規則（等幅＋重ね${OVERLAP}ページ＋末尾畳み込み）で、
ペアの両ページが同じセクションに入るかを数えたもの。**これが理論上の上限**で、実測はこれを下回る。

| セクション幅 | セクション数 | 届く term | 届く number | 届く drift | その距離 |
|---|---|---|---|---|---|
${widthRows}

**幅を広げれば単調に増えるわけではない**（幅30が幅25より少ない）。
境界がどこに落ちるかで、距離の短いペアでも分断されるためである。
したがって実測の recall は、その幅で**原理的に到達可能な集合を分母に**読む必要がある。
その集合は \`gold-long.json\` の \`reachability\` にあり、次で分母を揃えられる。

\`\`\`bash
node docs/benchmarks/score.mjs docs/benchmarks/fixtures/gold-long.json <run>.json --reachable 25 --by kind,distance
\`\`\`

## 埋め込み一覧

| ID | TARGET頁 | 対の頁 | 距離 | 種類 | 誤りの側 | ローカル | 該当箇所 | 内容 |
|----|---------|-------|------|------|---------|---------|----------|------|
${rows}
`);

console.log(`gold: ${gold.length}件 / TARGET ${enOrder.length}p / REF ${pages.length}p`);
console.log(`種類別: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`PDF: ${results.map(r => `${r.name}=${r.got.byCount ?? r.got.byType}p`).join(" / ")}`);
console.log(`出力: ${OUT}`);
