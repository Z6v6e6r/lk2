import { describe, expect, it } from 'vitest';

import {
  normalizePadlHubUpcomingBookings,
  normalizePadlHubUserProfile,
  normalizeVivaUserProfile,
} from './index.js';

const padlHubUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const vivaProfileId = '7aa93a46-9fa8-42b2-9894-490874fe53f7';

describe('profile normalization', () => {
  it('drops the Viva identifier and emits the canonical PadlHub profile DTO', () => {
    const result = normalizeVivaUserProfile(
      {
        id: vivaProfileId,
        firstName: ' Алексей ',
        middleName: 'Иванович',
        lastName: 'Петров',
        phone: '+7 (999) 123-31-90',
        deposit: 245_000,
        customFields: [
          {
            id: 'eabfe27b-3f72-4496-9185-1a2ec6e6465e',
            value: ['3,8'],
          },
        ],
      },
      padlHubUserId,
    );

    expect(result).toEqual({
      userId: padlHubUserId,
      displayName: 'Алексей Иванович Петров',
      firstName: 'Алексей',
      phoneLast4: '3190',
      balanceMinor: 245_000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
    });
    expect(JSON.stringify(result)).not.toContain(vivaProfileId);
  });

  it('uses an explicit unassessed level when Viva has no supported rating field', () => {
    expect(
      normalizeVivaUserProfile(
        {
          id: vivaProfileId,
          firstName: null,
          middleName: null,
          lastName: null,
          phone: null,
          deposit: -1500,
          customFields: [],
        },
        padlHubUserId,
      ),
    ).toMatchObject({
      userId: padlHubUserId,
      displayName: 'Игрок ПадлХАБ',
      balanceMinor: -1500,
      level: { label: 'D', value: 0, assessmentRequired: true },
    });
  });

  it('rejects a malformed PadlHub fallback response', () => {
    expect(() => normalizePadlHubUserProfile({ userId: vivaProfileId })).toThrow();
  });

  it('accepts bookings only when every item has a PadlHub UUID', () => {
    const payload = {
      version: 'home-17',
      generatedAt: '2026-07-15T18:00:00.000Z',
      staleAt: '2026-07-15T18:05:00.000Z',
      items: [
        {
          id: 'e45a6c36-58f3-467a-9ac2-54e36143ccea',
          kind: 'training',
          title: 'Групповая тренировка',
          startsAt: '2026-07-16T10:00:00.000Z',
          venue: 'ПаделХАБ',
          status: 'confirmed',
          route: '/bookings/e45a6c36-58f3-467a-9ac2-54e36143ccea',
        },
      ],
    };

    expect(normalizePadlHubUpcomingBookings(payload)).toEqual(payload);
    expect(() =>
      normalizePadlHubUpcomingBookings({
        ...payload,
        items: [{ ...payload.items[0], id: 'viva-booking-42' }],
      }),
    ).toThrow();
  });
});
