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
    const written = await client.query<{ id: string }>(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id,
         external_version, last_synced_at, sync_status, sync_error_code
       ) values ($1, 'VIVA', 'legacy_viewer_phone', $2, $3, null, $4::timestamptz, 'synced', null)
       on conflict (tenant_id, external_system, entity_type, internal_id)
       do update set external_id = excluded.external_id,
                     last_synced_at = excluded.last_synced_at,
                     sync_status = 'synced',
                     sync_error_code = null
       where integration.external_entity_map.external_id is distinct from excluded.external_id
       returning id`,
      [input.tenantId, input.userId, input.phoneE164, input.fetchedAt],
    );
    if (written.rows.length > 0) return 'linked';
    const existing = await client.query<{ external_id: string }>(
      `select external_id
         from integration.external_entity_map
        where tenant_id = $1
          and external_system = 'VIVA'
          and entity_type = 'legacy_viewer_phone'
          and internal_id = $2`,
      [input.tenantId, input.userId],
    );
    return existing.rows[0]?.external_id === input.phoneE164 ? 'unchanged' : 'conflict';
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
