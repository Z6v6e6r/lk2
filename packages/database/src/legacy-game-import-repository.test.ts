import { describe, expect, it, vi } from 'vitest';

import {
  createLegacyGameImportRepository,
  type LegacyGameImportSnapshot,
} from './legacy-game-import-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';

const snapshot: LegacyGameImportSnapshot = {
  externalId: 'legacy-game-secret-id',
  externalVersion: 'a'.repeat(64),
  vivaExerciseExternalId: '11111111-1111-4111-8111-111111111111',
  title: 'Рейтинговая игра',
  kind: 'RATING',
  visibility: 'PUBLIC',
  cancelled: false,
  startsAt: '2026-07-20T15:00:00.000Z',
  endsAt: '2026-07-20T16:30:00.000Z',
  timezone: 'Europe/Moscow',
  station: {
    externalId: 'legacy-station-secret-id',
    name: 'Терехово',
    courtExternalId: 'legacy-court-secret-id',
    courtName: 'Корт №4',
  },
  capacity: 4,
  waitlistEnabled: true,
  paymentMode: 'ORGANIZER_PAYS',
  levelFrom: 'C',
  levelTo: 'B',
  organizerExternalId: 'legacy-player-organizer',
  participants: [
    {
      externalId: 'legacy-player-organizer',
      displayName: 'Анна',
      level: 'C+',
      role: 'ORGANIZER',
      paymentState: 'PAID',
    },
    {
      externalId: 'legacy-player-two',
      displayName: 'Борис',
      level: 'B',
      role: 'PLAYER',
      paymentState: 'PAID',
    },
  ],
};

function fakePool(
  handler: (text: string, values: readonly unknown[]) => { rows?: readonly unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) =>
    Promise.resolve({ rows: handler(text, values).rows ?? [], rowCount: 0 }),
  );
  const clientQuery = vi.fn((text: string, values: readonly unknown[] = []) =>
    Promise.resolve({
      rows: handler(text, values).rows ?? [],
      rowCount: handler(text, values).rows?.length ?? 0,
    }),
  );
  const release = vi.fn();
  const pool = {
    query,
    connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
  };
  return { pool: pool as never, query, clientQuery, release };
}

