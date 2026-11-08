import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

/**
 * ADR 0028 writer. Input must be an LK1 owner attestation already parsed by
 * `parseProviderAccountAttestation`; browser data never reaches this repository.
 */
export interface AttestedAccountInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly providerClientId: string;
  readonly attestedAt: string;
  readonly subscriptions: readonly {
    readonly clientSubscriptionId: string;
    readonly productId: string | null;
    readonly title: string | null;
    readonly state: 'ACTIVE' | 'NOT_ACTIVATED' | 'PAUSED' | 'FINISHED';
    readonly remainingUnits: number | null;
    readonly validUntil: string | null;
  }[];
}

export interface AttestedAccountSubscription {
  /** PadlHub UUID; the only subscription identifier a client ever receives. */
  readonly subscriptionId: string;
  readonly clientSubscriptionId: string;
  readonly productId: string | null;
  readonly title: string | null;
  readonly state: 'ACTIVE' | 'NOT_ACTIVATED' | 'PAUSED' | 'FINISHED';
  readonly remainingUnits: number | null;
  readonly validUntil: string | null;
}

export interface AttestedAccountResult {
  readonly profileMappingId: string;
  readonly subscriptions: readonly AttestedAccountSubscription[];
}

export class ProviderAccountMappingConflict extends Error {
  constructor() {
    super('PROVIDER_ACCOUNT_CONFLICT');
  }
}

interface MappingRow extends QueryResultRow {
  readonly id: string;
  readonly internal_id: string;
}

async function upsertProfile(client: PoolClient, input: AttestedAccountInput): Promise<string> {
  // A Viva client is never moved between PadlHub users, and a user never silently changes client.
  const existing = await client.query<MappingRow & { readonly external_id: string }>(
    `select id, internal_id, external_id
       from integration.external_entity_map
      where tenant_id = $1 and external_system = 'VIVA' and entity_type = 'viva_profile'
        and (external_id = $2 or internal_id = $3)
      for update`,
    [input.tenantId, input.providerClientId, input.userId],
  );
  if (
    existing.rows.some(
      (row) => row.internal_id !== input.userId || row.external_id !== input.providerClientId,
    )
  )
    throw new ProviderAccountMappingConflict();
  const row = (
    await client.query<MappingRow>(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id,
         external_version, last_synced_at, sync_status, sync_error_code
       ) values ($1, 'VIVA', 'viva_profile', $2, $3, $4, $5::timestamptz, 'synced', null)
       on conflict (tenant_id, external_system, entity_type, external_id)
       do update set external_version = excluded.external_version,
                     last_synced_at = excluded.last_synced_at,
                     sync_status = 'synced', sync_error_code = null
         where integration.external_entity_map.internal_id = excluded.internal_id
       returning id, internal_id`,
      [input.tenantId, input.userId, input.providerClientId, input.operationId, input.attestedAt],
    )
  ).rows[0];
  if (!row || row.internal_id !== input.userId) throw new ProviderAccountMappingConflict();
  return row.id;
}

async function upsertSubscription(
  client: PoolClient,
  input: AttestedAccountInput,
  clientSubscriptionId: string,
): Promise<string> {
  const row = (
    await client.query<MappingRow>(
      `insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id,
         external_version, last_synced_at, sync_status, sync_error_code
       ) values ($1, 'VIVA', 'subscription', gen_random_uuid(), $2, $3, $4::timestamptz,
                 'synced', null)
       on conflict (tenant_id, external_system, entity_type, external_id)
       do update set external_version = excluded.external_version,
                     last_synced_at = excluded.last_synced_at,
                     sync_status = 'synced', sync_error_code = null
       returning id, internal_id`,
      [input.tenantId, clientSubscriptionId, input.operationId, input.attestedAt],
    )
  ).rows[0];
  if (!row) throw new Error('PROVIDER_ACCOUNT_MAPPING_FAILED');
  return row.internal_id;
}

export function createProviderAccountMappingRepository(pool: Pool) {
  return {
    /** Writes mappings and one audit row atomically; returns only PadlHub identifiers + display. */
    async recordAttestation(input: AttestedAccountInput): Promise<AttestedAccountResult> {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (client) => {
          const profileMappingId = await upsertProfile(client, input);
          const subscriptions: AttestedAccountSubscription[] = [];
          for (const item of input.subscriptions) {
            subscriptions.push({
              ...item,
              subscriptionId: await upsertSubscription(client, input, item.clientSubscriptionId),
            });
          }
          await client.query(
            `insert into audit.audit_log (
               tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
             ) values ($1, 'PROVIDER_ACCOUNT_ATTESTED', 'PROVIDER_ACCOUNT', $2, 'SUCCESS', $3,
                       $4::jsonb)`,
            [
              input.tenantId,
              input.userId,
              input.correlationId,
              JSON.stringify({
                operationId: input.operationId,
                profileMappingId,
                subscriptionCount: subscriptions.length,
              }),
            ],
          );
          return { profileMappingId, subscriptions };
        });
      } catch (error) {
        if (error instanceof ProviderAccountMappingConflict) {
          await withTenantTransaction(pool, input.tenantId, (client) =>
            client.query(
              `insert into audit.audit_log (
                 tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
               ) values ($1, 'PROVIDER_ACCOUNT_ATTESTED', 'PROVIDER_ACCOUNT', $2, 'FAILURE', $3,
                         $4::jsonb)`,
              [
                input.tenantId,
                input.userId,
                input.correlationId,
                JSON.stringify({
                  operationId: input.operationId,
                  code: 'PROVIDER_ACCOUNT_CONFLICT',
                }),
              ],
            ),
          );
        }
        throw error;
      }
    },
  };
}

export type ProviderAccountMappingRepository = ReturnType<
  typeof createProviderAccountMappingRepository
>;
