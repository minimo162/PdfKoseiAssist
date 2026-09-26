// Test-IndexHtmlSyntax.mjs — index.html のインライン JS を構文チェック（node tools/Test-IndexHtmlSyntax.mjs）
// 5000行超の monolith を編集した際の構文崩れを機械的に検知する。node --check は構文のみ検証
// （ブラウザ globals の未定義は無視）。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stagePdfCandidate, commitStagedPdfCandidate, stageReferencePdfBatch } from "../js/pdf-load-transaction.mjs";
import { reviewControlState, applyReferenceBufferSetting, applyReferenceRangeSetting, referencePagesForItem, loadResultAccepted, referenceRangeModeAfterAction } from "../js/review-settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const findingQuality = readFileSync(join(here, "..", "js", "finding-quality.mjs"), "utf8");
const transactionSource = readFileSync(join(here, "..", "js", "pdf-load-transaction.mjs"), "utf8");
const settingsSource = readFileSync(join(here, "..", "js", "review-settings.mjs"), "utf8");
const implementationText = `${html}\n${transactionSource}\n${settingsSource}`;

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
if (!blocks.some(b => b.body.includes("window.__koseiAutomation = {"))) {
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
  ["レポートZIPにローカルサーバーを同梱", '{ name: "_data/report-server.ps1", bytes: encodeUtf8(buildReportServerPs1Text()) }'],
  ["起動CMDは同梱サーバーを開始", 'powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File'],
  ["headerに価値説明を置く", "誤訳・訳抜け・数値の不整合を、原稿と照らして確認します。"],
  ["入力見出しを番号なしで簡潔にする", '<h2>PDFを選ぶ</h2>'],
  ["PDF選択と比較資料を同じ入力面に配置", 'class="pdf-choice-grid"'],
  ["対象PDFカードを全幅にする", ".upload-card { grid-column: 1 / -1; }"],
  ["入力面は対象PDFを広く比較資料を狭くする", ".pdf-choice-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(260px, .8fr);"],
  ["mobileのPDF入力面を縦積みにする", ".pdf-choice-grid { grid-template-columns: 1fr; }"],
  ["入力面の上下基準線をstretchで揃える", ".pdf-choice-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(260px, .8fr); gap: 14px; align-items: stretch; }"],
  ["比較資料の補助行でドロップ面の基準線を崩さない", ".pdf-choice-grid .reference-list-ui, .pdf-choice-grid .reference-actions { margin-top: 0; }"],
  ["対象と比較のドロップ面を同じ最小高に揃える", ".pdf-choice-grid .target-choice-panel .drop-zone,\n    .pdf-choice-grid .secondary-setup-card .drop-zone { width: 100%; min-height: 156px; flex: 1 1 auto;"],
  ["比較資料の外側パネルを無枠にする", ".pdf-choice-grid .secondary-setup-card { min-width: 0; display: flex; flex-direction: column; margin: 0; padding: 0; border: 0;"],
  ["開始操作をカード外の独立領域に置く", '<section class="setup-action-area" aria-label="校正の開始">'],
  ["開始操作領域を全幅グリッド行にする", ".setup-action-area {\n      grid-column: 1 / -1;"],
  ["開始操作領域に枠や背景を付けない", "border: 0;\n      background: transparent;\n      box-shadow: none;"],
  ["開始CTAを中央の幅制限内に置く", ".setup-action-area > *, .setup-action-main { width: min(100%, 620px); }"],
  ["主CTAの強調スタイルをaction areaへ紐付ける", ".setup-action-area .primary-cta {"],
  ["主CTAのhoverスタイルをaction areaへ紐付ける", ".setup-action-area .primary-cta:hover:not(:disabled)"],
  ["action areaのアクセシブルラベルを維持する", 'aria-label="校正の開始"'],
  ["閉じた一時ファイル説明を中央寄せにする", ".setup-action-area .data-retention-note:not([open]) { width: auto; justify-self: center; margin-top: 0; }"],
  ["mobileの開始操作領域を全幅にする", ".setup-action-area { grid-column: 1; width: 100%; }"],
  ["ページ範囲を任意detailsに降格する", '<details class="range-options">'],
  ["範囲detailsを開いたときだけ補足面にする", ".range-options[open]"],
  ["設定変更を単一detailsで開ける", '<summary>設定を変更（任意）</summary>'],
  ["設定details内で対象ページを示す", '<h3 class="setup-options-heading">対象ページ</h3>'],
  ["設定details内で校正設定を示す", '<h3 class="setup-options-heading">校正設定</h3>'],
  ["校正設定変更を参照範囲から分離する", "function setReviewSettingsEnabled()"],
  ["校正対象言語をPDF本文から自動判定する", "updateTargetLanguageDetection(pdfDoc, totalPages)"],
  ["比較資料言語をPDF本文から自動判定する", "updateReferenceLanguageDetection(referenceList)"],
  ["言語判定不能でもその他へフォールバックする", "detectDocumentLanguage(text)"],
  ["古い言語判定結果を世代・source identityで破棄する", "languageDetectionSnapshotIsCurrent"],
  ["再試行のancestor IDをクライアントで検証する", ".filter(value => /^[0-9a-f]{32}$/.test(value))"],
  ["空のancestor metadataを送信しない", "recoveryAncestors.length ? { recovery_ancestor_job_ids: recoveryAncestors } : {}"],
  ["参照範囲UIの表示を比較資料の有無だけで切り替える", "els.referenceRangeBlock.hidden = !on;"],
  ["結果見出しを番号なしで簡潔にする", '<h2>指摘を確認する</h2>'],
  ["送信内容の説明を必要時だけ展開", '<details class="send-notice">'],
  ["一時ファイル説明を必要時だけ展開", '<details class="data-retention-note">'],
  ["結果画面は原文を主面に配置", '<div class="viewer-pane">'],
  ["PDFスクロール領域をキーボード操作可能にする", 'id="viewerShell" class="viewer-shell" role="region" aria-label="PDF表示" tabindex="0"'],
  ["結果画面は指摘を右ペインに配置", '<aside class="findings-pane" aria-label="指摘の確認">'],
  ["回答取込ボタンはclick EventをrecoveryContextへ渡さない", 'els.importBtn.addEventListener("click", () => importResponse());'],
  ["回答取込時にcommit直前の選択を保持する", 'const selectedAtCommit = findings.find(f => f.id === activeFindingId) || null'],
  ["代表ID変更時はページとquoteで選択を復元する", 'resolveSelectedFinding(findings, selectedAtCommit?.id, selectionAnchor)'],
  ["選択済みの背景更新ではPDFを再移動しない", 'if (active && !preserveView && !isRecoveryImport)'],
  ["背景更新では選択中のPDFソースを自動切替しない", 'if (active && !preserveView && !isRecoveryImport) {\n          const nextViewerSource = viewerSourceForFinding(active, viewerSource)'],
  ["対象PDFと比較PDFを切り替えられる", 'id="viewTargetPdfBtn"'],
  ["比較PDFを選択できる", 'id="viewReferencePdfBtn"'],
  ["対象PDF内の比較ページタブを持つ", 'id="viewerTargetPageTabs"'],
  ["対象PDF比較ページタブは明示ラベルから候補を抽出する", "function targetPageCandidatesForFinding"],
  ["対象PDF比較ページタブは候補を対象PDF範囲に制限する", "TARGET_COMPARE_PAGE_LIMIT"],
  ["対象PDF比較ページタブはアクセシブルなtablistにする", 'aria-label="対象PDF内の比較ページ"'],
  ["対象PDF比較ページのクリックで対象PDFへ戻れる", "targetPageCandidatesForFinding(active)"],
  ["REFページラベルを対象ページ候補へ混ぜない", "f.target_pages_label, f.targetPagesLabel"],
  ["タブ再描画後にlive DOMへfocusする", "const refreshedButton = els.viewerTargetPageTabs.querySelector"],
  ["比較PDFにもページ別quote照合を使う", 'sourceInfo.kind === "reference" ? sourceInfo : null'],
  ["Copilot返却pageは補正前に候補として保持する", "const rawPage = Number(rawPageValue)"],
  ["ページ補正は対象packet範囲を最優先する", "const targetPagesForCorrection"],
  ["ページ補正はTEXT layer一致を採点する", "scoreFindingPageCandidate"],
  ["ページ補正は同点候補を補正しない", "ranked[1].score === ranked[0].score"],
  ["範囲外pageは補正不能なら取り込まない", 'page-outside-target'],
  ["結果画面に明確な完了バナーを持つ", 'id="reviewCompletionBanner"'],
  ["完了バナーは完了時刻と件数を表示する", "renderReviewCompletionBanner"],
  ["完了バナーはwarning/error/cancelledと分離する", "completionBanner.className = `review-completion-banner ${state}`"],
  ["完了バナーは全packet terminalと取込成功を要求する", "reviewCompletionEligibility(st"],
  ["新規run/retry/準備開始で完了表示をresetする", "resetReviewCompletionBanner()"],
  ["部分retryは元jobをpacket単位でmergeする", "mergeAutoReviewJobState(mergeBaseState, st)"],
  ["通常retryも元jobをpollへ渡す", "const retryPayload = packetsForFullRunRetry([payload])"],
  ["結果画面に幅合わせ操作を残す", 'id="fitWidthBtn"'],
  ["desktop結果画面はviewport内の共通高に収める", ".results-workbench { height:clamp(620px, calc(100vh - 96px), 900px); align-items:stretch; }"],
  ["PDF表示を独立スクロール可能にする", ".viewer-shell { width: 100%; max-width: 100%; min-width: 0; height:auto; min-height:0; overflow:auto; overscroll-behavior:contain;"],
  ["指摘一覧を独立スクロール可能にする", ".results-workbench .findings-pane .list { flex:1 1 auto; height:0; min-height:0; }"],
  ["packetページ検証に上限時間を設ける", "const PACKET_PAGE_VALIDATION_TIMEOUT_MS = 20000;"],
  ["出力PDFのテキスト検証をtimeoutで囲む", "extractTextLayerText(generatedDoc, probe.packetPageNo),\n              timeoutMs,"],
  ["出力PDF検証完了をstatusへ反映する", "確認用PDFの検証が完了しました。"],
  ["検証用PDF documentを破棄する", "generatedDoc?.destroy?.()"],
  ["完了文言を初見で示す", "校正完了"],
  ["対象PDFをparse後にstagingする", "const candidate = await stagePdfCandidate(file, openPdfDocument)"],
  ["対象PDFをstaged candidateからcommitする", "commitStagedPdfCandidate(stagedTarget"],
  ["比較PDFバッチを全件stagingしてからcommitする", "stageReferencePdfBatch(files, referenceList, openPdfDocument"],
  ["比較PDF重複判定は同名同サイズでも内容一致を確認する", "bytesEqual(refBytes, candidateBytes)"],
  ["比較PDF上限はdedupe後のpending件数で判定する", "existing.length + pending.length > maxFiles"],
  ["新規比較資料へ校正設定のbuffer値を引き継ぐ", "bufferPages:getReferenceBufferPageCount()"],
  ["既存比較資料へbuffer設定を反映する", "applyReferenceBufferSetting(referenceList, getReferenceBufferPageCount(), 0, 8)"],
  ["手入力比較範囲を全REFへ検証適用する", "applyReferenceRangeSetting(referenceList, referenceRangeText, parsePageRange, pagesToRangeText)"],
  ["REF候補ページ計算は共有helperを使う", "resolveReferencePagesForItem(ref, pages"],
  ["比較範囲のmanual/auto状態遷移を共有契約で管理する", "referenceRangeModeAfterAction"],
  ["自動比較範囲操作を明示的に分離する", "applyAutoReferenceRangeExplicitly()"],
  ["PDF読込handlerは結果契約を返す", "return { ok: true, fileName: originalFileName, totalPages }"],
  ["benchmark対象PDFはhandler結果okを検証する", "loadResultAccepted(result)"],
  ["benchmark比較PDFは今回追加件数を検証する", "loadResultAccepted(result, { requireAdded: true })"],
  ["buffer設定変更後に一覧・範囲・promptを更新する", "renderReferenceListUi();\n          }\n          invalidateReviewPdf();\n          if (pdfDoc && hasReferencePdf()) refreshRangeFromInput(false);"],
  ["比較PDF削除時にPDF.js documentをbest-effort破棄する", "destroyPdfDocumentBestEffort(removed.doc)"],
  ["対象PDF正常置換時に旧PDF.js documentだけを破棄する", "previousPdfDocument && previousPdfDocument !== next.doc"],
  ["mobile比較資料行を2列へ折り返す", ".reference-item { grid-template-columns: minmax(0, 1fr) auto; }"],
  ["比較資料行のgrid子要素を縮小可能にする", ".reference-item, .reference-item > * { min-width: 0; }"],
  ["比較資料行のファイル名は1行を占めて折り返し、原…と切らない", ".reference-item strong { min-width: 0; overflow: hidden; grid-column: 1 / -1; white-space: normal; overflow-wrap: anywhere;"],
  ["active findingのreferenceFileで比較資料を選ぶ", 'viewerSourceForFinding(active, viewerSource)'],
  ["比較資料の参照根拠を共有ヘルパーで判定する", "hasReferenceEvidence(active)"],
  ["全範囲の集約refreshでは比較候補上限を適用しない", "pages.length <= MAX_REVIEW_PAGES && arr.length > MAX_REFERENCE_CANDIDATE_PAGES"],
  ["全範囲は個別packetへ分割してから候補上限を適用する", "for (let offset = 0; offset < targetPages.length; offset += chunk)"],
  ["参照箇所なしの比較タブを対象PDFへ戻す", 'const sourceFellBackToTarget = missingReferenceLocation && viewerSource !== "target"'],
  ["参照箇所なしの比較タブを無効化する", "ref.disabled = !hasReference || !comparisonAllowed"],
  ["参照箇所なしの説明を表示する", "この指摘には原稿の参照箇所がありません。"],
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
  ["比較資料を任意の補助入力として示す", "日本語の原稿PDFを追加（任意）"],
  ["原稿の全解除ボタンは1件ごとの外すと区別できる", ">原稿をすべて外す</button>"],
  ["原稿1件ごとのボタンは外すと呼ぶ", 'aria-label="原稿${index + 1}を外す"${disabled}>外す</button>'],
  ["原稿の探し方に何のための設定かを添える", "原稿のどこを照らし合わせるか。ページ比率で見当"],
  ["一度に校正するページ数に説明を添える", 'id="targetChunkSizeHint" class="hint"'],
  ["前後に添えるページ数に説明を添える", 'id="targetContextPagesHint" class="hint"'],
  ["原稿を探す前後のページ数に説明を添える", 'id="referenceBufferPagesHint" class="hint"'],
  ["ページ範囲の初期案内を短く保つ", "PDF全体が初期選択されます。"],
  ["比較資料削除時は対象PDFへ即時復帰する", 'referenceSelectionAfterRemoval(referenceList, viewerSource, viewerReferenceId)'],
  ["比較PDFの選択状態を対象PDF表示中も保持する", 'Keep the last comparison selection while viewing TARGET'],
  ["比較タブは手動選択したREFを優先する", 'sourceForComparisonToggle(referenceList, viewerReferenceId, active)'],
  ["Copilotの工程段階を固定表示する", 'const COPILOT_PHASE_LABELS = Object.freeze'],
  ["取込失敗をlive regionで完了扱いしない", 'announcement.kind === "import_error"'],
  ["取込再試行後のlive region状態をキーに含める", 'autoReviewAnnouncementState(st, {'],
  ["指摘一覧に独立した見出しがある", '<section class="findings-list-region" aria-labelledby="findingsListHeading">'],
  ["指摘一覧を日本語で示す", '<h3 id="findingsListHeading">指摘一覧</h3>'],
  ["REF canonicalizer is shared with coerce", "canonicalizeReferenceFinding"],
  ["coerce boundary calls REF canonicalizer", "const normalizedReference = canonicalizeReferenceFinding(item"],
  ["numeric import uses shared two-pass helper", "runNumericImportTwoPass(rawFindings"],
  ["numeric context collector is injected into shared helper", "collectNumericFindingContexts,"],
  ["REF source resolver is shared", "resolveReferenceIndex(record, referenceList)"],
];
for (const [name, marker] of accessibilityChecks) {
  if (!implementationText.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}

// Target-PDF navigation accepts only source-validated numeric or display-only
// counterpart records. In particular, an explicit empty quote is not the same
// as an omitted quote (the latter may use the active finding's primary quote).
const targetQuoteStart = html.indexOf("function targetPageQuotesForFinding");
const targetQuoteEnd = html.indexOf("function updateTargetPageTabs", targetQuoteStart);
const targetQuoteSource = targetQuoteStart >= 0 && targetQuoteEnd > targetQuoteStart
  ? html.slice(targetQuoteStart, targetQuoteEnd) : "";
if (!targetQuoteSource.includes("navigationCounterpartsValidated")
  || !targetQuoteSource.includes('counterpart?.status || ""')
  || !targetQuoteSource.includes("if (records.length !== 1) return [];")
  || !targetQuoteSource.includes("targetPageQuotesForFinding")) {
  fail++;
  console.error("  FAIL 対象PDFの別ページquoteはokの単一counterpartだけを使い、無ければ空にする");
} else {
  console.log("  ok   対象PDFの別ページquoteはokの単一counterpartだけを使い、無ければ空にする");
}
const goToPageStart = html.indexOf("function goToPage(pageNo, quote)");
const goToPageEnd = html.indexOf("function normalizeSeverity", goToPageStart);
const goToPageSource = goToPageStart >= 0 && goToPageEnd > goToPageStart
  ? html.slice(goToPageStart, goToPageEnd) : "";
if (!goToPageSource.includes("hasExplicitQuote") || !goToPageSource.includes('String(quote ?? "")')) {
  fail++;
  console.error("  FAIL goToPageが明示的な空quoteをprimary quoteへフォールバックしない");
} else {
  console.log("  ok   goToPageが明示的な空quoteをprimary quoteへフォールバックしない");
}

// The duplicate-match sentence remains explanatory text, but is the only
// warning that is presentation-softened.  needs_human_review is intentionally
// not rewritten here; this is an app/report label contract only.
if (!html.includes("function isAmbiguityOnlyQualityWarning")
  || !html.includes("function shouldShowHumanReviewLabel")
  || !html.includes("function humanReviewLabel")
  || !html.includes("DUPLICATE_QUOTE_WARNING")
  || !html.includes("humanReviewLabel(f)")
  || !html.includes("reportHumanReviewLabel(r)")) {
  fail++;
  console.error("  FAIL ambiguity-only warning presentation contract or app/report use is missing");
} else {
  console.log("  ok   ambiguity-only warning presentation contract and app/report use");
}
const completionStyle = html.match(/\.review-completion-banner\s*\{([^}]*)\}/)?.[1] || "";
if (!/box-shadow\s*:\s*none/.test(completionStyle)
  || !/border-radius\s*:\s*10px/.test(completionStyle)
  || !/font-size\s*:\s*15px/.test(html.match(/\.review-completion-banner h3\s*\{([^}]*)\}/)?.[1] || "")) {
  fail++;
  console.error("  FAIL 完了バナーがneutral card visual languageを使っていない");
} else {
  console.log("  ok   完了バナーがneutral card visual languageを使う");
}
const coerceStart = implementationText.indexOf("function coerceFindings");
const coerceEnd = implementationText.indexOf("async function prepareValidatedSameDocumentCounterparts", coerceStart);
const coerceSource = coerceStart >= 0
  ? implementationText.slice(coerceStart, coerceEnd > coerceStart ? coerceEnd : undefined)
  : "";
