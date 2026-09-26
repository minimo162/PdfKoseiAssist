// 同じレポートを開き直すたびに、ふだんの Edge にタブが1つずつたまっていた（実機で5つ）。
// 新しいタブが開いたら、古いタブは閉じる（閉じられなければ「閉じて構いません」と出す）。
// 古いタブは「閉じた」と一時サーバーに知らせない（新しいタブが一時サーバーを使い続けるため）。
// レポートの中の実物のスクリプトを、ローカルだけで満たすページで2枚開いて確かめる。
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
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const start = html.indexOf('let supersededByNewerTab=false;');
const end = html.indexOf('ch.postMessage({type:\'opened\',id:me});}catch(_){}})();', start);
assert.ok(start > 0 && end > start, 'report superseded-tab script found in index.html');
const snippet = html.slice(start, end + "ch.postMessage({type:'opened',id:me});}catch(_){}})();".length);
const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.__beacons=[];navigator.sendBeacon=function(u){window.__beacons.push(String(u));return true};
const stateServer=true,stateToken='t';
${snippet}
</script></body></html>`;

let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch(process.env.PDF_KOSEI_CHROMIUM ? { executablePath: process.env.PDF_KOSEI_CHROMIUM } : { channel: 'msedge' }); }
try {
  const context = await browser.newContext();
  await context.route('http://127.0.0.1:59999/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: page }));
  const url = 'http://127.0.0.1:59999/%E6%8C%87%E6%91%98%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.html?t=t';
  const older = await context.newPage();
  await older.goto(url);
  await older.waitForTimeout(200);
  assert.equal(await older.locator('.superseded-note').count(), 0, 'a single tab is not superseded');
  const newer = await context.newPage();
  await newer.goto(url);
  await older.waitForFunction(() => !!document.querySelector('.superseded-note'), null, { timeout: 5000 });
  assert.match(await older.locator('.superseded-note').textContent(), /新しいタブで開き直しました/);
  assert.equal(await newer.locator('.superseded-note').count(), 0, 'the newer tab stays usable');
  // 古いタブを閉じても、「閉じた」は送らない（新しいタブの一時サーバーを止めない）。
  const olderBeacons = await older.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide')); return window.__beacons; });
  assert.deepEqual(olderBeacons, [], 'superseded tab does not report closed');
  const newerBeacons = await newer.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide')); return window.__beacons; });
  assert.equal(newerBeacons.length, 1, 'the active tab still reports closed');
  // 別のレポート（別の名前）は古いタブに影響しない。
  const other = await context.newPage();
  await other.goto('http://127.0.0.1:59999/other.html?t=t');
  await newer.waitForTimeout(300);
  assert.equal(await newer.locator('.superseded-note').count(), 0, 'a different report does not supersede');
  console.log('PASS ReportTabSuperseded');
} finally { await browser.close(); }
