import { createHash, randomUUID } from 'node:crypto';

import type { CommunitySummary } from '@phub/communities';
import { withTenantTransaction } from '@phub/database';
import {
  HOME_PROJECTION_COMPONENT_EVENT,
  homeProjectionComponentPayloadSchema,
} from '@phub/home-projection';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { CommunityLogoPersistence, CommunityLogoSyncRecord } from './community-logo-sync.js';

interface SourceRow extends QueryResultRow {
  readonly source_revision: string;
  readonly payload_checksum: string;
}

interface HomeComponentRow extends QueryResultRow {
  readonly component_revision: string;
  readonly payload_checksum: string;
}

interface CommunityLogoRow extends QueryResultRow {
  readonly community_id: string;
  readonly source_url: string;
  readonly source_etag: string | null;
  readonly source_last_modified: string | null;
  readonly content_sha256: string;
  readonly object_key: string;
  readonly delivery_url: string;
  readonly delivery_expires_at: Date | string;
  readonly synced_at: Date | string;
}

export interface CommunityLogoObjectGcItem {
  readonly objectKey: string;
}

export interface CommunityHomeUser {
  readonly userId: string;
}

export interface CommunityHomePersistenceResult {
  readonly outcome: 'published' | 'unchanged';
  readonly sourceRevision: string;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function listDueCommunityHomeUsers(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly dueBefore: Date;
  readonly limit: number;
}): Promise<readonly CommunityHomeUser[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `select u.id::text as user_id
         from identity.users u
         left join integration.community_home_source_components source
           on source.tenant_id = u.tenant_id and source.user_id = u.id
        where u.tenant_id = $1
          and u.status = 'ACTIVE'
          and (source.last_synced_at is null or source.last_synced_at < $2)
          and exists (
            select 1
              from integration.user_delegations delegation
             where delegation.tenant_id = u.tenant_id
               and delegation.user_id = u.id
               and delegation.provider = 'VIVA'
               and delegation.revoked_at is null
               and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
          )
        order by source.last_synced_at asc nulls first, u.id
        limit $3`,
      [input.tenantId, input.dueBefore, input.limit],
    );
    return result.rows.map((row) => ({ userId: row.user_id }));
  });
}

export function loadCommunityLogoSyncRecords(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly communityIds: readonly string[];
}): Promise<ReadonlyMap<string, CommunityLogoSyncRecord>> {
  const communityIds = [...new Set(input.communityIds)];
  if (communityIds.length === 0) return Promise.resolve(new Map());
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<CommunityLogoRow>(
      `select community_id::text as community_id, source_url, source_etag,
              source_last_modified, content_sha256, object_key, delivery_url,
              delivery_expires_at, synced_at
         from integration.community_logo_sync
        where tenant_id = $1 and community_id = any($2::uuid[])`,
      [input.tenantId, communityIds],
    );
    return new Map(
      result.rows.map((row) => [
        row.community_id,
        {
          communityId: row.community_id,
          sourceUrl: row.source_url,
          ...(row.source_etag ? { sourceEtag: row.source_etag } : {}),
          ...(row.source_last_modified ? { sourceLastModified: row.source_last_modified } : {}),
          contentSha256: row.content_sha256,
          objectKey: row.object_key,
          deliveryUrl: row.delivery_url,
          deliveryExpiresAt: new Date(row.delivery_expires_at).toISOString(),
          syncedAt: new Date(row.synced_at).toISOString(),
        },
      ]),
    );
  });
}

export function listDueCommunityLogoObjects(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly limit: number;
}): Promise<readonly CommunityLogoObjectGcItem[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<{ object_key: string } & QueryResultRow>(
      `select object_key
         from integration.community_logo_object_gc
        where tenant_id = $1 and delete_after <= now()
        order by delete_after, object_key
        limit $2`,
      [input.tenantId, input.limit],
    );
    return result.rows.map((row) => ({ objectKey: row.object_key }));
  });
}

export function completeCommunityLogoObjectGc(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectKey: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      `delete from integration.community_logo_object_gc
        where tenant_id = $1 and object_key = $2`,
      [input.tenantId, input.objectKey],
    );
  });
}

export function recordCommunityLogoObjectGcFailure(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly errorCode: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      `update integration.community_logo_object_gc
          set attempts = attempts + 1,
              last_error_code = $3,
              delete_after = now() + interval '15 minutes',
              updated_at = now()
        where tenant_id = $1 and object_key = $2`,
      [input.tenantId, input.objectKey, input.errorCode.slice(0, 100)],
    );
  });
}

