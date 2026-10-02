// @vitest-environment jsdom
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('removes synthetic OAuth fragment and query before displaying an unclaimed App Link', () => {
  const html = readFileSync('apps/web/public/android/oauth/yandex/index.html', 'utf8');
  const page = new DOMParser().parseFromString(html, 'text/html');
  const scripts = page.querySelectorAll('script');
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.hasAttribute('src')).toBe(false);
  expect(page.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  expect(page.querySelectorAll('iframe, img, link[href], form')).toHaveLength(0);

  history.replaceState(null, '', '/android/oauth/yandex?fixture=1#code=synthetic&state=synthetic');
  expect(location.hash).toContain('synthetic');
  window.eval(scripts[0]?.textContent ?? '');
  expect(location.pathname).toBe('/android/oauth/yandex');
  expect(location.search).toBe('');
  expect(location.hash).toBe('');
});
