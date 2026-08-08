// Test-SuggestionKind.mjs — 修正案が「貼れる英文」か「人がやること」かの線引きを固定する。
//
// なぜ要るか（実測 2026-08-08・4本のrun・修正案235件）:
//   整合性モードの69件は **貼れる英文が0件** だった。
//     「3,860と3,680のどちらが正しいか確認する」
//   どちらが正かはモデルには決められないので、これ自体は正しい出力である。
//   悪いのは表示側で、決められないものを `原文 → 修正案` の対に並べ、
//   **英文PDFに貼れるかのように見せていた**。日本語をそのまま貼る事故が起きる。
//
// ⚠️ この線引きを「日本語が混じっているか」でやってはいけない。
//    誤りをそのまま含んだ置き換え文（`... is 48百万 thousand yen.`）を
//    やること側に落としてしまい、**本物の修正案が貼れなくなる**。
//    見るのは **末尾** だけ。英文書類に貼る文が日本語で終わることはない。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const m = html.match(/function suggestionKind\(s\) \{[\s\S]*?\n    \}/);
if (!m) { console.error("index.html から判定式を取り出せません"); process.exit(1); }
const suggestionKind = eval("(function(){" + m[0] + "; return suggestionKind})()");

const results = [];
const check = (name, text, expected) => {
  const got = suggestionKind(text);
  results.push({ ok: got === expected, name, detail: `期待 ${expected} / 実際 ${got}` });
};

// 人がやること（実測から。整合性モードはほぼ全部これ）
check("値を決められない",     "当期の従業員1人当たり安全教育時間の正しい値を確認する", "action");
check("句点つき",             "同一組織であれば正式名称に統一する。", "action");
check("英単語が混じる指示",   "risk assessmentとcontrol activitiesの項番を確認し、連番に修正する。", "action");
check("英文の指示",           "Part 4をPart 3に修正する。", "action");
check("一致させる",           "研究開発人員の数値を比較資料の312に一致させる。", "action");
check("鉤括弧で終わる指示",   "参照先を「Note 12」に揃える", "action");

// 貼れる英文（校正モードの本体）
check("単語の置き換え",       "receives", "replacement");
check("文の置き換え",         "The Company has thoroughly complied with the relevant laws and regulations.", "replacement");
// ⚠️ ここが肝。日本語で弾くと本物の修正案が落ちる。
check("誤りごと写した置き換え", "The annual maintenance cost of this equipment is 48百万 thousand yen.", "replacement");
check("引用符で終わる英文",    'Replace with "Aoi Advanced Materials Co., Ltd."', "replacement");

// 空
check("修正案なし", "", "");
check("空白だけ", "   ", "");

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-SuggestionKind: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
