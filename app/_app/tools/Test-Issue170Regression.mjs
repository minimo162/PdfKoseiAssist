// Test-Issue170Regression.mjs — 指摘レポートの「確認済み」が開き直すと消える (#170)
//
// report-server.ps1 は起動のたびに空いているポートで待ち受ける。localStorage はポートごとに
// 分かれるので、開き直すと前回の「確認済み」が読めなかった。確認状況は展開フォルダの
// 確認状況.json に保存する（GET/PUT /__report-state）。ここでは次を確かめる。
//   - 別々のポートで2回起動しても、1回目で保存した確認状況を2回目で読める
//   - トークン無し・Host違い・上限超え・パスの抜け出しの書き込みは拒否される
//   - exported_at が違うファイルは読まない / 旧 localStorage の値はファイルへ移る
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import net from "node:net";

const root = join(import.meta.dirname, "..");
const lines = readFileSync(join(root, "index.html"), "utf8").split(/\r?\n/);
const STATE_NAME = "確認状況.json";

const results = [];
const t = (name, ok, detail = "") => results.push({ ok: !!ok, name, detail });

function functionSource(signature, nextSignature) {
  const start = lines.findIndex((line) => line.includes(signature));
  if (start < 0) throw new Error(`Missing function: ${signature}`);
  const next = lines.findIndex((line, index) => index > start && line.includes(nextSignature));
  if (next < 0) throw new Error(`Missing next function: ${nextSignature}`);
  return lines.slice(start, next).join("\n").trimEnd();
}

// ---- report-server.ps1 ------------------------------------------------------

function rawRequest(port, head, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    const sock = net.connect(port, "127.0.0.1");
    const finish = () => {
      if (finished) return;
      finished = true;
      const text = Buffer.concat(chunks).toString("utf8");
      const m = text.match(/^HTTP\/1\.1 (\d{3})/);
      const idx = text.indexOf("\r\n\r\n");
      resolve({ status: m ? Number(m[1]) : 0, body: idx >= 0 ? text.slice(idx + 4) : "" });
    };
    sock.on("connect", () => sock.write(Buffer.concat([Buffer.from(head, "latin1"), body])));
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", (e) => (chunks.length ? finish() : reject(e)));
    sock.setTimeout(10_000, () => sock.destroy(new Error("socket timeout")));
  });
}

function stateRequest(port, { method = "PUT", path = "/__report-state", host = `127.0.0.1:${port}`, token, body = "", contentLength } = {}) {
  const bytes = Buffer.from(body, "utf8");
  const head = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Content-Type: application/json",
    token == null ? null : `X-Report-Token: ${token}`,
    `Content-Length: ${contentLength ?? bytes.length}`,
    "Connection: close",
    "", "",
  ].filter((x) => x !== null).join("\r\n");
  return rawRequest(port, head, contentLength == null ? bytes : Buffer.alloc(0));
}