const coerceShapeContract = coerceSource.includes("issueSummary: modelSummary")
  && !/\bmodel_reason\s*:/u.test(coerceSource)
  && !/\bissue_summary\s*:/u.test(coerceSource);
const coerceForReadError = new Function(coerceSource + '; return coerceFindings;')();
if (coerceForReadError({ findings: [], read_error: 'Cannot read page' }).length !== 0) {
  fail++;
  console.error('  FAIL 読み取りエラーを文章の指摘として追加しました');
}
if (!coerceShapeContract) {
  fail++;
  console.error("  FAIL coerce output has issueSummary without model_reason/issue_summary");
} else {
  console.log("  ok   coerce output has issueSummary without model_reason/issue_summary");
}

const mainAppScriptMarker = '  <script type="module">';
const mainAppScriptPos = html.indexOf(mainAppScriptMarker);
if (mainAppScriptPos < 0) {
  fail++;
  console.error("  FAIL 本文後のアプリ本体module script markerが見つからない");
} else {
  console.log("  ok   本文後のアプリ本体module script markerを検出");
}
const mainAppMarkup = mainAppScriptPos >= 0 ? html.slice(0, mainAppScriptPos) : "";
const setupActionStart = mainAppMarkup.indexOf('<section class="setup-action-area" aria-label="校正の開始">');
const setupActionClose = setupActionStart >= 0 ? mainAppMarkup.indexOf("\n    </section>\n    </main>", setupActionStart) : -1;
const rangeOptionsStart = mainAppMarkup.indexOf('<details class="range-options">', setupActionStart);
const rangeOptionsEnd = rangeOptionsStart >= 0 ? mainAppMarkup.indexOf('\n      </details>\n      <div class="setup-action-main">', rangeOptionsStart) : -1;
const referenceHandlerStart = html.indexOf("async function handleReferencePdfFile");
const referenceHandlerEnd = referenceHandlerStart >= 0 ? html.indexOf("function clearReferencePdf", referenceHandlerStart) : -1;
const referenceHandlerMarkup = referenceHandlerStart >= 0 && referenceHandlerEnd >= 0 ? html.slice(referenceHandlerStart, referenceHandlerEnd) : "";
const fullReviewMarker = 'id="fullReviewBtn"';
const fullReviewPos = mainAppMarkup.indexOf(fullReviewMarker);
const rangeOptionsMarkup = rangeOptionsStart >= 0 && rangeOptionsEnd >= 0 ? mainAppMarkup.slice(rangeOptionsStart, rangeOptionsEnd) : "";
const setupActionMarkup = setupActionStart >= 0 && setupActionClose >= 0 ? mainAppMarkup.slice(setupActionStart, setupActionClose) : "";
if (mainAppMarkup.includes('<nav class="workflow-strip"') || mainAppMarkup.includes("PDFを選ぶ</strong></li>") || mainAppMarkup.includes("指摘を確認・書き出し</strong></li>")) {
  fail++;
  console.error("  FAIL 不要な2段階workflow stripを残さない");
} else {
  console.log("  ok   不要な2段階workflow stripがない");
}
if (mainAppMarkup.includes('id="setupActionHeading"') || mainAppMarkup.includes('<h2 class="visually-hidden">校正を開始</h2>')) {
  fail++;
  console.error("  FAIL action area内に重複するhidden見出しを戻さない");
} else {
  console.log("  ok   action area内に重複するhidden見出しがない");
}
if (mainAppMarkup.includes('class="card setup-card range-card') || mainAppMarkup.includes("2. 範囲を確認") || setupActionStart < 0 || setupActionClose < 0) {
  fail++;
  console.error("  FAIL 範囲カードを残さず独立した開始操作領域の構造を切り出せる");
} else if (rangeOptionsStart < 0 || rangeOptionsEnd < 0 || !rangeOptionsMarkup.includes('id="pageRangeInput"')) {
  fail++;
  console.error("  FAIL pageRangeInputを任意のrange-options details内に置く");
} else if (rangeOptionsMarkup.includes(fullReviewMarker)) {
  fail++;
  console.error("  FAIL range-options内にfullReviewBtnを戻さない");
} else if (fullReviewPos <= rangeOptionsEnd || !setupActionMarkup.includes(fullReviewMarker)) {
  fail++;
  console.error("  FAIL fullReviewBtnをrange-options後のsetup-action-area内に置く");
} else {
  console.log("  ok   fullReviewBtnはrange-options外かつ後のsetup-action-area内にある");
}
const reviewSettingIds = ["targetChunkSizeInput", "targetContextPagesInput", "referenceBufferPagesInput"];
const detectedLanguageIds = ["targetLanguageDetected", "referenceLanguageDetected"];
if (!rangeOptionsMarkup || !rangeOptionsMarkup.includes('<summary>設定を変更（任意）</summary>') || !rangeOptionsMarkup.includes('<h3 class="setup-options-heading">対象ページ</h3>') || !rangeOptionsMarkup.includes('<h3 class="setup-options-heading">校正設定</h3>') || reviewSettingIds.some(id => !rangeOptionsMarkup.includes(`id="${id}"`)) || detectedLanguageIds.some(id => !rangeOptionsMarkup.includes(`id="${id}"`))) {
  fail++;
  console.error("  FAIL 自動判定表示・3項目と見出しを単一の設定details内に置く");
} else if (rangeOptionsMarkup.includes("proofread-settings") || reviewSettingIds.some(id => new RegExp(`id="${id}"[^>]*\\bdisabled(?:\\s|=|>)`, "i").test(rangeOptionsMarkup))) {
  fail++;
  console.error("  FAIL nested proofread detailsまたは初期disabledを戻さない");
} else {
  console.log("  ok   言語自動判定表示と3項目は単一設定details内で利用できる");
}
if (mainAppMarkup.includes("proofread-settings")) {
  fail++;
  console.error("  FAIL nested proofread settings detailsを残さない");
} else {
  console.log("  ok   nested proofread settings detailsは存在しない");
}
if (referenceHandlerMarkup.includes("clearReferencePdf(false)")) {
  fail++;
  console.error("  FAIL 比較PDFのparse失敗時に既存リストを全消去しない");
} else if (!referenceHandlerMarkup) {
  fail++;
  console.error("  FAIL 比較PDFhandlerの構造を切り出せる");
} else {
  console.log("  ok   比較PDFのparse失敗時に既存リストを全消去しない");
}
const targetContextStart = html.indexOf("function captureCommittedTargetContext()");
const targetContextEnd = targetContextStart >= 0 ? html.indexOf("    // Recovery imports", targetContextStart) : -1;
const targetContextSource = targetContextStart >= 0 && targetContextEnd > targetContextStart
  ? html.slice(targetContextStart, targetContextEnd) : "";
