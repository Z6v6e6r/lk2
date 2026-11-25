import assert from 'node:assert/strict';

import {
  createCupPlayerLevelProjectionRepository,
  createDatabasePool,
  createPlayerLevelRepository,
  createProfileSummaryRepository,
  withTenantTransaction,
} from '@phub/database';
import Fastify from 'fastify';

import { registerCupPlayerLevelProjectionRoutes } from '../apps/api/src/profile/cup-player-level-projection-routes.js';

const playerId = '00000000-0000-4000-a000-000000000872';
const tenantKey = 'local-padel';
const externalClientId = 'synthetic-shared-player';
const url = new URL(process.env.LK2_CUP_PROJECTION_TEST_DB ?? '');
assert.equal(url.protocol, 'postgres:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '25478');
assert.equal(url.pathname, '/phub_cup_level_probe');
assert.equal(url.username, 'postgres');
assert.equal(url.search + url.hash + url.password, '');
const token = process.env.LK2_CUP_PROJECTION_TEST_TOKEN;
assert.ok(
  token && token.startsWith('synthetic-') && token.length >= 32,
  'synthetic ingress token required',
);

const admin = createDatabasePool(url.toString());
let tenantId: string;
try {
  const roleCheck = await admin.query(
    `select pg_catalog.current_database() as db,
            exists (
              select 1 from public.schema_migrations
               where filename = '0119_cup_calculated_player_levels.sql'
            ) as expected_migration`,
  );
  assert.deepEqual(roleCheck.rows[0], { db: 'phub_cup_level_probe', expected_migration: true });
  const tenant = await admin.query<{ id: string }>(
    'select id from identity.tenants where tenant_key = $1',
    [tenantKey],
  );
  assert.equal(tenant.rowCount, 1);
  tenantId = tenant.rows[0]!.id;
  await admin.query(`do $$ begin
    create role phub_cup_level_fixture login nosuperuser nobypassrls;
  exception when duplicate_object then null;
  end $$;
    grant usage on schema eligibility, integration, identity, profile, audit to phub_cup_level_fixture;
    grant select, update on identity.users, integration.external_entity_map,
      profile.user_summaries to phub_cup_level_fixture;
    grant select on eligibility.canonical_levels to phub_cup_level_fixture;
    grant select, insert, update on eligibility.player_sport_levels,
      eligibility.cup_player_level_projections to phub_cup_level_fixture;
    grant select, insert on eligibility.cup_player_level_projection_events,
      profile.level_history to phub_cup_level_fixture;
    grant insert on audit.audit_log to phub_cup_level_fixture;`);
  await withTenantTransaction(admin, tenantId, async (connection) => {
    await connection.query('insert into identity.users (id, tenant_id) values ($1, $2)', [
      playerId,
      tenantId,
    ]);
    await connection.query(
      `insert into integration.external_entity_map
         (tenant_id, external_system, entity_type, internal_id, external_id, sync_status)
       values ($1, 'VIVA', 'viva_profile', $2, $3, 'synced')`,
      [tenantId, playerId, externalClientId],
    );
    await connection.query(
      `insert into profile.user_summaries (tenant_id, user_id, display_name, level_label, level_value)
       values ($1, $2, 'Synthetic shared player', 'D+', 2.375)`,
      [tenantId, playerId],
    );
    await connection.query(
      `insert into eligibility.player_sport_levels
         (tenant_id, player_id, sport_code, level_id, source, scale_version)
       select $1, $2, sport_code, id, 'SELF_DECLARED', scale_version
         from eligibility.canonical_levels where tenant_id = $1 and code = 'D+'`,
      [tenantId, playerId],
    );
  });
} finally {
  await admin.end();
}

url.username = 'phub_cup_level_fixture';
const runtime = createDatabasePool(url.toString());
const app = Fastify();
const received: unknown[] = [];

registerCupPlayerLevelProjectionRoutes(app, {
  enabled: true,
  integrationToken: token,
  authorizedTenantKey: tenantKey,
  repository: createCupPlayerLevelProjectionRepository(runtime),
  commandHandlers: [
    (request, _reply, done) => {
      request.tenantId = tenantId;
      received.push(request.body);
      done();
    },
  ],
});
const levels = createPlayerLevelRepository(runtime);
const profiles = createProfileSummaryRepository(runtime);
app.get('/rehearsal', async () => {
  const [state, summary, projected, events] = await Promise.all([
    levels.getState(tenantId, playerId, 'PADEL'),
    profiles.get(tenantId, playerId),
    profiles.getCupProjectedLevels(tenantId, [playerId]),
    withTenantTransaction(
      runtime,
      tenantId,
      async (connection) =>
        (
          await connection.query<{ source_revision: string; source_event_id: string }>(
            `select source_revision, source_event_id from eligibility.cup_player_level_projection_events
            where tenant_id = $1 and player_id = $2 and sport_code = 'PADEL' order by source_revision`,
            [tenantId, playerId],
          )
        ).rows,
    ),
  ]);
  return {
    tenantKey,
    externalClientId,
    playerId,
    projectionStatus: state.projectionStatus,
    currentLevel: state.currentLevel,
    profileLevel: projected.get(playerId) ?? null,
    summaryLevel: summary?.levelLabel ?? null,
    events,
    received,
  };
});
async function stop(): Promise<void> {
  await app.close();
  await runtime.end();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
const address = await app.listen({ host: '127.0.0.1', port: 18078 });
process.stdout.write(`LK2 projection rehearsal listening on ${address}\n`);
