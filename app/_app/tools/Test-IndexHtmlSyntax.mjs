// Test-IndexHtmlSyntax.mjs — index.html のインライン JS を構文チェック（node tools/Test-IndexHtmlSyntax.mjs）
// 4900行の monolith を編集した際の構文崩れを機械的に検知する。node --check は構文のみ検証
// （ブラウザ globals の未定義は無視）。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, fail = 0;
while ((m = re.exec(html))) {
  const tmp = join(here, `.idxcheck_${i}.js`);
  writeFileSync(tmp, m[1]);
  try { execSync(`node --check "${tmp}"`, { stdio: "pipe" }); console.log(`  ok   inline script #${i}`); }
  catch (e) { fail++; console.error(`  FAIL inline script #${i}\n${e.stderr ? e.stderr.toString() : e}`); }
  finally { unlinkSync(tmp); }
  i++;
}
// 指摘レポート(HTML)のビューアJSは、index.html の中ではテンプレート文字列の一部なので
// 上の <script> 抽出には引っかからない（`<\/script>` でエスケープされている）。
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

if (!i) { console.error("インライン script が見つかりません"); process.exit(1); }
if (fail) { console.error(`\nTest-IndexHtmlSyntax: FAIL (${fail})`); process.exit(1); }
console.log(`\nTest-IndexHtmlSyntax: PASS (${i} block)`);
