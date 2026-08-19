import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';
import type { CanonicalLevelView } from './level-eligibility-policy-repository.js';

export interface PlayerSportLevelView {
  readonly playerId: string;
  readonly sportCode: string;
  readonly levelId: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number;
  readonly source: 'SELF_DECLARED' | 'ONBOARDING' | 'MANUAL' | 'CALCULATED' | 'VIVA' | 'MIGRATED';
  readonly numericValue: number | null;
  readonly scaleVersion: number;
  readonly updatedAt: string;
}

export interface PlayerLevelState {
  readonly sportCode: string;
  readonly scaleVersion: number | null;
  readonly levels: readonly CanonicalLevelView[];
  readonly currentLevel: PlayerSportLevelView | null;
}

export interface SetPlayerLevelInput {
  readonly tenantId: string;
  readonly playerId: string;
  readonly sportCode: string;
  readonly levelId: string;
  readonly source: 'SELF_DECLARED' | 'ONBOARDING';
  readonly numericValue?: number | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export type SetPlayerLevelResult =
  | {
      readonly outcome: 'applied';
      readonly level: PlayerSportLevelView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'cup_authoritative' }
  | { readonly outcome: 'level_not_found' }
  | { readonly outcome: 'profile_not_found' };

export interface PlayerLevelRepository {
  getState(tenantId: string, playerId: string, sportCode: string): Promise<PlayerLevelState>;
  setLevel(input: SetPlayerLevelInput): Promise<SetPlayerLevelResult>;
}

interface LevelRow extends QueryResultRow {
  readonly id: string;
  readonly sport_code: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number | string;
  readonly sort_order: number | string;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly scale_version: number | string;
}

interface PlayerLevelRow extends QueryResultRow {
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
  if (!Number.isSafeInteger(parsed)) throw new Error('PLAYER_LEVEL_INTEGER_INVALID');
  return parsed;
}

function levelView(row: LevelRow): CanonicalLevelView {
  return {
    id: row.id,
    sportCode: row.sport_code,
    code: row.code,
    title: row.title,
    rank: integer(row.rank),
    sortOrder: integer(row.sort_order),
    aliases: row.aliases,
    active: row.active,
    scaleVersion: integer(row.scale_version),
  };
}

function playerLevelView(row: PlayerLevelRow): PlayerSportLevelView {
  const numericValue = row.numeric_value === null ? null : Number(row.numeric_value);
  if (
    numericValue !== null &&
    (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 10)
  ) {
    throw new Error('PLAYER_LEVEL_NUMERIC_INVALID');
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

const PLAYER_LEVEL_COLUMNS = `player.player_id, player.sport_code, player.level_id,
  level.code, level.title, level.rank, player.source, player.scale_version,
  player.updated_at::text as updated_at, profile.level_value as numeric_value`;

export function createPlayerLevelRepository(pool: Pool): PlayerLevelRepository {
  return {
    getState(tenantId, playerId, sportCode) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const levels = await client.query<LevelRow>(
          `select id, sport_code, code, title, rank, sort_order, aliases, active, scale_version
             from eligibility.canonical_levels
            where tenant_id = $1 and sport_code = $2 and active
              and scale_version = (
                select max(scale_version) from eligibility.canonical_levels
                 where tenant_id = $1 and sport_code = $2 and active
              )
            order by sort_order, id`,
          [tenantId, sportCode],
        );
        const current = await queryOne<PlayerLevelRow>(
          client,
          `select ${PLAYER_LEVEL_COLUMNS}
             from eligibility.player_sport_levels player
             join eligibility.canonical_levels level
               on level.tenant_id = player.tenant_id
              and level.sport_code = player.sport_code
              and level.id = player.level_id
             join profile.user_summaries profile
               on profile.tenant_id = player.tenant_id and profile.user_id = player.player_id
            where player.tenant_id = $1 and player.player_id = $2 and player.sport_code = $3`,
          [tenantId, playerId, sportCode],
        );
        const views = levels.rows.map(levelView);
        return {
          sportCode,
          scaleVersion: views[0]?.scaleVersion ?? null,
          levels: views,
          currentLevel: current ? playerLevelView(current) : null,
        };
      });
    },

    setLevel(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (
          input.numericValue !== undefined &&
          input.numericValue !== null &&
          (!Number.isFinite(input.numericValue) ||
            input.numericValue < 0 ||
            input.numericValue > 10)
        ) {
          throw new Error('PLAYER_LEVEL_NUMERIC_INVALID');
        }
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `player-level:${input.tenantId}:${input.playerId}:${input.sportCode}`,
        ]);
        const cupProjection = await queryOne<QueryResultRow & { readonly present: number }>(
          client,
          `select 1 as present
             from eligibility.cup_player_level_projections
            where tenant_id = $1 and player_id = $2 and sport_code = $3
            for update`,
          [input.tenantId, input.playerId, input.sportCode],
        );
        if (cupProjection) return { outcome: 'cup_authoritative' };
        const replay = await queryOne<
          QueryResultRow & { readonly request_hash: string; readonly result_payload: unknown }
        >(
          client,
          `select request_hash, result_payload
             from eligibility.player_level_commands
            where tenant_id = $1 and player_id = $2 and idempotency_key = $3
            for update`,
          [input.tenantId, input.playerId, input.idempotencyKey],
        );
        if (replay) {
          if (replay.request_hash !== input.requestHash) return { outcome: 'idempotency_conflict' };
          return {
            outcome: 'applied',
            level: replay.result_payload as PlayerSportLevelView,
            replayed: true,
          };
        }

