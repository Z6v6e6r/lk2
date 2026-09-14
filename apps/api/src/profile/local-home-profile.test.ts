import { describe, expect, it } from 'vitest';

import { buildLocalHomeProfile, localProfileLevel } from './local-home-profile.js';

const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

describe('local home profile fallback', () => {
  it('publishes only the observable summary fields', () => {
    const profile = buildLocalHomeProfile({ userId, displayName: 'Сергеев Алексей' });

    expect(profile).toEqual({
      userId,
      displayName: 'Сергеев Алексей',
      firstName: 'Сергеев',
      lastName: 'Алексей',
    });
    expect(profile).not.toHaveProperty('balanceMinor');
    expect(profile).not.toHaveProperty('currency');
    expect(profile).not.toHaveProperty('level');
    expect(profile).not.toHaveProperty('phoneLast4');
  });

  it('omits a level that the stored summary does not carry', () => {
    expect(localProfileLevel(null, null)).toBeUndefined();
    expect(localProfileLevel('   ', null)).toBeUndefined();
    // An unknown label without a stored numeric value is not promoted to level D.
    expect(localProfileLevel('ZZ', null)).toBeUndefined();
    expect(
      buildLocalHomeProfile({ userId, displayName: 'Алексей', levelLabel: null }).level,
    ).toBeUndefined();
  });

  it('reports a level only from stored assessment data', () => {
    expect(localProfileLevel('C', null)).toEqual({
      label: 'C',
      value: 3,
      assessmentRequired: false,
    });
    expect(localProfileLevel('C+', 3.8)).toEqual({
      label: 'C+',
      value: 3.8,
      assessmentRequired: false,
    });
  });

  it('drops an avatar reference outside the published URL contract', () => {
    expect(
      buildLocalHomeProfile({ userId, displayName: 'Алексей', avatarUrl: 'javascript:alert(1)' }),
    ).not.toHaveProperty('avatarUrl');
    expect(
      buildLocalHomeProfile({
        userId,
        displayName: 'Алексей',
        avatarUrl: 'https://media.padlhub.test/profiles/aleksey.webp',
      }).avatarUrl,
    ).toBe('https://media.padlhub.test/profiles/aleksey.webp');
  });
});
