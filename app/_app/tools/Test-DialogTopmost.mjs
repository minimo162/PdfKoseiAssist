import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 初回セットアップの「準備ができました」が Edge の後ろに隠れ、完了していないように見えた。
// 見えない最前面の親に持たせるだけでは足りないので、メッセージ自体を最前面・前面に出していることを確かめる。
const src = readFileSync(new URL("../src/DesktopUi.ps1", import.meta.url), "utf8");
const fn = (src.match(/function Show-KoseiDesktopDialog \{[\s\S]*?\n\}/) || [])[0];
assert.ok(fn, "Show-KoseiDesktopDialog not found");
assert.match(fn, /MessageBoxW\(\$owner\.Handle/, "the dialog must be owned by the hidden topmost form");
assert.match(fn, /0x40000/, "MB_TOPMOST must be set on the message box itself");
assert.match(fn, /0x10000/, "MB_SETFOREGROUND must be set so the message box comes to the front");
assert.match(fn, /\[Windows\.Forms\.MessageBox\]::Show\(\$owner/, "keep the WinForms fallback when user32 cannot be called");
console.log("Test-DialogTopmost: ok");
