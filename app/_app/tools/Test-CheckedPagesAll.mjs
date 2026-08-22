// Test-CheckedPagesAll.mjs — 広範囲パケットの全ページ確認フラグ(checked_pages_all)経路。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const copilotClient = readFileSync(join(here, "..", "src", "CopilotClient.ps1"), "utf8");

function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: 必要な記述がありません: ${needle}`);
}

// サーバー completeness: フラグで全対象ページを確認済みとして扱う。
requireIncludes(copilotClient, "$checkedAll = ($names -contains 'checked_pages_all') -and ($obj.checked_pages_all -eq $true)", "Get-KoseiReviewCompletenessのフラグ判定");
requireIncludes(copilotClient, "if ($checkedAll) { $checked = $expected }", "Get-KoseiReviewCompletenessの全ページ展開");

// 整合性プロンプト: 全ページ列挙の代わりにフラグを出せる契約と使い分け指示。
requireIncludes(html, "\"checked_pages_all\": false,", "整合性プロンプトのschema例");
requireIncludes(html, "checked_pages の全ページ列挙は回答が長大になり切断の原因になります。", "整合性プロンプトの使い分け指示");
requireIncludes(html, "\"checked_pages_all\": true にして checked_pages は空配列にしてください", "整合性プロンプトのフラグ使用条件");

// 取り込みゲート: 指摘0件の空回答でも、フラグがあれば全ページ確認の根拠として受理する。
function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) throw new Error(`本番関数を切り出せません: ${startMarker}`);
  return source.slice(start, end);
}

const gateSource = sourceBetween(html, "function validateAutoImportSourceBinding", "async function importResponse");
const makeImportGate = new Function(
  "autoImportingPacketId",
  "activeImportAllowedPages",
  `${gateSource}\nreturn validateAutoImportSourceBinding;`,
);

const passthroughGate = makeImportGate("", null);
if (!passthroughGate({ read_error: "" }, [{}]).ok) {
  throw new Error("自動取込外の回答まで拒否しました");
}

const gateWithPages = makeImportGate("PACKET_001", new Set([1, 2, 3]));
const findingResult = gateWithPages({ read_error: "" }, [{ page: 1 }]);
if (!findingResult.ok || findingResult.acceptedCount !== 1) {
  throw new Error(`指摘あり回答の取り込みが壊れています: ${JSON.stringify(findingResult)}`);
}

const insufficient = gateWithPages(
  { read_error: "", no_findings_reason: "問題なし", checked_pages: [1] },
  [],
);
if (insufficient.ok) {
  throw new Error("全ページ確認の根拠がない空回答を取り込みました");
}

const flagged = gateWithPages(
  { read_error: "", no_findings_reason: "問題なし", checked_pages_all: true },
  [],
);
if (!flagged.ok) {
  throw new Error(`checked_pages_all付きの空回答を拒否しました: ${flagged.message}`);
}

const covered = gateWithPages(
  { read_error: "", no_findings_reason: "問題なし", checked_pages: [1, 2, 3] },
  [],
);
if (!covered.ok) {
  throw new Error("列挙による根拠がある空回答を拒否しました");
}

// サーバー(Get-KoseiReviewCompleteness)の70%ゲートと基準を揃える。
// 全ページ列挙だけを要求すると、サーバー受理済みの回答がクライアントで拒否される。
// 70%の境界を実際にpinするため、対象ページ数は4以上を使う(3ページ以下では70%と全件が一致する)。
const wideGate = makeImportGate("PACKET_001", new Set([1, 2, 3, 4]));
const partialCoverage = wideGate(
  { read_error: "", no_findings_reason: "問題なし", checked_pages: [1, 2, 3] },
  [],
);
if (!partialCoverage.ok) {
  throw new Error(`75%の列挙による空回答を拒否しました: ${partialCoverage.message}`);
}
const belowCoverage = makeImportGate("PACKET_002", new Set([1, 2, 3, 4]));
const belowResult = belowCoverage(
  { read_error: "", no_findings_reason: "問題なし", checked_pages: [1, 2] },
  [],
);
if (belowResult.ok) {
  throw new Error("50%の列挙の空回答を取り込みました");
}

const unreadable = gateWithPages(
  { read_error: "スキャン画像で読み取れない", checked_pages_all: true },
  [],
);
if (unreadable.ok) {
  throw new Error("read_error付き回答にフラグを上書きされました");
}

console.log("Test-CheckedPagesAll: PASS");
