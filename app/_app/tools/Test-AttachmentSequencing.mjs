// Test-AttachmentSequencing.mjs — single-file input replacement regression
// The live Copilot page may replace <input type=file> after each selection.
// This test models that DOM lifecycle and checks the production contract.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = fs.readFileSync(path.join(here, "..", "src", "CopilotClient.ps1"), "utf8");
const start = client.indexOf("function Invoke-KoseiCopilotAttachFiles");
const end = client.indexOf("\nfunction ", start + 10);
if (start < 0 || end <= start) throw new Error("添付関数を取得できません");
const attach = client.slice(start, end);

for (const marker of [
  "foreach ($fileIndex in 0..($Files.Count - 1))",
  "$resolveFileInput = {",
  "DOM.getDocument",
  "$setSingleFile = {",
  "Assert-KoseiTrustedCopilotOriginOnSocket",
  "files = @($FilePath)",
  "添付ファイル確定 fileIndex=",
  "添付完了確定 files=",
]) {
  if (!attach.includes(marker)) throw new Error("逐次添付契約がありません: " + marker);
}
if (attach.includes("files = @($Files)")) {
  throw new Error("複数ファイルを一度にsetFileInputFilesへ渡す旧経路が残っています");
}

class FakeInput {
  constructor(page, id) {
    this.page = page;
    this.id = id;
    this.detached = false;
  }
  setFile(file) {
    if (this.detached) throw new Error("stale input");
    this.page.setCalls.push({ inputId: this.id, files: [file] });
    if (this.page.failOn === file) throw new Error("setFileInputFiles failed");
    this.page.chips.push(file);
    this.detached = true;
    this.page.input = new FakeInput(this.page, this.id + 1);
  }
}

class FakePage {
  constructor({ failOn = "" } = {}) {
    this.input = new FakeInput(this, 1);
    this.failOn = failOn;
    this.chips = [];
    this.setCalls = [];
  }
  reacquireInput() { return this.input; }
  cleanup() { this.chips = []; }
}

async function sequentialAttach(page, files, { cancelBeforeIndex = -1 } = {}) {
  const attached = [];
  for (let index = 0; index < files.length; index++) {
    if (index === cancelBeforeIndex) {
      page.cleanup();
      return { completedBy: "cancelled", attached };
    }
    const input = page.reacquireInput();
    if (!input) throw new Error("file input missing");
    input.setFile(files[index]);
    if (!page.chips.includes(files[index])) throw new Error("chip did not appear");
    attached.push(files[index]);
  }
  const stable = page.chips.length === files.length
    && files.every(file => page.chips.includes(file));
  if (!stable) throw new Error("final all-expected verification failed");
  return { completedBy: "stable-chip", attached };
}

const files = ["PROMPT_SEC_001.txt", "TEXT_SEC_001.txt"];
const normalPage = new FakePage();
const normal = await sequentialAttach(normalPage, files);
if (normal.completedBy !== "stable-chip"
  || normalPage.setCalls.length !== 2
  || normalPage.setCalls[0].files.join() !== files[0]
  || normalPage.setCalls[1].files.join() !== files[1]
  || normalPage.setCalls[0].inputId === normalPage.setCalls[1].inputId
  || normalPage.chips.join() !== files.join(",")) {
  throw new Error("PROMPT→TEXTを差し替えinputへ個別送信し、両chipを保持できません");
}
console.log("  ok   replaced input receives PROMPT then TEXT separately; both chips survive");

const failedPage = new FakePage({ failOn: files[1] });
let failed = false;
try { await sequentialAttach(failedPage, files); } catch { failed = true; }
if (!failed || failedPage.setCalls.length !== 2 || failedPage.chips.join() !== files[0]) {
  throw new Error("2件目のsetFileInputFiles失敗時に先行chip/失敗境界を保護できません");
}
console.log("  ok   replacement failure does not silently report success");

const cancelledPage = new FakePage();
const cancelled = await sequentialAttach(cancelledPage, files, { cancelBeforeIndex: 1 });
if (cancelled.completedBy !== "cancelled"
  || cancelledPage.setCalls.length !== 1
  || cancelledPage.chips.length !== 0
  || cancelled.attached.join() !== files[0]) {
  throw new Error("キャンセル時に後続添付または残留chipを許している");
}
console.log("  ok   cancellation stops before next file and cleans residual chips");

console.log("Test-AttachmentSequencing: PASS");
