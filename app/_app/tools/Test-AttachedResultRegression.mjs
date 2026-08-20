// 2026-08-19 attached HTML viewer regression:
// suppress only source-proven unit conversions and cross-document TOC
// pagination, while preserving real value/section differences.
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { partitionNumericFalsePositives } from "../js/review-merge.mjs";
import { normalizeSuggestionIntegrityFinding, sanitizeSuggestionByNumericIntegrity, suggestionChangesNumericOrDateTokens } from "../js/finding-quality.mjs";

let failures = 0;
const test = (name, condition) => {
  if (condition) console.log("  ok   " + name);
  else { failures++; console.error("  FAIL " + name); }
};
const decision = (finding, context = null) => partitionNumericFalsePositives([finding], {
  forFinding: () => context || {},
});
const drops = (finding, context = null) => decision(finding, context).dropped.length === 1;

const tocCashFlow = {
  id: "F0026", category: "number_mismatch", issue_scope: "translation_consistency",
  issue_summary: "「Overview of Cash Flows」の掲載ページ番号を修正する。",
  reason: "目次の同一項目について掲載ページ番号が一致しません。",
  quote: "(3) Overview of Cash Flows………………………………………………………………………4",
  reference_quote: "（３）当期のキャッシュ・フローの概況 …………………………………………………3",
};
const tocDividend = {
  id: "F0027", category: "number_mismatch", issue_scope: "translation_consistency",
  issue_summary: "配当方針の掲載ページ番号を修正する。",
  reason: "目次の同一項目について掲載ページ番号が一致しません。",
  quote: "(5) Basic Dividend Policy, Dividends for March 2026 and March 2027 Fiscal Years……………5",
  reference_quote: "（５）利益配分に関する基本方針及び当期・次期の配当 ……………………………… 4",
};
test("attached F0026: TARGET/REF TOC terminal page difference is DROP", drops(tocCashFlow));
test("attached F0027: translated TOC text may omit explicit years and page difference is DROP", drops(tocDividend));
test("real section-number mismatch without TOC leader remains KEEP", !drops({
  ...tocCashFlow,
  quote: "(2) Consolidated Cash Flows",
  reference_quote: "（３）連結キャッシュ・フロー",
}));
test("unrelated translated TOC entries with the same entry number remain KEEP", !drops({
  ...tocCashFlow,
  quote: "(3) Net Sales………………………………………………………………………4",
  reference_quote: "（３）当期のキャッシュ・フローの概況 …………………………………………………3",
}));
test("TOC-like citations without an explicit terminal-page claim remain KEEP", !drops({
  ...tocCashFlow, issue_summary: "目次の訳を修正する。", reason: "見出しが一致しない。",
}));

const grammarNumberLeak = {
  id: "F0037", category: "grammar", issue_scope: "english_proofreading",
  quote: "due in part to declined sales of the Mexico made CX 30",
  suggestion: "due in part to declining sales of the Mexico made CX 30.00",
};
test("attached F0037: grammar suggestion changing CX 30 to 30.00 is rejected for regeneration",
  suggestionChangesNumericOrDateTokens(grammarNumberLeak));
const sanitizedGrammarNumberLeak = sanitizeSuggestionByNumericIntegrity(grammarNumberLeak);
test("attached F0037: valid finding stays visible while unsafe suggestion becomes an action",
  sanitizedGrammarNumberLeak.needsRegeneration
    && sanitizedGrammarNumberLeak.original === grammarNumberLeak.suggestion
    && sanitizedGrammarNumberLeak.suggestion.endsWith("再生成してください。"));
test("grammar wording-only change keeps the cited number", !suggestionChangesNumericOrDateTokens({
  ...grammarNumberLeak, suggestion: "due in part to declining sales of the Mexico made CX 30",
}));
test("model-name hyphen is not a numeric sign (CX-30/CX 30)", !suggestionChangesNumericOrDateTokens({
  ...grammarNumberLeak,
  quote: "Mexico-made CX-30",
  suggestion: "Mexico-made CX 30",
}));
test("model-name hyphen is not a numeric sign in the reverse direction (Model 3/Model-3)", !suggestionChangesNumericOrDateTokens({
  ...grammarNumberLeak,
  quote: "Model 3",
  suggestion: "Model-3",
}));
test("standalone -30 remains a real numeric change", suggestionChangesNumericOrDateTokens({
  ...grammarNumberLeak,
  quote: "loss -30",
  suggestion: "loss 30",
}));
test("numeric mismatch category may intentionally change cited values", !suggestionChangesNumericOrDateTokens({
  ...grammarNumberLeak, category: "number_mismatch", suggestion: "due in part to declining sales of the Mexico made CX 31",
}));

