import { randomUUID } from 'node:crypto';

import { profilePhotoDeliveryUrl } from '@phub/domain';
import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface PlayerProfileSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly levelLabel: string | null;
  readonly levelValue: number | null;
}

export interface ProfileSummaryRepository {
  get(tenantId: string, userId: string): Promise<PlayerProfileSummary | undefined>;
  getPhotoObjectKey(tenantId: string, deliveryId: string): Promise<string | undefined>;
  getPhotoDeliveryState(
    tenantId: string,
    userId: string,
  ): Promise<{ readonly deliveryId: string; readonly syncedAt: string } | undefined>;
  getPhotoDeliveryIds(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  getDisplayNames(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  getLevelValues(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;
  reserveClientAssistedPhoto?(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly contentSha256: string;
    readonly requestSha256: string;
    readonly idempotencyKey: string;
    readonly grantId: string;
    readonly grantIssuedAt: string;
    readonly expiresAt: string;
  }): Promise<{ readonly avatarUrl?: string; readonly replayed: boolean }>;
  finalizeClientAssistedPhoto?(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly contentSha256: string;
    readonly requestSha256: string;
    readonly idempotencyKey: string;
    readonly grantId: string;
    readonly grantIssuedAt: string;
    readonly syncedAt: string;
    readonly previousObjectRetentionSeconds: number;
    readonly correlationId: string;
  }): Promise<{ readonly avatarUrl: string; readonly replayed: boolean }>;
  removeClientAssistedPhoto?(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly grantId: string;
    readonly grantIssuedAt: string;
    readonly observedAt: string;
    readonly expiresAt: string;
    readonly previousObjectRetentionSeconds: number;
    readonly correlationId: string;
  }): Promise<{ readonly removed: boolean; readonly replayed: boolean }>;
}

export class ProfilePhotoIdempotencyConflictError extends Error {
  public constructor() {
    super('PROFILE_PHOTO_IDEMPOTENCY_CONFLICT');
    this.name = 'ProfilePhotoIdempotencyConflictError';
  }
}

export class ProfilePhotoGrantStaleError extends Error {
  public constructor() {
    super('PROFILE_PHOTO_GRANT_STALE');
    this.name = 'ProfilePhotoGrantStaleError';
  }
}

interface ProfileSummaryRow extends QueryResultRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly photo_url: string | null;
  readonly level_label: string | null;
  readonly level_value: number | string | null;
}

interface ClientPhotoCommandRow extends QueryResultRow {
  readonly command_kind: 'UPSERT' | 'DELETE';
  readonly idempotency_key: string;
  readonly grant_id: string;
  readonly request_sha256: string | null;
  readonly content_sha256: string | null;
  readonly object_key: string | null;
  readonly grant_issued_at: Date | string;
  readonly avatar_url: string | null;
}

interface CurrentPhotoRow extends QueryResultRow {
  readonly delivery_id: string;
  readonly object_key: string;
  readonly content_sha256: string;
  readonly source_url: string | null;
  readonly synced_at: Date | string;
  readonly client_grant_issued_at: Date | string | null;
}

interface PhotoObservationWatermarkRow extends QueryResultRow {
  readonly observed_at: Date | string;
}

function commandMatches(
  row: ClientPhotoCommandRow,
  input: {
    readonly idempotencyKey: string;
    readonly grantId: string;
    readonly requestSha256: string;
    readonly contentSha256: string;
    readonly objectKey: string;
    readonly grantIssuedAt: string;
  },
): boolean {
  return (
    row.command_kind === 'UPSERT' &&
    row.idempotency_key === input.idempotencyKey &&
    row.grant_id === input.grantId &&
    row.request_sha256 === input.requestSha256 &&
    row.content_sha256 === input.contentSha256 &&
    row.object_key === input.objectKey &&
    Date.parse(String(row.grant_issued_at)) === Date.parse(input.grantIssuedAt)
  );
}

function deleteCommandMatches(
  row: ClientPhotoCommandRow,
  input: {
    readonly idempotencyKey: string;
    readonly grantId: string;
    readonly grantIssuedAt: string;
  },
): boolean {
  return (
    row.command_kind === 'DELETE' &&
    row.idempotency_key === input.idempotencyKey &&
    row.grant_id === input.grantId &&
    Date.parse(String(row.grant_issued_at)) === Date.parse(input.grantIssuedAt)
  );
}

