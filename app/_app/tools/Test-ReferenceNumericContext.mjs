// Exact F0017 raw fixture (REF1) -> old UI-equivalent coerce/mask/context baseline -> canonical aliases.
// The baseline intentionally preserves the production snake_case shape. It proves whether
// the reported F0017/REF1 path was already GREEN before this change.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalizeReferenceFinding, referencePageForFinding, resolveReferenceIndex } from "../js/finding-reference-context.mjs";
import { collectNumericFindingContexts } from "../js/numeric-source-context.mjs";
import { findUniqueNumericSourceContext, isConclusiveNumericFalsePositive, partitionNumericFalsePositives } from "../js/review-merge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const rawFixture = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-proofread-f0017.json"), "utf8"));
const pageText = JSON.parse(readFileSync(join(fixtureDir, "review-merge-live-q4-0840-page-text.json"), "utf8"));
const raw = rawFixture.findings[0];
const rawResponse = { ...rawFixture, findings: [raw] };
const rawFinding = rawResponse.findings[0];
const refs = [{ id: "ref-ja", fileName: "mazda_fy2026_ja.pdf" }];
const sourceForRef = (ref, page) => ref?.id === "ref-ja"
  ? pageText.pages.reference[String(page)] || ""
  : "";
const t = (name, condition) => {
  if (!condition) { console.error("  FAIL " + name); process.exitCode = 1; }
  else console.log("  ok   " + name);
};

const snakeKeys = ["reference_pages", "reference_page", "reference_file", "reference_quote"];
const finding = canonicalizeReferenceFinding(rawFinding);
t("raw responseからcanonical-only findingを作る", snakeKeys.every(key => !(key in finding))
  && Object.keys(finding).every(key => !key.includes("_")));
t("exact F0017のcanonical REFページはP.18", finding.referencePages.length === 1 && finding.referencePages[0] === 18);
t("exact F0017のcanonical REFファイルはREF1", finding.referenceFile === "REF1_mazda_fy2026_ja.pdf");
t("exact F0017のcanonical REF引用は630,349/630,779", finding.referenceQuote.includes("630,349 630,779"));
t("canonical REFページ解決はP.18", referencePageForFinding(finding) === 18);