const translatedSectionCorrection = {
  id: "F0027", category: "mistranslation", issue_scope: "translation_consistency",
  quote: "(2) Consolidated Cash Flows",
  reference_quote: "（３）連結キャッシュ・フローの状況",
  suggestion: "(3) Consolidated Cash Flows",
};
test("attached F0027: reference-backed section index correction is not blocked by numeric gate",
  !suggestionChangesNumericOrDateTokens(translatedSectionCorrection));
test("section index correction without matching REF evidence remains blocked", suggestionChangesNumericOrDateTokens({
  ...translatedSectionCorrection,
  reference_quote: "（２）連結キャッシュ・フローの状況",
}));
test("section index correction rejects a non-heading REF parenthetical", suggestionChangesNumericOrDateTokens({
  ...translatedSectionCorrection,
  reference_quote: "注記（3）も参照。",
}));
test("section correction cannot smuggle a second amount change", suggestionChangesNumericOrDateTokens({
  ...translatedSectionCorrection,
  quote: "(2) Consolidated Cash Flows 140,000",
  suggestion: "(3) Consolidated Cash Flows 140,001",
  reference_quote: "（３）連結キャッシュ・フロー 140,000",
}));
test("parenthesized amount in sentence is not treated as a section index", suggestionChangesNumericOrDateTokens({
  ...translatedSectionCorrection,
  quote: "Consolidated Cash Flows (2) 140,000",
  suggestion: "Consolidated Cash Flows (3) 140,000",
  reference_quote: "（３）連結キャッシュ・フロー 140,000",
}));
test("attached F0066: yen unit wording correction may remove the 100 token", !suggestionChangesNumericOrDateTokens({
  category: "grammar", issue_scope: "english_proofreading",
  quote: "(In 100 millions of yen)",
  suggestion: "(In hundreds of millions of yen)",
}));
test("unit wording exception does not permit an arbitrary amount change", suggestionChangesNumericOrDateTokens({
  category: "grammar", issue_scope: "english_proofreading",
  quote: "Net income 100 millions of yen",
  suggestion: "Net income 200 millions of yen",
}));
test("unit wording exception applies only to the complete In-header", suggestionChangesNumericOrDateTokens({
  category: "grammar", issue_scope: "english_proofreading",
  quote: "Note: (In 100 millions of yen)",
  suggestion: "Note: (In hundreds of millions of yen)",
}));
test("F0066 unit wording exception rejects singular hundred", suggestionChangesNumericOrDateTokens({
  category: "grammar", issue_scope: "english_proofreading",
  quote: "(In 100 millions of yen)",
  suggestion: "(In hundred of millions of yen)",
}));
test("F0066 unit wording exception rejects singular million", suggestionChangesNumericOrDateTokens({
  category: "grammar", issue_scope: "english_proofreading",
  quote: "(In 100 millions of yen)",
  suggestion: "(In hundreds of million of yen)",
}));
test("attached F0049: Japanese instruction containing FY/date tokens is an action, not a replacement", !suggestionChangesNumericOrDateTokens({
  category: "omission", issue_scope: "translation_consistency",
  quote: "FY2025 FY2026 March 31, 2025 March 31, 2026",
  suggestion: "FY2025とFY2026の各列に、期首日から期末日までの対象期間を記載する。",
}));
test("explicit action kind bypasses numeric replacement guard even for an English instruction", !suggestionChangesNumericOrDateTokens({
  category: "omission", suggestion_kind: "action",
  quote: "Part 4", suggestion: "Part 3へ修正する。",
}));
const normalizedGrammarFinding = normalizeSuggestionIntegrityFinding(grammarNumberLeak);
const normalizedAgain = normalizeSuggestionIntegrityFinding(normalizedGrammarFinding);
test("common finding normalization suppresses unsafe suggestion and preserves the finding", normalizedGrammarFinding.suggestion_integrity === "numeric-token-change"
  && normalizedGrammarFinding.suggestion_original === grammarNumberLeak.suggestion
  && normalizedGrammarFinding.suggestion.endsWith("再生成してください。")
  && normalizedGrammarFinding.needs_human_review === true
  && String(normalizedGrammarFinding.quality_warning || "").includes("元の修正案は、数値・日付・固有名詞を変更していたため破棄しました。現在表示しているのは置き換え文ではなく"));
