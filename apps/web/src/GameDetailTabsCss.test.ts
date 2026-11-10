import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Game detail Figma navigation', () => {
  it('uses a compact grey track with equal-width tabs and a white active pill', () => {
    const track = ruleBody('.game-detail-tabs');
    expect(track).toMatch(/box-sizing:\s*border-box;/);
    expect(track).toMatch(/width:\s*100%;/);
    expect(track).toMatch(/height:\s*36px;/);
    expect(track).toMatch(/padding:\s*4px;/);
    expect(track).toMatch(/gap:\s*6px;/);
    expect(track).toMatch(/border-radius:\s*12px;/);
    expect(track).toMatch(/background:\s*#f6f6f6;/);
    expect(track).not.toContain('gradient');

    const tab = ruleBody('.game-detail-tabs button');
    expect(tab).toMatch(/flex:\s*1 1 0;/);
    expect(tab).toMatch(/min-width:\s*0;/);
    expect(tab).toMatch(/height:\s*28px;/);
    expect(tab).toMatch(/padding:\s*8px 14px;/);
    expect(tab).toMatch(/gap:\s*4px;/);
    expect(tab).toMatch(/justify-content:\s*center;/);
    expect(tab).toMatch(/border-radius:\s*8px;/);
    expect(tab).toMatch(/font-family:\s*'Inter Display', Inter, sans-serif;/);
    expect(tab).toMatch(/font-size:\s*12px;/);
    expect(tab).toMatch(/font-weight:\s*500;/);
    expect(tab).toMatch(/line-height:\s*100%;/);
    expect(tab).toMatch(/letter-spacing:\s*0\.02em;/);
    expect(tab).toMatch(/color:\s*#353436;/);

    const active = ruleBody('.game-detail-tabs button.is-active');
    expect(active).toMatch(/background:\s*#fff;/);
    expect(active).toMatch(/color:\s*#1f1e20;/);
    expect(styles).not.toContain('.game-detail-tabs button.is-active::after');
    expect(ruleBody('.game-detail-tabs button:focus-visible')).toMatch(
      /outline:\s*2px solid #8a63ff;/,
    );
  });
});
