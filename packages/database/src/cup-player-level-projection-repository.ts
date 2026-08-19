import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';
import type { PlayerSportLevelView } from './player-level-repository.js';

export interface ApplyCupPlayerLevelProjectionInput {
  readonly tenantId: string;
  readonly externalClientId: string;
  readonly sportCode: string;
  readonly levelCode: string;
  readonly numericValue: number;
  readonly sourceRevision: number;
  readonly sourceEventId: string;
  readonly sourceEventType:
    | 'RATING_INITIAL_IMPORTED'
    | 'RATING_BOOTSTRAPPED_FROM_VIVA'
    | 'RATING_MANUALLY_CHANGED';
  readonly formulaVersion: 'padel-rating-grade-v1';
  readonly occurredAt: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export type ApplyCupPlayerLevelProjectionResult =
  | { readonly outcome: 'applied'; readonly level: PlayerSportLevelView; readonly replayed: false }
  | { readonly outcome: 'replayed'; readonly level: PlayerSportLevelView; readonly replayed: true }
  | { readonly outcome: 'stale'; readonly currentRevision: number }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_mapped' }
  | { readonly outcome: 'level_not_found' }
  | { readonly outcome: 'profile_not_found' };

export interface CupPlayerLevelProjectionRepository {
  apply(input: ApplyCupPlayerLevelProjectionInput): Promise<ApplyCupPlayerLevelProjectionResult>;
}

interface ProjectionRow extends QueryResultRow {
  readonly source_revision: number | string;
  readonly source_event_id: string;
  readonly request_hash: string;
  readonly player_id: string;
  readonly level_id: string;
}

interface ActorMappingRow extends QueryResultRow {
  readonly mapping_id: string;
  readonly player_id: string;
}

interface LevelRow extends QueryResultRow {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number | string;
  readonly scale_version: number | string;
}

interface SavedLevelRow extends QueryResultRow {
  readonly player_id: string;
  readonly sport_code: string;
  readonly level_id: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number | string;
  readonly source: PlayerSportLevelView['source'];
  readonly numeric_value: number | string | null;
  readonly scale_version: number | string;
  readonly updated_at: string;
}

function integer(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('CUP_LEVEL_PROJECTION_INTEGER_INVALID');
  return parsed;
}

function view(row: SavedLevelRow): PlayerSportLevelView {
  const numericValue = row.numeric_value === null ? null : Number(row.numeric_value);
  if (numericValue !== null && !Number.isFinite(numericValue)) {
    throw new Error('CUP_LEVEL_PROJECTION_NUMERIC_INVALID');
  }
  return {
    playerId: row.player_id,
    sportCode: row.sport_code,
    levelId: row.level_id,
    code: row.code,
    title: row.title,
    rank: integer(row.rank),
    source: row.source,
    numericValue,
    scaleVersion: integer(row.scale_version),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function projectionSource(
  eventType: ApplyCupPlayerLevelProjectionInput['sourceEventType'],
): PlayerSportLevelView['source'] {
  switch (eventType) {
    case 'RATING_INITIAL_IMPORTED':
      return 'MIGRATED';
    case 'RATING_BOOTSTRAPPED_FROM_VIVA':
      return 'VIVA';
    case 'RATING_MANUALLY_CHANGED':
      return 'MANUAL';
    default:
      throw new Error('CUP_LEVEL_PROJECTION_EVENT_TYPE_UNSUPPORTED');
  }
}

export function createCupPlayerLevelProjectionRepository(
  pool: Pool,
): CupPlayerLevelProjectionRepository {
  return {
    apply(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `cup-level-event:${input.tenantId}:${input.sourceEventId}`,
        ]);
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `cup-level:${input.tenantId}:${input.externalClientId}:${input.sportCode}`,
        ]);

        const actor = await queryOne<ActorMappingRow>(
          client,
          `select mapping.id as mapping_id, mapping.internal_id as player_id
             from integration.external_entity_map mapping
             join identity.users actor
               on actor.tenant_id = mapping.tenant_id and actor.id = mapping.internal_id
            where mapping.tenant_id = $1
              and mapping.external_system = 'VIVA'
              and mapping.entity_type = 'viva_profile'
              and mapping.external_id = $2
              and actor.status = 'ACTIVE'
            for update of mapping, actor`,
          [input.tenantId, input.externalClientId],
        );
        if (!actor) return { outcome: 'actor_not_mapped' };
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `player-level:${input.tenantId}:${actor.player_id}:${input.sportCode}`,
        ]);

        const current = await queryOne<ProjectionRow>(
          client,
          `select source_revision, source_event_id, request_hash, player_id, level_id
             from eligibility.cup_player_level_projections
            where tenant_id = $1 and player_id = $2 and sport_code = $3
            for update`,
          [input.tenantId, actor.player_id, input.sportCode],
        );
        if (current) {
          const revision = integer(current.source_revision);
          if (input.sourceRevision === revision) {
            if (
              current.source_event_id !== input.sourceEventId ||
              current.request_hash !== input.requestHash
            ) {
              return { outcome: 'idempotency_conflict' };
            }
            const replay = await loadLevelView(client, input, current.player_id, current.level_id);
            if (!replay) return { outcome: 'profile_not_found' };
            return { outcome: 'replayed', level: replay, replayed: true };
          }
        }

        const reusedEvent = await queryOne<
          QueryResultRow & {
            readonly player_id: string;
            readonly sport_code: string;
            readonly source_revision: number | string;
            readonly request_hash: string;
          }
        >(
          client,
          `select player_id, sport_code, source_revision, request_hash
             from eligibility.cup_player_level_projection_events
            where tenant_id = $1 and source_event_id = $2
            for update`,
          [input.tenantId, input.sourceEventId],
        );
        if (
          reusedEvent &&
          (reusedEvent.player_id !== actor.player_id ||
            reusedEvent.sport_code !== input.sportCode ||
            integer(reusedEvent.source_revision) !== input.sourceRevision ||
            reusedEvent.request_hash !== input.requestHash)
        ) {
          return { outcome: 'idempotency_conflict' };
        }
        if (reusedEvent) {
          return current && integer(current.source_revision) > input.sourceRevision
            ? { outcome: 'stale', currentRevision: integer(current.source_revision) }
            : { outcome: 'idempotency_conflict' };
        }
        if (current && input.sourceRevision < integer(current.source_revision)) {
          return { outcome: 'stale', currentRevision: integer(current.source_revision) };
        }

        const level = await queryOne<LevelRow>(
          client,
          `select id, code, title, rank, scale_version
             from eligibility.canonical_levels
            where tenant_id = $1 and sport_code = $2 and code = $3 and active
              and scale_version = (
                select max(scale_version) from eligibility.canonical_levels
                 where tenant_id = $1 and sport_code = $2 and active
              )
            for update`,
          [input.tenantId, input.sportCode, input.levelCode],
        );
        if (!level) return { outcome: 'level_not_found' };

        const profile = await client.query(
          `update profile.user_summaries
              set level_label = $3, level_value = $4, updated_at = $5::timestamptz
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, actor.player_id, level.code, input.numericValue, input.occurredAt],
        );
        if ((profile.rowCount ?? 0) !== 1) return { outcome: 'profile_not_found' };

        const source = projectionSource(input.sourceEventType);
        const saved = await queryOne<SavedLevelRow>(
          client,
          `insert into eligibility.player_sport_levels (
             tenant_id, player_id, sport_code, level_id, source, scale_version, updated_at
           ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz)
           on conflict (tenant_id, player_id, sport_code) do update set
             level_id = excluded.level_id,
             source = excluded.source,
             scale_version = excluded.scale_version,
             updated_at = excluded.updated_at
           returning player_id, sport_code, level_id, $8::text as code, $9::text as title,
                     $10::integer as rank, source, scale_version, updated_at::text as updated_at,
                     $11::numeric as numeric_value`,
          [
            input.tenantId,
            actor.player_id,
            input.sportCode,
            level.id,
            source,
            integer(level.scale_version),
            input.occurredAt,
            level.code,
            level.title,
            integer(level.rank),
            input.numericValue,
          ],
        );
        if (!saved) throw new Error('CUP_LEVEL_PROJECTION_WRITE_LOST');
        const savedView = view(saved);

        await client.query(
          `insert into eligibility.cup_player_level_projections (
             tenant_id, player_id, sport_code, external_mapping_id, source_revision,
             source_event_id, request_hash, level_id, source_event_type, formula_version,
             occurred_at, applied_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, now())
           on conflict (tenant_id, player_id, sport_code) do update set
             external_mapping_id = excluded.external_mapping_id,
             source_revision = excluded.source_revision,
             source_event_id = excluded.source_event_id,
             request_hash = excluded.request_hash,
             level_id = excluded.level_id,
             source_event_type = excluded.source_event_type,
             formula_version = excluded.formula_version,
             occurred_at = excluded.occurred_at,
             applied_at = now()`,
          [
            input.tenantId,
            actor.player_id,
            input.sportCode,
            actor.mapping_id,
            input.sourceRevision,
            input.sourceEventId,
            input.requestHash,
            level.id,
            input.sourceEventType,
            input.formulaVersion,
            input.occurredAt,
          ],
        );
        await client.query(
          `insert into eligibility.cup_player_level_projection_events (
             tenant_id, source_event_id, player_id, sport_code, source_revision,
             request_hash, applied_at
           ) values ($1, $2, $3, $4, $5, $6, now())`,
          [
            input.tenantId,
            input.sourceEventId,
            actor.player_id,
            input.sportCode,
            input.sourceRevision,
            input.requestHash,
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, reason, correlation_id, new_value
           ) values ($1, null, 'CUP_PLAYER_LEVEL_PROJECTED', 'PROFILE', $2,
                     'SUCCESS', $3, $4, $5::jsonb)`,
          [
            input.tenantId,
            actor.player_id,
            input.sourceEventId,
            input.correlationId,
            JSON.stringify(savedView),
          ],
        );
        return { outcome: 'applied', level: savedView, replayed: false };
      });
    },
  };
}

async function loadLevelView(
  client: PoolClient,
  input: ApplyCupPlayerLevelProjectionInput,
  playerId: string,
  levelId: string,
): Promise<PlayerSportLevelView | undefined> {
  const row = await queryOne<SavedLevelRow>(
    client,
    `select player.player_id, player.sport_code, player.level_id,
            level.code, level.title, level.rank, player.source, player.scale_version,
            player.updated_at::text as updated_at, profile.level_value as numeric_value
       from eligibility.player_sport_levels player
       join eligibility.canonical_levels level
         on level.tenant_id = player.tenant_id
        and level.sport_code = player.sport_code and level.id = player.level_id
       join profile.user_summaries profile
         on profile.tenant_id = player.tenant_id and profile.user_id = player.player_id
      where player.tenant_id = $1 and player.player_id = $2
        and player.sport_code = $3 and player.level_id = $4`,
    [input.tenantId, playerId, input.sportCode, levelId],
  );
  return row ? view(row) : undefined;
}
