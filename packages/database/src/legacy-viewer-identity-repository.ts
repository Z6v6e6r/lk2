import type { Pool } from 'pg';

import { withTenantTransaction } from './connection.js';

export type LegacyViewerPhoneLinkOutcome = 'linked' | 'unchanged' | 'conflict' | 'absent';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

/**
 * Records the provider-asserted phone that keys every viewer-scoped legacy (CUP) read. The value stays
 * in integration custody: `profile.user_summaries.phone_e164` keeps meaning "verified phone login" and
 * is never written from the provider profile, so authentication, the payment actor guard and the legacy
 * engagement sink keep their existing semantics.
 *
 * `integration.external_entity_map` is unique on (tenant_id, external_system, entity_type, external_id),
 * so a phone already claimed by another PadlHub user fails closed: the link is skipped instead of
 * granting one account another person's legacy viewer identity. A provider-owned value may be refreshed
 * or replaced later by the same user, which keeps a wrong CRM number correctable.
 *
 * The write cannot use `on conflict`: migration 0042 replaced the table-level unique constraint on
 * `(tenant_id, external_system, entity_type, internal_id)` with the partial unique index
 * `external_entity_map_canonical_internal_idx`, and PostgreSQL refuses an `on conflict` target that no
 * non-partial constraint or matching partial index supports (`42P10`). The decision is therefore made
 * explicitly on the current row, and the two live unique guarantees keep it safe: a concurrent insert
 * for the same user or a phone owned by somebody else fails as a unique violation, which stays a
 * conflict and never rewrites the other account.
 */
export function linkLegacyViewerPhone(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  readonly phoneE164: string | undefined;
  readonly fetchedAt: string;
}): Promise<LegacyViewerPhoneLinkOutcome> {
  if (!input.phoneE164) return Promise.resolve('absent');
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const owner = await client.query<{ internal_id: string }>(
      `select internal_id
         from integration.external_entity_map
        where tenant_id = $1
          and external_system = 'VIVA'
          and entity_type = 'legacy_viewer_phone'
          and external_id = $2
        limit 1`,
      [input.tenantId, input.phoneE164],
    );
    if (owner.rows[0] && owner.rows[0].internal_id !== input.userId) return 'conflict';

    const current = await client.query<{ id: string; external_id: string }>(
      `select id, external_id
         from integration.external_entity_map
        where tenant_id = $1
          and external_system = 'VIVA'
          and entity_type = 'legacy_viewer_phone'
          and internal_id = $2
        order by last_synced_at desc nulls last, id
        limit 1`,
      [input.tenantId, input.userId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query(
        `insert into integration.external_entity_map (
           tenant_id, external_system, entity_type, internal_id, external_id,
           external_version, last_synced_at, sync_status, sync_error_code
         ) values ($1, 'VIVA', 'legacy_viewer_phone', $2, $3, null, $4::timestamptz, 'synced', null)`,
        [input.tenantId, input.userId, input.phoneE164, input.fetchedAt],
      );
      return 'linked';
    }
    await client.query(
      `update integration.external_entity_map
          set external_id = $3,
              last_synced_at = $4::timestamptz,
              sync_status = 'synced',
              sync_error_code = null
        where tenant_id = $1 and id = $2`,
      [input.tenantId, row.id, input.phoneE164, input.fetchedAt],
    );
    return row.external_id === input.phoneE164 ? 'unchanged' : 'linked';
  }).catch((error: unknown) => {
    // Another user already owns this phone in the same tenant: keep both accounts untouched.
    if (isUniqueViolation(error)) return 'conflict' as const;
    throw error;
  });
}

/**
 * Reads the provider-asserted legacy viewer phone so an authenticated request can skip a redundant
 * provider profile read when the link already exists.
 */
export function readLegacyViewerPhone(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
}): Promise<string | undefined> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const row = (
      await client.query<{ external_id: string }>(
        `select external_id
           from integration.external_entity_map
          where tenant_id = $1
            and external_system = 'VIVA'
            and entity_type = 'legacy_viewer_phone'
            and internal_id = $2
          order by last_synced_at desc nulls last, id
          limit 1`,
        [input.tenantId, input.userId],
      )
    ).rows[0];
    return row?.external_id;
  });
}