async function persistCommunityLogoAssets(input: {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly assets: readonly CommunityLogoPersistence[];
}): Promise<void> {
  for (const asset of input.assets) {
    if (
      asset.sourceUrl &&
      asset.contentSha256 &&
      asset.objectKey &&
      asset.deliveryUrl &&
      asset.deliveryExpiresAt
    ) {
      await input.client.query(
        `insert into integration.community_logo_sync (
           tenant_id, community_id, source_url, source_etag, source_last_modified,
           content_sha256, object_key, delivery_url, delivery_expires_at, synced_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (tenant_id, community_id) do update set
           source_url = excluded.source_url,
           source_etag = excluded.source_etag,
           source_last_modified = excluded.source_last_modified,
           content_sha256 = excluded.content_sha256,
           object_key = excluded.object_key,
           delivery_url = excluded.delivery_url,
           delivery_expires_at = excluded.delivery_expires_at,
           synced_at = excluded.synced_at,
           updated_at = now()`,
        [
          input.tenantId,
          asset.communityId,
          asset.sourceUrl,
          asset.sourceEtag ?? null,
          asset.sourceLastModified ?? null,
          asset.contentSha256,
          asset.objectKey,
          asset.deliveryUrl,
          asset.deliveryExpiresAt,
          asset.syncedAt,
        ],
      );
      await input.client.query(
        `delete from integration.community_logo_object_gc
          where tenant_id = $1 and object_key = $2`,
        [input.tenantId, asset.objectKey],
      );
    } else {
      await input.client.query(
        `delete from integration.community_logo_sync
          where tenant_id = $1 and community_id = $2`,
        [input.tenantId, asset.communityId],
      );
    }
    if (asset.supersededObjectKey && asset.deleteAfter) {
      await input.client.query(
        `insert into integration.community_logo_object_gc (
           tenant_id, object_key, delete_after
         ) values ($1, $2, $3)
         on conflict (tenant_id, object_key) do update set
           delete_after = least(integration.community_logo_object_gc.delete_after,
                                excluded.delete_after),
           updated_at = now()`,
        [input.tenantId, asset.supersededObjectKey, asset.deleteAfter],
      );
    }
  }
}

export function persistCommunityHomeSource(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  readonly sourceMode: 'LEGACY' | 'LOCAL';
  readonly communities: readonly CommunitySummary[];
  readonly logoAssets?: readonly CommunityLogoPersistence[];
  readonly correlationId: string;
  readonly fetchedAt: string;
}): Promise<CommunityHomePersistenceResult> {
  const payload = homeProjectionComponentPayloadSchema.parse({
    userId: input.userId,
    component: 'communities',
    componentRevision: '1',
    value: input.communities,
  });
  const payloadChecksum = checksum(payload.value);

  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
    if (input.logoAssets) {
      await persistCommunityLogoAssets({
        client,
        tenantId: input.tenantId,
        assets: input.logoAssets,
      });
    }
    const source = (
      await client.query<SourceRow>(
        `select source_revision::text as source_revision, payload_checksum
           from integration.community_home_source_components
          where tenant_id = $1 and user_id = $2
          for update`,
        [input.tenantId, input.userId],
      )
    ).rows[0];
    const currentHome = (
      await client.query<HomeComponentRow>(
        `select component_revision::text as component_revision, payload_checksum
           from home.dashboard_components
          where tenant_id = $1 and user_id = $2 and component = 'communities'`,
        [input.tenantId, input.userId],
      )
    ).rows[0];

    if (
      source?.payload_checksum === payloadChecksum &&
      currentHome?.payload_checksum === payloadChecksum
    ) {
      await client.query(
        `update integration.community_home_source_components
            set source_mode = $3, correlation_id = $4, fetched_at = $5,
                last_synced_at = now(), updated_at = now()
          where tenant_id = $1 and user_id = $2`,
        [input.tenantId, input.userId, input.sourceMode, input.correlationId, input.fetchedAt],
      );
      return { outcome: 'unchanged', sourceRevision: source.source_revision };
    }

    const nextRevision = (
      [source?.source_revision, currentHome?.component_revision]
        .filter((value): value is string => Boolean(value))
        .map(BigInt)
        .reduce((highest, value) => (value > highest ? value : highest), 0n) + 1n
    ).toString();
    const eventPayload = homeProjectionComponentPayloadSchema.parse({
      ...payload,
      componentRevision: nextRevision,
    });
    await client.query(
      `insert into integration.community_home_source_components (
         tenant_id, user_id, source_mode, source_revision, payload,
         payload_checksum, correlation_id, fetched_at
       ) values ($1, $2, $3, $4::bigint, $5::jsonb, $6, $7, $8)
       on conflict (tenant_id, user_id) do update set
         source_mode = excluded.source_mode,
         source_revision = excluded.source_revision,
         payload = excluded.payload,
         payload_checksum = excluded.payload_checksum,
         correlation_id = excluded.correlation_id,
         fetched_at = excluded.fetched_at,
         last_synced_at = now(),
         updated_at = now()`,
      [
        input.tenantId,
        input.userId,
        input.sourceMode,
        nextRevision,
        JSON.stringify(eventPayload.value),
        payloadChecksum,
        input.correlationId,
        input.fetchedAt,
      ],
    );
    const eventId = randomUUID();
    await client.query(
      `insert into audit.outbox_events (
         id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        eventId,
        input.tenantId,
        HOME_PROJECTION_COMPONENT_EVENT,
        input.userId,
        input.correlationId,
        JSON.stringify(eventPayload),
        input.fetchedAt,
      ],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id,
         result, correlation_id, new_value
       ) values ($1, $2, 'COMMUNITY_HOME_SYNC', 'HOME_SOURCE', $2,
                 'SUCCESS', $3, $4::jsonb)`,
      [
        input.tenantId,
        input.userId,
        input.correlationId,
        JSON.stringify({
          sourceMode: input.sourceMode,
          sourceRevision: nextRevision,
          communityCount: input.communities.length,
        }),
      ],
    );
    return { outcome: 'published', sourceRevision: nextRevision };
  });
}