// These helpers mirror the pre-fix main/index.html contracts exactly at the
// relevant boundary: snake-only page/quote normalization and reference resolver.
function oldNormalizeReferencePages(item) {
  const rawPages = item?.reference_pages ?? item?.ref_pages ?? item?.reference_page ?? item?.ref_page;
  if (Array.isArray(rawPages)) {
    return [...new Set(rawPages.map(Number).filter(n => Number.isFinite(n) && n > 0)
      .map(n => Math.round(n)))].sort((a, b) => a - b);
  }
  if (typeof rawPages === "string" && rawPages.trim()) {
    return [...new Set((rawPages.match(/\d+/g) || []).map(Number)
      .filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  }
  const n = Number(rawPages);
  return Number.isFinite(n) && n > 0 ? [Math.round(n)] : [];
}
function oldCoerceReferenceFinding(item) {
  const pages = oldNormalizeReferencePages(item);
  return {
    id: item.id || "F0017",
    page: Number(item.page),
    category: item.category,
    issueScope: item.issue_scope ?? item.issueScope ?? "",
    quote: item.quote || "",
    referencePages: pages,
    referencePage: pages[0] || null,
    referenceFile: item.reference_file ?? item.referenceFile ?? "",
    referenceQuote: item.reference_quote ?? item.ref_quote ?? "",
  };
}
function oldRestoreMaskedFindings(list) {
  // F0017 has no mask token. This is the old restore boundary's no-op result.
  return (list || []).map(item => ({ ...item }));
}
function oldReferenceIndex(record, references) {
  const wanted = String(record?.reference_file || "");
  const matched = references.findIndex((ref, i) =>
    wanted === ref.fileName || wanted === "REF" + (i + 1) + "_" + ref.fileName);
  return matched >= 0 ? matched : 0;
}
async function collectWithOldResolver(findings, calls) {
  // This is the old inline index.html collector: no shared alias helper.
  const contexts = new Map();
  const numericCategories = new Set(["number_mismatch", "value_inconsistency", "accounting_inconsistency", "numbers"]);
  for (const finding of findings || []) {
    const referenceQuote = String(finding?.referenceQuote || finding?.reference_quote || "");
    if (!numericCategories.has(String(finding?.category || "").toLowerCase())
        || !String(finding?.quote || "").trim() || !referenceQuote.trim()) continue;
    const targetSource = pageText.pages.target[String(finding.page)] || "";
    const ref = refs[oldReferenceIndex(finding, refs)];
    const referencePage = (finding.referencePages || []).map(Number).find(page => page >= 1)
      || Number(finding.referencePage) || 0;
    calls.push({ id: ref?.id || "", page: referencePage });
    const referenceSource = sourceForRef(ref, referencePage);
    const targetMatch = findUniqueNumericSourceContext(targetSource, finding.quote);
    const referenceMatch = findUniqueNumericSourceContext(referenceSource, referenceQuote);
    if (targetMatch?.unique && referenceMatch?.unique) {
      contexts.set(String(finding.id || ""), {
        targetText: targetMatch.text,
        referenceText: referenceMatch.text,
        targetRowText: targetMatch.rowText,
        referenceRowText: referenceMatch.rowText,
        targetQuote: finding.quote,
        referenceQuote,
        targetRowUnique: true,
        referenceRowUnique: true,
      });
    }
  }
  return contexts;
}

// A: exact production-shaped F0017/REF1 through old coerce -> mask restore ->
// PDF.js page text context -> review-merge. This is an explicit old GREEN baseline.
const oldSnakeCoerced = oldCoerceReferenceFinding(rawFinding);
const oldSnakeRestored = oldRestoreMaskedFindings([oldSnakeCoerced]);
const oldBaselineCalls = [];
const oldBaselineContexts = await collectWithOldResolver(oldSnakeRestored, oldBaselineCalls);
const oldBaselineContext = oldBaselineContexts.get(oldSnakeCoerced.id);
const oldBaseline = partitionNumericFalsePositives(oldSnakeRestored, {
  forFinding: () => oldBaselineContext || {},
});
t("旧coerceはexact F0017/REF1のP.18を保持", oldSnakeCoerced.referencePages[0] === 18
  && oldSnakeCoerced.referenceQuote.includes("630,779"));
t("旧mask restore相当は未マスク引用を保持", oldSnakeRestored[0].quote === raw.quote
  && oldSnakeRestored[0].referenceQuote === raw.reference_quote);
t("修正前baseline: exact F0017/REF1は本文reader→unique context→DROP",
  oldBaselineCalls.some(call => call.id === "ref-ja" && call.page === 18)
    && Boolean(oldBaselineContext?.targetRowUnique && oldBaselineContext?.referenceRowUnique)
    && oldBaseline.kept.length === 0 && oldBaseline.dropped.length === 1);

// B/C: exact values and REF1 are unchanged, but a canonical camel-only intake
// crosses the alias boundary that old main/index.html did not normalize.
const camelRaw = { ...raw };
for (const key of snakeKeys) delete camelRaw[key];
Object.assign(camelRaw, {
  referencePages: [18],
  referencePage: 18,
  referenceFile: "REF1_mazda_fy2026_ja.pdf",
  referenceQuote: raw.reference_quote,
});
const oldCamelCoerced = oldCoerceReferenceFinding(camelRaw);
const oldCamelCalls = [];
const oldCamelContexts = await collectWithOldResolver([oldCamelCoerced], oldCamelCalls);
const oldCamel = partitionNumericFalsePositives([oldCamelCoerced], {
  forFinding: () => oldCamelContexts.get(oldCamelCoerced.id) || {},
});
t("修正前RED: camel-only intakeは旧normalizerでREFページ/引用を失う",
  oldCamelCoerced.referencePages.length === 0
    && !oldCamelCoerced.referenceQuote
    && oldCamelCalls.length === 0
    && !oldCamelContexts.has(oldCamelCoerced.id)
    && oldCamel.kept.length === 1 && oldCamel.dropped.length === 0);

const camelFinding = canonicalizeReferenceFinding(camelRaw);
const camelCalls = [];
const camelContexts = await collectNumericFindingContexts([camelFinding], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (ref, page) => {
    camelCalls.push({ id: ref?.id || "", page });
    return sourceForRef(ref, page);
  },
  referenceSourceFor: record => refs[resolveReferenceIndex(record, refs)],
});
const camelContext = camelContexts.get(camelFinding.id);
const camelFiltered = partitionNumericFalsePositives([camelFinding], {
  forFinding: () => camelContext || {},
});
t("GREEN: camel-only aliasesをcanonical化しREF1 P.18 readerへ到達",
  camelFinding.referencePages[0] === 18
    && camelFinding.referenceFile === "REF1_mazda_fy2026_ja.pdf"
    && camelFinding.referenceQuote.includes("630,779")
    && camelCalls.some(call => call.id === "ref-ja" && call.page === 18));
t("GREEN: canonical camel-only exact値はunique context→DROP",
  Boolean(camelContext?.targetRowUnique && camelContext?.referenceRowUnique)
    && camelFiltered.kept.length === 0 && camelFiltered.dropped.length === 1);

// New shared path on the exact production snake_case fixture must remain GREEN,
// while the baseline above prevents claiming it was previously broken.
const targetCalls = [];
const referenceCalls = [];
const contexts = await collectNumericFindingContexts([finding], {
  targetTextFor: page => {
    targetCalls.push(page);
    return pageText.pages.target[String(page)] || "";
  },
  referenceTextFor: (ref, page) => {
    referenceCalls.push({ id: ref?.id || "", page });
    return sourceForRef(ref, page);
  },
  referenceSourceFor: record => refs[resolveReferenceIndex(record, refs)],
});
const context = contexts.get(finding.id);
t("GREEN: exact F0017/REF1 TARGET P.19/REF P.18 readerを呼ぶ",
  targetCalls.includes(19) && referenceCalls.some(call => call.id === "ref-ja" && call.page === 18));
t("GREEN: exact F0017/REF1本文行が双方一意", Boolean(context?.targetRowUnique && context?.referenceRowUnique));
const filtered = partitionNumericFalsePositives([finding], { forFinding: () => context || {} });
t("GREEN: exact F0017/REF1をreview-mergeで除外",
  filtered.kept.length === 0 && filtered.dropped.length === 1);

// Negative fixtures change the source text as well as the citation. Both sides
// must still bind uniquely before the fail-closed filter can make a decision.
const oneValueCase = pageText.negative_cases.f0017_one_value_difference;
const oneValueFinding = {
  ...finding,
  quote: rawFinding.quote.replace("630,779", "630,780"),
};
const oneValueContexts = await collectNumericFindingContexts([oneValueFinding], {
  targetTextFor: page => page === oneValueCase.target_page ? oneValueCase.target : "",
  referenceTextFor: (ref, page) => ref.id === "ref-ja" && page === oneValueCase.reference_page ? oneValueCase.reference : "",
  referenceSourceFor: () => refs[0],
});
const oneValueContext = oneValueContexts.get(finding.id);
t("真の1値差もTARGET/REF双方一意", Boolean(oneValueContext?.targetRowUnique && oneValueContext?.referenceRowUnique));
const oneValue = partitionNumericFalsePositives([oneValueFinding], {
  forFinding: () => oneValueContext || {},
});
t("真の1値差はKEEP", oneValue.kept.length === 1 && oneValue.dropped.length === 0);

const signCase = pageText.negative_cases.f0017_sign_difference;
const signFinding = {
  ...finding,
  referenceQuote: rawFinding.reference_quote.replace("630,349", "△630,349"),
};
const signContexts = await collectNumericFindingContexts([signFinding], {
  targetTextFor: page => page === signCase.target_page ? signCase.target : "",
  referenceTextFor: (ref, page) => ref.id === "ref-ja" && page === signCase.reference_page ? signCase.reference : "",
  referenceSourceFor: () => refs[0],
});
const signContext = signContexts.get(finding.id);
t("符号差もTARGET/REF双方一意", Boolean(signContext?.targetRowUnique && signContext?.referenceRowUnique));
const sign = partitionNumericFalsePositives([signFinding], {
  forFinding: () => signContext || {},
});
t("符号差はKEEP", sign.kept.length === 1 && sign.dropped.length === 0);

// Same-document consistency findings from the attached report have an empty
// reference_quote and model-authored page/reason text.  Without a validated
// counterpart source context, that prose must not authorize a numeric drop.
for (const [id, quote, reason] of [
  ["F0001", "営業利益は328億円(前年同期は461億円の損失)", "P.1の連結経営成績およびP.8の四半期連結損益計算書では、同じ2027年3月期第1四半期の連結営業利益が32,836である。P.4の328とは実量記号が異なる。"],
  ["F0005", "406億円の減少(前年同期は1,411億円の減少)となりました。", "P.10の四半期連結キャッシュ・フロー計算書では、2026年4月1日から2026年6月30日までの営業活動によるキャッシュ・フローが△40,552である。P.4の減少額406とは実量記号が異なる。両箇所の単位はそれぞれ億円と百万円だが、記号は単位換算後の実量に基づく。"],
]) {
  const sameDocument = {
    id, page: 4, issueScope: "consistency", category: "value_inconsistency",
    quote, referenceQuote: "", reason,
  };
  t(`${id}: source contextなしのreasonだけでは数値DROPしない`, !isConclusiveNumericFalsePositive(sameDocument, {}));
}

// Attached-report regressions: the values below are accepted only after the
// normal TARGET/REF source collector proves a unique same-measure row.
const sourceBoundReferences = [{ id: "ref-ja", fileName: "mazda_fy2026_ja.pdf" }];
async function sourceBoundNumericCase({ id, quote, referenceQuote, targetSource, referenceSource }) {
  const candidate = {
    id, page: 1, referencePages: [1], referencePage: 1, referenceFile: "REF1_mazda_fy2026_ja.pdf",
    category: "number_mismatch", issueScope: "translation_consistency", quote, referenceQuote,
  };
  const contexts = await collectNumericFindingContexts([candidate], {
    targetTextFor: () => targetSource,
    referenceTextFor: () => referenceSource,
    referenceSourceFor: () => sourceBoundReferences[0],
  });
  const sourceContext = contexts.get(id);
  const result = partitionNumericFalsePositives([candidate], { forFinding: () => sourceContext || {} });
  return { sourceContext, result };
}

const f8 = await sourceBoundNumericCase({
  id: "F0010", quote: "財務活動によるキャッシュ・フロー △25,713 △27,506",
  referenceQuote: "Financing cash flow (25,713) (27,506)",
  targetSource: "(単位：百万円)\n2025年6月30日\n財務活動によるキャッシュ・フロー △25,713 △27,506",
  referenceSource: "(Millions of yen)\nJune 30, 2025\nFinancing cash flow (25,713) (27,506)",
});
t("添付#8: △表記と括弧表記の同一ベクトルはsource-bound DROP",
  Boolean(f8.sourceContext?.targetRowUnique && f8.sourceContext?.referenceRowUnique)
    && f8.result.kept.length === 0 && f8.result.dropped.length === 1);

const f9 = await sourceBoundNumericCase({
  id: "F0011", quote: "現金及び現金同等物の四半期末残高 989,343 1,214,803",
  referenceQuote: "Cash and cash equivalents at quarter-end 989,343 1,214,803",
  targetSource: "(単位：百万円)\n2025年6月30日\n現金及び現金同等物の四半期末残高 989,343 1,214,803",
  referenceSource: "(Millions of yen)\nJune 30, 2025\nCash and cash equivalents at quarter-end 989,343 1,214,803",
});
t("添付#9: identical vectorはsource-bound DROP",
  Boolean(f9.sourceContext?.targetRowUnique && f9.sourceContext?.referenceRowUnique)
    && f9.result.kept.length === 0 && f9.result.dropped.length === 1);

for (const [id, quote, referenceQuote, targetLabel, referenceLabel] of [
  ["F0008", "借入額 700億円", "Loan Amount 70 billion yen", "借入額", "Loan Amount"],
  ["F0009", "期限前弁済総額 700億円", "Total amount of early repayment 70 billion yen", "期限前弁済総額", "Total amount of early repayment"],
]) {
  const amount = await sourceBoundNumericCase({
    id, quote, referenceQuote,
    targetSource: `(単位：億円)\n2026年6月30日\n${targetLabel} ${quote.match(/[0-9０-９]+億円/)?.[0] || "700億円"}`,
    referenceSource: `(billions of yen)\nJune 30, 2026\n${referenceLabel} 70 billion yen`,
  });
  t(`添付${id}: 億円/ billion yenの単位換算はsource-bound DROP`,
    Boolean(amount.sourceContext?.targetRowUnique && amount.sourceContext?.referenceRowUnique)
      && amount.result.kept.length === 0 && amount.result.dropped.length === 1);
}
const roundedNarrative = await sourceBoundNumericCase({
  id: "rounded-328", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円)\n2026年6月30日\n借入額 328億円",
  referenceSource: "(Millions of yen)\nJune 30, 2026\nLoan Amount 32,836百万円",
});
t("source-bound同一行・同期間なら丸めた328億円/32,836百万円をDROP",
  roundedNarrative.result.kept.length === 0 && roundedNarrative.result.dropped.length === 1);

