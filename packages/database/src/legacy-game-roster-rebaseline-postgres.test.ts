import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  createLegacyGameImportRepository,
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
          'games.participations',
          'integration.legacy_game_roster_sync_state',
          'integration.external_entity_map',
          'audit.outbox_events',
          'audit.audit_log',
          'games.games',
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
});
