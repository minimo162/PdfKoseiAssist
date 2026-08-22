import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const fixes = readFileSync(join(ROOT, 'src', 'RuntimeReviewFixes.ps1'), 'utf8');
const paths = readFileSync(join(ROOT, 'src', 'Paths.ps1'), 'utf8');
const cancelUx = readFileSync(join(ROOT, 'js', 'cancel-review-ux.js'), 'utf8');

const results = [];
const ok = name => results.push({ ok: true, name });
const fail = (name, detail) => results.push({ ok: false, name, detail });

const readerMatch = fixes.match(
  /function Get-KoseiLatestResponseTextRuntime[\s\S]*?\$js = @'\r?\n([\s\S]*?)\r?\n'@/
);
if (!readerMatch) {
  console.error('Get-KoseiLatestResponseTextRuntime の埋め込みJSが見つかりません');
  process.exit(1);
}
const readerJs = readerMatch[1];

const selectors = [
  '[data-testid="markdown-reply"]',
  '[data-content="ai-message"]',
  '[class*="ai-message" i]',
  '[role="article"][data-author="assistant"], [role="article"][aria-label*="Copilot" i]',
  '[data-message-author-role="assistant"]'
];

function fakeNode({ innerText = '', textContent = '', selectorIndex = 0, id = '' }) {
  const contained = new Set();
  return {
    innerText,
    textContent,
    contain(node) {
      contained.add(node);
    },
    contains(node) {
      return contained.has(node);
    },
    matches(selector) {
      return selector === selectors[selectorIndex];
    },
    getAttribute(name) {
      if (name === 'data-message-id' || name === 'id') return id;
      if (name === 'data-testid' && selectorIndex === 0) return 'markdown-reply';
      return '';
    }
  };
}

function runReader(nodes) {
  let combinedQuery = '';
  const document = {
    querySelectorAll(query) {
      combinedQuery = query;
      return nodes;
    }
  };
  const value = vm.runInNewContext(readerJs, { document, JSON });
  return { result: JSON.parse(value), combinedQuery };
}

const validAnswer =
  '{"packet_id":"SEC_001_STRUCTURE_R2","checked_pages":[84,85],"findings":[],"read_error":"","no_findings_reason":"確認済み"} KOSEI_END';

try {
  const oldAnswer = fakeNode({
    innerText: '{"packet_id":"OLD_PACKET","findings":[]} KOSEI_END',
    textContent: '{"packet_id":"OLD_PACKET","findings":[]} KOSEI_END',
    selectorIndex: 0,
    id: 'old'
  });
  const latestAnswer = fakeNode({
    innerText: validAnswer,
    textContent: validAnswer,
    selectorIndex: 1,
    id: 'latest'
  });
  const nestedFragment = fakeNode({
    innerText: '確認済み',
    textContent: '確認済み',
    selectorIndex: 2,
    id: 'nested-fragment'
  });
  latestAnswer.contain(nestedFragment);
  const trailingEmpty = fakeNode({ selectorIndex: 0, id: 'empty' });
  const { result, combinedQuery } = runReader([oldAnswer, latestAnswer, nestedFragment, trailingEmpty]);

  assert.equal(result.text, validAnswer);
  assert.equal(result.selectorIndex, 2);
  assert.equal(result.skippedEmpty, 1);
  assert.equal(result.candidateCount, 3);
  assert.equal(result.rawCandidateCount, 4);
  assert.equal(result.assistantDomKey, 'latest');
  assert.match(combinedQuery, /markdown-reply/);
  assert.match(combinedQuery, /data-content="ai-message"/);
  ok('異なる回答セレクターに旧回答が残ってもDOM上の最新回答を採用する');
} catch (error) {
  fail('異なる回答セレクターに旧回答が残ってもDOM上の最新回答を採用する', error.stack);
}

try {
  const minimizedAnswer = fakeNode({
    innerText: '',
    textContent: validAnswer,
    selectorIndex: 1,
    id: 'minimized'
  });
  const { result } = runReader([minimizedAnswer]);
  assert.equal(result.text, validAnswer);
  assert.equal(result.fallback, 'textContent');
  assert.ok(result.text.endsWith('} KOSEI_END'));
  assert.ok(result.text.includes('"findings":[]'));
  ok('非アクティブ／最小化時もtextContentから同一行の完了マーカー付きJSONを読む');
} catch (error) {
  fail('非アクティブ／最小化時もtextContentから同一行の完了マーカー付きJSONを読む', error.stack);
}

try {
  assert.match(paths, /RuntimeHtmlPolicy\.ps1/);
  assert.match(paths, /RuntimeReviewFixes\.ps1/);
  assert.match(fixes, /Set-Alias -Name Get-KoseiLatestResponseText/);
  assert.match(fixes, /Set-Alias -Name Stop-KoseiJob/);
  assert.match(fixes, /Set-Alias -Name Get-KoseiJobState/);
  assert.match(fixes, /Set-Alias -Name Get-KoseiRecoverableJobState/);
  assert.match(fixes, /Set-Alias -Name Acknowledge-KoseiCancelledShutdownCheckpoint/);
  assert.match(fixes, /Get-KoseiJobStateRuntime[\s\S]*Complete-KoseiCancelledResultDiscardRuntime/);
  assert.match(fixes, /Get-KoseiRecoverableJobStateRuntime[\s\S]*Complete-KoseiCancelledResultDiscardRuntime/);
  assert.match(fixes, /AddSeconds\(30\)[\s\S]*Start-Sleep -Milliseconds 100/);
  assert.match(fixes, /shutdown_discard_approved/);
  assert.match(fixes, /result_retained' -Value \$false/);
  assert.match(fixes, /raw_answer' -Value ''/);
  assert.match(fixes, /中止済みジョブの再接続用結果を破棄しました/);
  ok('全runspaceへ回答取得修正と中止結果破棄契約を読み込む');
} catch (error) {
  fail('全runspaceへ回答取得修正と中止結果破棄契約を読み込む', error.stack);
}

try {
  assert.match(fixes, /cancel-review-ux\.js\?v=77/);
  assert.match(cancelUx, /校正を中止/);
  assert.match(cancelUx, /中止しています…/);
  assert.match(cancelUx, /api\\\/review\\\/cancel/);
  assert.match(cancelUx, /未取り込みの校正結果を破棄/);
  assert.match(cancelUx, /MutationObserver/);
  ok('中止操作を明示し、動的再描画後も案内を維持する');
} catch (error) {
  fail('中止操作を明示し、動的再描画後も案内を維持する', error.stack);
}

for (const result of results) {
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : `\n       ${result.detail}`}`);
}
const failures = results.filter(result => !result.ok).length;
console.log(`\nTest-RuntimeReviewFixes: ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