test("common suggestion normalization is idempotent for ZIP/JSON/CSV paths", normalizedAgain.suggestion === normalizedGrammarFinding.suggestion
  && normalizedAgain.suggestion_original === normalizedGrammarFinding.suggestion_original
  && normalizedAgain.quality_warning === normalizedGrammarFinding.quality_warning);
const normalizedSectionCorrection = normalizeSuggestionIntegrityFinding(translatedSectionCorrection);
test("section correction survives the shared import/export normalization boundary", normalizedSectionCorrection.suggestion === translatedSectionCorrection.suggestion
  && !normalizedSectionCorrection.suggestion_integrity);
const normalizedUnitCorrection = normalizeSuggestionIntegrityFinding({
  category: "grammar", issue_scope: "english_proofreading",
  quote: "(In 100 millions of yen)",
  suggestion: "(In hundreds of millions of yen)",
});
test("unit wording correction survives the shared import/export normalization boundary", normalizedUnitCorrection.suggestion === "(In hundreds of millions of yen)"
  && !normalizedUnitCorrection.suggestion_integrity);
const normalizedAction = normalizeSuggestionIntegrityFinding({
  category: "omission", issue_scope: "translation_consistency",
  quote: "FY2025 FY2026 March 31, 2025 March 31, 2026",
  suggestion: "FY2025とFY2026の各列に、期首日から期末日までの対象期間を記載する。",
});
test("action instruction survives the shared import/export normalization boundary", normalizedAction.suggestion === "FY2025とFY2026の各列に、期首日から期末日までの対象期間を記載する。"
  && !normalizedAction.suggestion_integrity);
const legacyMarkedUnsafe = normalizeSuggestionIntegrityFinding({
  quote: grammarNumberLeak.quote,
  suggestion: grammarNumberLeak.suggestion,
  suggestion_integrity: "numeric-token-change",
});
test("legacy marked payload cannot resurrect an unsafe suggestion", legacyMarkedUnsafe.suggestion.endsWith("再生成してください。")
  && legacyMarkedUnsafe.suggestion_original === grammarNumberLeak.suggestion
  && legacyMarkedUnsafe.needs_human_review === true);

const roundedInvestingCashFlow = {
  id: "F0008", page: 6, category: "value_inconsistency", issue_scope: "consistency",
  quote: "Net cash used in investing activities was ¥0.9 billion",
  quote_variants: [
    "Net cash used in investing activities was ¥906 billion",
    "Net cash used in investing activities was ¥0.9 billion",
  ],
  reason: "P.6は2026年3月期の投資活動によるネット・キャッシュ・フローを負の¥906 billionとしているが、P.1の「Consolidated Cash Flows」では同じ2026年3月31日終了年度の「Cash Flows from Investing Activities」が(868) millions of yenである。両方とも連結、FY2026、投資活動によるキャッシュ・フロー、負の金額を示し、通貨とscaleも各箇所で明示されている。",
};
roundedInvestingCashFlow.model_reason = roundedInvestingCashFlow.reason;
test("attached F0008: source-selected 0.9 billion overlaps explicit (868) million and DROPs",
  drops(roundedInvestingCashFlow));
test("F0008 safety: an amount outside the displayed rounding interval remains KEEP", !drops({
  ...roundedInvestingCashFlow,
  reason: roundedInvestingCashFlow.reason.replace("(868)", "(951)"),
  model_reason: roundedInvestingCashFlow.reason.replace("(868)", "(951)"),
}));

const roundedNetIncome = {
  id: "F0020", page: 5, category: "value_inconsistency", issue_scope: "consistency",
  quote: "Net income attributable 114.1 35.1 (79.0) (69.2)% to owners of the parent",
  reason: "P.5の「Consolidated financial results」は単位が「In billion yen」で、FY2025 Full YearのNet income attributable to owners of the parentを114.1としている。一方、P.1の「Consolidated Financial Highlights」は単位が「millions of yen」で、FY2025の同指標を114,079としている。",
  suggestion: "FY2025親会社株主に帰属する当期純利益について、P.1の114,079とP.5の114.1のどちらが正しいか確認する。",
};
roundedNetIncome.model_reason = `${roundedNetIncome.reason}\n（同じ箇所の別案: FY2026の35,086と35.1を確認する。）`;
test("attached F0020: canonical unit proof ignores merged alternatives and suggestion restatement",
  drops(roundedNetIncome));
