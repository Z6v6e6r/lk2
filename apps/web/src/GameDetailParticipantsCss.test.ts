import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Game participants Figma typography', () => {
  it('uses the Figma organizer badge and preserves participant name typography', () => {
    expect(styles).toMatch(
      /font-family: 'Game Participants RF Dewi';\s*src: url\('\.\/assets\/recommendation-cards\/rf-dewi-bold\.ttf'\)/,
    );
    for (const selector of ['.game-detail-player__name strong', '.game-detail-player__badge']) {
      const rule = ruleBody(selector);
      expect(rule).toContain(
        "font-family: 'Game Participants RF Dewi', 'RF Dewi', 'Inter Display', sans-serif;",
      );

      expect(rule).toMatch(/font-weight:\s*700;/);
      expect(rule).toMatch(/line-height:\s*100%;/);
    }
    expect(ruleBody('.game-detail-player__name strong')).toMatch(/font-size:\s*14px;/);
    const badge = ruleBody('.game-detail-player__badge');
    expect(badge).toMatch(/font-size:\s*8px;/);
    expect(badge).toMatch(/height:\s*12px;/);
    expect(badge).toMatch(/padding:\s*2px 6px;/);
    expect(badge).toMatch(/background:\s*#e2f6fe;/);
    expect(badge).toMatch(/color:\s*#50b1f9;/);
    expect(badge).toMatch(/letter-spacing:\s*0\.12em;/);
    expect(badge).toMatch(/text-transform:\s*uppercase;/);
    expect(ruleBody('.game-detail-player__name')).toMatch(/gap:\s*5px;/);
    expect(ruleBody('.game-detail-player__name small')).toMatch(/font-size:\s*11px;/);
    expect(ruleBody('.game-detail-players__list > :not(:first-child)')).toMatch(
      /border-top:\s*1\.5px dashed #ededed;/,
    );
    expect(ruleBody('.game-detail-player__profile .participant-avatar-stack')).toMatch(
      /width:\s*48px;/,
    );
  });
});
