import { describe, expect, it, vi } from 'vitest';

import { createActivityHistoryRepository } from './activity-history-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const itemId = '55555555-5555-4555-8555-555555555555';
const mappingId = '77777777-7777-4777-8777-777777777777';
const startsAt = '2026-07-15T10:00:00.000Z';
const endsAt = '2026-07-15T11:00:00.000Z';
const syncedAt = '2026-07-15T12:00:00.000Z';
const staleAt = '2026-07-15T12:05:00.000Z';

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: itemId,
    user_id: userId,
    kind: 'TRAINING',
    status: 'COMPLETED',
    occurred_at: new Date(endsAt),
    starts_at: new Date(startsAt),
    ends_at: new Date(endsAt),
    title: 'Групповая тренировка',
    venue_name: 'Центральная станция',
    route: `/bookings/${itemId}`,
    game_id: null,
    tournament_id: null,
    details: { coachName: 'Анна' },
    source_revision: 'viva-history-42',
    synced_at: new Date(syncedAt),
    ...overrides,
  };
}

function syncRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    coverage_status: 'COMPLETE',
    last_success_at: new Date(syncedAt),
    stale_at: new Date(staleAt),
    oldest_synced_at: new Date(startsAt),
    next_provider_cursor: null,
    source_revision: 'viva-history-42',
    last_error_code: null,
    updated_at: new Date(syncedAt),
    ...overrides,
  };
}

