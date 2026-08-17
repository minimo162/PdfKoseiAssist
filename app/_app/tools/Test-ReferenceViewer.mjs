// REF1/REF2 source resolution and removal behavior.
import {
  hasReferenceEvidence,
  resolveReferenceSelector,
  resolveReferenceForFinding,
  sourceForFinding,
  sourceForComparisonToggle,
  referenceSelectionAfterRemoval,
} from "../js/reference-viewer.mjs";

let failures = 0;
const t = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
};

const refs = [
  { id: "ref_one", fileName: "japanese.pdf" },
  { id: "ref_two", fileName: "source.pdf" },
];

{
  t("REF1_filename形式をREF1へ解決", resolveReferenceSelector(refs, "REF1_japanese.pdf") === refs[0]);
  t("REF2_filename形式をREF2へ解決", resolveReferenceSelector(refs, "REF2_source.pdf") === refs[1]);
  t("生ファイル名をREF2へ解決", resolveReferenceSelector(refs, "source.pdf") === refs[1]);
  t("内部IDをREF1へ解決", resolveReferenceSelector(refs, "reference:ref_one") === refs[0]);
}

{
  const fileOnly = { referenceFile: "REF1_japanese.pdf" };
  const empty = {};
  const targetHighlightOnly = { highlightPage: 9, highlightPages: [10] };
  t("referenceFileだけでは参照位置の根拠にならない", !hasReferenceEvidence(fileOnly));
  t("空の指摘には参照位置の根拠がない", !hasReferenceEvidence(empty));
  t("対象PDF側の汎用highlightページだけでは比較根拠にならない", !hasReferenceEvidence(targetHighlightOnly));
  t("referencePageは参照位置の根拠になる", hasReferenceEvidence({ referencePage: 5 }));
  t("referencePages配列は参照位置の根拠になる", hasReferenceEvidence({ referencePages: [0, 7] }));
  t("normalized highlight pageは参照位置の根拠になる", hasReferenceEvidence({ reference_highlight_page: 9 }));
  t("referenceQuoteは参照位置の根拠になる", hasReferenceEvidence({ referenceQuote: "売上高" }));
  t("file-only指摘は比較モードでも対象PDFへ戻す", sourceForFinding(refs, fileOnly, "reference:ref_one") === "target");
  t("file-only指摘は比較タブ切替でも対象PDFへ戻す", sourceForComparisonToggle(refs, "ref_one", fileOnly) === "target");
  t("空の指摘は比較モードでも対象PDFへ戻す", sourceForFinding(refs, empty, "reference:ref_one") === "target");
  t("参照位置のある指摘はreferenceFileで比較資料を解決する", sourceForFinding(refs, { referenceFile: "REF2_source.pdf", referencePage: 7 }, "reference") === "reference:ref_two");
  t("ページだけの参照根拠は比較タブで解決できる", sourceForComparisonToggle(refs, "ref_two", { referenceFile: "REF2_source.pdf", referencePage: 7 }) === "reference:ref_two");
  t("quoteだけの参照根拠は比較タブで解決できる", sourceForComparisonToggle(refs, "ref_two", { referenceFile: "REF2_source.pdf", referenceQuote: "Net sales" }) === "reference:ref_two");
  t("activeなしの比較タブは手動選択を保持する", sourceForComparisonToggle(refs, "ref_two", null) === "reference:ref_two");
}

{
  const f1 = { referenceFile: "REF1_japanese.pdf", referencePage: 5, referenceQuote: "売上高" };
  const f2 = { referenceFile: "REF2_source.pdf", referencePage: 7, referenceQuote: "Net sales" };
  t("REF1指摘のreferenceFileを優先", resolveReferenceForFinding(refs, f1) === refs[0]);
  t("REF2指摘のreferenceFileを優先", resolveReferenceForFinding(refs, f2) === refs[1]);
  t("比較モードでREF2指摘をREF2へ自動選択", sourceForFinding(refs, f2, "reference") === "reference:ref_two");
  t("対象モードでは指摘のREFに切り替えない", sourceForFinding(refs, f2, "target") === "target");
  t("削除済み／未知のreferenceFileは別REFへ誤fallbackしない", sourceForFinding(refs, { referenceFile: "REF3_missing.pdf" }, "reference:ref_one") === "target");
  t("手動選択したREF2は対象PDF経由でも比較へ保持", sourceForComparisonToggle(refs, "ref_two", f1) === "reference:ref_two");
}

{
  const active = referenceSelectionAfterRemoval(refs, "reference:ref_two", "ref_two");
  t("現表示中REF2が残っていれば維持", active.source === "reference:ref_two" && !active.changed);
  const afterRemoval = referenceSelectionAfterRemoval([refs[0]], "reference:ref_two", "ref_two");
  t("表示中REF2が削除されたら対象PDFへ戻す", afterRemoval.source === "target" && afterRemoval.referenceId === "" && afterRemoval.changed);
  const target = referenceSelectionAfterRemoval([refs[0]], "target", "ref_two");
  t("対象PDF表示中に最後のREFが削除されたら保持先を更新", target.source === "target" && target.referenceId === "ref_one");
}

if (failures) {
  console.error(`\nTest-ReferenceViewer: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nTest-ReferenceViewer: PASS");
