import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const globalStyles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const moduleStyles = readFileSync(new URL('./ChatsUi.module.css', import.meta.url), 'utf8');

function ruleBodies(source: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)([^{}]*${escapedSelector}(?![\\w-])[^{}]*)\\{([^}]*)\\}`,
    'g',
  );
  const bodies = [...source.matchAll(pattern)].map((match) => match[2] ?? '');
  expect(bodies.length, `CSS rule for ${selector} must exist`).toBeGreaterThan(0);
  return bodies;
}

/**
 * The chat list shows the game roster at twice the thread-header size. The sizes live in CSS, so the
 * contract is pinned here: a later edit that shrinks one of the two variants back without touching
 * the other would otherwise only be visible on a rendered screen.
 */
describe('game roster avatar sizing', () => {
  it('keeps the compact stack at half the doubled one', () => {
    const compact = ruleBodies(
      globalStyles,
      '.chat-game-stack .participant-avatar-stack__item',
    ).join('\n');
    const wide = ruleBodies(
      globalStyles,
      '.chat-game-stack-wide .participant-avatar-stack__item',
    ).join('\n');

    expect(compact).toMatch(/width:\s*22px;/);
    expect(compact).toMatch(/flex:\s*0 0 22px;/);
    expect(compact).toMatch(/margin:\s*0 -7px;/);
    expect(wide).toMatch(/width:\s*44px;/);
    expect(wide).toMatch(/flex:\s*0 0 44px;/);
    expect(wide).toMatch(/margin:\s*0 -14px;/);
  });

  it('scales the shared level avatar by the circle it paints', () => {
    const compact = ruleBodies(
      globalStyles,
      '.chat-game-stack .participant-avatar-stack__item > [data-player-level-avatar]',
    ).join('\n');
    const wide = ruleBodies(
      globalStyles,
      '.chat-game-stack-wide .participant-avatar-stack__item > [data-player-level-avatar]',
    ).join('\n');

    // The level avatar renders at 48px; each variant scales it to its own circle size.
    expect(compact).toMatch(/transform:\s*scale\(0\.4583333\);/);
    expect(wide).toMatch(/transform:\s*scale\(0\.9166667\);/);
  });

  it('gives the doubled stack its own row column and keeps the header slot', () => {
    const row = ruleBodies(moduleStyles, '.rosterChatRow').join('\n');
    const wrapper = ruleBodies(moduleStyles, '.gameRosterAvatarWide').join('\n');
    const slot = ruleBodies(moduleStyles, '.gameRosterAvatar').join('\n');

    expect(row).toMatch(/grid-template-columns:\s*max-content minmax\(0, 1fr\);/);
    expect(wrapper).toMatch(/width:\s*max-content;/);
    expect(slot).toMatch(/width:\s*48px;/);
  });

  it('lets the wide stack take the width its circles need', () => {
    const wide = ruleBodies(globalStyles, '.chat-game-stack-wide').join('\n');

    expect(wide).toMatch(/width:\s*max-content;/);
    expect(wide).toMatch(/min-width:\s*48px;/);
  });
});
