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
import { hasEquivalentScaledNumbers } from "../js/review-merge.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
// ⚠️ 正規表現でソース断片を抜き出す方式は、間の実装が変わるたびに壊れやすい。
//    index.html 側に名前付きマーカーコメントを置き、ここではマーカーの
//    間だけを機械的に抜き出す。マーカー自体が消えたら「取り出せません」で確実に落ちる。
const START_MARKER = "/* @self-check-numeric-start */";
const END_MARKER = "/* @self-check-numeric-end */";
const startAt = html.indexOf(START_MARKER);
const endAt = html.indexOf(END_MARKER);
if (startAt < 0 || endAt < 0 || endAt <= startAt) {
  console.error("index.html からマーカー @self-check-numeric-start/end の間を取り出せません");
  process.exit(1);
}
const block = html.slice(startAt + START_MARKER.length, endAt);
const { sameNumbers, numericColumnsMatch, extractSignedNumberTokens } = eval("(function(){" + block + "; return { sameNumbers, numericColumnsMatch, extractSignedNumberTokens }})()");

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

// ⚠️ **ページ番号を数値として数えない。**「P.1では55.64だが、P.19では55.64」の
//    1 と 19 が混ざるせいで、同じ値どうしの矛盾を見逃していた
//    （実測 2026-08-08・マツダ短信で4件中3件を取りこぼした）。
check("ページ番号が混じっても見抜く", "P.1ではNet Income Per Shareが55.64だが、P.19では同じFY2026の値が55.64となっている。", true);
check("年度表記が混じっても見抜く", "March 31, 2026時点の値は1,266,466だが、FY2026の値も 1,266,466 である。", true);
check("ページ番号だけが違う場合は騒がない", "P.9の値は473,851で、P.21の値は528,679である。", false);

// ⚠️ 会計期表記も年度と同じく落とさないと、残った月日の数字が値として拾われる。
//    「2026年3月期」から年だけ落とすと「3月期」の3が残り、Setサイズが2になって
//    素通りしていた（実測 2026-08-18・利用者の実レポート「指摘.json」の実データ）。
check("実測: 会計期表記混じりの35,086同値を見抜く（35,086の指摘）",
  "P.15の連結株主資本等変動計算書では、2026年3月期のNet income attributable to owners of the parentが35,086ですが、"
  + "P.10の連結損益計算書では同じ2026年3月期・連結・百万円単位の値が35,086です。P.1、P.5およびP.19でも35,086と記載されています。",
  true);
check("会計期表記だけが違う場合は騒がない", "2026年3月期の値は100だが、2027年3月期の値は200である。", false);
check("第N四半期表記も日付として落とす", "第1四半期の値は42であり、第2四半期の値も42である。", true);

// ⚠️ `\d{1,2}月期` は「3月期末残高」のような会計用語からも「3月期」を
//    削ってしまう（数値抽出には実害が無い副作用）。ここでは実害が無いことを固定する。
check("「3月期末残高」の月期表記混じりでもsameNumbers判定が壊れない",
  "P.10の3月期末残高は1,234であり、P.15の3月期末残高も1,234である。", true);
check("「3月期末残高」表記混じりで値が違えば同値と誤判定しない",
  "P.10の3月期末残高は1,234であり、P.15の3月期末残高は1,235である。", false);

// ⚠️ %は「数字の直後」ルールでSCALE_WORDSと同じ扱いにする。12.5%と12.5は
//    比率と実数で意味が違うので同一視してはいけない。
check("12.5%と12.5は%の有無で区別する（一致とみなさない）", "TARGETは12.5%だが、比較資料は12.5となっている。", false);
check("12.5%どうしは一致とみなす", "P.1では自己資本比率12.5%、P.9でも12.5%となっている。", true);

// --- quote と reference_quote の数値列そのものの一致（reasonに数字が無い number_mismatch）---
const cols = (name, quote, referenceQuote, expected) => {
  const got = numericColumnsMatch(quote, referenceQuote);
  results.push({ ok: got === expected, name, detail: `期待 ${expected} / 実際 ${got}` });
};
// 実測 2026-08-18: reasonに数値が書かれない number_mismatch で、quote/reference_quote
// 自体の数値列は完全に一致していた（表側の桁ズレ誤指摘）。
cols("実測: 期中平均株式数の数値列は一致（630,263 / 630,626）",
  "Average number of shares outstanding during the period (Thousands of shares) 630,263 630,626",
  "普通株式の期中平均株式数 (千株) 630,263 630,626",
  true);
// 「－」は全角ダッシュのゼロ表記で数値ではない。数字に隣接せず空白を挟むので符号として拾わない。
cols("実測: 全角ダッシュ「－」は数値扱いしない（235のみ一致）",
  "Gain on sales of investment securities 235",
  "投資有価証券売却益 － 235",
  true);
// 英語版の(1,234)括弧表記と日本語版の△1,234は同じ負数の書き分け（実務慣行）。
cols("実測: 英語(37,812)と日本語△37,812は同じ負数として一致",
  "Dividends paid (37,812) (37,812)",
  "剰余金の配当 △37,812 △37,812",
  true);
// ⚠️ 符号を揃えても値そのものが違う場合は、引き続き不一致のまま残す。
cols("符号を揃えても値が違えば一致にしない（(37,812) と △37,813）",
  "Dividends paid (37,812)",
  "剰余金の配当 △37,813",
  false);
