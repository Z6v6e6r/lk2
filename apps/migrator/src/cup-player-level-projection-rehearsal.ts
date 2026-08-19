import { createCupPlayerLevelProjectionRepository, createDatabasePool } from '@phub/database';
import type { PoolClient } from 'pg';

const fixtures = {
  tenantA: '00000000-0000-4000-8000-000000000331',
  tenantB: '00000000-0000-4000-8000-000000000332',
  playerA: '00000000-0000-4000-8000-000000000333',
  playerB: '00000000-0000-4000-8000-000000000334',
  mappingA: '00000000-0000-4000-8000-000000000335',
  mappingB: '00000000-0000-4000-8000-000000000336',
  tenantKeyA: 'rehearsal-cup-projection-a',
  tenantKeyB: 'rehearsal-cup-projection-b',
  externalA: 'rehearsal-external-a',
  externalB: 'rehearsal-external-b',
} as const;

function fail(code: string): never {
  throw new Error(code);
}

function cloneDatabaseUrl(value: string | undefined, label: string): URL {
  if (!value) fail(`${label}_REQUIRED`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label}_INVALID`);
  }
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    fail(`${label}_INVALID`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    (parsed.port || '5432') !== '5432' ||
    parsed.search ||
    parsed.hash ||
    !/^phub_restore_[0-9]+(?:_[0-9]+)+$/.test(database)
  ) {
    fail(`${label}_INVALID`);
  }
  return parsed;
}

async function prepare(migratorConnectionString: string): Promise<void> {
  const pool = createDatabasePool(migratorConnectionString);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'CUP projection rehearsal A'),
              ($3, $4, 'CUP projection rehearsal B')`,
      [fixtures.tenantA, fixtures.tenantKeyA, fixtures.tenantB, fixtures.tenantKeyB],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function seedPlayer(
  client: PoolClient,
  fixture: {
    readonly tenantId: string;
    readonly playerId: string;
    readonly mappingId: string;
    readonly externalId: string;
    readonly displayName: string;
  },
): Promise<void> {
  await client.query("select set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
  await client.query('insert into identity.users (id, tenant_id) values ($1, $2)', [
    fixture.playerId,
    fixture.tenantId,
  ]);
  await client.query(
    `insert into profile.user_summaries (tenant_id, user_id, display_name)
     values ($1, $2, $3)`,
    [fixture.tenantId, fixture.playerId, fixture.displayName],
  );
  await client.query(
    `insert into integration.external_entity_map (
       id, tenant_id, external_system, entity_type, internal_id, external_id, sync_status
     ) values ($1, $2, 'VIVA', 'viva_profile', $3, $4, 'synced')`,
    [fixture.mappingId, fixture.tenantId, fixture.playerId, fixture.externalId],
  );
}

async function seedPlayers(migratorConnectionString: string): Promise<void> {
  const pool = createDatabasePool(migratorConnectionString);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await seedPlayer(client, {
      tenantId: fixtures.tenantA,
      playerId: fixtures.playerA,
      mappingId: fixtures.mappingA,
      externalId: fixtures.externalA,
      displayName: 'Rehearsal A',
    });
    await seedPlayer(client, {
      tenantId: fixtures.tenantB,
      playerId: fixtures.playerB,
      mappingId: fixtures.mappingB,
      externalId: fixtures.externalB,
      displayName: 'Rehearsal B',
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function visibleCount(
  runtimeConnectionString: string,
  tenantId: string,
  table: 'cup_player_level_projections' | 'cup_player_level_projection_events',
): Promise<number> {
  const pool = createDatabasePool(runtimeConnectionString);
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from eligibility.${table}`,
    );
    await client.query('rollback');
    return Number(result.rows[0]?.count ?? '-1');
  } finally {
    client.release();
    await pool.end();
  }
}

async function probe(
  migratorConnectionString: string,
  runtimeConnectionString: string,
): Promise<void> {
  await seedPlayers(migratorConnectionString);
  const runtimePool = createDatabasePool(runtimeConnectionString);
  try {
    const repository = createCupPlayerLevelProjectionRepository(runtimePool);
    const input = {
      tenantId: fixtures.tenantA,
      externalClientId: fixtures.externalA,
      sportCode: 'PADEL',
      levelCode: 'C',
      numericValue: 3.25,
      sourceRevision: 1,
      sourceEventId: 'rehearsal-cup-event-0001',
      requestHash: 'a'.repeat(64),
      sourceEventType: 'RATING_MANUALLY_CHANGED' as const,
      formulaVersion: 'padel-rating-grade-v1' as const,
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'rehearsal-cup-correlation-0001',
    };
    const applied = await repository.apply(input);
    if (applied.outcome !== 'applied') fail('CUP_PROJECTION_REHEARSAL_APPLY_FAILED');
    const replay = await repository.apply(input);
    if (replay.outcome !== 'replayed') fail('CUP_PROJECTION_REHEARSAL_REPLAY_FAILED');
    const advanced = await repository.apply({
      ...input,
      levelCode: 'C+',
      numericValue: 3.75,
      sourceRevision: 2,
      sourceEventId: 'rehearsal-cup-event-0002',
      requestHash: 'b'.repeat(64),
      occurredAt: '2026-01-02T00:00:00.000Z',
      correlationId: 'rehearsal-cup-correlation-0002',
    });
    if (advanced.outcome !== 'applied') fail('CUP_PROJECTION_REHEARSAL_ADVANCE_FAILED');
    const reusedEvent = await repository.apply({
      ...input,
      sourceRevision: 3,
      requestHash: 'c'.repeat(64),
    });
    if (reusedEvent.outcome !== 'idempotency_conflict') {
      fail('CUP_PROJECTION_REHEARSAL_EVENT_REUSE_ACCEPTED');
    }
    const crossTenant = await repository.apply({
      ...input,
      tenantId: fixtures.tenantB,
      sourceEventId: 'rehearsal-cup-event-0003',
      requestHash: 'd'.repeat(64),
    });
    if (crossTenant.outcome !== 'actor_not_mapped') {
      fail('CUP_PROJECTION_REHEARSAL_CROSS_TENANT_WRITE_VISIBLE');
    }
  } finally {
    await runtimePool.end();
  }
  const ownProjectionCount = await visibleCount(
    runtimeConnectionString,
    fixtures.tenantA,
    'cup_player_level_projections',
  );
  const ownEventCount = await visibleCount(
    runtimeConnectionString,
    fixtures.tenantA,
    'cup_player_level_projection_events',
  );
  const crossProjectionCount = await visibleCount(
    runtimeConnectionString,
    fixtures.tenantB,
    'cup_player_level_projections',
  );
  const crossEventCount = await visibleCount(
    runtimeConnectionString,
    fixtures.tenantB,
    'cup_player_level_projection_events',
  );
  if (
    ownProjectionCount !== 1 ||
    ownEventCount !== 2 ||
    crossProjectionCount !== 0 ||
    crossEventCount !== 0
  ) {
    fail('CUP_PROJECTION_REHEARSAL_RLS_INVALID');
  }
}

const mode = process.env.CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_MODE;
const migratorUrl = cloneDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
if (mode === 'prepare') {
  await prepare(migratorUrl.toString());
  process.stdout.write('CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_PREPARED tenants=2\n');
} else if (mode === 'probe') {
  const runtimeUrl = cloneDatabaseUrl(process.env.RUNTIME_DATABASE_URL, 'RUNTIME_DATABASE_URL');
  let migratorRoleName: string;
  let runtimeRoleName: string;
  try {
    migratorRoleName = decodeURIComponent(migratorUrl.username);
    runtimeRoleName = decodeURIComponent(runtimeUrl.username);
  } catch {
    fail('CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_ROLE_BOUNDARY_INVALID');
  }
  if (
    !migratorRoleName ||
    !runtimeRoleName ||
    runtimeUrl.hostname !== migratorUrl.hostname ||
    (runtimeUrl.port || '5432') !== (migratorUrl.port || '5432') ||
    runtimeUrl.pathname !== migratorUrl.pathname ||
    runtimeRoleName === migratorRoleName
  ) {
    fail('CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_ROLE_BOUNDARY_INVALID');
  }
  await probe(migratorUrl.toString(), runtimeUrl.toString());
  process.stdout.write(
    'CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_PROBE apply=passed replay=passed idempotency=passed cross_tenant_rls=passed\n',
  );
} else {
  fail('CUP_PLAYER_LEVEL_PROJECTION_REHEARSAL_MODE_INVALID');
}