const genuineAmount = await sourceBoundNumericCase({
  id: "genuine-700-vs-7", quote: "借入額 700億円", referenceQuote: "Loan Amount 7 billion yen",
  targetSource: "(単位：億円)\n2026年6月30日\n借入額 700億円",
  referenceSource: "(billions of yen)\nJune 30, 2026\nLoan Amount 7 billion yen",
});
t("700億円 vs 7 billion yenは真の差としてKEEP", genuineAmount.result.kept.length === 1 && genuineAmount.result.dropped.length === 0);

const signMismatch = await sourceBoundNumericCase({
  id: "sign-mismatch", quote: "借入額 △700億円", referenceQuote: "Loan Amount 70 billion yen",
  targetSource: "(単位：億円)\n2026年6月30日\n借入額 △700億円",
  referenceSource: "(billions of yen)\nJune 30, 2026\nLoan Amount 70 billion yen",
});
t("source-boundでも符号不一致はKEEP", signMismatch.result.kept.length === 1 && signMismatch.result.dropped.length === 0);

const metricMismatch = await sourceBoundNumericCase({
  id: "metric-mismatch", quote: "借入額 700億円", referenceQuote: "Total amount of early repayment 70 billion yen",
  targetSource: "(単位：億円)\n2026年6月30日\n借入額 700億円",
  referenceSource: "(billions of yen)\nJune 30, 2026\nTotal amount of early repayment 70 billion yen",
});
t("source-boundでも指標不一致はKEEP", metricMismatch.result.kept.length === 1 && metricMismatch.result.dropped.length === 0);

