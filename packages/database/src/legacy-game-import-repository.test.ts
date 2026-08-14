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
      levelValue: 3.8,
      role: 'ORGANIZER',
      paymentState: 'PAID',
    },
    {
      externalId: 'legacy-player-two',
      displayName: 'Борис',
      level: 'B',
      levelValue: 4.2,
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
  it('resolves the authenticated user Viva profile only inside the integration boundary', async () => {
    const userId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const { pool, clientQuery } = fakePool((text) => {
      if (text.includes("entity_type = 'viva_profile'")) {
        return { rows: [{ external_id: 'private-viva-profile-id' }] };
      }
      return { rows: [] };
    });

    await expect(
      createLegacyGameImportRepository(pool).resolveVivaProfileExternalId({ tenantId, userId }),
    ).resolves.toBe('private-viva-profile-id');
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('integration.external_entity_map')),
    ).toBe(true);
  });

  it('resolves the viewer phone only for the server-side CUP history adapter', async () => {
    const userId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const { pool } = fakePool((text) => {
      if (text.includes('from profile.user_summaries')) {
        return { rows: [{ phone_e164: '+79990000001' }] };
      }
      return { rows: [] };
    });

    await expect(
      createLegacyGameImportRepository(pool).resolveViewerPhoneE164({ tenantId, userId }),
    ).resolves.toBe('+79990000001');
  });

  it('binds the proven viewer participant to the existing PadlHub user during import', async () => {
    const viewerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const { pool, clientQuery } = fakePool((text) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('select id from identity.users')) return { rows: [{ id: viewerUserId }] };
      return { rows: [] };
    });

    await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-viewer-binding-test',
      participantUserBindings: [{ externalId: snapshot.organizerExternalId, userId: viewerUserId }],
      now: new Date('2026-07-21T10:00:00.000Z'),
    });

    const createdUsers = clientQuery.mock.calls.filter(([text]) =>
      text.includes('insert into identity.users'),
    );
    expect(createdUsers).toHaveLength(1);
    const viewerMapping = clientQuery.mock.calls.find(
      ([text, values]) =>
        text.includes('insert into integration.external_entity_map') &&
        values?.[3] === viewerUserId &&
        values?.[4] === snapshot.organizerExternalId,
    );
    expect(viewerMapping).toBeDefined();
    expect(
      clientQuery.mock.calls.find(
        ([text, values]) =>
          text.includes('insert into integration.legacy_game_player_bindings') &&
          values?.[1] === snapshot.organizerExternalId &&
          values?.[2] === viewerUserId &&
          values?.[3] === 'VIVA_PROFILE',
      ),
    ).toBeDefined();
  });

  it('moves an existing imported participation to the proven PadlHub viewer', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const syntheticUserId = 'c68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea19';
    const viewerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const sourcePlayerAssociationId = 'f'.repeat(64);
    const participationId = 'd68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea18';
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: gameId }] };
      }
      if (text.includes('from integration.external_entity_map') && values[2] === 'game_player') {
        return { rows: [{ internal_id: syntheticUserId }] };
      }
      if (text.includes('select id from identity.users')) return { rows: [{ id: viewerUserId }] };
      if (text.includes('from games.participations') && values[2] === syntheticUserId) {
        return { rows: [{ id: participationId, role: 'ORGANIZER' }] };
      }
      if (text.includes('from games.participations') && values[2] === viewerUserId) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-existing-viewer-binding-test',
      participantUserBindings: [
        {
          externalId: snapshot.organizerExternalId,
          sourcePlayerAssociationId,
          userId: viewerUserId,
          proofKind: 'VIEWER_PHONE',
        },
      ],
      now: new Date('2026-07-21T10:00:00.000Z'),
    });

    expect(result.existing).toEqual([expect.objectContaining({ gameId })]);
    expect(
      clientQuery.mock.calls.find(
        ([text, values]) =>
          text.includes('insert into integration.legacy_game_player_bindings') &&
          values?.[1] === sourcePlayerAssociationId &&
          values?.[2] === viewerUserId &&
          values?.[3] === 'VIEWER_PHONE',
      ),
    ).toBeDefined();
    expect(
      clientQuery.mock.calls.find(
        ([text, values]) =>
          text.includes('set user_id = $4') &&
          values?.[2] === participationId &&
          values?.[3] === viewerUserId,
      ),
    ).toBeDefined();
    expect(
      clientQuery.mock.calls.find(([text]) => text.includes('set revision = revision + 1')),
    ).toBeDefined();
    const profileSummaryUpsert = clientQuery.mock.calls.find(([text]) =>
      text.includes('insert into profile.user_summaries'),
    );
    expect(profileSummaryUpsert?.[0]).toContain('display_name = excluded.display_name');
    const conflictUpdate = profileSummaryUpsert?.[0].split('do update set')[1] ?? '';
    expect(conflictUpdate).not.toMatch(/\blevel_(?:label|value)\s*=/);
  });

  it('refreshes real names for already mapped players without changing the existing roster', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const organizerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const playerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea12';
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: gameId }] };
      }
      if (text.includes('from integration.external_entity_map') && values[2] === 'game_player') {
        return {
          rows: [
            {
              internal_id:
                values[3] === snapshot.organizerExternalId ? organizerUserId : playerUserId,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-name-refresh-test',
      now: new Date('2026-07-19T10:00:00.000Z'),
    });

    expect(result.existing).toEqual([expect.objectContaining({ gameId })]);
    const nameRefreshes = clientQuery.mock.calls.filter(([text]) =>
      text.includes('update profile.user_summaries summary'),
    );
    expect(nameRefreshes).toHaveLength(2);
    expect(nameRefreshes.map(([, values]) => values?.[2])).toEqual(['Анна', 'Борис']);
    expect(nameRefreshes.every(([text]) => !/\blevel_(?:label|value)\s*=/.test(text))).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
  });

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
    expect(clientQuery).toHaveBeenCalledWith(
      "select set_config('app.profile_level_history_origin', $1, true)",
      ['LK_LEGACY_SNAPSHOT'],
    );
    const profileSummaryInserts = clientQuery.mock.calls.filter(([text]) =>
      text.includes('insert into profile.user_summaries'),
    );
    expect(profileSummaryInserts.map(([, values]) => values?.slice(3, 5))).toEqual([
      ['C+', 3.8],
      ['B', 4.2],
    ]);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into identity.users')),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) =>
        text.includes(
          'level_label = coalesce(excluded.level_label, profile.user_summaries.level_label)',
        ),
      ),
    ).toBe(false);
    expect(
      clientQuery.mock.calls.some(([text]) =>
        text.includes(
          'level_value = coalesce(excluded.level_value, profile.user_summaries.level_value)',
        ),
      ),
    ).toBe(false);
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
    const lifecycleCommands = clientQuery.mock.calls.find(([text]) =>
      text.includes("'game.lifecycle.start.v1'::text"),
    );
    expect(lifecycleCommands).toBeDefined();
    expect(lifecycleCommands?.[0]).toContain("'game.lifecycle.finish.v1'::text");
    expect(lifecycleCommands?.[0]).toContain('where not exists');
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
      now: new Date('2026-07-18T10:00:00.000Z'),
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
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('set title = case when title = $4')),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes("'game.lifecycle.start.v1'::text")),
    ).toBe(true);
  });

  it('transactionally merges raw and pseudonymous game aliases into the canonical aggregate', async () => {
    const sourceGameId = '7418f90b-0fa6-4c04-a3da-57707e2f0ae1';
    const canonicalGameId = '7418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const aliasSnapshot: LegacyGameImportSnapshot = {
      ...snapshot,
      externalId: 'f'.repeat(64),
      externalAliases: ['pay_source-game-id'],
    };
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (
        text.includes('from integration.external_entity_map') &&
        values[2] === 'game' &&
        Array.isArray(values[3])
      ) {
        return {
          rows: [
            {
              internal_id: canonicalGameId,
              external_id: aliasSnapshot.externalId,
              external_version: snapshot.externalVersion,
            },
            {
              internal_id: sourceGameId,
              external_id: aliasSnapshot.externalAliases?.[0],
              external_version: snapshot.externalVersion,
            },
          ],
        };
      }
      if (text.includes('from games.games') && text.includes('id = any')) {
        return { rows: [{ id: sourceGameId }, { id: canonicalGameId }] };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [aliasSnapshot],
      correlationId: 'legacy-alias-merge-test',
      now: new Date('2026-07-18T10:00:00.000Z'),
    });

    expect(result.existing).toEqual([expect.objectContaining({ gameId: canonicalGameId })]);
    expect(
      clientQuery.mock.calls.some(
        ([text, values]) =>
          text.includes('insert into integration.legacy_game_merge_redirects') &&
          values?.[1] === sourceGameId &&
          values?.[2] === canonicalGameId,
      ),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) =>
        text.includes('update booking.activity_history_projection'),
      ),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('delete from games.card_projections')),
    ).toBe(true);
    const aliasMappings = clientQuery.mock.calls.filter(
      ([text, values]) =>
        text.includes('on conflict (tenant_id, external_system, entity_type, external_id)') &&
        values?.[2] === 'game' &&
        values?.[3] === canonicalGameId,
    );
    expect(aliasMappings.map(([, values]) => values?.[4])).toEqual(
      expect.arrayContaining([aliasSnapshot.externalId, aliasSnapshot.externalAliases?.[0]]),
    );
  });

  it('normalizes the existing raw Viva exercise association for an imported game', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const rawVivaExerciseId = 'private-raw-viva-exercise-id';
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: gameId }] };
      }
      if (text.includes("entity_type = 'exercise'") && text.includes('internal_id = $3'))
        return { rows: [{ external_id: rawVivaExerciseId }] };
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-association-normalize-test',
      now: new Date('2026-07-18T10:00:00.000Z'),
    });

    expect(result.existing).toEqual([expect.objectContaining({ gameId })]);
    expect(
      clientQuery.mock.calls.find(
        ([text, values]) =>
          text.includes('set external_id = $4') &&
          values?.[2] === gameId &&
          values?.[3] === snapshot.vivaExerciseExternalId,
      ),
    ).toBeDefined();
    expect(
      clientQuery.mock.calls.some(
        ([text, values]) =>
          text.includes('insert into integration.external_entity_map') &&
          values?.[1] === 'VIVA' &&
          values?.[3] === gameId,
      ),
    ).toBe(false);
  });

  it('advances an existing CUP game lifecycle and emits the canonical outbox fact', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const organizerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: gameId }] };
      }
      if (text.includes('set lifecycle_state = $3')) return { rows: [{}] };
      if (text.includes('set revision = revision + 1')) return { rows: [{ revision: '8' }] };
      if (text.includes('select user_id') && text.includes('from games.participations')) {
        return { rows: [{ user_id: organizerUserId }] };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-lifecycle-refresh-test',
      now: new Date('2026-07-21T10:00:00.000Z'),
    });

    expect(result.existing).toEqual([expect.objectContaining({ gameId })]);
    const lifecycleUpdate = clientQuery.mock.calls.find(([text]) =>
      text.includes('set lifecycle_state = $3'),
    );
    expect(lifecycleUpdate?.[1]?.[2]).toBe('FINISHED');
    const outbox = clientQuery.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.finished.v1');
    expect(outbox?.[1]?.[5]).toContain('"aggregateRevision":"8"');
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes("'LEGACY_GAME_LIFECYCLE_REFRESHED'")),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(
        ([text]) =>
          text.includes(
            "command_type in ('game.lifecycle.start.v1', 'game.lifecycle.finish.v1')",
          ) && text.includes("state in ('PENDING', 'FAILED')"),
      ),
    ).toBe(true);
  });

  it('advances an associated game from a fresh Viva history exercise reference', async () => {
    const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
    const organizerUserId = 'e68c6e6e-0b0a-4ad9-8e3d-4bc08c1eea11';
    const exerciseAssociationId = 'e'.repeat(64);
    const { pool, clientQuery } = fakePool((text) => {
      if (text.includes('from integration.external_entity_map mapping')) {
        return {
          rows: [
            {
              id: gameId,
              revision: '1',
              lifecycle_state: 'SCHEDULED',
              starts_at: '2026-07-20T15:00:00.000Z',
              ends_at: '2026-07-20T16:30:00.000Z',
            },
          ],
        };
      }
      if (text.includes('update games.games') && text.includes('returning revision')) {
        return { rows: [{ revision: '2' }] };
      }
      if (text.includes('select user_id') && text.includes('from games.participations')) {
        return { rows: [{ user_id: organizerUserId }] };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).refreshVivaExerciseGameLifecycles({
      tenantId,
      vivaExerciseAssociationIds: [exerciseAssociationId],
      correlationId: 'viva-history-lifecycle-test',
      now: new Date('2026-07-21T10:00:00.000Z'),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.gameId).toBe(gameId);
    expect(typeof result[0]?.projectionEventId).toBe('string');
    const lifecycleUpdate = clientQuery.mock.calls.find(
      ([text]) => text.includes('update games.games') && text.includes('returning revision'),
    );
    expect(lifecycleUpdate?.[1]?.[2]).toBe('FINISHED');
    const outbox = clientQuery.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.finished.v1');
    expect(JSON.stringify(outbox?.[1])).not.toContain(exerciseAssociationId);
    expect(
      clientQuery.mock.calls.some(([text]) =>
        text.includes("'VIVA_HISTORY_GAME_LIFECYCLE_REFRESHED'"),
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
      if (
        text.includes('from integration.external_entity_map') &&
        values[2] === 'game' &&
        text.includes('for update')
      ) {
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
    expect(clientQuery).toHaveBeenCalledWith(
      "select set_config('app.profile_level_history_origin', $1, true)",
      ['LK_LEGACY_SNAPSHOT'],
    );
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
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (
        text.includes('from integration.external_entity_map') &&
        values[2] === 'game' &&
        text.includes('for update')
      ) {
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
