// Test-IndexHtmlSyntax.mjs — index.html のインライン JS を構文チェック（node tools/Test-IndexHtmlSyntax.mjs）
// 5000行超の monolith を編集した際の構文崩れを機械的に検知する。node --check は構文のみ検証
// （ブラウザ globals の未定義は無視）。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const findingQuality = readFileSync(join(here, "..", "js", "finding-quality.mjs"), "utf8");

// ⚠️ 正規表現で「開きタグ 〜 綴じタグ」を切り出してはいけない。
//    アプリ本体の中には指摘レポート(HTML)を組み立てる**巨大なテンプレート文字列**があり、
//    その中にエスケープした綴じタグが入っている。素直に切ると本体の途中から始まる断片が取れ、
//    その断片は**テンプレート文字列の内側**なので、何を入れても構文エラーにならない。
//
//    実測（2026-08-05）: 文字列リテラルに生の改行が入った致命的な構文エラーを
//    このテストが「PASS」と報告した。アプリは真っ白（window.__koseiBenchmark が未定義）になり、
//    実機で走らせて初めて気づいた。
//
//    そこで**行**で切る。開始は開きタグだけの行、終了は綴じタグだけの行。
//    テンプレート内の綴じタグはエスケープされていて単独行にならないので、本体を丸ごと取り出せる。
const OPEN_LINE = /^\s*<script(?![^>]*\bsrc=)[^>]*>\s*$/;
const CLOSE_LINE = /^\s*<\/script>\s*$/;
const lines = html.split(/\r?\n/);
const blocks = [];
for (let n = 0; n < lines.length; n++) {
  if (!OPEN_LINE.test(lines[n])) continue;
  let close = -1;
  for (let k = n + 1; k < lines.length; k++) if (CLOSE_LINE.test(lines[k])) { close = k; break; }
  if (close < 0) continue;
  blocks.push({ start: n + 2, body: lines.slice(n + 1, close).join("\n"), module: /type="module"/.test(lines[n]) });
  n = close;
}

// ⚠️ 拡張子は **.mjs** にする。`.js` だと CJS として包まれ、V8 が関数本体を遅延解析するため
//    **本体の奥にある構文エラーを見逃す**。実測（2026-08-05）: 5100行の本体の 4861行目に
//    未閉じの文字列を入れても `node --check foo.js` は成功し、`foo.mjs` にすると落ちた。
//    `<script type="module">` の中身は ESM なので、モードとしても .mjs が正しい。
let i = 0, fail = 0;
for (const b of blocks) {
  const tmp = join(here, `.idxcheck_${i}.${b.module ? "mjs" : "js"}`);
  writeFileSync(tmp, b.body);
  try { execSync(`node --check "${tmp}"`, { stdio: "pipe" }); console.log(`  ok   inline script #${i}（${b.start}行目から）`); }
  catch (e) { fail++; console.error(`  FAIL inline script #${i}\n${e.stderr ? e.stderr.toString() : e}`); }
  finally { unlinkSync(tmp); }
  i++;
}

// 切り出しが浅くて本体を素通りしていないか。目印は入口の定義（ファイル終盤にある）。
// これが無いと「PASSしているのに本体は検査されていない」状態に戻る。
if (!blocks.some(b => b.body.includes("window.__koseiBenchmark = {"))) {
  fail++;
  console.error("  FAIL アプリ本体のブロックが検査対象に入っていない（切り出しが浅い）");
} else {
  console.log("  ok   アプリ本体のブロック（入口の定義を含む）を検査した");
}