describe('legacy game import repository', () => {
  it('creates a local aggregate, PadlHub mappings, audit and outbox in one transaction', async () => {
    const { pool, clientQuery } = fakePool((text) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-import-test-1',
      now: new Date('2026-07-18T10:00:00.000Z'),
    });

    expect(result).toMatchObject({ tenantId, skipped: 0 });
    expect(result.imported).toHaveLength(1);
    expect(clientQuery).toHaveBeenCalledWith('begin');
    expect(clientQuery).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into identity.users')),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into locations.profiles')),
    ).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(
      true,
    );
    expect(
      clientQuery.mock.calls.filter(([text]) => text.includes('insert into games.participations')),
    ).toHaveLength(2);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into audit.audit_log')),
    ).toBe(true);
    const vivaAssociation = clientQuery.mock.calls.find(
      ([text, values]) =>
        text.includes('external_system, entity_type, internal_id, external_id') &&
        values?.[1] === 'VIVA' &&
        values?.[3] === snapshot.vivaExerciseExternalId,
    );
    expect(vivaAssociation).toBeDefined();
    expect(clientQuery).toHaveBeenCalledWith('commit');

    const outbox = clientQuery.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.scheduled.v1');
    expect(JSON.stringify(outbox?.[1])).not.toContain(snapshot.externalId);
    expect(JSON.stringify(outbox?.[1])).not.toContain(snapshot.station.externalId);
    expect(JSON.stringify(outbox?.[1])).not.toContain(snapshot.organizerExternalId);
  });

  it('skips an already mapped game without overwriting local roster changes', async () => {
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: '6418f90b-0fa6-4c04-a3da-57707e2f0ae2' }] };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-import-test-2',
    });
    expect(result.imported).toEqual([]);
    expect(result.existing).toHaveLength(1);
    expect(result.existing[0]?.gameId).toBe('6418f90b-0fa6-4c04-a3da-57707e2f0ae2');
    expect(result.skipped).toBe(1);
    expect(clientQuery.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(
      false,
    );
    expect(
      clientQuery.mock.calls.some(
        ([text, values]) => text.includes("entity_type = 'exercise'") && values?.[1] === 'VIVA',
      ),
    ).toBe(true);
  });

  it('rejects an exercise association that already belongs to another PadlHub game', async () => {
    const { pool } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: '6418f90b-0fa6-4c04-a3da-57707e2f0ae2' }] };
      }
      if (text.includes("entity_type = 'exercise'")) {
        return { rows: [{ internal_id: 'a6ab4e3c-a9e0-459a-9d94-1e221d6fcbca' }] };
      }
      return { rows: [] };
    });

    await expect(
      createLegacyGameImportRepository(pool).importSnapshots({
        tenantKey: 'local-padel',
        snapshots: [snapshot],
        correlationId: 'legacy-import-test-3',
      }),
    ).rejects.toThrow('VIVA_EXERCISE_GAME_ASSOCIATION_CONFLICT');
  });

  it('mirrors a changed scheduled roster, increments the aggregate revision and emits a projection fact', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const organizerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const playerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea12';
    const existingVersion = 'b'.repeat(64);
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes("entity_type = 'game' and external_id") && text.includes('for update')) {
        return { rows: [{ internal_id: gameId, external_version: existingVersion }] };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              id: gameId,
              revision: '1',
              organizer_user_id: organizerUserId,
              lifecycle_state: 'SCHEDULED',
            },
          ],
        };
      }
      if (text.includes('from games.participations p')) {
        return {
          rows: [
            {
              id: 'f68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11',
              user_id: organizerUserId,
              role: 'ORGANIZER',
              payment_state: 'PAID',
              external_id: 'legacy-player-organizer',
            },
          ],
        };
      }
      if (text.includes('from integration.legacy_game_roster_sync_state')) {
        return {
          rows: [
            {
              source_external_version: existingVersion,
              last_synced_game_revision: '1',
              mode: 'MIRROR',
            },
          ],
        };
      }
      if (text.includes('from integration.external_entity_map') && values[2] === 'game_player') {
        return {
          rows: [
            {
              internal_id: values[3] === 'legacy-player-organizer' ? organizerUserId : playerUserId,
            },
          ],
        };
      }
      if (text.includes('update games.games') && text.includes('returning revision')) {
        return { rows: [{ revision: '2' }] };
      }
      return { rows: [] };
    });
    const changedSnapshot = { ...snapshot, externalVersion: 'c'.repeat(64) };

    const result = await createLegacyGameImportRepository(pool).synchronizeParticipants({
      tenantKey: 'local-padel',
      snapshots: [changedSnapshot],
      correlationId: 'legacy-sync-test-1',
      now: new Date('2026-07-19T10:00:00.000Z'),
    });

    expect(result).toMatchObject({ tenantId, synced: [{ gameId }] });
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(true);
    const outbox = clientQuery.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.scheduled.v1');
    expect(JSON.stringify(outbox?.[1])).not.toContain(changedSnapshot.externalId);
  });

  it('quarantines a roster when a local aggregate revision has moved since the last mirror', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const { pool, clientQuery } = fakePool((text) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes("entity_type = 'game' and external_id") && text.includes('for update')) {
        return { rows: [{ internal_id: gameId, external_version: snapshot.externalVersion }] };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              id: gameId,
              revision: '3',
              organizer_user_id: 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11',
              lifecycle_state: 'SCHEDULED',
            },
          ],
        };
      }
      if (text.includes('from games.participations p')) return { rows: [] };
      if (text.includes('from integration.legacy_game_roster_sync_state')) {
        return {
          rows: [
            {
              source_external_version: snapshot.externalVersion,
              last_synced_game_revision: '2',
              mode: 'MIRROR',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).synchronizeParticipants({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-sync-test-2',
    });

    expect(result.conflicts).toBe(1);
    expect(
      clientQuery.mock.calls.some(([, values]) =>
        values?.includes('LEGACY_GAME_ROSTER_LOCAL_REVISION_CHANGED'),
      ),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
  });
});
