import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

/** One chat message carries at most four attachments in display order. */
export const MESSAGING_MEDIA_MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** One chat attachment is at most 15 MiB, matching the accepted media lifecycle limit. */
export const MESSAGING_MEDIA_MAX_BYTES = 15 * 1024 * 1024;
export const MESSAGING_MEDIA_MAX_OUTSTANDING_UPLOADS_PER_USER = 10;
export const MESSAGING_MEDIA_MAX_PIPELINE_ITEMS_PER_USER = 20;
export const MESSAGING_MEDIA_MAX_DAILY_ISSUES_PER_USER = 100;
export const MESSAGING_MEDIA_MAX_DAILY_BYTES_PER_USER = 150 * 1024 * 1024;
export const MESSAGING_MEDIA_MAX_TENANT_PIPELINE_ITEMS = 100;
export const MESSAGING_MEDIA_UPLOAD_TTL_MS = 15 * 60 * 1_000;
export const MESSAGING_MEDIA_UNATTACHED_TTL_MS = 24 * 60 * 60 * 1_000;

export const MESSAGING_MEDIA_IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * A file attachment is always downloaded, never rendered inside our own origin, so only the content
 * types a browser would execute in place are refused outright.
 */
export const MESSAGING_MEDIA_FORBIDDEN_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
] as const;

export type MessagingMediaType = 'IMAGE' | 'FILE';
export type MessagingMediaState =
  'UPLOADING' | 'SCANNING' | 'READY' | 'REJECTED' | 'EXPIRED' | 'PURGED';

export interface MessagingMediaAsset {
  readonly id: string;
  readonly conversationId: string;
  readonly uploaderUserId: string;
  readonly mediaType: MessagingMediaType;
  readonly state: MessagingMediaState;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly revision: number;
  readonly readyObjectVersion: string | null;
  readonly readyAt: string | null;
  readonly rejectionCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessagingMediaUploadIntent {
  readonly id: string;
  readonly conversationId: string;
  readonly uploaderUserId: string;
  readonly mediaType: MessagingMediaType;
  readonly objectKey: string;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
  readonly declaredSha256: string;
  readonly uploadExpiresAt: string;
  readonly revision: number;
  readonly createdAt: string;
}

export interface MessagingMediaObservedObject {
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly etag: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly checksumSha256: string | null;
}

export type MessagingMediaFailureCode =
  | 'MESSAGING_MEDIA_NOT_FOUND'
  | 'MESSAGING_MEDIA_COMMAND_INVALID'
  | 'MESSAGING_MEDIA_CONTENT_TYPE_FORBIDDEN'
  | 'MESSAGING_MEDIA_SIZE_INVALID'
  | 'MESSAGING_MEDIA_OBJECT_MISMATCH'
  | 'MESSAGING_MEDIA_STATE_INVALID';

export interface MessagingMediaScanClaim {
  readonly mediaId: string;
  readonly conversationId: string;
  readonly uploaderUserId: string;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly etag: string;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
  readonly declaredSha256: string;
  readonly attempt: number;
  readonly leaseOwner: string;
}

export interface MessagingMediaGcClaim {
  readonly jobId: string;
  readonly mediaId: string;
  readonly objectKind: 'SOURCE' | 'READY';
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly attempt: number;
  readonly leaseOwner: string;
}

export interface MessagingMediaAttachmentSnapshot {
  readonly mediaId: string;
  readonly position: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly mediaType: MessagingMediaType;
}

export interface MessagingMediaRepository {
  issueUpload(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly conversationId: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<
    | {
        readonly outcome: 'issued';
        readonly intent: MessagingMediaUploadIntent;
        readonly replayed: boolean;
      }
    | { readonly outcome: 'not_found' }
    | { readonly outcome: 'state_invalid' }
    | { readonly outcome: 'idempotency_conflict' }
    | {
        readonly outcome:
          | 'outstanding_upload_quota_exceeded'
          | 'actor_pipeline_quota_exceeded'
          | 'daily_issue_count_quota_exceeded'
          | 'daily_declared_bytes_quota_exceeded'
          | 'scan_backlog_quota_exceeded';
        readonly retryAfterSeconds: number;
      }
  >;
  getFinalizeTarget(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly mediaId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<
    | { readonly outcome: 'inspect'; readonly objectKey: string }
    | {
        readonly outcome: 'finalized';
        readonly media: MessagingMediaAsset;
        readonly replayed: true;
      }
    | {
        readonly outcome: 'not_found' | 'upload_expired' | 'state_invalid' | 'idempotency_conflict';
      }
  >;
  finalizeUpload(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly mediaId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly observed: MessagingMediaObservedObject;
  }): Promise<
    | {
        readonly outcome: 'finalized';
        readonly media: MessagingMediaAsset;
        readonly replayed: boolean;
      }
    | {
        readonly outcome:
          | 'not_found'
          | 'upload_expired'
          | 'state_invalid'
          | 'object_missing'
          | 'object_mismatch'
          | 'idempotency_conflict';
      }
  >;
  getMedia(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly mediaId: string;
  }): Promise<
    | { readonly outcome: 'ok'; readonly media: MessagingMediaAsset }
    | { readonly outcome: 'not_found' }
  >;
  claimScans(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseSeconds: number;
  }): Promise<readonly MessagingMediaScanClaim[]>;
  completeScan(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly mediaId: string;
    readonly readyObjectKey: string;
    readonly readyObjectVersion: string;
    readonly correlationId: string;
  }): Promise<'ready' | 'lease_lost'>;
  rejectScan(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly mediaId: string;
    readonly rejectionCode: string;
    readonly correlationId: string;
  }): Promise<'rejected' | 'lease_lost'>;
  releaseScan(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly mediaId: string;
    readonly failureCode: string;
    readonly availableAt: Date;
  }): Promise<void>;
  failScan(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly mediaId: string;
    readonly failureCode: string;
    readonly correlationId: string;
  }): Promise<'rejected' | 'lease_lost'>;
  expireDue(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<
    readonly {
      readonly mediaId: string;
      readonly objectKey: string;
      readonly objectVersion: string | null;
    }[]
  >;
  scheduleExpiredSourceVersion(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly objectVersion: string;
  }): Promise<void>;
  confirmExpiredObjectsAbsent(input: {
    readonly tenantId: string;
    readonly mediaId: string;
  }): Promise<boolean>;
  claimGc(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseSeconds: number;
  }): Promise<readonly MessagingMediaGcClaim[]>;
  completeGc(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly jobId: string;
  }): Promise<'deleted' | 'lease_lost'>;
  failGc(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly jobId: string;
    readonly failureCode: string;
    readonly availableAt: Date;
  }): Promise<void>;
  deadLetterGc(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly jobId: string;
    readonly failureCode: string;
  }): Promise<void>;
}