async function startServer(dir) {
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(dir, "report-server.ps1"), "-NoBrowser",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for REPORT_URL " + stderr)), 15_000);
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => {
      if (!line.startsWith("REPORT_URL=")) return;
      clearTimeout(timer);
      output.close();
      resolve(line.slice("REPORT_URL=".length));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited before startup (${code}) ${stderr}`)));
  });
  const parsed = new URL(url);
  return { child, url, port: Number(parsed.port), token: parsed.searchParams.get("t") || "" };
}

function stopServer(server) {
  if (!server || server.child.exitCode != null || server.child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => { server.child.once("exit", resolve); server.child.kill(); });
}

const exportedAt = "2026-09-25T01:02:03.000Z";
const tempRoot = mkdtempSync(join(tmpdir(), "kosei-issue170-"));
const reportDir = join(tempRoot, "report");
mkdirSync(reportDir);
let first, second;
try {
  const { buildReportServerPs1Text } = eval(`(function () {
    ${functionSource("function buildReportServerPs1Text(", "function buildReportOpenCmdText(")}
    return { buildReportServerPs1Text };
  })()`);
  const serverText = buildReportServerPs1Text();
  // 生成スクリプトは BOM なしで書き出す。PowerShell 5.1 は BOM なしを ANSI として読むので、
  // 日本語を直接書くとファイル名が化ける。
  t("report-server.ps1 に日本語を直接書いていない", !/[^\x00-\x7f]/.test(serverText));
  writeFileSync(join(reportDir, "指摘レポート.html"), "<!doctype html><meta charset=utf-8><title>report-ok</title>");
  writeFileSync(join(reportDir, "report-server.ps1"), serverText);

  first = await startServer(reportDir);
  t("開くURLに起動ごとのトークン ?t= が付く", /^[0-9a-f]{32}$/.test(first.token), first.url);
  const page = await fetch(first.url);
  t("トークン付きURLでもレポートが開く", page.ok && (await page.text()).includes("report-ok"), String(page.status));

  const empty = await fetch(new URL("/__report-state", first.url));
  t("保存が無いときは GET /__report-state が {} を返す", empty.ok && (await empty.text()).trim() === "{}", String(empty.status));

  const good = JSON.stringify({ exported_at: exportedAt, done: ["1", "5"], updated_at: "2026-09-25T02:00:00.000Z" });
  const noToken = await stateRequest(first.port, { body: good });
  t("トークンが無い書き込みは拒否される", noToken.status === 403, String(noToken.status));
  const badToken = await stateRequest(first.port, { body: good, token: "0".repeat(32) });
  t("トークンが違う書き込みは拒否される", badToken.status === 403, String(badToken.status));
  const badHost = await stateRequest(first.port, { body: good, token: first.token, host: `localhost:${first.port}` });
  t("Host が 127.0.0.1:<port> でない書き込みは拒否される", badHost.status === 403, String(badHost.status));
  const evilHost = await stateRequest(first.port, { body: good, token: first.token, host: "evil.example" });
  t("他サイトの Host (DNS rebinding) の書き込みは拒否される", evilHost.status === 403, String(evilHost.status));
  const tooLarge = await stateRequest(first.port, { token: first.token, contentLength: 1024 * 1024 + 1 });
  t("1MB を超える本文は拒否される", tooLarge.status === 413, String(tooLarge.status));
  const notJson = await stateRequest(first.port, { body: "not json", token: first.token });
  t("JSON でない本文は拒否される", notJson.status === 400, String(notJson.status));
  const escapes = [];
  for (const path of [
    "/../" + encodeURIComponent(STATE_NAME),
    "/__report-state/../../" + encodeURIComponent(STATE_NAME),
    "/..%2F" + encodeURIComponent(STATE_NAME),
    "/" + encodeURIComponent(STATE_NAME),
  ]) {
    const r = await stateRequest(first.port, { body: good, token: first.token, path });
    escapes.push(`${path}=${r.status}`);
    if (r.status >= 200 && r.status < 300) escapes.push("ACCEPTED");
  }
  t("/__report-state 以外（../ を含むパス等）への書き込みは拒否される",
    !escapes.includes("ACCEPTED") && !existsSync(join(tempRoot, STATE_NAME)), escapes.join(" "));
  t("拒否した書き込みでは確認状況.json を作らない", !existsSync(join(reportDir, STATE_NAME)));

  const saved = await stateRequest(first.port, { body: good, token: first.token });
  t("正しいトークンと Host の書き込みは受け付ける", saved.status === 200, `${saved.status} ${saved.body}`);
  t("展開フォルダの 確認状況.json に保存される",
    existsSync(join(reportDir, STATE_NAME)) && JSON.parse(readFileSync(join(reportDir, STATE_NAME), "utf8")).done.join(",") === "1,5");
  const updated = JSON.stringify({ exported_at: exportedAt, done: ["1", "5", "7"], updated_at: "2026-09-25T02:01:00.000Z" });
  const saved2 = await stateRequest(first.port, { method: "POST", body: updated, token: first.token });
  t("既存の 確認状況.json を置き換えられる", saved2.status === 200
    && JSON.parse(readFileSync(join(reportDir, STATE_NAME), "utf8")).done.join(",") === "1,5,7", String(saved2.status));
  t("一時ファイル .tmp が残らない", !readdirSync(reportDir).some((f) => f.endsWith(".tmp")), readdirSync(reportDir).join(","));
  const firstToken = first.token, firstPort = first.port;
  await stopServer(first);

  // 2回目。ポートが偶然同じだと検査にならないので、違うポートになるまで起動し直す。
  for (let i = 0; i < 5; i++) {
    second = await startServer(reportDir);
    if (second.port !== firstPort) break;
    await stopServer(second);
  }
  t("2回目は別のポートで起動する", second.port !== firstPort, `${firstPort} -> ${second.port}`);
  t("2回目はトークンも変わる", second.token && second.token !== firstToken);
  const reread = await fetch(new URL("/__report-state", second.url));
  const rereadJson = reread.ok ? await reread.json() : null;
  t("2回目の起動でも1回目の確認状況を読める",
    rereadJson && rereadJson.exported_at === exportedAt && rereadJson.done.join(",") === "1,5,7", JSON.stringify(rereadJson));
  const stale = await stateRequest(second.port, { body: good, token: firstToken });
  t("前回の起動のトークンでは書き込めない", stale.status === 403, String(stale.status));
} catch (e) {
  t("report-server.ps1 の検査を最後まで実行できる", false, String(e.stack || e));
} finally {
  await stopServer(first);
  await stopServer(second);
  rmSync(tempRoot, { recursive: true, force: true });
}

// ---- レポートHTML側（loadDone / persistDone） -----------------------------------

function pageSource() {
  const start = lines.findIndex((l) => l.startsWith("const stateToken="));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("function eligibleCards("));
  if (start < 0 || end < 0) throw new Error("レポート側の確認状況の保存処理が見つかりません");
  const src = lines.slice(start, end).join("\n");
  // reportHtmlDocument のテンプレートリテラル内なので、\ や ${ があると出力が変わる。
  if (/\\|\$\{|`/.test(src)) throw new Error("テンプレート内でエスケープが必要な文字を使っています");
  return src;
}