        const level = await queryOne<LevelRow>(
          client,
          `select id, sport_code, code, title, rank, sort_order, aliases, active, scale_version
             from eligibility.canonical_levels
            where tenant_id = $1 and sport_code = $2 and id = $3 and active
              and scale_version = (
                select max(scale_version) from eligibility.canonical_levels
                 where tenant_id = $1 and sport_code = $2 and active
              )
            for update`,
          [input.tenantId, input.sportCode, input.levelId],
        );
        if (!level) return { outcome: 'level_not_found' };

        const previous = await queryOne<PlayerLevelRow>(
          client,
          `select ${PLAYER_LEVEL_COLUMNS}
             from eligibility.player_sport_levels player
             join eligibility.canonical_levels level
               on level.tenant_id = player.tenant_id
              and level.sport_code = player.sport_code
              and level.id = player.level_id
             join profile.user_summaries profile
               on profile.tenant_id = player.tenant_id and profile.user_id = player.player_id
            where player.tenant_id = $1 and player.player_id = $2 and player.sport_code = $3
            for update of player`,
          [input.tenantId, input.playerId, input.sportCode],
        );
        const profile = await client.query(
          `update profile.user_summaries
              set level_label = $3, level_value = $4, updated_at = now()
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.playerId, level.code, input.numericValue ?? null],
        );
        if ((profile.rowCount ?? 0) !== 1) return { outcome: 'profile_not_found' };

        const saved = await queryOne<PlayerLevelRow>(
          client,
          `insert into eligibility.player_sport_levels (
             tenant_id, player_id, sport_code, level_id, source, scale_version, updated_at
           ) values ($1, $2, $3, $4, $5, $6, now())
           on conflict (tenant_id, player_id, sport_code) do update set
             level_id = excluded.level_id,
             source = excluded.source,
             scale_version = excluded.scale_version,
             updated_at = now()
           returning player_id, sport_code, level_id, $7::text as code, $8::text as title,
                     $9::integer as rank, source, scale_version, updated_at::text as updated_at,
                     $10::numeric as numeric_value`,
          [
            input.tenantId,
            input.playerId,
            input.sportCode,
            level.id,
            input.source,
            integer(level.scale_version),
            level.code,
            level.title,
            integer(level.rank),
            input.numericValue ?? null,
          ],
        );
        if (!saved) throw new Error('PLAYER_LEVEL_WRITE_LOST');
        const view = playerLevelView(saved);
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, old_value, new_value
           ) values ($1, $2, 'PLAYER_LEVEL_UPDATED', 'PROFILE', $2,
                     'SUCCESS', $3, $4::jsonb, $5::jsonb)`,
          [
            input.tenantId,
            input.playerId,
            input.correlationId,
            JSON.stringify(previous ? playerLevelView(previous) : null),
            JSON.stringify(view),
          ],
        );
        await client.query(
          `insert into eligibility.player_level_commands (
             tenant_id, player_id, idempotency_key, request_hash, result_payload
           ) values ($1, $2, $3, $4, $5::jsonb)`,
          [
            input.tenantId,
            input.playerId,
            input.idempotencyKey,
            input.requestHash,
            JSON.stringify(view),
          ],
        );
        return { outcome: 'applied', level: view, replayed: false };
      });
    },
  };
}
