// Test-FixtureTextLayer.mjs — フィクスチャPDFの**抽出テキスト**が gold と合っているかを見る。
//
//   node tools/Test-FixtureTextLayer.mjs
//
// Test-LongFixture.mjs は HTML と gold-long.json を突き合わせる。しかし製品が読むのは
// **PDFのテキストレイヤー**であって HTML ではない。ここが食い違うと、
// 「モデルが見落とした」のか「そもそも本文がそう読めていない」のかが区別できなくなる。
//
// 実例（2026-08-05）: playwright が無い環境で Edge に刷らせたところ、日本語が
// Yu Gothic に落ち、Chromium が「月・高・人・水・用・立・方・子・目・十」を
// **康熙部首（⽉ ⾼ ⼈ …）の符号位置**で ToUnicode に書いた。見た目は同じで、
// ページ数の検査も通る。抽出テキストだけが別物になる。
// 引用照合も、数値マスクの単位語判定（百万・千）も、これで静かに狂う。
//
// 確認するのは2つ:
//   1. 康熙部首ブロック（U+2E80〜U+2FDF）の文字が1つも混ざっていないこと
//   2. gold の全 planted の引用（と跨ぎの alt）が、その頁の抽出テキストに実在し、
//      かつ文書全体で一意であること（ページ単位の採点が成立する条件）
//
// 実行にはブラウザ（Edge/Chrome）が要る。無ければ SKIP する。

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const FIXTURES = [
  { pdf: "aoi-long_en_TARGET.pdf", gold: "gold-long.json", ja: false },
  { pdf: "aoi-long_ja_REF.pdf", gold: null, ja: true },
];

for (const f of [...FIXTURES.map(x => x.pdf), "gold-long.json"]) {
  if (!existsSync(join(appDir, "docs", "benchmarks", "fixtures", f))) {
    console.log(`SKIP: ${f} がありません（node docs/benchmarks/fixtures/build-long-fixture.mjs で生成）`);
    process.exit(0);
  }
}

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

// pdf.js はブラウザ用ビルドなので Node からは読めない（DOMMatrix が無い）。
// 製品と同じ pdfjs で読むために、ローカルに配ってヘッドレスブラウザで実行する。
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const post = t => fetch("/result", { method: "POST", body: JSON.stringify(t) });
try {
  const pdfjs = await import("/app/pdfjs/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/app/pdfjs/build/pdf.worker.min.mjs";
  const base = "/app/docs/benchmarks/fixtures/";
  const gold = await (await fetch(base + "gold-long.json")).json();
  const out = { files: [], missing: [], notUnique: [] };
  for (const f of ${JSON.stringify(FIXTURES.map(x => x.pdf))}) {
    const doc = await pdfjs.getDocument(base + f).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const c = await (await doc.getPage(p)).getTextContent();
      pages.push(c.items.map(i => i.str + (i.hasEOL ? " " : "")).join(""));
    }
    const text = pages.join("\\n");
    const radicals = [...new Set([...text].filter(ch => ch >= "\\u2E80" && ch <= "\\u2FDF"))].join("");
    out.files.push({ file: f, pages: doc.numPages, radicals });
    if (f !== ${JSON.stringify(FIXTURES[0].pdf)}) continue;
    const norm = s => s.normalize("NFKC").toLowerCase().replace(/[\\s\\u3000,]/g, "");
    const all = norm(text);
    const countOf = q => { let n = 0, i = 0; for (;;) { const k = all.indexOf(q, i); if (k < 0) break; n++; i = k + 1; } return n; };
    for (const g of gold.packets[0].planted) {
      if (!norm(pages[g.page - 1] || "").includes(norm(g.quote))) out.missing.push(g.id + "@p" + g.page);
      if (countOf(norm(g.quote)) !== 1) out.notUnique.push(g.id + "×" + countOf(norm(g.quote)));
      for (const a of g.alt || []) {
        if (!norm(pages[a.page - 1] || "").includes(norm(a.quote))) out.missing.push(g.id + "(alt)@p" + a.page);
      }
    }
    out.planted = gold.packets[0].planted.length;
    out.expectPages = gold.target_pages;
    out.expectRefPages = gold.ref_pages;
  }
  await post(out);
} catch (e) { await post({ error: String(e && e.stack || e) }); }
<\/script>`;

const tmp = mkdtempSync(join(tmpdir(), "kosei-textlayer-"));
writeFileSync(join(tmp, "index.html"), PAGE);

const types = { ".mjs": "text/javascript", ".html": "text/html", ".pdf": "application/pdf", ".json": "application/json" };
let resolveResult;
const result = new Promise(r => { resolveResult = r; });
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => { res.writeHead(200).end("ok"); resolveResult(JSON.parse(body)); });
    return;
  }
  const url = req.url.split("?")[0];
  const file = url.startsWith("/app/") ? join(appDir, url.slice(5)) : join(tmp, "index.html");
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = join(tmp, "profile");
const child = spawn(exe, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/`], { stdio: "ignore" });

const data = await Promise.race([
  result,
  new Promise(r => setTimeout(() => r({ error: "ブラウザからの応答が120秒以内に返りませんでした" }), 120000)),
]);
child.kill();
server.close();

let failures = 0;
const t = (name, cond, detail) => {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); if (detail) console.error(`       ${detail}`); }
  else console.log(`  ok   ${name}`);
};

if (data.error) { console.error("  FAIL 抽出そのものに失敗: " + data.error); process.exit(1); }

for (const f of data.files) {
  // 見た目は同じで、ページ数の検査も通る。抽出テキストだけが別物になる種類の壊れ方。
  t(`${f.file}: 康熙部首の混入が無い`, f.radicals === "",
    f.radicals ? `混入: ${f.radicals}（日本語フォントが Yu Gothic / Meiryo / Noto Sans JP に落ちていないか）` : "");
}
t(`TARGET のページ数が gold と一致（${data.expectPages}）`,
  data.files[0].pages === data.expectPages, `PDF ${data.files[0].pages}p`);
t(`REF のページ数が gold と一致（${data.expectRefPages}）`,
  data.files[1].pages === data.expectRefPages, `PDF ${data.files[1].pages}p`);
t(`gold の引用 ${data.planted}件がすべて抽出テキストに実在する`, data.missing.length === 0,
  data.missing.slice(0, 8).join(", "));
t("引用が抽出テキストの中でも一意（ページ単位の採点が成立する）", data.notUnique.length === 0,
  data.notUnique.slice(0, 8).join(", "));

if (failures) { console.error(`\nTest-FixtureTextLayer: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-FixtureTextLayer: PASS");