/** The same column list, qualified for statements that join another relation with an id column. */
function mediaColumns(alias: string): string {
  return MEDIA_COLUMNS.split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');
}

const MEDIA_COLUMNS = `id, conversation_id, uploader_user_id, media_type, state, file_name,
       declared_content_type, declared_size_bytes, declared_sha256,
       source_object_key, source_object_version, source_etag, source_content_type,
       source_size_bytes, source_sha256, ready_object_key, ready_object_version, bound_message_id,
       revision, rejection_code, ready_at, finalized_at, upload_expires_at,
       unattached_expires_at, expired_at, purged_at, created_at, updated_at`;

interface MediaRow extends QueryResultRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly uploader_user_id: string;
  readonly media_type: MessagingMediaType;
  readonly state: MessagingMediaState;
  readonly file_name: string;
  readonly declared_content_type: string;
  readonly declared_size_bytes: string | number;
  readonly declared_sha256: string;
  readonly source_object_key: string;
  readonly source_object_version: string | null;
  readonly source_etag: string | null;
  readonly source_content_type: string | null;
  readonly source_size_bytes: string | number | null;
  readonly source_sha256: string | null;
  readonly ready_object_key: string | null;
  readonly ready_object_version: string | null;
  readonly bound_message_id: string | null;
  readonly revision: string | number;
  readonly rejection_code: string | null;
  readonly ready_at: Date | string | null;
  readonly finalized_at: Date | string | null;
  readonly upload_expires_at: Date | string;
  readonly unattached_expires_at: Date | string | null;
  readonly expired_at: Date | string | null;
  readonly purged_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  readonly media_id: string;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface IssueQuotaRow extends QueryResultRow {
  readonly outstanding_count: string | number;
  readonly outstanding_retry_after_seconds: string | number | null;
  readonly actor_pipeline_count: string | number;
  readonly daily_issue_count: string | number;
  readonly daily_bytes: string | number;
  readonly daily_retry_after_seconds: string | number | null;
  readonly tenant_pipeline_count: string | number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mediaTypeFor(contentType: string): MessagingMediaType {
  return (MESSAGING_MEDIA_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)
    ? 'IMAGE'
    : 'FILE';
}

function asset(row: MediaRow): MessagingMediaAsset {
  const observedSize = row.source_size_bytes ?? row.declared_size_bytes;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    uploaderUserId: row.uploader_user_id,
    mediaType: row.media_type,
    state: row.state,
    fileName: row.file_name,
    contentType: row.source_content_type ?? row.declared_content_type,
    byteSize: Number(observedSize),
    sha256: row.source_sha256 ?? row.declared_sha256,
    revision: Number(row.revision),
    readyObjectVersion: row.ready_object_version,
    readyAt: row.ready_at ? iso(row.ready_at) : null,
    rejectionCode: row.rejection_code,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function messagingMediaObjectKey(input: {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly mediaId: string;
}): { readonly source: string; readonly readyPrefix: string } {
  return {
    source: `chat-media/quarantine/${input.tenantId}/${input.conversationId}/${input.mediaId}/source`,
    readyPrefix: `chat-media/ready/${input.tenantId}/${input.conversationId}/${input.mediaId}`,
  };
}

async function lockCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `messaging-media:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
}

async function previousCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select media_id, request_hash, result_payload
       from messaging.media_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function recordCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
  commandType: 'ISSUE_UPLOAD' | 'FINALIZE_UPLOAD',
  mediaId: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `insert into messaging.media_commands (
       tenant_id, actor_user_id, idempotency_key, command_type, media_id, request_hash, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      commandType,
      mediaId,
      input.requestHash,
      JSON.stringify(result),
    ],
  );
}

async function recordTransition(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly actorUserId?: string;
    readonly correlationId: string;
    readonly action: string;
    readonly value: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, 'MESSAGING_MEDIA', $4, 'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId ?? null,
      input.action,
      input.mediaId,
      input.correlationId,
      JSON.stringify(input.value),
    ],
  );
}

