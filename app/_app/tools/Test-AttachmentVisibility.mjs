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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
async function loadChromium() {
  try { return (await import("playwright")).chromium; } catch {}
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const m = await import(pathToFileURL(join(root, "playwright", "index.js")).href);
    return m.chromium || m.default?.chromium || null;
  } catch { return null; }
}
const chromium = await loadChromium();
if (!chromium) { console.log("SKIP: playwright が見つかりません"); process.exit(0); }
async function launchChromium() {
  try { return await chromium.launch(); }
  catch (error) {
    const message = String(error && error.message ? error.message : error);
    const packagedExecutableMissing = process.platform === "win32"
      && /executable\b.*(?:doesn't exist|does not exist|not found)/i.test(message);
    if (!packagedExecutableMissing) throw error;
    return await chromium.launch({ channel: "msedge" });
  }
}

const src = readFileSync(join(here, "..", "src", "CopilotClient.ps1"), "utf8");
const i = src.indexOf("const itemSels = __ITEM_SELS__");
const j = src.indexOf("})()", i);
const jsTemplate = src.slice(src.lastIndexOf("(() => {", i), j + 4);
const makeJs = (expected, itemSelectors = [".fai-BebopAttachment"], listSelectors = [".list"]) => jsTemplate
  .replace("__ITEM_SELS__", JSON.stringify(itemSelectors))
  .replace("__NAME_SELS__", '[".name"]')
  .replace("__LIST_SELS__", JSON.stringify(listSelectors))
  .replace("__EXPECTED_NAMES__", JSON.stringify(expected));
const js = makeJs(["target.pdf", "reference.txt", "instructions.docx"]);

const b = await launchChromium();
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

// Copilot exposes chip labels through arbitrary data attributes, aria-label,
// title, and visible text; statuses and duplicate/near-match names are noise.
await p.setContent(`<style>
  .realistic-fixture .fai-BebopAttachment { display: block; min-width: 1px; min-height: 1px; }
</style><div class="list realistic-fixture">
  <div class="fai-BebopAttachment" data-filename="添付ファイル target.pdf アップロード完了" data-upload-status="アップロード完了"><span class="upload-status">アップロード中…</span></div>
  <div class="fai-BebopAttachment" aria-label="ファイル名: reference.txt — アップロード完了"><span>添付ファイル</span></div>
  <div class="fai-BebopAttachment" title="instructions.docx — アップロード完了"></div>
  <div class="fai-BebopAttachment" data-upload-label="アップロード中…"></div>
  <div class="fai-BebopAttachment" data-name="添付ファイル target.pdf — uploaded"></div>
  <div class="fai-BebopAttachment" data-filename="target.pdf.backup — アップロード完了"></div>
</div>`);
const fallbackNames = JSON.parse(await p.evaluate(js));

// Primary selector intentionally sees only target.pdf; fallback selectors must add
// the other two DOM chips without replacing or duplicating the primary node.
const unionJs = makeJs(
  ["target.pdf", "reference.txt", "instructions.docx"],
  [".primary-chip"]
);
await p.setContent(`<style>
  .realistic-fixture .fai-BebopAttachment { display: block; min-width: 1px; min-height: 1px; }
</style><div class="list realistic-fixture">
  <div class="fai-BebopAttachment primary-chip" data-filename="添付ファイル target.pdf アップロード完了"></div>
  <div class="fai-BebopAttachment" aria-label="ファイル名: reference.txt — アップロード完了"></div>
  <div class="fai-BebopAttachment" title="instructions.docx — アップロード完了"></div>
</div>`);
const unionNames = JSON.parse(await p.evaluate(unionJs));

// A filename token must be exact after known decoration is removed.  Prefixes
// such as 旧/old and prose on the candidate item must not create a match.
const decoratedJs = makeJs(["報告書.pdf", "report.pdf"]);
await p.setContent(`<style>
  .realistic-fixture .fai-BebopAttachment { display: block; min-width: 1px; min-height: 1px; }
</style><div class="list realistic-fixture">
  <div class="fai-BebopAttachment" data-filename="添付ファイル 報告書.pdf — アップロード完了"></div>
  <div class="fai-BebopAttachment" data-filename="旧報告書.pdf — アップロード完了"></div>
  <div class="fai-BebopAttachment" aria-label="filename: report.pdf — uploaded"></div>
  <div class="fai-BebopAttachment" title="old report.pdf — uploaded"></div>
  <div class="fai-BebopAttachment"><span class="ancestor-prose">前回の資料 報告書.pdf と old report.pdf を参照</span></div>
</div>`);
const decoratedNames = JSON.parse(await p.evaluate(decoratedJs));

// Generated names may contain spaces and parentheses; compare the complete
// decoration-stripped value rather than a whitespace-delimited token.
const spacedJs = makeJs(["Annual Report-packet.pdf", "Quarterly (Final) report.pdf"]);
await p.setContent(`<style>
  .realistic-fixture .fai-BebopAttachment { display: block; min-width: 1px; min-height: 1px; }
</style><div class="list realistic-fixture">
  <div class="fai-BebopAttachment" data-filename="添付ファイル Annual Report-packet.pdf アップロード完了"></div>
  <div class="fai-BebopAttachment" aria-label="ファイル名: Quarterly (Final) report.pdf — アップロード完了"></div>
</div>`);
const spacedNames = JSON.parse(await p.evaluate(spacedJs));

// M365現行DOM: 外側の opaque wrapper は class に Attachment を含むが、実体は
// data-overflow-item + aria-label を持つ子チップ。旧コードの広い class fallback
// は wrapper を1件としてしまうため、semantic selector で2件のDOM identityを保つ。
const currentDomJs = makeJs(
  ["target.pdf", "reference.txt"],
  [".fai-BebopAttachment", ".fai-Attachment", '[class*="Attachment"][data-overflow-item]'],
  ['[focusgroup^="toolbar"][aria-label="添付ファイル"]']
);
await p.setContent(`<style>
  .realistic-fixture .fai-BebopLiteChatInput__attachments { display: block; min-width: 1px; min-height: 1px; }
  .realistic-fixture [data-overflow-item="true"] { display: block; min-width: 1px; min-height: 1px; }
</style><div class="list realistic-fixture">
  <div class="fai-BebopLiteChatInput__attachments" focusgroup="toolbar inline wrap" aria-label="添付ファイル">
    <div class="opaque-chip-a" data-overflow-item="true" aria-label="target.pdf"><button aria-label="添付ファイル target.pdf を削除する"></button></div>
    <div class="opaque-chip-b" data-overflow-item="true" aria-label="reference.txt"><button aria-label="添付ファイル reference.txt を削除する"></button></div>
  </div>
</div>`);
const currentDomNames = JSON.parse(await p.evaluate(currentDomJs));

// #115: semantic list selectorがwrapperではなくチップ自身に一致するDOM。
// querySelectorAllはroot自身を返さないため、root込みで同じselectorを評価する必要がある。
const rootChipJs = makeJs(
  ["packet.pdf"],
  [".fai-BebopAttachment"],
  ['[focusgroup^="toolbar"][aria-label="添付ファイル"]']
);
await p.setContent(`<style>[data-overflow-item="true"] { display:block; min-width:1px; min-height:1px; }</style>
  <div focusgroup="toolbar inline" aria-label="attachment packet.pdf" data-overflow-item="true"></div>`);
const rootChipNames = JSON.parse(await p.evaluate(rootChipJs));
await b.close();

let bad = 0;
const t = (n, c, d) => { if (c) console.log("  ok   " + n); else { bad++; console.error("  FAIL " + n + "  " + JSON.stringify(d)); } };
t("通常表示で2件拾う（厳密判定）", normal.count === 2 && normal.laxUsed === false, normal);
t("サイズ0でも2件拾う（最小化対策）", zero.count === 2 && zero.laxUsed === true, zero);
t("display:none は拾わない", hidden.count === 0, hidden);
t("前置き/後置き付き属性から3期待名を正規化する",
  fallbackNames.items.some(x => x.names?.includes("target.pdf"))
  && fallbackNames.items.some(x => x.names?.includes("reference.txt"))
  && fallbackNames.items.some(x => x.names?.includes("instructions.docx")), fallbackNames);
t("進捗/近似名だけのチップはファイル名にならない",
  fallbackNames.items.filter(x => !x.names?.length).length >= 2
  && fallbackNames.items.every(x => !/アップロード中/.test(x.name)), fallbackNames);
// One DOM chip must satisfy at most one expected file.
function assignExpected(items, expected) {
  const used = new Set();
  const matched = [];
  for (const wanted of expected) {
    const index = items.findIndex((item, i) => !used.has(i) && (item.names || []).includes(wanted));
    if (index < 0) return { ok: false, matched };
    used.add(index); matched.push(wanted);
  }
  return { ok: matched.length === expected.length, matched };
}
const primaryFallbackExpected = assignExpected(unionNames.items, ["target.pdf", "reference.txt", "instructions.docx"]);
t("primary 1/3 + fallback 2/3 をDOM identityで一対一に統合する",
  primaryFallbackExpected.ok
  && unionNames.items.length === 3
  && /primary:\.primary-chip/.test(unionNames.usedItemSelector)
  && /fallback:/.test(unionNames.usedItemSelector), { unionNames, primaryFallbackExpected });

const decoratedJapanese = decoratedNames.items.filter(x => x.names?.includes("報告書.pdf")).length;
const decoratedEnglish = decoratedNames.items.filter(x => x.names?.includes("report.pdf")).length;
t("Unicode/英文の前置きと候補要素内の説明文は部分一致せず、装飾済み完全名だけを採る",
  decoratedNames.items.length === 5
  && decoratedJapanese === 1
  && decoratedEnglish === 1, { decoratedNames, decoratedJapanese, decoratedEnglish });

const spacedExpected = assignExpected(spacedNames.items, ["Annual Report-packet.pdf", "Quarterly (Final) report.pdf"]);
t("空白・括弧を含む生成ファイル名も完全名で完了判定する",
  spacedExpected.ok && spacedNames.items.length === 2, { spacedNames, spacedExpected });

t("現行M365のsemantic子チップをwrapperではなく2件として検出する",
  currentDomNames.count === 2
  && currentDomNames.items.some(x => x.names?.includes("target.pdf"))
  && currentDomNames.items.some(x => x.names?.includes("reference.txt"))
  && !currentDomNames.items.some(x => x.names?.length > 1)
  && /data-overflow-item/.test(currentDomNames.usedItemSelector), currentDomNames);
t("semantic list自身がチップでもcount=1として検出する",
  rootChipNames.count === 1 && rootChipNames.items[0]?.names?.includes("packet.pdf"), rootChipNames);

const threeExpected = assignExpected(fallbackNames.items, ["target.pdf","reference.txt","instructions.docx"]);
const missingOne = assignExpected(fallbackNames.items.filter(item => !item.names?.includes("reference.txt")), ["target.pdf","reference.txt","instructions.docx"]);
t("3期待名を一対一で完了判定する", threeExpected.ok, threeExpected);
t("1チップ欠落は完了にしない", !missingOne.ok, missingOne);
t("aggregate 1件のnames配列だけでは2期待名を完了扱いにしない",
  !assignExpected([{ names: ["target.pdf", "reference.txt"] }], ["target.pdf", "reference.txt"]).ok);
t("近似拡張子/重複チップは期待名を水増ししない",
  fallbackNames.items.filter(x => x.names?.includes("target.pdf")).length === 2
  && fallbackNames.items.filter(x => x.names?.includes("instructions.docx")).length === 1, fallbackNames);

// --- 共通の visible 判定 ------------------------------------------------
// 添付検出だけ直しても、利用者が実行中に手で最小化すれば入力欄・送信ボタンも
// 同じ理由で見つからなくなる（実装は同じ idiom を9箇所で使っている）。
// 判定そのものが最小化に耐えることを、実ブラウザで確かめる。
{
  const defs = src.split("\n").filter(l => l.includes("visible=e=>{"));
  const b2 = await launchChromium();
  try {
    for (let k = 0; k < defs.length; k++) {
      const i = defs[k].indexOf("visible=e=>{");
      const body = defs[k].slice(i).replace(/^visible=/, "");
      const end = body.indexOf("return true;};");
      const def = end >= 0 ? body.slice(0, end + "return true;}".length) : body;

      const pg = await b2.newPage();
      await pg.setContent(`<div id="ok">見える</div>
        <div id="none" style="display:none">見えない</div>
        <div id="hiddenvis" style="visibility:hidden">見えない</div>
        <div id="zero" style="width:0;height:0;overflow:hidden">実寸0</div>
        <div style="display:none"><div id="inNone">親が none</div></div>`);
      const r = await pg.evaluate(([d, hide]) => {
        if (hide) Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
        const visible = eval("(" + d + ")");
        const q = id => visible(document.getElementById(id));
        return { ok: q("ok"), none: q("none"), hiddenvis: q("hiddenvis"), zero: q("zero"), inNone: q("inNone") };
      }, [def, false]);
      const rh = await pg.evaluate(([d, hide]) => {
        if (hide) Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
        const visible = eval("(" + d + ")");
        const q = id => visible(document.getElementById(id));
        return { ok: q("ok"), none: q("none"), hiddenvis: q("hiddenvis"), zero: q("zero"), inNone: q("inNone") };
      }, [def, true]);
      await pg.close();

      const tag = `visible定義#${k + 1}`;
      t(`${tag}: 通常時は見えるものだけ true`, r.ok && !r.none && !r.hiddenvis, r);
      t(`${tag}: 通常時は実寸0を採らない（重複要素の取り違えを防ぐ）`, r.zero === false, r);
      t(`${tag}: 最小化時は実寸0でも true（手で最小化されても動く）`, rh.zero === true, rh);
      t(`${tag}: 最小化時でも display:none は false`, !rh.none && !rh.inNone, rh);
    }
  } finally { await b2.close(); }
}

// --- 取りこぼしが残っていないか ---------------------------------------
// 実測で2箇所（生成中の停止ボタン・再試行ボタン）が実寸だけを見る古い idiom のまま
// 残っていた。非アクティブなタブや最小化中はそこも実寸0になるので、判定は1種類に揃える。
{
  const allDefs = src.split("\n").filter(l => /\bvisible\s*=\s*\w+\s*=>/.test(l));
  const odd = allDefs.filter(l => !l.includes("visible=e=>{"));
  t("visible 判定はすべて共通版（実寸だけを見る古い idiom が残っていない）",
    allDefs.length > 0 && odd.length === 0, odd.map(l => l.trim().slice(0, 70)));
}

// --- 回答本体の読み取り -------------------------------------------------
// innerText はレイアウト結果を読むので、タブが非アクティブ（アプリ画面など別タブが
// 手前）だと空になり得る。実測: 回答が画面に見えているのに1文字も取れず、
// $responseSeen が立たないまま待ち続けた。
{
  t("最新応答は innerText が空なら textContent へ落とす",
    /const rendered\s*=\s*\([^;\n]*\.innerText\s*\|\|\s*''\)\.trim\(\);[\s\S]{0,160}const text\s*=\s*rendered\s*\|\|\s*\([^;\n]*\.textContent/.test(src));
  t("どちらで読めたかを呼び出し側へ返す（後から切り分けられるように）",
    /fallback: rendered \? '' : 'textContent'/.test(src));
  t("スナップショットも textContent へ落とす",
    /const t\s*=\s*\(\([^;\n]*\.innerText\s*\|\|\s*''\)\.trim\(\)\)\s*\|\|\s*\(\([^;\n]*\.textContent\s*\|\|\s*''\)\.trim\(\)\)/.test(src));
  t("main全文も textContent へ落とす",
    /document\.querySelector\('main'\)\s*\|\|\s*document\.body;[^\n]{0,160}e\.innerText\s*\|\|\s*e\.textContent/.test(src));
}

if (bad) { console.error(`\nTest-AttachmentVisibility: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-AttachmentVisibility: PASS");
