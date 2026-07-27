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

  it('keeps the compact hero and exact lower-box Figma geometry', () => {
    const heroRule = ruleBody('.fh-hero');
    const communitiesRule = ruleBody('.fh-hero-communities');
    const communityTrackRule = ruleBody('.fh-community-track');
    const actionsRule = ruleBody('.fh-actions');
    const tabsRule = ruleBody('.fh-tabs');
    const tabRule = ruleBody('.fh-tabs button');
    const tabIndicatorRule = ruleBody('.fh-tabs button::after');
    const mainBoxRule = ruleBody('.fh-main-box');
    const lowerRule = ruleBody('.fh-lower');
    const locationsRule = ruleBody('.fh-locations');
    const additionalRule = ruleBody('.fh-additional');

    const bookingsRule = ruleBody('.fh-bookings');

    expect(heroRule).toMatch(/height:\s*380px\s*;/);
    expect(heroRule).toMatch(/gap:\s*8px\s*;/);
    expect(communitiesRule).toMatch(/height:\s*73px\s*;/);
    expect(communitiesRule).toMatch(/margin-top:\s*8px\s*;/);
    expect(communitiesRule).toMatch(/margin-bottom:\s*16px\s*;/);
    expect(communityTrackRule).toMatch(/padding:\s*0 8px 0 4px\s*;/);
    expect(communityTrackRule).toMatch(/gap:\s*18px\s*;/);
    expect(actionsRule).toMatch(/height:\s*136px\s*;/);
    expect(tabsRule).toMatch(/width:\s*335px\s*;/);
    expect(tabsRule).toMatch(/height:\s*50px\s*;/);
    expect(tabsRule).toMatch(/gap:\s*12px\s*;/);
    expect(tabRule).toMatch(/width:\s*148px\s*;/);
    expect(tabRule).toMatch(/height:\s*50px\s*;/);
    expect(tabRule).toMatch(/padding:\s*16px 0 0\s*;/);
    expect(tabRule).toMatch(/justify-content:\s*center\s*;/);
    expect(tabRule).toMatch(/gap:\s*13px\s*;/);
    expect(tabIndicatorRule).toMatch(/height:\s*3px\s*;/);
    expect(tabIndicatorRule).toMatch(/background:\s*transparent\s*;/);
    expect(mainBoxRule).toMatch(
      /height:\s*calc\(1316px \+ var\(--fh-bookings-extra-height\)\)\s*;/,
    );
    expect(bookingsRule).toMatch(
      /height:\s*calc\(522px \+ var\(--fh-bookings-extra-height\)\)\s*;/,
    );
    expect(lowerRule).toMatch(/width:\s*375px\s*;/);
    expect(lowerRule).toMatch(/height:\s*554px\s*;/);
    expect(lowerRule).toMatch(/padding:\s*32px 24px\s*;/);
    expect(lowerRule).toMatch(/gap:\s*48px\s*;/);
    expect(locationsRule).toMatch(/width:\s*327px\s*;/);
    expect(locationsRule).toMatch(/height:\s*230px\s*;/);
    expect(additionalRule).toMatch(/height:\s*148px\s*;/);
    expect(additionalRule).not.toMatch(/margin-top\s*:/);
  });

  it('does not retain the removed recommendation explanation styles', () => {
    expect(styles).not.toContain('.booking-recommendation-explainer');
    expect(styles).not.toContain('.has-recommendation-explainer');
  });

  it('shares the History date badge geometry with Home recommendation cards', () => {
    const compactHeaderRule = ruleBody('.game-card.is-compact .game-card__header');
    const compactHeadingRule = ruleBody('.game-card.is-compact .game-card__heading');
    const dateBadgeRule = ruleBody('.game-card.is-compact .game-card__date-badge');

    expect(compactHeaderRule).toMatch(/position:\s*relative\s*;/);
    expect(compactHeadingRule).toMatch(/padding-right:\s*52px\s*;/);
    expect(dateBadgeRule).toMatch(/width:\s*44px\s*;/);
    expect(dateBadgeRule).toMatch(/height:\s*51px\s*;/);
    expect(dateBadgeRule).toMatch(/padding:\s*8px\s*;/);
    expect(dateBadgeRule).toMatch(/border-radius:\s*8px\s*;/);
  });

  it('shares the History typography with Home recommendation cards', () => {
    const titleRule = ruleBody('.game-card.is-compact .game-card__heading > a');
    const metadataRule = ruleBody('.game-card.is-compact .game-card__history-meta');
    const levelRule = ruleBody('.game-card__compact-level');
    const stateRule = ruleBody('.game-card.is-compact .game-state');

    expect(titleRule).toMatch(/font-size:\s*15px\s*;/);
    expect(titleRule).toMatch(/font-weight:\s*600\s*;/);
    expect(titleRule).toMatch(/line-height:\s*112%\s*;/);
    expect(metadataRule).toMatch(/font-size:\s*10px\s*;/);
    expect(metadataRule).toMatch(/font-weight:\s*500\s*;/);
    expect(metadataRule).toMatch(/letter-spacing:\s*0\.02em\s*;/);
    expect(metadataRule).toMatch(/line-height:\s*100%\s*;/);
    expect(levelRule).toMatch(/font-size:\s*12px\s*;/);
    expect(levelRule).toMatch(/font-weight:\s*500\s*;/);
    expect(levelRule).toMatch(/letter-spacing:\s*0\.02em\s*;/);
    expect(levelRule).toMatch(/line-height:\s*100%\s*;/);
    expect(stateRule).toMatch(/font-size:\s*11px\s*;/);
    expect(stateRule).toMatch(/font-weight:\s*500\s*;/);
    expect(stateRule).toMatch(/line-height:\s*100%\s*;/);
  });
});
