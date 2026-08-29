import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Home layout scroll contract', () => {
  it('pins the compact recommendation ad CTA to the bottom edge', () => {
    expect(
      ruleBody('.booking-recommendation-ad.is-card.is-compact .booking-recommendation-ad__footer'),
    ).toMatch(/margin-top:\s*auto\s*;/);
  });

  it('shows compact recommendation artwork without a dark overlay', () => {
    expect(ruleBody('.booking-recommendation-ad.is-card.is-compact picture::after')).toMatch(
      /content:\s*none\s*;/,
    );
  });

  it('clips horizontal artwork without creating a nested vertical page scroller', () => {
    const homeRule = ruleBody('.figma-home');

    expect(homeRule).toMatch(/overflow-x:\s*clip\s*;/);
    expect(homeRule).toMatch(/overflow-y:\s*visible\s*;/);
    expect(homeRule).not.toMatch(/overflow-x:\s*hidden\s*;/);
  });

  it('keeps the compact hero and exact lower-box Figma geometry', () => {
    const homeRule = ruleBody('.figma-home');
    const heroRule = ruleBody('.fh-hero');
    const heroV2Rule = ruleBody('.fh-hero--v2');
    const profileRowRule = ruleBody('.fh-profile-row');
    const profileRule = ruleBody('.fh-profile');
    const profileAvatarRule = ruleBody('.fh-profile-avatar');
    const communitiesRule = ruleBody('.fh-hero-communities');
    const communityTrackRule = ruleBody('.fh-community-track');
    const communityLogoRule = ruleBody('.fh-community-logo');
    const recommendationCardRule = ruleBody(
      '.fh-for-me .booking-recommendation > .game-card.is-compact',
    );
    const recommendationScrollerRule = ruleBody('.fh-for-me .booking-recommendations.is-compact');
    const recommendationItemRule = ruleBody('.fh-for-me .booking-recommendation');
    const recommendationHeaderRule = ruleBody(
      '.fh-for-me .booking-recommendation > .game-card.is-compact .game-card__header',
    );
    const actionsRule = ruleBody('.fh-actions');
    const tabsRule = ruleBody('.fh-tabs');
    const tabRule = ruleBody('.fh-tabs button');
    const tabIndicatorRule = ruleBody('.fh-tabs button::after');
    const bookingPresenceDotRule = ruleBody('.fh-booking-presence-dot');
    const tabBookingPresenceDotRule = ruleBody('.fh-tab-label .fh-booking-presence-dot');
    const calendarBookingPresenceDotRule = ruleBody('.fh-calendar .fh-booking-presence-dot');
    const mainBoxRule = ruleBody('.fh-main-box');
    const lowerRule = ruleBody('.fh-lower');
    const locationsRule = ruleBody('.fh-locations');
    const additionalRule = ruleBody('.fh-additional');

    const bookingsRule = ruleBody('.fh-bookings');
    const recommendationsPeekRule = ruleBody('.figma-home-shell.has-recommendations-scroll-peek');
    const splitFooterRule = ruleBody('.fh-bookings-footer-action.is-split');

    expect(heroRule).toMatch(/height:\s*419px\s*;/);
    expect(heroRule).toMatch(/gap:\s*12px\s*;/);
    expect(profileRowRule).toMatch(/height:\s*57px\s*;/);
    expect(profileRule).toMatch(/height:\s*51px\s*;/);
    expect(profileAvatarRule).toMatch(/width:\s*48px\s*;/);
    expect(profileAvatarRule).toMatch(/height:\s*51px\s*;/);
    expect(homeRule).toMatch(/--page-padding-x:\s*20px\s*;/);
    expect(homeRule).toMatch(/--gap-profile-banner:\s*11px\s*;/);
    expect(homeRule).toMatch(/--gap-banner-communities:\s*11px\s*;/);
    expect(homeRule).toMatch(/--gap-communities-actions:\s*8px\s*;/);
    expect(homeRule).toMatch(/--gap-actions-tabs:\s*6px\s*;/);
    expect(homeRule).toMatch(/--gap-tabs-sheet:\s*5px\s*;/);
    expect(heroV2Rule).toMatch(/height:\s*calc\(410px \+ env\(safe-area-inset-top,\s*0px\)\)\s*;/);
    expect(heroV2Rule).toMatch(
      /padding:\s*calc\(10px \+ env\(safe-area-inset-top,\s*0px\)\) 0 0\s*;/,
    );
    expect(heroV2Rule).toMatch(
      /flex-basis:\s*calc\(410px \+ env\(safe-area-inset-top,\s*0px\)\)\s*;/,
    );
    expect(heroV2Rule).toMatch(/gap:\s*0\s*;/);
    expect(ruleBody('.fh-hero--v2 .fh-hero-promotion')).toMatch(
      /margin-top:\s*var\(--gap-profile-banner\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 .fh-hero-communities')).toMatch(
      /margin-top:\s*var\(--gap-banner-communities\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 .fh-hero-communities .fh-community-track')).toMatch(
      /padding:\s*1px var\(--page-padding-x\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 .fh-actions')).toMatch(/grid-template-columns:\s*2fr 3fr\s*;/);
    expect(ruleBody('.fh-hero--v2 .fh-actions')).toMatch(
      /margin-top:\s*var\(--gap-communities-actions\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 .fh-actions')).toMatch(/gap:\s*var\(--actions-gap\)\s*;/);
    const actionLabelRule = ruleBody('.fh-hero--v2 .fh-actions > a > span:nth-child(2)');
    expect(actionLabelRule).toMatch(/font-family:\s*'Inter Display',\s*sans-serif\s*;/);
    expect(actionLabelRule).toMatch(/font-size:\s*14px\s*;/);
    expect(actionLabelRule).toMatch(/font-style:\s*normal\s*;/);
    expect(actionLabelRule).toMatch(/font-weight:\s*500\s*;/);
    expect(actionLabelRule).toMatch(/letter-spacing:\s*0\.02em\s*;/);
    expect(actionLabelRule).toMatch(/line-height:\s*100%\s*;/);
    expect(actionLabelRule).toMatch(/text-align:\s*center\s*;/);
    expect(ruleBody('.fh-hero--v2 .fh-tabs')).toMatch(
      /margin-top:\s*var\(--gap-actions-tabs\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 .fh-tabs')).not.toMatch(
      /(?:display|height|grid-template-columns|flex-basis|gap)\s*:/,
    );
    expect(ruleBody('.fh-hero--v2 .fh-tabs button')).toMatch(/justify-content:\s*flex-end\s*;/);
    expect(ruleBody('.fh-hero--v2 .fh-tabs button')).toMatch(/gap:\s*10px\s*;/);
    expect(ruleBody('.fh-hero--v2 + .fh-main-box')).toMatch(
      /margin-top:\s*var\(--gap-tabs-sheet\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 + .fh-main-box .fh-bookings')).toMatch(
      /padding:\s*var\(--sheet-padding-top\) 0 var\(--sheet-padding-bottom\)\s*;/,
    );
    expect(ruleBody('.fh-hero--v2 + .fh-main-box .fh-bookings')).toMatch(/border-top:\s*0\s*;/);
    expect(
      ruleBody(
        '.fh-hero--v2 + .fh-main-box .fh-for-me > .booking-recommendations.booking-recommendations',
      ),
    ).toMatch(/margin-top:\s*0\s*;/);
    expect(ruleBody('.fh-hero--v2 + .fh-main-box .fh-for-me')).toMatch(
      /padding:\s*0 var\(--sheet-padding-x\)\s*;/,
    );
    expect(communitiesRule).toMatch(/height:\s*73px\s*;/);
    expect(communitiesRule).toMatch(/margin-top:\s*0\s*;/);
    expect(communitiesRule).toMatch(/margin-bottom:\s*0\s*;/);
    expect(communityTrackRule).toMatch(/padding:\s*1px 2px\s*;/);
    expect(communityTrackRule).toMatch(/gap:\s*12px\s*;/);
    expect(communityLogoRule).toMatch(/padding:\s*1px\s*;/);
    expect(ruleBody('.fh-community-search')).toMatch(/height:\s*56px\s*;/);
    expect(recommendationCardRule).toMatch(/gap:\s*20px\s*;/);
    expect(recommendationScrollerRule).toMatch(/contain:\s*layout paint\s*;/);
    expect(recommendationScrollerRule).toMatch(/isolation:\s*isolate\s*;/);
    expect(recommendationScrollerRule).toMatch(/transform:\s*translateZ\(0\)\s*;/);
    expect(recommendationScrollerRule).toMatch(/-webkit-overflow-scrolling:\s*touch\s*;/);
    expect(recommendationItemRule).toMatch(/contain:\s*layout style\s*;/);
    expect(recommendationHeaderRule).toMatch(/min-height:\s*35px\s*;/);
    expect(actionsRule).toMatch(/height:\s*64px\s*;/);
    expect(actionsRule).toMatch(/gap:\s*8px\s*;/);
    expect(ruleBody('.fh-actions > a:first-child')).toMatch(/flex:\s*0 0 128px\s*;/);
    expect(ruleBody('.fh-actions > a:last-child')).toMatch(/flex:\s*1 1 0\s*;/);
    expect(tabsRule).toMatch(/width:\s*335px\s*;/);
    expect(tabsRule).toMatch(/height:\s*50px\s*;/);
    expect(tabsRule).toMatch(/margin-top:\s*auto\s*;/);
    expect(tabsRule).toMatch(/gap:\s*12px\s*;/);
    expect(tabRule).toMatch(/width:\s*148px\s*;/);
    expect(tabRule).toMatch(/height:\s*50px\s*;/);
    expect(tabRule).toMatch(/padding:\s*16px 0 0\s*;/);
    expect(tabRule).toMatch(/justify-content:\s*center\s*;/);
    expect(tabRule).toMatch(/gap:\s*13px\s*;/);
    expect(tabIndicatorRule).toMatch(/height:\s*3px\s*;/);
    expect(bookingPresenceDotRule).toMatch(/width:\s*4px\s*;/);
    expect(bookingPresenceDotRule).toMatch(/height:\s*4px\s*;/);
    expect(bookingPresenceDotRule).toMatch(/background:\s*#f0705f\s*;/);
    expect(tabBookingPresenceDotRule).toMatch(/right:\s*-8px\s*;/);
    expect(calendarBookingPresenceDotRule).toMatch(/left:\s*21px\s*;/);
    expect(tabIndicatorRule).toMatch(/background:\s*transparent\s*;/);
    expect(mainBoxRule).toMatch(
      /height:\s*calc\(1316px \+ var\(--fh-bookings-extra-height\) \+ var\(--fh-my-extras-height\)\)\s*;/,
    );
    expect(bookingsRule).toMatch(
      /height:\s*calc\(522px \+ var\(--fh-bookings-extra-height\)\)\s*;/,
    );
    expect(recommendationsPeekRule).toMatch(/--fh-bookings-extra-height:\s*148px\s*;/);
    expect(splitFooterRule).toMatch(
      /grid-template-columns:\s*minmax\(0, 3fr\) minmax\(0, 2fr\)\s*;/,
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

  it('keeps the requested Home V3 promotion spacing', () => {
    expect(ruleBody('.fh-hero--v3 .fh-hero-promotion')).toMatch(/margin-top:\s*4px\s*;/);
    expect(ruleBody('.fh-hero--v3 .fh-actions')).toMatch(/margin-top:\s*11px\s*;/);
  });

  it('keeps the preferences edit icon white and half-sized beside the tab label', () => {
    const editRule = ruleBody('.figma-home .fh-preferences-edit');
    const iconRule = ruleBody('.figma-home .fh-preferences-edit svg');

    expect(editRule).toMatch(/width:\s*12px\s*;/);
    expect(editRule).toMatch(/height:\s*12px\s*;/);
    expect(editRule).toMatch(/color:\s*#fff\s*;/);
    expect(iconRule).toMatch(/width:\s*8px\s*;/);
    expect(iconRule).toMatch(/height:\s*8px\s*;/);
  });

  it('does not retain the removed recommendation explanation styles', () => {
    expect(styles).not.toContain('.booking-recommendation-explainer');
    expect(styles).not.toContain('.has-recommendation-explainer');
    expect(styles).not.toContain('.fh-community-title');
    expect(styles).not.toContain('.fh-community-search small');
    expect(styles).not.toMatch(/^\.game-card::before\s*\{/m);
  });

  it('keeps the recommendation loader visible at the top of the mobile sheet', () => {
    const loaderRule = ruleBody('.fh-for-me-loader');

    expect(loaderRule).toMatch(/display:\s*grid\s*;/);
    expect(loaderRule).toMatch(/place-items:\s*start center\s*;/);
    expect(loaderRule).toMatch(/padding:\s*16px 8px\s*;/);
  });

  it('keeps the Home V3 pulse loader centered and respects reduced motion', () => {
    expect(ruleBody('.fh-for-me-loader--pulse')).toMatch(/place-items:\s*center\s*;/);
    expect(ruleBody('.fh-loader-pulse i')).toMatch(/animation:\s*fh-loader-pulse/);
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.fh-loader-pulse i\s*\{[\s\S]*?animation:\s*none\s*;/,
    );
  });

  it('keeps the Home V3 recommendation grid isolated to two columns', () => {
    const v3ShellRule = ruleBody('.figma-home-shell.is-home-v3');
    const v3HomeRule = ruleBody('.figma-home-shell.is-home-v3 .figma-home');
    const v3MainBoxRule = ruleBody('.figma-home-shell.is-home-v3 .fh-main-box');
    const v3RowsShellRule = ruleBody('.figma-home-shell.is-home-v3-rows');
    const v3RowsHomeRule = ruleBody('.figma-home-shell.is-home-v3-rows .figma-home');
    const v3MyExtrasShellRule = ruleBody('.figma-home-shell.has-v3-my-extras');
    const v3MyExtrasRule = ruleBody('.fh-v3-my-extras');
    const v3GridRule = ruleBody(
      '.figma-home-shell.is-home-v3 .fh-for-me .booking-recommendations.is-compact',
    );
    const v3CardRule = ruleBody('.figma-home-shell.is-home-v3 .fh-for-me .booking-recommendation');

    expect(v3ShellRule).toMatch(
      /min-height:\s*calc\(937px \+ var\(--fh-bookings-extra-height\) \+ var\(--fh-my-extras-height\)\)\s*;/,
    );
    expect(v3HomeRule).toMatch(/--gap-tabs-sheet:\s*3px\s*;/);
    expect(v3HomeRule).toMatch(/--sheet-padding-x:\s*6px\s*;/);
    expect(v3HomeRule).toMatch(
      /height:\s*calc\(937px \+ var\(--fh-bookings-extra-height\) \+ var\(--fh-my-extras-height\)\)\s*;/,
    );
    expect(v3HomeRule).toMatch(/background-color:\s*#fff\s*;/);
    expect(v3HomeRule).toMatch(
      /background-size:\s*100% calc\(435px \+ env\(safe-area-inset-top,\s*0px\)\)\s*;/,
    );
    expect(v3MainBoxRule).toMatch(
      /height:\s*calc\(522px \+ var\(--fh-bookings-extra-height\) \+ var\(--fh-my-extras-height\)\)\s*;/,
    );
    expect(v3RowsShellRule).toMatch(
      /min-height:\s*calc\(937px \+ var\(--fh-bookings-extra-height\) \+ var\(--fh-my-extras-height\)\)\s*;/,
    );
    expect(v3RowsHomeRule).toMatch(/--sheet-padding-x:\s*6px\s*;/);
    expect(v3MyExtrasShellRule).toMatch(/--fh-my-extras-height:\s*780px\s*;/);
    expect(v3MyExtrasRule).toMatch(/min-height:\s*722px\s*;/);
    expect(v3MyExtrasRule).toMatch(/padding:\s*24px 0 32px\s*;/);
    expect(v3MyExtrasRule).toMatch(/gap:\s*24px\s*;/);
    expect(v3GridRule).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/);
    expect(v3GridRule).toMatch(/grid-auto-rows:\s*minmax\(178px,\s*auto\)\s*;/);
    expect(v3GridRule).toMatch(/padding-right:\s*10px\s*;/);
    expect(v3GridRule).toMatch(/margin-right:\s*-10px\s*;/);
    expect(v3GridRule).toMatch(/gap:\s*10px\s*;/);
    expect(v3GridRule).toMatch(/overflow-x:\s*hidden\s*;/);
    expect(v3CardRule).toMatch(/position:\s*relative\s*;/);
    expect(v3CardRule).toMatch(/overflow:\s*visible\s*;/);
    expect(v3CardRule).toMatch(/border-radius:\s*18px\s*;/);
    expect(v3CardRule).toMatch(
      /background-image:\s*linear-gradient\(rgb\(255 255 255 \/ 15%\),\s*rgb\(255 255 255 \/ 15%\)\),\s*var\(--booking-card-background-image\)\s*;/,
    );
    expect(styles).not.toMatch(
      /\.booking-recommendation\[data-booking-card-background-tone='training'\]\s*\{[^}]*background-image\s*:/s,
    );
    expect(ruleBody('.fh-for-me .booking-recommendations.is-compact')).not.toMatch(
      /grid-template-columns\s*:/,
    );
  });

  it('uses compact photo-grid proportions without recommendation-card decoration', () => {
    const gridRule = ruleBody(
      '.figma-home-shell.is-home-v3 .fh-for-me .booking-recommendations.is-photo-grid',
    );
    const heroRule = ruleBody('.recommendation-grid-card__hero');
    const cardRule = ruleBody('.recommendation-grid-card');
    const bodyRule = ruleBody('.recommendation-grid-card__body');
    const titleRule = ruleBody('.recommendation-grid-card__title');
    const socialRule = ruleBody('.recommendation-grid-card__social');
    const socialAvatarRule = ruleBody(
      '.figma-home-shell.is-home-v3 .recommendation-grid-card__social .participant-avatar-stack',
    );
    const socialAvatarItemRule = ruleBody(
      '.figma-home-shell.is-home-v3 .recommendation-grid-card__social .participant-avatar-stack__item',
    );
    const socialAvatarVisualMatch = styles.match(
      /\.figma-home-shell\.is-home-v3\s+\.recommendation-grid-card__social\s+\.participant-avatar-stack__item\s+>\s+\[data-player-level-avatar\]\s*\{([^}]*)\}/,
    );
    expect(socialAvatarVisualMatch).not.toBeNull();
    const socialAvatarVisualRule = socialAvatarVisualMatch?.[1] ?? '';
    const socialAvailabilityRule = ruleBody('.recommendation-grid-card__availability');
    const footerRule = ruleBody('.recommendation-grid-card__footer');
    const actionRule = ruleBody('.recommendation-grid-card__action');
    const actionIconRule = ruleBody('.recommendation-grid-card__action svg');

    expect(gridRule).toMatch(/grid-auto-rows:\s*minmax\(242px,\s*auto\)\s*;/);
    expect(gridRule).toMatch(/align-items:\s*stretch\s*;/);
    expect(gridRule).toMatch(/padding-right:\s*0\s*;/);
    expect(gridRule).toMatch(/margin-right:\s*0\s*;/);
    expect(gridRule).toMatch(/gap:\s*8px\s*;/);
    expect(heroRule).toMatch(/height:\s*72px\s*;/);
    expect(heroRule).toMatch(/flex:\s*0 0 72px\s*;/);
    expect(cardRule).toMatch(/height:\s*100%\s*;/);
    expect(bodyRule).not.toMatch(/min-height\s*:/);
    expect(bodyRule).toMatch(/flex:\s*1\s*;/);
    expect(titleRule).toMatch(/-webkit-line-clamp:\s*2\s*;/);
    expect(titleRule).not.toMatch(/min-height\s*:/);
    expect(titleRule).toMatch(/line-height:\s*1\.24\s*;/);
    expect(titleRule).not.toMatch(/flex-shrink\s*:/);
    expect(socialRule).toMatch(/margin-top:\s*0\s*;/);
    expect(socialAvatarRule).toMatch(/order:\s*0\s*;/);
    expect(socialAvatarRule).toMatch(/height:\s*32px\s*;/);
    expect(socialAvatarRule).toMatch(/padding:\s*0 6px\s*;/);
    expect(socialAvatarItemRule).toMatch(/width:\s*32px\s*;/);
    expect(socialAvatarItemRule).toMatch(/height:\s*32px\s*;/);
    expect(socialAvatarItemRule).toMatch(/margin:\s*0 -6px\s*;/);
    expect(socialAvatarVisualRule).toMatch(/transform:\s*scale\(0\.6666667\)\s*;/);
    expect(socialAvailabilityRule).toMatch(/order:\s*1\s*;/);
    expect(footerRule).toMatch(/align-items:\s*flex-end\s*;/);
    expect(footerRule).toMatch(/margin-top:\s*auto\s*;/);
    expect(footerRule).toMatch(/min-height:\s*40px\s*;/);
    expect(actionRule).toMatch(/width:\s*47px\s*;/);
    expect(actionRule).toMatch(/height:\s*40px\s*;/);
    expect(actionRule).toMatch(/background:\s*transparent\s*;/);
    expect(actionRule).not.toMatch(/gradient/i);
    expect(actionIconRule).toMatch(/width:\s*57px\s*;/);
    expect(actionIconRule).toMatch(/transform:\s*translate\(-5px,\s*-3px\)\s*;/);
    expect(styles).toMatch(
      /@media \(min-width: 413px\)[\s\S]*?--sheet-padding-x:\s*16px[\s\S]*?\.booking-recommendations\.is-photo-grid\s*\{[\s\S]*?grid-auto-rows:\s*minmax\(242px,\s*auto\)[\s\S]*?gap:\s*12px[\s\S]*?\.recommendation-grid-card__hero\s*\{[\s\S]*?height:\s*76px/,
    );
  });

  it('matches training and tournament type typography to game type tags', () => {
    const activityKindRule = ruleBody('.booking-activity-card__kind');
    const trainingKindRule = ruleBody('.booking-activity-card__kind--training');
    const trainingKindIconRule = ruleBody(
      '.booking-activity-card__kind--training .booking-activity-card__kind-icon',
    );
    const trainingKindIconSvgRule = ruleBody(
      '.booking-activity-card__kind--training .booking-activity-card__kind-icon svg',
    );
    const trainingKindLabelRule = ruleBody(
      '.booking-activity-card__kind--training .booking-activity-card__kind-label',
    );
    const tournamentKindRule = ruleBody('.booking-activity-card__kind--tournament');
    const tournamentKindIconRule = ruleBody(
      '.booking-activity-card__kind--tournament .booking-activity-card__kind-icon',
    );
    const tournamentKindLabelRule = ruleBody(
      '.booking-activity-card__kind--tournament .booking-activity-card__kind-label',
    );
    const coachKindRule = ruleBody('.booking-activity-card__kind--coach-game');
    const coachKindLabelRule = ruleBody(
      '.booking-activity-card__kind--coach-game .booking-activity-card__kind-label',
    );
    const gameTypeRule = ruleBody('.fh-event__tag');

    expect(activityKindRule).toMatch(
      /font-family:\s*'RF Dewi',\s*'Inter Display',\s*sans-serif\s*;/,
    );
    expect(activityKindRule).toMatch(/font-size:\s*8px\s*;/);
    expect(activityKindRule).toMatch(/font-weight:\s*700\s*;/);
    expect(activityKindRule).toMatch(/letter-spacing:\s*0\.12em\s*;/);
    expect(trainingKindRule).toMatch(/width:\s*123px\s*;/);
    expect(trainingKindRule).toMatch(/height:\s*14px\s*;/);
    expect(trainingKindRule).toMatch(/padding:\s*2px 5px\s*;/);
    expect(trainingKindRule).toMatch(/margin:\s*0 auto\s*;/);
    expect(trainingKindRule).toMatch(/gap:\s*6px\s*;/);
    expect(trainingKindRule).toMatch(/border-radius:\s*24px\s*;/);
    expect(trainingKindRule).toMatch(/background:\s*transparent\s*;/);
    expect(trainingKindRule).toMatch(/color:\s*#50b1f9\s*;/);
    expect(trainingKindIconRule).toMatch(/width:\s*8px\s*;/);
    expect(trainingKindIconRule).toMatch(/height:\s*10px\s*;/);
    expect(trainingKindIconSvgRule).toMatch(/left:\s*-2px\s*;/);
    expect(trainingKindIconSvgRule).toMatch(/width:\s*10px\s*;/);
    expect(trainingKindIconSvgRule).toMatch(/height:\s*10px\s*;/);
    expect(trainingKindLabelRule).toMatch(/width:\s*99px\s*;/);
    expect(trainingKindLabelRule).toMatch(/height:\s*8px\s*;/);
    expect(trainingKindLabelRule).toMatch(/line-height:\s*8px\s*;/);
    expect(trainingKindLabelRule).toMatch(/text-align:\s*center\s*;/);
    expect(tournamentKindRule).toMatch(/width:\s*123px\s*;/);
    expect(tournamentKindRule).toMatch(/height:\s*14px\s*;/);
    expect(tournamentKindRule).toMatch(/padding:\s*2px 5px\s*;/);
    expect(tournamentKindRule).toMatch(/justify-content:\s*flex-end\s*;/);
    expect(tournamentKindRule).toMatch(/margin:\s*0 0 0 auto\s*;/);
    expect(tournamentKindRule).toMatch(/gap:\s*6px\s*;/);
    expect(tournamentKindRule).toMatch(/background:\s*transparent\s*;/);
    expect(tournamentKindRule).toMatch(/color:\s*#e4681f\s*;/);
    expect(tournamentKindIconRule).toMatch(/width:\s*8px\s*;/);
    expect(tournamentKindIconRule).toMatch(/height:\s*8px\s*;/);
    expect(tournamentKindLabelRule).toMatch(/width:\s*99px\s*;/);
    expect(tournamentKindLabelRule).toMatch(/color:\s*#e4681f\s*;/);
    expect(tournamentKindLabelRule).toMatch(/line-height:\s*8px\s*;/);
    expect(coachKindRule).toMatch(/color:\s*#8766eb\s*;/);
    expect(coachKindLabelRule).toMatch(/color:\s*#8766eb\s*;/);
    expect(gameTypeRule).toMatch(/padding:\s*2px 5px\s*;/);
    expect(gameTypeRule).toMatch(/gap:\s*6px\s*;/);
  });

  it('keeps the Home V3 mini create action inside the card edge', () => {
    const actionRule = ruleBody('.game-card__actions--mini-create');
    const buttonRule = ruleBody('.game-card.is-compact .game-card__button--mini-create');
    const staticCrossRule = ruleBody('.game-card__button--static .fh-create-cross');
    const participantStackRule = ruleBody(
      '.figma-home-shell.is-home-v3 .fh-for-me .participant-avatar-stack',
    );
    const participantItemRuleMatch = styles.match(
      /\.figma-home-shell\.is-home-v3 \.fh-for-me \.participant-avatar-stack__item,\s*\.figma-home-shell\.is-home-v3 \.fh-for-me \.participant-avatar-stack__open-slot\s*\{([^}]*)\}/,
    );
    expect(participantItemRuleMatch).not.toBeNull();
    const participantItemRule = participantItemRuleMatch?.[1] ?? '';

    expect(actionRule).toMatch(/position:\s*absolute\s*;/);
    expect(actionRule).toMatch(/right:\s*-10px\s*;/);
    expect(actionRule).toMatch(/bottom:\s*-10px\s*;/);
    expect(buttonRule).toMatch(/width:\s*57px\s*;/);
    expect(buttonRule).toMatch(/height:\s*47px\s*;/);
    expect(buttonRule).toMatch(/overflow:\s*hidden\s*;/);
    expect(buttonRule).toMatch(/background:\s*transparent\s*;/);
    expect(ruleBody('.game-card__button--mini-create svg')).toMatch(
      /transform:\s*translateX\(8px\)\s*;/,
    );
    expect(staticCrossRule).toMatch(/animation:\s*none\s*;/);
    expect(staticCrossRule).toMatch(/transform:\s*none\s*;/);
    expect(participantStackRule).toMatch(/width:\s*119px\s*;/);
    expect(participantStackRule).toMatch(/height:\s*35px\s*;/);
    expect(participantStackRule).toMatch(/padding:\s*0\s*;/);
    expect(participantStackRule).toMatch(/gap:\s*0\s*;/);
    expect(participantStackRule).toMatch(/isolation:\s*isolate\s*;/);
    expect(participantStackRule).toMatch(/overflow:\s*visible\s*;/);
    expect(participantItemRule).toMatch(/width:\s*32px\s*;/);
    expect(participantItemRule).toMatch(/height:\s*32px\s*;/);
    expect(participantItemRule).toMatch(/margin:\s*0 -6px\s*;/);
    expect(
      ruleBody('.figma-home-shell.is-home-v3 .fh-for-me .participant-avatar-stack > :nth-child(1)'),
    ).toMatch(/z-index:\s*3\s*;/);
    expect(
      ruleBody('.figma-home-shell.is-home-v3 .fh-for-me .participant-avatar-stack > :nth-child(4)'),
    ).toMatch(/z-index:\s*0\s*;/);
    expect(
      ruleBody(
        '.figma-home-shell.is-home-v3 .participant-avatar-stack__item > [data-player-level-avatar]',
      ),
    ).toMatch(/transform:\s*scale\(0\.6666667\)\s*;/);
    expect(
      ruleBody('.figma-home-shell.is-home-v3 .fh-for-me .participant-avatar-stack__open-slot svg'),
    ).toMatch(/width:\s*32px\s*;/);
    const hostRosterRule = ruleBody(
      '.figma-home-shell.is-home-v3 .fh-for-me .booking-activity-card__host-roster',
    );
    const hostRosterAvatarRuleMatch = styles.match(
      /\.figma-home-shell\.is-home-v3\s+\.fh-for-me\s+\.booking-activity-card__host-avatar\s+\.participant-avatar-stack\s*\{([^}]*)\}/,
    );
    expect(hostRosterAvatarRuleMatch).not.toBeNull();
    const hostRosterAvatarRule = hostRosterAvatarRuleMatch?.[1] ?? '';
    const openSlotsRule = ruleBody(
      '.figma-home-shell.is-home-v3 .fh-for-me .booking-activity-card__open-slots',
    );
    const openSlotsItemRuleMatch = styles.match(
      /\.figma-home-shell\.is-home-v3\s+\.fh-for-me\s+\.booking-activity-card__open-slots\s+\.participant-avatar-stack__open-slot\s*\{([^}]*)\}/,
    );
    expect(openSlotsItemRuleMatch).not.toBeNull();
    const openSlotsItemRule = openSlotsItemRuleMatch?.[1] ?? '';
    expect(hostRosterRule).toMatch(/gap:\s*8px\s*;/);
    expect(hostRosterAvatarRule).toMatch(/order:\s*0\s*;/);
    expect(openSlotsRule).toMatch(/width:\s*max-content\s*;/);
    expect(openSlotsRule).toMatch(/order:\s*1\s*;/);
    expect(openSlotsItemRule).toMatch(/margin:\s*0 -8px\s*;/);
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
