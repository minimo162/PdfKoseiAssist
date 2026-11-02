// 誤指摘「両側が同じ数値なのに不一致」の回帰テスト（docs/plans/誤指摘_同一数値_改善案_2026-11-02.md）。
//
//   node tools/Test-SameValueMismatchRegression.mjs
//
// 本番と同じ入口（index.html が import する js/finding-quality.mjs・js/review-merge.mjs）から呼ぶ。
// 2026-08-24 の教訓: core を直接 import したテストは本番経路の欠落を検知できなかった。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isUnmaskedIdenticalNumericMismatchFinding,
  isSelfIdenticalValueClaim,
  analyzeSelfIdenticalValueClaim,
  extractClaimedValuePairs,
  isSelfIdenticalComparisonInstruction,
  isNoOpSuggestionFinding,
  normalizeSuggestionIntegrityFinding,
  MASKED_SCALE_UNCERTAIN_NOTE,
} from "../js/finding-quality.mjs";
import { partitionNumericFalsePositives, runNumericImportTwoPass, isConclusiveNumericFalsePositive } from "../js/review-merge.mjs";
import { Masker, unmaskFragment, unmaskFragmentVariants } from "../js/number-mask.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
const fixture = name => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
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
// 後段（除外一覧へ移す）ゲートのどれかに掛かるか。
// P4: self-identical-comparison（取り込み直後・引用検証後）/ P1: unmasked-identical-numeric-mismatch（復元後）。
const excluded = finding => isSelfIdenticalComparisonInstruction(finding) || isUnmaskedIdenticalNumericMismatchFinding(finding);
const kept = finding => !excluded(finding);

const S1 = { category: "value_inconsistency", suggestion: "要約の584と表の584のどちらが正しいか確認し、統一してください。" };
const S2 = { category: "value_inconsistency", suggestion: "要約の1,208と表の1,208のどちらが正しいか確認し、統一してください。" };
const S3 = { category: "translation_consistency", suggestion: "英語版の (579) と日本語版の (579) を整合させる。",
  quote: "Operating loss (579)", referenceQuote: "営業損失 △579" };
const S3p = { ...S3, suggestion: "英語版の (579) と日本語版の △579 を整合させる。" };

// --- P1: 場所の修飾語つきの同値主張 ---
check("T1 S1（要約の584と表の584）を除外一覧へ", excluded(S1));
check("T2 S2（桁区切りあり 1,208）を除外一覧へ", excluded(S2));
check("T3 桁区切りなし 1208 ⇔ 1,208 を除外一覧へ", excluded({ ...S2, suggestion: "要約の1208と表の1,208のどちらが正しいか確認し、統一してください。" }));
check("T3 全角 １，２０８ ⇔ 1,208 を除外一覧へ", excluded({ ...S2, suggestion: "要約の１，２０８と表の1,208のどちらが正しいか確認し、統一してください。" }));
check("T4 S3（(579) ⇔ (579)、translation_consistency）を除外一覧へ", excluded(S3));
check("T5 S3′（(579) ⇔ △579）を除外一覧へ", excluded(S3p));
check("T6 要約の584と表の548 は残る", kept({ ...S1, suggestion: "要約の584と表の548のどちらが正しいか確認し、統一してください。" }));
check("T7 579 と (579)（符号の有無が違う）は残る", kept({ ...S3, suggestion: "英語版の 579 と日本語版の (579) を整合させる。", quote: "", referenceQuote: "" }));
check("T11 500と500（既存 #126）は従来どおり除外", excluded({ category: "value_inconsistency", issueSummary: "FY2026/3の通期連結営業利益について、500と500のどちらが正しいか確認する。" }));
check("T11 347と347（既存 #126）は従来どおり除外", excluded({ category: "translation_consistency", suggestion: "347と347のどちらが正しいか確認し、該当箇所を統一する。" }));
check("T12 「3,860」と内訳合計のどちらが…（#151、片側が数値でない）は残る",
  kept({ category: "value_inconsistency", suggestion: "「3,860」と内訳合計のどちらが正しいか確認してください。" }));
check("T13 FY2026とFY2026の営業利益500と600 は残る（年は値として数えない）",
  kept({ category: "value_inconsistency", issueSummary: "FY2026とFY2026の営業利益500と600が不一致" }));
