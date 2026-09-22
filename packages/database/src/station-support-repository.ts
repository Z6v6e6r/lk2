import type { Pool } from 'pg';

import { withTenantTransaction } from './connection.js';

/**
 * Read-only bindings the station-support boundary needs. Nothing here is a PadlHub business
 * aggregate: the support dialogs stay owned by the legacy provider, and the viewer identity is
 * resolved server-side from integration custody rather than accepted from the caller.
 */
export interface StationSupportViewerIdentity {
  /** The phone the provider profile reported; it is the key the legacy CUP dialog already stores. */
  readonly providerPhoneE164: string | null;
  /** The verified phone login, which outranks the provider value as an identity but may be newer. */
  readonly verifiedPhoneE164: string | null;
}

export interface StationSupportRepository {
  /**
   * Both viewer phones in one read. The provider phone identifies existing CUP dialogs, while the
   * verified login phone is the stronger identity for a client the provider has not seen yet; the
   * caller decides, so neither value is silently dropped.
   */
  readViewerIdentity(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<StationSupportViewerIdentity>;
  /** Legacy station key for a PadlHub station UUID, or null when no usable binding exists. */
  readLegacyStationExternalId(input: {
    readonly tenantId: string;
    readonly stationId: string;
  }): Promise<string | null>;
  /** Reverse binding: legacy station key to PadlHub station UUID for the caller's own dialogs. */
  readStationIdsByLegacyExternalIds(input: {
    readonly tenantId: string;
    readonly externalIds: readonly string[];
  }): Promise<ReadonlyMap<string, string>>;
}

const PSEUDONYMOUS_EXTERNAL_ID = /^[0-9a-f]{64}$/;

export function createStationSupportRepository(pool: Pool): StationSupportRepository {
  return {
    readViewerIdentity(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = (
          await client.query<{ phone_e164: string | null; provider_phone_e164: string | null }>(
            `select p.phone_e164, provider_phone.external_id as provider_phone_e164
               from identity.users u
               left join profile.user_summaries p
                 on p.tenant_id = u.tenant_id and p.user_id = u.id
               left join lateral (
                 select e.external_id
                   from integration.external_entity_map e
                  where e.tenant_id = u.tenant_id
                    and e.external_system = 'VIVA'
                    and e.entity_type = 'legacy_viewer_phone'
                    and e.internal_id = u.id
                  order by e.last_synced_at desc nulls last, e.id
                  limit 1
               ) provider_phone on true
              where u.tenant_id = $1 and u.id = $2 and u.status = 'ACTIVE'`,
            [input.tenantId, input.userId],
          )
        ).rows[0];
        return {
          providerPhoneE164: row?.provider_phone_e164 ?? null,
          verifiedPhoneE164: row?.phone_e164 ?? null,
        };
      });
    },

    readLegacyStationExternalId(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = (
          await client.query<{ external_id: string }>(
            `select external_id
               from integration.external_entity_map
              where tenant_id = $1
                and external_system = 'LK_LEGACY_SNAPSHOT'
                and entity_type = 'game_station'
                and internal_id = $2
              order by external_id`,
            [input.tenantId, input.stationId],
          )
        ).rows;
        // The public legacy clone stores a one-way pseudonym as its canonical external id and keeps
        // the raw legacy key only as an alias, so a raw key must win whenever both rows exist.
        const preferred = rows
          .map((row) => row.external_id)
          .find((id) => !PSEUDONYMOUS_EXTERNAL_ID.test(id));
        return preferred ?? rows[0]?.external_id ?? null;
      });
    },

    readStationIdsByLegacyExternalIds(input) {
      const externalIds = [...new Set(input.externalIds.filter(Boolean))].slice(0, 200);
      if (externalIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = (
          await client.query<{ external_id: string; internal_id: string }>(
            `select distinct on (external_id) external_id, internal_id
               from integration.external_entity_map
              where tenant_id = $1
                and external_system = 'LK_LEGACY_SNAPSHOT'
                and entity_type = 'game_station'
                and external_id = any($2::text[])
              order by external_id, internal_id`,
            [input.tenantId, externalIds],
          )
        ).rows;
        return new Map(rows.map((row) => [row.external_id, row.internal_id]));
      });
    },
  };
}
