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
// 確認するのは4つ:
//   1. 康熙部首ブロック（U+2E80〜U+2FDF）の文字が1つも混ざっていないこと
//   2. gold の全 planted の引用（と跨ぎの alt）が、その頁の抽出テキストに実在し、
//      かつ文書全体で一意であること（ページ単位の採点が成立する条件）
//   3. 抽出テキストを製品のマスカーに通したとき、平文の数字が1つも残らないこと
//      （残ると `verify()` が設計どおり**送信を中止**する。実測で PACKET_008 がこれで落ち、
//        20分走らせた末に1本も測れなかった）
//   4. 同じ実量に日英で同じ記号が振られていること
//      （ここが崩れると、正しい訳が「記号が違う＝別の値」として誤検知される。
//        逆に数値の誤訳(num-tr)では記号がずれていないと、埋めた誤りが見えなくなる）
//
// 3と4は実機で走らせる前の関門である。単位語が新しくなる（トン・立方メートル・
// メガワット時…）たびに、マスカーが読めるかどうかは実際に通してみないと分からない。
//
// 実行にはブラウザ（Edge/Chrome）が要る。無ければ SKIP する。

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { Masker, maskSidecarByRole, verify } from "../js/number-mask.mjs";
import { NUMBER_PAIRS, LOCAL_ERRORS }
  from "../docs/benchmarks/fixtures/long-fixture-content.mjs";

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
  const out = { files: [], missing: [], notUnique: [], pages: {} };
  for (const f of ${JSON.stringify(FIXTURES.map(x => x.pdf))}) {
    const doc = await pdfjs.getDocument(base + f).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const c = await (await doc.getPage(p)).getTextContent();
      pages.push(c.items.map(i => i.str + (i.hasEOL ? "\\n" : "")).join(""));
    }
    out.pages[f] = pages;                       // マスカーの検査は Node 側で製品の実装を呼ぶ
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
// 自分で起動した1本だけを落とす。IMAGENAME 指定は利用者のブラウザまで巻き込む。
try { execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); }
catch { child.kill(); }
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

// --- 製品のマスカーを通す（実機で走らせる前の関門） --------------------
{
  const en = data.pages[FIXTURES[0].pdf], ja = data.pages[FIXTURES[1].pdf];
  const jaOf = p => (p >= 2 ? p + 1 : p);        // 【表紙】の分だけ日本語が1ページ後ろ
  const sidecar = rows => rows.map(r =>
    `===== PDF P.${r.page} / ${r.role} / x =====\n${r.text}\n`).join("");

  // (3) 平文の数字が残らないか。パケットの粒度（10ページ）で本番と同じ経路に通す。
  let leaks = 0, worst = "";
  for (let start = 1; start <= en.length; start += 10) {
    const rows = [];
    for (let p = start; p < start + 10 && p <= en.length; p++) {
      rows.push({ page: p, role: "TARGET_CHECK", text: en[p - 1] });
      rows.push({ page: jaOf(p), role: "REF1_CANDIDATE", text: ja[jaOf(p) - 1] || "" });
    }
    const v = verify(maskSidecarByRole(sidecar(rows), new Masker(1)));
    if (!v.ok) { leaks += v.leaks.length; worst ||= `P${start}〜: ${[...new Set(v.leaks.map(l => l.why))].join(",")}`; }
  }
  t("マスク後に平文の数字が残らない（残ると verify() が送信を中止する）", leaks === 0,
    leaks ? `${leaks}件 / ${worst}` : "");

  // (4) 同じ実量に日英で同じ記号が振られているか。文書全体を1つの Masker に通して見る。
  const rows = [];
  for (let p = 1; p <= en.length; p++) rows.push({ page: p, role: "TARGET_CHECK", text: en[p - 1] });
  for (let p = 1; p <= ja.length; p++) rows.push({ page: p, role: "REF1_CANDIDATE", text: ja[p - 1] });
  const masker = new Masker(1);
  const masked = maskSidecarByRole(sidecar(rows), masker);
  const blocks = { en: new Map(), ja: new Map() };
  const parts = masked.split(/^===== PDF P\.(\d+) \/ (\S+) \/ x =====$/gm).slice(1);
  for (let i = 0; i + 2 < parts.length + 1; i += 3) {
    blocks[/^REF/.test(parts[i + 1]) ? "ja" : "en"].set(Number(parts[i]), parts[i + 2] || "");
  }
  const syms = txt => new Set(String(txt).match(/⟦#[A-Z]{3}⟧/g) || []);
  const shares = (a, b) => [...syms(a)].some(x => syms(b).has(x));

  const noPair = [];
  for (const n of NUMBER_PAIRS) {
    if (!shares(blocks.en.get(n.anchorEnPage), blocks.ja.get(jaOf(n.anchorEnPage)))) noPair.push(n.id + "(先行)");
    if ((n.side || "both") === "both" &&
        !shares(blocks.en.get(n.errorEnPage), blocks.ja.get(jaOf(n.errorEnPage)))) noPair.push(n.id + "(後続)");
  }

  t("跨ぎペアのページで日英に同じ記号が立つ（記号のずれ＝誤り、が成立する条件）",
    noPair.length === 0, noPair.slice(0, 8).join(", "));

  // 同じ数字表記に複数の記号が付いていないか（跨ぎ比較で「幻の不一致」になる元）。
  // ⚠️ 実測: 表のセル（単位は行の見出し）と本文（単位語つき）で 458,921 に別の記号が付き、
  //    「P.6 と P.22 の売上高が一致しない」という指摘が6件出た。
  //    表記が同じでも**実際に別の量**であれば別記号が正しいので、理由を書いて明示的に許す。
  const SPLIT_OK = new Map([
    ["18,900", "営業利益 18,900百万円 と 大株主 18,900千株"],
    ["4,100", "設備投資 4,100百万円 と 持株会 4,100千株"],
    ["5,200", "機械装置 5,200百万円 と 中期計画 5,200億円"],
    ["7,200", "大株主 7,200千株 と 明細表 7,200百万円"],
    ["1,450", "支払利息 1,450百万円 と 試験実施 1,450件"],
  ]);
  const byDigits = new Map();
  for (const o of masker.occurrences) {
    const d = o.raw.replace(/[^\d.,]/g, "");
    if (d.replace(/\D/g, "").length < 4) continue;      // 3桁以下は同表記でも別物が多い
    (byDigits.get(d) || byDigits.set(d, new Set()).get(d)).add(o.symbol);
  }
  const split = [...byDigits.entries()].filter(([d, s]) => s.size > 1 && !SPLIT_OK.has(d)).map(([d]) => d);
  t("同じ金額に同じ記号が付く（表と本文で割れていない）", split.length === 0,
    split.slice(0, 8).join(", ") + "（別の量なら SPLIT_OK に理由を書いて許す）");

  // 数値の誤訳は逆に、記号がずれていないと埋めた誤りが消える
  const invisible = [];
  for (const x of LOCAL_ERRORS.filter(v => v.kind === "num-tr")) {
    const e = syms(blocks.en.get(x.enPage)), j = syms(blocks.ja.get(jaOf(x.enPage)));
    if (![...e].some(s => !j.has(s)) || ![...j].some(s => !e.has(s))) invisible.push(x.id);
  }
  t("数値の誤訳では日英の記号がずれる（ずれないと誤りが見えない）", invisible.length === 0,
    invisible.join(", "));
}

if (failures) { console.error(`\nTest-FixtureTextLayer: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-FixtureTextLayer: PASS");
