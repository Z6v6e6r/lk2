import { createHash, randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import {
  HOME_PROJECTION_COMPONENT_EVENT,
  homeProjectionComponentPayloadSchema,
  type HomeDashboard,
} from '@phub/home-projection';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  PromotionMediaPersistence,
  PromotionMediaSyncRecord,
} from './promotion-media-sync.js';

interface SourceRow extends QueryResultRow {
  readonly source_revision: string;
  readonly payload_checksum: string;
}

interface HomeComponentRow extends QueryResultRow {
  readonly component_revision: string;
  readonly payload_checksum: string;
}

interface PromotionMappingRow extends QueryResultRow {
  readonly external_id: string;
  readonly internal_id: string;
}

interface PromotionMediaRow extends QueryResultRow {
  readonly promotion_id: string;
  readonly source_url: string;
  readonly source_etag: string | null;
  readonly source_last_modified: string | null;
  readonly desktop_sha256: string;
  readonly mobile_sha256: string;
  readonly desktop_object_key: string;
  readonly mobile_object_key: string;
  readonly desktop_delivery_url: string;
  readonly mobile_delivery_url: string;
  readonly delivery_expires_at: Date | string;
  readonly synced_at: Date | string;
}

export interface PromotionHomePersistenceResult {
  readonly outcome: 'published' | 'unchanged';
  readonly sourceRevision: string;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function resolvePromotionIds(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly externalIds: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
  const externalIds = [...new Set(input.externalIds.map((id) => id.trim()).filter(Boolean))];
  if (externalIds.length === 0) return Promise.resolve(new Map());
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<PromotionMappingRow>(
      `with source as (
         select distinct external_id
           from unnest($2::text[]) as source_ids(external_id)
       )
       insert into integration.external_entity_map (
         tenant_id, external_system, entity_type, internal_id, external_id,
         external_version, last_synced_at, sync_status, sync_error_code
       )
       select $1, 'LK_LEGACY', 'cabinet_home_ad', gen_random_uuid(), source.external_id,
              'cabinet-home-v1', now(), 'synced', null
         from source
       on conflict (tenant_id, external_system, entity_type, external_id)
       do update set external_version = excluded.external_version,
                     last_synced_at = excluded.last_synced_at,
                     sync_status = 'synced',
                     sync_error_code = null
       returning external_id, internal_id`,
      [input.tenantId, externalIds],
    );
    return new Map(result.rows.map((row) => [row.external_id, row.internal_id]));
  });
}

export function listDuePromotionHomeUsers(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly dueBefore: Date;
  readonly limit: number;
}): Promise<readonly string[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `select u.id::text as user_id
         from identity.users u
         left join integration.promotion_home_source_components source
           on source.tenant_id = u.tenant_id and source.user_id = u.id
        where u.tenant_id = $1
          and u.status = 'ACTIVE'
          and (source.last_synced_at is null or source.last_synced_at < $2)
        order by source.last_synced_at asc nulls first, u.id
        limit $3`,
      [input.tenantId, input.dueBefore, input.limit],
    );
    return result.rows.map((row) => row.user_id);
  });
}

export function loadPromotionMediaSyncRecords(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly promotionIds: readonly string[];
}): Promise<ReadonlyMap<string, PromotionMediaSyncRecord>> {
  const promotionIds = [...new Set(input.promotionIds)];
  if (promotionIds.length === 0) return Promise.resolve(new Map());
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<PromotionMediaRow>(
      `select promotion_id::text as promotion_id, source_url, source_etag,
              source_last_modified, desktop_sha256, mobile_sha256,
              desktop_object_key, mobile_object_key, desktop_delivery_url,
              mobile_delivery_url, delivery_expires_at, synced_at
         from integration.promotion_media_sync
        where tenant_id = $1 and promotion_id = any($2::uuid[])`,
      [input.tenantId, promotionIds],
    );
    return new Map(
      result.rows.map((row) => [
        row.promotion_id,
        {
          promotionId: row.promotion_id,
          sourceUrl: row.source_url,
          ...(row.source_etag ? { sourceEtag: row.source_etag } : {}),
          ...(row.source_last_modified ? { sourceLastModified: row.source_last_modified } : {}),
          desktopSha256: row.desktop_sha256,
          mobileSha256: row.mobile_sha256,
          desktopObjectKey: row.desktop_object_key,
          mobileObjectKey: row.mobile_object_key,
          desktopDeliveryUrl: row.desktop_delivery_url,
          mobileDeliveryUrl: row.mobile_delivery_url,
          deliveryExpiresAt: new Date(row.delivery_expires_at).toISOString(),
          syncedAt: new Date(row.synced_at).toISOString(),
        },
      ]),
    );
  });
}

async function scheduleObjectGc(input: {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly deleteAfter: string;
}): Promise<void> {
  await input.client.query(
    `insert into integration.promotion_media_object_gc (tenant_id, object_key, delete_after)
     values ($1, $2, $3)
     on conflict (tenant_id, object_key) do update set
       delete_after = least(integration.promotion_media_object_gc.delete_after,
                            excluded.delete_after),
       updated_at = now()`,
    [input.tenantId, input.objectKey, input.deleteAfter],
  );
}

