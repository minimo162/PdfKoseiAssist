// Regression coverage for issue #152: the numeric false-positive filter and the
// masker must not drop genuine numeric translation errors.
//
//   node tools/Test-Issue152Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Masker, unmaskFragment, unmaskFragmentVariants } from "../js/number-mask.mjs";
import { partitionNumericFalsePositives, isConclusiveNumericFalsePositive } from "../js/review-merge.mjs";
import { normalizeSuggestionIntegrityFinding } from "../js/finding-quality.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
function extractFunction(name) {
  const start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = indexHtml.indexOf("{", start); i < indexHtml.length; i++) {
    if (indexHtml[i] === "{") depth++;
    else if (indexHtml[i] === "}" && --depth === 0) return indexHtml.slice(start, i + 1);
  }
  throw new Error(`${name} is not closed`);
}

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); failures.push(name); }
};
const kept = (finding, context = {}) => partitionNumericFalsePositives([finding], context).kept.length === 1;
const symbols = text => text.match(/⟦#[A-Z]{3}⟧/g) || [];

// --- 1. subset proof: prior-year value, swapped current/prior, YoY change used as total ---
{
  const cases = [
    ["前期の値を流用", "Capital expenditures for the fiscal year were ¥98.0 billion.", "当期の設備投資額は1,250億円（前期は980億円）となりました。"],
    ["当期と前期の入れ替え", "Ordinary income was ¥435.0 billion (¥412.0 billion in the previous fiscal year).", "経常利益は4,120億円（前期は4,350億円）となりました。"],
    ["増減額を総額として記載", "R&D expenses were ¥8.0 billion.", "研究開発費は1,520億円（前期比80億円増）となりました。"],
  ];
  for (const [label, en, ja] of cases) {
    const masker = new Masker(152);
    const quote = masker.mask(en, "en").text;
    const referenceQuote = masker.mask(ja, "ja").text;
    const finding = { id: label, category: "number_mismatch", quote, referenceQuote,
      suggestion: quote, reason: "英文の金額が日本語版の当期の金額と一致しません。" };
    check(`記号の部分集合一致だけで除外しない（${label}）`, kept(finding, { masker }), `${quote} || ${referenceQuote}`);
  }
}
{
  // Labelled rows still prove equivalence when the extra amount is another metric.
  const finding = { id: "label-match", category: "number_mismatch",
    quote: "Operating income ⟦#DEF⟧ oku", referenceQuote: "売上高 ⟦#ABC⟧億円 営業利益 ⟦#DEF⟧億円" };
  check("指標名で対応し、余りが別指標の行なら従来どおり除外", !kept(finding));
}

// --- 2. direction words ---
for (const [label, en, ja] of [
  ["up ⇔ 減", "Net sales were up 5.2% year on year.", "売上高は前年同期比5.2％減となりました。"],
  ["increased ⇔ 減少", "Net sales increased by ¥350 million year on year.", "売上高は前年同期比350百万円の減少となりました。"],
  ["income ⇔ 純損失", "Net income attributable to owners of the parent was ¥1,234 million.", "親会社株主に帰属する当期純損失は1,234百万円となりました。"],
]) {
  const finding = { id: label, category: "number_mismatch", quote: en, referenceQuote: ja, referencePages: [1],
    reason: "増減（損益）の向きが逆です。", suggestion: "向きを日本語版に合わせてください。" };
  check(`増減・損益の向きが逆なら除外しない（${label}、伏字なし）`, kept(finding));
  const masker = new Masker(7);
  const masked = { ...finding, quote: masker.mask(en, "en").text, referenceQuote: masker.mask(ja, "ja").text };
  check(`増減・損益の向きが逆なら除外しない（${label}、伏字あり）`,
    !isConclusiveNumericFalsePositive(masked, { masker }) && kept(masked, { masker }));
}
check("「減価償却」の減は減少の向きとみなさない", !isConclusiveNumericFalsePositive({
  category: "number_mismatch", quote: "Depreciation was ¥500 million.", referenceQuote: "減価償却費は500百万円でした。",
}) === !isConclusiveNumericFalsePositive({
  category: "number_mismatch", quote: "Depreciation was ¥500 million.", referenceQuote: "償却費は500百万円でした。",
}));

// --- 3. same masked symbol with a different explicit unit or currency ---
for (const [label, en, ja] of [
  ["% ⇔ ポイント", "The operating margin improved by 1.2% year on year.", "営業利益率は前年同期比1.2ポイント改善しました。"],
  ["US$ ⇔ 円", "Net sales of the U.S. subsidiary were US$386 million.", "米国子会社の売上高は386百万円でした。"],
  ["円 ⇔ 米ドル", "Net sales of the U.S. subsidiary were ¥386 million.", "米国子会社の売上高は386百万米ドルでした。"],
]) {
  const masker = new Masker(11);
  const finding = { id: label, category: "number_mismatch", quote: masker.mask(en, "en").text,
    referenceQuote: masker.mask(ja, "ja").text, referencePages: [1], reason: "単位が異なる。", suggestion: "単位を合わせる。" };
  check(`同じ記号でも単位・通貨が違えば除外しない（${label}、伏字あり）`,
    !isConclusiveNumericFalsePositive(finding, { masker }) && kept(finding, { masker }));
  check(`単位・通貨が違えば除外しない（${label}、伏字なし）`, kept({ ...finding, quote: en, referenceQuote: ja }));
}

// --- 4/5. restoring must keep the fact that the masked symbols were different quantities ---
{
  const masker = new Masker(99);
  const restoreMaskedFindings = new Function("jobMasker", "unmaskFragment", "unmaskFragmentVariants", "normalizeSuggestionIntegrityFinding",
    `${extractFunction("restoreMaskedFindings")}; return restoreMaskedFindings;`)(masker, unmaskFragment, unmaskFragmentVariants, normalizeSuggestionIntegrityFinding);
  const isUnmaskedIdenticalNumericMismatchFinding = new Function(
    `${extractFunction("isUnmaskedIdenticalNumericMismatchFinding")}; return isUnmaskedIdenticalNumericMismatchFinding;`)();
  const en = masker.mask("Net sales for the year were 48 thousand yen.", "en").text;
  const ja = masker.mask("当期の売上高は48百万円でした。", "ja").text;
  const [e48] = symbols(en), [j48] = symbols(ja);
  const [restored] = restoreMaskedFindings([{ id: "scale", category: "number_mismatch", quote: en, referenceQuote: ja,
    issueSummary: `売上高の記号が${e48}と${j48}で異なる`, suggestion: en.replace("thousand", "million") }]);
  check("復元時に、伏字の記号が非互換だったことを記録する", restored.maskedSymbolsIncompatible === true);
  check("千円と百万円の取り違えを「伏字の誤指摘」として除外しない", !isUnmaskedIdenticalNumericMismatchFinding(restored),
    restored.issueSummary);
  check("復元後に数字が同じに見えても同値として除外しない",
    !isConclusiveNumericFalsePositive({ ...restored, quote: "Net sales 3,860 4,120", referenceQuote: "売上高 3,860 4,120" }));
  const same = masker.mask("Operating income was ¥52.0 billion.", "en").text;
  const sameJa = masker.mask("営業利益は520億円でした。", "ja").text;
  const [sameRestored] = restoreMaskedFindings([{ id: "same", category: "number_mismatch", quote: same, referenceQuote: sameJa }]);
  check("同じ量を表す記号どうしなら非互換の印を付けない", !sameRestored.maskedSymbolsIncompatible, `${same} || ${sameJa}`);
}

// --- 6. rounding merges must not give two different values one symbol ---
{
  const masker = new Masker(31);
  const companies = symbols(masker.mask("The number of consolidated subsidiaries increased by 3 companies.", "en").text)[0];
  const rate30 = symbols(masker.mask("Net sales rose 3.0% year on year.", "en").text)[0];
  const rate34 = symbols(masker.mask("売上高は前年同期比3.4%増となりました。", "ja").text)[0];
  check("3.0% と 3.4% は粗い値（3社）を介しても同じ記号にならない", rate30 !== rate34, `${companies} ${rate30} ${rate34}`);
  const m2 = new Masker(31);
  const [exact12380, coarse124] = symbols(m2.mask("Operating income was 12,380 million yen (¥12.4 billion).", "en").text);
  const [ja12400] = symbols(m2.mask("営業利益は12,400百万円となりました。", "ja").text);
  check("12,380 と 12,400 は ¥12.4 billion を介しても同じ記号にならない", exact12380 !== ja12400, `${exact12380} ${coarse124} ${ja12400}`);
  check("同じ精度で別の値を含む記号どうしは互換にしない", !m2.areSymbolsCompatible(exact12380, ja12400));
  const finding = { id: "collision", category: "number_mismatch", issueScope: "translation_consistency",
    quote: `Operating income was ${exact12380} million yen.`, referenceQuote: `営業利益は${ja12400}円となりました。`,
    issueSummary: "営業利益の金額がREFと一致しない" };
  check("Copilot が報告した 12,380 ⇔ 12,400 の差を互換判定で除外しない", !isConclusiveNumericFalsePositive(finding, { masker: m2 }));
  const m3 = new Masker(5);
  const en = symbols(m3.mask("Net sales were ¥1,285.7 billion.", "en").text)[0];
  const ja = symbols(m3.mask("売上高は1,285,706百万円でした。", "ja").text)[0];
  check("表示桁で丸めた同じ量は従来どおり同じ記号", en === ja, `${en} ${ja}`);
}

if (failures.length) {
  console.error(`\nTest-Issue152Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue152Regression: PASS");
