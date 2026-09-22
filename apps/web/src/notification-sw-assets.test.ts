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

  it('reports the display and open funnel with the token the push carried', () => {
    // A service worker has no session, so the payload's signed token is the whole authorization and the
    // report must never be able to break the notification itself.
    expect(serviceWorker).toContain('self.phubReportReceipt = function phubReportReceipt');
    expect(serviceWorker).toContain("fetch('/user/api/v1/notifications/receipts', {");
    expect(serviceWorker).toContain("credentials: 'omit'");
    expect(serviceWorker).toContain('keepalive: true');
    expect(serviceWorker).toMatch(
      /\.catch\(function ignoreReceiptFailure\(\) \{\s*\n\s*return undefined;/u,
    );
    expect(serviceWorker).toContain("self.phubReportReceipt(receiptToken, 'DISPLAYED')");
    expect(serviceWorker).toContain(
      "event.waitUntil(self.phubReportReceipt(data.receiptToken, 'OPENED'))",
    );
    // The click still navigates: the receipt is reported before the window opens.
    expect(serviceWorker).toContain('return self.clients.openWindow(deepLink);');
    // The token is optional in the payload, so an older worker payload cannot break the banner.
    expect(serviceWorker).toContain("typeof payload.receiptToken === 'string'");
  });

  it('shows the banner through a helper that has a minimal fallback for stricter engines', () => {
    // iOS ignores the artwork and has no vibration API; a rejected options dictionary must not mean a
    // silent push, so the push handler goes through the guarded helper instead of calling directly.
    expect(serviceWorker).toContain('self.phubShowNotification = function phubShowNotification');
    expect(serviceWorker).toContain('self.phubShowNotification(typeof payload.title');
    // Two calls: the helper's own attempt and its minimal fallback. Formatting may split the receiver
    // and the method across lines, so only the method call itself is counted.
    expect(serviceWorker.match(/\.showNotification\(/g)?.length ?? 0).toBe(2);
    expect(serviceWorker).toMatch(
      /catch\(function fallback\(\) \{\s*\n\s*return self\.registration\.showNotification\(title, \{\s*\n\s*body: options\.body,\s*\n\s*tag: options\.tag,\s*\n\s*data: options\.data,/u,
    );
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

describe('installable web app artwork', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
  ) as {
    readonly display?: string;
    readonly start_url?: string;
    readonly scope?: string;
    readonly icons?: readonly {
      readonly src: string;
      readonly sizes: string;
      readonly type: string;
    }[];
  };
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('declares a standalone manifest, because iOS only offers Web Push to a Home Screen app', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons?.length ?? 0).toBeGreaterThan(0);
  });

  it('ships every manifest icon at the size the manifest promises', async () => {
    for (const icon of manifest.icons ?? []) {
      expect(icon.src.startsWith('/')).toBe(true);
      expect(icon.type).toBe('image/png');
      const [width, height] = icon.sizes.split('x').map(Number);
      const metadata = await sharp(assetPath(icon.src.slice(1))).metadata();
      expect([metadata.width, metadata.height]).toEqual([width, height]);
    }
  });

  it('links the manifest and an opaque 180px touch icon from the document head', () => {
    expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(indexHtml).toContain(
      'rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"',
    );
    expect(indexHtml).toContain('name="apple-mobile-web-app-capable" content="yes"');
  });

  it('keeps the iOS touch icon opaque, because iOS composites it over the Home Screen', async () => {
    const icon = await readBitmap('apple-touch-icon.png');
    expect([icon.width, icon.height]).toEqual([180, 180]);
    const translucent = countPixels(icon, (rgba) => rgba[3] !== 255);
    expect(translucent).toBe(0);
    // The same brand gradient as the notification avatar, so the installed app matches the brand.
    expect(pixel(icon, 0, 0).slice(0, 3)).toEqual([177, 125, 232]);
    expect(pixel(icon, icon.width - 1, icon.height - 1).slice(0, 3)).toEqual([153, 131, 251]);
  });
});

function countPixels(bitmap: Bitmap, predicate: (rgba: number[]) => boolean): number {
  let count = 0;
  for (let offset = 0; offset < bitmap.data.length; offset += 4) {
    if (predicate([...bitmap.data.subarray(offset, offset + 4)])) count += 1;
  }
  return count;
}