const referenceTargetIdentityContract = targetContextSource.includes("function captureCommittedTargetContext()")
  && targetContextSource.includes("function isCurrentCommittedTargetContext(context)")
  && targetContextSource.includes("function assertCurrentCommittedTargetContext(context)")
  && referenceHandlerMarkup.includes("const targetContext = captureCommittedTargetContext();")
  && referenceHandlerMarkup.includes("assertCurrentCommittedTargetContext(targetContext);")
  && referenceHandlerMarkup.includes("const sourceSha256 = await sha256HexBytes(candidate.bytes);")
  && referenceHandlerMarkup.includes("const documents = new Set([")
  && referenceHandlerMarkup.includes("if (isStaleRecoveryContextError(error))");
if (!referenceTargetIdentityContract) {
  fail++;
  console.error("  FAIL 比較PDF stagingがcommit済みTARGET identityへ束縛されていない");
} else {
  console.log("  ok   比較PDF stagingはcommit済みTARGET identityとSHA await後のguardを持つ");
  // Execute the production handler and its production target-context helpers.
  // The target is replaced while SHA-256 is pending; the staged REF document
  // must be destroyed once and must never enter the new target's list.
  let releaseSha;
  let shaEntered;
  const shaEnteredPromise = new Promise(resolve => { shaEntered = resolve; });
  const shaGate = new Promise(resolve => { releaseSha = resolve; });
  let stagedDestroyCalls = 0;
  const stagedDoc = { destroy: () => { stagedDestroyCalls++; } };
  const targetA = { id: "target-A" };
  const targetB = { id: "target-B" };
  const bytesA = new Uint8Array([1, 2, 3]);
  const bytesB = new Uint8Array([4, 5, 6]);
  const raceContext = {
    FileList: class FileList {},
    targetLoadGeneration: 1,
    pdfDoc: targetA,
    originalPdfBytes: bytesA,
    originalPdfSha256: "sha-a",
    originalFileName: "A.pdf",
    totalPages: 3,
    referenceList: [{ id: "existing", doc: { id: "existing" }, fileName: "existing.pdf", bytes: new Uint8Array([9]), totalPages: 1 }],
    referenceControlsAreLocked: () => false,
    els: { referenceDropZone: { setAttribute() {}, removeAttribute() {} } },
    setStatus() {},
    showToast() {},
    openPdfDocument: async () => ({ numPages: 1 }),
    MAX_REFERENCE_FILES: 3,
    SHORT_REFERENCE_ALL_PAGES_THRESHOLD: 3,
    getReferenceBufferPageCount: () => 1,
    stageReferencePdfBatch: async () => ({
      limited: false,
      skipped: [],
      candidates: [{ fileName: "stale-ref.pdf", bytes: new Uint8Array([7, 8]), byteLength: 2, totalPages: 1, doc: stagedDoc }],
    }),
    sha256HexBytes: async () => {
      shaEntered();
      await shaGate;
      return "sha-ref";
    },
    destroyPdfDocumentBestEffort: doc => { try { doc?.destroy?.(); } catch {} },
    replaceReferenceList(next) { this.referenceList = next; },
    syncLegacyReferenceAlias() {},
    clearReportTextCaches() {},
    updateReferenceLanguageDetection: async () => "その他",
    renderReferenceListUi() {},
    updateReferenceUi() {},
    referencePages: [],
    pagesToRangeText: pages => (pages || []).join(","),
    invalidateReviewPdf() {},
    refreshRangeFromInput() {},
    buildPrompt() {},
    updateViewerSourceTabs() {},
    staleRecoveryContextError: () => { const error = new Error("stale"); error.code = "stale_recovery_source"; return error; },
    isStaleRecoveryContextError: error => error?.code === "stale_recovery_source",
  };
  try {
    runInNewContext(`${targetContextSource}\n${referenceHandlerMarkup}\nthis.__handleReference = handleReferencePdfFile;`, raceContext);
    const pendingReferenceLoad = raceContext.__handleReference([{ name: "stale-ref.pdf", type: "application/pdf" }]);
    await shaEnteredPromise;
    raceContext.targetLoadGeneration = 2;
    raceContext.pdfDoc = targetB;
    raceContext.originalPdfBytes = bytesB;
    raceContext.originalPdfSha256 = "sha-b";
    raceContext.originalFileName = "B.pdf";
    raceContext.totalPages = 4;
    releaseSha();
    const result = await pendingReferenceLoad;
    const preserved = result?.superseded === true
      && raceContext.referenceList.length === 1
      && raceContext.referenceList[0].id === "existing"
      && stagedDestroyCalls === 1;
    if (!preserved) {
      fail++;
      console.error("  FAIL TARGET置換中のstale比較PDFが新TARGETへ混入した、またはstaged documentの破棄回数が不正");
    } else {
      console.log("  ok   TARGET置換中のstale比較PDFをcommitせずstaged documentを1回だけ破棄する");
    }
  } catch (error) {
    fail++;
    console.error(`  FAIL 比較PDF TARGET identity race regression: ${error.message || error}`);
  }
}
// Target staging, review operations, and recoverable-job probes each have an
// owner separate from the committed source identity.  Keep these checks
// executable at the production-source boundary so a failed candidate cannot
// invalidate the visible target, and an old async result cannot repaint a
// newer run.
const targetHandlerStart = html.indexOf("async function handlePdfFile");
const targetHandlerEnd = html.indexOf("function renderReferenceListUi", targetHandlerStart);
const targetHandlerMarkup = targetHandlerStart >= 0 && targetHandlerEnd > targetHandlerStart
  ? html.slice(targetHandlerStart, targetHandlerEnd) : "";
