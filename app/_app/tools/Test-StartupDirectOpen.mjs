import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// index.html をエクスプローラーから直接開く（file://）と、モジュールが読み込まれず15秒間まっ白になっていた。
// 起動前スクリプトだけを取り出し、直接開いたときにすぐ起動方法を出すことを確かめる。
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const boot = (html.match(/<script>\s*(\(\(\) => \{\s*const html = document\.documentElement;[\s\S]*?\}\)\(\);)\s*<\/script>/) || [])[1];
assert.ok(boot, "startup script not found in index.html");

function run(protocol) {
  const dataset = {};
  const listeners = [];
  const timers = [];
  const box = { id: "", textContent: "", setAttribute() {} };
  const body = { prepend: el => { box.id = el.id; } };
  const document = {
    documentElement: { dataset },
    body,
    getElementById: id => (box.id === id ? box : null),
    createElement: () => box,
    addEventListener() {},
  };
  const window = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) };
  const location = { protocol, search: "" };
  new Function("document", "window", "location", "setTimeout", "clearTimeout", "URLSearchParams", boot)(
    document, window, location, (fn, ms) => { timers.push(ms); return timers.length; }, () => {}, URLSearchParams,
  );
  return { dataset, box, listeners, timers, window };
}

const direct = run("file:");
assert.equal(direct.dataset.koseiStartup, "failed");
assert.match(direct.box.textContent, /PDF校正アシスト起動\.cmd/);
assert.deepEqual(direct.timers, []);

const served = run("http:");
assert.equal(served.dataset.koseiStartup, "booting");
assert.deepEqual(served.timers, [15000]);
const onError = served.listeners.find(l => l.type === "error");
assert.equal(onError.capture, true, "script load errors do not bubble; listen in the capture phase");
onError.fn({ target: { tagName: "IMG" } });
assert.equal(served.dataset.koseiStartup, "booting", "an image failing to load is not a startup failure");

const failing = run("http:");
failing.window.__koseiMarkStartupFailed = message => { failing.dataset.koseiStartup = "failed"; failing.message = message; };
failing.listeners.find(l => l.type === "error").fn({ target: { tagName: "SCRIPT" } });
assert.equal(failing.dataset.koseiStartup, "failed");

console.log("Test-StartupDirectOpen: ok");
