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

describe('station logo frame', () => {
  it('keeps the squared-off station frame instead of the round participant avatar', () => {
    const start = styles.indexOf('.stationAvatar {');
    expect(start, 'the .stationAvatar block must exist').toBeGreaterThan(-1);
    const body = styles.slice(start, styles.indexOf('}', start));

    // The design frame is a 36px square with an 8px corner radius, so the radius stays proportional.
    expect(body).toMatch(/border-radius:\s*22\.222%\s*;/);
    expect(body).not.toMatch(/border-radius:\s*50%\s*;/);
    expect(body).toMatch(/overflow:\s*hidden\s*;/);
  });

  it('narrows the logo frame to the 36px phone header column', () => {
    const phone = atRule('@media (max-width: 767px)');

    expect(phone).toMatch(/\.stationThreadHeader \.stationAvatar\s*\{[^}]*width:\s*36px\s*;/);
    expect(phone).toMatch(/\.stationThreadHeader \.stationAvatar\s*\{[^}]*height:\s*36px\s*;/);
  });
});
