import { randomUUID, createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumersForGameEvent } from '@phub/games';

import { createGameRepository } from './game-repository.js';
import { createGameResultRepository } from './game-result-repository.js';
import { withTenantTransaction } from './connection.js';
import {
  createLegacyGameImportRepository,
  attestExactRosterPlayerMappings,
  exactRosterParticipations,
  exactRosterValueSha256,
  readExactRosterUiIdentityPreimage,
  readFinishedUnscoredUiPreimage,
  type LegacyGameUiObservationFence,
  type LegacyGameImportSnapshot,
} from './legacy-game-import-repository.js';

const suppliedConnectionString = process.env.LEGACY_ROSTER_REBASELINE_TEST_DATABASE_URL;
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

const tenantId = randomUUID();
const tenantKey = `roster-rebaseline-${tenantId.slice(0, 8)}`;

function snapshot(input: {
  readonly label: string;
  readonly players: number;
  readonly capacity?: number;
  readonly version?: string;
}): LegacyGameImportSnapshot {
  const participants = Array.from({ length: input.players }, (_unused, index) => ({
    externalId: `${input.label}-player-${index}`,
    displayName: `Игрок ${index}`,
    level: 'C+' as const,
    levelValue: 3.5,
    role: index === 0 ? ('ORGANIZER' as const) : ('PLAYER' as const),
    paymentState: 'PAID' as const,
  }));
  return {
    externalId: `${input.label}-game`,
    externalVersion: input.version ?? 'a'.repeat(64),
    vivaExerciseExternalId: randomUUID(),
    title: `Игра ${input.label}`,
    kind: 'RATING',
    visibility: 'PUBLIC',
    cancelled: false,
    startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 86_400_000 + 5_400_000).toISOString(),
    timezone: 'Europe/Moscow',
    station: {
      externalId: `${input.label}-station`,
      name: 'Терехово',
      courtExternalId: `${input.label}-court`,
      courtName: 'Корт №4',
    },
    capacity: input.capacity ?? input.players,
    waitlistEnabled: true,
    paymentMode: 'ORGANIZER_PAYS',
    levelFrom: 'C',
    levelTo: 'B',
    organizerExternalId: `${input.label}-player-0`,
    participants,
  };
}

