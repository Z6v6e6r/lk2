import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const serviceWorker = readFileSync(
  new URL('../public/phub-notification-sw.js', import.meta.url),
  'utf8',
);

describe('notification service worker assets', () => {
  it('references only notification icons that ship with the web bundle', () => {
    const referenced = [...serviceWorker.matchAll(/'(\/phub-notification-[a-z0-9-]+\.png)'/g)].map(
      (match) => match[1] as string,
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(
        existsSync(new URL(`../public${file}`, import.meta.url)),
        `missing public asset ${file}`,
      ).toBe(true);
    }
  });

  it('keeps the presentation options the operating system needs for a visible alert', () => {
    for (const option of ['icon:', 'badge:', 'vibrate:', 'renotify: true', 'silent: false']) {
      expect(serviceWorker).toContain(option);
    }
  });
});
