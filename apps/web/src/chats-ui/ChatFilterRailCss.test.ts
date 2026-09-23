import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./ChatsUi.module.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(found, `CSS rule ${selector} must exist`).not.toBeNull();
  return found?.[1] ?? '';
}

/** Extracts an at-rule body by brace matching, so nested rules stay intact. */
function atRule(marker: string): string {
  const start = styles.indexOf(marker);
  expect(start, `the ${marker} block must exist`).toBeGreaterThan(-1);
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
  throw new Error(`unterminated ${marker} block`);
}

describe('chat filter rail layout', () => {
  it('never squeezes the pictogram away inside a compressed button', () => {
    // A label cannot shrink, so without a floor the icon collapses to zero width and the rail reads
    // as text only, with labels overlapping their neighbours.
    expect(ruleBody('.filterRail svg')).toMatch(/flex:\s*0 0 20px\s*;/);
  });

  it('keeps the compact icon rail in every layout the app ships', () => {
    // The list pane is 340–390px wide on desktop too — the same width a phone already collapses for —
    // while seven labelled chips need roughly 850px. A viewport-gated collapse left the desktop rail
    // squeezing every label over its neighbour's pictogram.
    expect(ruleBody('.filterLabel')).toMatch(/display:\s*none\s*;/);
    expect(styles).not.toMatch(/\.filterLabel\s*\{[^}]*display:\s*inline/);
  });

  it('keeps accessible touch targets that a squeezed chip cannot undercut', () => {
    const chips = ruleBody('.filterRail button,\n.filterRail a');

    expect(chips).toMatch(/min-width:\s*44px\s*;/);
    expect(chips).toMatch(/min-height:\s*44px\s*;/);
    expect(chips).toMatch(/box-sizing:\s*border-box\s*;/);
    expect(chips).toMatch(/flex:\s*1 1 0\s*;/);
  });

  it('leaves the rail layout to the filter rail rule alone', () => {
    const phone = atRule('@media (max-width: 767px)');

    expect(phone).not.toMatch(/\.filterLabel/);
    expect(phone).not.toMatch(/\.filterRail/);
  });
});
