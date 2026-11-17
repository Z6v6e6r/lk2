import { describe, expect, it } from 'vitest';

import {
  buildLocalHomeProfile,
  freshProviderObservation,
  localProfileLevel,
} from './local-home-profile.js';

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
describe('local home profile provider observation merge', () => {
  const observedAt = '2026-11-09T06:00:00.000Z';
  const observation = {
    level: { label: 'C+', value: 3.8 },
    balanceMinor: 54_000,
    currency: 'RUB' as const,
    observedAt,
  };

  it('adds the provider level and balance to the local slice', () => {
    const profile = buildLocalHomeProfile({
      userId,
      displayName: 'Сергеев Алексей',
      observation,
    });

    expect(profile).toEqual({
      userId,
      displayName: 'Сергеев Алексей',
      firstName: 'Сергеев',
      lastName: 'Алексей',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
      balanceMinor: 54_000,
      currency: 'RUB',
    });
  });

  it('prefers the fresh provider level over the cached summary level', () => {
    const profile = buildLocalHomeProfile({
      userId,
      displayName: 'Сергеев Алексей',
      levelLabel: 'D',
      levelValue: 0.5,
      observation,
    });

    expect(profile.level).toEqual({ label: 'C+', value: 3.8, assessmentRequired: false });
  });

  it('keeps the cached level when the observation carries none', () => {
    const profile = buildLocalHomeProfile({
      userId,
      displayName: 'Сергеев Алексей',
      levelLabel: 'B',
      observation: { balanceMinor: 12_500, currency: 'RUB', observedAt },
    });

    expect(profile.level).toEqual({ label: 'B', value: 4.5, assessmentRequired: false });
    expect(profile.balanceMinor).toBe(12_500);
    expect(profile.currency).toBe('RUB');
  });

  it('omits provider fields the observation does not carry', () => {
    const profile = buildLocalHomeProfile({
      userId,
      displayName: 'Сергеев Алексей',
      observation: { currency: 'RUB', observedAt },
    });

    expect(profile).not.toHaveProperty('balanceMinor');
    expect(profile).not.toHaveProperty('currency');
    expect(profile).not.toHaveProperty('level');
  });

  it('accepts an observation only inside the freshness window', () => {
    const now = Date.parse(observedAt) + 900_000;
    expect(freshProviderObservation(observation, 900, now)).toBe(observation);
    expect(freshProviderObservation(observation, 900, now + 1)).toBeUndefined();
    // A peer instance whose clock is slightly ahead still publishes its observation.
    expect(freshProviderObservation(observation, 900, Date.parse(observedAt) - 30_000)).toBe(
      observation,
    );
    expect(
      freshProviderObservation(observation, 900, Date.parse(observedAt) - 61_000),
    ).toBeUndefined();
    expect(freshProviderObservation(undefined, 900, now)).toBeUndefined();
    expect(
      freshProviderObservation({ ...observation, observedAt: 'not-a-date' }, 900, now),
    ).toBeUndefined();
  });

  it('keeps the local slice unchanged without a fresh observation', () => {
    const stale = freshProviderObservation(observation, 0, Date.parse(observedAt) + 1);
    expect(stale).toBeUndefined();
    const profile = buildLocalHomeProfile({
      userId,
      displayName: 'Сергеев Алексей',
      levelLabel: 'C',
      ...(stale ? { observation: stale } : {}),
    });

    expect(profile.level).toEqual({ label: 'C', value: 3, assessmentRequired: false });
    expect(profile).not.toHaveProperty('balanceMinor');
  });
});
