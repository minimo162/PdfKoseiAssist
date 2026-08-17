// REF1/REF2 source resolution and removal behavior.
import {
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
