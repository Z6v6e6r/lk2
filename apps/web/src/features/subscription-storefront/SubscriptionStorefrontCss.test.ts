import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./subscriptions.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('subscription storefront responsive contract', () => {
  it('keeps the page vertical while making only the plan rail horizontally scrollable', () => {
    expect(ruleBody('.subscription-storefront')).toContain('overflow-x: clip');
    expect(ruleBody('.subscription-plan-rail')).toContain('overflow-x: auto');
    expect(ruleBody('.subscription-plan-rail')).toContain('scroll-snap-type: inline mandatory');
    expect(ruleBody('.subscription-plan-rail__item')).toContain('scroll-snap-align: start');
  });

  it('switches to a three-column wrapping grid on desktop', () => {
    const desktop = css.slice(css.indexOf('@media (min-width: 720px)'));
    expect(desktop).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(desktop).toContain('grid-auto-flow: row');
    expect(desktop).toContain('scroll-snap-type: none');
  });
});
