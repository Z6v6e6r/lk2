import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./ChatsUi.module.css', import.meta.url), 'utf8');
const wallpaper = "url('../assets/chats-background.webp')";

function ruleBodies(selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)([^{}]*${escapedSelector}(?![\\w-])[^{}]*)\\{([^}]*)\\}`,
    'g',
  );
  const bodies = [...styles.matchAll(pattern)].map((match) => match[2] ?? '');
  expect(bodies.length, `CSS rule for ${selector} must exist`).toBeGreaterThan(0);
  return bodies;
}

describe('chat background contract', () => {
  it('paints the whole chats screen with the shared wallpaper', () => {
    const page = ruleBodies('.page').join('\n');

    expect(page).toContain(wallpaper);
    expect(page).toMatch(/background-position:\s*center,\s*center;/);
    expect(page).toMatch(/background-repeat:\s*no-repeat,\s*no-repeat;/);
    expect(page).toMatch(/background-size:\s*cover,\s*cover;/);
    expect(page).toMatch(/linear-gradient\(rgb\(255 255 255 \/ 12%\)/);
  });

  it('keeps the wallpaper on phones instead of resetting the page to white', () => {
    const pageBodies = ruleBodies('.page');

    expect(pageBodies.length, 'the mobile layout must override .page').toBeGreaterThan(1);
    for (const body of pageBodies) {
      expect(body, '.page must never fall back to an opaque white screen').not.toMatch(
        /background(?:-color)?\s*:\s*#fff/,
      );
    }
  });

  it('keeps every pane transparent so the wallpaper reaches the list and the conversation', () => {
    for (const selector of [
      '.shell',
      '.listPane',
      '.thread',
      '.threadBody',
      '.messages',
      '.threadPlaceholder',
    ]) {
      for (const body of ruleBodies(selector)) {
        for (const declaration of body.matchAll(/background(?:-color|-image)?\s*:\s*([^;]+);/g)) {
          expect(declaration[1]?.trim(), `${selector} must not hide the page wallpaper`).toBe(
            'transparent',
          );
        }
      }
    }
  });

  it('keeps copy that sits on the artwork on the ink token', () => {
    for (const selector of ['.threadEmpty', '.threadPlaceholder', '.emptyState p']) {
      expect(ruleBodies(selector).join('\n')).toMatch(/color:\s*var\(--comms-ink\);/);
    }
  });

  it('ships the wallpaper once and no longer ships the replaced sleeve pattern', () => {
    expect(styles).not.toContain('padlhub-sleeve-wallpaper');
    expect(styles.match(/chats-background\.webp/g)).toHaveLength(1);
  });
});
