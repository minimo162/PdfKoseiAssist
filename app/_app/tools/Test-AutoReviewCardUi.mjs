// 自動校正ログ領域は行数に関係なく同じ高さで、キーボードから読める。
import fs from "node:fs";

const here = new URL("..", import.meta.url);
const html = fs.readFileSync(new URL("index.html", here), "utf8");
if (!html.includes("function hasTextSelectionWithin")
  || !html.includes("event.detail > 0 && hasTextSelectionWithin(node)")) {
  throw new Error("ポインタ文字選択をカード活性化へ変換しないガードがない");
}
if (!html.includes('event.key !== "Enter"') || !html.includes('event.key !== " "')) {
  throw new Error("Enter/Spaceのカードキーボード活性化を保持していない");
}
const css = html.match(/#autoReviewCard\s*\{([^}]*)\}/)?.[1] || "";
if (!/height\s*:\s*clamp\(/.test(css)) throw new Error("autoReviewCard が固定 height ではない");
if (/min-height|max-height/.test(css)) throw new Error("autoReviewCard が内容依存の min/max height を使っている");
if (!/overflow-y\s*:\s*auto/.test(css)) throw new Error("autoReviewCard の内部スクロールがない");
const card = html.match(/<div\s+id="autoReviewCard"[^>]*>/)?.[0] || "";
for (const marker of ['tabindex="0"', 'role="region"', 'aria-label="自動校正ログ"']) {
  if (!card.includes(marker)) throw new Error(`autoReviewCard の${marker}がない`);
}
if (html.includes("観点ごとの走査が記録されていません。")) throw new Error("内部実装語の二重警告が残っている");
if (!html.includes("観点ごとの確認が記録されていません。アプリを更新してから、もう一度実行してください。")) throw new Error("利用者向け観点警告がない");
if (!html.includes("needs_user_visibility") || !html.includes("autoVisibilityRetryLink") || !html.includes("showCopilotAndRetryAutoPacket")) throw new Error("hidden時の表示/同一packet再試行導線がない");
if (!html.includes('<strong>現在の段階:</strong>') || !html.includes("autoElapsedLine(st)")) {
  throw new Error("進捗カードの現在段階または経過時間の要約行がない");
}
if (!html.includes("function shouldShowHumanReviewLabel")
  || !html.includes("humanReviewLabel(f)")
  || !html.includes("quality-warning")) {
  throw new Error("曖昧一致以外の品質警告を具体的な確認ラベルへつなぐ導線がない");
}
const renderStart = html.indexOf("function renderAutoCard");
const renderEnd = html.indexOf("async function pollReadyState", renderStart);
const renderSource = renderStart >= 0 && renderEnd > renderStart ? html.slice(renderStart, renderEnd) : "";
if (!renderSource.includes('<details class="auto-review-details"><summary>依頼別の詳細</summary>')
  || renderSource.includes("すべての依頼の取り込みが終わりました。")) {
  throw new Error("進捗詳細がcollapsedでない、または完了文をカードで重複表示している");
}
if (!renderSource.includes("const warningHeading = terminal.announceCompletion")
  || !renderSource.includes("terminal.announceContinuation")) {
  throw new Error("中間warningのカード見出しまたは継続表示が最終phase判定に結び付いていない");
}
const bannerStart = html.indexOf("function renderReviewCompletionBanner");
const bannerEnd = html.indexOf("function renderFindings", bannerStart);
const bannerSource = bannerStart >= 0 && bannerEnd > bannerStart ? html.slice(bannerStart, bannerEnd) : "";
if (!bannerSource.includes("complete && terminal?.announceCompletion")
  || !bannerSource.includes("reviewCompletionEligibility(st")) {
  throw new Error("中間warningが完了bannerを迂回できる状態です");
}
const warningStart = html.indexOf("function isAmbiguityOnlyQualityWarning");
const warningEnd = html.indexOf("function coerceFindings", warningStart);
const warningSource = warningStart >= 0 && warningEnd > warningStart ? html.slice(warningStart, warningEnd) : "";
const showHumanReviewLabel = new Function(`const DUPLICATE_QUOTE_WARNING = "quoteが同一ページ内の複数箇所に一致します。"; ${warningSource}; return shouldShowHumanReviewLabel;`)();
const reviewLabel = new Function(`const DUPLICATE_QUOTE_WARNING = "quoteが同一ページ内の複数箇所に一致します。"; ${warningSource}; return humanReviewLabel;`)();
const findingQualityWarningText = new Function(`const DUPLICATE_QUOTE_WARNING = "quoteが同一ページ内の複数箇所に一致します。"; ${warningSource}; return findingQualityWarningText;`)();
if (showHumanReviewLabel("品質ゲートに失敗しました。") !== true
  || showHumanReviewLabel("quoteが同一ページ内の複数箇所に一致します。") !== false) {
  throw new Error("非曖昧品質warningの強い人確認ラベル、または曖昧warningの抑制契約が壊れている");
}
const integrityAudit = "自動作成された案は原文と一致しない内容を含んでいたため、表示していません。";
if (findingQualityWarningText({ suggestionIntegrity: "numeric-token-change", qualityWarning: `${integrityAudit} 追加の品質確認が必要です。` }) !== "追加の品質確認が必要です。"
  || findingQualityWarningText({ suggestionIntegrity: "numeric-token-change", qualityWarning: integrityAudit }) !== "") {
  throw new Error("メインアプリの品質警告に整合性監査文が常時表示されている");
}
if (reviewLabel({
  suggestionIntegrity: "numeric-token-change",
  qualityWarning: "自動作成された案は原文と一致しない内容を含んでいたため、表示していません。",
}) !== ""
  || reviewLabel({
    suggestionIntegrity: "numeric-token-change",
    qualityWarning: "自動作成された案は原文と一致しない内容を含んでいたため、表示していません。追加の品質確認が必要です。",
  }) !== "内容を確認してください"
  || reviewLabel({ qualityWarning: "追加の品質確認が必要です。" }) !== "内容を確認してください") {
  throw new Error("品質警告の具体的な利用者向けラベルが壊れている");
}
console.log("Test-AutoReviewCardUi: PASS");