async function authorizedConversationWriter(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly conversationId: string;
  },
): Promise<boolean> {
  const row = await queryOne<{ readonly allowed: boolean } & QueryResultRow>(
    client,
    `select exists (
              select 1
                from messaging.conversations conversation
                join messaging.conversation_members member
                  on member.tenant_id = conversation.tenant_id
                 and member.conversation_id = conversation.id
               where conversation.tenant_id = $1
                 and conversation.id = $2
                 and conversation.state = 'OPEN'
                 and member.user_id = $3
                 and member.member_type = 'USER'
                 and member.state = 'ACTIVE'
            ) as allowed`,
    [input.tenantId, input.conversationId, input.actorUserId],
  );
  return row?.allowed === true;
}

async function lockIssueQuota(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string },
): Promise<void> {
  for (const key of [
    `messaging-media-tenant-pipeline:${input.tenantId}`,
    `messaging-media-actor-quota:${input.tenantId}:${input.actorUserId}`,
  ]) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}

async function currentIssueQuota(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string },
): Promise<IssueQuotaRow> {
  const row = await queryOne<IssueQuotaRow>(
    client,
    `with actor_outstanding as (
       select count(*) as outstanding_count,
              ceil(extract(epoch from greatest(
                min(upload_expires_at) - now(), interval '1 second'
              )))::bigint as outstanding_retry_after_seconds
         from messaging.media_assets
        where tenant_id = $1 and uploader_user_id = $2
          and state = 'UPLOADING' and upload_expires_at > now()
     ), actor_pipeline as (
       select count(*) as actor_pipeline_count
         from messaging.media_assets
        where tenant_id = $1 and uploader_user_id = $2
          and (state = 'SCANNING' or (state = 'UPLOADING' and upload_expires_at > now()))
     ), actor_daily as (
       select count(*) as daily_issue_count,
              coalesce(sum(declared_size_bytes), 0)::bigint as daily_bytes,
              ceil(extract(epoch from greatest(
                min(created_at) + interval '24 hours' - now(), interval '1 second'
              )))::bigint as daily_retry_after_seconds
         from messaging.media_assets
        where tenant_id = $1 and uploader_user_id = $2
          and created_at > now() - interval '24 hours'
     ), tenant_pipeline as (
       select count(*) as tenant_pipeline_count
         from messaging.media_assets
        where tenant_id = $1
          and (state = 'SCANNING' or (state = 'UPLOADING' and upload_expires_at > now()))
     )
     select actor_outstanding.outstanding_count,
            actor_outstanding.outstanding_retry_after_seconds,
            actor_pipeline.actor_pipeline_count,
            actor_daily.daily_issue_count, actor_daily.daily_bytes,
            actor_daily.daily_retry_after_seconds,
            tenant_pipeline.tenant_pipeline_count
       from actor_outstanding cross join actor_pipeline
       cross join actor_daily cross join tenant_pipeline`,
    [input.tenantId, input.actorUserId],
  );
  if (!row) throw new Error('MESSAGING_MEDIA_ISSUE_QUOTA_RESULT_INVALID');
  return row;
}

function retryAfter(value: number | string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.ceil(parsed) : fallback;
}

/**
 * Chat media pipeline. One message may reference up to four assets, and the asset has to reach READY
 * through the private quarantine before the message that carries it exists. Object keys never leave
 * this boundary: a reader receives an authorized API path, and the API hands out a short-lived
 * signed URL.
 */
