import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Games page multi-select filters', () => {
  it('uses the light palette independently of the system colour scheme', () => {
    const pageRule = ruleBody('.games-page');

    expect(pageRule).toMatch(/--games-bg:\s*#f7f7f8\s*;/);
    expect(pageRule).toMatch(/--games-surface:\s*#fff\s*;/);
    expect(pageRule).toMatch(/--games-card:\s*#fff\s*;/);
    expect(pageRule).toMatch(/--games-ink:\s*#1f1e20\s*;/);
    expect(styles).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  });

  it('clips the date rail horizontally without clipping dropdown menus vertically', () => {
    const filtersRule = ruleBody('.games-filters');

    expect(filtersRule).toMatch(/overflow-x:\s*clip\s*;/);
    expect(filtersRule).toMatch(/overflow-y:\s*visible\s*;/);
    expect(filtersRule).not.toMatch(/overflow:\s*hidden\s*;/);
  });

  it('keeps checkbox menus above the results with a bounded scroll area', () => {
    const menuRule = ruleBody('.games-multiselect__menu');

    expect(menuRule).toMatch(/z-index:\s*20\s*;/);
    expect(menuRule).toMatch(/max-height:\s*220px\s*;/);
    expect(menuRule).toMatch(/overflow-y:\s*auto\s*;/);
  });

  it('keeps the two multi-selects and availability checkbox in one primary row', () => {
    const primaryRule = ruleBody('.games-filter-primary');

    expect(primaryRule).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*0\.9fr\)\s+minmax\(0,\s*1fr\)\s+minmax\(100px,\s*1\.1fr\)\s*;/,
    );
    expect(primaryRule).toMatch(/align-items:\s*center\s*;/);
  });

  it('fills training type badges and aligns them to the card heading left edge', () => {
    const trainingKindRule = ruleBody('.games-page .booking-activity-card__kind--training');
    const coachGameKindRule = ruleBody('.games-page .booking-activity-card__kind--coach-game');

    expect(trainingKindRule).toMatch(/justify-content:\s*flex-start\s*;/);
    expect(trainingKindRule).toMatch(/margin:\s*0 auto 0 0\s*;/);
    expect(trainingKindRule).toMatch(/background:\s*#e1ecff\s*;/);
    expect(coachGameKindRule).toMatch(/background:\s*#f2edff\s*;/);
  });

  it('shows a trainer avatar followed by compact visual open slots', () => {
    const rosterRule = ruleBody('.games-page .booking-activity-card__host-roster');
    const hostAvatarRule = ruleBody(
      '.games-page .booking-activity-card__host-avatar .participant-avatar-stack',
    );
    const openSlotsRule = ruleBody(
      '.games-page .booking-activity-card__open-slots .participant-avatar-stack',
    );
    const openSlotIconRule = ruleBody(
      '.games-page .booking-activity-card__open-slots .participant-avatar-stack__open-slot svg',
    );

    expect(rosterRule).toMatch(/height:\s*32px\s*;/);
    expect(rosterRule).toMatch(/gap:\s*10px\s*;/);
    expect(hostAvatarRule).toMatch(/width:\s*32px\s*;/);
    expect(openSlotsRule).toMatch(/padding-left:\s*4px\s*;/);
    expect(openSlotIconRule).toMatch(/width:\s*32px\s*;/);
    expect(openSlotIconRule).toMatch(/height:\s*32px\s*;/);
  });

  it('makes the tournament title link cover the whole card without hiding its action', () => {
    const cardLinkRule = ruleBody('.tournament-summary-card .game-card__heading > a::after');
    const cardActionRule = ruleBody('.tournament-summary-card .game-card__button');

    expect(cardLinkRule).toMatch(/position:\s*absolute\s*;/);
    expect(cardLinkRule).toMatch(/inset:\s*0\s*;/);
    expect(cardLinkRule).toMatch(/cursor:\s*pointer\s*;/);
    expect(cardActionRule).toMatch(/position:\s*relative\s*;/);
    expect(cardActionRule).toMatch(/z-index:\s*1\s*;/);
  });
});
