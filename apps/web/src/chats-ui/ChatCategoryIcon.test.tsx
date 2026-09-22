// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatCategoryIcon, type ChatCategoryIconName } from './ChatCategoryIcon.js';

afterEach(cleanup);

/**
 * Geometry digests of the seven header category icons handed over as LK1/LK2 SVG.
 * The same path data ships in `lk-header-icons/svg/*.svg`; provenance is recorded there.
 */
const categoryDigests: ReadonlyArray<readonly [ChatCategoryIconName, string]> = [
  ['ALL', '9038e24391d4d5b9'],
  ['DIRECT', 'f5866364f67732f0'],
  ['GAME', 'fa3e451ed2279af3'],
  ['TOURNAMENT', '7617e4e8aea481e6'],
  ['STATION', '009fd664e16e6ba2'],
  ['COMMUNITY', 'd4a8eb36d4065232'],
  ['NOTIFICATIONS', '08a37198ae5a0a05'],
];

const serviceIcons: ReadonlyArray<ChatCategoryIconName> = [
  'BELL_OFF',
  'UNREAD',
  'SETTINGS',
  'SEND',
  'REFRESH',
];

function geometryDigest(container: HTMLElement): string {
  const paths = [...container.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '');
  return createHash('sha256').update(paths.sort().join('\n')).digest('hex').slice(0, 16);
}

describe('ChatCategoryIcon', () => {
  it('renders the handed-over LK1/LK2 geometry for every header category', () => {
    for (const [name, digest] of categoryDigests) {
      const { container } = render(<ChatCategoryIcon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(geometryDigest(container)).toBe(digest);
      cleanup();
    }
  });

  it('keeps the five service icons distinct from the category set', () => {
    const digests = serviceIcons.map((name) => {
      const { container } = render(<ChatCategoryIcon name={name} />);
      const digest = geometryDigest(container);
      cleanup();
      return digest;
    });
    expect(new Set(digests).size).toBe(serviceIcons.length);
    for (const digest of digests) {
      expect(categoryDigests.map(([, value]) => value)).not.toContain(digest);
    }
  });
});
