// Test-SelfCheck.mjs — 出力の自己検算が「本物を落とさず、矛盾だけ落とす」ことを固定する。
//
// なぜ要るか（独立レビュー 2026-08-08）:
//   校正モードの誤検出33件は、どれも「人間が0.5秒で分かる矛盾」だった。
//   そこで書き出し時に検算を入れたが、**最初の版は本物を落とすところだった**。
//     「TARGETの48と比較資料の48百万が一致していない」← 48千円 vs 48百万円。本物の誤り。
//   数字だけを見て「同じ」と判定していたためである。単位まで見ないといけない。
//   この道具は、その線引きが崩れていないことを見る。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const m = html.match(/const SCALE_WORDS = \[[\s\S]*?\n      \};/);
if (!m) { console.error("index.html から判定式を取り出せません"); process.exit(1); }
const sameNumbers = eval("(function(){" + m[0] + "; return sameNumbers})()");

const results = [];
const check = (name, text, expected) => {
  const got = sameNumbers(text);
  results.push({ ok: got === expected, name, detail: `期待 ${expected} / 実際 ${got}` });
};

// 落とすべきもの（同じ量どうしを「一致しない」と言っている）
check("同じ数値どうし", "TARGETの12と比較資料の12が一致していない。", true);
check("鉤括弧つきでも同じ", "TARGET側では「13」、REF側では「13」となっている。", true);
check("3つ並べても同じ", "前頁は6であり、続頁も6だが、この頁だけ6になっている。", true);
check("桁区切りが違うだけ", "TARGETは1,234、REFは1234となっている。", true);

// 残すべきもの（単位が違う＝本物の誤り）
check("千と百万", "TARGETの48と比較資料の48百万が一致していない。", false);
check("百万と億", "TARGETの記号は12、比較資料の記号は12億となっており、実量が異なる。", false);
check("thousand と million", "TARGET is 48 thousand yen but REF is 48 million yen.", false);
check("値そのものが違う", "P.96では478,600、P.6では476,800と一致しない。", false);
check("数値が1つだけ", "この文には数値が12しかない。", false);

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-SelfCheck: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
