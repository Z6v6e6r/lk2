import type { Pool } from 'pg';
import { withTenantTransaction } from './connection.js';

export interface BookedOperationAdmissionTargetRepository {
  resolve(input: { tenantId: string; targetId: string; expectedRevision: number }): Promise<{
    providerExerciseId: string;
    targetMappingId: string;
    targetVersion: string;
    startsAt: string;
    durationMinutes: number;
    capacity: number;
    admissible: boolean;
  } | null>;
}
// Current lifecycle/revision eligibility is a signed initial-admission condition.
// A valid existing receipt is recovered before that condition is applied by its sole owner.
// Reverse only a previously synced, versioned server mapping. Never establish one from a request.
export function createBookedOperationAdmissionTargetRepository(
  pool: Pool,
): BookedOperationAdmissionTargetRepository {
  return {
    resolve: (input) =>
      withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query("set local statement_timeout = '1500ms'");
        const result = await client.query<{
          external_id: string;
          id: string;
          external_version: string;
          starts_at: Date;
          duration_minutes: number;
          capacity: number;
          admissible: boolean;
        }>(
          `select mapping.id, mapping.external_id, mapping.external_version, game.starts_at,
         extract(epoch from (game.ends_at-game.starts_at))/60 as duration_minutes, game.capacity,
         (game.revision=$3 and game.lifecycle_state='SCHEDULED' and game.visibility='PUBLIC'
          and game.payment_mode in ('SPLIT','SUBSCRIPTION') and game.capacity=4 and game.starts_at>now()
          and (game.join_cutoff_at is null or game.join_cutoff_at>now())) as admissible
       from integration.external_entity_map mapping join games.games game
         on game.tenant_id=mapping.tenant_id and game.id=mapping.internal_id
       where mapping.tenant_id=$1 and mapping.internal_id=$2 and mapping.external_system='VIVA' and mapping.entity_type='exercise'
         and mapping.sync_status='synced' and mapping.sync_error_code is null and mapping.last_synced_at is not null
         and mapping.external_version is not null and mapping.external_version<>''`,
          [input.tenantId, input.targetId, input.expectedRevision],
        );
        const row = result.rows.length === 1 ? result.rows[0] : undefined;
        return row &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(row.external_id) &&
          Number.isSafeInteger(Number(row.duration_minutes)) &&
          Number(row.duration_minutes) > 0
          ? {
              providerExerciseId: row.external_id,
              targetMappingId: row.id,
              targetVersion: row.external_version,
              startsAt: row.starts_at.toISOString(),
              durationMinutes: Number(row.duration_minutes),
              capacity: row.capacity,
              admissible: row.admissible,
            }
          : null;
      }),
  };
}