// ⚠️ 単位語は数字直後だけを見る。48 と 48百万は指数0と6で食い違うので一致にしない
//    （48千円 vs 48百万円という本物の誤りを握りつぶさないため）。
cols("48 と 48百万は数値列一致にしない（本物の単位誤り）", "TARGETの値は48である。", "比較資料の値は48百万である。", false);
// 桁が入れ替わっただけの別の値は一致にしない。
cols("3,860 と 3,680は一致にしない（桁の転置）", "TARGETの値は3,860である。", "比較資料の値は3,680である。", false);
// 片方だけ数値が多い場合は保守的に抑制しない。
cols("片方にだけ余分な数値がある場合は抑制しない", "値は100と200である。", "値は100である。", false);
// quoteまたはreference_quoteが空なら比較しない。
cols("reference_quoteが空なら一致扱いしない", "値は100である。", "", false);

// ⚠️ 符号と数字の間に空白が入る書式（△ 37,812）。△▲は空白1つまで許容し、
//    ダッシュ類（－ - −）は直接隣接する場合だけ符号として扱う（設計判断。上のcols
//    「全角ダッシュ「－」は数値扱いしない」テストと対で、△▲とダッシュ類の非対称な
//    空白許容ルールを固定する）。
cols("実測: 空白入り△ 37,812は符号として拾う（(37,812)と同じ負数として一致）",
  "Dividends paid (37,812)",
  "純資産の部の変動 △ 37,812",
  true);
cols("空白入り△ 37,812と符号なし37,812は区別する（一致にしない）",
  "純資産の部の変動 △ 37,812",
  "純資産の部の変動 37,812",
  false);

// ⚠️ 括弧=負数は閉じ括弧の位置まで見て判定する。単位語を挟んでも閉じていれば
//    負数、単位語だけの注記（中に数字が無い）は最初から対象にならない。
cols("実測: (1,234 million)は単位語を挟んでも閉じ括弧まで見て負数と判定する",
  "Loss amount (1,234 million)",
  "△1,234 million",
  true);
cols("実測: (千株)は数字を含まない単位注記なので負数扱いにならない（正の数値列のまま一致）",
  "普通株式の期中平均株式数 (千株) 630,263",
  "Average number of shares (Thousands of shares) 630,263",
  true);

// --- 桁の書き方が違うだけ（十億 vs 百万）---
const scale = (name, text, expected) => {
  const got = hasEquivalentScaledNumbers(text);
  results.push({ ok: got === expected, name, detail: `期待 ${expected} / 実際 ${got}` });
};
scale("十億と百万（4,918.2 ⇔ 4,918,172）", "P.5では4,918.2、P.1では4,918,172とすべて異なる。", true);
scale("端数の丸めも見抜く（51.6 ⇔ 51,579）", "P.5では51.6、P.1では51,579。", true);
// ⚠️ ここが肝。桁列が同じものはこちらで拾わない。48千円 vs 48百万円は**本物の誤り**で、
//    単位まで見る sameNumbers の担当である。ここで拾うと本物が「怪しい」印になる。
scale("48 と 48百万は拾わない（本物）", "TARGETの48と比較資料の48百万が一致していない。", false);
scale("まったく違う値は拾わない", "P.96では478,600、P.6では476,800と一致しない。", false);
scale("2桁以下は偶然当たるので拾わない", "12と125で異なる。", false);

// --- extractSignedNumberTokens そのものを直接見る ---
const tokens = (name, text, expected) => {
  const got = extractSignedNumberTokens(text);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  results.push({ ok, name, detail: `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(got)}` });
};
// ⚠️ 全角数字は NFKC 正規化を通さないと \d（ASCII限定）が素通りしてしまい拾えなかった
//    （実測 2026-08-18）。既存の半角・全角括弧の挙動が変わらないことも同時に固定する。
tokens("全角数字「１，２３４」を拾う（NFKC正規化）", "値は１，２３４である。", ["1234e0"]);
tokens("半角括弧の負数(1,234)は従来どおり", "値は(1,234)である。", ["-1234e0"]);
tokens("全角括弧の負数（1,234）は従来どおり", "値は（1,234）である。", ["-1234e0"]);
tokens("全角数字と全角括弧の組み合わせ（１，２３４）も負数として拾う", "値は（１，２３４）である。", ["-1234e0"]);

// ⚠️ 脚注・箇条書き番号 `(1)` を負数と誤認しない。桁区切り・小数点の無い1〜2桁の
//    括弧内数字は識別子である可能性が高いため負数と見なさない設計判断（実測 2026-08-18）。
//    本物の1桁の負数 `(5)` との判別は見た目だけでは付かないため、「抑制しない」方向
//    （＝負数と見なさない）に倒す。
tokens("脚注番号(1)は負数トークン化しない", "注(1) の値は 500", ["1e0", "500e0"]);
tokens("箇条書き番号(12)も2桁までは負数トークン化しない", "(12) 項目の値は 500", ["12e0", "500e0"]);
// 桁区切りが付けば1〜2桁でも従来どおり負数（`(37)` のような3桁未満の本物の負数も
// 桁区切りが付かない限りは識別子扱いになる、という設計上のトレードオフはコメントに明記済み）。
tokens("桁区切り付きの短い数値は従来どおり負数（(1,2)想定はまず出ないが桁区切りがあれば負数扱い）",
  "差引額は(1,234)である。", ["-1234e0"]);
// numericColumnsMatch は列数完全一致を要求するため、脚注番号の解釈がどちらでも
// 実際の列比較には影響しないことを固定する（実害が無いことの確認）。
cols("実測: 脚注番号が混じっても列数完全一致要求のnumericColumnsMatchは実害なし",
  "注(1) 売上高の値は 500", "注(1) 売上高の値は 500", true);

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-SelfCheck: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
