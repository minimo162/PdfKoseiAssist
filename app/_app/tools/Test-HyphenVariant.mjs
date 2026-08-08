// Test-HyphenVariant.mjs — 「ハイフン・空白の有無だけ」の指摘を畳む線引きを固定する。
//
// なぜ要るか（実測 2026-08-08・マツダ 決算短信の日英）:
//   **PDFのテキスト層にハイフンが入っていないことがある。**
//   画面には Short-term と出ているのに pdfjs が返すのは `Shortterm`。
//   `available-for-sale` は `availableforsale`、`CX-5` は同じ文書内で
//   `CX 5` と `CX‑5`（U+2011）が混在していた。生の pdfjs 出力の時点でこうなので、
//   こちらの再構成の問題ではない。
//
//   結果、**抽出した文字の上でだけ表記が割れて見える**。モデルは正しく報告するが、
//   利用者がPDFを開けばハイフンは揃っている。55件中6件がこれだった。
//   「PDFを見れば合っているのに間違った指摘が出る」のは、道具としていちばん
//   信用を落とす壊れ方である。確かめられないことは通常の指摘として出さない。
//
// ⚠️ 語そのものが違う揺れ（収益/売上）まで畳んではいけない。**本物が消える。**
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const L = readFileSync(join(ROOT, "index.html"), "utf8").split(/\r?\n/);
const fn = (needle) => {
  const i = L.findIndex(s => s.includes(needle));
  if (i < 0) throw new Error("index.html に見つかりません: " + needle);
  const indent = L[i].match(/^\s*/)[0];
  for (let j = i + 1; j < L.length; j++) if (L[j] === indent + "}") return L.slice(i, j + 1).join("\n");
  throw new Error("閉じ括弧が見つかりません: " + needle);
};
const src = [fn("function normalizeHyphenationComparisonText(value)"),
             fn("function citedFormsInReason(text)"),
             fn("function isHyphenSpaceOnlyVariantClaim(f)")].join("\n");
const isHyphenSpaceOnlyVariantClaim =
  eval("(function(){" + src + "; return isHyphenSpaceOnlyVariantClaim})()");

const results = [];
const check = (name, f, expected) => {
  const got = isHyphenSpaceOnlyVariantClaim(f);
  results.push({ ok: got === expected, name, detail: `期待 ${expected} / 実際 ${got}` });
};

// --- 畳むべきもの（実測の指摘そのまま） ---
check("Noncontrolling ⇔ Non controlling", {
  issueSummary: "Noncontrolling Interestsの空白表記が不統一",
  reason: "P.9、P.10、P.15では「Noncontrolling Interests」または「noncontrolling interests」だが、P.19では「Non controlling Interests」と空白を入れている。",
}, true);
check("availableforsale ⇔ available for sale", {
  issueSummary: "available-for-sale相当語の連結方法が不統一",
  reason: "P.9、P.11、P.21では「availableforsale securities」と連結されている一方、P.12、P.13では「available for sale securities」と分かれている。",
}, true);
check("Shortterm ⇔ short term", {
  issueSummary: "ShorttermおよびLongtermの連結表記が不統一",
  reason: "P.9、P.14では「Shortterm」「Longterm」が使われる一方、P.6、P.15では「short term」「long term」と分かれている。",
}, true);
check("CX 5 ⇔ CX‑5", {
  issueSummary: "CXモデル名でハイフンとMazdaの有無が不統一",
  reason: "P.4では「Mazda CX 5」、同ページでは「CX 5」、P.6では「CX‑5」と、同一モデル名にMazdaの有無およびハイフンの有無の揺れがある。",
}, true);

// 実測（利用者の指摘・2026-08-08）: 同じページの中でハイフンが U+2011 だったり
// 空白だったりする。"Mazda EZ‑60"(2011) と "Mazda EZ 6"(20) が同一ページに並ぶ。
// ブランド接頭辞の有無は付随的な差で、本体はハイフンが消えていること。
check("Mazda EZ‑60 ⇔ EZ 60（接頭辞の差を含む）", {
  issueSummary: "Mazda EZモデル名のハイフン表記が不統一",
  reason: "P.4では「Mazda EZ‑60」、P.5では「EZ 60」と表記され、同一モデル名についてハイフンとMazdaの有無が揺れている。",
}, true);

// --- 畳んではいけないもの ---
// ⚠️ ここが肝。語そのものが違う揺れを畳むと、本物の指摘が消える。
check("訳語そのものが違う（本物）", {
  issueSummary: "売上高の訳語が不統一",
  reason: "P.3では「Net sales」だが、P.10では「Revenue」と表記が分かれている。",
}, false);
check("法人格の略記（本物）", {
  issueSummary: "社名の表記が不統一",
  reason: "P.1では「Mazda Motor Corporation」、P.5では「Mazda Motor Corp.」と分かれている。",
}, false);
check("ハイフンの話をしていない", {
  issueSummary: "数値が不一致",
  reason: "P.9では「473,851」だが、P.21では「473,851」となっている。",
}, false);
check("挙げた表記が1つだけ", {
  issueSummary: "ハイフンが抜けている",
  reason: "「Shortterm」はハイフンが必要である。",
}, false);
check("理由文が空", { issueSummary: "", reason: "" }, false);
// ⚠️ ここが肝。前方一致で判定すると `mazdamotorcorp` が `mazdamotorcorporation` に
//    一致してしまい、**法人格の略記という本物の揺れが消える**。後方一致だけを見る。
check("Corp. ⇔ Corporation（本物・前方一致の罠）", {
  issueSummary: "社名の表記が不統一",
  reason: "P.1では「Mazda Motor Corporation」だが、P.5では「Mazda Motor Corp.」と空白と略記が揺れている。",
}, false);

for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\nTest-HyphenVariant: ${bad ? `FAIL (${bad})` : "PASS"}`);
process.exit(bad ? 1 : 0);
