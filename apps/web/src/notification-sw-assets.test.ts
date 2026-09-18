import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const serviceWorker = readFileSync(
  new URL('../public/phub-notification-sw.js', import.meta.url),
  'utf8',
);

type Bitmap = { data: Buffer; width: number; height: number };

function assetPath(asset: string): string {
  return fileURLToPath(new URL(`../public/${asset}`, import.meta.url));
}

async function readBitmap(asset: string): Promise<Bitmap> {
  const { data, info } = await sharp(assetPath(asset))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixel(bitmap: Bitmap, x: number, y: number): number[] {
  const offset = (y * bitmap.width + x) * 4;
  return [...bitmap.data.subarray(offset, offset + 4)];
}

describe('notification service worker assets', () => {
  it('references only notification icons that ship with the web bundle', () => {
    const referenced = [...serviceWorker.matchAll(/'(\/phub-notification-[a-z0-9-]+\.png)'/g)].map(
      (match) => match[1] as string,
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(
        existsSync(new URL(`../public${file}`, import.meta.url)),
        `missing public asset ${file}`,
      ).toBe(true);
    }
  });

  it('keeps the presentation options the operating system needs for a visible alert', () => {
    for (const option of ['icon:', 'badge:', 'vibrate:', 'renotify: true', 'silent: false']) {
      expect(serviceWorker).toContain(option);
    }
  });
});

describe('notification brand artwork', () => {
  it('ships the sizes the notification platforms request', async () => {
    for (const size of [192, 512]) {
      const metadata = await sharp(assetPath(`phub-notification-icon-${size}.png`)).metadata();
      expect(metadata.format).toBe('png');
      expect([metadata.width, metadata.height]).toEqual([size, size]);
    }

    const badge = await sharp(assetPath('phub-notification-badge-72.png')).metadata();
    expect(badge.format).toBe('png');
    expect([badge.width, badge.height]).toEqual([72, 72]);
  });

  it('draws the PadlHub lock-up in white on the brand gradient instead of a placeholder glyph', async () => {
    const icon = await readBitmap('phub-notification-icon-192.png');
    const last = icon.width - 1;

    // The gradient runs corner to corner, so both ends pin the brand palette.
    expect(pixel(icon, 0, 0).slice(0, 3)).toEqual([177, 125, 232]);
    expect(pixel(icon, last, last).slice(0, 3)).toEqual([153, 131, 251]);
    expect(pixel(icon, last, last)[3]).toBe(255);
    expect(pixel(icon, last, 0)[3]).toBe(255);

    const opaque = countPixels(icon, (rgba) => rgba[3] === 255);
    const glyphs = countPixels(
      icon,
      (rgba) => rgba[3] === 255 && rgba.slice(0, 3).every((c) => c >= 240),
    );
    expect(opaque).toBe(icon.width * icon.height);

    // The lock-up covers a visible but bounded share of the avatar: not an empty tile, not a white square.
    expect(glyphs / opaque).toBeGreaterThan(0.03);
    expect(glyphs / opaque).toBeLessThan(0.25);
  });

  it('keeps the badge a monochrome silhouette on a transparent background, because Android tints it', async () => {
    const badge = await readBitmap('phub-notification-badge-72.png');
    const total = badge.width * badge.height;
    const clear = countPixels(badge, (rgba) => rgba[3] === 0);
    const drawn = countPixels(badge, (rgba) => rgba[3] === 255);
    const tinted = countPixels(
      badge,
      (rgba) => rgba[3] === 255 && !rgba.slice(0, 3).every((c) => c === 255),
    );

    expect(drawn).toBeGreaterThan(200);
    expect(clear / total).toBeGreaterThan(0.4);
    expect(clear / total).toBeLessThan(0.9);
    // Any colour left in the silhouette would render as a solid blob once the platform applies its tint.
    expect(tinted).toBe(0);
  });
});

function countPixels(bitmap: Bitmap, predicate: (rgba: number[]) => boolean): number {
  let count = 0;
  for (let offset = 0; offset < bitmap.data.length; offset += 4) {
    if (predicate([...bitmap.data.subarray(offset, offset + 4)])) count += 1;
  }
  return count;
}
