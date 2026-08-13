import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(".github/workflows/windows-tests.yml");
const workflow = readFileSync(workflowPath, "utf8");

const dependencyInstall = workflow.indexOf("npm install --no-save playwright");
const browserInstall = workflow.indexOf("npx playwright install chromium");
const headlessRun = workflow.indexOf("./tools/Run-Tests.ps1 -Suite headless-integration -DisallowSkips");

if (dependencyInstall < 0) {
  throw new Error("Playwright dependency install is missing from the Windows workflow");
}
if (browserInstall < 0) {
  throw new Error("Playwright Chromium install is missing from the Windows workflow");
}
if (!(dependencyInstall < browserInstall && browserInstall < headlessRun)) {
  throw new Error("Playwright and Chromium must be installed before headless integration tests run");
}

console.log("Test-WindowsWorkflow: PASS");
