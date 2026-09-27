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

/** Reads one top-level rule: the leading newline keeps a nested copy of the selector out of it. */
function rule(selector: string): string {
  const start = styles.indexOf(`\n${selector} {`);
  expect(start, `the ${selector} block must exist`).toBeGreaterThan(-1);
  return styles.slice(start, styles.indexOf('}', start));
}

describe('community thread phone layout', () => {
  it('gives the read-only community header four columns like the station header', () => {
    const phone = atRule('@media (max-width: 767px)');

    // The community thread has no notification control either, so back, logo frame, title and update
    // fill the header instead of reserving an empty fifth column.
    expect(phone).toMatch(
      /\.communityThreadHeader\s*\{[^}]*grid-template-columns:\s*44px 36px minmax\(0, 1fr\) 44px\s*;/,
    );
  });

  it('narrows the community logo frame to the 36px phone header column', () => {
    const phone = atRule('@media (max-width: 767px)');

    expect(phone).toMatch(/\.communityThreadHeader \.communityAvatar\s*\{[^}]*width:\s*36px\s*;/);
    expect(phone).toMatch(/\.communityThreadHeader \.communityAvatar\s*\{[^}]*height:\s*36px\s*;/);
  });
});

describe('community avatar frame', () => {
  it('keeps the squared group frame instead of the round participant avatar', () => {
    const body = rule('.communityAvatar');

    expect(body).toMatch(/border-radius:\s*22\.222%\s*;/);
    expect(body).not.toMatch(/border-radius:\s*50%\s*;/);
    expect(body).toMatch(/overflow:\s*hidden\s*;/);
  });

  it('lays the artwork over the initials so a failed load reveals them', () => {
    expect(styles).toMatch(/\.communityAvatarInitials\s*\{/);
    expect(rule('.communityAvatarImage')).toMatch(/position:\s*absolute\s*;/);
    expect(rule('.communityAvatarImage')).toMatch(/inset:\s*0\s*;/);
    expect(rule('.communityAvatarImage')).toMatch(/object-fit:\s*cover\s*;/);
  });
});

describe('community chat thread copy', () => {
  it('states the read-only projection in its own block under the thread', () => {
    expect(rule('.threadReadOnlyNote')).toMatch(/border-top:\s*1px solid/);
  });
});
