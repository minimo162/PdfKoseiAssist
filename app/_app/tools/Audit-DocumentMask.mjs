// Audit-DocumentMask.mjs — 実物のPDFで、製品のマスカーが何を伏せ損ねるかを見る。
//
//   node tools/Audit-DocumentMask.mjs docs/benchmarks/real/shionogi_160th_en.pdf
//   node tools/Audit-DocumentMask.mjs <pdf> --lang ja      … 日本語文書として通す
//   node tools/Audit-DocumentMask.mjs <pdf> --show 40      … 事例の表示件数
//
// なぜ要るか（2026-08-05 実測）:
//   合成フィクスチャ（docs/benchmarks/fixtures/）は「日英で数値を必ず揃える」ように
//   作ってあるので素直すぎる。実物の有価証券報告書（167p）で整合性レビューを回したら、
//   1本目のセクションで
//     「数値を伏せきれませんでした（43件: partial-mask@452913, unmasked-number@28613 …）」
//   となり、verify() が設計どおり**送信を中止**した。つまり実物では**1指摘も出ない**。
//   Test-FixtureTextLayer.mjs は同じ検査をフィクスチャに対してやるが、
//   実物は gold が無いので通せない。この道具は gold を要求せず、
//   **伏せ損ねの現物を前後の文脈つきで並べる**ことだけをする。
//
// 出力は「型ごとの件数」と「実例」。仕様（docs/plan/NUMBER_MASKING_SPEC.md）に
// 規則を足すときは、必ずここに出た現物を根拠にすること。
//
// pdf.js はブラウザ用ビルドなので Node からは読めない（DOMMatrix が無い）。
// Test-FixtureTextLayer.mjs と同じく、ローカルに配ってヘッドレスEdgeで実行する。

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { Masker, maskSidecarByRole, verify } from "../js/number-mask.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");

const argv = process.argv.slice(2);
const pdfArg = argv.find(a => !a.startsWith("--"));
const lang = (argv[argv.indexOf("--lang") + 1] && argv.includes("--lang")) ? argv[argv.indexOf("--lang") + 1] : "en";
const show = argv.includes("--show") ? Number(argv[argv.indexOf("--show") + 1]) || 20 : 20;
if (!pdfArg) {
  console.error("usage: node tools/Audit-DocumentMask.mjs <pdf> [--lang en|ja] [--show N]");
  process.exit(2);
}
const pdfPath = resolve(pdfArg);
if (!existsSync(pdfPath)) { console.error(`ありません: ${pdfPath}`); process.exit(2); }

function findBrowserExe() {
  return [
    process.env.KOSEI_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean).find(p => existsSync(p)) || null;
}
const exe = findBrowserExe();
if (!exe) { console.log("SKIP: Edge/Chrome が見つかりません（KOSEI_BROWSER で指定できます）"); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), "kosei-maskaudit-"));
copyFileSync(pdfPath, join(tmp, "doc.pdf"));

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const post = t => fetch("/result", { method: "POST", body: JSON.stringify(t) });
try {
  const pdfjs = await import("/app/pdfjs/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/app/pdfjs/build/pdf.worker.min.mjs";
  // ⚠️ **製品と同じ再構成を使うこと。** 実測（2026-08-06）: pdfjs の hasEOL で改行していたら、
  //    アプリが実際に送っているテキストと**行の切れ方が違い**、この道具の数字が製品の挙動と
  //    対応しなくなっていた（p4 の単位が、製品では「Millions」/ 数値行 /「of Yen」と
  //    離れて並ぶのに、この道具では隣り合って見えていた）。
  //    以下は index.html の reconstructTextContentByVisualLines と同じ処理。
  //    ⚠️ ここはテンプレート文字列の中。バッククォートを書くと文字列がそこで閉じる。
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const reconstruct = (content) => {
    const items = (content.items || []).map(item => {
      const str = String(item?.str || "");
      if (!str.trim()) return null;
      const t = Array.isArray(item?.transform) ? item.transform : [];
      return { str, x: num(t[4], 0), y: num(t[5], 0),
        width: Math.max(0, num(item?.width, 0)),
        height: Math.max(1, num(item?.height, Math.abs(num(t[3], 10)) || 10)) };
    }).filter(Boolean);
    if (!items.length) return "";
    const hs = items.map(i => i.height).filter(h => h > 0).sort((a, b) => a - b);
    const mh = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
    const yTol = Math.max(2.5, Math.min(8, mh * 0.45));
    const lines = [];
    for (const item of items.sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
      let line = lines.find(l => Math.abs(l.y - item.y) <= yTol);
      if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
      line.items.push(item);
    }
    lines.sort((a, b) => b.y - a.y);
    const out = [];
    for (const line of lines) {
      const parts = line.items.sort((a, b) => a.x - b.x);
      let text = "", prevRight = null, prevHeight = mh;
      for (const part of parts) {
        const gap = prevRight === null ? 0 : part.x - prevRight;
        const threshold = Math.max(2.5, Math.min(14, prevHeight * 0.35));
        if (text && gap > threshold && !/\\s$/.test(text) && !/^\\s/.test(part.str)) text += " ";
        text += part.str;
        prevRight = part.x + Math.max(part.width, 0);
        prevHeight = part.height || prevHeight;
      }
      const normalized = text.replace(/[ \\t]+/g, " ").trimEnd();
      if (normalized.trim()) out.push(normalized);
    }
    return out.join("\\n").trim();
  };
  const doc = await pdfjs.getDocument("/doc.pdf").promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent({ includeMarkedContent: false });
    pages.push(reconstruct(c));
  }
  await post({ pages });
} catch (e) { await post({ error: String(e && e.stack || e) }); }
<\/script>`;
writeFileSync(join(tmp, "index.html"), PAGE);

const types = { ".mjs": "text/javascript", ".html": "text/html", ".pdf": "application/pdf", ".json": "application/json" };
let resolveResult;
const done = new Promise(r => { resolveResult = r; });
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => { res.writeHead(200).end("ok"); resolveResult(JSON.parse(body)); });
    return;
  }
  const url = req.url.split("?")[0];
  const file = url.startsWith("/app/") ? join(appDir, url.slice(5))
    : url === "/doc.pdf" ? join(tmp, "doc.pdf") : join(tmp, "index.html");
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const child = spawn(exe, ["--headless=new", "--disable-gpu", `--user-data-dir=${join(tmp, "profile")}`,
  `http://127.0.0.1:${port}/`], { stdio: "ignore" });
