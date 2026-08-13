// Generated report launcher smoke test.
// It evaluates the launcher builders from index.html, starts the bundled
// PowerShell server without opening a browser, and verifies loopback delivery.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

const tempRoot = mkdtempSync(join(tmpdir(), "kosei-report-launcher-"));
const assetDir = join(tempRoot, "assets");
mkdirSync(assetDir);
writeFileSync(join(tempRoot, "指摘レポート.html"), "<!doctype html><meta charset=utf-8><title>report-ok</title>");
writeFileSync(join(assetDir, "app.js"), "globalThis.reportAssetLoaded = true;");
writeFileSync(join(tempRoot, "report-server.ps1"), serverText);

let child;
try {
  child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(tempRoot, "report-server.ps1"),
    "-NoBrowser", "-StopAfterRequests", "3",
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
  if (!decodeURIComponent(parsed.pathname).endsWith("指摘レポート.html")) throw new Error(`Unexpected report URL: ${url}`);

  const reportResponse = await fetch(url);
  if (!reportResponse.ok || !(await reportResponse.text()).includes("report-ok")) {
    throw new Error(`Report request failed: ${reportResponse.status}`);
  }
  const assetResponse = await fetch(new URL("assets/app.js", url));
  if (!assetResponse.ok || !(await assetResponse.text()).includes("reportAssetLoaded")) {
    throw new Error(`Asset request failed: ${assetResponse.status}`);
  }
  const missingResponse = await fetch(new URL("missing.txt", url));
  if (missingResponse.status !== 404) throw new Error(`Expected 404, got ${missingResponse.status}`);

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not stop after the test requests")), 10_000);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  if (exitCode !== 0) throw new Error(`Server exited with ${exitCode}`);
  console.log(`Test-ReportLauncher: PASS (${url})`);
} finally {
  if (child && child.exitCode == null) child.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}
