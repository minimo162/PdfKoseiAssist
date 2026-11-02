// Regression coverage for issue #126.
// The predicate is shared with index.html through js/finding-quality.mjs (2026-11-02).
import { isUnmaskedIdenticalNumericMismatchFinding as identicalMismatch } from "../js/finding-quality.mjs";

const failures = [];
const check = (name, condition) => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}`); failures.push(name); }
};

check("FY labels do not hide a restored 500-to-500 mismatch", identicalMismatch({
  category: "value_inconsistency",
  issueSummary: "FY2026/3の通期連結営業利益について、500と500のどちらが正しいか確認する。",
}));
check("restored 347-to-347 mismatch is detected", identicalMismatch({
  category: "translation_consistency",
  suggestion: "347と347のどちらが正しいか確認し、該当箇所を統一する。",
}));
check("two identical regional value sequences are detected", identicalMismatch({
  category: "translation_consistency",
  reason: "USA (413)、Japan (307)であり、要約文のUSA (413)、Japan (307)とすべて異なる。",
}));
check("a real 500-to-600 discrepancy remains actionable", !identicalMismatch({
  category: "value_inconsistency", issueSummary: "500と600が不一致である。",
}));
check("ordinary repeated numbers without a mismatch claim are ignored", !identicalMismatch({
  category: "grammar", reason: "500は本文と表の両方に500として記載されている。",
}));

if (failures.length) process.exit(1);
console.log("\nTest-Issue126Regression: PASS");
