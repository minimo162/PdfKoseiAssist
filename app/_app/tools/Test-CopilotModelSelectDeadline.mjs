import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Set-KoseiCopilotModel が Edge に流す非同期の式が、ページ内の持ち時間で必ず打ち切られることを確かめる。
// ⚠️ 打ち切らないと、候補が多い・メニューの確認が取れないときに sleep が積み重なって
//    「CDP応答タイムアウト：Runtime.evaluate」になり、しかもページ側ではメニュー操作が続く。
// 実際の DOM は使わず、式が触る最小限の要素だけを作って丸ごと実行する。
const source = readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const fn = /function Set-KoseiCopilotModel \{[\s\S]*?\$jsTpl = @'\r?\n([\s\S]*?)\r?\n'@/.exec(source);
assert.ok(fn, "Set-KoseiCopilotModel template not found in CopilotClient.ps1");
const template = fn[1];
assert.ok(template.includes("__BUDGET_MS__"), "model selection script must carry an in-page budget");

const budgetMatch = /\$script:KoseiModelSelectBudgetMs = (\d+)/.exec(source);
const marginMatch = /\$script:KoseiModelSelectCdpMarginSeconds = (\d+)/.exec(source);
assert.ok(budgetMatch && marginMatch, "budget/margin settings not found");
// 持ち時間は、CDP の応答待ち（持ち時間＋余裕）より十分に短いこと。
assert.ok(Number(marginMatch[1]) >= 10, "CDP wait must leave a margin over the in-page budget");

function fakePage({ labels, clickChangesLabel }) {
  const style = { display: "block", visibility: "visible" };
  const doc = { visibilityState: "visible", activeElement: null };
  const win = { innerWidth: 1280, innerHeight: 900, getComputedStyle: () => style };
  doc.defaultView = win;
  const el = (props) => ({
    ownerDocument: doc,
    innerText: "",
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    getAttribute: (name) => (props.attrs || {})[name] ?? null,
    querySelector: () => null,
    dispatchEvent: () => true,
    focus() {},
    click() { if (props.onClick) props.onClick(); },
    ...props,
  });
  let menuOpen = false;
  const button = el({ innerText: "自動", attrs: { "aria-haspopup": "menu", "aria-label": "モデル" }, onClick: () => { menuOpen = true; } });
  const items = labels.map((label) => el({
    innerText: label,
    attrs: { role: "menuitem" },
    onClick: () => { if (clickChangesLabel) button.innerText = label; menuOpen = false; },
  }));
  const menu = el({ querySelectorAll: () => (menuOpen ? items : []) });
  doc.body = button;
  doc.querySelector = (sel) => (sel === "#gptModeSwitcher" ? button : sel === ".fui-MenuPopover" && menuOpen ? menu : null);
  doc.querySelectorAll = (sel) => (sel === "iframe" ? [] : sel.includes(".fui-MenuPopover") && menuOpen ? [menu] : []);
  return { doc, win };
}

class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }

async function run({ candidates, budgetMs, labels, clickChangesLabel }) {
  const { doc, win } = fakePage({ labels, clickChangesLabel });
  const js = template
    .replace("__CANDIDATES__", JSON.stringify(candidates))
    .replace("__SWITCHER__", JSON.stringify("#gptModeSwitcher"))
    .replace("__BUDGET_MS__", String(budgetMs));
  const started = Date.now();
  const raw = await new Function("document", "window", "PointerEvent", "MouseEvent", "KeyboardEvent", `return ${js};`)(
    doc, win, FakeEvent, FakeEvent, FakeEvent,
  );
  return { result: JSON.parse(raw), elapsedMs: Date.now() - started };
}

// 1. 通常どおり選べるときは、持ち時間を入れても結果は変わらない。
{
  const { result } = await run({ candidates: ["Model B"], budgetMs: 15000, labels: ["Model A", "Model B"], clickChangesLabel: true });
  assert.equal(result.reason, "selected");
  assert.equal(result.after, "Model B");
}

// 2. 確認が取れない候補が並んでも、持ち時間で打ち切って deadline_exceeded を返す。
//    打ち切りが無いと 1候補あたり約3秒（確認2秒＋閉じ直し）で、4候補なら12秒を超える。
{
  const labels = ["Model A", "Model B", "Model C", "Model D"];
  const { result, elapsedMs } = await run({ candidates: labels, budgetMs: 800, labels, clickChangesLabel: false });
  assert.equal(result.reason, "deadline_exceeded", JSON.stringify(result));
  assert.equal(result.changed, false);
  assert.ok(elapsedMs < 4000, `budget not honoured: ${elapsedMs}ms`);
}

console.log("Test-CopilotModelSelectDeadline: ok");