describePostgres('legacy roster rebaseline against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const repository = createLegacyGameImportRepository(pool);

  async function state(mappingGameId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{
        mode: string;
        conflict_code: string | null;
        source_external_version: string;
      }>(
        `select mode, conflict_code, source_external_version
           from integration.legacy_game_roster_sync_state
          where tenant_id = $1 and game_id = $2`,
        [tenantId, mappingGameId],
      );
      return result.rows[0];
    });
  }

  async function activeParticipants(mappingGameId: string): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from games.participations
          where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'`,
        [tenantId, mappingGameId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  async function auditActions(mappingGameId: string): Promise<readonly string[]> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ action: string }>(
        `select action from audit.audit_log
          where tenant_id = $1 and resource_id = $2 order by occurred_at`,
        [tenantId, mappingGameId],
      );
      return result.rows.map((row) => row.action);
    });
  }

  async function quarantine(mappingGameId: string, version: string): Promise<void> {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into integration.legacy_game_roster_sync_state (
           tenant_id, game_id, source_external_version, last_synced_game_revision, mode,
           conflict_code, last_synced_at, updated_at
         ) values ($1, $2, $3, 1, 'CONFLICT', 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH', now(), now())
         on conflict (tenant_id, game_id) do update set
           mode = 'CONFLICT', conflict_code = 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH',
           source_external_version = excluded.source_external_version, updated_at = now()`,
        [tenantId, mappingGameId, version],
      );
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, tenantKey, 'Legacy roster rebaseline integration'],
    );
  });

  afterAll(async () => {
    // The suite owns a random tenant, so a failed child delete must never fail the run: the CI
    // database is disposable and a local leftover tenant is inert.
    const tolerate = async (statement: () => Promise<unknown>): Promise<void> => {
      try {
        await statement();
      } catch {
        // Cleanup only; the assertions above already carry the evidence.
      }
    };
    await tolerate(() =>
      withTenantTransaction(pool, tenantId, async (client) => {
        for (const table of [
          'games.result_submission_reviews',
          'games.result_submissions',
          'games.command_idempotency',
          'games.scheduled_commands',
          'games.card_projections',
          'games.seat_reservations',
          'games.waitlist_entries',
          'games.participations',
          'integration.legacy_game_roster_sync_state',
          'integration.external_entity_map',
          'audit.inbox_events',
          'audit.outbox_events',
          'audit.audit_log',
          'games.games',
          'profile.user_summaries',
          'identity.users',
        ]) {
          await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
        }
      }),
    );
    await tolerate(() => pool.query('delete from identity.tenants where id = $1', [tenantId]));
    await pool.end();
  });

  it('repairs only additive drift and reports the rosters that would drop a local participant', async () => {
    const additive = snapshot({ label: 'additive', players: 3, capacity: 4 });
    const additiveImported = await repository.importSnapshots({
      tenantKey,
      snapshots: [additive],
      correlationId: 'rebaseline-test-additive-import',
    });
    const additiveGameId = additiveImported.imported[0]?.gameId as string;
    expect(additiveGameId).toBeTruthy();
    await quarantine(additiveGameId, 'b'.repeat(64));

    const additiveRepair = await repository.rebaselineParticipants({
      tenantKey,
      snapshots: [
        {
          ...snapshot({ label: 'additive', players: 4, capacity: 4 }),
          externalVersion: 'c'.repeat(64),
        },
      ],
      correlationId: 'rebaseline-test-additive-repair',
    });
    expect(additiveRepair.rebaselined.map((item) => item.gameId)).toEqual([additiveGameId]);
    expect(additiveRepair.deferred).toEqual([]);
    expect(await state(additiveGameId)).toMatchObject({
      mode: 'MIRROR',
      conflict_code: null,
      source_external_version: 'c'.repeat(64),
    });
    expect(await activeParticipants(additiveGameId)).toBe(4);
    expect(await auditActions(additiveGameId)).toContain(
      'GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT',
    );

    const removal = snapshot({ label: 'removal', players: 4 });
    const removalImported = await repository.importSnapshots({
      tenantKey,
      snapshots: [removal],
      correlationId: 'rebaseline-test-removal-import',
    });
    const removalGameId = removalImported.imported[0]?.gameId as string;
    await quarantine(removalGameId, 'b'.repeat(64));

    const removalRepair = await repository.rebaselineParticipants({
      tenantKey,
      snapshots: [
        {
          ...removal,
          externalVersion: 'd'.repeat(64),
          participants: removal.participants.slice(0, 3),
        },
      ],
      correlationId: 'rebaseline-test-removal-repair',
    });
    expect(removalRepair.rebaselined).toEqual([]);
    expect(removalRepair.deferred).toEqual([
      {
        gameId: removalGameId,
        externalId: removal.externalId,
        code: 'LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL',
        removableParticipantCount: 1,
      },
    ]);
    expect(await state(removalGameId)).toMatchObject({
      mode: 'CONFLICT',
      conflict_code: 'LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL',
    });
    expect(await activeParticipants(removalGameId)).toBe(4);
    expect(await auditActions(removalGameId)).toContain('LEGACY_GAME_ROSTER_SYNC_QUARANTINED');

    // A Game with no quarantine row is never touched by the repair driver.
    const fresh = snapshot({ label: 'fresh', players: 2, capacity: 4 });
    await repository.importSnapshots({
      tenantKey,
      snapshots: [fresh],
      correlationId: 'rebaseline-test-fresh-import',
    });
    const freshRepair = await repository.rebaselineParticipants({
      tenantKey,
      snapshots: [fresh],
      correlationId: 'rebaseline-test-fresh-repair',
    });
    expect(freshRepair.rebaselined).toEqual([]);
    expect(freshRepair.deferred).toEqual([]);
    expect(freshRepair.skipped).toBe(1);
  });
  it('bootstraps aliases once and verifies an unchanged old card without changing its revision', async () => {
    const original = snapshot({ label: 'alias-heartbeat', players: 2, capacity: 4 });
    const aliased = {
      ...original,
      participants: original.participants.map((p) => ({
        ...p,
        externalAliases: ['raw-' + p.externalId],
      })),
    };
    const imported = await repository.importSnapshots({
      tenantKey,
      snapshots: [aliased],
      correlationId: 'alias-heartbeat-import',
    });
    const gameId = imported.imported[0]!.gameId;
    const cards = createGameRepository(pool);
    await cards.projectCardEvent({
      tenantId,
      gameId,
      eventId: imported.imported[0]!.projectionEventId,
    });
    expect(
      (
        await repository.synchronizeParticipants({
          tenantKey,
          snapshots: [aliased],
          correlationId: 'alias-heartbeat-bootstrap',
        })
      ).bootstrapped,
    ).toBe(1);
    const baseline = await cards.getCardProjections!(tenantId, [gameId]);
    expect(baseline.get(gameId)?.rosterVerifiedAt).toBeTruthy();
    await withTenantTransaction(pool, tenantId, async (c) => {
      await c.query(
        "update games.card_projections set projected_at=now()-interval '1 day' where tenant_id=$1 and game_id=$2",
        [tenantId, gameId],
      );
      await c.query(
        "update integration.legacy_game_roster_sync_state set last_synced_at=now()-interval '1 day' where tenant_id=$1 and game_id=$2",
        [tenantId, gameId],
      );
    });
    const before = await auditActions(gameId);
    expect(
      (
        await repository.synchronizeParticipants({
          tenantKey,
          snapshots: [aliased],
          correlationId: 'alias-heartbeat-unchanged',
        })
      ).unchanged,
    ).toBe(1);
    const refreshed = (await cards.getCardProjections!(tenantId, [gameId])).get(gameId)!;
    expect(Date.parse(refreshed.rosterVerifiedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(refreshed.projectedAt)).toBeLessThan(Date.now() - 23 * 3_600_000);
    expect(refreshed.aggregateRevision).toBe(1);
    expect(await auditActions(gameId)).toEqual(before);
    await quarantine(gameId, aliased.externalVersion);
    expect(
      (await cards.getCardProjections!(tenantId, [gameId])).get(gameId)?.rosterVerifiedAt,
    ).toBeNull();
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "update integration.legacy_game_roster_sync_state set mode='MIRROR',conflict_code=null where tenant_id=$1 and game_id=$2",
        [tenantId, gameId],
      ),
    );
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query('update games.games set revision=revision+1 where tenant_id=$1 and id=$2', [
        tenantId,
        gameId,
      ]),
    );
    expect(
      (await cards.getCardProjections!(tenantId, [gameId])).get(gameId)?.rosterVerifiedAt,
    ).toBeNull();
  });
  it('preserves existing profile values and timestamps during an audited repair', async () => {
    const original = snapshot({ label: 'preserve-profile', players: 2, capacity: 4 });
    const aliased = {
      ...original,
      participants: original.participants.map((p) => ({
        ...p,
        externalAliases: ['raw-' + p.externalId],
      })),
    };
    const imported = await repository.importSnapshots({
      tenantKey,
      snapshots: [aliased],
      correlationId: 'preserve-profile-import',
    });
    const gameId = imported.imported[0]!.gameId;
    await quarantine(gameId, aliased.externalVersion);
    const names = await withTenantTransaction(pool, tenantId, async (c) => {
      await c.query(
        "update profile.user_summaries set display_name='Сохранённое имя' where tenant_id=$1",
        [tenantId],
      );
      return (
        await c.query<{ user_id: string; display_name: string; updated_at: Date }>(
          'select user_id,display_name,updated_at from profile.user_summaries where tenant_id=$1 order by user_id',
          [tenantId],
        )
      ).rows;
    });
    const repaired = await repository.rebaselineParticipants({
      tenantKey,
      snapshots: [aliased],
      correlationId: 'preserve-profile-repair',
    });
    expect(repaired.rebaselined).toHaveLength(1);
    expect(
      await withTenantTransaction(
        pool,
        tenantId,
        async (c) =>
          (
            await c.query<{ user_id: string; display_name: string; updated_at: Date }>(
              'select user_id,display_name,updated_at from profile.user_summaries where tenant_id=$1 order by user_id',
              [tenantId],
            )
          ).rows,
      ),
    ).toEqual(names);
  });
  it('fences an additive participant identity in PostgreSQL and never creates a replacement account', async () => {
    const original = snapshot({ label: 'exact-identity-cas', players: 2, capacity: 4 });
    const expanded = {
      ...original,
      externalVersion: 'c'.repeat(64),
      participants: [
        ...original.participants,
        {
          ...original.participants[1]!,
          externalId: 'exact-identity-third',
          displayName: 'Третий участник',
        },
      ],
    };
    const first = await repository.importSnapshots({
      tenantKey,
      snapshots: [original],
      correlationId: 'exact-identity-target-import',
    });
    const gameId = first.imported[0]!.gameId;
    await repository.importSnapshots({
      tenantKey,
      snapshots: [
        {
          ...expanded,
          externalId: original.externalId + '-registry',
          vivaExerciseExternalId: randomUUID(),
        },
      ],
      correlationId: 'exact-identity-registry-import',
    });
    await quarantine(gameId, 'b'.repeat(64));
    const aliases = expanded.participants.map((p) => p.externalId);
    const identities = await withTenantTransaction(
      pool,
      tenantId,
      async (c) =>
        (
          await c.query<{
            external_id: string;
            internal_id: string;
            sync_status: string;
            sync_error_code: string | null;
          }>(
            "select external_id,internal_id,sync_status,sync_error_code from integration.external_entity_map where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player' and external_id=any($2::text[])",
            [tenantId, aliases],
          )
        ).rows,
    );
    const expected = {
      gameId,
      revision: 1,
      sourceVersion: expanded.externalVersion,
      syncSourceVersion: 'b'.repeat(64),
      playerMappingsSha256: attestExactRosterPlayerMappings(expanded, identities).sha256,
    };
    const extraUser = randomUUID();
    await withTenantTransaction(pool, tenantId, async (c) => {
      await c.query('insert into identity.users(id,tenant_id) values($1,$2)', [
        extraUser,
        tenantId,
      ]);
      await c.query(
        "update integration.external_entity_map set internal_id=$3 where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player' and external_id=$2",
        [tenantId, 'exact-identity-third', extraUser],
      );
    });
    const repair = {
      tenantKey,
      snapshots: [expanded],
      correlationId: 'exact-identity-reviewed-operation',
      allowLocalRemovals: false,
      expected,
    };
    await expect(repository.rebaselineParticipants(repair)).rejects.toThrow(
      'LEGACY_GAME_EXACT_REPAIR_DRIFT',
    );
    expect(await activeParticipants(gameId)).toBe(2);
    expect(
      (await auditActions(gameId)).includes('GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT'),
    ).toBe(false);
    const third = identities.find((row) => row.external_id === 'exact-identity-third')!;
    await withTenantTransaction(pool, tenantId, (c) =>
      c.query(
        "update integration.external_entity_map set internal_id=$3 where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player' and external_id=$2",
        [tenantId, third.external_id, third.internal_id],
      ),
    );
    const usersBefore = await withTenantTransaction(
      pool,
      tenantId,
      async (c) =>
        (
          await c.query<{ count: string }>(
            'select count(*)::text as count from identity.users where tenant_id=$1',
            [tenantId],
          )
        ).rows[0]!.count,
    );
    expect((await repository.rebaselineParticipants(repair)).rebaselined).toHaveLength(1);
    expect(await activeParticipants(gameId)).toBe(3);
    expect(
      await withTenantTransaction(
        pool,
        tenantId,
        async (c) =>
          (
            await c.query<{ count: string }>(
              'select count(*)::text as count from identity.users where tenant_id=$1',
              [tenantId],
            )
          ).rows[0]!.count,
      ),
    ).toBe(usersBefore);
  });
  it('replaces a fenced 2-player roster with source4 atomically while retaining paid rows and every account', async () => {
    const original = snapshot({ label: 'exact-replacement-old', players: 2, capacity: 4 });
    const source = {
      ...snapshot({ label: 'exact-replacement-source', players: 4, capacity: 4 }),
      externalId: original.externalId,
      vivaExerciseExternalId: original.vivaExerciseExternalId,
      startsAt: original.startsAt,
      endsAt: original.endsAt,
      externalVersion: 'c'.repeat(64),
    };
    const imported = await repository.importSnapshots({
      tenantKey,
      snapshots: [original],
      correlationId: 'replacement-target-import',
    });
    const gameId = imported.imported[0]!.gameId;
    // Existing accounts are registered through an independent synthetic game. Exact repair must
    // use these identities; it must never call the account/profile creation path itself.
    await repository.importSnapshots({
      tenantKey,
      snapshots: [
        {
          ...source,
          externalId: 'exact-replacement-registry',
          vivaExerciseExternalId: randomUUID(),
        },
      ],
      correlationId: 'replacement-registry-import',
    });
    await quarantine(gameId, 'b'.repeat(64));
    const read = () =>
      withTenantTransaction(pool, tenantId, async (c) => {
        const roster = (
          await c.query<{
            id: string;
            user_id: string;
            role: string;
            state: string;
            payment_state: string;
          }>(
            'select id,user_id,role,state,payment_state from games.participations where tenant_id=$1 and game_id=$2 order by id',
            [tenantId, gameId],
          )
        ).rows;
        const identities = (
          await c.query<{
            external_id: string;
            internal_id: string;
            sync_status: string;
            sync_error_code: string | null;
          }>(
            "select external_id,internal_id,sync_status,sync_error_code from integration.external_entity_map where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player' and external_id=any($2::text[]) order by external_id",
            [tenantId, source.participants.map((p) => p.externalId)],
          )
        ).rows;
        const accounts = (
          await c.query<Record<string, unknown>>(
            'select * from identity.users where tenant_id=$1 order by id',
            [tenantId],
          )
        ).rows;
        const profiles = (
          await c.query<Record<string, unknown>>(
            'select * from profile.user_summaries where tenant_id=$1 order by user_id',
            [tenantId],
          )
        ).rows;
        const game = (
          await c.query<Record<string, unknown> & { starts_at: Date; ends_at: Date }>(
            'select * from games.games where tenant_id=$1 and id=$2',
            [tenantId, gameId],
          )
        ).rows[0]!;
        const sync = (
          await c.query<Record<string, unknown>>(
            'select * from integration.legacy_game_roster_sync_state where tenant_id=$1 and game_id=$2',
            [tenantId, gameId],
          )
        ).rows[0]!;
        const outbox = (
          await c.query<{ id: string; event_type: string; payload: unknown }>(
            'select id,event_type,payload from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 order by id',
            [tenantId, gameId],
          )
        ).rows;
        return { roster, identities, accounts, profiles, game, sync, outbox };
      });
    const before = await read();
    const tuples = exactRosterParticipations(
      before.roster.map((p) => [p.id, p.user_id, p.role, p.state, p.payment_state]),
    );
    const expected = {
      gameId,
      revision: 1,
      sourceVersion: source.externalVersion,
      syncSourceVersion: 'b'.repeat(64),
      playerMappingsSha256: attestExactRosterPlayerMappings(source, before.identities).sha256,
      replacement: {
        participationsSha256: exactRosterValueSha256(tuples),
        retainedParticipationIdsSha256: exactRosterValueSha256(
          before.roster.map((p) => p.id).sort(),
        ),
      },
    };
    const command = {
      tenantKey,
      snapshots: [source],
      correlationId: 'replacement-reviewed-operation',
      allowLocalRemovals: true,
      expected,
    };
    await expect(
      repository.rebaselineParticipants({
        ...command,
        expected: {
          ...expected,
          replacement: { ...expected.replacement, participationsSha256: 'e'.repeat(64) },
        },
      }),
    ).rejects.toThrow('LEGACY_GAME_EXACT_REPAIR_DRIFT');
    expect(await read()).toEqual(before);
    // Even an expired ACTIVE reservation is a pending payment boundary, so stop rather than
    // letting a later confirmation overfill the restored source4 roster.
    for (const table of ['games.seat_reservations', 'games.waitlist_entries']) {
      const id = randomUUID();
      await withTenantTransaction(pool, tenantId, async (c) => {
        if (table === 'games.seat_reservations')
          await c.query(
            "insert into games.seat_reservations(tenant_id,game_id,id,user_id,created_at,expires_at) values($1,$2,$3,$4,now()-interval '2 hours',now()-interval '1 hour')",
            [tenantId, gameId, id, before.roster[0]!.user_id],
          );
        else
          await c.query(
            'insert into games.waitlist_entries(tenant_id,game_id,id,user_id,position) values($1,$2,$3,$4,1)',
            [tenantId, gameId, id, before.roster[0]!.user_id],
          );
      });
      await expect(repository.rebaselineParticipants(command)).rejects.toThrow(
        'LEGACY_GAME_EXACT_REPAIR_PENDING_CAPACITY',
      );
      expect(await read()).toEqual(before);
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query(`delete from ${table} where tenant_id=$1 and id=$2`, [tenantId, id]),
      );
    }
    // Fail after the actual participation/game/sync writes, before committing the outbox.
    // The real PostgreSQL transaction must roll back all preceding changes.
    const failingPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: (sql: string, values?: unknown[]) => {
            if (sql.includes('insert into audit.outbox_events'))
              throw new Error('synthetic-outbox-failure');
            return client.query(sql, values);
          },
        };
      },
    };
    await expect(
      createLegacyGameImportRepository(failingPool as unknown as Pool).rebaselineParticipants(
        command,
      ),
    ).rejects.toThrow('synthetic-outbox-failure');
    expect(await read()).toEqual(before);
    expect(
      (await repository.rebaselineParticipants(command)).rebaselined.map((r) => r.gameId),
    ).toEqual([gameId]);
    const after = await read();
    expect(after.accounts).toEqual(before.accounts);
    expect(after.profiles).toEqual(before.profiles);
    expect(
      after.roster
        .filter((p) => p.state === 'ACTIVE')
        .map((p) => p.user_id)
        .sort(),
    ).toEqual(before.identities.map((p) => p.internal_id).sort());
    expect(after.roster.filter((p) => p.state === 'LEFT')).toEqual(
      before.roster.map((p) => ({ ...p, state: 'LEFT' })),
    );
    expect(after.roster.every((p) => p.payment_state === 'PAID')).toBe(true);
    expect(after.game).toMatchObject({
      revision: '2',
      lifecycle_state: 'SCHEDULED',
      starts_at: before.game.starts_at,
      ends_at: before.game.ends_at,
      capacity: 4,
    });
    expect(after.sync).toMatchObject({
      mode: 'MIRROR',
      conflict_code: null,
      last_synced_game_revision: '2',
    });
    expect(after.outbox).toHaveLength(before.outbox.length + 1);
    const emitted = after.outbox.filter(
      (event) => !before.outbox.some((old) => old.id === event.id),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event_type).toBe('game.scheduled.v1');
    expect(emitted[0]!.payload).toMatchObject({ gameId, aggregateRevision: '2' });
    // The existing event deliberately retains the normal downstream consumers. An operator must
    // review notification/chat effects before live execution; recovery is not projection-only.
    expect(consumersForGameEvent('game.scheduled.v1')).toEqual(
      expect.arrayContaining(['messaging-membership', 'notifications-rules']),
    );
    const audit = await withTenantTransaction(
      pool,
      tenantId,
      async (c) =>
        (
          await c.query<{ new_value: { replacement: Record<string, unknown> } }>(
            "select new_value from audit.audit_log where tenant_id=$1 and resource_id=$2 and action='GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT' and result='SUCCESS'",
            [tenantId, gameId],
          )
        ).rows,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.new_value.replacement).toMatchObject({
      retainedParticipationCount: 2,
      retainedPaidParticipationCount: 2,
      participationsBeforeSha256: expected.replacement.participationsSha256,
      retainedParticipationIdsSha256: expected.replacement.retainedParticipationIdsSha256,
      participationsAfterSha256: exactRosterValueSha256(
        exactRosterParticipations(
          after.roster.map((p) => [p.id, p.user_id, p.role, p.state, p.payment_state]),
        ),
      ),
    });
    // The repository fence rejects an old revision. Lost-ACK readback belongs to the Worker,
    // which recognizes the matching success audit without calling this writer again.
    await expect(repository.rebaselineParticipants(command)).rejects.toThrow(
      'LEGACY_GAME_EXACT_REPAIR_DRIFT',
    );
    expect(await read()).toEqual(after);
  });
  it.each(['scheduled', 'finished'] as const)(
    'preserves paid rows and mapping absence in %s UI recovery',
    async (phase) => {
      const old = {
        ...snapshot({ label: 'ui-proof-old', players: 2, capacity: 4 }),
        vivaExerciseExternalId: 'e'.repeat(64),
      };
      const imported = await repository.importSnapshots({
        tenantKey,
        snapshots: [old],
        correlationId: 'ui-old-import',
      });
      const gameId = imported.imported[0]!.gameId,
        clients = Array.from({ length: 4 }, () => randomUUID());
      const members = clients.map((id, i) => ({
        ...old.participants[0]!,
        externalId: createHash('sha256')
          .update('phub-local-public-clone-v1:player:' + id)
          .digest('hex'),
        externalAliases: [id],
        role: i === 0 ? ('ORGANIZER' as const) : ('PLAYER' as const),
      }));
      const source = {
        ...old,
        externalVersion: 'c'.repeat(64),
        organizerExternalId: members[0]!.externalId,
        participants: members,
      };
      await repository.importSnapshots({
        tenantKey,
        snapshots: [
          { ...source, externalId: 'ui-proof-registry', vivaExerciseExternalId: randomUUID() },
        ],
        correlationId: 'ui-registry-import',
      });
      await quarantine(gameId, 'b'.repeat(64));
      if (phase === 'finished') {
        source.startsAt = new Date(Date.now() - 7200000).toISOString();
        source.endsAt = new Date(Date.now() - 3600000).toISOString();
        await withTenantTransaction(pool, tenantId, (c) =>
          c.query('update games.games set starts_at=$3,ends_at=$4 where tenant_id=$1 and id=$2', [
            tenantId,
            gameId,
            source.startsAt,
            source.endsAt,
          ]),
        );
        for (const [kind, revision, due] of [
          ['start', 1, source.startsAt],
          ['finish', 2, source.endsAt],
        ] as const) {
          const id = await withTenantTransaction(
            pool,
            tenantId,
            async (c) =>
              (
                await c.query<{ id: string }>(
                  "update games.scheduled_commands set state='PROCESSING',locked_by='owned-ui-fixture',locked_at=now(),attempts=attempts+1,expected_revision=$4,due_at=$5 where tenant_id=$1 and game_id=$2 and command_type=$3 returning id",
                  [tenantId, gameId, `game.lifecycle.${kind}.v1`, revision, due],
                )
              ).rows[0]!.id,
          );
          expect(
            await createGameRepository(pool).executeLifecycleCommand({
              tenantId,
              commandId: id,
              workerId: 'owned-ui-fixture',
              correlationId: `ui-native-${kind}-${gameId}`,
              occurredAt: new Date(due),
            }),
          ).toMatchObject({ outcome: 'applied', revision: revision + 1 });
        }
      }
      const pre = await withTenantTransaction(pool, tenantId, async (c) => {
        const rows = (
          await c.query<{
            id: string;
            user_id: string;
            role: string;
            state: string;
            payment_state: string;
          }>(
            'select id,user_id,role,state,payment_state from games.participations where tenant_id=$1 and game_id=$2 order by id',
            [tenantId, gameId],
          )
        ).rows;
        const mappings = (
          await c.query<{
            external_id: string;
            internal_id: string;
            sync_status: string;
            sync_error_code: string | null;
          }>(
            "select external_id,internal_id,sync_status,sync_error_code from integration.external_entity_map where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player' and external_id=any($2::text[]) order by external_id",
            [tenantId, members.flatMap((m) => [m.externalId, ...m.externalAliases])],
          )
        ).rows;
        const identities = await readExactRosterUiIdentityPreimage(c, {
          tenantId,
          gameId,
          source,
          mappings,
          lock: false,
        });
        const users = (
          await c.query<Record<string, unknown>>(
            'select * from identity.users where tenant_id=$1 order by id',
            [tenantId],
          )
        ).rows;
        const profiles = (
          await c.query<Record<string, unknown>>(
            'select * from profile.user_summaries where tenant_id=$1 order by user_id',
            [tenantId],
          )
        ).rows;
        return { rows, mappings, identities, users, profiles };
      });
      const ui: LegacyGameUiObservationFence = {
        policy: 'OPERATOR_REVIEWED_VIVA_UI_SUBSCRIPTION_OBSERVATION_V1',
        originAuthenticated: false,
        proofSha256: '1'.repeat(64),
        reviewSha256: '2'.repeat(64),
        captureSetSha256: '3'.repeat(64),
        observationSetSha256: '4'.repeat(64),
        sourceObservationSha256: '5'.repeat(64),
        ...pre.identities,
        capturedAt: new Date(Date.now() - 60000).toISOString(),
        reviewedAt: new Date(Date.now() - 30000).toISOString(),
        expiresAt: new Date(Date.now() + 840000).toISOString(),
      };
      if (phase === 'finished') {
        const native = await withTenantTransaction(pool, tenantId, (c) =>
          readFinishedUnscoredUiPreimage(c, { tenantId, gameId, lock: false }),
        );
        Object.assign(ui, {
          finishedUnscored: {
            policy: 'EXACT_UI_PROOF_FINISHED_UNSCORED',
            preimageSha256: native.sha256,
          },
        });
      }
      const expected = {
        gameId,
        revision: phase === 'finished' ? 3 : 1,
        sourceVersion: source.externalVersion,
        syncSourceVersion: 'b'.repeat(64),
        playerMappingsSha256: attestExactRosterPlayerMappings(source, pre.mappings).sha256,
        replacement: {
          participationsSha256: exactRosterValueSha256(
            exactRosterParticipations(
              pre.rows.map((r) => [r.id, r.user_id, r.role, r.state, r.payment_state]),
            ),
          ),
          retainedParticipationIdsSha256: exactRosterValueSha256(pre.rows.map((r) => r.id).sort()),
          uiObservation: ui,
        },
      };
      const command = {
        tenantKey,
        snapshots: [source],
        correlationId: 'ui-observation-reviewed-operation',
        allowLocalRemovals: true,
        expected,
        now: new Date('1990-01-01T00:00:00Z'),
      };
      // Reserve a quiet table slot during fixture transaction setup, because other CI suites
      // write different tenants concurrently. Runtime NOWAIT remains exercised reentrantly;
      // busy/refusal cases below use the unmodified pool and never wait or retry the operation.
      const isolatedPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          const c = await pool.connect();
          return {
            release: () => c.release(),
            query: async (sql: string, values?: unknown[]) => {
              const result = await c.query(sql, values);
              if (sql === 'begin') {
                await c.query("set local statement_timeout='10000'");
                await c.query('lock table integration.external_entity_map in exclusive mode');
              }
              return result;
            },
          };
        },
      };
      const isolated = createLegacyGameImportRepository(isolatedPool as unknown as Pool);
      const readWriteImage = () =>
        withTenantTransaction(pool, tenantId, async (c) => {
          const image: Record<string, unknown> = {};
          for (const [table, column] of [
            ['games.games', 'id'],
            ['games.participations', 'game_id'],
            ['integration.legacy_game_roster_sync_state', 'game_id'],
            ['audit.audit_log', 'resource_id'],
            ['audit.outbox_events', 'aggregate_id'],
          ] as const)
            image[table] = (
              await c.query<Record<string, unknown>>(
                `select * from ${table} where tenant_id=$1 and ${column}=$2 order by 1,2`,
                [tenantId, gameId],
              )
            ).rows;
          return image;
        });
      const unchanged = await readWriteImage();
      await expect(
        isolated.rebaselineParticipants({
          ...command,
          expected: {
            ...expected,
            replacement: {
              ...expected.replacement,
              uiObservation: {
                ...ui,
                capturedAt: new Date(Date.now() - 120000).toISOString(),
                reviewedAt: new Date(Date.now() - 90000).toISOString(),
                expiresAt: new Date(Date.now() - 60000).toISOString(),
              },
            },
          },
        }),
      ).rejects.toThrow('LEGACY_GAME_UI_OBSERVATION_EXPIRED');
      expect(await activeParticipants(gameId)).toBe(2);
      // Inject only the final observed DB instant; all rows/locks remain real PostgreSQL.
      // This proves that expiry while checking the final phase cannot authorize a paid write.
      let phaseClocks = 0;
      const finalClockPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          const c = await isolatedPool.connect();
          return {
            release: () => c.release(),
            query: async (sql: string, values?: unknown[]) => {
              const result = await c.query(sql, values);
              if (sql === 'select clock_timestamp() as server_now' && ++phaseClocks === 2)
                return {
                  ...result,
                  rows: [{ server_now: new Date(Date.parse(ui.expiresAt) + 1) }],
                };
              if (phase === 'scheduled' && sql === 'select clock_timestamp() as checked_at')
                return { ...result, rows: [{ checked_at: new Date(source.startsAt) }] };
              return result;
            },
          };
        },
      };
      await expect(
        createLegacyGameImportRepository(finalClockPool as unknown as Pool).rebaselineParticipants(
          command,
        ),
      ).rejects.toThrow(
        phase === 'finished'
          ? 'LEGACY_GAME_UI_OBSERVATION_EXPIRED'
          : 'LEGACY_GAME_EXACT_REPAIR_SCHEDULE',
      );
      expect(await activeParticipants(gameId)).toBe(2);
      if (phase === 'finished') {
        // A result writer that owns the Game first wins. Recovery waits for that same row,
        // sees the newly committed submission, and performs no roster mutation.
        const resultWriter = await pool.connect();
        let waiting!: () => void;
        const gameRequested = new Promise<void>((resolve) => {
          waiting = resolve;
        });
        const watched = {
          query: pool.query.bind(pool),
          connect: async () => {
            const c = await isolatedPool.connect();
            return {
              release: () => c.release(),
              query: (sql: string, values?: unknown[]) => {
                if (sql.includes('from games.games') && sql.includes('for update')) waiting();
                return c.query(sql, values);
              },
            };
          },
        };
        try {
          await resultWriter.query('begin');
          await resultWriter.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
          await resultWriter.query(
            'select id from games.games where tenant_id=$1 and id=$2 for update',
            [tenantId, gameId],
          );
          const rejected = expect(
            createLegacyGameImportRepository(watched as unknown as Pool).rebaselineParticipants(
              command,
            ),
          ).rejects.toThrow('LEGACY_GAME_UI_FINISHED_RESULT_EXISTS');
          await gameRequested;
          await resultWriter.query(
            "insert into games.result_submissions(tenant_id,game_id,submitted_by_user_id,score_payload,roster_snapshot) values($1,$2,$3,'{}','{}')",
            [tenantId, gameId, pre.rows[0]!.user_id],
          );
          await resultWriter.query('commit');
          await rejected;
          expect(await activeParticipants(gameId)).toBe(2);
          await withTenantTransaction(pool, tenantId, (c) =>
            c.query('delete from games.result_submissions where tenant_id=$1 and game_id=$2', [
              tenantId,
              gameId,
            ]),
          );
        } finally {
          await resultWriter.query('rollback');
          resultWriter.release();
        }
      }
      const blocker = await pool.connect(),
        ref = [...clients].sort()[0]!;
      try {
        await blocker.query('begin');
        await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          tenantId + '\u001fVIVA\u001f' + ref,
        ]);
        await expect(repository.rebaselineParticipants(command)).rejects.toThrow(
          'LEGACY_GAME_UI_OBSERVATION_WRITER_BUSY',
        );
        await blocker.query('rollback');
        await blocker.query('begin');
        await blocker.query('lock table integration.external_entity_map in row exclusive mode');
        await expect(repository.rebaselineParticipants(command)).rejects.toMatchObject({
          code: '55P03',
        });
        expect(await activeParticipants(gameId)).toBe(2);
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
      expect(await readWriteImage()).toEqual(unchanged);
      expect((await isolated.rebaselineParticipants(command)).rebaselined).toHaveLength(1);
      const post = await withTenantTransaction(pool, tenantId, async (c) => ({
        rows: (
          await c.query<{
            id: string;
            user_id: string;
            role: string;
            state: string;
            payment_state: string;
          }>(
            'select id,user_id,role,state,payment_state from games.participations where tenant_id=$1 and game_id=$2 order by id',
            [tenantId, gameId],
          )
        ).rows,
        users: (
          await c.query<Record<string, unknown>>(
            'select * from identity.users where tenant_id=$1 order by id',
            [tenantId],
          )
        ).rows,
        profiles: (
          await c.query<Record<string, unknown>>(
            'select * from profile.user_summaries where tenant_id=$1 order by user_id',
            [tenantId],
          )
        ).rows,
        audit: (
          await c.query<{
            new_value: { replacement: { uiObservation: LegacyGameUiObservationFence } };
          }>(
            "select new_value from audit.audit_log where tenant_id=$1 and resource_id=$2 and action='GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT'",
            [tenantId, gameId],
          )
        ).rows,
      }));
      expect(post.users).toEqual(pre.users);
      expect(post.profiles).toEqual(pre.profiles);
      expect(post.rows.filter((r) => r.state === 'LEFT')).toEqual(
        pre.rows.map((r) => ({ ...r, state: 'LEFT' })),
      );
      expect(post.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(4);
      expect(post.rows.every((r) => r.payment_state === 'PAID')).toBe(true);
      expect(post.audit).toHaveLength(1);
      expect(post.audit[0]!.new_value.replacement.uiObservation).toEqual(ui);
      expect(JSON.stringify(post.audit)).not.toContain(ref);
      if (phase === 'finished') {
        const preserved = await withTenantTransaction(pool, tenantId, async (c) => ({
          game: (
            await c.query<Record<string, unknown>>(
              'select revision,lifecycle_state,result_state,starts_at,ends_at,started_at,finished_at from games.games where tenant_id=$1 and id=$2',
              [tenantId, gameId],
            )
          ).rows[0],
          phases: (
            await c.query(
              "select event_type,count(*)::int as count from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type in ('game.started.v1','game.finished.v1') group by event_type order by event_type",
              [tenantId, gameId],
            )
          ).rows,
          commands: (
            await c.query(
              'select state,count(*)::int as count from games.scheduled_commands where tenant_id=$1 and game_id=$2 group by state',
              [tenantId, gameId],
            )
          ).rows,
        }));
        expect(preserved.game).toMatchObject({
          revision: '4',
          lifecycle_state: 'FINISHED',
          result_state: 'AWAITING_SUBMISSION',
          starts_at: new Date(source.startsAt),
          ends_at: new Date(source.endsAt),
          started_at: new Date(source.startsAt),
          finished_at: new Date(source.endsAt),
        });
        expect(preserved.phases).toEqual([
          { event_type: 'game.finished.v1', count: 1 },
          { event_type: 'game.started.v1', count: 1 },
        ]);
        expect(preserved.commands).toEqual([{ state: 'COMPLETED', count: 2 }]);
        const users = post.rows
          .filter((r) => r.state === 'ACTIVE')
          .map((r) => r.user_id)
          .sort();
        expect(
          await createGameResultRepository(pool).submit({
            tenantId,
            gameId,
            actorUserId: users[0]!,
            idempotencyKey: 'owned-ui-post-recovery-result',
            requestHash: 'd'.repeat(64),
            correlationId: 'ui-post-recovery-result',
            result: {
              sets: [
                {
                  teamAUserIds: [users[0]!, users[1]!],
                  teamBUserIds: [users[2]!, users[3]!],
                  setNumber: 1,
                  teamA: 6,
                  teamB: 4,
                },
              ],
            },
          }),
        ).toMatchObject({ outcome: 'applied', resultState: 'PENDING_CONFIRMATION' });
        const submitted = await withTenantTransaction(
          pool,
          tenantId,
          async (c) =>
            (
              await c.query<{ roster_snapshot: unknown }>(
                'select roster_snapshot from games.result_submissions where tenant_id=$1 and game_id=$2',
                [tenantId, gameId],
              )
            ).rows[0]!.roster_snapshot,
        );
        for (const user of users) expect(JSON.stringify(submitted)).toContain(user);
        await expect(isolated.rebaselineParticipants(command)).rejects.toThrow(
          'LEGACY_GAME_UI_FINISHED_STATE',
        );
        expect(await activeParticipants(gameId)).toBe(4);
      }
    },
  );
  it.each(['clean', 'quarantined', 'stale'] as const)(
    'keeps the %s roster verification boundary through native start and finish',
    async (mode) => {
      const original = snapshot({ label: `native-carry-${mode}`, players: 4 });
      const imported = await repository.importSnapshots({
        tenantKey,
        snapshots: [original],
        correlationId: `native-carry-import-${mode}`,
      });
      const gameId = imported.imported[0]!.gameId,
        cards = createGameRepository(pool);
      await repository.synchronizeParticipants({
        tenantKey,
        snapshots: [original],
        correlationId: `native-carry-bootstrap-${mode}`,
      });
      const starts = new Date(Date.now() - 7200000),
        ends = new Date(Date.now() - 3600000);
      await withTenantTransaction(pool, tenantId, async (c) => {
        await c.query(
          'update games.games set starts_at=$3,ends_at=$4,revision=$5 where tenant_id=$1 and id=$2',
          [tenantId, gameId, starts, ends, mode === 'stale' ? 2 : 1],
        );
        if (mode === 'quarantined')
          await c.query(
            "update integration.legacy_game_roster_sync_state set mode='CONFLICT',conflict_code='LEGACY_GAME_ROSTER_BASELINE_MISMATCH' where tenant_id=$1 and game_id=$2",
            [tenantId, gameId],
          );
      });
      const read = () =>
        withTenantTransaction(
          pool,
          tenantId,
          async (c) =>
            (
              await c.query<{
                [key: string]: unknown;
                last_synced_game_revision: string;
                last_synced_at: Date;
              }>(
                'select * from integration.legacy_game_roster_sync_state where tenant_id=$1 and game_id=$2',
                [tenantId, gameId],
              )
            ).rows[0]!,
        );
      const before = await read();
      for (const [kind, offset, due] of [
        ['start', 0, starts],
        ['finish', 1, ends],
      ] as const) {
        const revision = (mode === 'stale' ? 2 : 1) + offset;
        const commandId = await withTenantTransaction(
          pool,
          tenantId,
          async (c) =>
            (
              await c.query<{ id: string }>(
                "update games.scheduled_commands set state='PROCESSING',locked_by='owned-carry-fixture',locked_at=now(),attempts=attempts+1,expected_revision=$4,due_at=$5 where tenant_id=$1 and game_id=$2 and command_type=$3 returning id",
                [tenantId, gameId, `game.lifecycle.${kind}.v1`, revision, due],
              )
            ).rows[0]!.id,
        );
        const applied = await cards.executeLifecycleCommand({
          tenantId,
          commandId,
          workerId: 'owned-carry-fixture',
          correlationId: `carry-${kind}-${gameId}`,
          occurredAt: due,
        });
        expect(applied).toMatchObject({ outcome: 'applied', revision: revision + 1 });
        if (applied.outcome !== 'applied') throw new Error('native fixture failed');
        await cards.projectCardEvent({ tenantId, gameId, eventId: applied.eventId });
        const after = await read();
        expect(after).toEqual({
          ...before,
          last_synced_game_revision:
            mode === 'clean' ? String(revision + 1) : before.last_synced_game_revision,
        });
        const card = (await cards.getCardProjections!(tenantId, [gameId])).get(gameId)!;
        expect(Boolean(card.rosterVerifiedAt)).toBe(mode === 'clean');
        if (mode === 'clean')
          expect(card.rosterVerifiedAt).toBe(new Date(before.last_synced_at).toISOString());
      }
    },
  );
});
