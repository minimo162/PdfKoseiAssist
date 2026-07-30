// turn-complete.mjs — §7.3 turn 完了検知と成功分類
//
// 計画書 §7.3 / fix F:
//   - 完了検知(detection): marker が「独立した最終非空行」として現れ、その後は空白だけ。
//     JSON文字列値や説明文に marker と同じ部分文字列が含まれても完了扱いしない。
//   - 成功分類(success): 完了検知に加え、marker 直前の本文が（任意の code fence 除去後）
//     単一の有効な JSON object として parse できること。
//   - marker 検知済みだが JSON が厳密でない場合は detection=true, success=false を返し、
//     呼び出し側（PS の incomplete-json 脱出 / JS の取り込み修復）へ委ねる。timeoutまで待たない。
//
// 純関数。marker は呼び出し側で turn ごとに一意なものを渡す。

// 先頭/末尾の ```json ... ``` を1組だけ除去する（許可されたオプションの wrapper）。
export function stripCodeFence(text) {
  let s = String(text || "").trim();
  const fence = s.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  if (fence) return fence[1].trim();
  return s;
}

// 最初の '{' から対応する '}' までを、文字列・エスケープを考慮して切り出す。
function extractFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// marker をリテラルとして行単位照合するための正規表現エスケープ。
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTurnCompletion(rawText, marker) {
  const text = String(rawText || "");
  const mk = String(marker || "");
  const result = { detected: false, success: false, jsonValid: false, markerLineOk: false, trailingClean: false, json: null };
  if (!mk) return result;

  const lines = text.split(/\r\n|\r|\n/);
  // 最後の非空行の index
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") { lastIdx = i; break; }
  }
  if (lastIdx < 0) return result;

  const markerRe = new RegExp("^" + escapeRegExp(mk) + "[ \\t]*$");
  // marker は「独立した最終非空行」であること（condition 3/4）。
  if (!markerRe.test(lines[lastIdx])) return result;
  result.markerLineOk = true;
  // marker 行より後ろは空白のみ（lastIdx が最終非空行なので自明だが明示）。
  result.trailingClean = lines.slice(lastIdx + 1).every(l => l.trim() === "");
  result.detected = result.markerLineOk && result.trailingClean;
  if (!result.detected) return result;

  // marker 行の直前までを本文として、code fence 除去 → JSON object 抽出 → parse（condition 2）。
  const before = lines.slice(0, lastIdx).join("\n");
  const body = stripCodeFence(before);
  const objText = extractFirstJsonObject(body);
  if (objText) {
    try {
      const parsed = JSON.parse(objText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result.jsonValid = true;
        result.json = parsed;
      }
    } catch (_) { /* detection=true, success=false のまま */ }
  }
  result.success = result.detected && result.jsonValid;
  return result;
}