const periodMismatch = await sourceBoundNumericCase({
  id: "period-mismatch", quote: "借入額 700億円", referenceQuote: "Loan Amount 70 billion yen",
  targetSource: "(単位：億円)\n2026年6月30日\n借入額 700億円",
  referenceSource: "(billions of yen)\nJune 30, 2025\nLoan Amount 70 billion yen",
});
t("source-boundでも期間不一致はKEEP", periodMismatch.result.kept.length === 1 && periodMismatch.result.dropped.length === 0);

const explicitDateMismatch = await sourceBoundNumericCase({
  id: "explicit-date-mismatch", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円)\n2026年6月30日\n借入額 328億円",
  referenceSource: "(Millions of yen)\nSeptember 30, 2026\nLoan Amount 32,836百万円",
});
t("source-boundでも月日が異なる明示日付はKEEP",
  explicitDateMismatch.result.kept.length === 1 && explicitDateMismatch.result.dropped.length === 0);

const quarterMismatch = await sourceBoundNumericCase({
  id: "explicit-quarter-mismatch", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円)\n2026 Q1\n借入額 328億円",
  referenceSource: "(Millions of yen)\n2026 Q2\nLoan Amount 32,836百万円",
});
t("source-boundでも明示四半期が異なる行はKEEP",
  quarterMismatch.result.kept.length === 1 && quarterMismatch.result.dropped.length === 0);

