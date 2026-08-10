import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHeadlessPdfJsPage } from "./pdfjs-headless-runner.mjs";

const prefix = `kosei-runner-exit-test-${process.pid}-`;
const dirs = () => readdirSync(tmpdir()).filter(name => name.startsWith(prefix)).sort();
const before = dirs();
const previousBrowser = process.env.KOSEI_BROWSER;
const started = Date.now();
let rejected = false;
try {
  process.env.KOSEI_BROWSER = process.execPath;
  await runHeadlessPdfJsPage({
    appDir: new URL("..", import.meta.url).pathname,
    html: "<!doctype html><title>must not open</title>",
    tempPrefix: prefix,
    batchLabel: "runner early-exit test",
    startupTimeoutMs: 10_000,
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 10_000,
  });
} catch (error) {
  rejected = /code=|起動|browser/i.test(String(error?.message || error));
} finally {
  if (previousBrowser === undefined) delete process.env.KOSEI_BROWSER;
  else process.env.KOSEI_BROWSER = previousBrowser;
}

const elapsed = Date.now() - started;
const after = dirs();
if (!rejected || elapsed >= 5_000 || before.length !== 0 || after.length !== 0) {
  console.error("Test-PdfJsRunner: FAIL", { rejected, elapsed, before, after });
  process.exit(1);
}
console.log(`Test-PdfJsRunner: PASS (early exit ${elapsed}ms, temp cleanup confirmed)`);