export function createMessagingMediaRepository(pool: Pool): MessagingMediaRepository {
  return {
    issueUpload(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, input);
        const previous = await previousCommand(client, input);
        if (previous) {
          if (previous.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' } as const;
          }
          const replayed = await queryOne<MediaRow>(
            client,
            `select ${MEDIA_COLUMNS} from messaging.media_assets
              where tenant_id = $1 and id = $2`,
            [input.tenantId, previous.media_id],
          );
          if (!replayed) return { outcome: 'not_found' } as const;
          const allowed = await authorizedConversationWriter(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            conversationId: replayed.conversation_id,
          });
          if (!allowed) return { outcome: 'not_found' } as const;
          if (
            replayed.state !== 'UPLOADING' ||
            Date.parse(iso(replayed.upload_expires_at)) <= Date.now()
          ) {
            return { outcome: 'state_invalid' } as const;
          }
          return {
            outcome: 'issued',
            replayed: true,
            intent: {
              id: replayed.id,
              conversationId: replayed.conversation_id,
              uploaderUserId: replayed.uploader_user_id,
              mediaType: replayed.media_type,
              objectKey: replayed.source_object_key,
              declaredContentType: replayed.declared_content_type,
              declaredByteSize: Number(replayed.declared_size_bytes),
              declaredSha256: replayed.declared_sha256,
              uploadExpiresAt: iso(replayed.upload_expires_at),
              revision: Number(replayed.revision),
              createdAt: iso(replayed.created_at),
            },
          } as const;
        }

        const allowed = await authorizedConversationWriter(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          conversationId: input.conversationId,
        });
        if (!allowed) return { outcome: 'not_found' } as const;

        await lockIssueQuota(client, input);
        const quota = await currentIssueQuota(client, input);
        if (Number(quota.outstanding_count) >= MESSAGING_MEDIA_MAX_OUTSTANDING_UPLOADS_PER_USER) {
          return {
            outcome: 'outstanding_upload_quota_exceeded',
            retryAfterSeconds: retryAfter(quota.outstanding_retry_after_seconds, 60),
          } as const;
        }
        if (Number(quota.actor_pipeline_count) >= MESSAGING_MEDIA_MAX_PIPELINE_ITEMS_PER_USER) {
          return { outcome: 'actor_pipeline_quota_exceeded', retryAfterSeconds: 30 } as const;
        }
        if (Number(quota.daily_issue_count) >= MESSAGING_MEDIA_MAX_DAILY_ISSUES_PER_USER) {
          return {
            outcome: 'daily_issue_count_quota_exceeded',
            retryAfterSeconds: retryAfter(quota.daily_retry_after_seconds, 60),
          } as const;
        }
        if (Number(quota.daily_bytes) + input.byteSize > MESSAGING_MEDIA_MAX_DAILY_BYTES_PER_USER) {
          return {
            outcome: 'daily_declared_bytes_quota_exceeded',
            retryAfterSeconds: retryAfter(quota.daily_retry_after_seconds, 60),
          } as const;
        }
        if (Number(quota.tenant_pipeline_count) >= MESSAGING_MEDIA_MAX_TENANT_PIPELINE_ITEMS) {
          return { outcome: 'scan_backlog_quota_exceeded', retryAfterSeconds: 30 } as const;
        }

        const mediaId = randomUUID();
        const keys = messagingMediaObjectKey({
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          mediaId,
        });
        const row = await queryOne<MediaRow>(
          client,
          `insert into messaging.media_assets (
             tenant_id, id, conversation_id, uploader_user_id, media_type, file_name,
             source_object_key, declared_content_type, declared_size_bytes, declared_sha256,
             upload_expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     now() + ($11::bigint * interval '1 millisecond'))
           returning ${MEDIA_COLUMNS}`,
          [
            input.tenantId,
            mediaId,
            input.conversationId,
            input.actorUserId,
            mediaTypeFor(input.contentType),
            input.fileName,
            keys.source,
            input.contentType,
            input.byteSize,
            input.sha256,
            MESSAGING_MEDIA_UPLOAD_TTL_MS,
          ],
        );
        if (!row) throw new Error('MESSAGING_MEDIA_ISSUE_WRITE_LOST');
        const intent: MessagingMediaUploadIntent = {
          id: row.id,
          conversationId: row.conversation_id,
          uploaderUserId: row.uploader_user_id,
          mediaType: row.media_type,
          objectKey: row.source_object_key,
          declaredContentType: row.declared_content_type,
          declaredByteSize: Number(row.declared_size_bytes),
          declaredSha256: row.declared_sha256,
          uploadExpiresAt: iso(row.upload_expires_at),
          revision: Number(row.revision),
          createdAt: iso(row.created_at),
        };
        await recordCommand(client, input, 'ISSUE_UPLOAD', mediaId, intent);
        await recordTransition(client, {
          tenantId: input.tenantId,
          mediaId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'MESSAGING_MEDIA_UPLOAD_REQUESTED',
          value: { conversationId: input.conversationId, mediaId, revision: intent.revision },
        });
        return { outcome: 'issued', intent, replayed: false } as const;
      });
    },

    getFinalizeTarget(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, input);
        const previous = await previousCommand(client, input);
        if (previous) {
          if (previous.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' } as const;
          }
          const replayed = await queryOne<MediaRow>(
            client,
            `select ${MEDIA_COLUMNS} from messaging.media_assets
              where tenant_id = $1 and id = $2`,
            [input.tenantId, previous.media_id],
          );
          if (!replayed) return { outcome: 'not_found' } as const;
          return { outcome: 'finalized', media: asset(replayed), replayed: true } as const;
        }
        const row = await queryOne<MediaRow>(
          client,
          `select ${MEDIA_COLUMNS} from messaging.media_assets
            where tenant_id = $1 and id = $2 and uploader_user_id = $3
            for update`,
          [input.tenantId, input.mediaId, input.actorUserId],
        );
        if (!row) return { outcome: 'not_found' } as const;
        if (row.state === 'READY') {
          return { outcome: 'finalized', media: asset(row), replayed: true } as const;
        }
        if (row.state !== 'UPLOADING') return { outcome: 'state_invalid' } as const;
        if (Date.parse(iso(row.upload_expires_at)) <= Date.now()) {
          return { outcome: 'upload_expired' } as const;
        }
        return { outcome: 'inspect', objectKey: row.source_object_key } as const;
      });
    },

    finalizeUpload(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, input);
        const previous = await previousCommand(client, input);
        if (previous) {
          if (previous.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' } as const;
          }
          const replayed = await queryOne<MediaRow>(
            client,
            `select ${MEDIA_COLUMNS} from messaging.media_assets
              where tenant_id = $1 and id = $2`,
            [input.tenantId, previous.media_id],
          );
          if (!replayed) return { outcome: 'not_found' } as const;
          return { outcome: 'finalized', media: asset(replayed), replayed: true } as const;
        }
        const row = await queryOne<MediaRow>(
          client,
          `select ${MEDIA_COLUMNS} from messaging.media_assets
            where tenant_id = $1 and id = $2 and uploader_user_id = $3
            for update`,
          [input.tenantId, input.mediaId, input.actorUserId],
        );
        if (!row) return { outcome: 'not_found' } as const;
        if (row.state === 'READY') {
          return { outcome: 'finalized', media: asset(row), replayed: true } as const;
        }
        if (row.state !== 'UPLOADING') return { outcome: 'state_invalid' } as const;
        if (Date.parse(iso(row.upload_expires_at)) <= Date.now()) {
          return { outcome: 'upload_expired' } as const;
        }
        const observed = input.observed;
        if (observed.objectKey !== row.source_object_key)
          return { outcome: 'object_mismatch' } as const;
        if (observed.byteSize !== Number(row.declared_size_bytes)) {
          return { outcome: 'object_mismatch' } as const;
        }
        if (observed.contentType !== row.declared_content_type) {
          return { outcome: 'object_mismatch' } as const;
        }
        if (
          observed.checksumSha256 !== null &&
          observed.checksumSha256.toLowerCase() !== row.declared_sha256.toLowerCase()
        ) {
          return { outcome: 'object_mismatch' } as const;
        }
        const updated = await queryOne<MediaRow>(
          client,
          `update messaging.media_assets
              set state = 'SCANNING',
                  source_object_version = $3,
                  source_etag = $4,
                  source_content_type = $5,
                  source_size_bytes = $6,
                  source_sha256 = $7,
                  finalized_at = now(),
                  scan_available_at = now(),
                  scan_lease_owner = null,
                  scan_lease_expires_at = null,
                  revision = revision + 1,
                  updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'UPLOADING'
            returning ${MEDIA_COLUMNS}`,
          [
            input.tenantId,
            input.mediaId,
            observed.objectVersion,
            observed.etag,
            observed.contentType,
            observed.byteSize,
            observed.checksumSha256?.toLowerCase() ?? null,
          ],
        );
        if (!updated) return { outcome: 'state_invalid' } as const;
        await recordCommand(client, input, 'FINALIZE_UPLOAD', input.mediaId, {
          mediaId: input.mediaId,
        });
        await recordTransition(client, {
          tenantId: input.tenantId,
          mediaId: input.mediaId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'MESSAGING_MEDIA_UPLOAD_FINALIZED',
          value: {
            conversationId: row.conversation_id,
            mediaId: input.mediaId,
            revision: Number(updated.revision),
          },
        });
        return { outcome: 'finalized', media: asset(updated), replayed: false } as const;
      });
    },

    getMedia(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `select ${MEDIA_COLUMNS} from messaging.media_assets
            where tenant_id = $1 and id = $2 and uploader_user_id = $3`,
          [input.tenantId, input.mediaId, input.actorUserId],
        );
        if (!row) return { outcome: 'not_found' } as const;
        return { outcome: 'ok', media: asset(row) } as const;
      });
    },

    claimScans(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = await client.query<MediaRow & { readonly attempt: string | number }>(
          `with claimable as (
             select id
               from messaging.media_assets
              where tenant_id = $1
                and state in ('UPLOADING', 'SCANNING')
                and scan_available_at <= now()
                and source_object_version is not null
                and (scan_lease_expires_at is null or scan_lease_expires_at <= now())
              order by scan_available_at, id
              limit $2
              for update skip locked
           )
           update messaging.media_assets asset
              set scan_lease_owner = $3,
                  scan_lease_expires_at = now() + ($4::bigint * interval '1 second'),
                  scan_attempts = asset.scan_attempts + 1,
                  updated_at = now()
             from claimable
            where asset.tenant_id = $1 and asset.id = claimable.id
            returning asset.id, asset.conversation_id, asset.uploader_user_id,
                      asset.source_object_key, asset.source_object_version, asset.source_etag,
                      asset.declared_content_type, asset.declared_size_bytes, asset.declared_sha256,
                      asset.scan_attempts as attempt`,
          [input.tenantId, input.limit, input.leaseOwner, input.leaseSeconds],
        );
        return rows.rows.map((row) => ({
          mediaId: row.id,
          conversationId: row.conversation_id,
          uploaderUserId: row.uploader_user_id,
          objectKey: row.source_object_key,
          objectVersion: String(row.source_object_version),
          etag: String(row.source_etag),
          declaredContentType: row.declared_content_type,
          declaredByteSize: Number(row.declared_size_bytes),
          declaredSha256: row.declared_sha256,
          attempt: Number(row.attempt),
          leaseOwner: input.leaseOwner,
        }));
      });
    },

    completeScan(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `update messaging.media_assets
              set state = 'READY',
                  ready_object_key = $4,
                  ready_object_version = $5,
                  ready_at = now(),
                  unattached_expires_at = now() + ($6::bigint * interval '1 millisecond'),
                  scan_lease_owner = null,
                  scan_lease_expires_at = null,
                  rejection_code = null,
                  revision = revision + 1,
                  updated_at = now()
            where tenant_id = $1 and id = $2 and scan_lease_owner = $3
              and state in ('UPLOADING', 'SCANNING')
            returning ${MEDIA_COLUMNS}`,
          [
            input.tenantId,
            input.mediaId,
            input.leaseOwner,
            input.readyObjectKey,
            input.readyObjectVersion,
            MESSAGING_MEDIA_UNATTACHED_TTL_MS,
          ],
        );
        if (!row) return 'lease_lost' as const;
        if (row.source_object_version) {
          await client.query(
            `insert into messaging.media_gc_jobs (
               tenant_id, media_id, object_kind, object_key, object_version, available_at
             ) values ($1, $2, 'SOURCE', $3, $4, greatest(now(), $5::timestamptz))
             on conflict (tenant_id, object_key, object_version) do nothing`,
            [
              input.tenantId,
              input.mediaId,
              row.source_object_key,
              row.source_object_version,
              iso(row.upload_expires_at),
            ],
          );
        }
        await recordTransition(client, {
          tenantId: input.tenantId,
          mediaId: input.mediaId,
          correlationId: input.correlationId,
          action: 'MESSAGING_MEDIA_READY',
          value: {
            conversationId: row.conversation_id,
            mediaId: input.mediaId,
            revision: Number(row.revision),
          },
        });
        return 'ready' as const;
      });
    },

    rejectScan(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `update messaging.media_assets
              set state = 'REJECTED',
                  rejection_code = $4,
                  rejected_at = now(),
                  scan_lease_owner = null,
                  scan_lease_expires_at = null,
                  revision = revision + 1,
                  updated_at = now()
            where tenant_id = $1 and id = $2 and scan_lease_owner = $3
              and state in ('UPLOADING', 'SCANNING')
            returning ${MEDIA_COLUMNS}`,
          [input.tenantId, input.mediaId, input.leaseOwner, input.rejectionCode],
        );
        if (!row) return 'lease_lost' as const;
        if (row.source_object_version) {
          await client.query(
            `insert into messaging.media_gc_jobs (
               tenant_id, media_id, object_kind, object_key, object_version, available_at
             ) values ($1, $2, 'SOURCE', $3, $4, now())
             on conflict (tenant_id, object_key, object_version) do nothing`,
            [input.tenantId, input.mediaId, row.source_object_key, row.source_object_version],
          );
        }
        await recordTransition(client, {
          tenantId: input.tenantId,
          mediaId: input.mediaId,
          correlationId: input.correlationId,
          action: 'MESSAGING_MEDIA_REJECTED',
          value: {
            conversationId: row.conversation_id,
            mediaId: input.mediaId,
            rejectionCode: input.rejectionCode,
          },
        });
        return 'rejected' as const;
      });
    },

    releaseScan(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          `update messaging.media_assets
              set scan_lease_owner = null,
                  scan_lease_expires_at = null,
                  scan_available_at = $4,
                  scan_failure_code = $5,
                  updated_at = now()
            where tenant_id = $1 and id = $2 and scan_lease_owner = $3`,
          [input.tenantId, input.mediaId, input.leaseOwner, input.availableAt, input.failureCode],
        );
      });
    },

    failScan(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `update messaging.media_assets
              set state = 'REJECTED',
                  rejection_code = $4,
                  rejected_at = now(),
                  scan_failed_at = now(),
                  scan_failure_code = $4,
                  scan_lease_owner = null,
                  scan_lease_expires_at = null,
                  revision = revision + 1,
                  updated_at = now()
            where tenant_id = $1 and id = $2 and scan_lease_owner = $3
              and state in ('UPLOADING', 'SCANNING')
            returning ${MEDIA_COLUMNS}`,
          [input.tenantId, input.mediaId, input.leaseOwner, input.failureCode],
        );
        if (!row) return 'lease_lost' as const;
        if (row.source_object_version) {
          await client.query(
            `insert into messaging.media_gc_jobs (
               tenant_id, media_id, object_kind, object_key, object_version, available_at
             ) values ($1, $2, 'SOURCE', $3, $4, now())
             on conflict (tenant_id, object_key, object_version) do nothing`,
            [input.tenantId, input.mediaId, row.source_object_key, row.source_object_version],
          );
        }
        return 'rejected' as const;
      });
    },

    expireDue(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = await client.query<MediaRow>(
          `with due as (
             select id
               from messaging.media_assets
              where tenant_id = $1
                and (
                  (state = 'UPLOADING' and upload_expires_at <= now())
                  -- A scan that never finishes because the scanner or the object store stays down
                  -- must not pin the quarantine object forever: after the stall window the upload
                  -- expires, the sender re-uploads, and the bytes are reclaimed.
                  or (state = 'SCANNING' and upload_expires_at <= now() - interval '24 hours')
                  or (state = 'READY' and bound_message_id is null and unattached_expires_at <= now())
                  -- An earlier cycle expired the asset but failed to discover its source version, so
                  -- the object was never scheduled for deletion. Return it until discovery succeeds;
                  -- an asset without a discovered version must never be confirmed PURGED.
                  or (state = 'EXPIRED' and purged_at is null and source_object_version is null)
                )
              order by id
              limit $2
              for update skip locked
           )
           update messaging.media_assets asset
              set state = 'EXPIRED',
                  expired_at = coalesce(asset.expired_at, now()),
                  scan_lease_owner = null,
                  scan_lease_expires_at = null,
                  revision = case
                    when asset.state = 'EXPIRED' then asset.revision
                    else asset.revision + 1
                  end,
                  updated_at = case
                    when asset.state = 'EXPIRED' then asset.updated_at
                    else now()
                  end
             from due
            where asset.tenant_id = $1 and asset.id = due.id
            returning ${mediaColumns('asset')}`,
          [input.tenantId, input.limit],
        );
        if (rows.rows.length > 0) {
          // Expiry schedules the exact object versions for deletion in the same transaction, so an
          // expired asset never keeps a reachable version behind.
          await client.query(
            `insert into messaging.media_gc_jobs (
               tenant_id, media_id, object_kind, object_key, object_version, available_at
             )
             select asset.tenant_id, asset.id, 'SOURCE', asset.source_object_key,
                    asset.source_object_version, now()
               from messaging.media_assets asset
              where asset.tenant_id = $1 and asset.id = any($2::uuid[])
                and asset.source_object_version is not null
             union all
             select asset.tenant_id, asset.id, 'READY', asset.ready_object_key,
                    asset.ready_object_version, now()
               from messaging.media_assets asset
              where asset.tenant_id = $1 and asset.id = any($2::uuid[])
                and asset.ready_object_key is not null and asset.ready_object_version is not null
             on conflict (tenant_id, object_key, object_version) do update
               set available_at = least(
                 messaging.media_gc_jobs.available_at, excluded.available_at
               )`,
            [input.tenantId, rows.rows.map((row) => row.id)],
          );
        }
        return rows.rows.map((row) => ({
          mediaId: row.id,
          objectKey: row.source_object_key,
          objectVersion: row.source_object_version,
        }));
      });
    },

    scheduleExpiredSourceVersion(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        // An abandoned upload never reached finalize, so the database does not know its object
        // version; the caller discovers it by key and records it here for exact deletion.
        await client.query(
          `insert into messaging.media_gc_jobs (
             tenant_id, media_id, object_kind, object_key, object_version, available_at
           )
           select asset.tenant_id, asset.id, 'SOURCE', asset.source_object_key, $3, now()
             from messaging.media_assets asset
            where asset.tenant_id = $1 and asset.id = $2
           on conflict (tenant_id, object_key, object_version) do update
             set available_at = least(messaging.media_gc_jobs.available_at, excluded.available_at)`,
          [input.tenantId, input.mediaId, input.objectVersion],
        );
      });
    },

    confirmExpiredObjectsAbsent(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<{ readonly id: string } & QueryResultRow>(
          client,
          `update messaging.media_assets
              set state = 'PURGED', purged_at = now(), revision = revision + 1, updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'EXPIRED'
              -- PURGED means every scheduled deletion completed. A dead-lettered job still holds
              -- bytes in the bucket, so the asset stays EXPIRED and the dead-letter metric, not a
              -- false PURGED row, is what surfaces the object for operator action.
              and not exists (
                select 1 from messaging.media_gc_jobs job
                 where job.tenant_id = $1 and job.media_id = $2
              )
            returning id`,
          [input.tenantId, input.mediaId],
        );
        return row !== undefined;
      });
    },

    claimGc(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = await client.query<{
          readonly id: string;
          readonly media_id: string;
          readonly object_kind: 'SOURCE' | 'READY';
          readonly object_key: string;
          readonly object_version: string;
          readonly attempt: string | number;
        }>(
          `with claimable as (
             select id
               from messaging.media_gc_jobs
              where tenant_id = $1
                and dead_at is null
                and available_at <= now()
                and (lease_expires_at is null or lease_expires_at <= now())
              order by available_at, id
              limit $2
              for update skip locked
           )
           update messaging.media_gc_jobs job
              set lease_owner = $3,
                  lease_expires_at = now() + ($4::bigint * interval '1 second'),
                  attempts = job.attempts + 1
             from claimable
            where job.tenant_id = $1 and job.id = claimable.id
            returning job.id, job.media_id, job.object_kind, job.object_key, job.object_version,
                      job.attempts as attempt`,
          [input.tenantId, input.limit, input.leaseOwner, input.leaseSeconds],
        );
        return rows.rows.map((row) => ({
          jobId: row.id,
          mediaId: row.media_id,
          objectKind: row.object_kind,
          objectKey: row.object_key,
          objectVersion: row.object_version,
          attempt: Number(row.attempt),
          leaseOwner: input.leaseOwner,
        }));
      });
    },

    completeGc(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const deleted = await client.query(
          `delete from messaging.media_gc_jobs
            where tenant_id = $1 and id = $2 and lease_owner = $3`,
          [input.tenantId, input.jobId, input.leaseOwner],
        );
        if ((deleted.rowCount ?? 0) === 0) return 'lease_lost' as const;
        return 'deleted' as const;
      });
    },

    failGc(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          `update messaging.media_gc_jobs
              set lease_owner = null,
                  lease_expires_at = null,
                  available_at = $4,
                  failure_code = $5
            where tenant_id = $1 and id = $2 and lease_owner = $3`,
          [input.tenantId, input.jobId, input.leaseOwner, input.availableAt, input.failureCode],
        );
      });
    },

    deadLetterGc(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          `update messaging.media_gc_jobs
              set dead_at = now(), failure_code = $4, lease_owner = null, lease_expires_at = null
            where tenant_id = $1 and id = $2 and lease_owner = $3`,
          [input.tenantId, input.jobId, input.leaseOwner, input.failureCode],
        );
      });
    },
  };
}