const wordedQuarterMismatch = await sourceBoundNumericCase({
  id: "worded-quarter-mismatch", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円)\nfirst quarter FY2026\n借入額 328億円",
  referenceSource: "(Millions of yen)\nsecond quarter FY2026\nLoan Amount 32,836百万円",
});
t("source-boundでもfirst/second quarter FYの明示差はKEEP",
  wordedQuarterMismatch.result.kept.length === 1 && wordedQuarterMismatch.result.dropped.length === 0);

const oneSidedPrecisePeriod = await sourceBoundNumericCase({
  id: "one-sided-precise-period", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円)\n2026 Q1\n借入額 328億円",
  referenceSource: "(Millions of yen)\nFY2026\nLoan Amount 32,836百万円",
});
t("source-boundで片側だけ明示四半期の行はKEEP",
  oneSidedPrecisePeriod.result.kept.length === 1 && oneSidedPrecisePeriod.result.dropped.length === 0);

const citedRowDateMismatch = await sourceBoundNumericCase({
  id: "cited-row-date-mismatch", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円)\nSeptember 30, 2026\n前回の借入額\nJune 30, 2026\n借入額 328億円",
  referenceSource: "(Millions of yen)\nJune 30, 2026\nPrior loan amount\nSeptember 30, 2026\nLoan Amount 32,836百万円",
});
t("source-boundは引用行の月日を優先し、周辺の同じ日付に引きずられない",
  citedRowDateMismatch.result.kept.length === 1 && citedRowDateMismatch.result.dropped.length === 0);

