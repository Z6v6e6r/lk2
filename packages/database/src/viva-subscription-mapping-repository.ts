import type { Pool, PoolClient } from 'pg';

import { withTenantTransaction } from './connection.js';

/**
 * ADR 0029 D5: writes `VIVA/subscription` integration mappings for a user who already has a synced
 * `VIVA/viva_profile` mapping, from a complete server Viva Admin read of that client's
 * subscriptions, and binds each mapping to the user in `integration.viva_subscription_owners`.
 *
 * Row format is the one every reader and the Home worker already use: `external_id` is the Viva
 * client-subscription instance id exactly as Viva returned it, `internal_id` is a stable PadlHub
 * UUID, `sync_status='synced'`, `sync_error_code=null`, `last_synced_at` and `external_version` are
 * the observation time.
 *
 * Fail-closed rules:
 * - the profile mapping is re-read under the canonical provider-client advisory lock; if it moved
 *   or is no longer synced, nothing is written (`profile_changed`);
 * - an instance already bound to another user or another profile mapping is a conflict: neither the
 *   mapping nor its owner changes, and an audit row is written;
 * - nothing is ever deleted or marked absent; instances missing from a read keep their rows.
 *
 * Audit rows carry PadlHub UUIDs and counts only, never phone or provider identifiers.
 */

export interface VivaSubscriptionSyncProfile {
  readonly profileMappingId: string;
  /** Viva client id exactly as stored on the `viva_profile` mapping. */
  readonly providerClientId: string;
}

export interface VivaSubscriptionMappingResult {
  readonly outcome: 'synced' | 'profile_changed';
  /** Mappings created by this write. */
  readonly created: number;
  /** Existing mappings refreshed (including first binding of an unowned mapping). */
  readonly refreshed: number;
  /** Instances skipped because another user or profile owns them. */
  readonly conflicts: number;
}

/** One read never maps more than the adapter's bounded page budget. */
export const VIVA_SUBSCRIPTION_MAPPING_MAX_ITEMS = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProfileRow {
  readonly id: string;
  readonly internal_id: string;
  readonly external_id: string;
}

const SYNCED_PROFILE = `external_system = 'VIVA' and entity_type = 'viva_profile'
  and sync_status = 'synced' and sync_error_code is null and last_synced_at is not null`;

/**
 * The user's single synced `viva_profile` mapping, or null. Same filters as the paid-command
 * readers, so a sync never runs for a mapping those readers would refuse.
 */
export function readVivaSubscriptionSyncProfile(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
}): Promise<VivaSubscriptionSyncProfile | null> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const rows = await client.query<ProfileRow>(
      `select id, internal_id, external_id from integration.external_entity_map
        where tenant_id = $1 and internal_id = $2 and ${SYNCED_PROFILE}
        limit 2`,
      [input.tenantId, input.userId],
    );
    const row = rows.rows.length === 1 ? rows.rows[0] : undefined;
    if (!row || !UUID_PATTERN.test(row.external_id)) return null;
    return { profileMappingId: row.id, providerClientId: row.external_id };
  });
}

async function profileStillCurrent(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly profileMappingId: string;
    readonly clientKey: string;
  },
): Promise<boolean> {
  const mine = await client.query<ProfileRow>(
    `select id, internal_id, external_id from integration.external_entity_map
      where tenant_id = $1 and internal_id = $2 and ${SYNCED_PROFILE}
      limit 2`,
    [input.tenantId, input.userId],
  );
  if (
    mine.rows.length !== 1 ||
    mine.rows[0]!.id !== input.profileMappingId ||
    mine.rows[0]!.external_id.toLowerCase() !== input.clientKey
  )
    return false;
  // The client must not be mapped to anyone else (any sync state) either.
  const others = await client.query(
    `select 1 from integration.external_entity_map
      where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'viva_profile'
        and lower(external_id) = $2 and internal_id <> $3
      limit 1`,
    [input.tenantId, input.clientKey, input.userId],
  );
  return others.rows.length === 0;
}

