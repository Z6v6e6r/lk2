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
});