/**
 * Binds already-READY assets to a message inside the caller's transaction. The caller (message send)
 * supplies the client so the message row, its ordered attachment snapshot and the asset binding
 * commit together; a fifth attachment, a foreign asset or an unscanned asset fails the whole send.
 */
export async function attachReadyMediaToMessageWithClient(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderUserId: string;
    readonly mediaIds: readonly string[];
  },
): Promise<readonly MessagingMediaAttachmentSnapshot[]> {
  const unique = [...new Set(input.mediaIds)];
  if (unique.length !== input.mediaIds.length) {
    throw new Error('MESSAGING_ATTACHMENT_DUPLICATE');
  }
  if (unique.length > MESSAGING_MEDIA_MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error('MESSAGING_ATTACHMENT_LIMIT_EXCEEDED');
  }
  if (unique.length === 0) return [];
  const assets = await client.query<MediaRow>(
    `select ${MEDIA_COLUMNS}
       from messaging.media_assets
      where tenant_id = $1 and id = any($2::uuid[])
      order by id
      for update`,
    [input.tenantId, unique],
  );
  if (assets.rows.length !== unique.length) throw new Error('MESSAGING_ATTACHMENT_NOT_FOUND');
  const snapshots: MessagingMediaAttachmentSnapshot[] = [];
  for (const [index, mediaId] of unique.entries()) {
    const row = assets.rows.find((candidate) => candidate.id === mediaId);
    if (!row) throw new Error('MESSAGING_ATTACHMENT_NOT_FOUND');
    if (row.conversation_id !== input.conversationId)
      throw new Error('MESSAGING_ATTACHMENT_NOT_FOUND');
    if (row.uploader_user_id !== input.senderUserId)
      throw new Error('MESSAGING_ATTACHMENT_FORBIDDEN');
    if (row.state !== 'READY' || !row.ready_object_key) {
      throw new Error('MESSAGING_ATTACHMENT_NOT_READY');
    }
    if (row.bound_message_id && row.bound_message_id !== input.messageId) {
      throw new Error('MESSAGING_ATTACHMENT_ALREADY_BOUND');
    }
    await client.query(
      `update messaging.media_assets
          set bound_conversation_id = $3,
              bound_message_id = $4,
              unattached_expires_at = null,
              revision = revision + 1,
              updated_at = now()
        where tenant_id = $1 and id = $2`,
      [input.tenantId, mediaId, input.conversationId, input.messageId],
    );
    await client.query(
      `insert into messaging.message_attachments (
         tenant_id, conversation_id, message_id, object_key, file_name, content_type,
         size_bytes, sha256, scan_state, ready_at, media_id, uploader_user_id, position
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'READY', $9, $10, $11, $12)`,
      [
        input.tenantId,
        input.conversationId,
        input.messageId,
        row.ready_object_key,
        fileNameFor(row),
        row.source_content_type ?? row.declared_content_type,
        Number(row.source_size_bytes ?? row.declared_size_bytes),
        row.source_sha256 ?? row.declared_sha256,
        row.ready_at,
        row.id,
        input.senderUserId,
        index + 1,
      ],
    );
    snapshots.push({
      mediaId: row.id,
      position: index + 1,
      fileName: fileNameFor(row),
      contentType: row.source_content_type ?? row.declared_content_type,
      byteSize: Number(row.source_size_bytes ?? row.declared_size_bytes),
      mediaType: row.media_type,
    });
  }
  return snapshots;
}

