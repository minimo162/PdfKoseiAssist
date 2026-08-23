import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");

const checks = [
  ["監査契約をUIへimport", "./js/audit-contract.mjs"],
  ["進捗overviewを持つ", 'id="reviewOverview"'],
  ["ページcoverage metricを持つ", 'reviewOverviewMetric("ページcoverage"'],
  ["パケット進捗を持つ", 'id="reviewPacketList"'],
  ["利用者判定summaryを持つ", 'id="reviewDecisionSummary"'],
  ["採用判定ボタンを持つ", 'data-decision="accepted"'],
  ["要確認判定ボタンを持つ", 'data-decision="needs_review"'],
  ["保留判定ボタンを持つ", 'data-decision="held"'],
  ["棄却判定ボタンを持つ", 'data-decision="rejected"'],
  ["判定をlocalStorageへ保存する", "persistFindingDecisions"],
  ["判定ボタンはカード選択と分離する", "event.stopPropagation()"],
  ["監査manifestを参照できる", "/audit"],
  ["監査manifestを明示削除できる", "/purge"],
  ["モバイルでmetricを2列化する", ".review-overview-metrics { grid-template-columns: repeat(2"],
  ["操作領域を44px以上にする", ".finding-decision-actions .btn { min-height: 44px"],
  ["完了文言をページ確認と意味的確認に分ける", "処理終了（ページ確認完了）"],
];

let failed = 0;
for (const [label, needle] of checks) {
  if (!html.includes(needle)) {
    console.error(`FAIL ${label}: ${needle}`);
    failed += 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

if (failed) process.exit(1);
console.log("Test-ReviewOverviewUi: PASS");
