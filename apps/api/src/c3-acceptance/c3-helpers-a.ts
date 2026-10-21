/**
 * C3 acceptance helpers owned by scenario A (CREATE side) and the LK2 cross-channel case.
 *
 * TEST-ONLY, synthetic fixtures. Every row written here is marked `C3 SYNTHETIC` and belongs to a
 * freshly generated synthetic tenant from harness.ts. No product code is imported for writing; only
 * the same real tenant transaction wrapper the product uses. Evidence level: LOCAL.
 */
import { randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import type { Pool } from 'pg';

export const C3A_SYNTHETIC_MARKER = 'C3 SYNTHETIC';

export interface SyntheticStationInput {
  readonly tenantId: string;
  readonly createdByUserId: string;
  readonly label: string;
}

/**
 * Seeds a published synthetic location profile so a *free* CREATE control request can reach the
 * real GameRepository. A paid CREATE must be refused before any repository call, so this station is
 * only needed to prove that the request shape/authorization itself is valid.
 */
export async function seedSyntheticStation(
  pool: Pool,
  input: SyntheticStationInput,
): Promise<string> {
  const stationId = randomUUID();
  const slug = `c3-${input.label}-${stationId.slice(0, 8)}`.toLowerCase();
  await withTenantTransaction(pool, input.tenantId, async (client) => {
    await client.query(
      `insert into locations.profiles (
         tenant_id, id, slug, title, timezone, publication_status, published_at,
         created_by, updated_by
       ) values ($1, $2, $3, $4, 'Europe/Moscow', 'PUBLISHED', now(), $5, $5)`,
      [
        input.tenantId,
        stationId,
        slug,
        `${C3A_SYNTHETIC_MARKER} station ${input.label} ${stationId.slice(0, 8)}`,
        input.createdByUserId,
      ],
    );
  });
  return stationId;
}

export interface GameAggregateRow {
  readonly revision: number;
  readonly paymentMode: string;
  readonly lifecycleState: string;
  readonly capacity: number;
  readonly organizerUserId: string;
  readonly visibility: string;
}

/** Reads the real games.games row so revision arithmetic can be asserted, not guessed from HTTP. */
export async function readGameAggregate(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<GameAggregateRow | undefined> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      revision: string;
      payment_mode: string;
      lifecycle_state: string;
      capacity: number;
      organizer_user_id: string;
      visibility: string;
    }>(
      `select revision::text as revision, payment_mode, lifecycle_state, capacity,
              organizer_user_id, visibility
         from games.games
        where tenant_id = $1 and id = $2`,
      [input.tenantId, input.gameId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      revision: Number(row.revision),
      paymentMode: row.payment_mode,
      lifecycleState: row.lifecycle_state,
      capacity: row.capacity,
      organizerUserId: row.organizer_user_id,
      visibility: row.visibility,
    };
  });
}

/** Counts synthetic game rows for one tenant (optionally filtered by visibility). */
export async function countTenantGames(
  pool: Pool,
  input: { readonly tenantId: string; readonly visibility?: string },
): Promise<number> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count
         from games.games
        where tenant_id = $1
          and ($2::text is null or visibility = $2)`,
      [input.tenantId, input.visibility ?? null],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

/**
 * Counts audit rows that claim a successful business outcome. A fail-closed refusal may be audited,
 * but it must never be recorded as a success.
 */
export async function readAuditSuccessCount(pool: Pool, tenantId: string): Promise<number> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count
         from audit.audit_log
        where tenant_id = $1 and result = 'SUCCESS'`,
      [tenantId],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

export interface PaymentEvidenceRow {
  readonly id: string;
  readonly game_id: string;
  readonly reservation_id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly provider_operation_type: string;
  readonly provider_operation_id: string;
  readonly verified_by: string;
  readonly resolution: string;
  readonly error_code: string | null;
  readonly participation_id: string | null;
  readonly aggregate_revision: string | null;
}

/** Reads the trusted payment confirmations saved by the legacy owner channel. */
export async function readPaymentEvidenceRows(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<PaymentEvidenceRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<PaymentEvidenceRow>(
      `select id, game_id, reservation_id, user_id, provider, provider_operation_type,
              provider_operation_id, verified_by, resolution, error_code, participation_id,
              aggregate_revision::text as aggregate_revision
         from games.payment_confirmation_evidence
        where tenant_id = $1 and game_id = $2
        order by received_at, id`,
      [input.tenantId, input.gameId],
    );
    return result.rows;
  });
}
