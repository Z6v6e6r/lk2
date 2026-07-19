import { describe, expect, it, vi } from 'vitest';

import { createBookingPreferencesRepository } from './booking-preferences-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const stationId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';
const updatedAt = new Date('2026-07-18T10:00:00.000Z');

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

function transactionQuery(handler: (text: string, values: readonly unknown[]) => unknown) {
  return vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve(handler(text, values));
  });
}

describe('booking preferences repository', () => {
  it('returns history-enabled defaults without creating a row', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from profile.booking_preferences')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingPreferencesRepository(poolWithQuery(query) as never);

    await expect(repository.get(tenantId, userId)).resolves.toEqual({
      favoriteStationIds: [],
      preferredTimeWindows: [],
      useHistory: true,
      version: 0,
      updatedAt: null,
    });
  });

  it('writes preferences, audit and outbox atomically', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from profile.booking_preference_commands')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('from profile.booking_preferences')) return { rows: [], rowCount: 0 };
      if (text.includes('insert into profile.booking_preferences')) {
        return {
          rows: [
            {
              favorite_station_ids: [stationId],
              preferred_time_windows: [{ weekday: 'MON', startsAt: '18:00', endsAt: '21:00' }],
              use_history: false,
              version: 1,
              updated_at: updatedAt,
            },
          ],
          rowCount: 1,
        };
      }
      if (
        text.includes('insert into profile.booking_preference_commands') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('insert into audit.outbox_events')
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingPreferencesRepository(poolWithQuery(query) as never);

    await expect(
      repository.update({
        tenantId,
        userId,
        actorUserId: userId,
        idempotencyKey: 'booking-preferences-test-0001',
        requestHash: 'a'.repeat(64),
        correlationId: 'booking-preferences-correlation-0001',
        expectedVersion: 0,
        favoriteStationIds: [stationId],
        preferredTimeWindows: [{ weekday: 'MON', startsAt: '18:00', endsAt: '21:00' }],
        useHistory: false,
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      settings: {
        favoriteStationIds: [stationId],
        preferredTimeWindows: [{ weekday: 'MON', startsAt: '18:00', endsAt: '21:00' }],
        useHistory: false,
        version: 1,
        updatedAt: updatedAt.toISOString(),
      },
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
  });

  it('loads preferences and player level as one recommendation profile query', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from identity.users u')) {
        return {
          rows: [
            {
              favorite_station_ids: [stationId],
              preferred_time_windows: [],
              use_history: true,
              version: 3,
              updated_at: updatedAt,
              level_label: 'C+',
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createBookingPreferencesRepository(poolWithQuery(query) as never);

    await expect(repository.getRecommendationProfile(tenantId, userId)).resolves.toEqual({
      preferences: {
        favoriteStationIds: [stationId],
        preferredTimeWindows: [],
        useHistory: true,
        version: 3,
        updatedAt: updatedAt.toISOString(),
      },
      playerLevel: 'C+',
    });
  });
});