const conflictingUnitCaptions = await sourceBoundNumericCase({
  id: "conflicting-unit-captions", quote: "借入額 328億円", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "(単位：億円) (単位：百万円) 2026年6月30日 借入額 328億円",
  referenceSource: "(Millions of yen)\nJune 30, 2026\nLoan Amount 32,836百万円",
});
t("source-boundでも同一行の競合単位captionはfail-closed KEEP",
  conflictingUnitCaptions.result.kept.length === 1 && conflictingUnitCaptions.result.dropped.length === 0);

const rowBoundUnit = await sourceBoundNumericCase({
  id: "row-bound-unit", quote: "借入額 328", referenceQuote: "Loan Amount 32,836百万円",
  targetSource: "単位：億円\n注記\n単位：百万円\n2026年6月30日\n借入額 328",
  referenceSource: "(Millions of yen)\nJune 30, 2026\nLoan Amount 32,836百万円",
});
t("source-boundでも引用行に最も近いunit captionを優先し、先頭の別captionを採用しない",
  rowBoundUnit.result.kept.length === 1 && rowBoundUnit.result.dropped.length === 0);

const missingPage = { ...finding, referencePages: [999], referencePage: 999 };
const missingContexts = await collectNumericFindingContexts([missingPage], {
  targetTextFor: page => pageText.pages.target[String(page)] || "",
  referenceTextFor: (ref, page) => sourceForRef(ref, page),
  referenceSourceFor: () => refs[0],
});
const missingContext = missingContexts.get(finding.id);
const missing = partitionNumericFalsePositives([missingPage], {
  forFinding: () => missingContext || {},
});
t("REF本文が取得できない場合はcontextなし", !missingContext);
t("REF本文欠落時はfail-closedでKEEP", missing.kept.length === 1 && missing.dropped.length === 0);

