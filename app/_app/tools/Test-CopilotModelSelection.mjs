import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Set-KoseiCopilotModel が Edge に流す JS のうち、DOM に触れない照合部分だけを取り出して検証する。
const source = readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");
const block = /\/\* model-match:begin \*\/([\s\S]*?)\/\* model-match:end \*\//.exec(source);
assert.ok(block, "model-match block not found in CopilotClient.ps1");
const { isLatestGptCand, pickLatestGpt, matchesModel } = new Function(
  `${block[1]}\nreturn { isLatestGptCand, pickLatestGpt, matchesModel };`,
)();

const items = labels => labels.map(label => ({ label }));
const pick = (labels, cand) => (pickLatestGpt(items(labels), cand) || {}).label;

assert.equal(isLatestGptCand("GPT 最新"), true);
assert.equal(isLatestGptCand("gpt latest"), true);
assert.equal(isLatestGptCand("GPT 最新 Think Deeper"), true);
assert.equal(isLatestGptCand("GPT 5.6 Think deeper"), false);
assert.equal(isLatestGptCand("Opus"), false);

// 2026-09 時点の GPT サブメニュー: 版が最も新しい 6.0 を選ぶ。
const current = ["GPT 5.6 Sol クイック応答", "GPT 5.6 Sol Think Deeper", "GPT 6.0 Sol"];
assert.equal(pick(current, "GPT 最新"), "GPT 6.0 Sol");

// 将来の版も設定変更なしで追従する（6.10 > 6.9 のように数値で比べる）。
assert.equal(pick([...current, "GPT 6.1 Sol"], "GPT 最新"), "GPT 6.1 Sol");
assert.equal(pick(["GPT 7.0", ...current], "GPT latest"), "GPT 7.0");
assert.equal(pick(["GPT 6.9 Sol", "GPT 6.10 Sol"], "GPT 最新"), "GPT 6.10 Sol");

// 同じ版に複数あるときは Think Deeper → 無印 → クイック応答。後ろに書いた種類があればそれを優先する。
const sameVersion = ["GPT 7.0 Sol クイック応答", "GPT 7.0 Sol", "GPT 7.0 Sol Think Deeper"];
assert.equal(pick(sameVersion, "GPT 最新"), "GPT 7.0 Sol Think Deeper");
assert.equal(pick(sameVersion.slice(0, 2), "GPT 最新"), "GPT 7.0 Sol");
assert.equal(pick(sameVersion, "GPT 最新 クイック応答"), "GPT 7.0 Sol クイック応答");

// 版番号のない項目（自動・Think Deeper・GPT のサブメニュー見出し）は対象にしない。
assert.equal(pick(["自動", "クイック応答", "Think Deeper", "GPT"], "GPT 最新"), undefined);

// 選択後の確認は、実際に押した項目名で一致をとる。
assert.equal(matchesModel("GPT 6.0 Sol", "GPT 最新", "GPT 6.0 Sol"), true);
assert.equal(matchesModel("自動", "GPT 最新", "GPT 6.0 Sol"), false);

console.log("Test-CopilotModelSelection: ok");