function repositoryWithQueries(
  handler: (text: string, values: readonly unknown[]) => { rows: unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
    return Promise.resolve(handler(text, values));
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
  return { repository: createActivityHistoryRepository(pool as never), query };
}

describe('Activity history repository', () => {
  it('resolves only tenant-scoped opaque Viva exercise associations to canonical games', async () => {
    const associationId = 'opaque-exercise-association';
    const gameId = '33333333-3333-4333-8333-333333333333';
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes("mapping.entity_type = 'exercise'")) {
        return { rows: [{ external_id: associationId, internal_id: gameId }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.resolveVivaExerciseGameAssociations({
        tenantId,
        associationIds: [associationId, associationId],
      }),
    ).resolves.toEqual([{ associationId, gameId }]);

    const associationCall = query.mock.calls.find(([text]) =>
      String(text).includes("mapping.entity_type = 'exercise'"),
    );
    expect(associationCall?.[1]).toEqual([tenantId, [associationId]]);
    expect(String(associationCall?.[0])).toContain('join games.games game');
  });

  it('resolves a Viva booking reference only inside the integration mapping', async () => {
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('insert into integration.external_entity_map')) {
        return { rows: [{ id: mappingId, internal_id: itemId }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.resolveSourceMapping({
        tenantId,
        externalSystem: 'VIVA',
        entityType: 'booking_history',
        externalId: 'private-viva-booking-reference',
        externalVersion: 'revision-42',
        syncedAt,
      }),
    ).resolves.toEqual({ mappingId, internalId: itemId });

    const mappingCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into integration.external_entity_map'),
    );
    expect(String(mappingCall?.[0])).toContain(
      'on conflict (tenant_id, external_system, entity_type, external_id)',
    );
    expect(mappingCall?.[1]).toEqual([
      tenantId,
      'VIVA',
      'booking_history',
      'private-viva-booking-reference',
      'revision-42',
      syncedAt,
    ]);
    expect(String(mappingCall?.[0])).not.toContain('booking.activity_history_projection');
  });

  it('lists one tenant-scoped filtered page with a stable descending cursor', async () => {
    const secondId = '66666666-6666-4666-8666-666666666666';
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('from booking.activity_history_projection')) {
        return { rows: [historyRow(), historyRow({ id: secondId })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.list({
        tenantId,
        userId,
        kind: 'TRAINING',
        status: 'COMPLETED',
        limit: 1,
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: itemId, userId, kind: 'TRAINING' })],
      next: { occurredAt: endsAt, id: itemId },
    });

    const listCall = query.mock.calls.find(([text]) =>
      String(text).includes('from booking.activity_history_projection'),
    );
    expect(listCall?.[1]).toEqual([tenantId, userId, 'TRAINING', 'COMPLETED', null, null, 2]);
    expect(String(listCall?.[0])).toContain('(occurred_at, id) <');
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
  });

  it('distinguishes unsynced, fresh, stale and partial coverage', async () => {
    const rows = [
      undefined,
      syncRow(),
      syncRow(),
      syncRow({
        coverage_status: 'PARTIAL',
        next_provider_cursor: 'opaque-next-page',
      }),
    ];
    const { repository } = repositoryWithQueries((text) => {
      if (text.includes('from integration.user_activity_history_sync_state')) {
        const row = rows.shift();
        return { rows: row ? [row] : [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.getSyncState({ tenantId, userId, asOf: syncedAt }),
    ).resolves.toMatchObject({ coverageStatus: 'UNSYNCED', freshness: 'UNSYNCED' });
    await expect(
      repository.getSyncState({ tenantId, userId, asOf: syncedAt }),
    ).resolves.toMatchObject({ coverageStatus: 'COMPLETE', freshness: 'FRESH' });
    await expect(
      repository.getSyncState({ tenantId, userId, asOf: '2026-07-15T13:00:00.000Z' }),
    ).resolves.toMatchObject({ coverageStatus: 'COMPLETE', freshness: 'STALE' });
    await expect(
      repository.getSyncState({ tenantId, userId, asOf: syncedAt }),
    ).resolves.toMatchObject({
      coverageStatus: 'PARTIAL',
      freshness: 'FRESH',
      nextProviderCursor: 'opaque-next-page',
    });
  });

  it('atomically persists an idempotent page and complete coverage', async () => {
    const supersededItemId = '88888888-8888-4888-8888-888888888888';
    const { repository, query } = repositoryWithQueries((text) => {
      if (text.includes('insert into booking.activity_history_projection')) return { rows: [] };
      if (text.includes('delete from booking.activity_history_projection')) return { rows: [] };
      if (text.includes('insert into integration.user_activity_history_sync_state')) {
        return { rows: [syncRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.persistPage({
        tenantId,
        userId,
        items: [
          {
            id: itemId,
            kind: 'TRAINING',
            status: 'COMPLETED',
            occurredAt: endsAt,
            startsAt,
            endsAt,
            title: 'Групповая тренировка',
            details: { coachName: 'Анна' },
            sourceRevision: 'viva-history-42',
            syncedAt,
          },
        ],
        supersededItemIds: [supersededItemId, itemId, supersededItemId],
        sync: {
          coverageStatus: 'COMPLETE',
          lastSuccessAt: syncedAt,
          staleAt,
          oldestSyncedAt: startsAt,
          sourceRevision: 'viva-history-42',
        },
      }),
    ).resolves.toMatchObject({ coverageStatus: 'COMPLETE', freshness: 'FRESH' });

    const itemCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into booking.activity_history_projection'),
    );
    expect(String(itemCall?.[0])).toContain('on conflict (tenant_id, user_id, id) do update');
    expect(String(itemCall?.[0])).toContain('excluded.synced_at >=');
    expect(itemCall?.[1]?.slice(0, 2)).toEqual([tenantId, userId]);
    const deleteCall = query.mock.calls.find(([text]) =>
      String(text).includes('delete from booking.activity_history_projection'),
    );
    expect(deleteCall?.[1]).toEqual([tenantId, userId, [supersededItemId]]);
  });

  it('preserves an unknown end time as null instead of inventing duration', async () => {
    const { repository } = repositoryWithQueries((text) => {
      if (text.includes('from booking.activity_history_projection')) {
        return { rows: [historyRow({ ends_at: null })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.list({ tenantId, userId, limit: 20 })).resolves.toMatchObject({
      items: [{ id: itemId, endsAt: null }],
    });
  });

  it('persists an empty complete page so an empty history is not treated as unsynced', async () => {
    const { repository, query } = repositoryWithQueries((text, values) => {
      if (text.includes('insert into integration.user_activity_history_sync_state')) {
        expect(values[5]).toBeNull();
        return { rows: [syncRow({ oldest_synced_at: null })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.persistPage({
        tenantId,
        userId,
        items: [],
        sync: {
          coverageStatus: 'COMPLETE',
          lastSuccessAt: syncedAt,
          staleAt,
          sourceRevision: 'viva-history-empty-1',
        },
      }),
    ).resolves.toMatchObject({
      coverageStatus: 'COMPLETE',
      freshness: 'FRESH',
      oldestSyncedAt: null,
    });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into booking.activity_history_projection'),
      ),
    ).toBe(false);
  });

  it('rejects provider identifiers hidden inside public projection details', async () => {
    const { repository, query } = repositoryWithQueries(() => ({ rows: [] }));

    await expect(
      repository.persistPage({
        tenantId,
        userId,
        items: [
          {
            id: itemId,
            kind: 'TOURNAMENT',
            status: 'COMPLETED',
            occurredAt: endsAt,
            startsAt,
            endsAt,
            title: 'Турнир',
            details: { result: { vivaExerciseId: 'must-not-leak' } },
            sourceRevision: '1',
            syncedAt,
          },
        ],
        sync: {
          coverageStatus: 'COMPLETE',
          lastSuccessAt: syncedAt,
          staleAt,
          sourceRevision: '1',
        },
      }),
    ).rejects.toThrow('ACTIVITY_HISTORY_EXTERNAL_IDENTIFIER_FORBIDDEN');
    expect(query).not.toHaveBeenCalled();
  });
});
