import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateKnownRealCases } from "../js/known-real-evaluator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "..", "docs", "benchmarks", "fixtures", "known-real-cases.json"), "utf8"));
const cases = Array.isArray(fixture.cases) ? fixture.cases : [];
if (cases.length !== 6) throw new Error(`known-real-cases must contain 6 cases, got ${cases.length}`);
if (cases.filter(item => item.status === "confirmed").length !== 3) throw new Error("three confirmed cases are required");
if (cases.filter(item => item.status === "provisional").length !== 3) throw new Error("three provisional cases are required");
for (const item of cases) {
  if (!item.id || !item.category || !item.expected) throw new Error(`fixture metadata is incomplete: ${item.id}`);
  if (item.category !== "translation" && !String(item.text || "").trim()) throw new Error(`fixture text is missing: ${item.id}`);
  if (!["accepted", "accepted_or_needs_review"].includes(item.expected)) throw new Error(`unexpected expected state: ${item.id}`);
}

const unmeasured = evaluateKnownRealCases({ cases });
if (unmeasured.status !== "unmeasured" || unmeasured.gates.confirmed_detection || unmeasured.gates.confirmed_highlight) {
  throw new Error("known-case evaluator must fail closed without an observed run");
}
const syntheticFindings = cases.map(item => ({
  id: "F-" + item.id,
  known_case_id: item.id,
  decision_state: item.status === "confirmed" ? "accepted" : "needs_review",
  highlight_status: item.status === "confirmed" ? "ok" : "pending",
  highlight_boxes: item.status === "confirmed" ? [{ x: 10, y: 10, w: 20, h: 5 }] : [],
}));
const textMatched = evaluateKnownRealCases({
  cases,
  findings: [{ id: "F-TEXT", quote: cases[0].text, decision_state: "accepted", highlight_status: "ok", highlight_boxes: [{ x: 1, y: 1, w: 2, h: 2 }] }],
  observedRun: true,
});
if (!textMatched.cases[0].detected || !textMatched.cases[0].highlighted) {
  throw new Error("known-case evaluator did not match a finding by its fixture text");
}
const measured = evaluateKnownRealCases({ cases, findings: syntheticFindings, observedRun: true });
if (measured.status !== "pass"
  || !measured.gates.confirmed_detection
  || !measured.gates.confirmed_highlight
  || !measured.gates.provisional_review) {
  throw new Error("synthetic known-case evaluation did not pass: " + JSON.stringify(measured));
}
const missingHighlight = evaluateKnownRealCases({
  cases,
  findings: syntheticFindings.map((finding, index) => index === 0 ? { ...finding, highlight_status: "pending", highlight_boxes: [] } : finding),
  observedRun: true,
});
if (missingHighlight.status !== "fail"
  || missingHighlight.gates.confirmed_detection !== true
  || missingHighlight.gates.confirmed_highlight !== false) {
  throw new Error("known-case highlight gate did not fail closed");
}
console.log("Test-KnownRealCases: PASS (6 cases / 3 confirmed / 3 provisional / evaluator contract)");
