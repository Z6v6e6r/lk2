import { createHash } from 'node:crypto';
import {
  attestExactRosterPlayerMappings,
  withTenantTransaction,
  type LegacyGameExactPlayerMapping,
  type LegacyGameImportRepository,
} from '@phub/database';
import type { LegacyGamesMongoAdapter } from '@phub/legacy-games-adapter';
import type { Pool, QueryResultRow } from 'pg';

interface TargetRow extends QueryResultRow {
  game_id: string;
  revision: string | number;
  lifecycle_state: string;
  mode: string | null;
  conflict_code: string | null;
  sync_revision: string | number | null;
  sync_version: string | null;
  source_aliases: string[];
  participations: unknown;
  previous_audits: { revision: number; playerMappingsSha256: string }[];
}
export interface ExactRosterRepairReport {
  schema: 'PHUB_EXACT_LEGACY_ROSTER_REPAIR_V1';
  status: 'PLAN' | 'REPAIRED' | 'ALREADY_REPAIRED' | 'DEFERRED';
  gameId: string;
  operationId: string;
  planSha256: string;
  sourceParticipants: number;
  allowLocalRemovals: false;
  authorizesDeploy: false;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
function need(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`LEGACY_GAME_EXACT_REPAIR_${code}`);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** One canonical game per invocation. Source aliases and full snapshots stay in memory.
 * This is the existing audited rebaseline path, with an exact read-only plan and revision fence.
 * The deployment owner supplies backup, immutable image and preimage custody before apply.
 */
export async function exactLegacyGameRosterRepair(input: {
  readonly pool: Pool;
  readonly repository: Pick<LegacyGameImportRepository, 'rebaselineParticipants'>;
  readonly source: Pick<LegacyGamesMongoAdapter, 'readRosterByExternalIds'>;
  readonly tenantKey: string;
  readonly gameId: string;
  readonly operationId: string;
  readonly planOnly: boolean;
  readonly expectedPlanSha256?: string;
  readonly now?: Date;
}): Promise<ExactRosterRepairReport> {
  need(UUID.test(input.gameId), 'TARGET');
  need(/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/u.test(input.operationId), 'OPERATION');
  need(
    input.planOnly
      ? input.expectedPlanSha256 === undefined
      : HASH.test(input.expectedPlanSha256 ?? ''),
    'PLAN_HASH',
  );
  const tenant = (
    await input.pool.query<{ id: string }>(
      'select id from identity.tenants where tenant_key = $1 and active = true',
      [input.tenantKey],
    )
  ).rows[0];
  need(tenant, 'TENANT');
  const expectedCorrelation = input.expectedPlanSha256
    ? `legacy-roster-repair:${input.operationId}:${input.expectedPlanSha256}`
    : '';
  const row = await withTenantTransaction(
    input.pool,
    tenant.id,
    async (client) =>
      (
        await client.query<TargetRow>(
          `select g.id as game_id, g.revision, g.lifecycle_state, s.mode, s.conflict_code,
            s.last_synced_game_revision as sync_revision, s.source_external_version as sync_version,
            array(select m.external_id from integration.external_entity_map m
                   where m.tenant_id=g.tenant_id and m.internal_id=g.id
                     and m.external_system='LK_LEGACY_SNAPSHOT' and m.entity_type='game'
                   order by m.external_id) as source_aliases,
            (select coalesce(jsonb_agg(jsonb_build_array(p.id,p.user_id,p.role,p.state,p.payment_state)
                      order by p.id),'[]'::jsonb) from games.participations p
              where p.tenant_id=g.tenant_id and p.game_id=g.id) as participations,
            (select coalesce(jsonb_agg(jsonb_build_object('revision',(a.new_value->>'revision')::int,'playerMappingsSha256',a.new_value->>'playerMappingsSha256')),'[]'::jsonb)
               from audit.audit_log a where a.tenant_id=g.tenant_id and a.resource_id=g.id
                and a.action='GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT'
                and a.result='SUCCESS' and a.correlation_id=$3) as previous_audits
       from games.games g left join integration.legacy_game_roster_sync_state s
         on s.tenant_id=g.tenant_id and s.game_id=g.id
      where g.tenant_id=$1 and g.id=$2 and not exists (
        select 1 from integration.legacy_game_merge_redirects r
         where r.tenant_id=g.tenant_id and r.source_game_id=g.id)`,
          [tenant.id, input.gameId, expectedCorrelation],
        )
      ).rows[0],
  );
  need(row && row.game_id === input.gameId && row.lifecycle_state === 'SCHEDULED', 'TARGET');
  need(row.source_aliases.length > 0 && row.source_aliases.length <= 30, 'SOURCE_MAPPING');
  const snapshots = await input.source.readRosterByExternalIds({
    externalIds: row.source_aliases,
    limit: 1,
  });
  need(snapshots.length === 1, 'SOURCE_CARDINALITY');
  const snapshot = snapshots[0]!;
  need(
    [snapshot.externalId, ...(snapshot.externalAliases ?? [])].some((id) =>
      row.source_aliases.includes(id),
    ),
    'SOURCE_MAPPING',
  );
  need(
    !snapshot.cancelled &&
      snapshot.participants.length > 0 &&
      snapshot.participants.length <= snapshot.capacity,
    'SOURCE_ROSTER',
  );
  need(HASH.test(snapshot.externalVersion), 'SOURCE_VERSION');
  const playerAliases = [
    ...new Set(snapshot.participants.flatMap((p) => [p.externalId, ...(p.externalAliases ?? [])])),
  ].sort();
  const mappings = await withTenantTransaction(
    input.pool,
    tenant.id,
    async (client) =>
      (
        await client.query<LegacyGameExactPlayerMapping & QueryResultRow>(
          `select external_id,internal_id,sync_status,sync_error_code from integration.external_entity_map
      where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player'
        and external_id=any($2::text[]) order by external_id`,
          [tenant.id, playerAliases],
        )
      ).rows,
  );
  const identity = attestExactRosterPlayerMappings(snapshot, mappings);
  // Stable operation/correlation evidence permits a lost-ACK readback without reapplying.
  if (row.previous_audits.length > 0) {
    need(
      row.previous_audits.length === 1 &&
        row.mode === 'MIRROR' &&
        row.conflict_code === null &&
        Number(row.revision) === row.previous_audits[0]!.revision &&
        Number(row.sync_revision) === Number(row.revision) &&
        row.sync_version === snapshot.externalVersion &&
        row.previous_audits[0]!.playerMappingsSha256 === identity.sha256,
      'PREVIOUS_OUTCOME_DRIFT',
    );
    return {
      schema: 'PHUB_EXACT_LEGACY_ROSTER_REPAIR_V1',
      status: 'ALREADY_REPAIRED',
      gameId: input.gameId,
      operationId: input.operationId,
      planSha256: input.expectedPlanSha256!,
      sourceParticipants: snapshot.participants.length,
      allowLocalRemovals: false,
      authorizesDeploy: false,
    };
  }
  need(
    row.mode === 'CONFLICT' &&
      row.conflict_code === 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH' &&
      Number(row.sync_revision) === Number(row.revision),
    'QUARANTINE',
  );
  const planSha256 = digest({
    schema: 1,
    tenantId: tenant.id,
    gameId: input.gameId,
    operationId: input.operationId,
    revision: Number(row.revision),
    syncVersion: row.sync_version,
    participations: row.participations,
    sourceVersion: snapshot.externalVersion,
    playerMappingsSha256: identity.sha256,
    sourceSnapshot: digest(snapshot),
  });
  const base = {
    schema: 'PHUB_EXACT_LEGACY_ROSTER_REPAIR_V1' as const,
    gameId: input.gameId,
    operationId: input.operationId,
    planSha256,
    sourceParticipants: snapshot.participants.length,
    allowLocalRemovals: false as const,
    authorizesDeploy: false as const,
  };
  if (input.planOnly) return { ...base, status: 'PLAN' };
  need(input.expectedPlanSha256 === planSha256, 'PLAN_DRIFT');
  const result = await input.repository.rebaselineParticipants({
    tenantKey: input.tenantKey,
    snapshots,
    correlationId: `legacy-roster-repair:${input.operationId}:${planSha256}`,
    allowLocalRemovals: false,
    expected: {
      gameId: input.gameId,
      revision: Number(row.revision),
      sourceVersion: snapshot.externalVersion,
      syncSourceVersion: row.sync_version!,
      playerMappingsSha256: identity.sha256,
    },
    now: input.now ?? new Date(),
  });
  need(
    result.skipped === 0 &&
      result.rebaselined.length + result.deferred.length === 1 &&
      [...result.rebaselined, ...result.deferred].every((item) => item.gameId === input.gameId),
    'RESULT',
  );
  return { ...base, status: result.rebaselined.length === 1 ? 'REPAIRED' : 'DEFERRED' };
}
