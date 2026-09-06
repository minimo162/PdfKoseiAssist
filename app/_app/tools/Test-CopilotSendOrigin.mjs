// Execute production click scripts in a real browser; every URL is fulfilled
// locally, including the synthetic M365 origin. No account or external send.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
for (const root of [process.env.PDF_KOSEI_PLAYWRIGHT_DIR,
  ...(!chromium ? [execSync('npm root -g', { encoding: 'utf8' }).trim()] : [])]) {
  if (chromium || !root) continue;
  try { ({ chromium } = await import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href)); } catch {}
}
assert.ok(chromium, 'Playwright required; set PDF_KOSEI_PLAYWRIGHT_DIR to its node_modules directory');
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'CopilotClient.ps1'), 'utf8');
function script(name) {
  const body = source.split(`function ${name} {`)[1].split('\nfunction ')[0];
  const match = body.match(/@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match, `production script for ${name}`);
  return match[1].replaceAll('__CONFIGURED_URL__', JSON.stringify('https://m365.cloud.microsoft/chat/'));
}
const scripts = ['Invoke-KoseiClickSend', 'Invoke-KoseiSameChatRetry'].map(script);
let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch({ channel: 'msedge' }); }
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <title>Chat</title><script>window.sent=0;window.retried=0;</script>
    <button aria-label="Send" onclick="window.sent++">Send</button>
    <button aria-label="Retry" onclick="window.retried++">Retry</button>` }));
  const page = await context.newPage();
  for (const origin of ['https://m365.cloud.microsoft', 'https://example.invalid',
    'https://m365.cloud.microsoft.example.invalid', 'http://m365.cloud.microsoft',
    'https://m365.cloud.microsoft:444', 'https://login.microsoftonline.com',
    'https://m365.cloud.microsoft']) {
    // Same page/target, different origin: models redirects before the click.
    await page.goto(`${origin}/chat/`);
    if (origin === 'https://m365.cloud.microsoft') {
      for (const js of scripts) await page.evaluate(js);
      assert.deepEqual(await page.evaluate(() => [window.sent, window.retried]), [1, 1]);
    } else {
      for (const js of scripts) await assert.rejects(page.evaluate(js), /origin changed/);
      assert.deepEqual(await page.evaluate(() => [window.sent, window.retried]), [0, 0]);
    }
  }
  console.log('Test-CopilotSendOrigin: PASS (send + retry, 7 same-target origin transitions, no external requests)');
} finally { await browser.close(); }
