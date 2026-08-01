import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `CSS rule ${selector} must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Profile page background', () => {
  it('applies 20% transparency only to the level artwork', () => {
    const backgroundRule = ruleBody('.profile-page::before');

    expect(backgroundRule).toMatch(/background-image:\s*var\(--profile-level-background\)\s*;/);
    expect(backgroundRule).toMatch(/opacity:\s*0\.8\s*;/);
    expect(backgroundRule).toMatch(/z-index:\s*-2\s*;/);
  });
});

describe('Profile recommendation preferences', () => {
  it('renders the two presentation previews as an equal-width selector', () => {
    const displayRule = ruleBody('.profile-recommendation-display');

    expect(displayRule).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/);
    expect(ruleBody('.profile-recommendation-display__preview.is-cards')).toMatch(
      /grid-template-columns:\s*repeat\(2,\s*1fr\)\s*;/,
    );
    expect(ruleBody('.profile-recommendation-display__preview.is-rows')).toMatch(
      /grid-template-rows:\s*repeat\(4,\s*1fr\)\s*;/,
    );
  });

  it('keeps favorite-station selection and recommendation toggles compact', () => {
    expect(ruleBody('.profile-station-select')).toMatch(/min-height:\s*34px\s*;/);
    expect(ruleBody('.profile-recommendation-toggles')).toMatch(/gap:\s*4px\s*;/);
  });
});
