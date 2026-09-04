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
    expect(ruleBody('.subscription-plan-rail__item')).toContain('scroll-snap-align: center');
  });

  it('uses a horizontal flex card rail instead of a three-column grid on tablet and desktop', () => {
    expect(css).not.toContain('grid-template-columns: repeat(3');
    expect(ruleBody('.subscription-plan-rail')).toContain('display: flex');
    expect(ruleBody('.subscription-plan-rail__item')).toContain(
      'flex: 0 0 var(--subscription-card-width)',
    );

    const tablet = css.slice(css.indexOf('@media (min-width: 720px)'));
    expect(tablet).toContain('--subscription-card-width: min(460px, calc(100vw - 64px))');
    expect(tablet).toContain('scroll-snap-type: none');
    expect(tablet).toContain('--subscription-rail-snap-pad: var(--subscription-rail-inset)');
    expect(tablet).toContain('scroll-snap-align: none');

    const desktop = css.slice(css.indexOf('@media (min-width: 1280px)'));
    expect(desktop).toContain('--subscription-card-width: 480px');
  });

  it('styles every card with a gradient wrapper, progress strip and white panel', () => {
    expect(ruleBody('.subscription-card')).toContain(
      'background: linear-gradient(180deg, #9c80f2 0%, #fafafa 100%)',
    );
    expect(ruleBody('.subscription-card')).not.toContain('box-shadow');
    expect(ruleBody('.subscription-card__panel')).toContain(
      'box-shadow: -4px 4px 8px 0 #1f1e2005',
    );
    expect(ruleBody('.subscription-card--no-progress')).toContain(
      'background: transparent',
    );
    expect(ruleBody('.subscription-card__progress')).toContain('justify-content: space-between');
    expect(ruleBody('.subscription-card__progress')).toContain(
      'padding: 0 clamp(16px, 1.3vw, 24px)',
    );
    expect(ruleBody('.subscription-card__panel')).toContain('height: 100%');
    expect(ruleBody('.subscription-card__panel')).toContain('border: 0.5px solid #ededed');
    expect(ruleBody('.subscription-card__panel')).toContain('border-radius: clamp(18px, 1.3vw, 24px)');
    expect(ruleBody('.subscription-card__panel')).toContain('gap: clamp(18px, 1.7vw, 32px)');
    expect(ruleBody('.subscription-card__panel')).toContain(
      'padding: clamp(20px, 1.9vw, 36px) clamp(18px, 1.7vw, 32px) clamp(28px, 2.72vw, 52px)',
    );
    expect(ruleBody('.subscription-storefront__nav-button')).not.toContain('background: #fff');
    expect(ruleBody('.subscription-storefront__nav-button')).toContain(
      'width: clamp(40px, 4vw, 48px)',
    );
    expect(ruleBody('.subscription-storefront__nav-button')).toContain(
      'height: clamp(40px, 4vw, 48px)',
    );
    expect(ruleBody('.subscription-storefront__nav-icon')).toContain('width: 100%');
    expect(ruleBody('.subscription-storefront__nav-icon')).toContain('height: 100%');
  });

  it('caps the content gap when an offer section header is filled', () => {
    expect(ruleBody('.subscription-storefront__content')).toContain(
      'gap: var(--subscription-hero-gap)',
    );
    expect(css).toContain(
      '.subscription-storefront__content:has(.subscription-offer-section__header)',
    );
    expect(
      ruleBody('.subscription-storefront__content:has(.subscription-offer-section__header)'),
    ).toContain('gap: clamp(36px, 5vw, 48px)');
  });

  it('adapts the section gap and offer-section header typography', () => {
    expect(ruleBody('.subscription-storefront__sections')).toContain(
      'gap: clamp(24px, 4vw, 48px)',
    );
    expect(ruleBody('.subscription-offer-section__header h2')).toContain(
      'font-size: clamp(18px, 2.5vw, 24px)',
    );
    expect(ruleBody('.subscription-offer-section__header p')).toContain(
      'font-size: clamp(13px, 2vw, 16px)',
    );
  });

  it('bleeds the plan rail to the display edge with center snap when overflowing', () => {
    expect(ruleBody('.subscription-plan-rail')).toContain('width: 100vw');
    expect(ruleBody('.subscription-plan-rail')).toContain('margin-left: calc(50% - 50vw)');
    expect(ruleBody('.subscription-plan-rail')).toContain('justify-content: center');
    expect(ruleBody('.subscription-plan-rail')).toContain(
      'padding-inline: var(--subscription-rail-inset)',
    );
    expect(ruleBody('.subscription-plan-rail')).toContain(
      'calc((100vw - var(--subscription-card-width)) / 2)',
    );
    expect(css).toContain(".subscription-plan-rail[data-overflow='true']");
    expect(ruleBody(".subscription-plan-rail[data-overflow='true']")).toContain(
      'justify-content: flex-start',
    );
    expect(ruleBody(".subscription-plan-rail[data-overflow='true']")).toContain(
      'padding-inline: 0',
    );
    expect(css).toContain(".subscription-plan-rail[data-overflow='true']::before");
    expect(css).toContain(".subscription-plan-rail[data-overflow='true']::after");
    expect(css).toContain(
      'flex: 0 0 max(0px, calc(var(--subscription-rail-snap-pad) - var(--subscription-rail-gap)))',
    );
    expect(ruleBody('.subscription-plan-rail__item')).toContain('scroll-snap-align: center');
    const desktop = css.slice(css.indexOf('@media (min-width: 1280px)'));
    expect(desktop).not.toMatch(/margin-inline:\s*auto/);
    expect(ruleBody('.subscription-plan-rail')).toContain('gap: var(--subscription-rail-gap)');
    expect(ruleBody('.subscription-plan-rail')).toContain('align-items: stretch');
    expect(ruleBody('.subscription-plan-rail__item')).toContain('align-items: stretch');
    expect(ruleBody('.subscription-plan-rail__item')).toMatch(
      /padding: clamp\(2px, 0\.25vw, 4px\) clamp\(2px, 0\.25vw, 4px\) 0;/,
    );
    expect(ruleBody('.subscription-card')).toContain('height: 100%');
  });

  it('wraps billing options under the price only on very narrow screens', () => {
    expect(css).toContain('@media (max-width: 499px)');
    expect(css).not.toContain('@media (max-width: 719px)');
    const narrow = css.slice(css.indexOf('@media (max-width: 499px)'));
    expect(narrow).toContain('.subscription-card__billing-options');
    expect(narrow).toContain('width: 100%');
  });

  it('always reserves the progress strip and right-aligns the seats-left span', () => {
    expect(ruleBody('.subscription-card__progress span')).toContain('text-align: right');
    expect(ruleBody('.subscription-card__progress span')).toContain('flex: 1');
  });

  it('renders an art-only tag or a three-part svg badge with a default tone fallback', () => {
    expect(ruleBody('.subscription-card__tag--art')).toContain('background: transparent');
    expect(ruleBody('.subscription-card__tag--label')).toContain('background: transparent');
    expect(css).toContain('.subscription-card__badge');
    expect(css).toContain('.subscription-card__badge-text');
    expect(ruleBody('.subscription-card__badge-text')).toContain(
      'background: var(--subscription-tag-tone, var(--subscription-accent))',
    );
    expect(ruleBody('.subscription-card__badge-text')).toContain(
      "font-family: 'Subscription RF Dewi Expanded', 'Subscription RF Dewi', sans-serif",
    );
    expect(ruleBody('.subscription-card__badge-text')).toContain('font-size: 18px');
    expect(ruleBody('.subscription-card__badge-text')).toContain('font-weight: 700');
    expect(ruleBody('.subscription-card__badge > svg')).toContain('height: 100%');
    expect(ruleBody('.subscription-card__badge > svg:first-of-type')).toContain(
      'margin-inline-end: calc(var(--subscription-badge-height) * -32 / 22 * 0.3)',
    );
    expect(ruleBody('.subscription-card__badge > svg:last-of-type')).toContain(
      'margin-inline-start: calc(var(--subscription-badge-height) * -29 / 22 * 0.64)',
    );
    expect(css).toContain("font-family: 'Subscription RF Dewi Expanded'");
    expect(css).toContain('RFDewiExpanded-Bold.ttf');
  });
});