async function auditConflict(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly subscriptionMappingId: string;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id
     ) values ($1, $2, 'VIVA_SUBSCRIPTION_MAPPING_OWNER_CONFLICT', 'EXTERNAL_SUBSCRIPTION', $3,
               'DENIED', 'OWNER_CONFLICT', $4)`,
    [input.tenantId, input.userId, input.subscriptionMappingId, input.correlationId],
  );
}

export function recordVivaSubscriptionMappings(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  /** From `readVivaSubscriptionSyncProfile`; re-verified inside the write transaction. */
  readonly profileMappingId: string;
  readonly providerClientId: string;
  /** From a complete `VivaClientSubscriptionMappingSource.read` of that same client. */
  readonly providerSubscriptionIds: readonly string[];
  readonly observedAt: string;
  readonly correlationId: string;
}): Promise<VivaSubscriptionMappingResult> {
  if (!UUID_PATTERN.test(input.providerClientId)) {
    return Promise.reject(new Error('VIVA_SUBSCRIPTION_MAPPING_CLIENT_ID_INVALID'));
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    return Promise.reject(new Error('VIVA_SUBSCRIPTION_MAPPING_OBSERVED_AT_INVALID'));
  }
  if (input.providerSubscriptionIds.length > VIVA_SUBSCRIPTION_MAPPING_MAX_ITEMS) {
    return Promise.reject(new Error('VIVA_SUBSCRIPTION_MAPPING_TOO_MANY'));
  }
  const ids = new Map<string, string>();
  for (const id of input.providerSubscriptionIds) {
    if (!UUID_PATTERN.test(id)) {
      return Promise.reject(new Error('VIVA_SUBSCRIPTION_MAPPING_ID_INVALID'));
    }
    const key = id.toLowerCase();
    if (!ids.has(key)) ids.set(key, id);
  }
  const clientKey = input.providerClientId.toLowerCase();
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    // Same key and lock as upsertExternalUser and the phone link: a profile link or relink of this
    // client serializes with this write.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.tenantId}\u001fVIVA\u001f${clientKey}`,
    ]);
    if (
      !(await profileStillCurrent(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        profileMappingId: input.profileMappingId,
        clientKey,
      }))
    ) {
      return { outcome: 'profile_changed', created: 0, refreshed: 0, conflicts: 0 };
    }
    let created = 0;
    let refreshed = 0;
    let conflicts = 0;
    // A fixed order across concurrent transactions avoids row-lock deadlocks between two syncs.
    const ordered = [...ids].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [key, providerSubscriptionId] of ordered) {
      const inserted = await client.query<{ id: string }>(
        `insert into integration.external_entity_map (
           tenant_id, external_system, entity_type, internal_id, external_id,
           external_version, last_synced_at, sync_status, sync_error_code
         )
         select $1, 'VIVA', 'subscription', gen_random_uuid(), $2, $3::text, $3::timestamptz,
                'synced', null
          where not exists (
            select 1 from integration.external_entity_map
             where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'subscription'
               and lower(external_id) = $4)
         on conflict (tenant_id, external_system, entity_type, external_id) do nothing
         returning id`,
        [input.tenantId, providerSubscriptionId, input.observedAt, key],
      );
      // Lock the mapping row before reading its owner, so two users' syncs serialize per instance.
      const mapping = await client.query<{ id: string }>(
        `select id from integration.external_entity_map
          where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'subscription'
            and lower(external_id) = $2
          for update`,
        [input.tenantId, key],
      );
      if (mapping.rows.length !== 1) {
        // Case-variant duplicates written by another writer: refuse rather than pick one.
        conflicts += 1;
        continue;
      }
      const mappingId = mapping.rows[0]!.id;
      const owner = await client.query<{ user_id: string; profile_mapping_id: string }>(
        `select user_id, profile_mapping_id from integration.viva_subscription_owners
          where tenant_id = $1 and subscription_mapping_id = $2
          for update`,
        [input.tenantId, mappingId],
      );
      const bound = owner.rows[0];
      if (
        bound &&
        (bound.user_id !== input.userId || bound.profile_mapping_id !== input.profileMappingId)
      ) {
        conflicts += 1;
        await auditConflict(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          correlationId: input.correlationId,
          subscriptionMappingId: mappingId,
        });
        continue;
      }
      if (inserted.rows.length === 1) {
        created += 1;
      } else {
        // Never move freshness backwards when a newer observation already landed.
        await client.query(
          `update integration.external_entity_map
              set external_version = case
                    when last_synced_at is null or last_synced_at <= $3::timestamptz then $3::text
                    else external_version
                  end,
                  last_synced_at = greatest(coalesce(last_synced_at, $3::timestamptz), $3::timestamptz),
                  sync_status = 'synced', sync_error_code = null
            where tenant_id = $1 and id = $2`,
          [input.tenantId, mappingId, input.observedAt],
        );
        refreshed += 1;
      }
      await client.query(
        `insert into integration.viva_subscription_owners (
           tenant_id, subscription_mapping_id, profile_mapping_id, user_id,
           first_observed_at, last_observed_at
         ) values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)
         on conflict (tenant_id, subscription_mapping_id) do update
           set last_observed_at = greatest(
                 integration.viva_subscription_owners.last_observed_at, excluded.last_observed_at)`,
        [input.tenantId, mappingId, input.profileMappingId, input.userId, input.observedAt],
      );
    }
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id, new_value
       ) values ($1, $2, 'VIVA_SUBSCRIPTION_MAPPINGS_SYNCED', 'EXTERNAL_IDENTITY', $2, $3, $4,
                 $5::jsonb)`,
      [
        input.tenantId,
        input.userId,
        conflicts > 0 ? 'PARTIAL' : 'SUCCESS',
        input.correlationId,
        JSON.stringify({ created, refreshed, conflicts }),
      ],
    );
    return { outcome: 'synced', created, refreshed, conflicts };
  });
}
