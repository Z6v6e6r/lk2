import type { GameLifecycleState } from '@phub/games';
import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';
import type { LegacyGameImportSnapshot } from './legacy-game-import-repository.js';

const LEGACY_EXTERNAL_SYSTEM = 'LK_LEGACY_SNAPSHOT';

export type LegacyGameReconciliationReason =
  | 'CANONICAL_GAME_MISSING'
  | 'CAPACITY_MISMATCH'
  | 'TIME_MISMATCH'
  | 'LIFECYCLE_MISMATCH'
  | 'ACTIVE_ROSTER_COUNT_MISMATCH'
  | 'VIVA_EXERCISE_ASSOCIATION_MISSING';

export interface LegacyGameReconciliationIssue {
  /** PadlHub UUID only. A missing source mapping intentionally has no external identifier here. */
  readonly gameId?: string;
  readonly reasons: readonly LegacyGameReconciliationReason[];
}

export interface LegacyGameReconciliationResult {
  readonly tenantId: string;
  readonly compared: number;
  readonly matched: number;
  readonly missing: number;
  readonly discrepancies: readonly LegacyGameReconciliationIssue[];
}

export interface LegacyGameReconciliationRepository {
  reconcileSnapshots(input: {
    readonly tenantKey: string;
    readonly snapshots: readonly LegacyGameImportSnapshot[];
    readonly now?: Date;
  }): Promise<LegacyGameReconciliationResult>;
}

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface ReconciliationRow extends QueryResultRow {
  readonly external_id: string;
  readonly game_id: string;
  readonly capacity: number;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
  readonly lifecycle_state: GameLifecycleState;
  readonly active_participant_count: number | string;
  readonly viva_exercise_external_ids: readonly string[] | null;
}

function expectedLifecycle(snapshot: LegacyGameImportSnapshot, now: Date): GameLifecycleState {
  if (snapshot.cancelled) return 'CANCELLED';
  if (Date.parse(snapshot.endsAt) <= now.getTime()) return 'FINISHED';
  if (Date.parse(snapshot.startsAt) <= now.getTime()) return 'IN_PROGRESS';
  return 'SCHEDULED';
}

function sameInstant(left: Date | string, right: string): boolean {
  return Date.parse(left instanceof Date ? left.toISOString() : left) === Date.parse(right);
}

export function createLegacyGameReconciliationRepository(
  pool: Pool,
): LegacyGameReconciliationRepository {
  return {
    async reconcileSnapshots(input) {
      const tenant = (
        await pool.query<TenantRow>(
          `select id from identity.tenants where tenant_key = $1 and active = true`,
          [input.tenantKey],
        )
      ).rows[0];
      if (!tenant) throw new Error('LEGACY_GAME_RECONCILIATION_TENANT_NOT_FOUND');

      const snapshots = new Map<string, LegacyGameImportSnapshot>();
      for (const snapshot of input.snapshots) {
        if (snapshots.has(snapshot.externalId)) {
          throw new Error('LEGACY_GAME_RECONCILIATION_SOURCE_DUPLICATE');
        }
        snapshots.set(snapshot.externalId, snapshot);
      }
      if (snapshots.size === 0) {
        return { tenantId: tenant.id, compared: 0, matched: 0, missing: 0, discrepancies: [] };
      }

      return withTenantTransaction(pool, tenant.id, async (client) => {
        const rows = await client.query<ReconciliationRow>(
          `select legacy.external_id, legacy.internal_id as game_id,
                  game.capacity, game.starts_at, game.ends_at, game.lifecycle_state,
                  count(distinct participation.user_id)::integer as active_participant_count,
                  array_remove(array_agg(distinct viva.external_id), null) as viva_exercise_external_ids
             from integration.external_entity_map legacy
             join games.games game
               on game.tenant_id = legacy.tenant_id and game.id = legacy.internal_id
             left join games.participations participation
               on participation.tenant_id = game.tenant_id
              and participation.game_id = game.id
              and participation.state = 'ACTIVE'
             left join integration.external_entity_map viva
               on viva.tenant_id = game.tenant_id
              and viva.internal_id = game.id
              and viva.external_system = 'VIVA'
              and viva.entity_type = 'exercise'
            where legacy.tenant_id = $1
              and legacy.external_system = $2
              and legacy.entity_type = 'game'
              and legacy.external_id = any($3::text[])
            group by legacy.external_id, legacy.internal_id, game.capacity, game.starts_at,
                     game.ends_at, game.lifecycle_state`,
          [tenant.id, LEGACY_EXTERNAL_SYSTEM, [...snapshots.keys()]],
        );
        const byExternalId = new Map(rows.rows.map((row) => [row.external_id, row]));
        const discrepancies: LegacyGameReconciliationIssue[] = [];
        const now = input.now ?? new Date();

        for (const [externalId, snapshot] of snapshots) {
          const row = byExternalId.get(externalId);
          if (!row) {
            discrepancies.push({ reasons: ['CANONICAL_GAME_MISSING'] });
            continue;
          }
          const reasons: LegacyGameReconciliationReason[] = [];
          if (row.capacity !== snapshot.capacity) reasons.push('CAPACITY_MISMATCH');
          if (
            !sameInstant(row.starts_at, snapshot.startsAt) ||
            !sameInstant(row.ends_at, snapshot.endsAt)
          ) {
            reasons.push('TIME_MISMATCH');
          }
          if (row.lifecycle_state !== expectedLifecycle(snapshot, now)) {
            reasons.push('LIFECYCLE_MISMATCH');
          }
          if (Number(row.active_participant_count) !== snapshot.participants.length) {
            reasons.push('ACTIVE_ROSTER_COUNT_MISMATCH');
          }
          if (
            snapshot.vivaExerciseExternalId &&
            !row.viva_exercise_external_ids?.includes(snapshot.vivaExerciseExternalId)
          ) {
            reasons.push('VIVA_EXERCISE_ASSOCIATION_MISSING');
          }
          if (reasons.length) discrepancies.push({ gameId: row.game_id, reasons });
        }

        return {
          tenantId: tenant.id,
          compared: snapshots.size,
          matched: snapshots.size - discrepancies.length,
          missing: discrepancies.filter((item) => item.reasons.includes('CANONICAL_GAME_MISSING'))
            .length,
          discrepancies,
        };
      });
    },
  };
}
