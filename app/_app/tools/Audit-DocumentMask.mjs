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
  const doc = await pdfjs.getDocument("/doc.pdf").promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    pages.push(c.items.map(i => i.str + (i.hasEOL ? "\\n" : "")).join(""));
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
