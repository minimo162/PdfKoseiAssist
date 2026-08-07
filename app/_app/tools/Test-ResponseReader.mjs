// 回答の読み取りが「Markdownレンダリング後のDOM」から星印を失わないかを見る。
//
// 何を確かめるか（引き継ぎ書 §8）:
//   1. 地の文で返された JSON では *1 … *1 が強調として消える（＝直す前の壊れ方の再現）
//   2. ```json のコードフェンスなら消えない
//   3. src/CopilotClient.ps1 の読み取りが、フェンスがあればそちらを採る
//
// ヘッドレスEdgeでDOMを作り、製品と同じ抽出式を流し込んで比べる。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killHeadlessByProfile } from "./headless-cleanup.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
const ok = (name) => results.push({ ok: true, name });
const fail = (name, detail) => results.push({ ok: false, name, detail });

// 製品の抽出式を、コメントごとそのまま取り出して使う。書き写すと本体とずれる。
const ps = readFileSync(join(ROOT, "src", "CopilotClient.ps1"), "utf8");
const m = ps.match(/function Get-KoseiLatestResponseText[\s\S]*?\$js = @'\r?\n([\s\S]*?)\r?\n'@/);
if (!m) { console.error("Get-KoseiLatestResponseText の抽出式が見つかりません"); process.exit(1); }
const EXTRACT_JS = m[1];

// Copilot の返信要素を模した2通りのページ。Markdown のレンダリングは
// 「強調は消える／コードブロックは消えない」という点だけ再現すれば足りる。
const QUOTE = '(Note) *2 Depreciation includes amortization of intangible assets';
const JSON_BODY = JSON.stringify({ findings: [{ page: 123, quote: QUOTE }] });

const page = (inner) => `<!doctype html><meta charset="utf-8"><body>
<div data-testid="markdown-reply">${inner}</div>
</body>`;

// 1) 地の文: *2 … *2 が <em> になって星印が落ちる（Copilot 側の描画結果を写したもの）
const prose = page(`<p>{"findings": [{"page": 123, "quote": "(Note) <em>2 Depreciation includes amortization of intangible assets"}]}</em></p>`);
// 2) コードフェンス: そのまま残る
const fenced = page(`<pre><code>${JSON_BODY.replace(/</g, "&lt;")}</code></pre>`);

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
const cdp = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try { target = (await cdp("/json/list")).find(t => t.type === "page"); } catch { /* まだ起きていない */ }
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
  if (!/\*/.test(String(a.text || ""))) ok("地の文だと星印が消える（壊れ方の再現）");
  else fail("地の文だと星印が消える（壊れ方の再現）", `星印が残った: ${a.text}`);

  const b = await evalOn(fenced);
  if (String(b.text || "").includes(QUOTE)) ok("コードフェンスなら星印が残る");
  else fail("コードフェンスなら星印が残る", `取れた: ${b.text}`);

  if (String(b.fallback || "") === "codeBlock") ok("フェンスがあるときはコードブロックから読んでいる");
  else fail("フェンスがあるときはコードブロックから読んでいる", `fallback=${b.fallback}`);

  if (String(a.fallback || "") !== "codeBlock") ok("フェンスが無ければ従来どおり innerText に落ちる");
  else fail("フェンスが無ければ従来どおり innerText に落ちる", `fallback=${a.fallback}`);
} finally {
  try { child.kill(); } catch { /* 既に落ちている */ }
  killHeadlessByProfile(profile);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 消せなくてもよい */ }
}

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "\n       " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-ResponseReader: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
