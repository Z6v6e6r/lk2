import type { Pool } from 'pg';
import { withTenantTransaction } from './connection.js';

export type BookedOperationAdmissionAction = 'JOIN_GAME' | 'CREATE_GAME';

/** Canonical JOIN target. The provider exercise mapping is the stable identity of a JOIN. */
export interface BookedOperationAdmissionJoinTarget {
  providerExerciseId: string;
  targetMappingId: string;
  targetVersion: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  admissible: boolean;
}

/**
 * LK2 draft game eligible for a CREATE admission. A draft is local-primary and has no provider
 * exercise yet, so it exposes no provider fields: the Viva exercise does not exist before the LK1
 * reserve/confirm approval.
 */
export interface BookedOperationCreateDraftTarget {
  draftGameId: string;
  expectedRevision: number;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  paymentMode: 'SPLIT' | 'SUBSCRIPTION';
  admissible: boolean;
}

export interface BookedOperationAdmissionResolveInput {
  tenantId: string;
  targetId: string;
  expectedRevision: number;
  /**
   * Defaults to JOIN_GAME. CREATE_GAME drafts are resolved only through `resolveCreateDraft`; this
   * JOIN-mapping resolver fails closed for them so a provider mapping is never reused for a draft.
   */
  action?: BookedOperationAdmissionAction;
  /** Authenticated LK2 actor. JOIN admissibility does not depend on it; CREATE authorization does. */
  actorUserId?: string;
}

export interface BookedOperationAdmissionCreateDraftResolveInput {
  tenantId: string;
  targetId: string;
  expectedRevision: number;
  action?: 'CREATE_GAME';
  /** Authenticated LK2 actor; the draft must be organized by this user in this tenant. */
  actorUserId: string;
}

export interface BookedOperationAdmissionTargetRepository {
  resolve(
    input: BookedOperationAdmissionResolveInput,
  ): Promise<BookedOperationAdmissionJoinTarget | null>;
}

export interface BookedOperationCreateAdmissionTargetRepository extends BookedOperationAdmissionTargetRepository {
  /**
   * Resolves an LK2 draft game for a CREATE admission, scoped to the authenticated organizer.
   * Fails closed (null) when any identity, authorization or eligibility condition is absent.
   */
  resolveCreateDraft(
    input: BookedOperationAdmissionCreateDraftResolveInput,
  ): Promise<BookedOperationCreateDraftTarget | null>;
}

// Current lifecycle/revision eligibility is a signed initial-admission condition.
// A valid existing receipt is recovered before that condition is applied by its sole owner.
// Reverse only a previously synced, versioned server mapping. Never establish one from a request.
export function createBookedOperationAdmissionTargetRepository(
  pool: Pool,
): BookedOperationCreateAdmissionTargetRepository {
  return {
    resolve: (input) => {
      // A CREATE draft is games.games-only and has no provider exercise: never let the JOIN mapping
      // path answer a CREATE admission.
      if (input.action === 'CREATE_GAME') return Promise.resolve(null);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
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
      });
    },
    // LK2 drafts are LOCAL_PRIMARY: one tenant-scoped read of games.games only. There is no provider
    // mapping to reverse for a draft and no migration is added for this contract.
    resolveCreateDraft: (input) =>
      withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query("set local statement_timeout = '1500ms'");
        const result = await client.query<{
          id: string;
          revision: string;
          starts_at: Date;
          duration_minutes: string;
          capacity: number;
          payment_mode: string;
          admissible: boolean;
        }>(
          `select game.id, game.revision, game.starts_at,
         extract(epoch from (game.ends_at-game.starts_at))/60 as duration_minutes, game.capacity,
         game.payment_mode,
         (game.revision=$3 and game.lifecycle_state='PROVISIONING'
          and game.payment_mode in ('SPLIT','SUBSCRIPTION') and game.capacity=4 and game.starts_at>now()
          and game.cancelled_at is null) as admissible
       from games.games game
       where game.tenant_id=$1 and game.id=$2 and game.organizer_user_id=$4
         and game.revision=$3 and game.lifecycle_state='PROVISIONING'
         and game.payment_mode in ('SPLIT','SUBSCRIPTION') and game.capacity=4
         and game.starts_at>now() and game.cancelled_at is null`,
          [input.tenantId, input.targetId, input.expectedRevision, input.actorUserId],
        );
        const row = result.rows.length === 1 ? result.rows[0] : undefined;
        const paymentMode = row?.payment_mode;
        return row &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            row.id,
          ) &&
          Number.isSafeInteger(Number(row.revision)) &&
          Number(row.revision) >= 1 &&
          Number(row.capacity) === 4 &&
          (paymentMode === 'SPLIT' || paymentMode === 'SUBSCRIPTION') &&
          Number.isSafeInteger(Number(row.duration_minutes)) &&
          Number(row.duration_minutes) > 0 &&
          row.starts_at instanceof Date &&
          Number.isFinite(row.starts_at.getTime()) &&
          row.admissible === true
          ? {
              draftGameId: row.id,
              expectedRevision: Number(row.revision),
              startsAt: row.starts_at.toISOString(),
              durationMinutes: Number(row.duration_minutes),
              capacity: row.capacity,
              paymentMode,
              admissible: row.admissible,
            }
          : null;
      }),
  };
}
