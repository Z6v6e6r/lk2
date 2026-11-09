import type { Pool, PoolClient } from 'pg';

import { withTenantTransaction } from './connection.js';

/**
 * ADR 0029 D5: writes the canonical `VIVA/viva_profile` mapping from a server Viva Admin lookup by
 * the OTP-verified phone.
 *
 * The mapping is never overwritten:
 * - the Viva client already belongs to another PadlHub user -> `client_conflict`;
 * - this user is already mapped to a different Viva client -> `user_conflict`;
 * - the same pair already exists -> `unchanged` (freshness touched only).
 *
 * Both outcomes are decided on the current rows under the same canonical advisory lock that
 * `upsertExternalUser` takes for this provider client, so login and this link serialize. The two
 * live unique guarantees on `integration.external_entity_map` (external id, and the partial
 * canonical internal-id index of migration 0042) still catch a concurrent writer; that unique
 * violation is reported as `client_conflict` and changes nothing.
 *
 * Each linked or conflicting decision writes an audit row without phone or provider identifiers.
 */
export type VivaProfilePhoneLinkOutcome =
  'linked' | 'unchanged' | 'user_conflict' | 'client_conflict';

const AUDIT_ACTION: Record<Exclude<VivaProfilePhoneLinkOutcome, 'unchanged'>, string> = {
  linked: 'VIVA_PROFILE_LINKED_BY_PHONE',
  user_conflict: 'VIVA_PROFILE_PHONE_LINK_USER_CONFLICT',
  client_conflict: 'VIVA_PROFILE_PHONE_LINK_CLIENT_CONFLICT',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

async function audit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly outcome: Exclude<VivaProfilePhoneLinkOutcome, 'unchanged'>;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id
     ) values ($1, $2, $3, 'EXTERNAL_IDENTITY', $2, $4, $5, $6)`,
    [
      input.tenantId,
      input.userId,
      AUDIT_ACTION[input.outcome],
      input.outcome === 'linked' ? 'SUCCESS' : 'DENIED',
      input.outcome === 'linked' ? null : input.outcome.toUpperCase(),
      input.correlationId,
    ],
  );
}

export function linkVivaProfileByVerifiedPhone(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  /** Viva client UUID from `VivaClientPhoneLookupAdapter` `MATCHED`; never from a request. */
  readonly providerClientId: string;
  readonly correlationId: string;
}): Promise<VivaProfilePhoneLinkOutcome> {
  const providerClientId = input.providerClientId.toLowerCase();
  if (!UUID_PATTERN.test(providerClientId)) {
    return Promise.reject(new Error('VIVA_PROFILE_PHONE_LINK_CLIENT_ID_INVALID'));
  }
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    // Same key and lock as the canonical provider-user lock in upsertExternalUser.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.tenantId}\u001fVIVA\u001f${providerClientId}`,
    ]);
    const owner = await client.query<{ internal_id: string }>(
      `select internal_id
         from integration.external_entity_map
        where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'viva_profile'
          and lower(external_id) = $2
        limit 2`,
      [input.tenantId, providerClientId],
    );
    if (owner.rows.some((row) => row.internal_id !== input.userId)) {
      await audit(client, { ...input, outcome: 'client_conflict' });
      return 'client_conflict';
    }
    const current = await client.query<{ id: string; external_id: string }>(
      `select id, external_id
         from integration.external_entity_map
        where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'viva_profile'
          and internal_id = $2
        limit 2`,
      [input.tenantId, input.userId],
    );
    if (current.rows.some((row) => row.external_id.toLowerCase() !== providerClientId)) {
      await audit(client, { ...input, outcome: 'user_conflict' });
      return 'user_conflict';
    }
    const existing = current.rows[0];
    if (existing) {
      await client.query(
        `update integration.external_entity_map
            set last_synced_at = now(), sync_status = 'synced', sync_error_code = null
          where tenant_id = $1 and id = $2`,
        [input.tenantId, existing.id],
      );
      return 'unchanged';
    }
    await client.query(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id,
         last_synced_at, sync_status, sync_error_code
       ) values ($1, 'VIVA', 'viva_profile', $2, $3, now(), 'synced', null)`,
      [input.tenantId, input.userId, providerClientId],
    );
    await audit(client, { ...input, outcome: 'linked' });
    return 'linked';
  }).catch((error: unknown) => {
    // A concurrent writer claimed the client or the user first: keep both rows untouched.
    if (isUniqueViolation(error)) return 'client_conflict' as const;
    throw error;
  });
}

/** True when the user already has a canonical Viva profile mapping; lets login skip the lookup. */
export function hasVivaProfileMapping(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
}): Promise<boolean> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query(
      `select 1
         from integration.external_entity_map
        where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'viva_profile'
          and internal_id = $2
        limit 1`,
      [input.tenantId, input.userId],
    );
    return result.rows.length > 0;
  });
}
