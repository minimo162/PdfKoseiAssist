// Regression coverage for issue #126.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const identicalMismatch = new Function(
  `${extractFunction("isUnmaskedIdenticalNumericMismatchFinding")}; return isUnmaskedIdenticalNumericMismatchFinding;`,
)();

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
