import sharp from 'sharp';
import { expect, it } from 'vitest';

// GHSA-wq5f-xc86-pv6w: test the loaded native closure, beyond the npm package label.
it('loads patched libvips and librsvg for image decoding', () => {
  for (const [library, minimum] of [
    ['vips', '8.18.7'],
    ['rsvg', '2.63.2'],
  ] as const) {
    const actual = sharp.versions[library];
    if (typeof actual !== 'string') throw new Error(`${library} decoder version is unavailable`);
    expect(actual).toMatch(/^\d+\.\d+\.\d+$/);
    const current = actual.split('.').map(Number);
    const floor = minimum.split('.').map(Number);
    const difference = current
      .map((value, index) => value - floor[index])
      .find((value) => value !== 0);
    expect(
      difference ?? 0,
      `${library} must include the patched native decoder`,
    ).toBeGreaterThanOrEqual(0);
  }
});