const data = await Promise.race([
  done,
  new Promise(r => setTimeout(() => r({ error: "ブラウザからの応答が180秒以内に返りませんでした" }), 180000)),
]);
// 自分で起動した1本だけを落とす。IMAGENAME 指定は利用者のブラウザまで巻き込む。
try { execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { child.kill(); }
server.close();
if (data.error) { console.error("抽出に失敗: " + data.error); process.exit(1); }

// --- 製品と同じ経路でマスクし、伏せ損ねを拾う ---------------------------
// 整合性レビューは文書全体を1セクションにするので、ここも全ページを1つの
// サイドカーに畳んで通す（パケットの切り方でマスクの成否が変わらないことの確認でもある）。
const role = lang === "ja" ? "REF1_CANDIDATE" : "TARGET_CHECK";
const sidecar = data.pages.map((t, i) =>
  `===== PDF P.${i + 1} / ${role} / x =====\n${t}\n`).join("");
const masked = maskSidecarByRole(sidecar, new Masker(1));
const v = verify(masked);

// 記号の位置 → その時点のページ番号（見出しを数えて割り当てる）
const pageAt = (() => {
  const marks = [];
  for (const m of masked.matchAll(/^===== PDF P\.(\d+) \//gm)) marks.push({ at: m.index, page: Number(m[1]) });
  return (i) => { let p = 0; for (const m of marks) { if (m.at > i) break; p = m.page; } return p; };
})();

// --dump-page N … そのページの**マスク前**の抽出テキストを出す。
// 伏せ損ねの現物を仕様に書くとき、マスク後だけ見ていると元の姿が分からない。
if (argv.includes("--dump-page")) {
  const n = Number(argv[argv.indexOf("--dump-page") + 1]);
  console.log(`--- p${n} の抽出テキスト（マスク前）---`);
  console.log((data.pages[n - 1] || "(無し)").split("\n").map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join("\n"));
  process.exit(0);
}

// --gold <json> … 埋めた誤りの引用が、抽出テキストに実在し一意かを確かめる。
//
// ⚠️ 合成フィクスチャ用の関門（Test-FixtureTextLayer.mjs）は実物には使えない
//    （HTMLの素材が無い）。実物に誤りを埋めたら、**送る前にここで確かめる**こと。
//    引用が抽出テキストに無ければ、モデルが見つけられなくて当然になる。
//    一意でなければ、どのページの指摘なのか採点できない。
if (argv.includes("--gold")) {
  const goldPath = resolve(argv[argv.indexOf("--gold") + 1]);
  const gold = JSON.parse(readFileSync(goldPath, "utf8"));
  const planted = gold.packets[0].planted;
  const norm = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
  const all = norm(data.pages.join("\n"));
  const countOf = (q) => { let n = 0, i = 0; for (;;) { const k = all.indexOf(q, i); if (k < 0) break; n++; i = k + 1; } return n; };
  let bad = 0;
  // ⚠️ 一意性を課すのは**主たる箇所（quote）だけ**。
  //    アンカー（alt）は実物では繰り返し出るのが当然で、むしろ繰り返すからアンカーになる
  //    （`ViiV Healthcare Ltd.` は12回出る）。合成フィクスチャは日英を作り分けているので
  //    アンカーも一意にできたが、実物にその条件を持ち込むと埋められる誤りが激減する。
  //    アンカーは「そのページに在る」ことだけ確かめる。
  for (const g of planted) {
    const checks = [["", g.page, g.quote, true], ...(g.alt || []).map(a => ["(alt)", a.page, a.quote, false])];
    for (const [what, page, quote, unique] of checks) {
      if (!quote) continue;
      const onPage = norm(data.pages[page - 1] || "").includes(norm(quote));
      if (!onPage) { bad++; console.error(`  FAIL ${g.id}${what}: p${page} の抽出テキストに引用が無い → ${quote}`); continue; }
      if (!unique) { console.log(`  ok   ${g.id}${what}: p${page} に実在（アンカーなので一意性は問わない）`); continue; }
      const times = countOf(norm(quote));
      if (times !== 1) { bad++; console.error(`  FAIL ${g.id}${what}: 引用が文書全体で ${times} 回出る（一意でないと採点できない） → ${quote}`); }
      else console.log(`  ok   ${g.id}${what}: p${page} に一意で実在`);
    }
  }
  console.log(bad ? `\ngold の照合: FAIL (${bad})` : `\ngold の照合: PASS（${planted.length}件）`);
  if (bad) process.exit(1);
}

console.log(`文書: ${basename(pdfPath)} / ${data.pages.length}ページ / lang=${lang}`);
console.log(`マスク後の判定: ${v.ok ? "OK（送信できる）" : `NG（送信は中止される）— 伏せ損ね ${v.leaks.length}件`}`);

// --- 単位（スケール語）がどこに置かれているか -----------------------------
// 行単位の継承（js/number-mask.mjs の LINE_UNIT_PATTERNS）が届くのは「同じ行」だけ。
// 実物で単位がキャプション行にしか無いなら、その表の裸のセルは実量がずれる。
// 規則を足す前に、まず**実際にどちらが多いのか**を数える。
if (argv.includes("--units")) {
  const SCALE = /[(（]\s*(?:in\s+)?(?:trillions?|billions?|millions?|thousands?)\s+of\s+(?:yen|shares|U\.S\. dollars)\s*[)）]|[(（]\s*(?:兆円|億円|百\s*万円|千(?:円|株))\s*[)）]/i;
  const NUMBERISH = /\d[\d,]{2,}/;
  let sameLine = 0, captionOnly = 0;
  const samples = [];
  for (let p = 0; p < data.pages.length; p++) {
    const lines = data.pages[p].split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!SCALE.test(lines[i])) continue;
      const withNum = NUMBERISH.test(lines[i]);
      // 直後3行に数字が並ぶなら「キャプションだけに単位がある表」
      const following = lines.slice(i + 1, i + 4).filter(l => NUMBERISH.test(l)).length;
      if (withNum) sameLine++;
      else if (following) { captionOnly++; if (samples.length < 8) samples.push(`p${p + 1}: ${lines[i].trim().slice(0, 70)} → 次行: ${(lines[i + 1] || "").trim().slice(0, 60)}`); }
    }
  }
  console.log(`\n単位（スケール語）の置き方:`);
  console.log(`  同じ行に数字もある（行継承が効く）      : ${sameLine}`);
  console.log(`  単位だけの行で、数字は次行以降（届かない）: ${captionOnly}`);
  for (const s of samples) console.log(`    ${s}`);
}

// --- 同じ金額に別の記号が付いていないか（「幻の不一致」の元） -----------------
//
// ⚠️ 実測（2026-08-06）: 実物で「P.35 の営業CFが P.4 と不一致」という指摘が5件出た。
//    原本を見ると **両方とも 195,460 で一致していた**。つまり誤検知である。
//    整合性レビューは記号どうしを突き合わせるので、同じ実量に別の記号が振られると
//    モデルには「別の値」に見える。§2.3 で6件の幻の不一致を作ったのと同じ型。
//    合成フィクスチャには Test-FixtureTextLayer.mjs の同名の検査があるが、
//    実物には gold が無いので通せない。ここで同じことを見る。
{
  const bySym = new Map();     // 数字の並び → 付いた記号の集合
  const masker2 = new Masker(1);
  const masked2 = maskSidecarByRole(sidecar, masker2);
  void masked2;
  for (const o of masker2.occurrences || []) {
    const d = String(o.raw).replace(/[^\d.,]/g, "");
    if (d.replace(/\D/g, "").length < 4) continue;      // 3桁以下は同表記でも別物が多い
    if (!bySym.has(d)) bySym.set(d, new Set());
    bySym.get(d).add(o.symbol);
  }
  // 記号 → 実量。桁がいくつ違うかを出すと、割れが妥当かどうかを人が判断できる。
  //   桁差 0        … 同じ実量なのに記号が違う（ありえない。あれば実装の不具合）
  //   桁差 3 / 6    … 片方だけ単位（千・百万）が付いた疑い。**幻の不一致の元**
  //   それ以外      … もともと別の量（％と金額など）。正しい割れ
  const microOf = new Map();
  for (const [micro, sym] of masker2.byKey) microOf.set(sym, BigInt(micro));
  const digitsOf = (n) => (n === 0n ? 1 : String(n < 0n ? -n : n).length);
  const split = [...bySym.entries()].filter(([, s]) => s.size > 1)
    .map(([d, s]) => {
      const syms = [...s];
      const ds = syms.map(x => digitsOf(microOf.get(x) ?? 0n));
      return { d, syms, gap: Math.max(...ds) - Math.min(...ds) };
    });
  const scaleLike = split.filter(x => x.gap === 3 || x.gap === 6 || x.gap === 9);
  console.log(`\n同じ数字表記に複数の記号が付いた組: ${split.length}件`
    + `（うち桁差が 3/6/9 の「片側だけ単位が付いた疑い」: **${scaleLike.length}件**）`);
  const showAll = argv.includes("--all");
  const list = showAll ? split : scaleLike;
  const limit = showAll ? list.length : 12;
  for (const x of list.slice(0, limit)) console.log(`  ${x.d} → ${x.syms.join(" ")}（桁差 ${x.gap}）`);
  if (list.length > limit) console.log(`  …ほか ${list.length - limit}件`);

  // --context で、割れた両側が**どう書かれているか**を出す。
  // 単位の書き方には文書ごとに流儀があり、現物を見ないと規則を書けない。
  if (argv.includes("--context")) {
    const at = (sym) => { const i = masked2.indexOf(sym); return i < 0 ? null : i; };
    const pageAt2 = (() => {
      const marks = [];
      for (const m of masked2.matchAll(/^===== PDF P\.(\d+) \//gm)) marks.push({ at: m.index, page: Number(m[1]) });
      return (i) => { let p = 0; for (const m of marks) { if (m.at > i) break; p = m.page; } return p; };
    })();
    const lineAt = (i) => {
      const s = masked2.lastIndexOf("\n", i) + 1;
      const e = masked2.indexOf("\n", i);
      return masked2.slice(s, e < 0 ? masked2.length : e).trim().slice(0, 110);
    };
    const n = Number(argv[argv.indexOf("--context") + 1]) || 10;
    console.log(`\n割れた両側の書かれ方（最大${n}件）:`);
    for (const x of scaleLike.slice(0, n)) {
      console.log(`  ── ${x.d}`);
      for (const sym of x.syms) {
        const i = at(sym);
        if (i === null) { console.log(`     ${sym}: 見つからず`); continue; }
        console.log(`     p${pageAt2(i)} ${sym} 桁${digitsOf(microOf.get(sym) ?? 0n)}: ${lineAt(i)}`);
      }
    }
  }
}

if (v.ok) process.exit(0);

const byWhy = new Map();
for (const l of v.leaks) byWhy.set(l.why, (byWhy.get(l.why) || 0) + 1);
console.log("\n型ごとの件数:");
for (const [why, n] of [...byWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${why.padEnd(16)} ${n}`);

// 残った現物を「そのページのどこか」まで含めて出す。仕様に規則を足すときの根拠になる。
const ctx = (i, w = 60) => masked.slice(Math.max(0, i - w), i + w).replace(/\n/g, "⏎");
console.log(`\n実例（最大${show}件）:`);
const seen = new Set();
let n = 0;
for (const l of v.leaks) {
  if (n >= show) break;
  const c = ctx(l.index);
  const key = c.replace(/\d/g, "0");           // 同型の繰り返しは1つにまとめる
  if (seen.has(key)) continue;
  seen.add(key);
  n++;
  console.log(`  [${l.why}] p${pageAt(l.index)} @${l.index}`);
  console.log(`    …${c}…`);
}
console.log(`\n（同型をまとめて ${n}種類。全 ${v.leaks.length}件）`);
process.exit(1);
