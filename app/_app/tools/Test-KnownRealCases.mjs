import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
console.log("Test-KnownRealCases: PASS (6 cases / 3 confirmed / 3 provisional)");
