(() => {
  'use strict';

  const installKey = '__koseiCancelReviewUxV1';
  if (window[installKey]) return;
  window[installKey] = true;

  const genericLabels = new Set(['中止', '停止', 'キャンセル', '中止する', '停止する']);
  const decoratedSelector = '[data-kosei-review-cancel="true"]';
  const hintAttribute = 'data-kosei-review-cancel-hint';
  const noticeId = 'kosei-review-cancel-notice';

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();

  function buttonLabel(button) {
    return normalize(
      button.innerText ||
      button.textContent ||
      button.getAttribute('aria-label') ||
      button.getAttribute('title')
    );
  }

  function reviewContext(button) {
    let node = button;
    let text = '';
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      text += ' ' + normalize(node.innerText || node.textContent);
      if (node.id === 'autoReviewCard' || node.hasAttribute?.('data-auto-review')) break;
    }
    return text;
  }

  function isReviewCancelButton(button) {
    if (!(button instanceof Element)) return false;
    if (!button.matches('button,[role="button"]')) return false;
    if (button.matches('[data-kosei-app-exit], [aria-label*="終了"], [title*="終了"]')) return false;

    const label = buttonLabel(button);
    if (label === '校正を中止' || label === '中止しています…') return true;
    if (!genericLabels.has(label)) return false;

    const context = reviewContext(button);
    return /(校正|整合性|レビュー|一括校正|回答待機|パケット)/.test(context);
  }

  function setCancelButtonState(button, state) {
    if (!(button instanceof Element)) return;
    button.setAttribute('data-kosei-review-cancel', 'true');
    button.setAttribute('aria-label', state === 'cancelling' ? '校正を中止しています' : '実行中の校正を中止');
    button.setAttribute(
      'title',
      state === 'cancelling'
        ? '校正を中止しています。停止後は未取り込み結果を破棄して終了できます。'
        : '実行中の校正を中止します。中止後は未取り込み結果を破棄して終了できます。'
    );
    if (state === 'cancelling') {
      button.textContent = '中止しています…';
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    } else {
      button.textContent = '校正を中止';
      button.removeAttribute('aria-busy');
    }
  }

  function ensureHint(button) {
    const parent = button.parentElement;
    if (!parent || parent.querySelector(`[${hintAttribute}]`)) return;

    const hint = document.createElement('span');
    hint.setAttribute(hintAttribute, 'true');
    hint.textContent = '中止すると未取り込みの校正結果を破棄し、停止後にそのまま終了できます。';
    hint.style.display = 'block';
    hint.style.marginTop = '6px';
    hint.style.fontSize = '12px';
    hint.style.lineHeight = '1.45';
    hint.style.opacity = '0.78';
    parent.appendChild(hint);
  }

  function showNotice(message, isError = false) {
    let notice = document.getElementById(noticeId);
    if (!notice) {
      notice = document.createElement('div');
      notice.id = noticeId;
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.style.position = 'fixed';
      notice.style.right = '18px';
      notice.style.bottom = '18px';
      notice.style.zIndex = '2147483647';
      notice.style.maxWidth = '420px';
      notice.style.padding = '12px 14px';
      notice.style.borderRadius = '10px';
      notice.style.boxShadow = '0 8px 28px rgba(0,0,0,.24)';
      notice.style.fontSize = '13px';
      notice.style.lineHeight = '1.5';
      notice.style.background = '#ffffff';
      notice.style.color = '#1f2937';
      notice.style.border = '1px solid #cbd5e1';
      document.body.appendChild(notice);
    }
    notice.style.borderColor = isError ? '#dc2626' : '#94a3b8';
    notice.textContent = message;
    notice.hidden = false;
  }

  function decorateButtons() {
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(isReviewCancelButton);
    for (const button of buttons) {
      if (!button.matches(decoratedSelector)) {
        setCancelButtonState(button, 'ready');
      }
      ensureHint(button);
    }
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function koseiFetch(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const isCancel = method === 'POST' && /\/api\/review\/cancel(?:[?#]|$)/.test(url);

    if (isCancel) {
      document.querySelectorAll(decoratedSelector).forEach(button => setCancelButtonState(button, 'cancelling'));
      showNotice('校正を中止しています。停止後は未取り込み結果を破棄し、そのままアプリを終了できます。');
    }

    try {
      const response = await nativeFetch(input, init);
      if (isCancel) {
        if (response.ok) {
          showNotice('校正の中止を受け付けました。処理の停止後は未取り込み結果を破棄し、そのまま終了できます。');
        } else {
          document.querySelectorAll(decoratedSelector).forEach(button => {
            button.disabled = false;
            setCancelButtonState(button, 'ready');
          });
          showNotice('校正を中止できませんでした。ログを確認して、もう一度お試しください。', true);
        }
      }
      return response;
    } catch (error) {
      if (isCancel) {
        document.querySelectorAll(decoratedSelector).forEach(button => {
          button.disabled = false;
          setCancelButtonState(button, 'ready');
        });
        showNotice('校正を中止できませんでした。アプリとの接続を確認してください。', true);
      }
      throw error;
    }
  };

  const observer = new MutationObserver(() => decorateButtons());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateButtons, { once: true });
  } else {
    decorateButtons();
  }
})();
