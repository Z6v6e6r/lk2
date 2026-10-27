import { describe, expect, it, vi } from 'vitest';

import {
  beginLegacyGameReminderSourceCycle,
  completeLegacyGameReminderSourceCycle,
} from './legacy-game-reminder-source-repository.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const gameId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const generationId = '44444444-4444-4444-8444-444444444444';

function result(rows: readonly Record<string, unknown>[] = []) {
  return { rows, rowCount: rows.length };
}

function poolFor(queryImpl: (sql: string, values?: readonly unknown[]) => unknown) {
  const calls: string[] = [];
  const callValues: (readonly unknown[] | undefined)[] = [];
  const query = vi.fn((sql: string, values?: readonly unknown[]) => {
    calls.push(sql);
    callValues.push(values);
    return Promise.resolve(queryImpl(sql, values));
  });
  const client = { query, release: vi.fn() };
  return {
    pool: {
      query: vi.fn(() => Promise.resolve(result([{ id: tenantId }]))),
      connect: vi.fn(() => Promise.resolve(client)),
    } as never,
    calls,
    callValues,
    client,
  };
}

describe('isolated legacy game reminder source repository', () => {
  it('commits the unhealthy generation before listing tracked targets', async () => {
    const fixture = poolFor((sql) => {
      if (sql.includes('array_agg')) return result([]);
      return result();
    });
    await beginLegacyGameReminderSourceCycle(fixture.pool, {
      tenantKey: 'synthetic',
      generationId,
      now: new Date('2026-11-01T12:00:00Z'),
      trackedLimit: 20,
    });
    const statusWrite = fixture.calls.findIndex((sql) => sql.includes('source_status('));
    const firstCommit = fixture.calls.findIndex((sql) => sql === 'commit');
    const trackedRead = fixture.calls.findIndex((sql) => sql.includes('array_agg'));
    expect(statusWrite).toBeGreaterThan(-1);
    expect(firstCommit).toBeGreaterThan(statusWrite);
    expect(trackedRead).toBeGreaterThan(firstCommit);
    expect(fixture.calls[trackedRead]).toContain("source.source_state='SCHEDULED'");
    expect(fixture.calls[trackedRead]).toContain("mirror.mode='MIRROR'");
  });

  it('writes only notification-owned mirror state for a mapped verified participant', async () => {
    const fixture = poolFor((sql) => {
      if (sql.includes('generation_id=$2 and healthy=false')) return result([{ one: 1 }]);
      if (sql.includes('set healthy=true')) return result([{ finalized: true }]);
      if (sql.includes('select distinct mapping.internal_id game_id'))
        return result([{ game_id: gameId }]);
      if (sql.includes('select distinct binding.user_id')) return result([{ user_id: userId }]);
      if (sql.includes('select source_revision,source_external_version')) return result([]);
      return result();
    });
    const beforeFinalize = vi.fn().mockResolvedValue(undefined);
    const completed = await completeLegacyGameReminderSourceCycle(fixture.pool, {
      admission: { tenantId, generationId, tracked: [] },
      snapshots: [
        {
          externalId: 'a'.repeat(64),
          externalAliases: ['source-game'],
          externalVersion: 'b'.repeat(64),
          sourceUpdatedAt: '2026-11-01T11:59:00.000Z',
          vivaExerciseExternalId: null,
          title: 'Private legacy game',
          kind: 'FRIENDLY',
          visibility: 'PRIVATE',
          cancelled: false,
          startsAt: '2026-11-01T18:00:00.000Z',
          endsAt: '2026-11-01T19:00:00.000Z',
          timezone: 'Europe/Moscow',
          station: {
            externalId: 'c'.repeat(64),
            name: 'Club',
            courtExternalId: null,
            courtName: null,
          },
          capacity: 4,
          waitlistEnabled: true,
          paymentMode: 'ORGANIZER_PAYS',
          levelFrom: null,
          levelTo: null,
          organizerExternalId: 'd'.repeat(64),
          participants: [
            {
              externalId: 'd'.repeat(64),
              externalAliases: ['source-player'],
              displayName: 'Player',
              level: null,
              levelValue: null,
              role: 'ORGANIZER',
              paymentState: 'PAID',
              avatarSourceUrl: null,
            },
          ],
        },
      ],
      now: new Date('2026-11-01T12:00:00Z'),
      windowTo: new Date('2026-11-08T12:00:00Z'),
      beforeFinalize,
    });
    expect(completed).toMatchObject({
      changedGameIds: [gameId],
      refreshGameIds: [gameId],
      skippedUnmapped: 0,
    });
    const mutations = fixture.calls.filter((sql) => /^\s*(insert|update|delete)/i.test(sql));
    expect(mutations.join('\n')).not.toMatch(
      /(?:insert into|update|delete from)\s+(?:games|identity|profile|audit)\./i,
    );
    expect(mutations.join('\n')).toContain('notifications.legacy_game_reminder_sources');
    expect(mutations.join('\n')).toContain('notifications.legacy_game_reminder_recipients');
    expect(beforeFinalize).toHaveBeenCalledWith(
      fixture.client,
      expect.objectContaining({ refreshGameIds: [gameId] }),
    );
    const adminLock = fixture.callValues.findIndex((values) =>
      String(values?.[0]).startsWith('scenario-admin:'),
    );
    const sourceLock = fixture.callValues.findIndex((values) =>
      String(values?.[0]).startsWith('legacy-game-reminder-source:'),
    );
    const statusLock = fixture.calls.findIndex((sql) => sql.includes('healthy=false for update'));
    const finalize = fixture.calls.findIndex((sql) => sql.includes('set healthy=true'));
    expect(adminLock).toBeGreaterThan(-1);
    expect(sourceLock).toBeGreaterThan(adminLock);
    expect(statusLock).toBeGreaterThan(sourceLock);
    expect(finalize).toBeGreaterThan(statusLock);
  });

  it('rolls back without publishing healthy when context refresh fails', async () => {
    const fixture = poolFor((sql) => {
      if (sql.includes('generation_id=$2 and healthy=false')) return result([{ one: 1 }]);
      return result();
    });
    await expect(
      completeLegacyGameReminderSourceCycle(fixture.pool, {
        admission: { tenantId, generationId, tracked: [] },
        snapshots: [],
        now: new Date('2026-11-01T12:00:00Z'),
        windowTo: new Date('2026-11-08T12:00:00Z'),
        beforeFinalize: vi.fn().mockRejectedValue(new Error('CONTEXT_REFRESH_FAILED')),
      }),
    ).rejects.toThrow('CONTEXT_REFRESH_FAILED');
    expect(fixture.calls.some((sql) => sql.includes('set healthy=true'))).toBe(false);
    expect(fixture.calls).toContain('rollback');
  });

  it('does not refresh or finalize a generation superseded before completion', async () => {
    const fixture = poolFor(() => result());
    const beforeFinalize = vi.fn();
    await expect(
      completeLegacyGameReminderSourceCycle(fixture.pool, {
        admission: { tenantId, generationId, tracked: [] },
        snapshots: [],
        now: new Date('2026-11-01T12:00:00Z'),
        windowTo: new Date('2026-11-08T12:00:00Z'),
        beforeFinalize,
      }),
    ).rejects.toThrow('LEGACY_GAME_REMINDER_GENERATION_STALE');
    expect(beforeFinalize).not.toHaveBeenCalled();
    expect(fixture.calls.some((sql) => sql.includes('set healthy=true'))).toBe(false);
  });
});
