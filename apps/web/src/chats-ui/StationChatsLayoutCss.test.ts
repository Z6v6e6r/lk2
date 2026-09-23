import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./ChatsUi.module.css', import.meta.url), 'utf8');

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

describe('station thread phone layout', () => {
  it('makes the thread mode class the single-pane switch on a phone', () => {
    const phone = atRule('@media (max-width: 767px)');

    // A station is picked from the list without leaving `/chats`, so the phone screen only opens the
    // dialog because `ChatsPage` moves the shell into thread mode: the list pane goes away here.
    expect(phone).toMatch(/\.threadMode \.listPane[^{}]*\{[^}]*display:\s*none\s*;/);
    expect(phone).toMatch(/\.listMode \.thread[^{}]*\{[^}]*display:\s*none\s*;/);
  });

  it('gives the station header four columns because it has no notification control', () => {
    const phone = atRule('@media (max-width: 767px)');

    expect(phone).toMatch(
      /\.stationThreadHeader\s*\{[^}]*grid-template-columns:\s*44px 36px minmax\(0, 1fr\) 44px\s*;/,
    );
  });
});