// --- #130 item 4: リテラル経路の境界検査・行連結の数字融合・大小文字 ---
t("#130 リテラル一致は長い数字列の途中で始まらない（21,100 の中の 1,100）",
  findUniqueNumericSourceContext("売上高 21,100 20,300\n営業利益 1,100 1,300", "1,100 20,300") === null);
t("#130 行連結で分断された数字（1 / 00）を 100 として束縛しない",
  findUniqueNumericSourceContext("Total assets 1\n00 million yen\nfoo", "100 million yen") === null);
t("#130 リテラル一致は後続の数字も拒否する（1000 の中の 100）",
  findUniqueNumericSourceContext("Net sales 1000\nOther 5", "Net sales 100") === null);
t("#130 normalizeQuote 済み（小文字）の引用でもリテラル経路が原文へ束縛する", (() => {
  const match = findUniqueNumericSourceContext("Net Sales FY2025 1,100 FY2026 1,200\nOther 5", "net sales fy2025 1,100");
  return Boolean(match?.unique) && /Net Sales FY2025 1,100$/.test(match.rowText);
})());
t("#130 境界が正しい通常の引用は従来どおり一意に束縛する", (() => {
  const match = findUniqueNumericSourceContext("売上高 21,100 20,300\n営業利益 1,100 1,300", "1,100 1,300");
  return Boolean(match?.unique) && match.rowLines.length === 1 && match.rowLines[0] === "営業利益 1,100 1,300";
})());

// --- #130 item 5: ページマーカー除外は NFKC で長さが変わる文字の後でも効く ---
t("#130 NFKCで伸びる文字（㈱）の後のＰ．12 は数値証拠にならない",
  findUniqueNumericSourceContext("㈱㈱ Ｐ．12 を参照\n売上高 100", "１２") === null
  && findUniqueNumericSourceContext("P.12 を参照\n売上高 100", "12") === null);

// --- #130 item 7: 報告ページに引用が複数回あるなら他ページへ束縛しない ---
{
  const rowFinding = {
    id: "F130-7", page: 1, category: "number_mismatch", issue_scope: "translation_consistency",
    quote: "Operating income 1,100 1,300", reference_quote: "営業利益 1,100 1,300",
    reference_pages: [3], reference_file: "REF1_reference.pdf",
  };
  // 報告ページ P.3 には同じ数値列が 2 回（単位語を挟むためリテラル一致ではなく
  // トークン一致）。文書走査のリテラル重複カウントには掛からず、従来は P.5 の
  // 一意行へ束縛され、別の表から数値抑制が authorize されていた。
  const referencePages = new Map([
    [3, "営業利益 1,100 百万円 1,300\n営業利益 1,100 百万円 1,300"],
    [5, "営業利益 1,100 1,300\n経常利益 900 950"],
  ]);
  const ambiguousReported = await collectNumericFindingContexts([rowFinding], {
    targetTextFor: page => page === 1 ? "Operating income 1,100 1,300\nOrdinary income 900 950" : "",
    referenceTextFor: (_ref, page) => referencePages.get(page) || "",
    referenceSourceFor: () => ({ id: "ref-130" }),
    referencePageCount: 5,
  });
  t("#130 報告ページで非ユニークな引用は他ページの一意行へ束縛しない（fail-closed）",
    !ambiguousReported.has("F130-7"));
  const staleReported = await collectNumericFindingContexts([rowFinding], {
    targetTextFor: page => page === 1 ? "Operating income 1,100 1,300\nOrdinary income 900 950" : "",
    referenceTextFor: (_ref, page) => page === 3 ? "table of contents only" : (referencePages.get(page) || ""),
    referenceSourceFor: () => ({ id: "ref-130" }),
    referencePageCount: 5,
  });
  t("#130 報告ページに引用が無い（stale）場合は従来どおり文書走査で束縛する",
    staleReported.has("F130-7"));
}

if (process.exitCode) {
  console.error("\nTest-ReferenceNumericContext: FAIL");
  process.exit(1);
}
console.log("\nTest-ReferenceNumericContext: PASS");
