// Regression coverage for issue #156: amounts must not be sent to Copilot
// unmasked.
//
//   node tools/Test-Issue156Regression.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Masker, maskSidecarByRole, verify } from "../js/number-mask.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf8");
function extractFunction(name) {
  const start = indexHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = indexHtml.indexOf(") {", start) + 2; i < indexHtml.length; i++) {
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

// --- 1. small values at the end of table rows ---
{
  const sidecar =
    "===== PDF P.9 / TARGET_CHECK / 元PDF P.9 / en.pdf =====\n" +
    "Consolidated Statements of Comprehensive Income (Millions of yen)\n" +
    "Profit 1,234 1,456\n" +
    "Valuation difference on available-for-sale securities 45 (12)\n" +
    "Foreign currency translation adjustment (38) (7)\n" +
    "Remeasurements of defined benefit plans, net of tax 3 (5)\n" +
    "Total other comprehensive income 10 (24)\n" +
    "Depreciation (70)\nDividends per share are 50 yen.\n" +
    "===== PDF P.9 / REF1_CANDIDATE / 元PDF P.9 / ja.pdf =====\n" +
    "地域別販売台数（単位：千台）\n" +
    "北米 147 154 +7\n" +
    "日本 32 33 +1\n" +
    "北米 144 216 △11\n" +
    "日本 92 243 △40\n";
  const out = maskSidecarByRole(sidecar, new Masker(5));
  check("伏字化した表テストが verify を通る", verify(out).ok);
  for (const leaked of ["(12)", "(7)", "(5)", "(24)", "(70)", "+7\n", "△11\n"]) {
    check(`行末の値 ${JSON.stringify(leaked)} を平文で送らない`, !out.includes(leaked), out);
  }
}

// --- allowed structure and dates stay readable on the same line ---
{
  const m = new Masker(9);
  const ja = maskSidecarByRole("===== PDF P.2 / REF1_CANDIDATE / 元PDF P.2 / ja.pdf =====\n(1) 監視、(2) 予防\n2026年3月31日現在\n", m);
  check("同じ行の項番 (1) (2) は従来どおり残す", ja.includes("(1) 監視") && ja.includes("(2) 予防"), ja);
  check("同じ行の月日は従来どおり残す", ja.includes("3月31日"), ja);
  const en = maskSidecarByRole("===== PDF P.2 / TARGET_CHECK / 元PDF P.2 / en.pdf =====\n(1) Overview of results\n", m);
  check("行頭の見出し番号 (1) は従来どおり残す", en.includes("(1) Overview"), en);
}

// --- 2. the round-2 digest is never sent unmasked ---
{
  const build = (jobMasker, findings) => new Function("scope", `with (scope) { ${extractFunction("priorFindingsDigest")}; return priorFindingsDigest; }`)({
    MASKING_ENABLED: true, jobMasker, findings, verifyMask: verify, console,
  });
  const findings = [{ page: 1, quote: "Net sales were 458,921 million yen, up 7.2%." },
    { page: 3, quote: "Operating profit decreased 3,860 million yen (12.5%)" }];
  const resumed = build(null, findings)();
  check("辞書が無い再開経路では既出一覧を送らない", resumed === "", resumed);
  const normal = build(new Masker(3), findings)();
  check("通常の2巡目は伏字化した既出一覧を送る", normal.includes("⟦#") && !normal.includes("458,921") && verify(normal).ok, normal);
}

if (failures.length) {
  console.error(`\nTest-Issue156Regression: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nTest-Issue156Regression: PASS");
