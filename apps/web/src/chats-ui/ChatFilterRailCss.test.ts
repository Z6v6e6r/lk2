import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./ChatsUi.module.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(found, `CSS rule ${selector} must exist`).not.toBeNull();
  return found?.[1] ?? '';
}

/** Extracts the body of the phone media query by brace matching, so nested rules stay intact. */
function phoneMediaQuery(): string {
  const start = styles.indexOf('@media (max-width: 767px)');
  expect(start, 'the phone layout media query must exist').toBeGreaterThan(-1);
  const open = styles.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    const char = styles[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return styles.slice(open + 1, index);
    }
  }
  throw new Error('unterminated media query');
}

describe('chat filter rail on a phone', () => {
  it('never squeezes the pictogram away inside a compressed button', () => {
    // A label cannot shrink, so without a floor the icon collapses to zero width and the rail reads
    // as text only, with labels overlapping their neighbours.
    expect(ruleBody('.filterRail svg')).toMatch(/flex:\s*0 0 20px\s*;/);
  });

  it('shows the icon set on a phone instead of seven colliding labels', () => {
    const phone = phoneMediaQuery();

    expect(phone).toMatch(/\.filterLabel\s*\{[^}]*display:\s*none\s*;/);
    expect(phone).toMatch(/min-width:\s*0\s*;/);
    expect(phone).toMatch(/flex:\s*1 1 0\s*;/);
  });
});
