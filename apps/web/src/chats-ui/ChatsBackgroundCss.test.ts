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
  it('paints the conversation pane with the shared wallpaper', () => {
    const thread = ruleBodies('.thread').join('\n');

    expect(thread).toContain(wallpaper);
    expect(thread).toMatch(/background-position:\s*center,\s*center;/);
    expect(thread).toMatch(/background-repeat:\s*no-repeat,\s*no-repeat;/);
    expect(thread).toMatch(/background-size:\s*cover,\s*cover;/);
    expect(thread).toMatch(/linear-gradient\(rgb\(255 255 255 \/ 12%\)/);
  });

  it('paints the conversation placeholder with the same wallpaper', () => {
    expect(ruleBodies('.threadPlaceholder').join('\n')).toContain(wallpaper);
  });

  it('keeps the message surface and empty states transparent over the pane', () => {
    for (const selector of ['.messages', '.threadEmpty', '.emptyState']) {
      for (const body of ruleBodies(selector)) {
        for (const declaration of body.matchAll(/background(?:-color|-image)?\s*:\s*([^;]+);/g)) {
          expect(declaration[1]?.trim(), `${selector} must not hide the pane background`).toBe(
            'transparent',
          );
        }
      }
    }
  });

  it('ships the wallpaper instead of the replaced sleeve pattern', () => {
    expect(styles).not.toContain('padlhub-sleeve-wallpaper');
    expect(styles.match(/chats-background\.webp/g)).toHaveLength(2);
  });

  it('keeps copy that sits on the artwork on the ink token', () => {
    for (const selector of ['.threadEmpty', '.threadPlaceholder']) {
      expect(ruleBodies(selector).join('\n')).toMatch(/color:\s*var\(--comms-ink\);/);
    }
  });
});
