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
  ["進捗告知は状態・完了数の変化時だけ", 'if (key === lastAutoAnnouncementKey) return;'],
  ["toastがlive region", 'id="toast" class="toast" role="status" aria-live="polite"'],
  ["小文字化した数値記号も原文照合できる", 'chooseSourceBackedFragment(finding.maskedQuote, targetCandidates, source)'],
];
for (const [name, marker] of accessibilityChecks) {
  if (!html.includes(marker)) { fail++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}
if (!findingQuality.includes('normalizedMasked.split(/(⟦#[A-Z]{3}⟧)/gi)')) {
  fail++; console.error("  FAIL 数値記号の照合は大文字小文字を区別しない");
} else console.log("  ok   数値記号の照合は大文字小文字を区別しない");

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