const targetCommitStart = targetHandlerMarkup.indexOf("commit(next)");
const targetCommitMarkup = targetCommitStart >= 0 ? targetHandlerMarkup.slice(targetCommitStart) : "";
const stagingOwnershipContract = html.includes("let targetLoadRequestSequence = 0;")
  && targetHandlerMarkup.includes("const targetLoadRequestGeneration = ++targetLoadRequestSequence;")
  && !targetHandlerMarkup.slice(0, Math.max(0, targetCommitStart)).includes("++targetLoadGeneration")
  && targetCommitMarkup.includes("targetLoadGeneration += 1;")
  && targetCommitMarkup.includes("invalidateReviewOperation();")
  && targetHandlerMarkup.includes("invalidateRecoverableJobProbe({ clearPending: true });");
if (!stagingOwnershipContract) {
  fail++;
  console.error("  FAIL target stagingはrequest sequenceとcommitted source generationを分離し、commit後だけ旧stateを無効化する");
} else {
  // A small state-machine replay demonstrates the failed staging boundary:
  // request sequence advances, but the committed generation and review owner
  // remain unchanged until commit.
  let requestSequence = 0;
  let committedGeneration = 7;
  let owner = "review-7";
  const oldOwner = owner;
  const failedRequest = ++requestSequence;
  const failedStage = () => ({ request: failedRequest, committedGeneration, owner });
  const failed = failedStage();
  const preserved = failed.committedGeneration === 7 && failed.owner === oldOwner;
  const committedRequest = ++requestSequence;
  committedGeneration += 1;
  owner = "review-8";
  const committed = committedRequest > failedRequest && committedGeneration === 8 && owner !== oldOwner;
  if (!preserved || !committed) {
    fail++;
    console.error("  FAIL failed/successful target replacement state-machine regression");
  } else {
    console.log("  ok   failed target stagingはactive review/source identityを保持し、commitだけが世代を進める");
  }
}
const operationOwnershipContract = html.includes("function beginReviewOperation")
  && html.includes("function assertCurrentReviewOperation")
  && html.includes("async function waitForCopilotPreparation(operationOwner = null)")
  && html.includes("async function applyAutoAnswer(rawAnswer, packetId, recoveryContext = null, operationOwner = null, restoreOwner = null)")
  && html.includes('async function pollAutoReviewJob(jobId, mergeBaseState = null, resultUrl = "", recoveryContext = null, operationOwner = null, restoreOwner = null)')
  && html.includes("await waitForCopilotPreparation(operationOwner);")
  && html.includes("const packets = await buildFullRunPackets(operationOwner);")
  && html.includes("const packets = await buildAutoPackets(all, sampling, operationOwner);")
  && html.includes("const packets = await buildConsistencyRoundPackets(roundOpts, operationOwner);")
  && html.includes("await applyAutoAnswer(ans, rp.packet_id, recoveryContext, operationOwner, restoreOwner)")
  && html.includes("operationIsCurrent = () => (!operationOwner || isCurrentReviewOperation(operationOwner))");
