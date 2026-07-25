import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Home layout scroll contract', () => {
  it('clips horizontal artwork without creating a nested vertical page scroller', () => {
    const homeRule = ruleBody('.figma-home');

    expect(homeRule).toMatch(/overflow-x:\s*clip\s*;/);
    expect(homeRule).toMatch(/overflow-y:\s*visible\s*;/);
    expect(homeRule).not.toMatch(/overflow-x:\s*hidden\s*;/);
  });
});
