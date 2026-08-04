import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Tournament activity-history typography', () => {
  it('uses the same 51px compact summary geometry as game history cards', () => {
    expect(ruleBody('.tournament-history-card__summary')).toMatch(/min-height:\s*51px\s*;/);
    expect(ruleBody('.tournament-history-card__copy')).toMatch(/padding-right:\s*52px\s*;/);
    expect(ruleBody('.tournament-history-card__copy')).toMatch(/gap:\s*5px\s*;/);
  });

  it('matches compact game title typography', () => {
    const title = ruleBody('.activity-history-card--tournament .tournament-history-card__copy h3');
    expect(title).toMatch(/font-family:\s*'RF Dewi',\s*'Inter Display',\s*sans-serif\s*;/);
    expect(title).toMatch(/font-size:\s*15px\s*;/);
    expect(title).toMatch(/font-weight:\s*600\s*;/);
    expect(title).toMatch(/letter-spacing:\s*0\.01em\s*;/);
    expect(title).toMatch(/line-height:\s*112%\s*;/);
  });

  it('matches compact game metadata typography', () => {
    const metadata = ruleBody('.tournament-history-card__copy > p');
    expect(metadata).toMatch(/font-family:\s*'Inter Display',\s*sans-serif\s*;/);
    expect(metadata).toMatch(/font-size:\s*10px\s*;/);
    expect(metadata).toMatch(/font-weight:\s*500\s*;/);
    expect(metadata).toMatch(/letter-spacing:\s*0\.02em\s*;/);
    expect(metadata).toMatch(/line-height:\s*100%\s*;/);
  });

  it('matches compact game calendar dimensions and type scale', () => {
    const badge = ruleBody('.tournament-history-card__summary > time');
    const day = ruleBody('.tournament-history-card__summary > time strong');
    const month = ruleBody('.tournament-history-card__summary > time span');
    expect(badge).toMatch(/width:\s*44px\s*;/);
    expect(badge).toMatch(/height:\s*51px\s*;/);
    expect(day).toMatch(/font-size:\s*18px\s*;/);
    expect(day).toMatch(/font-weight:\s*700\s*;/);
    expect(month).toMatch(/font-size:\s*9px\s*;/);
    expect(month).toMatch(/font-weight:\s*600\s*;/);
  });
});

describe('Tournament activity-history podium', () => {
  it('uses the reference 2-1-3 podium arrangement', () => {
    const podium = ruleBody('.tournament-history-card__podium');
    expect(podium).toMatch(/grid-template-areas:\s*'second first third'\s*;/);
    expect(ruleBody('.tournament-history-card__podium .is-place-1')).toMatch(
      /grid-area:\s*first\s*;/,
    );
    expect(ruleBody('.tournament-history-card__podium .is-place-2')).toMatch(
      /grid-area:\s*second\s*;/,
    );
    expect(ruleBody('.tournament-history-card__podium .is-place-3')).toMatch(
      /grid-area:\s*third\s*;/,
    );
  });

  it('overlaps medal markers without a second row of place labels', () => {
    const marker = ruleBody('.tournament-history-card__place');
    expect(marker).toMatch(/position:\s*absolute\s*;/);
    expect(marker).toMatch(/bottom:\s*-12px\s*;/);
    expect(marker).toMatch(/border-radius:\s*50%\s*;/);
    expect(styles).not.toContain('.tournament-history-card__place-label');
  });
});
