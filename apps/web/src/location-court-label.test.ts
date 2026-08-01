import { describe, expect, it } from 'vitest';

import { locationCourtLabel } from './location-court-label.js';

describe('locationCourtLabel', () => {
  it.each([
    [1, 'корт'],
    [2, 'корта'],
    [3, 'корта'],
    [4, 'корта'],
    [5, 'кортов'],
    [11, 'кортов'],
    [21, 'корт'],
  ])('uses the right form for %s', (count, expected) => {
    expect(locationCourtLabel(count)).toBe(expected);
  });
});