// 主要な結果確認フローをキーボードと支援技術から利用できる状態に固定する。
const accessibilityChecks = [
  ["指摘カードがフォーカス可能なbutton role", 'data-finding-id="${escapeHtml(f.id)}" role="button" tabindex="0"'],
  ["ページ注記がフォーカス可能なbutton role", 'data-note-id="${escapeHtml(f.id)}" role="button" tabindex="0"'],
  ["Enter/Spaceで指摘を選択", 'event.key !== "Enter" && event.key !== " "'],
  ["校正進捗に専用live region", 'id="autoReviewAnnouncer" class="visually-hidden" role="status" aria-live="polite"'],
  ["進捗告知は状態・完了数・取込状態の変化時だけ", 'if (announcement.key === lastAutoAnnouncementKey) return;'],
  ["toastがlive region", 'id="toast" class="toast" role="status" aria-live="polite"'],
  ["小文字化した数値記号も原文照合できる", 'chooseSourceBackedFragment(finding.maskedQuote, targetCandidates, source)'],
  ["一括校正の中止要求を次段階へ伝搬", 'if (fullRunActive) fullRunCancelRequested = true;'],
  ["中止後に次の巡回へ進まない", 'if (lastAutoJobState?.mode === "cancelled" || fullRunCancelRequested) return;'],
  ["一括校正の中止後に次段階へ進まない", 'if (fullRunCancelRequested || lastAutoJobState?.mode === "cancelled") return;'],
  ["レポート起動はループバックHTTPを使う", "http://127.0.0.1:"],
  ["レポートZIPにローカルサーバーを同梱", '{ name: "report-server.ps1", bytes: encodeUtf8(buildReportServerPs1Text()) }'],
  ["起動CMDは同梱サーバーを開始", 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SERVER%"'],
  ["初回操作を3段階で案内", 'class="workflow-strip" aria-label="校正の流れ"'],
  ["PDF選択と範囲確認を同じ初回画面に配置", 'class="setup-workflow"'],
  ["送信内容の説明を必要時だけ展開", '<details class="send-notice">'],
  ["一時ファイル説明を必要時だけ展開", '<details class="data-retention-note">'],
  ["結果画面は原文を主面に配置", '<div class="viewer-pane">'],
  ["結果画面は指摘を右ペインに配置", '<aside class="findings-pane" aria-label="指摘の確認">'],
  ["選択中の詳細に見出しとラベルがある", '<section id="activeDetail" class="detail selected-detail" aria-labelledby="activeDetailHeading">'],
  ["選択中の詳細を日本語で示す", '<h3 id="activeDetailHeading">選択中の指摘</h3>'],
  ["選択中の詳細は現在位置だけを表示する", 'P.${page}・${sourceLabel}${referenceNote}・${safeText(f.displayCategory || f.category, 80)}'],
  ["回答取込時にcommit直前の選択を保持する", 'const selectedAtCommit = findings.find(f => f.id === activeFindingId) || null'],
  ["代表ID変更時はページとquoteで選択を復元する", 'resolveSelectedFinding(findings, selectedAtCommit?.id, selectionAnchor)'],
  ["選択済みの背景更新ではPDFを再移動しない", 'if (active && !preserveView)'],
  ["背景更新では選択中のPDFソースを自動切替しない", 'if (active && !preserveView) {\n          const nextViewerSource = viewerSourceForFinding(active, viewerSource)'],
  ["対象PDFと比較PDFを切り替えられる", 'id="viewTargetPdfBtn"'],
  ["比較PDFを選択できる", 'id="viewReferencePdfBtn"'],
  ["比較PDFにもページ別quote照合を使う", 'sourceInfo.kind === "reference" ? sourceInfo : null'],
  ["active findingのreferenceFileで比較資料を選ぶ", 'viewerSourceForFinding(active, viewerSource)'],
  ["選択中の簡潔な状態に比較資料名を表示する", '比較資料: ${referenceLabel}'],
  ["比較資料削除時は対象PDFへ即時復帰する", 'referenceSelectionAfterRemoval(referenceList, viewerSource, viewerReferenceId)'],
  ["比較PDFの選択状態を対象PDF表示中も保持する", 'Keep the last comparison selection while viewing TARGET'],
  ["比較タブは手動選択したREFを優先する", 'sourceForComparisonToggle(referenceList, viewerReferenceId, active)'],
  ["Copilotの工程段階を固定表示する", 'const COPILOT_PHASE_LABELS = Object.freeze'],
  ["取込失敗をlive regionで完了扱いしない", 'announcement.kind === "import_error"'],
  ["取込再試行後のlive region状態をキーに含める", 'autoReviewAnnouncementState(st, {'],
  ["指摘一覧に独立した見出しがある", '<section class="findings-list-region" aria-labelledby="findingsListHeading">'],
  ["指摘一覧を日本語で示す", '<h3 id="findingsListHeading">指摘一覧</h3>'],
];
for (const [name, marker] of accessibilityChecks) {
  if (!html.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
if (!findingQuality.includes('normalizedMasked.split(/(⟦#[A-Z]{3}⟧)/gi)')) {
  fail++; console.error("  FAIL 数値記号の照合は大文字小文字を区別しない");
} else console.log("  ok   数値記号の照合は大文字小文字を区別しない");

// 完了通知は表示文の解析ではなく、明示的なレビュー段階で決める。
// phase 1 の done は「続行中」であり、最終 toast/live-region/操作を出してはいけない。
let autoReviewTerminalBehavior;
let autoReviewSkippedRoundDecision;
try {
  const phaseStart = html.indexOf("const AUTO_REVIEW_PHASES");
  const phaseEnd = html.indexOf("let lastAutoAnnouncementKey", phaseStart);
  if (phaseStart < 0 || phaseEnd < 0) throw new Error("レビュー段階の判定ヘルパーが見つかりません");
  const helpers = new Function(
    html.slice(phaseStart, phaseEnd) + "; return { autoReviewTerminalBehavior, autoReviewSkippedRoundDecision };"
  )();
  autoReviewTerminalBehavior = helpers.autoReviewTerminalBehavior;
  autoReviewSkippedRoundDecision = helpers.autoReviewSkippedRoundDecision;
} catch (e) {
  fail++;
  console.error(`  FAIL 完了通知判定ヘルパーを実行できる: ${e.message || e}`);
}
if (autoReviewTerminalBehavior) {
  const behaviorCheck = (name, ok, detail) => {
    if (!ok) { fail++; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); }
    else console.log(`  ok   ${name}`);
  };
  const roundOne = autoReviewTerminalBehavior("done", "full-consistency", { current: 1, total: 2 });
  behaviorCheck("整合性レビュー round 1/2 は文書全体の継続だけ", roundOne.intermediate
    && roundOne.announceContinuation
    && !roundOne.announceCompletion
    && !roundOne.showFinalControls
    && !roundOne.startsPageReview
    && roundOne.continuationMessage === "文書全体の確認を続けています。レビューはまだ終わっていません。",
    JSON.stringify(roundOne));
  const roundTwo = autoReviewTerminalBehavior("done", "full-consistency", { current: 2, total: 2 });
  behaviorCheck("整合性レビュー round 2/2 は次にページ確認と案内する", roundTwo.intermediate
    && roundTwo.announceContinuation
    && !roundTwo.announceCompletion
    && !roundTwo.showFinalControls
    && roundTwo.startsPageReview
    && roundTwo.continuationMessage === "文書全体の確認が終わりました。レビューは続いています。続いてページごとの確認を始めます。",
    JSON.stringify(roundTwo));
  const standaloneConsistencyRoundOne = autoReviewTerminalBehavior("done", "standalone-consistency", { current: 1, total: 2 });
  behaviorCheck("単独の文書全体点検 round 1/2 は完了通知を出さず継続する", standaloneConsistencyRoundOne.intermediate
    && standaloneConsistencyRoundOne.announceContinuation
    && !standaloneConsistencyRoundOne.announceCompletion
    && !standaloneConsistencyRoundOne.showFinalControls
    && !standaloneConsistencyRoundOne.startsPageReview
    && standaloneConsistencyRoundOne.continuationMessage === "文書全体の確認を続けています。レビューはまだ終わっていません。",
    JSON.stringify(standaloneConsistencyRoundOne));
  const standaloneConsistencyRoundTwo = autoReviewTerminalBehavior("done", "standalone-consistency", { current: 2, total: 2 });
  behaviorCheck("単独の文書全体点検 round 2/2 は通常の完了通知を出す", !standaloneConsistencyRoundTwo.intermediate
    && !standaloneConsistencyRoundTwo.announceContinuation
    && standaloneConsistencyRoundTwo.announceCompletion
    && standaloneConsistencyRoundTwo.showFinalControls
    && !standaloneConsistencyRoundTwo.startsPageReview
    && standaloneConsistencyRoundTwo.continuationMessage === "",
    JSON.stringify(standaloneConsistencyRoundTwo));
  const standaloneConsistencyOneRound = autoReviewTerminalBehavior("done", "standalone-consistency", { current: 1, total: 1 });
  behaviorCheck("単独の文書全体点検 round 1/1 は通常の完了通知を出す", !standaloneConsistencyOneRound.intermediate
    && !standaloneConsistencyOneRound.announceContinuation
    && standaloneConsistencyOneRound.announceCompletion
    && standaloneConsistencyOneRound.showFinalControls
    && !standaloneConsistencyOneRound.startsPageReview
    && standaloneConsistencyOneRound.continuationMessage === "",
    JSON.stringify(standaloneConsistencyOneRound));
  const finalPhase = autoReviewTerminalBehavior("done", "full-pages", { current: 2, total: 2 });
  behaviorCheck("full review のページ確認完了は最終通知と操作を出す", finalPhase.announceCompletion
    && finalPhase.showFinalControls
    && !finalPhase.intermediate
    && finalPhase.continuationMessage === "",
    JSON.stringify(finalPhase));
  const standalone = autoReviewTerminalBehavior("done", "standalone");
  behaviorCheck("単独レビューは通常の完了通知を出す", standalone.announceCompletion
    && standalone.showFinalControls
    && !standalone.intermediate
    && standalone.continuationMessage === "",
    JSON.stringify(standalone));
  const running = autoReviewTerminalBehavior("running", "full-consistency", { current: 1, total: 2 });
  behaviorCheck("実行中は完了通知も最終操作も出さない", !running.announceCompletion
    && !running.showFinalControls
    && !running.announceContinuation
    && running.continuationMessage === "",
    JSON.stringify(running));
  behaviorCheck("指摘0件で省略する単独点検は直前の成功ラウンドを最終化する",
    autoReviewSkippedRoundDecision
      && (() => {
        const decision = autoReviewSkippedRoundDecision({ fullRunActive: false, currentRound: 2, lastJobMode: "done" });
        return decision.reclassifyAsFinal
          && decision.finalRound === 1
          && decision.renderFinal
          && decision.announceCompletion;
      })(),
    JSON.stringify(autoReviewSkippedRoundDecision?.({ fullRunActive: false, currentRound: 2, lastJobMode: "done" })));
  behaviorCheck("指摘0件で省略するフルレビューは最終化せず次段階へ残す",
    autoReviewSkippedRoundDecision
      && !autoReviewSkippedRoundDecision({ fullRunActive: true, currentRound: 2, lastJobMode: "done" }).reclassifyAsFinal
      && !autoReviewSkippedRoundDecision({ fullRunActive: true, currentRound: 2, lastJobMode: "done" }).renderFinal
      && !autoReviewSkippedRoundDecision({ fullRunActive: true, currentRound: 2, lastJobMode: "done" }).announceCompletion,
    JSON.stringify(autoReviewSkippedRoundDecision?.({ fullRunActive: true, currentRound: 2, lastJobMode: "done" })));
  behaviorCheck("失敗した直前ラウンドは完了通知へ再分類しない",
    autoReviewSkippedRoundDecision
      && !autoReviewSkippedRoundDecision({ fullRunActive: false, currentRound: 2, lastJobMode: "error" }).reclassifyAsFinal,
    JSON.stringify(autoReviewSkippedRoundDecision?.({ fullRunActive: false, currentRound: 2, lastJobMode: "error" })));
  behaviorCheck("省略分岐の再描画とToastは単独成功判定の後だけ実行する",
    html.includes("if (skipDecision.renderFinal) {")
      && html.includes("renderAutoCard(lastAutoJobState, { note:")
      && html.includes("if (skipDecision.announceCompletion) showToast(\"自動校正が完了しました\")"),
    "省略分岐の最終表示ゲートが見つかりません");
}

// 指摘レポート(HTML)のビューアJSは、index.html の中ではテンプレート文字列の一部なので
// 上の行ベースの抽出には引っかからない（綴じタグがエスケープされている）。
// 出力される実物と同じ形に戻して構文チェックする。ここが壊れるとZIPを開くまで気づけない。
const reportRe = /<script type="module">\n([\s\S]*?)\n<\\\/script>/g;
let r, ri = 0;
while ((r = reportRe.exec(html))) {
  if (/<script[\s>]/.test(r[1])) continue;   // アプリ本体の module ブロックを跨いだ誤マッチを除外
  const src = r[1]
    .replace(/\$\{[^}]*\}/g, "0")      // テンプレート補間 → リテラル
    .replace(/<\\\/script>/g, "</script>");
  const tmp = join(here, `.reportcheck_${ri}.mjs`);
  writeFileSync(tmp, src);
  try { execSync(`node --check "${tmp}"`, { stdio: "pipe" }); console.log(`  ok   report viewer script #${ri}`); }
  catch (e) { fail++; console.error(`  FAIL report viewer script #${ri}\n${e.stderr ? e.stderr.toString() : e}`); }
  finally { unlinkSync(tmp); }
  ri++;
}
if (!ri) { console.error("指摘レポートのビューアJSが見つかりません（テンプレート構造が変わった可能性）"); process.exit(1); }
i += ri;

if (fail) { console.error(`\nTest-IndexHtmlSyntax: FAIL (${fail}/${i} block)`); process.exit(1); }
console.log(`\nTest-IndexHtmlSyntax: PASS (${i} block)`);