function fileNameFor(row: MediaRow): string {
  return row.file_name;
}

/**
 * Ordered attachment snapshots for a whole message page in one query. The caller passes only the
 * messages it is about to return, so a hidden message never leaks an attachment.
 */
export async function listAttachmentsForMessagesWithClient(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageIds: readonly string[];
  },
): Promise<readonly MessagingMediaAttachmentSnapshotWithMessage[]> {
  if (input.messageIds.length === 0) return [];
  const rows = await client.query<{
    readonly message_id: string;
    readonly media_id: string;
    readonly position: number;
    readonly file_name: string;
    readonly content_type: string;
    readonly size_bytes: string | number;
    readonly media_type: MessagingMediaType | null;
  }>(
    `select attachment.message_id, attachment.media_id, attachment.position,
            attachment.file_name, attachment.content_type, attachment.size_bytes,
            media.media_type
       from messaging.message_attachments attachment
       left join messaging.media_assets media
         on media.tenant_id = attachment.tenant_id and media.id = attachment.media_id
      where attachment.tenant_id = $1
        and attachment.conversation_id = $2
        and attachment.message_id = any($3::uuid[])
      order by attachment.message_id, attachment.position`,
    [input.tenantId, input.conversationId, input.messageIds],
  );
  return rows.rows.map((row) => ({
    messageId: row.message_id,
    mediaId: row.media_id,
    position: row.position,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: Number(row.size_bytes),
    mediaType: row.media_type ?? 'FILE',
  }));
}

export interface MessagingMediaAttachmentSnapshotWithMessage extends MessagingMediaAttachmentSnapshot {
  readonly messageId: string;
}

/** Ordered attachment snapshots for one message; readers receive them only for visible messages. */
export async function listMessageAttachmentsWithClient(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
  },
): Promise<readonly MessagingMediaAttachmentSnapshot[]> {
  const rows = await client.query<{
    readonly media_id: string;
    readonly position: number;
    readonly file_name: string;
    readonly content_type: string;
    readonly size_bytes: string | number;
    readonly media_type: MessagingMediaType | null;
  }>(
    `select attachment.media_id, attachment.position, attachment.file_name,
            attachment.content_type, attachment.size_bytes, media.media_type
       from messaging.message_attachments attachment
       left join messaging.media_assets media
         on media.tenant_id = attachment.tenant_id and media.id = attachment.media_id
      where attachment.tenant_id = $1
        and attachment.conversation_id = $2
        and attachment.message_id = $3
      order by attachment.position`,
    [input.tenantId, input.conversationId, input.messageId],
  );
  return rows.rows.map((row) => ({
    mediaId: row.media_id,
    position: row.position,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: Number(row.size_bytes),
    mediaType: row.media_type ?? 'FILE',
  }));
}
