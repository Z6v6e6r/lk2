import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./ChatsUi.module.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/** Extracts every at-rule body for one marker, so several blocks can be asserted together. */
function atRuleBodies(marker: string): string {
  const bodies: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = styles.indexOf(marker, searchFrom);
    if (start === -1) break;
    const open = styles.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = open; index < styles.length; index += 1) {
      const char = styles[index];
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unterminated ${marker} block`);
    bodies.push(styles.slice(open + 1, end));
    searchFrom = end;
  }
  expect(bodies.length, `the ${marker} block must exist`).toBeGreaterThan(0);
  return bodies.join('\n');
}

/** Everything outside the phone blocks, used to prove a rule is not global. */
function outsidePhoneBlocks(): string {
  const blocks: Array<{ readonly start: number; readonly end: number }> = [];
  let searchFrom = 0;
  for (;;) {
    const start = styles.indexOf('@media (max-width: 767px)', searchFrom);
    if (start === -1) break;
    const open = styles.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = open; index < styles.length; index += 1) {
      const char = styles[index];
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) throw new Error('unterminated phone block');
    blocks.push({ start, end: end + 1 });
    searchFrom = end;
  }
  let remainder = '';
  let cursor = 0;
  for (const block of blocks) {
    remainder += styles.slice(cursor, block.start);
    cursor = block.end;
  }
  return remainder + styles.slice(cursor);
}

describe('chats thread keyboard geometry', () => {
  it('lets the on-screen keyboard shrink the layout viewport', () => {
    // Chrome Android defaults to `resizes-visual`, which leaves the layout viewport (and therefore
    // `100dvh`) at its full height while the keyboard covers the lower part of the screen.
    expect(indexHtml).toMatch(/name="viewport"[\s\S]{0,200}interactive-widget=resizes-content/);
  });

  it('reserves the navigation strip on a phone and drops it while the composer is focused', () => {
    const phone = atRuleBodies('@media (max-width: 767px)');

    // The composer's bottom edge is the navigation's top edge: the page is one viewport tall and the
    // bar's height is reserved, never more.
    expect(phone).toMatch(/\.threadPage\s*\{[^}]*height:\s*100dvh\s*;/);
    expect(phone).toMatch(/\.threadPage\s*\{[^}]*padding-bottom:\s*var\(--chat-nav-height\)\s*;/);
    expect(phone).toMatch(
      /\.threadPage :global\(\.fh-bottom-nav\)\s*\{[^}]*display:\s*flex\s*;[^}]*height:\s*var\(--chat-nav-height\)\s*;/,
    );

    // While the keyboard is open the reservation is dropped together with the bar, otherwise the
    // strip stays behind as an empty band between the composer and the keyboard.
    expect(phone).toMatch(/\.page:has\(\.composer:focus-within\)\s*\{[^}]*padding-bottom:\s*0\s*;/);
    expect(phone).toMatch(
      /\.page:has\(\.composer:focus-within\)\s*:global\(\.fh-bottom-nav\)\s*\{[^}]*display:\s*none\s*;/,
    );
    // The list-mode station thread shares the phone shell, so its `.shell` must fill the viewport
    // once the reservation is gone.
    expect(phone).toMatch(
      /\.page:has\(\.composer:focus-within\) \.shell\s*\{[^}]*height:\s*100dvh\s*;/,
    );
  });

  it('keeps the reservation out of the desktop shell, where the bar is hidden', () => {
    const desktop = atRuleBodies('@media (min-width: 768px)');

    expect(desktop).toMatch(/\.shell\s*\{[^}]*height:\s*calc\(100dvh - 40px\)\s*;/);
    expect(desktop).toMatch(/\.page :global\(\.fh-bottom-nav\)\s*\{[^}]*display:\s*none\s*;/);

    // An unconditional `.threadPage` rule used to reserve the bar and re-show it at every width,
    // which left a wallpaper band under the composer on desktop and defeated the rule above.
    expect(outsidePhoneBlocks()).not.toMatch(/\.threadPage\s*\{/);
  });
});
