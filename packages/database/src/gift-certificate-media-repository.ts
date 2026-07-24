import {
  GIFT_CERTIFICATE_MEDIA_READY_EVENT,
  giftCertificateMediaAssetSchema,
  type GiftCertificateMediaAsset,
} from '@phub/gift-certificates';
import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type GiftCertificateMediaCommandResult =
  | {
      readonly outcome: 'applied';
      readonly asset: GiftCertificateMediaAsset;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' };

export interface GiftCertificateMediaRepository {
  saveReady(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly tenantKey: string;
    readonly assetId: string;
    readonly objectKey: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<GiftCertificateMediaCommandResult>;
  getReady(
    tenantId: string,
    assetId: string,
  ): Promise<
    | {
        readonly asset: GiftCertificateMediaAsset;
        readonly objectKey: string;
      }
    | undefined
  >;
}

interface MediaRow extends QueryResultRow {
  readonly id: string;
  readonly status: 'READY';
  readonly object_key: string;
  readonly content_sha256: string;
  readonly content_type: 'image/webp';
  readonly byte_size: number;
  readonly width: number;
  readonly height: number;
  readonly created_at: Date | string;
}

interface MediaCommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

function mapAsset(row: MediaRow, tenantKey: string): GiftCertificateMediaAsset {
  return giftCertificateMediaAssetSchema.parse({
    id: row.id,
    status: row.status,
    mediaUrl: `/public/api/v1/${tenantKey}/gift-certificate-media/${row.id}`,
    contentType: row.content_type,
    bytes: row.byte_size,
    width: row.width,
    height: row.height,
    sha256: row.content_sha256,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export function createGiftCertificateMediaRepository(pool: Pool): GiftCertificateMediaRepository {
  return {
    saveReady(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await queryOne<MediaCommandRow>(
          client,
          `select request_hash, result_payload
             from gift_certificates.media_commands
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
            for update`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (command) {
          if (command.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'applied',
            asset: giftCertificateMediaAssetSchema.parse(command.result_payload),
            replayed: true,
          };
        }

        const row = await queryOne<MediaRow>(
          client,
          `insert into gift_certificates.media_assets (
             tenant_id, id, status, object_key, content_sha256,
             content_type, byte_size, width, height, created_by
           ) values ($1, $2, 'READY', $3, $4, 'image/webp', $5, $6, $7, $8)
           on conflict (tenant_id, content_sha256) do update set
             content_sha256 = excluded.content_sha256
           returning id, status, object_key, content_sha256,
                     content_type, byte_size, width, height, created_at`,
          [
            input.tenantId,
            input.assetId,
            input.objectKey,
            input.sha256,
            input.bytes,
            input.width,
            input.height,
            input.actorUserId,
          ],
        );
        if (!row) throw new Error('GIFT_CERTIFICATE_MEDIA_WRITE_LOST');
        const asset = mapAsset(row, input.tenantKey);
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'GIFT_CERTIFICATE_MEDIA_READY', 'GIFT_CERTIFICATE_MEDIA', $3,
                     'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            asset.id,
            input.correlationId,
            JSON.stringify({
              sha256: asset.sha256,
              contentType: asset.contentType,
              bytes: asset.bytes,
              width: asset.width,
              height: asset.height,
            }),
          ],
        );
        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, $2, $3, $4, $5::jsonb)`,
          [
            input.tenantId,
            GIFT_CERTIFICATE_MEDIA_READY_EVENT,
            asset.id,
            input.correlationId,
            JSON.stringify({ assetId: asset.id }),
          ],
        );
        await client.query(
          `insert into gift_certificates.media_commands (
             tenant_id, actor_user_id, idempotency_key, request_hash,
             asset_id, result_payload
           ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            input.idempotencyKey,
            input.requestHash,
            asset.id,
            JSON.stringify(asset),
          ],
        );
        return { outcome: 'applied', asset, replayed: false };
      });
    },

    getReady(tenantId, assetId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const tenant = await queryOne<{ readonly tenant_key: string }>(
          client,
          'select tenant_key from identity.tenants where id = $1 and active = true',
          [tenantId],
        );
        const row = await queryOne<MediaRow>(
          client,
          `select id, status, object_key, content_sha256,
                  content_type, byte_size, width, height, created_at
             from gift_certificates.media_assets
            where tenant_id = $1 and id = $2 and status = 'READY'`,
          [tenantId, assetId],
        );
        return row && tenant
          ? { asset: mapAsset(row, tenant.tenant_key), objectKey: row.object_key }
          : undefined;
      });
    },
  };
}