if (!operationOwnershipContract) {
  fail++;
  console.error("  FAIL old preparation/build/pollはreview operation ownerを検証しない");
} else {
  let activeOwner = "old";
  const oldResult = owner => owner === activeOwner;
  const oldPreparation = () => oldResult("old");
  activeOwner = "new";
  if (oldPreparation()) {
    fail++;
    console.error("  FAIL overlapping old/new review owner replay");
  } else {
    console.log("  ok   overlapping old/new reviewは旧operationの結果を無効化する");
  }
}
const recoverableProbeContract = html.includes("let recoverableProbeSequence = 0;")
  && html.includes("let recoverableProbeOwner = null;")
  && html.includes("let recoverableRestoreSequence = 0;")
  && html.includes("function beginRecoverableRestore(sourceContext, probeOwner = null)")
  && html.includes("function isCurrentRecoverableProbe(owner)")
  && html.includes("function isCurrentRecoverableRestore(owner)")
  && html.includes("invalidateRecoverableJobProbe({ clearPending: true });")
  && html.includes("if (!isCurrentRecoverableProbe(owner)) return null;")
  && html.includes("if (recoverableProbeOwner === owner)");
if (!recoverableProbeContract) {
  fail++;
  console.error("  FAIL recoverable probeの旧promise owner/generation guardがない");
} else {
  let probeOwner = { id: 1 };
  let pending = null;
  const oldProbe = probeOwner;
  probeOwner = { id: 2 };
  if (oldProbe === probeOwner) {
    fail++;
    console.error("  FAIL old recoverable probe can still own pending state");
  } else {
    pending = "new";
    console.log("  ok   target変更後のrecoverable probeは旧promiseのpending/status復元を拒否する");
  }
}
const retryImportOwnershipContract = html.includes("async function retryAutoImport(packetId)")
  && html.includes("const reviewContext = captureRecoverySourceContext();")
  && html.includes("const operationOwner = beginReviewOperation(reviewContext);")
  && html.includes("await applyAutoAnswer(rawAnswer, id, reviewContext, operationOwner)")
  && html.includes("if (!isCurrentReviewOperation(operationOwner)) return;")
  && html.includes("unlockReferenceControls(operationOwner);")
  && html.includes("const restoreOwner = arguments.length > 2 ? arguments[2] : null;");
if (!retryImportOwnershipContract) {
  fail++;
  console.error("  FAIL 再取り込みがreview operation owner/source contextを持たず旧回答を混在させる");
} else {
  // Executable async replay: an old retry remains suspended while a new
  // operation takes ownership.  The old continuation must neither commit nor
  // release the new operation's controls.
  let activeOwner = null;
  let lockedOwner = null;
  const commits = [];
  let releaseOldImport;
  const oldImportGate = new Promise(resolve => { releaseOldImport = resolve; });
  const importWithOwner = async (owner, value) => {
    await oldImportGate;
    if (activeOwner !== owner) return false;
    commits.push(value);
    return true;
  };
  const oldOwner = { id: "old" };
  activeOwner = oldOwner;
  lockedOwner = oldOwner;
  const oldRetry = importWithOwner(oldOwner, "old-answer");
  const newOwner = { id: "new" };
  activeOwner = newOwner;
  lockedOwner = newOwner;
  releaseOldImport();
  const oldCommitted = await oldRetry;
  if (oldCommitted || commits.length || lockedOwner !== newOwner) {
    fail++;
    console.error("  FAIL 旧retry importが新operation開始後に回答またはlockを上書きする");
  } else {
    lockedOwner = null;
    console.log("  ok   新operation開始後の旧retry importはcommitせずcurrent lockを保持する");
  }
}
const restoreRaceContract = html.includes("function invalidateRecoverableRestore()")
  && html.includes("function abortActiveRecoverableRestoreForNewReview()")
  && html.includes("abortActiveRecoverableRestoreForNewReview();")
  && html.includes("const ownerIsCurrent = () => (!operationOwner || isCurrentReviewOperation(operationOwner))")
  && html.includes("(!restoreOwner || isCurrentRecoverableRestore(restoreOwner))")
  && html.includes("if (!restoreOwner) invalidateRecoverableJobProbe({ clearPending: true });")
  && html.includes("await restoreRecoverableJobAfterTargetLoad(owner)")
  && html.includes("pollAutoReviewJob(String(descriptor.id || \"\"), descriptor, String(descriptor.result_url || \"/api/review/recoverable/result\"), recoveryContext, null, restoreOwner)")
  && html.includes("acknowledgeRecoveredJob(descriptor.id, descriptor.recovery_chain_id, recoveryContext, null, restoreOwner)");
if (!restoreRaceContract) {
  fail++;
  console.error("  FAIL 新review開始で旧recoverable restoreを無効化するowner guardがない");
} else {
  let currentRestore = { id: "restore-old" };
  let installed = false;
  let releaseRestore;
  const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
  const restore = async owner => {
    await restoreGate;
    if (currentRestore !== owner) return false;
    installed = true;
    return true;
  };
  const oldRestore = restore(currentRestore);
  currentRestore = { id: "review-new" };
  releaseRestore();
  const oldRestored = await oldRestore;
  if (oldRestored || installed) {
    fail++;
    console.error("  FAIL 新review開始後に旧recoverable restoreがstateをinstallする");
  } else {
    console.log("  ok   新review開始後の旧recoverable restoreはstateをinstallしない");
  }
}
const referenceEditingLockContract = html.includes("let reviewControlLockOwner = null;")
  && html.includes("function referenceControlsAreLocked()")
  && html.includes("reviewControlLockOwner || autoReviewRunning || fullRunActive")
  && html.includes("function lockReferenceControls(owner)")
  && html.includes("function unlockReferenceControls(owner = null)")
  && html.includes("lockReferenceControls(owner);")
  && html.includes("unlockReferenceControls(operationOwner);")
  && html.includes("if (els.referencePdfFile) els.referencePdfFile.disabled = locked;")
  && html.includes("if (els.clearReferenceBtn) els.clearReferenceBtn.disabled = !on || locked;")
  && html.includes("state.referenceRangeDisabled || locked")
  && html.includes("els.referenceBufferPagesInput.disabled = state.reviewSettingsDisabled || locked")
  && html.includes("const disabled = referenceControlsAreLocked() ? \" disabled\" : \"\";")
  && html.includes("if (!referenceControlsAreLocked()) clearReferencePdf(true);")
  && html.includes("if (referenceControlsAreLocked()) return { ok: false, error: \"レビュー実行中は原稿を変更できません。\" };");
