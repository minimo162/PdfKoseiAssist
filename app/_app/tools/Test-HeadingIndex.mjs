import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildNumberedHeadingIndexPrompt, extractNumberedHeadingIndex } from "../js/heading-index.mjs";

const sidecar = `PDF校正アシスト 抽出テキスト: PKT-01
===== PDF P.2 / TARGET_CONTEXT / 元PDF P.11 / target.pdf =====
0. Context Only
===== PDF P.3 / TARGET_CHECK / 元PDF P.12 / target.pdf =====
1. Overview of the Subordinated Loan
- Overview of the Subordinated Loan
1 Domestic ⟦#AAA⟧ ⟦#BBB⟧
(2) Details of the Loan
2. Details of the Loan
===== PDF P.4 / TARGET_CHECK / 元PDF P.13 / target.pdf =====
Ⅱ. Impact on Financial Results
3. Impact on Financial Results
(4) Other Information
===== PDF P.5 / REF1_CANDIDATE / 元PDF P.7 / reference.pdf =====
5. Reference Only`;

let failures = 0;
const test = (name, condition) => {
  if (condition) console.log("  ok   " + name);
  else { failures++; console.error("  FAIL " + name); }
};

const entries = extractNumberedHeadingIndex(sidecar);
const texts = entries.map(entry => `${entry.page}:${entry.text}`);
test("TARGET_CHECKだけを抽出する", !texts.some(text => /Context Only|Reference Only/.test(text)));
test("アラビア数字・括弧・ローマ数字の見出しを抽出する",
  texts.includes("12:1. Overview of the Subordinated Loan")
  && texts.includes("12:(2) Details of the Loan")
  && texts.includes("13:Ⅱ. Impact on Financial Results")
  && texts.includes("13:(4) Other Information"));
test("表行と箇条書きを見出しにしない",
  !texts.some(text => /Domestic|^- Overview/.test(text)));

const prompt = buildNumberedHeadingIndexPrompt(sidecar);
test("存在確認済み一覧としてページ付きでプロンプト化する",
  /存在確認済み/.test(prompt)
  && /P\.12: 1\. Overview of the Subordinated Loan/.test(prompt));
test("一覧にある見出しの欠番報告を禁止する",
  /一覧に1件でもあれば、その欠番候補は報告禁止/.test(prompt)
  && /一覧に無いことだけでは欠番の証明になりません/.test(prompt));

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
test("手動ZIP・通常校正・整合性校正の伏字TEXTから一覧を作る",
  (html.match(/buildNumberedHeadingIndexPrompt\((?:maskedText|text)\)/g) || []).length === 3
  && /generatedPromptText = buildPacketPromptText\(effectivePacket\) \+ buildNumberedHeadingIndexPrompt\(maskedText\)/.test(html));
test("手動ZIPの依頼文ファイルとコピーボタンが同じ一覧付きプロンプトを使う",
  /bytes: encodeUtf8\(generatedPromptText\)/.test(html)
  && (html.match(/firstPacket\.generatedPromptText \|\| buildPacketPromptText\(firstPacket\)/g) || []).length === 2);
test("整合性では観点指示とquality gateより後に一覧を置く",
  /prompt: basePrompt \+ suffix \+ \(suffix \? "\\n\\n" \+ candidateValidationPromptSection\(hasRef\) : ""\) \+ headingIndex/.test(html));

if (failures) {
  console.error(`\nTest-HeadingIndex: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-HeadingIndex: PASS");
