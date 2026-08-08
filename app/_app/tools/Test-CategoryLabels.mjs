// Test-CategoryLabels.mjs — 依頼文が名乗る分類に、日本語の名前が必ず付いていることを見る。
//
// なぜ要るか（実測 2026-08-08・runs/raw の全指摘）:
//   画面に出ていた分類のうち、上位3つが **英語の識別子のまま** だった。
//     translation_consistency 1,817件 / value_inconsistency 1,657件 / prose_inconsistency 1,067件
//   整合性モードで出る分類は4つしかなく、その4つ全部が英語だった。
//   name_mismatch（19件）も同じ。表示の落ち穂ではなく、モードまるごとの穴である。
//
// ⚠️ 原因は、依頼文の分類一覧と表示側の対応表が**別々に書かれている**こと。
//    片方を足しても、もう片方は黙って英語を出す。人が気付くのは利用者の画面である。
//    そこでここでは、**依頼文から分類名を読み取って** 両方の表に当てる。
//    依頼文に分類を足したら、名前を付けるまでこの検査は落ちる。
//
// 表は2つある（書き出し側 categoryLabels / 閲覧側 categoryText）。両方見る。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const results = [];
const t = (name, ok, detail) => results.push({ ok: !!ok, name, detail });

// --- 依頼文が名乗る分類を集める ---
const declared = new Set();
for (const m of html.matchAll(/"category":\s*"([^"]*\|[^"]*)"/g)) {
  for (const w of m[1].split("|")) {
    const key = w.trim();
    if (/^[a-z_]+$/.test(key)) declared.add(key);   // 「読み取り不可など」等の日本語は元から読める
  }
}
t("依頼文から分類を読み取れた", declared.size >= 10, `${declared.size}種`);

// --- 2つの対応表を取り出す ---
const grab = (re, label) => {
  const m = html.match(re);
  if (!m) { console.error(`index.html から ${label} を取り出せません`); process.exit(1); }
  return new Set([...m[1].matchAll(/([a-z_]+)\s*:/g)].map(x => x[1]));
};
const genLabels  = grab(/const categoryLabels = \{([^}]*)\}/, "categoryLabels（書き出し側）");
const viewLabels = grab(/function categoryText\(s\)\{const m=\{([^}]*)\}/, "categoryText（閲覧側）");

for (const [name, set] of [["書き出し側", genLabels], ["閲覧側", viewLabels]]) {
  const missing = [...declared].filter(k => !set.has(k));
  t(`${name}に日本語名がある`, missing.length === 0, missing.join(", "));
}

// --- 2つの表が食い違っていないか ---
const onlyGen  = [...genLabels].filter(k => !viewLabels.has(k));
const onlyView = [...viewLabels].filter(k => !genLabels.has(k));
t("2つの表の分類が揃っている", !onlyGen.length && !onlyView.length,
  `書き出し側だけ: ${onlyGen.join(",") || "なし"} / 閲覧側だけ: ${onlyView.join(",") || "なし"}`);

// --- 実測で出た分類が漏れていないか（依頼文に無い分類が現場で出ることがある） ---
// formatting は決め打ちの絞り込みが付けるもので、依頼文には出てこない。
const SEEN = ["translation_consistency", "value_inconsistency", "prose_inconsistency",
              "number_mismatch", "grammar", "typo", "omission", "mistranslation",
              "name_mismatch", "date_mismatch", "accounting_inconsistency",
              "terminology", "note_mismatch", "formatting"];
const unseen = SEEN.filter(k => !genLabels.has(k) || !viewLabels.has(k));
t("実測で出た分類すべてに日本語名がある", unseen.length === 0, unseen.join(", "));

// CSVも同じcategoryLabelを使う。定義がHTML生成関数の内側にあると、CSV書き出し時に
// ReferenceErrorとなるため、CSV関数より前の共有スコープに置かれていることを固定する。
const categoryLabelPos = html.indexOf("const categoryLabel =");
const reportCsvPos = html.indexOf("function reportCsvText(");
t("分類名関数がCSVから見える共有スコープにある",
  categoryLabelPos >= 0 && reportCsvPos >= 0 && categoryLabelPos < reportCsvPos,
  `categoryLabel=${categoryLabelPos}, reportCsvText=${reportCsvPos}`);

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-CategoryLabels: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
