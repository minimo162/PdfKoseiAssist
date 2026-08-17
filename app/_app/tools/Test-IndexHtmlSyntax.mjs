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
  ["headerに価値説明を置く", "誤訳・訳抜け・数値の不整合を、原稿と照らして確認します。"],
  ["初回操作を3段階で案内", 'class="workflow-strip" aria-label="校正の流れ"'],
  ["PDF選択と範囲確認を同じ初回画面に配置", 'class="setup-workflow"'],
  ["デスクトップのStep 1/2カードを同じ高さに揃える", ".setup-workflow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, .86fr); gap: 16px; align-items: stretch;"],
  ["狭い画面ではStep 1/2カードを自然高に戻す", ".setup-workflow { grid-template-columns: 1fr; align-items: start; }"],
  ["送信内容の説明を必要時だけ展開", '<details class="send-notice">'],
  ["一時ファイル説明を必要時だけ展開", '<details class="data-retention-note">'],
  ["結果画面は原文を主面に配置", '<div class="viewer-pane">'],
  ["結果画面は指摘を右ペインに配置", '<aside class="findings-pane" aria-label="指摘の確認">'],
  ["回答取込時にcommit直前の選択を保持する", 'const selectedAtCommit = findings.find(f => f.id === activeFindingId) || null'],
  ["代表ID変更時はページとquoteで選択を復元する", 'resolveSelectedFinding(findings, selectedAtCommit?.id, selectionAnchor)'],
  ["選択済みの背景更新ではPDFを再移動しない", 'if (active && !preserveView)'],
  ["背景更新では選択中のPDFソースを自動切替しない", 'if (active && !preserveView) {\n          const nextViewerSource = viewerSourceForFinding(active, viewerSource)'],
  ["対象PDFと比較PDFを切り替えられる", 'id="viewTargetPdfBtn"'],
  ["比較PDFを選択できる", 'id="viewReferencePdfBtn"'],
  ["比較PDFにもページ別quote照合を使う", 'sourceInfo.kind === "reference" ? sourceInfo : null'],
  ["active findingのreferenceFileで比較資料を選ぶ", 'viewerSourceForFinding(active, viewerSource)'],
  ["比較資料の参照根拠を共有ヘルパーで判定する", "hasReferenceEvidence(active)"],
  ["参照箇所なしの比較タブを対象PDFへ戻す", 'const sourceFellBackToTarget = missingReferenceLocation && viewerSource !== "target"'],
  ["参照箇所なしの比較タブを無効化する", "ref.disabled = !hasReference || !comparisonAllowed"],
  ["参照箇所なしの説明を表示する", "この指摘には比較資料の参照箇所がありません。"],
  ["参照箇所なしのヒントを近くに表示する", 'id="viewerReferenceHint" class="viewer-reference-hint"'],
  ["結果領域に初期状態コンテナを置く", 'id="resultsEmptyState" class="results-empty-state"'],
  ["未読込結果をコンパクトに保つ", 'aria-label="PDF未読込"'],
  ["初期statusは空でhidden", '<div id="status" class="status" role="status" aria-live="polite" hidden></div>'],
  ["setStatusは空文字でstatusを隠す", "els.status.hidden = !text;"],
  ["setStatusはstatus文をtrimする", 'const text = String(message ?? "").trim();'],
  ["送信説明を補助リンク相当にする", ".send-notice, .data-retention-note"],
  ["補助説明は通常時に背景を持たない", "background: transparent;"],
  ["補助説明は小型muted文字にする", "font-size: 12px;"],
  ["補足説明は展開時だけ補足面にする", ".send-notice[open], .data-retention-note[open]"],
  ["補助説明summaryをリンク相当にする", "text-decoration: underline;"],
  ["補助説明のキーボードfocusを保持する", ".send-notice summary:focus-visible, .data-retention-note summary:focus-visible"],
  ["結果ビューワーは初期状態で隠す", 'id="resultsWorkbench" class="results-workbench workbench" hidden'],
  ["結果表示の切替ヘルパーを持つ", "function updateResultsPresentation()"],
  ["結果表示はPDF読込状態で切り替える", "const hasTarget = Boolean(originalPdfBytes && pdfDoc && totalPages)"],
  ["未読込時の結果補助操作を隠す", 'data-results-ready hidden'],
  ["結果補助操作を読込後に切り替える", 'document.querySelectorAll("[data-results-ready]").forEach'],
  ["結果表示は空状態とworkbenchを切り替える", "els.resultsEmptyState.hidden = hasTarget"],
  ["対象PDFを主面として示す", "primary-setup-card"],
  ["比較資料を補助面として示す", "secondary-setup-card"],
  ["開始操作を主CTAとして示す", "primary-cta"],
  ["対象PDFの案内を短く保つ", "クリックまたはドラッグ＆ドロップで選択。"],
  ["比較資料を任意の補助入力として示す", "比較資料PDFを追加（任意）"],
  ["ページ範囲の初期案内を短く保つ", "PDF全体が初期選択されます。"],
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

