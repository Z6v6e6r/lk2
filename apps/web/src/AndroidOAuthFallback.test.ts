// @vitest-environment jsdom
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const html = readFileSync('apps/web/public/android/oauth/yandex/index.html', 'utf8');
const source = new DOMParser().parseFromString(html, 'text/html');
const script = source.querySelector('script')?.textContent ?? '';
const TARGET = 'https://lk2.padlhub.su/android/oauth/yandex';
const CODE = 'c'.repeat(43);
const STATE = 's'.repeat(43);

function render(fragment: string): Document {
  history.replaceState(null, '', `/android/oauth/yandex?fixture=1${fragment}`);
  document.head.innerHTML = source.head.innerHTML;
  document.body.innerHTML = source.body.innerHTML;
  window.eval(script);
  return document;
}

it('offers a user-initiated return and drops the one-time fragment from history', () => {
  render(`#code=${CODE}&state=${STATE}`);
  const scripts = document.querySelectorAll('script');
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.hasAttribute('src')).toBe(false);
  expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe(
    'no-referrer',
  );
  expect(document.querySelectorAll('iframe, img, link[href], form, script[src]')).toHaveLength(0);

  expect(location.pathname).toBe('/android/oauth/yandex');
  expect(location.search).toBe('');
  expect(location.hash).toBe('');

  const open = document.getElementById('open-app')!;
  expect(open.hasAttribute('hidden')).toBe(false);
  expect(open.getAttribute('href')).toBe(`padlhub://oauth/yandex?code=${CODE}&state=${STATE}`);
  const retry = document.getElementById('retry')!;
  expect(retry.hasAttribute('hidden')).toBe(false);
  expect(retry.getAttribute('href')).toBe(`${TARGET}#code=${CODE}&state=${STATE}`);
  expect(document.getElementById('expiry')?.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('no-code')?.hasAttribute('hidden')).toBe(true);
  expect(document.body.textContent).not.toContain(CODE);
  expect(document.body.textContent).not.toContain(STATE);
});

it('never requests, stores or navigates on its own', () => {
  const requests: string[] = [];
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: (input: unknown) => {
      requests.push(String(input));
      throw new Error('unexpected request');
    },
  });
  Object.defineProperty(window, 'XMLHttpRequest', {
    configurable: true,
    value: class {
      public constructor() {
        requests.push('XMLHttpRequest');
        throw new Error('unexpected request');
      }
    },
  });
  render(`#code=${CODE}&state=${STATE}`);
  expect(requests).toHaveLength(0);
  expect(document.cookie).toBe('');
  // The only application entry is the anchor the user activates; nothing runs automatically.
  expect(document.querySelectorAll('a[href]')).toHaveLength(2);
  expect(script).not.toMatch(
    /fetch|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|location\.(assign|replace)|location\.href/,
  );
});

it('asks for a new login when the callback carries no code', () => {
  render('');
  expect(location.pathname).toBe('/android/oauth/yandex');
  expect(document.getElementById('open-app')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('retry')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('lead')?.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('no-code')?.hasAttribute('hidden')).toBe(false);
  expect(document.body.textContent).toContain('Код входа не найден');
});

it('rejects a malformed or extended callback fragment and keeps nothing in history', () => {
  for (const fragment of [
    `#code=${CODE.slice(1)}&state=${STATE}`,
    `#code=${CODE}&state=${STATE}&next=evil`,
    `#state=${STATE}&code=${CODE}`,
    `#code=${CODE}&state=${STATE}/`,
    `#state=${STATE}`,
    `#code=${CODE}&state=${STATE}&state=${STATE}`,
    `#code=${CODE.replace(/c/g, '%63')}&state=${STATE}`,
  ]) {
    render(fragment);
    expect(location.pathname).toBe('/android/oauth/yandex');
    expect(location.hash).toBe('');
    expect(document.getElementById('open-app')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('retry')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('no-code')?.hasAttribute('hidden')).toBe(false);
  }
});