check("T13 P.13の修飾語は値として数えない", excluded({ category: "value_inconsistency", suggestion: "P.5の営業利益100とP.13の100のどちらが正しいか確認する" }));
check("T16 category が日本語名（数値不一致）でも除外一覧へ", excluded({ ...S1, category: "数値不一致" }));
check("1つでも別値の対があれば除外しない", kept({ category: "value_inconsistency",
  suggestion: "要約の584と表の584、売上の500と600のどちらが正しいか確認する" }));

// 単位（スケール語）つき
check("584億円 ⇔ 584億円 は同値", excluded({ ...S1, suggestion: "要約の584億円と表の584億円のどちらが正しいか確認してください。" }));
check("584k ⇔ 584千円 は同値（k = 千）", excluded({ ...S1, suggestion: "英語版の¥584kと日本語版の584千円のどちらが正しいか確認してください。" }));
check("1.2 billion ⇔ 12億 は同値（スケール換算）", excluded({ ...S1, suggestion: "英語版の1.2 billionと日本語版の12億のどちらが正しいか確認してください。" }));
check("584億円 ⇔ 584百万円（両側明示・桁違い）は残る", kept({ ...S1, suggestion: "要約の584億円と表の584百万円のどちらが正しいか確認してください。" }));
check("48 thousand yen ⇔ 48 million yen は残る", kept({ ...S1, suggestion: "48 thousand yen と 48 million yen のどちらが正しいか確認する" }));
check("584億円 ⇔ 裸の584 は、単位の読み取り失敗が分からない限り残る",
  kept({ ...S1, suggestion: "要約の584億円と表の584のどちらが正しいか確認してください。" }));
check("584億円 ⇔ 5,840億円（桁違い）は残る", kept({ ...S1, suggestion: "要約の584億円と表の5,840億円のどちらが正しいか確認してください。" }));

// --- 数値列ガード（F0040/F0041） ---
for (const name of ["review-merge-live-q4-0840-f0040.json", "review-merge-live-q4-0840-f0041.json"]) {
  const raw = fixture(name).findings[0];
  const finding = { ...raw, issueSummary: raw.issue_summary, referenceQuote: raw.reference_quote };
  const analysis = analyzeSelfIdenticalValueClaim(finding);
  check(`T14 ${raw.id} 挙げた値は同値と読める`, analysis.claimed, JSON.stringify(analysis.pairs));
  check(`T14 ${raw.id} 行の数値列に差があるので除外しない`, analysis.vectorDiffers && kept(finding) && !isSelfIdenticalValueClaim(finding));
}
check("quote/ref の数値列が違えば、挙げた値が同じでも除外しない", kept({
  category: "number_mismatch", quote: "Net sales 48 million yen", referenceQuote: "Net sales 49 million yen",
  suggestion: "48 million yen と 48 million yen のどちらが正しいか確認する" }));
check("片側しか数値を持たない（reference_quote が空）ときはガードを通す", excluded({ ...S1, quote: "売上高は584でした。" }));
check("取り込み処理が数値列ガードの警告を付ける", /analyzeSelfIdenticalValueClaim\(f\)\.vectorDiffers/.test(indexHtml)
  && /appendFindingQualityWarning\(f, SELF_IDENTICAL_VALUE_WARNING\)/.test(indexHtml));

// --- T15: hard drop はしない（後段の除外一覧ゲートの担当） ---
{
  const labelled = { id: "T15", category: "value_inconsistency", suggestion: "P.4の304とP.15の304のどちらが正しいか確認する" };
  check("T15 partitionNumericFalsePositives では残る", partitionNumericFalsePositives([labelled]).kept.length === 1);
  check("T15 後段ゲートで除外一覧へ", excluded(labelled));
}

// --- P4: 自己同一の確認指示（self-identical-comparison） ---
check("P4 S1 → self-identical-comparison", isSelfIdenticalComparisonInstruction(S1));
check("P4 S2 → self-identical-comparison", isSelfIdenticalComparisonInstruction(S2));
check("P4 S3 → self-identical-comparison", isSelfIdenticalComparisonInstruction(S3));
check("P4 T12 「3,860」と内訳合計（片側が数値でない）は対象外",
  !isSelfIdenticalComparisonInstruction({ category: "value_inconsistency", suggestion: "「3,860」と内訳合計のどちらが正しいか確認してください。" }));
