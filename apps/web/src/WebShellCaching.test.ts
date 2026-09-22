import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

/** The shipped config has only flat server/location blocks, so a non-nested match is exact. */
function locationBody(match: string): string {
  const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = config.match(new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`));
  expect(found, `location ${match} must exist`).not.toBeNull();
  return found?.[1] ?? '';
}

describe('web shell caching policy', () => {
  it('revalidates the SPA shell instead of pinning a heuristic cache lifetime', () => {
    const root = locationBody('/');

    expect(root).toMatch(/add_header\s+Cache-Control\s+"no-cache"\s*;/);
    expect(root).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/);
    expect(root).not.toMatch(/max-age=\d{4,}/);
  });

  it('caches only the fingerprinted build artifacts as immutable', () => {
    const assets = locationBody('/assets/');

    expect(assets).toMatch(
      /add_header\s+Cache-Control\s+"public,\s*max-age=31536000,\s*immutable"\s*;/,
    );
    expect(assets).toMatch(/try_files\s+\$uri\s+=404\s*;/);
  });

  it('keeps the manifest and the service worker on no-cache', () => {
    expect(locationBody('= /manifest.webmanifest')).toMatch(
      /add_header\s+Cache-Control\s+"no-cache"\s*;/,
    );
    expect(locationBody('= /phub-notification-sw.js')).toMatch(
      /add_header\s+Cache-Control\s+"no-cache"\s*;/,
    );
  });
});
