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
  ["パケット詳細パネルを持つ", 'id="reviewPacketDetail"'],
  ["パケット状態遷移を表示する", "review-packet-state-ladder"],
  ["パケットraw抜粋を表示する", "reviewPacketRaw"],
  ["パケット入力hashを表示する", "input_hash"],
  ["パケット保留にして続行できる", "保留にして続行"],
  ["パケット選択をキーボード操作できる", "data-review-packet-select"],
  ["指摘詳細比較パネルを持つ", 'id="reviewDetailPanel"'],
  ["対象と比較資料の引用欄を持つ", "reviewTargetEvidence"],
  ["比較資料欠落を明示する", "欠落候補として要確認"],
  ["詳細判定を再描画する", "data-review-detail-decision"],
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
  ["PageModelを利用する", "./js/layout-model.mjs"],
  ["参照整合を利用する", "./js/reference-alignment.mjs"],
  ["候補ledgerを利用する", "./js/candidate-ledger.mjs"],
  ["条件付きreview routerを利用する", "./js/review-router.mjs"],
  ["ローカル候補を送信payloadから分離する", "Local-only structural evidence; never included in Copilot payloads."],
  ["候補根拠を表示する", "finding-evidence-grid"],
  ["決定的検査を表示する", "決定的検査"],
  ["Reviewer Aを表示する", "Reviewer A"],
  ["試行timelineを表示する", "auto-attempt-details"],
  ["raw response抜粋を表示する", "raw response（抜粋）"],
  ["再試行と再判定を分離する", "再試行=新しい回答 / 再判定=現在の指摘を確認"],
  ["再判定導線を持つ", "autoRejudgeLink"],
  ["意味的完了状態を表示する", "processing_done_with_review"],
  ["取り込み後も決定的根拠を保持する", "deterministic_check: importedDeterministic"],
  ["取り込み後もReviewer A/Bを保持する", "reviewer_a: importedReviewerA"],
  ["手動取り込みをpacket概要へ反映する", "buildManualReviewState(data, incoming.length)"],
  ["候補件数を表示する", "候補ledger"],
  ["Copilot呼出数を表示する", "Copilot呼出"],
  ["処理段階を表示する", "段階"],
  ["監査状態を表示する", "監査"],
  ["判断ショートカットを持つ", "a: \"accepted\""],
  ["mobile操作をstickyにする", "position: sticky; bottom: 0"],
  ["根拠カードをmobile縦積みにする", ".finding-evidence-grid { grid-template-columns: 1fr; }"],
  ["狭幅metricを1列化する", "@media (max-width: 420px)"],
  ["overviewの横スクロールを抑制する", "overflow-x: hidden"],
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