test("F0020 safety: a contradictory suggestion amount remains KEEP", !drops({
  ...roundedNetIncome, suggestion: roundedNetIncome.suggestion.replace("114,079", "114,080"),
}));

const resultVector = {
  id: "F0055", category: "number_mismatch", issue_scope: "translation_consistency",
  quote: "Net sales 5,018.9 4,918.2 (100.7) (2.0)% Operating income 186.1 51.6 (134.5) (72.3)% Ordinary income 189.0 131.8 (57.2) (30.2)%",
  reference_quote: "売上高 50,189 49,182 △1,007 △2.0% 営業利益 1,861 516 △1,345 △72.3% 経常利益 1,890 1,318 △572 △30.2%",
};
const resultContext = {
  targetRowUnique: true, referenceRowUnique: true,
  targetText: "(In billion yen)\nNet sales 5,018.9 4,918.2 (100.7) (2.0)%\nOperating income 186.1 51.6 (134.5) (72.3)%\nOrdinary income 189.0 131.8 (57.2) (30.2)%",
  referenceText: "(単位：億円)\n売上高 50,189 49,182 △1,007 △2.0%\n営業利益 1,861 516 △1,345 △72.3%\n経常利益 1,890 1,318 △572 △30.2%",
  targetRowText: resultVector.quote,
  referenceRowText: resultVector.reference_quote,
  targetRowLines: [
    "Net sales 5,018.9 4,918.2 (100.7) (2.0)%",
    "Operating income 186.1 51.6 (134.5) (72.3)%",
    "Ordinary income 189.0 131.8 (57.2) (30.2)%",
  ],
  referenceRowLines: [
    "売上高 50,189 49,182 △1,007 △2.0%",
    "営業利益 1,861 516 △1,345 △72.3%",
    "経常利益 1,890 1,318 △572 △30.2%",
  ],
};
test("attached F0055: three-row billion/億円 vector is DROP", drops(resultVector, resultContext));
test("F0055 safety: one changed source value remains KEEP", !drops({
  ...resultVector,
  reference_quote: resultVector.reference_quote.replace("1,318", "1,319"),
}, {
  ...resultContext,
  referenceRowText: resultContext.referenceRowText.replace("1,318", "1,319"),
  referenceRowLines: resultContext.referenceRowLines.map(line => line.replace("1,318", "1,319")),
}));

const forecastVector = {
  id: "F0057", category: "number_mismatch", issue_scope: "translation_consistency",
  quote: "Net Sales 5,500.0 11.8 % Operating Income 150.0 190.8 % Ordinary Income 140.0 6.2 % Net Income Attributable 90.0 156.5 % to Owners of the parent",
  reference_quote: "売上高 55,000 +11.8% 営業利益 1,500 +190.8% 経常利益 1,400 +6.2% 親会社株主に帰属する 900 +156.5% 当期純利益",
};
const forecastContext = {
  targetRowUnique: true, referenceRowUnique: true,
  targetText: "(In billion yen)\nNet Sales 5,500.0 11.8 %\nOperating Income 150.0 190.8 %\nOrdinary Income 140.0 6.2 %\nNet Income Attributable\n90.0 156.5 %",
  referenceText: "連結業績 (単位：億円) グローバル販売台数 (単位：千台)\n売上高 55,000 +11.8％ 日本 153 +6.1％\n営業利益 1,500 +190.8％ 北米 629 +8.1％\n経常利益 1,400 +6.2％ 欧州 197 +20.5％\n親会社株主に帰属する\n900 +156.5％ 中国 71 △0.6％",
  targetRowText: "Net Sales 5,500.0 11.8 % Operating Income 150.0 190.8 % Ordinary Income 140.0 6.2 % Net Income Attributable 90.0 156.5 %",
  referenceRowText: "売上高 55,000 +11.8％ 日本 153 +6.1％ 営業利益 1,500 +190.8％ 北米 629 +8.1％ 経常利益 1,400 +6.2％ 欧州 197 +20.5％ 親会社株主に帰属する 900 +156.5％ 中国 71 △0.6％",
  targetRowLines: [
    "Net Sales 5,500.0 11.8 %",
    "Operating Income 150.0 190.8 %",
    "Ordinary Income 140.0 6.2 %",
    "Net Income Attributable",
    "90.0 156.5 %",
  ],
  referenceRowLines: [
    "売上高 55,000 +11.8％ 日本 153 +6.1％",
    "営業利益 1,500 +190.8％ 北米 629 +8.1％",
    "経常利益 1,400 +6.2％ 欧州 197 +20.5％",
    "親会社株主に帰属する",
    "900 +156.5％ 中国 71 △0.6％",
  ],
};
test("attached F0057: mixed-caption side-by-side forecast selects 億円 vector and DROPs", drops(forecastVector, forecastContext));
test("F0057 safety: selecting adjacent vehicle-count value remains KEEP", !drops({
  ...forecastVector,
  reference_quote: forecastVector.reference_quote.replace("55,000", "153"),
}, forecastContext));