check("P4 要約の584と表の548 は対象外",
  !isSelfIdenticalComparisonInstruction({ ...S1, suggestion: "要約の584と表の548のどちらが正しいか確認してください。" }));
check("P4 伏字のまま同じ記号どうし（⟦#ABC⟧と⟦#ABC⟧）も対象",
  isSelfIdenticalComparisonInstruction({ ...S1, suggestion: "要約の⟦#ABC⟧と表の⟦#ABC⟧のどちらが正しいか確認してください。" }));
check("P4 伏字のまま別の記号どうし（⟦#ABC⟧と⟦#DEF⟧）は対象外",
  !isSelfIdenticalComparisonInstruction({ ...S1, suggestion: "要約の⟦#ABC⟧と表の⟦#DEF⟧のどちらが正しいか確認してください。" }));
check("P4 確認・統一の指示でない文は対象外",
  !isSelfIdenticalComparisonInstruction({ ...S1, suggestion: "584と584は同じ値です。" }));
check("P4 isNoOpSuggestionFinding は確認指示を no-op にしない（#151 を変えない）",
  !isNoOpSuggestionFinding({ ...S1, quote: "売上高 584" }));
check("P4 F0040（行の数値列に差）は対象外", (() => {
  const raw = fixture("review-merge-live-q4-0840-f0040.json").findings[0];
  return !isSelfIdenticalComparisonInstruction({ ...raw, referenceQuote: raw.reference_quote });
})());
{
  const appLabels = (indexHtml.match(/const EXCLUDED_REASON_LABELS = \{([\s\S]*?)\};/) || [])[1] || "";
  const reportLabels = (indexHtml.match(/const reportExcludedReasonLabels = \{([\s\S]*?)\};/) || [])[1] || "";
  const markSrc = (indexHtml.match(/function markNoOpSuggestionFindings\(findingsToCheck\) \{[\s\S]*?\n    \}/) || [])[0] || "";
  check("P4 取り込み直後と引用検証後の両方で呼ばれるゲートに入っている",
    /isSelfIdenticalComparisonInstruction\(finding\)/.test(markSrc) && /excludedReason = "self-identical-comparison"/.test(markSrc)
      && (indexHtml.match(/markNoOpSuggestionFindings\((?:rawFindings|findingsToCheck)\)/g) || []).length >= 2);
  check("P4 除外理由のラベルがアプリとレポートの両方にある",
    appLabels.includes('"self-identical-comparison"') && reportLabels.includes('"self-identical-comparison"'));
}