const mainAppMarkup = html.slice(0, html.indexOf("<script"));
const mainStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
for (const [name, marker] of [
  ["メイン画面の背景gradientを再追加しない", /(?:background-image\s*:|(?:radial|linear|repeating-radial|repeating-linear)-gradient\s*\()/i],
  ["メイン画面の背景patternを再追加しない", /pattern\s*\(/i],
]) {
  if (marker.test(mainStyle)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
for (const [name, marker] of [
  ["冗長な範囲説明を常時DOMに残さない", "開始後は、資料の分割からCopilotへの依頼・結果の取り込みまで自動で進みます。"],
  ["冗長なCTA説明を常時DOMに残さない", "文書全体の食い違いを探してから、ページごとに詳しく確認します。"],
  ["冗長な比較資料説明を常時DOMに残さない", "日本語版（原稿）のPDFを追加すると、訳抜け・数値違いを突き合わせて確かめられます。"],
  ["冗長な結果空状態説明を常時DOMに残さない", "PDFを読み込むと、ここに原文と指摘が表示されます。"],
  ["冗長な要確認説明を常時DOMに残さない", "誤指摘の可能性があるものも自動削除せず、理由付きの「要確認」として残します。"],
  ["結果上部に要確認説明を重ねない", "要確認の指摘も理由付きで残します。"],
]) {
  if (mainAppMarkup.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
for (const [name, marker] of [
  ["headerの手順言い換えを常時DOMに残さない", "英訳したPDFと日本語の原稿PDFを選び、開始ボタンを押すだけで指摘レポートができます。"],
  ["初期PDF待ち案内を常時DOMに残さない", "はじめにPDFを置いてください。"],
  ["PDF読込成功案内を成功コードに残さない", "読み込みました（${totalPages}ページ）。範囲を確認して「校正を開始」を押してください。"],
  ["比較資料読込成功案内を成功コードに残さない", "比較資料を${referenceList.length}件読み込みました。"],
  ["比較資料解除案内を成功コードに残さない", "比較資料を外しました。単体校正の元PDF保持パケットZIPを作成します。"],
  ["結果0件案内を常時DOMや成功コードに残さない", "まだ指摘はありません"],
  ["結果取込待ち案内を常時DOMに残さない", "Copilotの指摘を取り込むと、ここに一覧が出ます。"],
]) {
  if (html.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
const forbiddenMainPanelMarkers = [
  ["メイン画面のactiveDetailパネルを再追加しない", 'id="activeDetail"'],
  ["メイン画面のactiveDetail見出しを再追加しない", 'id="activeDetailHeading"'],
  ["メイン画面のactiveDetail本文を再追加しない", 'id="activeDetailContent"'],
  ["メイン画面の選択中の指摘見出しを再追加しない", "選択中の指摘"],
];
for (const [name, marker] of forbiddenMainPanelMarkers) {
  if (mainAppMarkup.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
for (const [name, marker] of [
  ["メイン画面のactiveDetailバインディングを再追加しない", 'activeDetail: document.getElementById('],
  ["メイン画面のrenderDetailヘルパーを再追加しない", "function renderDetail("],
  ["メイン画面のrenderDetail呼び出しを再追加しない", "renderDetail("],
]) {
  if (html.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
for (const [name, marker] of [
  ["指摘カードのactive stylingを保持する", 'class="finding-card ${f.id === activeFindingId ? "active" : ""}"'],
  ["ページ注記のactive stylingを保持する", 'class="page-note ${f.id === activeFindingId ? "active" : ""}"'],
]) {
  if (!html.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
const ariaCurrentMarker = 'aria-current="${f.id === activeFindingId ? "true" : "false"}"';
const ariaCurrentCount = html.split(ariaCurrentMarker).length - 1;
if (ariaCurrentCount < 2) { fail++; console.error("  FAIL 指摘カードとページ注記のaria-currentを保持する"); }
else console.log("  ok   指摘カードとページ注記のaria-currentを保持する");
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