function grantIsStale(current: CurrentPhotoRow | undefined, grantIssuedAt: string): boolean {
  if (!current) return false;
  const issuedAt = Date.parse(grantIssuedAt);
  if (
    current.client_grant_issued_at &&
    issuedAt <= Date.parse(String(current.client_grant_issued_at))
  ) {
    return true;
  }
  return Boolean(current.source_url && issuedAt <= Date.parse(String(current.synced_at)));
}

function watermarkIsStale(
  watermark: PhotoObservationWatermarkRow | undefined,
  observationAt: string,
): boolean {
  return Boolean(
    watermark && Date.parse(observationAt) <= Date.parse(String(watermark.observed_at)),
  );
}

function levelValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function createProfileSummaryRepository(pool: Pool): ProfileSummaryRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<ProfileSummaryRow>(
          client,
          `select user_id, display_name, photo_url, level_label, level_value
             from profile.user_summaries
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row
          ? {
              userId: row.user_id,
              displayName: row.display_name,
              avatarUrl: row.photo_url,
              levelLabel: row.level_label,
              levelValue: levelValue(row.level_value),
            }
          : undefined;
      });
    },

    getPhotoObjectKey(tenantId, deliveryId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<{ readonly object_key: string } & QueryResultRow>(
          client,
          `select s.object_key
             from integration.user_profile_photo_sync s
             join identity.tenants t on t.id = s.tenant_id and t.active = true
            where s.tenant_id = $1 and s.delivery_id = $2`,
          [tenantId, deliveryId],
        );
        return row?.object_key;
      });
    },

    getPhotoDeliveryIds(tenantId, userIds) {
      if (userIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<
          { readonly user_id: string; readonly delivery_id: string } & QueryResultRow
        >(
          `select user_id, delivery_id
             from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = any($2::uuid[])`,
          [tenantId, [...new Set(userIds)]],
        );
        return new Map(rows.rows.map((row) => [row.user_id, row.delivery_id]));
      });
    },

    getPhotoDeliveryState(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<
          { readonly delivery_id: string; readonly synced_at: Date | string } & QueryResultRow
        >(
          client,
          `select delivery_id, synced_at
             from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row
          ? { deliveryId: row.delivery_id, syncedAt: new Date(row.synced_at).toISOString() }
          : undefined;
      });
    },

    reserveClientAssistedPhoto(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
        const previousCommand = await queryOne<ClientPhotoCommandRow>(
          client,
          `select command_kind, idempotency_key, grant_id, request_sha256, content_sha256, object_key,
                  grant_issued_at, avatar_url
             from integration.profile_photo_client_commands
            where tenant_id = $1 and user_id = $2
              and (idempotency_key = $3 or grant_id = $4)`,
          [input.tenantId, input.userId, input.idempotencyKey, input.grantId],
        );
        if (previousCommand) {
          if (!commandMatches(previousCommand, input)) {
            throw new ProfilePhotoIdempotencyConflictError();
          }
          if (previousCommand.avatar_url) {
            return { avatarUrl: previousCommand.avatar_url, replayed: true };
          }
        }
        const current = await queryOne<CurrentPhotoRow>(
          client,
          `select delivery_id, object_key, content_sha256, source_url, synced_at,
                  client_grant_issued_at
             from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        const watermark = await queryOne<PhotoObservationWatermarkRow>(
          client,
          `select observed_at
             from integration.profile_photo_observation_watermarks
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        if (
          grantIsStale(current, input.grantIssuedAt) ||
          watermarkIsStale(watermark, input.grantIssuedAt)
        ) {
          throw new ProfilePhotoGrantStaleError();
        }
        if (!previousCommand) {
          await client.query(
            `insert into integration.profile_photo_client_commands (
               tenant_id, user_id, idempotency_key, grant_id, command_kind, request_sha256,
               content_sha256, object_key, grant_issued_at, expires_at
             ) values ($1, $2, $3, $4, 'UPSERT', $5, $6, $7, $8, $9)`,
            [
              input.tenantId,
              input.userId,
              input.idempotencyKey,
              input.grantId,
              input.requestSha256,
              input.contentSha256,
              input.objectKey,
              input.grantIssuedAt,
              input.expiresAt,
            ],
          );
          if (current?.object_key !== input.objectKey) {
            await client.query(
              `insert into integration.profile_photo_object_gc (tenant_id, object_key, delete_after)
               values ($1, $2, $3)
               on conflict (tenant_id, object_key) do update set
                 delete_after = greatest(integration.profile_photo_object_gc.delete_after,
                                         excluded.delete_after),
                 updated_at = now()`,
              [input.tenantId, input.objectKey, input.expiresAt],
            );
          }
        }
        return { replayed: false };
      });
    },

    finalizeClientAssistedPhoto(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
        const command = await queryOne<ClientPhotoCommandRow>(
          client,
          `select command_kind, idempotency_key, grant_id, request_sha256, content_sha256, object_key,
                  grant_issued_at, avatar_url
             from integration.profile_photo_client_commands
            where tenant_id = $1 and user_id = $2 and idempotency_key = $3
              and expires_at > now()
            for update`,
          [input.tenantId, input.userId, input.idempotencyKey],
        );
        if (!command || !commandMatches(command, input)) {
          throw new ProfilePhotoIdempotencyConflictError();
        }
        if (command.avatar_url) return { avatarUrl: command.avatar_url, replayed: true };
        const current = await queryOne<CurrentPhotoRow>(
          client,
          `select delivery_id, object_key, content_sha256, source_url, synced_at,
                  client_grant_issued_at
             from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        const watermark = await queryOne<PhotoObservationWatermarkRow>(
          client,
          `select observed_at
             from integration.profile_photo_observation_watermarks
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        if (
          grantIsStale(current, input.grantIssuedAt) ||
          watermarkIsStale(watermark, input.grantIssuedAt)
        ) {
          throw new ProfilePhotoGrantStaleError();
        }
        const deliveryId = current?.delivery_id ?? randomUUID();
        const avatarUrl = profilePhotoDeliveryUrl(input.tenantId, deliveryId);
        const updated = await client.query(
          `update profile.user_summaries
              set photo_url = $3, updated_at = now()
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.userId, avatarUrl],
        );
        if ((updated.rowCount ?? 0) !== 1) throw new Error('PROFILE_SUMMARY_NOT_FOUND');
        await client.query(
          `insert into integration.user_profile_photo_sync (
             tenant_id, user_id, delivery_id, source_url, source_etag, source_last_modified,
             content_sha256, object_key, synced_at, client_grant_issued_at
           ) values ($1, $2, $3, null, null, null, $4, $5, $6, $7)
           on conflict (tenant_id, user_id) do update set
             source_url = null,
             source_etag = null,
             source_last_modified = null,
             content_sha256 = excluded.content_sha256,
             object_key = excluded.object_key,
             synced_at = excluded.synced_at,
             client_grant_issued_at = excluded.client_grant_issued_at,
             updated_at = now()`,
          [
            input.tenantId,
            input.userId,
            deliveryId,
            input.contentSha256,
            input.objectKey,
            input.syncedAt,
            input.grantIssuedAt,
          ],
        );
        await client.query(
          `insert into integration.profile_photo_observation_watermarks (
             tenant_id, user_id, observed_at
           ) values ($1, $2, $3)
           on conflict (tenant_id, user_id) do update set
             observed_at = greatest(integration.profile_photo_observation_watermarks.observed_at,
                                    excluded.observed_at),
             updated_at = now()`,
          [input.tenantId, input.userId, input.grantIssuedAt],
        );
        if (current?.object_key && current.object_key !== input.objectKey) {
          await client.query(
            `insert into integration.profile_photo_object_gc (tenant_id, object_key, delete_after)
             values ($1, $2, $3::timestamptz + ($4::text || ' seconds')::interval)
             on conflict (tenant_id, object_key) do update set
               delete_after = least(integration.profile_photo_object_gc.delete_after,
                                    excluded.delete_after),
               updated_at = now()`,
            [
              input.tenantId,
              current.object_key,
              input.syncedAt,
              input.previousObjectRetentionSeconds,
            ],
          );
        }
        await client.query(
          `update integration.profile_photo_client_commands
              set avatar_url = $4, completed_at = now()
            where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
          [input.tenantId, input.userId, input.idempotencyKey, avatarUrl],
        );
        await client.query(
          `delete from integration.profile_photo_object_gc
            where tenant_id = $1 and object_key = $2`,
          [input.tenantId, input.objectKey],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'PROFILE_PHOTO_CLIENT_SYNC', 'PROFILE', $2,
                     'SUCCESS', $3, $4::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.correlationId,
            JSON.stringify({
              contentSha256: input.contentSha256,
              replayed: current?.content_sha256 === input.contentSha256,
            }),
          ],
        );
        return {
          avatarUrl,
          replayed:
            current?.content_sha256 === input.contentSha256 &&
            current.object_key === input.objectKey,
        };
      });
    },

    removeClientAssistedPhoto(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
        const previousCommand = await queryOne<ClientPhotoCommandRow>(
          client,
          `select command_kind, idempotency_key, grant_id, request_sha256, content_sha256,
                  object_key, grant_issued_at, avatar_url
             from integration.profile_photo_client_commands
            where tenant_id = $1 and user_id = $2
              and (idempotency_key = $3 or grant_id = $4)
            for update`,
          [input.tenantId, input.userId, input.idempotencyKey, input.grantId],
        );
        if (previousCommand) {
          if (!deleteCommandMatches(previousCommand, input)) {
            throw new ProfilePhotoIdempotencyConflictError();
          }
          return { removed: true, replayed: true };
        }
        const current = await queryOne<CurrentPhotoRow>(
          client,
          `select delivery_id, object_key, content_sha256, source_url, synced_at,
                  client_grant_issued_at
             from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        const watermark = await queryOne<PhotoObservationWatermarkRow>(
          client,
          `select observed_at
             from integration.profile_photo_observation_watermarks
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        if (
          grantIsStale(current, input.grantIssuedAt) ||
          watermarkIsStale(watermark, input.grantIssuedAt)
        ) {
          throw new ProfilePhotoGrantStaleError();
        }
        await client.query(
          `insert into integration.profile_photo_client_commands (
             tenant_id, user_id, idempotency_key, grant_id, command_kind,
             grant_issued_at, completed_at, expires_at
           ) values ($1, $2, $3, $4, 'DELETE', $5, now(), $6)`,
          [
            input.tenantId,
            input.userId,
            input.idempotencyKey,
            input.grantId,
            input.grantIssuedAt,
            input.expiresAt,
          ],
        );
        const updated = await client.query(
          `update profile.user_summaries
              set photo_url = null, updated_at = now()
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.userId],
        );
        if ((updated.rowCount ?? 0) !== 1) throw new Error('PROFILE_SUMMARY_NOT_FOUND');
        await client.query(
          `delete from integration.user_profile_photo_sync
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.userId],
        );
        await client.query(
          `insert into integration.profile_photo_observation_watermarks (
             tenant_id, user_id, observed_at
           ) values ($1, $2, $3)
           on conflict (tenant_id, user_id) do update set
             observed_at = greatest(integration.profile_photo_observation_watermarks.observed_at,
                                    excluded.observed_at),
             updated_at = now()`,
          [input.tenantId, input.userId, input.grantIssuedAt],
        );
        if (current?.object_key) {
          await client.query(
            `insert into integration.profile_photo_object_gc (tenant_id, object_key, delete_after)
             values ($1, $2, $3::timestamptz + ($4::text || ' seconds')::interval)
             on conflict (tenant_id, object_key) do update set
               delete_after = least(integration.profile_photo_object_gc.delete_after,
                                    excluded.delete_after),
               updated_at = now()`,
            [
              input.tenantId,
              current.object_key,
              input.observedAt,
              input.previousObjectRetentionSeconds,
            ],
          );
        }
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, old_value
           ) values ($1, $2, 'PROFILE_PHOTO_CLIENT_DELETE', 'PROFILE', $2,
                     'SUCCESS', $3, $4::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.correlationId,
            JSON.stringify({ deliveryId: current?.delivery_id ?? null }),
          ],
        );
        return { removed: true, replayed: false };
      });
    },

    getDisplayNames(tenantId, userIds) {
      if (userIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<
          { readonly user_id: string; readonly display_name: string } & QueryResultRow
        >(
          `select user_id, display_name
             from profile.user_summaries
            where tenant_id = $1 and user_id = any($2::uuid[])
              and nullif(btrim(display_name), '') is not null`,
          [tenantId, [...new Set(userIds)]],
        );
        return new Map(rows.rows.map((row) => [row.user_id, row.display_name.trim()]));
      });
    },

    getLevelValues(tenantId, userIds) {
      if (userIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<
          { readonly user_id: string; readonly level_value: number | string } & QueryResultRow
        >(
          `select user_id, level_value
             from profile.user_summaries
            where tenant_id = $1 and user_id = any($2::uuid[]) and level_value is not null`,
          [tenantId, [...new Set(userIds)]],
        );
        return new Map(
          rows.rows.flatMap((row) => {
            const value = levelValue(row.level_value);
            return value === null ? [] : [[row.user_id, value] as const];
          }),
        );
      });
    },
  };
}
