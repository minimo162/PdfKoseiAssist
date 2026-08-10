// TARGET_CHECK の抽出テキストから、番号付き見出しだけを決定的に拾う。
// Copilot に本文検索を任せず、欠番候補を検証するための存在確認済み一覧を渡すために使う。

const TARGET_BLOCK_HEADER = /^===== PDF P\.\d+ \/ TARGET_CHECK \/ 元PDF P\.(\d+) \/.*=====$/;
const ANY_BLOCK_HEADER = /^===== PDF P\.\d+ \/ [A-Z0-9_]+ \/ 元PDF P\.\d+ \/.*=====$/;
const MASK_TOKEN = /⟦#[A-Z0-9]+⟧/g;

function normalizeLine(value) {
  return String(value || "")
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
function parseNumberedHeading(line) {
  const text = normalizeLine(line);
  if (!text || /^[-*•●○◆◇▪▫]\s*/.test(text)) return null;

  // 数字だけを空白で区切った表行は拾わない。見出しには区切り記号を必須にする。
  const match = text.match(/^(?<marker>(?:\d{1,3}(?:\.\d{1,3}){0,3}[.．)）:]|[（(]\d{1,3}[)）]|第\d{1,3}[章節項]|(?:[IVX]{1,7}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]{1,4})[.．)）]))\s*(?<body>.+)$/iu);
  if (!match?.groups) return null;

  const marker = normalizeLine(match.groups.marker);
  const body = normalizeLine(match.groups.body);
  if (!body || body.length > 240) return null;

  const letters = body.match(/\p{L}/gu) || [];
  if (letters.length < 3) return null;

  // 表の行番号や数値明細を見出しとして渡さない。伏字が複数ある行はほぼ表行。
  const maskedValues = body.match(MASK_TOKEN) || [];
  if (maskedValues.length >= 2) return null;
  const numericTokens = body.match(/(?:^|\s)[+−-]?\d[\d,]*(?:\.\d+)?(?:%|円|yen|million|billion|thousand)?(?=\s|$)/giu) || [];
  if (numericTokens.length >= 3) return null;

  return { marker, heading: body, text: `${marker} ${body}` };
}

export function extractNumberedHeadingIndex(sidecarText, { maxItems = 240 } = {}) {
  const lines = String(sidecarText || "").replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  const seen = new Set();
  let targetPage = null;

  for (const rawLine of lines) {
    const header = rawLine.match(TARGET_BLOCK_HEADER);
    if (header) {
      targetPage = Number(header[1]);
      continue;
    }
    if (ANY_BLOCK_HEADER.test(rawLine)) {
      targetPage = null;
      continue;
    }
    if (!Number.isInteger(targetPage)) continue;

    const parsed = parseNumberedHeading(rawLine);
    if (!parsed) continue;
    const key = `${targetPage}\u0000${parsed.text.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ page: targetPage, ...parsed });
    if (entries.length >= Math.max(1, Number(maxItems) || 240)) break;
  }
  return entries;
}

export function buildNumberedHeadingIndexPrompt(sidecarText, options) {
  const entries = extractNumberedHeadingIndex(sidecarText, options);
  const list = entries.length
    ? entries.map(entry => `- P.${entry.page}: ${entry.text}`).join("\n")
    : "- （番号付き見出しを検出できませんでした）";

  return `
■ アプリがTARGET_CHECKから抽出した番号付き見出し一覧（存在確認済み）
以下は、Copilotの推測や検索結果ではなく、アプリが送信TEXTのTARGET_CHECKから抽出した実在行です。
${list}

欠番・見出し番号の不足を判断する前に、必ずこの一覧を照合してください。
- 欠けていると主張する番号付き見出しが一覧に1件でもあれば、その欠番候補は報告禁止です。
- 一覧に無いことだけでは欠番の証明になりません。抽出できない組版もあるため、前後の番号列と本文から欠落が明白な場合だけ候補にしてください。
- 箇条書き、表の行番号、注記番号は、この「番号付き見出し一覧」と同じ項番列として混同しないでください。
- 欠番候補を残す場合、reasonへ「アプリ抽出一覧に該当なし」と、欠けている番号＋見出し本文を明記してください。`;
}
