// Test-AttachmentVisibility.mjs — 添付チップの検出がウィンドウ状態に左右されないかを検証する。
//
//   node tools/Test-AttachmentVisibility.mjs
//
// 実測（2026-08-04 16:07）: Edge には添付されているのにアプリは
//   添付待機中 elapsedSec=50 count=0 names= lives= usedItemSelector=''
// のまま60秒待って失敗した。同じコードが15:25と16:45には通っている。
// 差は Edge ウィンドウが最小化されていたかどうか。最小化中は
// getBoundingClientRect が 0 を返し、実在するチップが全部「不可視」として捨てられる。
//
// 対策は2つ入れた。既定を foreground にしたことと、サイズを問わない判定への
// フォールバック。ただし display:none のものまで拾っては意味がないので、
// その線引きを実ブラウザで確認する。CopilotClient.ps1 の埋め込みJSを直接取り出して走らせる。
//
// playwright が無い環境では SKIP する。

// 最小化相当（全要素サイズ0）でも添付チップを拾えるかを実ブラウザで確認する
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const m = await import(join(root, "playwright", "index.js"));
    return m.chromium || m.default?.chromium || null;
  } catch { return null; }
}
const chromium = await loadChromium();
if (!chromium) { console.log("SKIP: playwright が見つかりません"); process.exit(0); }

const src = readFileSync(join(here, "..", "src", "CopilotClient.ps1"), "utf8");
const i = src.indexOf("const itemSels = __ITEM_SELS__");
const j = src.indexOf("})()", i);
const js = src.slice(src.lastIndexOf("(() => {", i), j + 4)
  .replace("__ITEM_SELS__", '[".fai-BebopAttachment"]')
  .replace("__NAME_SELS__", '[".name"]')
  .replace("__LIST_SELS__", '[".list"]');

const b = await chromium.launch();
const p = await b.newPage();
await p.setContent(`<div class="list">
  <div class="fai-BebopAttachment"><span class="name">a.pdf</span></div>
  <div class="fai-BebopAttachment"><span class="name">b.txt</span></div>
</div>`);
const normal = JSON.parse(await p.evaluate(js));
// 最小化時に相当する状態: 全要素の実寸が 0
await p.addStyleTag({ content: ".list,.fai-BebopAttachment,.name{width:0!important;height:0!important;overflow:hidden}" });
const zero = JSON.parse(await p.evaluate(js));
// 本当に隠されている場合は拾ってはいけない
await p.addStyleTag({ content: ".list{display:none!important}" });
const hidden = JSON.parse(await p.evaluate(js));
await b.close();

let bad = 0;
const t = (n, c, d) => { if (c) console.log("  ok   " + n); else { bad++; console.error("  FAIL " + n + "  " + JSON.stringify(d)); } };
t("通常表示で2件拾う（厳密判定）", normal.count === 2 && normal.laxUsed === false, normal);
t("サイズ0でも2件拾う（最小化対策）", zero.count === 2 && zero.laxUsed === true, zero);
t("display:none は拾わない", hidden.count === 0, hidden);
if (bad) { console.error(`\nTest-AttachmentVisibility: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-AttachmentVisibility: PASS");