const attachedF0077 = {
  id: "F0077", category: "number_mismatch", issue_scope: "translation_consistency",
  quote: "Dividends paid (37,812) (37,812)",
  reference_quote: "剰余金の配当 △37,812 △37,812",
};
const attachedF0079 = {
  id: "F0079", category: "number_mismatch", issue_scope: "translation_consistency",
  quote: "Dividends paid (34,680) (34,680)",
  reference_quote: "剰余金の配当 △34,680 △34,680",
};
const attachedF0083 = {
  id: "F0083", category: "number_mismatch", issue_scope: "translation_consistency",
  quote: "43 48,783 47,144",
  reference_quote: "従業員数(就業人員) (人) 43 48,783 47,144",
};
test("attached F0077: parentheses and △ negative vector is DROP", drops(attachedF0077));
test("attached F0079: identical dividend amount is DROP", drops(attachedF0079));
const attachedF0083Context = {
  targetRowUnique: true, referenceRowUnique: true,
  targetText: "(人)\nEmployee count 43 48,783 47,144",
  referenceText: "(人)\n従業員数(就業人員) (人) 43 48,783 47,144",
  targetRowText: "Employee count 43 48,783 47,144",
  referenceRowText: "従業員数(就業人員) (人) 43 48,783 47,144",
};
test("attached F0083: row number plus two identical employee values is DROP",
  drops(attachedF0083, attachedF0083Context));
test("F0083 safety: one employee value changed remains KEEP",
  !drops({ ...attachedF0083, reference_quote: attachedF0083.reference_quote.replace("47,144", "47,145") }, {
    ...attachedF0083Context,
    referenceText: attachedF0083Context.referenceText.replace("47,144", "47,145"),
    referenceRowText: attachedF0083Context.referenceRowText.replace("47,144", "47,145"),
  }));

const attachedF0041 = {
  id: "F0041", category: "number_mismatch", issue_scope: "translation_consistency",
  quote: "Consolidated wholesales volume Overseas FY2025 458",
  reference_quote: "連結卸売台数 海外 FY2025 459",
};
test("attached P.26 row 41: Overseas FY2025 458 vs 459 remains KEEP", !drops(attachedF0041));

const stalePageFinding = {
  ...forecastVector, page: 7, reference_pages: [3], reference_file: "REF1_reference.pdf",
};
const referencePages = new Map([
  [3, "table of contents only"],
  [6, forecastContext.referenceText],
]);
const recovered = await collectNumericFindingContexts([stalePageFinding], {
  targetTextFor: page => page === 7 ? forecastContext.targetText : "",
  referenceTextFor: (_ref, page) => referencePages.get(page) || "",
  referenceSourceFor: () => ({ id: "ref-1" }),
  referencePageCount: 6,
});
test("stale reported REF page falls back to a document-unique quote", recovered.has("F0057"));
referencePages.set(5, forecastContext.referenceText);
const ambiguous = await collectNumericFindingContexts([stalePageFinding], {
  targetTextFor: page => page === 7 ? forecastContext.targetText : "",
  referenceTextFor: (_ref, page) => referencePages.get(page) || "",
  referenceSourceFor: () => ({ id: "ref-1" }),
  referencePageCount: 6,
});
test("document scan with the same quote on two pages fails closed", !ambiguous.has("F0057"));

if (failures) {
  console.error(`\nTest-AttachedResultRegression: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-AttachedResultRegression: PASS");