export function persistPromotionMedia(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly activePromotionIds: readonly string[];
  readonly assets: readonly PromotionMediaPersistence[];
  readonly deleteAfter: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    for (const asset of input.assets) {
      await client.query(
        `insert into integration.promotion_media_sync (
           tenant_id, promotion_id, source_url, source_etag, source_last_modified,
           desktop_sha256, mobile_sha256, desktop_object_key, mobile_object_key,
           desktop_delivery_url, mobile_delivery_url, delivery_expires_at, synced_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (tenant_id, promotion_id) do update set
           source_url = excluded.source_url,
           source_etag = excluded.source_etag,
           source_last_modified = excluded.source_last_modified,
           desktop_sha256 = excluded.desktop_sha256,
           mobile_sha256 = excluded.mobile_sha256,
           desktop_object_key = excluded.desktop_object_key,
           mobile_object_key = excluded.mobile_object_key,
           desktop_delivery_url = excluded.desktop_delivery_url,
           mobile_delivery_url = excluded.mobile_delivery_url,
           delivery_expires_at = excluded.delivery_expires_at,
           synced_at = excluded.synced_at,
           updated_at = now()`,
        [
          input.tenantId,
          asset.promotionId,
          asset.sourceUrl,
          asset.sourceEtag ?? null,
          asset.sourceLastModified ?? null,
          asset.desktopSha256,
          asset.mobileSha256,
          asset.desktopObjectKey,
          asset.mobileObjectKey,
          asset.desktopDeliveryUrl,
          asset.mobileDeliveryUrl,
          asset.deliveryExpiresAt,
          asset.syncedAt,
        ],
      );
      await client.query(
        `delete from integration.promotion_media_object_gc
          where tenant_id = $1 and object_key = any($2::text[])`,
        [input.tenantId, [asset.desktopObjectKey, asset.mobileObjectKey]],
      );
      if (asset.supersededObjectKeys && asset.deleteAfter) {
        for (const objectKey of asset.supersededObjectKeys) {
          await scheduleObjectGc({
            client,
            tenantId: input.tenantId,
            objectKey,
            deleteAfter: asset.deleteAfter,
          });
        }
      }
    }

    const removed = await client.query<
      {
        desktop_object_key: string;
        mobile_object_key: string;
      } & QueryResultRow
    >(
      `delete from integration.promotion_media_sync
        where tenant_id = $1
          and not (promotion_id = any($2::uuid[]))
      returning desktop_object_key, mobile_object_key`,
      [input.tenantId, input.activePromotionIds],
    );
    for (const row of removed.rows) {
      for (const objectKey of [row.desktop_object_key, row.mobile_object_key]) {
        await scheduleObjectGc({
          client,
          tenantId: input.tenantId,
          objectKey,
          deleteAfter: input.deleteAfter,
        });
      }
    }
  });
}

export function listDuePromotionMediaObjects(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly limit: number;
}): Promise<readonly string[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<{ object_key: string } & QueryResultRow>(
      `select object_key
         from integration.promotion_media_object_gc
        where tenant_id = $1 and delete_after <= now()
        order by delete_after, object_key
        limit $2`,
      [input.tenantId, input.limit],
    );
    return result.rows.map((row) => row.object_key);
  });
}

export function completePromotionMediaObjectGc(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectKey: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      `delete from integration.promotion_media_object_gc
        where tenant_id = $1 and object_key = $2`,
      [input.tenantId, input.objectKey],
    );
  });
}

export function recordPromotionMediaObjectGcFailure(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly errorCode: string;
}): Promise<void> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      `update integration.promotion_media_object_gc
          set attempts = attempts + 1,
              last_error_code = $3,
              delete_after = now() + interval '15 minutes',
              updated_at = now()
        where tenant_id = $1 and object_key = $2`,
      [input.tenantId, input.objectKey, input.errorCode.slice(0, 100)],
    );
  });
}

export function persistPromotionHomeSource(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  readonly promotions: HomeDashboard['promotions'];
  readonly correlationId: string;
  readonly fetchedAt: string;
}): Promise<PromotionHomePersistenceResult> {
  const payload = homeProjectionComponentPayloadSchema.parse({
    userId: input.userId,
    component: 'promotion',
    componentRevision: '1',
    value: input.promotions,
  });
  const payloadChecksum = checksum(payload.value);

  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
    const source = (
      await client.query<SourceRow>(
        `select source_revision::text as source_revision, payload_checksum
           from integration.promotion_home_source_components
          where tenant_id = $1 and user_id = $2
          for update`,
        [input.tenantId, input.userId],
      )
    ).rows[0];
    const currentHome = (
      await client.query<HomeComponentRow>(
        `select component_revision::text as component_revision, payload_checksum
           from home.dashboard_components
          where tenant_id = $1 and user_id = $2 and component = 'promotion'`,
        [input.tenantId, input.userId],
      )
    ).rows[0];
    if (
      source?.payload_checksum === payloadChecksum &&
      currentHome?.payload_checksum === payloadChecksum
    ) {
      await client.query(
        `update integration.promotion_home_source_components
            set correlation_id = $3, fetched_at = $4,
                last_synced_at = now(), updated_at = now()
          where tenant_id = $1 and user_id = $2`,
        [input.tenantId, input.userId, input.correlationId, input.fetchedAt],
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
      `insert into integration.promotion_home_source_components (
         tenant_id, user_id, source_revision, payload, payload_checksum,
         correlation_id, fetched_at
       ) values ($1, $2, $3::bigint, $4::jsonb, $5, $6, $7)
       on conflict (tenant_id, user_id) do update set
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
        nextRevision,
        JSON.stringify(eventPayload.value),
        payloadChecksum,
        input.correlationId,
        input.fetchedAt,
      ],
    );
    await client.query(
      `insert into audit.outbox_events (
         id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        randomUUID(),
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
       ) values ($1, $2, 'PROMOTION_HOME_SYNC', 'HOME_SOURCE', $2,
                 'SUCCESS', $3, $4::jsonb)`,
      [
        input.tenantId,
        input.userId,
        input.correlationId,
        JSON.stringify({
          sourceRevision: nextRevision,
          promotionCount: input.promotions.items.length,
          rotationEnabled: input.promotions.rotationEnabled,
        }),
      ],
    );
    return { outcome: 'published', sourceRevision: nextRevision };
  });
}
