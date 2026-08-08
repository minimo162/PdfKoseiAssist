// 回答の読み取りが、Markdownレンダリング後のDOMから脚注記号を失わないかを見る。
//
// 経緯（引き継ぎ書 §8）:
//   Copilot の回答は Markdown をレンダリングした後の DOM から読む。地の文で返された
//   JSON は Markdown として解釈され、*1 … *1 のように対になった星印が強調記号として
//   **消える**。引用が本文と食い違うのでハイライトが当たらない。
//
//   ⚠️ **コードフェンスで囲ませる案は駄目だった。** Copilot はコードブロックに
//      行番号を差し込み、長いものを折りたたむ（「その他の行を表示する」）。
//      行番号が本文に混ざって JSON として読めず、実測で3パケットが no-json-idle で
//      落ちた。全文が DOM に無いので、行番号を剥がしても直らない。
//
//   → 依頼文の側で `\*2` のようにエスケープさせる。Markdown はエスケープを解いて
//     `*2` を出すので、ここで読むテキストがそのまま正しくなる。
//
// この道具が守るもの:
//   1. エスケープされていない `*1 … *1` は消える（＝直っていないと分かる形）
//   2. エスケープされた `\*2` はレンダリング後に `*2` として残る
//   3. 読み取りはコードブロックを**優先しない**（行番号を拾わない）
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killHeadlessByProfile } from "./headless-cleanup.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
const ok = (name) => results.push({ ok: true, name });
const fail = (name, detail) => results.push({ ok: false, name, detail });

// 製品の抽出式をそのまま取り出して使う。書き写すと本体とずれる。
const ps = readFileSync(join(ROOT, "src", "CopilotClient.ps1"), "utf8");
const m = ps.match(/function Get-KoseiLatestResponseText[\s\S]*?\$js = @'\r?\n([\s\S]*?)\r?\n'@/);
if (!m) { console.error("Get-KoseiLatestResponseText の抽出式が見つかりません"); process.exit(1); }
const EXTRACT_JS = m[1];

const QUOTE = "(Note) *2 Depreciation includes amortization of intangible assets";

const page = (inner) => `<!doctype html><meta charset="utf-8"><body>
<div data-testid="markdown-reply">${inner}</div>
</body>`;

// 1) 地の文・エスケープ無し: *2 … *2 が <em> になって星印が落ちる（壊れ方の再現）
const prose = page(`<p>{"quote": "(Note) <em>2 Depreciation includes amortization of intangible assets"}</em></p>`);
// 2) 地の文・エスケープ有り: \*2 はレンダリング後 *2 として残る
const escaped = page(`<p>{"quote": "${QUOTE.replace(/&/g, "&amp;").replace(/</g, "&lt;")}"}</p>`);
// 4) 空の返信要素が後ろに付く形。**最後を採ると空が返る。**
//    実測 2026-08-08: markdown-reply が2個あり [0]=5100文字（KOSEI_END まで完成）/ [1]=0文字。
//    最後を採ったせいで「回答は完成しているのに生成停滞」と判定し、180秒待って捨てていた。
const trailingEmpty = page(
  `<div data-testid="markdown-reply"><p>{"quote": "${QUOTE}"} KOSEI_END</p></div>` +
  `<div data-testid="markdown-reply"></div>`);
// 3) コードフェンス: Copilot は行番号を差し込み、長いものを折りたたむ
const fenced = page(`<div><div>JSON</div><pre><code><span>1</span>{"quote": "(Note) *2 …"}<span>2</span></code></pre><button>その他の行を表示する</button></div>`);

const exe = [
  process.env.KOSEI_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean).find(p => { try { readFileSync(p); return true; } catch { return false; } });
if (!exe) { console.error("Edge が見つかりません"); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "kosei-reader-"));
const profile = join(dir, "profile");
const port = 9800 + (process.pid % 100);
const child = spawn(exe, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === "page");
    } catch { /* まだ起きていない */ }
  }
  if (!target) throw new Error("CDP に繋がりません");

  // WebSocket は Node 22+ の組み込みを使う（依存を増やさない）
  const evalOn = async (html) => {
    const file = join(dir, "page.html");
    writeFileSync(file, html, "utf8");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const send = (method, params) => new Promise(res => {
      const mid = ++id;
      const onMsg = e => {
        const d = JSON.parse(e.data);
        if (d.id === mid) { ws.removeEventListener("message", onMsg); res(d.result); }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send("Page.enable", {});
    await send("Page.navigate", { url: pathToFileURL(file).href });
    await sleep(600);
    const r = await send("Runtime.evaluate", { expression: EXTRACT_JS, returnByValue: true });
    ws.close();
    return JSON.parse(r?.result?.value || "{}");
  };

  const a = await evalOn(prose);
  if (!/\*/.test(String(a.text || ""))) ok("エスケープ無しだと星印が消える（壊れ方の再現）");
  else fail("エスケープ無しだと星印が消える（壊れ方の再現）", `星印が残った: ${a.text}`);

  const b = await evalOn(escaped);
  if (String(b.text || "").includes(QUOTE)) ok("エスケープすれば星印が残る");
  else fail("エスケープすれば星印が残る", `取れた: ${b.text}`);

  const c = await evalOn(fenced);
  const txt = String(c.text || "");
  if (String(c.fallback || "") !== "codeBlock") ok("コードブロックを優先していない");
  else fail("コードブロックを優先していない", `fallback=${c.fallback}`);
  if (/その他の行を表示する/.test(txt)) ok("フェンスは折りたたまれる（採用できない証拠が残る）");
  else fail("フェンスは折りたたまれる（採用できない証拠が残る）", `取れた: ${txt.slice(0, 120)}`);
  const d = await evalOn(trailingEmpty);
  if (String(d.text || "").includes(QUOTE)) ok("空の返信要素が後ろに付いても、中身のある方を読む");
  else fail("空の返信要素が後ろに付いても、中身のある方を読む", `取れた: ${JSON.stringify(String(d.text || "").slice(0, 80))}`);
  if (Number(d.skippedEmpty || 0) === 1) ok("空を飛ばした数が記録される（skippedEmpty=1）");
  else fail("空を飛ばした数が記録される（skippedEmpty=1）", `skippedEmpty=${d.skippedEmpty}`);
} finally {
  try { child.kill(); } catch { /* 既に落ちている */ }
  killHeadlessByProfile(profile);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 消せなくてもよい */ }
}

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "\n       " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ResponseReader: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