// --- P2: 記号割れの痕跡（合成の回答JSONを、本番の取り込み順で通す） ---
{
  const data = fixture("same-value-mismatch-20261102.json");
  const masker = new Masker(data.seed);
  const symbolsBySource = new Map();
  for (const source of data.sources) {
    symbolsBySource.set(source.key, masker.mask(source.text, source.lang).text.match(/⟦#[A-Z]{3}⟧/g) || []);
  }
  const resolve = value => typeof value === "string"
    ? value.replace(/\{([A-Za-z0-9]+)#(\d+)\}/g, (_all, key, index) => {
      const symbol = symbolsBySource.get(key)?.[Number(index)];
      if (!symbol) throw new Error(`fixture symbol ${key}#${index} not found`);
      return symbol;
    })
    : value;
  const restoreMaskedFindings = new Function("jobMasker", "unmaskFragment", "unmaskFragmentVariants", "normalizeSuggestionIntegrityFinding",
    `${extractFunction("restoreMaskedFindings")}; return restoreMaskedFindings;`)(masker, unmaskFragment, unmaskFragmentVariants, normalizeSuggestionIntegrityFinding);
  // index.html の取り込みと同じ順: coerce → markNoOpSuggestionFindings（自己同一の確認指示）→
  // runNumericImportTwoPass（伏字のまま → 復元 → 復元後）→ 復元後ゲート → 引用検証後の markNoOpSuggestionFindings。
  const markSelfIdentical = list => {
    for (const f of list) {
      if (!f.excludedReason && isSelfIdenticalComparisonInstruction(f)) {
        f.excludedReason = "self-identical-comparison";
        f.displayReason = "比べている2つの値が同じ" + (f.maskedScaleUncertain ? MASKED_SCALE_UNCERTAIN_NOTE : "");
      }
    }
  };
  const raw = data.findings.map((item, index) => {
    const f = Object.fromEntries(Object.entries(item.finding).map(([key, value]) => [key, resolve(value)]));
    return { id: `F${String(index + 1).padStart(4, "0")}`, ...f,
      referenceQuote: f.reference_quote ?? "", issueSummary: f.issue_summary ?? "", reason: f.reason ?? "", displayReason: f.reason ?? "" };
  });
  markSelfIdentical(raw);
  const pass = await runNumericImportTwoPass(raw, {
    prepareValidatedSameDocumentCounterparts: async () => new Map(),
    collectNumericFindingContexts: async () => new Map(),
    restoreMaskedFindings,
    isMaskerCompatibleNumericFinding: (finding, context) => isConclusiveNumericFalsePositive(finding, { masker, ...context }),
    masker,
  });
  const incoming = pass.coerced;
  for (const f of incoming) {
    if (!f.excludedReason && isUnmaskedIdenticalNumericMismatchFinding(f)) {
      f.excludedReason = "unmasked-identical-numeric-mismatch";
      f.displayReason = "数値を元に戻すと同じ値だった" + (f.maskedScaleUncertain ? MASKED_SCALE_UNCERTAIN_NOTE : "");
    }
  }
  markSelfIdentical(incoming);
  data.findings.forEach((item, index) => {
    const id = `F${String(index + 1).padStart(4, "0")}`;
    const out = incoming.find(f => f.id === id);
    const state = !out ? "dropped" : out.excludedReason ? "excluded" : "kept";
    const detail = out ? `${state} ${out.excludedReason || ""} ${out.suggestion} | ${out.quote || ""} | ${out.referenceQuote || ""}` : "hard drop";
    check(`${item.case}（取り込み経路）: ${item.expect}`, state === item.expect, detail);
    if (item.scaleNote) {
      check(`${item.case}: 単位を読み取れなかった可能性の注記と maskedScaleUncertain`,
        out?.maskedScaleUncertain === true && String(out?.displayReason || "").includes(MASKED_SCALE_UNCERTAIN_NOTE), detail);
    }
  });
  const t8 = incoming.find(f => f.id === `F${String(data.findings.findIndex(item => item.case === "T8") + 1).padStart(4, "0")}`);
  check("T8 両側明示の単位誤りは maskedSymbolsIncompatible", t8?.maskedSymbolsIncompatible === true
    && t8?.maskedSymbolSplit?.kind === "explicit-scale-conflict");
  check("除外は全件 excludedReason 付きで残り、hard drop は無い", pass.numericFilteredCount === 0, String(pass.numericFilteredCount));
}
{
  const masker = new Masker(9);
  const [summary] = masker.mask("当期の売上高は584億円となりました。", "ja").text.match(/⟦#[A-Z]{3}⟧/g);
  const [bare] = masker.mask("売上高 584 612", "ja").text.match(/⟦#[A-Z]{3}⟧/g);
  const [en] = masker.mask("Net sales for the year were 48 thousand yen.", "en").text.match(/⟦#[A-Z]{3}⟧/g);
  const [ja] = masker.mask("当期の売上高は48百万円でした。", "ja").text.match(/⟦#[A-Z]{3}⟧/g);
  check("describeSymbolSplit: 584億円 ⇔ 単位の無い表の584 は inferred-scale-split",
    masker.describeSymbolSplit(summary, bare)?.kind === "inferred-scale-split");
  check("describeSymbolSplit: 48 thousand ⇔ 48百万 は explicit-scale-conflict",
    masker.describeSymbolSplit(en, ja)?.kind === "explicit-scale-conflict");
  check("describeSymbolSplit: 表記の違う値は null", masker.describeSymbolSplit(summary, en) === null);
  check("出現記録に explicitScale を残す", masker.occurrences.some(rec => rec.explicitScale === true)
    && masker.occurrences.some(rec => rec.explicitScale === false));
}

check("抽出: 「A」を日本語版の「B」と照合", extractClaimedValuePairs("「283,957」を日本語版の「283,957」と照合して修正する。").length === 1);

if (failures.length) {
  console.error(`\nTest-SameValueMismatchRegression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-SameValueMismatchRegression: PASS");