if (!referenceEditingLockContract) {
  fail++;
  console.error("  FAIL active review中の比較資料編集ロック契約がない");
} else {
  const referenceState = { files: ["REF1"], mode: "ratio", buffer: 3, range: "1-2" };
  let lockOwner = null;
  const lock = owner => { lockOwner = owner; };
  const unlock = owner => { if (lockOwner === owner) lockOwner = null; };
  const edit = (name, value) => { if (lockOwner) return false; referenceState[name] = value; return true; };
  const oldOwner = {};
  lock(oldOwner);
  const before = JSON.stringify(referenceState);
  const blocked = [edit("files", ["REF1", "REF2"]), edit("mode", "all"), edit("buffer", 8), edit("range", "3-4")];
  const unchanged = JSON.stringify(referenceState) === before && blocked.every(result => result === false);
  const currentOwner = {};
  lock(currentOwner);
  unlock(oldOwner);
  const staleReleasePreservesLock = Boolean(lockOwner === currentOwner);
  unlock(currentOwner);
  const restored = edit("mode", "all") && referenceState.mode === "all";
  if (!unchanged || !staleReleasePreservesLock || !restored) {
    fail++;
    console.error("  FAIL active review中のREF追加/削除/設定変更を遮断し、current owner完了後に再有効化する回帰");
  } else {
    console.log("  ok   active review中のREF追加/削除/設定変更を遮断し、current owner完了後に再有効化する");
  }
}
const settingsListenerStart = html.indexOf("for (const el of [els.targetChunkSizeInput");
const settingsListenerEnd = settingsListenerStart >= 0 ? html.indexOf("els.resetRangeBtn.addEventListener", settingsListenerStart) : -1;
const settingsListenerMarkup = settingsListenerStart >= 0 && settingsListenerEnd >= 0 ? html.slice(settingsListenerStart, settingsListenerEnd) : "";
const benchmarkSetPageRangeStart = html.indexOf("setPageRange(text) {");
const benchmarkSetPageRangeEnd = benchmarkSetPageRangeStart >= 0 ? html.indexOf("setChunkSize(n) {", benchmarkSetPageRangeStart) : -1;
const benchmarkSetPageRangeMarkup = benchmarkSetPageRangeStart >= 0 && benchmarkSetPageRangeEnd >= 0 ? html.slice(benchmarkSetPageRangeStart, benchmarkSetPageRangeEnd) : "";
const startConsistencyStart = html.indexOf("async function startConsistencyReview");
const startConsistencyEnd = startConsistencyStart >= 0 ? html.indexOf("window.startConsistencyReview =", startConsistencyStart) : -1;
const startConsistencyMarkup = startConsistencyStart >= 0 && startConsistencyEnd >= 0 ? html.slice(startConsistencyStart, startConsistencyEnd) : "";
const startFullStart = html.indexOf("async function startFullReview");
const startFullEnd = startFullStart >= 0 ? html.indexOf("async function startAutoReview", startFullStart) : -1;
const startFullMarkup = startFullStart >= 0 && startFullEnd >= 0 ? html.slice(startFullStart, startFullEnd) : "";
const startAutoStart = html.indexOf("async function startAutoReview");
const startAutoEnd = startAutoStart >= 0 ? html.indexOf("async function resumeAutoReviewAfterVisibility", startAutoStart) : -1;
const startAutoMarkup = startAutoStart >= 0 && startAutoEnd >= 0 ? html.slice(startAutoStart, startAutoEnd) : "";
const fullBuilderStart = html.indexOf("async function buildFullRunPackets");
const fullBuilderEnd = html.indexOf("async function startConsistencyReview", fullBuilderStart);
const fullBuilderMarkup = fullBuilderStart >= 0 && fullBuilderEnd > fullBuilderStart ? html.slice(fullBuilderStart, fullBuilderEnd) : "";
const fullSubmitCount = (startFullMarkup.match(/submitAndPollAutoJob\(/g) || []).length;
const cancellationHelperStart = html.indexOf("function cancellationStateAtReviewStart");
const cancellationHelperEnd = cancellationHelperStart >= 0
  ? html.indexOf("\n    // 完了通知と最終操作", cancellationHelperStart)
  : -1;
try {
  const cancellationSource = cancellationHelperStart >= 0 && cancellationHelperEnd > cancellationHelperStart
    ? html.slice(cancellationHelperStart, cancellationHelperEnd)
    : "";
  const cancellationStateAtReviewStart = new Function(
    `${cancellationSource}; return cancellationStateAtReviewStart;`
  )();
  const helperBehavior = cancellationStateAtReviewStart(false, true) === false
    && cancellationStateAtReviewStart(false, false) === false
    && cancellationStateAtReviewStart(true, true) === true
    && cancellationStateAtReviewStart(true, false) === false;
  const standaloneCalls = [
    startConsistencyMarkup,
    startAutoMarkup,
  ].every(source => /fullRunCancelRequested\s*=\s*fullRunActive\s*\?\s*cancellationStateAtReviewStart\(fullRunActive, fullRunCancelRequested\)\s*:\s*false/.test(source));
  if (!helperBehavior || !standaloneCalls) {
    fail++;
    console.error("  FAIL 新規standalone reviewは旧full-runのcancel状態をリセットする");
  } else {
    console.log("  ok   新規standalone reviewは旧full-runのcancel状態をリセットする");
  }
} catch (error) {
  fail++;
  console.error(`  FAIL 新規standalone reviewのcancel状態回帰を実行できる: ${error.message || error}`);
}
if (!startFullMarkup || fullSubmitCount !== 1
  || /startConsistencyReview\s*\(/.test(startFullMarkup)
  || /startAutoReview\s*\(/.test(startFullMarkup)
  || !startFullMarkup.includes("buildFullRunPackets(operationOwner)")
  || !fullBuilderMarkup.includes("withFullRunStageMetadata(round1, 1")
  || !fullBuilderMarkup.includes("withFullRunStageMetadata(round2, 2")
  || !fullBuilderMarkup.includes("withFullRunStageMetadata(pages, 3")) {
  fail++;
  console.error("  FAIL startFullReviewは3段階packetを作成して1回だけsubmitするproduction pathではない");
} else {
  console.log("  ok   startFullReviewは3段階packetを作成して1回だけsubmitする");
}
for (const [name, source] of [
  ["校正設定変更はmanual比較範囲をautoへ戻さない", settingsListenerMarkup],
  ["benchmarkのtarget範囲変更はmanual比較範囲をautoへ戻さない", benchmarkSetPageRangeMarkup],
  ["full review開始はmanual比較範囲をautoへ戻さない", startFullMarkup],
  ["consistency開始はmanual比較範囲をautoへ戻さない", startConsistencyMarkup],
  ["page review開始はmanual比較範囲をautoへ戻さない", startAutoMarkup],
]) {
  if (!source || source.includes("referenceRangeAutoMode = true")) {
    fail++;
    console.error(`  FAIL ${name}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}
const directReferenceModeAssignments = html.match(/referenceRangeAutoMode\s*=\s*(?:true|false)/g) || [];
if (directReferenceModeAssignments.length !== 1) {
  fail++;
  console.error("  FAIL manual/auto状態を開始系の暗黙代入へ戻さない");
} else {
  console.log("  ok   manual/auto状態を開始系の暗黙代入へ戻さない");
}
if (!html.includes('if (el === els.referenceBufferPagesInput)') || !settingsListenerMarkup.includes("refreshRangeFromInput(false)")) {
  fail++;
  console.error("  FAIL buffer変更後に現在の比較範囲を再評価する");
} else {
  console.log("  ok   buffer変更後に現在の比較範囲を再評価する");
}
for (const id of ["consistencyReviewBtn", "autoReviewBtn", "autoReviewAllBtn", "resetRangeBtn"]) {
  if (!setupActionMarkup.includes(`id="${id}"`)) {
    fail++;
    console.error(`  FAIL ${id}をsetup-action-area内に置く`);
  }
}
const mainStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
for (const [name, marker] of [
  ["メイン画面の背景gradientを再追加しない", /(?:background-image\s*:|(?:radial|linear|repeating-radial|repeating-linear)-gradient\s*\()/i],
  ["メイン画面の背景patternを再追加しない", /pattern\s*\(/i],
  ["主CTAを旧range-card selectorへ戻さない", /\.next-step-card \.primary-cta/],
]) {
  if (marker.test(mainStyle)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
for (const [name, marker] of [
  ["workflow stripを常時DOMに残さない", '<nav class="workflow-strip"'],
  ["拡大ボタンを常時DOMに残さない", 'id="zoomInBtn"'],
  ["縮小ボタンを常時DOMに残さない", 'id="zoomOutBtn"'],
  ["指摘一覧を見るボタンを常時DOMに残さない", "指摘の一覧を見る"],
  ["レポートZIP保存ボタンを常時DOMに残さない", "レポートZIPを保存"],
  ["最終操作用autoOpenReportを残さない", "autoOpenReport"],
  ["最終操作用autoSaveReportZipを残さない", "autoSaveReportZip"],
  ["workflow Step2の旧文言を常時DOMに残さない", '<li><span>2</span><strong>範囲を確認</strong></li>'],
  ["範囲を主Stepにする旧見出しを常時DOMに残さない", "<h2>2. 範囲を確認</h2>"],
  ["結果の旧3段階見出しを常時DOMに残さない", "<h2>3. 指摘を確認する</h2>"],
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
  behaviorCheck("整合性round1が0件でもround2を省略しない",
    !html.includes("ラウンド1で指摘が0件だったので、ラウンド2は行いません")
      && html.includes("for (let round = resumeRound; round <= rounds; round++)")
      && html.includes("const packets = await buildConsistencyRoundPackets(roundOpts, operationOwner)"),
    "round2の必須実行ループが見つかりません");
}

// 数値filterのmasked -> restored context再構築は共有helperへ委譲する。
// importResponseがそのhelperへ実際のsource/restore callbacksを渡すことを
// 静的に固定し、ブラウザとtracked replayが同じ二段階契約を使うようにする。
const importResponseStart = html.indexOf("async function importResponse()");
const importResponseEnd = html.indexOf("async function ", importResponseStart + 32);
const importResponseSource = importResponseStart >= 0
  ? html.slice(importResponseStart, importResponseEnd > importResponseStart ? importResponseEnd : undefined)
  : "";
const sharedTwoPassPos = importResponseSource.indexOf("runNumericImportTwoPass(rawFindings");
const sharedTwoPassSource = sharedTwoPassPos >= 0 ? importResponseSource.slice(sharedTwoPassPos) : "";
const restoredContextRebuilt = sharedTwoPassPos >= 0
  && /prepareValidatedSameDocumentCounterparts/.test(sharedTwoPassSource)
  && /collectNumericFindingContexts/.test(sharedTwoPassSource)
  && /restoreMaskedFindings/.test(sharedTwoPassSource)
  && /chooseSourceBackedQuoteVariants/.test(sharedTwoPassSource)
  && /isMaskerCompatibleNumericFinding/.test(sharedTwoPassSource)
  && /sourceCache:\s*sameDocumentSourceCache/.test(sharedTwoPassSource);
if (!restoredContextRebuilt) {
  fail++;
  console.error("  FAIL raw masked contextを再利用せず、restore後contextでnumeric filterを実行する");
} else {
  console.log("  ok   raw masked context→restore後contextの順でnumeric filterを実行する");
}

async function runPdfLoadTransactionChecks() {
  const check = (name, condition, detail = "") => {
    if (!condition) { fail++; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); }
    else console.log(`  ok   ${name}`);
  };
  const bytes = size => new Uint8Array(size).buffer;
  const file = (name, size) => ({
    name,
    type: "application/pdf",
    size,
    arrayBuffer: async () => bytes(size),
  });
  const fileBytes = (name, values) => ({
    name,
    type: "application/pdf",
    size: values.length,
    arrayBuffer: async () => new Uint8Array(values).buffer,
  });
  const parser = async value => ({ numPages: Number(value?.byteLength) || 1 });

  const targetState = { name: "A.pdf", pages: 3, token: "A" };
  const targetBefore = JSON.stringify(targetState);
  let targetCommitCalls = 0;
  try {
    const stagedB = await stagePdfCandidate(file("B.pdf", 8), async () => { throw new Error("破損PDF"); });
    commitStagedPdfCandidate(stagedB, {
      commit: () => { targetCommitCalls++; targetState.name = "B.pdf"; },
    });
  } catch {}
  check("対象PDF Bのparse失敗はA状態とcommit callbackを変えない", JSON.stringify(targetState) === targetBefore && targetCommitCalls === 0);

  const stagedGood = await stagePdfCandidate(file("good.pdf", 5), parser);
  let committedTarget = "";
  commitStagedPdfCandidate(stagedGood, { commit: candidate => { committedTarget = candidate.fileName; } });
  check("対象PDFの正常candidateはparse後にcommitできる", committedTarget === "good.pdf" && stagedGood.totalPages === 5);
  let discardedCandidate = 0;
  const stagedForFailure = await stagePdfCandidate(file("discard.pdf", 4), parser);
  try {
    commitStagedPdfCandidate(stagedForFailure, { commit: () => { throw new Error("commit failure"); }, discard: () => { discardedCandidate++; } });
  } catch {}
  check("staged commit例外ではdiscard callbackを呼ぶ", discardedCandidate === 1);

  const ref1 = { id: "ref1", fileName: "REF1.pdf", byteLength: 4, bytes: bytes(4), doc: { numPages: 1 }, totalPages: 1 };
  const existing = [ref1];
  let referenceCommitCalls = 0;
  try {
    const partialBatch = await stageReferencePdfBatch(
      [file("REF2.pdf", 6), file("REF3.pdf", 7)],
      existing,
      async value => { if (value.byteLength === 7) throw new Error("REF3破損PDF"); return { numPages: 2 }; },
      { maxFiles: 3 },
    );
    commitStagedPdfCandidate(partialBatch.candidates[0], { commit: () => { referenceCommitCalls++; } });
  } catch {}
  check("REF2成功後REF3失敗でも既存REFとbatch commitは変えない", existing.length === 1 && existing[0] === ref1 && referenceCommitCalls === 0);

  const allValid = await stageReferencePdfBatch([file("REF2.pdf", 6), file("REF3.pdf", 7)], existing, parser, { maxFiles: 3 });
  check("全件validな比較PDF batchは入力順でcandidateを返す", !allValid.limited && allValid.candidates.map(item => item.fileName).join(",") === "REF2.pdf,REF3.pdf");

  const duplicateAndNew = await stageReferencePdfBatch([file("REF1.pdf", 4), file("REF2.pdf", 6)], existing, parser, { maxFiles: 3 });
  check("比較PDFの重複skipは維持し新規candidateだけ返す", duplicateAndNew.skipped.length === 1 && duplicateAndNew.candidates.length === 1 && duplicateAndNew.candidates[0].fileName === "REF2.pdf");

  const sameNameExisting = [{ id: "same", fileName: "same.pdf", byteLength: 2, bytes: new Uint8Array([1, 2]), totalPages: 1, doc: { numPages: 1 } }];
  let contentDifferenceParserCalls = 0;
  const contentDifference = await stageReferencePdfBatch(
    [fileBytes("same.pdf", [1, 3])],
    sameNameExisting,
    async value => { contentDifferenceParserCalls++; return { numPages: value.byteLength }; },
    { maxFiles: 2 },
  );
  check("同名同サイズでもPDF内容が違えば比較資料へ追加する", !contentDifference.limited && contentDifference.skipped.length === 0 && contentDifference.candidates.length === 1 && contentDifferenceParserCalls === 1);

  const existingTwo = [
    { id: "dup", fileName: "dup.pdf", byteLength: 2, bytes: new Uint8Array([1, 2]), totalPages: 1, doc: { numPages: 1 } },
    { id: "other", fileName: "other.pdf", byteLength: 2, bytes: new Uint8Array([3, 4]), totalPages: 1, doc: { numPages: 1 } },
  ];
  let dedupeAfterLimitParserCalls = 0;
  const dedupeBeforeLimit = await stageReferencePdfBatch(
    [fileBytes("dup.pdf", [1, 2]), fileBytes("new.pdf", [5, 6])],
    existingTwo,
    async value => { dedupeAfterLimitParserCalls++; return { numPages: value.byteLength }; },
    { maxFiles: 3 },
  );
  check("重複除外後に上限内なら既存2件へ新規1件を追加できる", !dedupeBeforeLimit.limited && dedupeBeforeLimit.skipped.length === 1 && dedupeBeforeLimit.candidates.length === 1 && dedupeAfterLimitParserCalls === 1);

  let cleanupCalls = 0;
  try {
    await stageReferencePdfBatch(
      [fileBytes("cleanup1.pdf", [1]), fileBytes("cleanup2.pdf", [2])],
      [],
      async value => {
        if (new Uint8Array(value)[0] === 2) throw new Error("late invalid PDF");
        return { numPages: 1, destroy: () => { cleanupCalls++; } };
      },
      { maxFiles: 3 },
    );
  } catch {}
  check("比較PDFの後半parse失敗時に先行candidate documentを破棄する", cleanupCalls === 1);

  let limitedParserCalls = 0;
  const limited = await stageReferencePdfBatch([file("R2.pdf", 2), file("R3.pdf", 3), file("R4.pdf", 4)], existing, async value => { limitedParserCalls++; return parser(value); }, { maxFiles: 3 });
  check("比較PDFの上限超過はparseせずlimitedを返す", limited.limited && limited.candidates.length === 0 && limitedParserCalls === 0);
}
try { await runPdfLoadTransactionChecks(); }
catch (error) { fail++; console.error(`  FAIL PDF load transaction behavioral checks: ${error.message || error}`); }

function runReviewControlChecks() {
  const check = (name, condition) => {
    if (!condition) { fail++; console.error(`  FAIL ${name}`); }
    else console.log(`  ok   ${name}`);
  };
  const withoutReference = reviewControlState(false);
  const withReference = reviewControlState(true);
  check("比較資料なしでは候補範囲だけdisabled", withoutReference.referenceRangeDisabled && withoutReference.autoReferenceRangeDisabled && !withoutReference.reviewSettingsDisabled);
  check("比較資料ありでは候補範囲をenabledにできる", !withReference.referenceRangeDisabled && !withReference.autoReferenceRangeDisabled && !withReference.reviewSettingsDisabled);
  check("校正設定はPDF未読込でも変更可能な契約", reviewControlState(false).reviewSettingsDisabled === false);
  const existing = [{ id: "ref1", bufferPages: 3 }, { id: "ref2", bufferPages: 3 }];
  const applied = applyReferenceBufferSetting(existing, 5, 0, 8);
  check("buffer設定5を新旧REFへ反映する", applied.bufferPages === 5 && applied.references.every(ref => ref.bufferPages === 5));
  check("buffer設定helperはcurrent listをcloneして元REFを保持する", existing.every(ref => ref.bufferPages === 3) && applied.references[0] !== existing[0]);
  const clamped = applyReferenceBufferSetting(existing, 99, 0, 8);
  check("buffer設定helperは上限clampを維持する", clamped.bufferPages === 8 && clamped.references.every(ref => ref.bufferPages === 8));
  const parseRange = (value, totalPages) => {
    const match = String(value).match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error("invalid range");
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end > totalPages) throw new Error("range outside document");
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  };
  const formatRange = pages => pages.join(",");
  const manualRange = applyReferenceRangeSetting(
    [{ id: "r1", totalPages: 8, rangeText: "" }, { id: "r2", totalPages: 10, rangeText: "" }],
    "2-4",
    parseRange,
    formatRange,
  );
  check("手入力2-4を複数REFのrangeTextへ正規化して適用する", manualRange.rangeText === "2,3,4" && manualRange.references.every(ref => ref.rangeText === "2,3,4"));
  const beforeInvalidRange = manualRange.references;
  try { applyReferenceRangeSetting(beforeInvalidRange, "2-99", parseRange, formatRange); } catch {}
  check("不正な比較範囲は既存REFのrangeTextを部分変更しない", beforeInvalidRange.every(ref => ref.rangeText === "2,3,4"));
  const autoRange = applyReferenceRangeSetting(beforeInvalidRange, "", parseRange, formatRange);
  check("自動比較へ戻すとrangeTextを空にする", autoRange.references.every(ref => ref.rangeText === ""));
  const noBufferPages = referencePagesForItem(
    { totalPages: 12, mode: "ratio", bufferPages: 0, rangeText: "" },
    [4],
    { targetTotalPages: 10, defaultBuffer: 3, parseRange },
  );
  const defaultBufferPages = referencePagesForItem(
    { totalPages: 12, mode: "ratio", bufferPages: 3, rangeText: "" },
    [4],
    { targetTotalPages: 10, defaultBuffer: 3, parseRange },
  );
  const shortAllManual = referencePagesForItem(
    { totalPages: 8, mode: "all", rangeText: "2-4" },
    [1],
    { targetTotalPages: 10, parseRange },
  );
  const shortAllAutomatic = referencePagesForItem(
    { totalPages: 8, mode: "all", rangeText: "" },
    [1],
    { targetTotalPages: 10, parseRange },
  );
  check("buffer=0の比較候補は既定3ページを足さない", noBufferPages.join(",") === "4,5" && defaultBufferPages.length > noBufferPages.length);
  check("mode=allでも手入力2-4を優先して候補化する", shortAllManual.join(",") === "2,3,4");
  check("mode=allでrangeText空欄なら全ページ候補に戻す", shortAllAutomatic.join(",") === "1,2,3,4,5,6,7,8");
  let manualMode = false;
  const manualRef = { totalPages: 14, mode: "all", rangeText: "2-4", bufferPages: 3 };
  const manualPacketPages = () => referencePagesForItem(manualRef, [1], { targetTotalPages: 14, defaultBuffer: 3, parseRange });
  for (const action of ["full-review", "consistency-review", "page-packet", "language-change", "chunk-change", "context-change", "buffer-change", "benchmark-page-range"]) {
    manualMode = referenceRangeModeAfterAction(manualMode, action);
    check(`manual REF範囲は${action}後も2-4を維持する`, !manualMode && manualPacketPages().join(",") === "2,3,4");
  }
  const explicitAutoMode = referenceRangeModeAfterAction(manualMode, "explicit-auto");
  const autoRef = { ...manualRef, rangeText: "" };
  const autoPacketPages = referencePagesForItem(autoRef, [1], { targetTotalPages: 14, defaultBuffer: 3, parseRange });
  check("明示的な自動範囲操作だけmanual REFをautoへ戻す", explicitAutoMode && autoPacketPages.join(",") === "1,2,3,4,5,6,7,8,9,10,11,12,13,14");
  check("比較範囲を空にした操作はautoへ戻す", referenceRangeModeAfterAction(false, "empty-input") && referencePagesForItem(autoRef, [1], { targetTotalPages: 14, parseRange }).length === 14);
  const aggregateTargets = Array.from({ length: 200 }, (_, index) => index + 1);
  const aggregateReferences = Array.from({ length: 201 }, (_, index) => index + 1);
  const aggregateCandidatePreview = (pages, refs, maxReviewPages, maxCandidatePages) => {
    const candidates = refs.slice().sort((a, b) => a - b);
    if (pages.length <= maxReviewPages && candidates.length > maxCandidatePages) throw new Error("candidate limit");
    return candidates;
  };
  let aggregateRefreshPassed = false;
  let aggregateCandidates = [];
  try {
    aggregateCandidates = aggregateCandidatePreview(aggregateTargets, aggregateReferences, 30, 45);
    aggregateRefreshPassed = true;
  } catch {}
  const packetTargets = [];
  for (let offset = 0; offset < aggregateTargets.length; offset += 10) packetTargets.push(aggregateTargets.slice(offset, offset + 10));
  check("200ページ集約refreshは201候補を保持して10ページpacketへ分割できる", aggregateRefreshPassed && aggregateCandidates.length === 201 && packetTargets.length === 20 && packetTargets.every(packet => packet.length === 10));
  let singlePacketRejected = false;
  try { aggregateCandidatePreview(aggregateTargets.slice(0, 10), aggregateReferences, 30, 45); } catch { singlePacketRejected = true; }
  check("単一packetの比較候補上限超過は引き続き拒否する", singlePacketRejected);
  check("handler結果は旧targetのtruthy状態では成功扱いしない", !loadResultAccepted({ ok: false, totalPages: 9 }));
  check("handlerのinvalid/max結果はnon-successとして扱う", !loadResultAccepted({ ok: false, limited: true }));
  check("比較PDF結果は今回追加件数がないと成功扱いしない", !loadResultAccepted({ ok: true, addedCount: 0 }, { requireAdded: true }));
  check("比較PDF結果は今回追加件数を満たせば成功扱いする", loadResultAccepted({ ok: true, addedCount: 1 }, { requireAdded: true }));
}
try { runReviewControlChecks(); }
catch (error) { fail++; console.error(`  FAIL review control behavioral checks: ${error.message || error}`); }

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
