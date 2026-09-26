// Generated report launcher smoke test.
// It evaluates the launcher builders from index.html, starts the bundled
// PowerShell server without opening a browser, and verifies loopback delivery.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const root = join(import.meta.dirname, "..");
const lines = readFileSync(join(root, "index.html"), "utf8").split(/\r?\n/);

function functionSource(signature, nextSignature) {
  const start = lines.findIndex((line) => line.includes(signature));
  if (start < 0) throw new Error(`Missing function: ${signature}`);
  const next = lines.findIndex((line, index) => index > start && line.includes(nextSignature));
  if (next < 0) throw new Error(`Missing next function: ${nextSignature}`);
  return lines.slice(start, next).join("\n").trimEnd();
}

const builders = eval(`(function () {
  ${functionSource("function buildReportServerPs1Text(", "function buildReportOpenCmdText(")}
  ${functionSource("function buildReportOpenCmdText(", "async function buildHtmlReportZipInBrowser(")}
  return { buildReportServerPs1Text, buildReportOpenCmdText };
})()`);

const serverText = builders.buildReportServerPs1Text();
const cmdText = builders.buildReportOpenCmdText();
if (!serverText.includes("[Net.IPAddress]::Loopback")) throw new Error("Server is not bound to loopback");
if (!cmdText.includes('report-server.ps1')) throw new Error("CMD does not start the bundled server");
if (/start\s+""\s+"%REPORT%"/i.test(cmdText)) throw new Error("CMD still opens the HTML file directly");
// The report HTML lives in _data (#203); folders made earlier keep it at the top. Either one opens.
if (!cmdText.includes('if not exist "%~dp0_data\\*.html" if not exist "%~dp0*.html" goto :missing')) {
  throw new Error("CMD does not look for the report HTML in both _data and the top of the folder");
}

// Run the .cmd's existence checks with cmd.exe. The line that starts the server is swapped for an
// echo so that no browser opens.
function cmdFinds(layout) {
  const dir = mkdtempSync(join(tmpdir(), `kosei-report-cmd-${layout}-`));
  try {
    mkdirSync(join(dir, "_data"));
    writeFileSync(join(dir, "_data", "report-server.ps1"), "");
    if (layout === "current") writeFileSync(join(dir, "_data", "report.html"), "");
    if (layout === "legacy") writeFileSync(join(dir, "report.html"), "");
    const probe = cmdText.replace(/^start "" powershell\.exe .*$/m, "echo FOUND");
    if (probe === cmdText) throw new Error("CMD start line was not found");
    writeFileSync(join(dir, "open.cmd"), probe);
    const result = spawnSync("cmd.exe", ["/d", "/c", join(dir, "open.cmd")], { input: "\r\n", encoding: "utf8", windowsHide: true });
    return result.status === 0 && result.stdout.includes("FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (!cmdFinds("current")) throw new Error("CMD does not open a report kept in _data");
if (!cmdFinds("legacy")) throw new Error("CMD does not open a report kept at the top (older result folders)");
if (cmdFinds("none")) throw new Error("CMD starts even though no report HTML exists");

// layout "current":指摘レポートを開く.cmd + _data/{指摘レポート.html, report-server.ps1, assets/} (#203)
// layout "legacy":  指摘レポート.html at the top next to the .cmd (result folders made before #203)
async function checkLayout(layout) {
  const tempRoot = mkdtempSync(join(tmpdir(), `kosei-report-launcher-${layout}-`));
  const dataDir = join(tempRoot, "_data");
  const assetDir = join(dataDir, "assets");
  mkdirSync(assetDir, {recursive:true});
  const reportDir = layout === "current" ? dataDir : tempRoot;
  writeFileSync(join(reportDir, "指摘レポート.html"), "<!doctype html><meta charset=utf-8><title>report-ok</title>");
  writeFileSync(join(assetDir, "app.js"), "globalThis.reportAssetLoaded = true;");
  writeFileSync(join(dataDir, "report-server.ps1"), serverText);

  let child;
  try {
    child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", join(dataDir, "report-server.ps1"),
      "-NoBrowser", "-StopAfterRequests", "5",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for REPORT_URL")), 10_000);
      const output = createInterface({ input: child.stdout });
      output.on("line", (line) => {
        if (!line.startsWith("REPORT_URL=")) return;
        clearTimeout(timer);
        output.close();
        resolve(line.slice("REPORT_URL=".length));
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Server exited before startup (${code})`));
      });
    });

    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1") throw new Error(`Unexpected server host: ${parsed.hostname}`);
    const expectedPath = layout === "current" ? "/_data/指摘レポート.html" : "/指摘レポート.html";
    if (decodeURIComponent(parsed.pathname) !== expectedPath) throw new Error(`Unexpected report URL (${layout}): ${url}`);

    const reportResponse = await fetch(url);
    if (!reportResponse.ok || !(await reportResponse.text()).includes("report-ok")) {
      throw new Error(`Report request failed (${layout}): ${reportResponse.status}`);
    }
    // The current report refers to assets/... relative to _data; older reports refer to _data/assets/...
    const assetHref = layout === "current" ? "assets/app.js" : "_data/assets/app.js";
    const assetResponse = await fetch(new URL(assetHref, url));
    if (!assetResponse.ok || !(await assetResponse.text()).includes("reportAssetLoaded")) {
      throw new Error(`Asset request failed (${layout}): ${assetResponse.status}`);
    }
    const rootResponse = await fetch(new URL("/", url));
    if (!rootResponse.ok || !(await rootResponse.text()).includes("report-ok")) {
      throw new Error(`Root request failed (${layout}): ${rootResponse.status}`);
    }
    const stateResponse = await fetch(new URL("/__report-state", url));
    if (!stateResponse.ok || (await stateResponse.text()).trim() !== "{}") {
      throw new Error(`State request failed (${layout}): ${stateResponse.status}`);
    }
    const missingResponse = await fetch(new URL("missing.txt", url));
    if (missingResponse.status !== 404) throw new Error(`Expected 404, got ${missingResponse.status}`);

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server did not stop after the test requests")), 10_000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode !== 0) throw new Error(`Server exited with ${exitCode}`);
    console.log(`Test-ReportLauncher: PASS ${layout} (${url})`);
  } finally {
    if (child && child.exitCode == null) child.kill();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await checkLayout("current");
await checkLayout("legacy");