function makeCard(no) {
  const cb = { checked: false };
  const classes = new Set();
  return {
    id: "issue-" + no, dataset: { no: String(no) }, cb,
    querySelector: (sel) => (sel === "[data-done]" ? cb : null),
    classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
  };
}

function makePage({ protocol = "http:", search = "?t=tok123", fileState = {}, getStatus = 200, putStatus = 200, local = {} } = {}) {
  const cards = [1, 2, 3, 5].map(makeCard);
  const store = new Map(Object.entries(local));
  const calls = [];
  const notes = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if ((opts.method || "GET") === "GET") {
      return { ok: getStatus === 200, status: getStatus, json: async () => fileState };
    }
    return { ok: putStatus === 200, status: putStatus, json: async () => ({ ok: true }) };
  };
  const env = {
    DATA: { exported_at: exportedAt },
    cards,
    active: "issue-1",
    masterDetail: { querySelector: () => null },
    compactProgress: { append: (el) => notes.push(el) },
    updateProgress: () => {},
    apply: () => {},
    location: { protocol, search },
    fetch: fetchStub,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: {
      getElementById: (id) => cards.find((c) => c.id === id) || null,
      createElement: () => ({ style: {}, setAttribute() {}, textContent: "", hidden: false }),
    },
    window: { addEventListener() {} },
  };
  const names = Object.keys(env);
  const api = new Function(...names, pageSource() + "\nreturn { loadDone, persistDone };")(...names.map((n) => env[n]));
  return { ...api, cards, store, calls, notes, checked: () => cards.filter((c) => c.cb.checked).map((c) => c.dataset.no).join(",") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = "pdf-kosei-done:" + exportedAt;
try {
  // 旧 localStorage の値しか無い → 読み込んでファイルへ移す
  const migrate = makePage({ fileState: {}, local: { [key]: JSON.stringify(["1", "3"]) } });
  await migrate.loadDone();
  await sleep(400);
  const put = migrate.calls.find((c) => c.method === "PUT");
  t("旧 localStorage の確認済みを読み込む", migrate.checked() === "1,3", migrate.checked());
  t("旧 localStorage の確認済みをファイルへ移す",
    put && put.url === "/__report-state" && put.body.exported_at === exportedAt && put.body.done.join(",") === "1,3"
      && put.headers["X-Report-Token"] === "tok123" && typeof put.body.updated_at === "string",
    JSON.stringify(put));

  // ファイルがあればファイルを優先する
  const fromFile = makePage({ fileState: { exported_at: exportedAt, done: ["2"] }, local: { [key]: JSON.stringify(["1"]) } });
  await fromFile.loadDone();
  await sleep(400);
  t("確認状況.json があればそれを読む", fromFile.checked() === "2", fromFile.checked());
  t("ファイルから読んだときは書き戻さない", !fromFile.calls.some((c) => c.method === "PUT"));

  // exported_at が違うファイルは読まない
  const other = makePage({ fileState: { exported_at: "2020-01-01T00:00:00.000Z", done: ["2", "5"] } });
  await other.loadDone();
  t("exported_at が違う 確認状況.json は読まない", other.checked() === "", other.checked());

  // 連続した操作は 300ms ほどまとめて1回だけ保存する
  const debounce = makePage({ fileState: {} });
  await debounce.loadDone();
  for (const c of debounce.cards.slice(0, 3)) { c.cb.checked = true; debounce.persistDone(); await sleep(20); }
  t("保存は300ms待ってから行う", !debounce.calls.some((c) => c.method === "PUT"));
  await sleep(450);
  const puts = debounce.calls.filter((c) => c.method === "PUT");
  t("連続した操作は1回の保存にまとまる", puts.length === 1 && puts[0].body.done.join(",") === "1,2,3", JSON.stringify(puts.map((p) => p.body.done)));
  t("localStorage にも控えを残す", debounce.store.get(key) === JSON.stringify(["1", "2", "3"]), debounce.store.get(key));

  // 保存に失敗したら localStorage に残し、画面に小さく知らせる
  const failing = makePage({ fileState: {}, putStatus: 403 });
  await failing.loadDone();
  failing.cards[0].cb.checked = true;
  failing.persistDone();
  await sleep(450);
  t("ファイルに保存できないときも localStorage に残す", failing.store.get(key) === JSON.stringify(["1"]));
  t("ファイルに保存できないときは画面に知らせる",
    failing.notes.length === 1 && /確認状況をファイルに保存できませんでした/.test(failing.notes[0].textContent) && !failing.notes[0].hidden,
    JSON.stringify(failing.notes));

  // file:// で直接開いたとき（サーバーが無い）は localStorage だけで動く
  const direct = makePage({ protocol: "file:", search: "", local: { [key]: JSON.stringify(["5"]) } });
  await direct.loadDone();
  direct.cards[1].cb.checked = true;
  direct.persistDone();
  await sleep(400);
  t("サーバーが無いときは localStorage から読む", direct.checked() === "2,5", direct.checked());
  t("サーバーが無いときは通信しない", direct.calls.length === 0, JSON.stringify(direct.calls));
  t("サーバーが無いときも localStorage に保存する", direct.store.get(key) === JSON.stringify(["2", "5"]), direct.store.get(key));

  // GET に失敗したら localStorage にフォールバックし、以後ファイルには書かない
  const down = makePage({ getStatus: 500, local: { [key]: JSON.stringify(["3"]) } });
  await down.loadDone();
  down.persistDone();
  await sleep(400);
  t("読み込みに失敗したら localStorage で動く", down.checked() === "3" && !down.calls.some((c) => c.method === "PUT"), down.checked());
} catch (e) {
  t("レポート側の検査を最後まで実行できる", false, String(e.stack || e));
}

// ---- 説明文 -----------------------------------------------------------------------

const readme = readFileSync(join(root, "..", "はじめにお読みください.txt"), "utf8");
t("はじめにお読みください.txt が保存先 確認状況.json を説明する", readme.includes("確認状況.json"));
t("ZIP内の README_使い方.txt が保存先 確認状況.json を説明する",
  lines.some((l) => l.includes("確認状況.json に保存されます")) && lines.some((l) => l.includes("フォルダごと渡せば")));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${!r.ok && r.detail ? " — " + r.detail : ""}`);
}
console.log(`Test-Issue170Regression: ${results.length - failed}/${results.length} passed`);
if (failed) process.exitCode = 1;
