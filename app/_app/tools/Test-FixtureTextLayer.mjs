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

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runHeadlessPdfJsPage } from "./pdfjs-headless-runner.mjs";
import { Masker, maskSidecarByRole, verify } from "../js/number-mask.mjs";
import { NUMBER_PAIRS, LOCAL_ERRORS }
  from "../docs/benchmarks/fixtures/long-fixture-content.mjs";
import { reconstructTextContentDetailed, marginaliaSignatureKeys, collectRepeatedMarginaliaSignatures, applyRepeatedMarginaliaSignatures, classifyRepeatedMarginalia, serializeLayoutBlocksForPrompt } from "../js/pdf-text-reconstruct.mjs";

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

// pdf.js はブラウザ用ビルドなので Node からは読めない（DOMMatrix が無い）。
// 製品と同じ pdfjs で読むために、ローカルに配ってヘッドレスブラウザで実行する。
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const post = t => fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) });
const progress = t => fetch("/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) });
try {
  const startedAt = performance.now();
  const pdfjs = await import("/app/pdfjs/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/app/pdfjs/build/pdf.worker.min.mjs";
  const reconstructDetailed = ${reconstructTextContentDetailed.toString()};
  const marginaliaSignatureKeys = ${marginaliaSignatureKeys.toString()};
  const collectRepeatedMarginaliaSignatures = ${collectRepeatedMarginaliaSignatures.toString()};
  const applyRepeatedMarginaliaSignatures = ${applyRepeatedMarginaliaSignatures.toString()};
  const classifyMarginalia = ${classifyRepeatedMarginalia.toString()};
  const serializePromptLayout = ${serializeLayoutBlocksForPrompt.toString()};
  const base = "/app/docs/benchmarks/fixtures/";
  const gold = await (await fetch(base + "gold-long.json")).json();
  const out = { files: [], missing: [], notUnique: [], pages: {}, timings: [] };
  for (const f of ${JSON.stringify(FIXTURES.map(x => x.pdf))}) {
    const fileStartedAt = performance.now();
    const doc = await pdfjs.getDocument(base + f).promise;
    const layouts = new Array(doc.numPages);
    // 401ページを1ページずつ待つ必要はない。pdf.js workerへ小さなバッチで渡し、
    // メモリを抑えながらページ取得の待ち時間を重ねる。
    const batchSize = 8;
    for (let first = 1; first <= doc.numPages; first += batchSize) {
      const pageNumbers = Array.from({ length: Math.min(batchSize, doc.numPages - first + 1) }, (_, i) => first + i);
      const extracted = await Promise.all(pageNumbers.map(async p => {
        const page = await doc.getPage(p);
        const c = await page.getTextContent();
        const viewport = page.getViewport({ scale:1 });
        const layout = reconstructDetailed(c, { page:{ width:viewport.width, height:viewport.height, rotation:viewport.rotation || 0 } });
        page.cleanup();
        return [p, layout];
      }));
      for (const [p, layout] of extracted) layouts[p - 1] = layout;
      await progress({ phase: "extract", file: f, done: Math.min(first + batchSize - 1, doc.numPages), total: doc.numPages });
    }
    classifyMarginalia(layouts);
    const pages=layouts.map(layout=>serializePromptLayout(layout));
    out.timings.push({ file: f, pages: doc.numPages, ms: Math.round(performance.now() - fileStartedAt) });
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
  out.elapsedMs = Math.round(performance.now() - startedAt);
  await post(out);
} catch (e) { await post({ error: String(e && e.stack || e) }); }
<\/script>`;

const timeoutMs = Math.max(30000, Number(process.env.KOSEI_FIXTURE_TIMEOUT_MS) || 300000);
const idleTimeoutMs = Math.max(30000, Number(process.env.KOSEI_FIXTURE_IDLE_TIMEOUT_MS) || 90000);
let data;
try {
  data = await runHeadlessPdfJsPage({ appDir, html:PAGE, tempPrefix:"kosei-textlayer-", batchLabel:"401ページfixture抽出", idleTimeoutMs, totalTimeoutMs:timeoutMs });
} catch (error) {
  console.error("  FAIL 抽出そのものに失敗: " + error.message);
  process.exit(1);
}

let failures = 0;
const t = (name, cond, detail) => {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); if (detail) console.error(`       ${detail}`); }
  else console.log(`  ok   ${name}`);
};

console.log(`  info PDF.js抽出: ${data.files.reduce((n, f) => n + f.pages, 0)}ページ / ${(data.elapsedMs / 1000).toFixed(1)}秒`
  + `（${data.timings.map(x => `${x.file} ${(x.ms / 1000).toFixed(1)}秒`).join("、")}）`);
t("PDF.js抽出が10秒以内", data.elapsedMs <= 10000, `${data.elapsedMs}ms > 10000ms`);

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
    // 図/順序不確定blockや無型の散文数値は、プロンプト側でも列対応・数値対応の
    // 根拠にしない。比較対象は明示familyを持つ値とreview可能なTABLEセルに限る。
    if (o.layoutRole && o.layoutRole !== "TABLE" && !o.family) continue;
    const d = o.raw.replace(/[^\d.,]/g, "");
    if (d.replace(/\D/g, "").length < 4) continue;      // 3桁以下は同表記でも別物が多い
    (byDigits.get(d) || byDigits.set(d, new Set()).get(d)).add(o.symbol);
  }
  const split = [...byDigits.entries()].filter(([d, s]) => s.size > 1 && !SPLIT_OK.has(d)).map(([d]) => d);
  const splitDetails = split.slice(0, 8).map(d => {
    const rows = masker.occurrences.filter(o => o.raw.replace(/[^\d.,]/g, "") === d);
    return `${d}: ${rows.map(o => `${o.symbol}/${o.micro}/${o.family || "-"}/${o.source || "-"}/${o.layoutRole || "-"}`).join(" | ")}`;
  });
  t("同じ金額に同じ記号が付く（表と本文で割れていない）", split.length === 0,
    splitDetails.join("; ") + "（別の量なら SPLIT_OK に理由を書いて許す）");

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
