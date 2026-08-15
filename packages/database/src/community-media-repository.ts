import { randomUUID } from 'node:crypto';

import {
  COMMUNITY_MEDIA_EXPIRED_EVENT,
  COMMUNITY_MEDIA_MAX_DAILY_BYTES_PER_USER,
  COMMUNITY_MEDIA_MAX_DAILY_ISSUES_PER_USER,
  COMMUNITY_MEDIA_MAX_OUTSTANDING_UPLOADS_PER_USER,
  COMMUNITY_MEDIA_MAX_PIPELINE_ITEMS_PER_USER,
  COMMUNITY_MEDIA_MAX_PER_POST,
  COMMUNITY_MEDIA_MAX_TENANT_PIPELINE_ITEMS,
  COMMUNITY_MEDIA_PURGED_EVENT,
  COMMUNITY_MEDIA_READY_EVENT,
  COMMUNITY_MEDIA_REJECTED_EVENT,
  COMMUNITY_MEDIA_SCAN_REQUESTED_EVENT,
  COMMUNITY_MEDIA_UNATTACHED_READY_TTL_HOURS,
  COMMUNITY_MEDIA_UPLOAD_REQUESTED_EVENT,
  communityMediaStatusSchema,
  communityMediaUploadIntentSchema,
  type CommunityFinalizeMediaUploadInput,
  type CommunityFinalizeMediaUploadPersistenceInput,
  type CommunityGetMediaInput,
  type CommunityGetMediaResult,
  type CommunityIssueMediaUploadPersistenceResult,
  type CommunityMediaFinalizeTargetResult,
  type CommunityMediaRepository,
  type CommunityMediaStatus,
  type CommunityMediaVariantName,
} from '@phub/communities';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

const MEDIA_ATTACHED_EVENT = 'community.media.attached.v1';

interface MediaRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly uploader_user_id: string;
  readonly state: CommunityMediaStatus['state'];
  readonly source_object_key: string;
  readonly source_object_version: string | null;
  readonly source_etag: string | null;
  readonly declared_content_type: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly declared_size_bytes: number | string;
  readonly declared_sha256: string;
  readonly revision: number | string;
  readonly upload_expires_at: Date | string;
  readonly finalized_at: Date | string | null;
  readonly ready_at: Date | string | null;
  readonly rejected_at: Date | string | null;
  readonly rejection_code: string | null;
  readonly unattached_expires_at: Date | string | null;
  readonly expired_at: Date | string | null;
  readonly purged_at: Date | string | null;
  readonly bound_post_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface VariantRow extends QueryResultRow {
  readonly id: string;
  readonly variant_name: CommunityMediaVariantName;
  readonly object_key: string;
  readonly object_version: string;
  readonly object_etag: string;
  readonly size_bytes: number | string;
  readonly width: number | string;
  readonly height: number | string;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: 'ISSUE_UPLOAD' | 'FINALIZE_UPLOAD';
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface OperationsCommandRow extends QueryResultRow {
  readonly operation: 'REPLAY_SCAN' | 'REPLAY_GC';
  readonly target_id: string;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface IssueContextRow extends QueryResultRow {
  readonly actor_active: boolean;
  readonly community_found: boolean;
  readonly member_active: boolean;
  readonly publishing_allowed: boolean;
}

interface IssueQuotaRow extends QueryResultRow {
  readonly outstanding_count: number | string;
  readonly outstanding_retry_after_seconds: number | string | null;
  readonly actor_pipeline_count: number | string;
  readonly daily_issue_count: number | string;
  readonly daily_bytes: number | string;
  readonly daily_retry_after_seconds: number | string | null;
  readonly tenant_pipeline_count: number | string;
}

const mediaColumns = `id, community_id, uploader_user_id, state, source_object_key,
  source_object_version, source_etag, declared_content_type, declared_size_bytes,
  declared_sha256, revision, upload_expires_at, finalized_at, ready_at,
  rejected_at, rejection_code, unattached_expires_at, expired_at, purged_at,
  bound_post_id, created_at, updated_at`;
const qualifiedMediaColumns = mediaColumns
  .split(',')
  .map((column) => `media.${column.trim()}`)
  .join(', ');

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mediaBase(row: MediaRow) {
  return {
    id: row.id,
    communityId: row.community_id,
    uploaderUserId: row.uploader_user_id,
    mediaType: 'IMAGE' as const,
    revision: Number(row.revision),
    declaredContentType: row.declared_content_type,
    declaredByteSize: Number(row.declared_size_bytes),
    declaredSha256: row.declared_sha256,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function uploadIntent(row: MediaRow) {
  return communityMediaUploadIntentSchema.parse({
    ...mediaBase(row),
    state: 'UPLOADING',
    objectKey: row.source_object_key,
    uploadExpiresAt: iso(row.upload_expires_at),
  });
}

async function variants(client: PoolClient, tenantId: string, mediaId: string) {
  const result = await client.query<VariantRow>(
    `select id, variant_name, object_key, object_version, object_etag,
            size_bytes, width, height
       from community_content.media_variants
      where tenant_id = $1 and media_id = $2 and state = 'ACTIVE'
      order by variant_name`,
    [tenantId, mediaId],
  );
  return result.rows;
}

async function mediaStatus(
  client: PoolClient,
  tenantId: string,
  row: MediaRow,
): Promise<CommunityMediaStatus> {
  const base = mediaBase(row);
  switch (row.state) {
    case 'UPLOADING':
      return communityMediaStatusSchema.parse({
        ...base,
        state: row.state,
        uploadExpiresAt: iso(row.upload_expires_at),
      });
    case 'SCANNING':
      if (!row.finalized_at) throw new Error('COMMUNITY_MEDIA_FINALIZED_AT_MISSING');
      return communityMediaStatusSchema.parse({
        ...base,
        state: row.state,
        finalizedAt: iso(row.finalized_at),
      });
    case 'READY': {
      if (!row.ready_at) throw new Error('COMMUNITY_MEDIA_READY_AT_MISSING');
      const [stored, tenant] = await Promise.all([
        variants(client, tenantId, row.id),
        queryOne<{ readonly tenant_key: string } & QueryResultRow>(
          client,
          'select tenant_key from identity.tenants where id = $1 and active = true',
          [tenantId],
        ),
      ]);
      if (stored.length === 0) throw new Error('COMMUNITY_MEDIA_VARIANTS_MISSING');
      if (!tenant) throw new Error('COMMUNITY_MEDIA_TENANT_MISSING');
      return communityMediaStatusSchema.parse({
        ...base,
        state: row.state,
        width: Math.max(...stored.map((item) => Number(item.width))),
        height: Math.max(...stored.map((item) => Number(item.height))),
        variants: stored.map((item) => ({
          variant: item.variant_name,
          url: `/user/api/v1/${tenant.tenant_key}/communities/${row.community_id}/media/${row.id}/variants/${item.variant_name}`,
          contentType: 'image/webp',
          width: Number(item.width),
          height: Number(item.height),
          byteSize: Number(item.size_bytes),
        })),
        readyAt: iso(row.ready_at),
        unattachedExpiresAt: isoOrNull(row.unattached_expires_at),
      });
    }
    case 'REJECTED':
      if (!row.rejected_at || !row.rejection_code) {
        throw new Error('COMMUNITY_MEDIA_REJECTION_MISSING');
      }
      return communityMediaStatusSchema.parse({
        ...base,
        state: row.state,
        rejectionCode: row.rejection_code,
        rejectedAt: iso(row.rejected_at),
      });
    case 'EXPIRED':
      if (!row.expired_at) throw new Error('COMMUNITY_MEDIA_EXPIRED_AT_MISSING');
      return communityMediaStatusSchema.parse({
        ...base,
        state: row.state,
        expiredAt: iso(row.expired_at),
      });
    case 'PURGED':
      if (!row.purged_at) throw new Error('COMMUNITY_MEDIA_PURGED_AT_MISSING');
      return communityMediaStatusSchema.parse({
        ...base,
        state: row.state,
        purgedAt: iso(row.purged_at),
      });
  }
}

async function lockCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<CommandRow | undefined> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-media:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from community_content.media_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function issueContext(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string; readonly communityId: string },
) {
  return queryOne<IssueContextRow>(
    client,
    `select coalesce(actor_user.status = 'ACTIVE', false) as actor_active,
            exists (
              select 1 from communities.communities community
               where community.tenant_id = $1 and community.id = $3
                 and community.status = 'ACTIVE'
            ) as community_found,
            exists (
              select 1 from communities.memberships membership
               where membership.tenant_id = $1 and membership.community_id = $3
                 and membership.user_id = $2 and membership.status = 'ACTIVE'
            ) as member_active,
            exists (
              select 1
                from communities.communities community
                join communities.memberships membership
                  on membership.tenant_id = community.tenant_id
                 and membership.community_id = community.id
                 and membership.user_id = $2
                 and membership.status = 'ACTIVE'
               where community.tenant_id = $1 and community.id = $3
                 and community.status = 'ACTIVE'
                 and (
                   community.publishing_preset <> 'STAFF_FEED'
                   or membership.role in ('OWNER', 'ADMIN', 'MODERATOR')
                 )
            ) as publishing_allowed
       from (values (1)) seed(value)
       left join identity.users actor_user
         on actor_user.tenant_id = $1 and actor_user.id = $2`,
    [input.tenantId, input.actorUserId, input.communityId],
  );
}

async function lockIssueQuota(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string },
): Promise<void> {
  for (const key of [
    `community-media-tenant-pipeline:${input.tenantId}`,
    `community-media-actor-quota:${input.tenantId}:${input.actorUserId}`,
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
         from community_content.media_assets
        where tenant_id = $1 and uploader_user_id = $2
          and state = 'UPLOADING' and upload_expires_at > now()
     ), actor_pipeline as (
       select count(*) as actor_pipeline_count
         from community_content.media_assets
        where tenant_id = $1 and uploader_user_id = $2
          and (
            state = 'SCANNING'
            or (state = 'UPLOADING' and upload_expires_at > now())
          )
     ), actor_daily as (
       select count(*) as daily_issue_count,
              coalesce(sum(declared_size_bytes), 0)::bigint as daily_bytes,
              ceil(extract(epoch from greatest(
                min(created_at) + interval '24 hours' - now(), interval '1 second'
              )))::bigint as daily_retry_after_seconds
         from community_content.media_assets
        where tenant_id = $1 and uploader_user_id = $2
          and created_at > now() - interval '24 hours'
     ), tenant_pipeline as (
       select count(*) as tenant_pipeline_count
         from community_content.media_assets
        where tenant_id = $1
          and (
            state = 'SCANNING'
            or (state = 'UPLOADING' and upload_expires_at > now())
          )
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
  if (!row) throw new Error('COMMUNITY_MEDIA_ISSUE_QUOTA_RESULT_INVALID');
  return row;
}

function quotaRetryAfter(value: number | string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.ceil(parsed) : fallback;
}

async function recordCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
  commandType: 'ISSUE_UPLOAD' | 'FINALIZE_UPLOAD',
  mediaId: string,
  result: unknown,
) {
  await client.query(
    `insert into community_content.media_commands (
       tenant_id, actor_user_id, community_id, command_type, media_id,
       idempotency_key, request_hash, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      commandType,
      mediaId,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(result),
    ],
  );
}

async function recordTransition(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly mediaId: string;
    readonly actorUserId?: string;
    readonly correlationId: string;
    readonly action: string;
    readonly eventType: string;
    readonly payload: Record<string, unknown>;
  },
) {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, 'COMMUNITY_MEDIA', $4, 'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId ?? null,
      input.action,
      input.mediaId,
      input.correlationId,
      JSON.stringify(input.payload),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      input.eventType,
      input.communityId,
      input.correlationId,
      JSON.stringify(input.payload),
    ],
  );
}

async function lockOperationsCommand(
  client: PoolClient,
  input: Pick<CommunityMediaReplayInput, 'tenantId' | 'actorUserId' | 'idempotencyKey'>,
): Promise<OperationsCommandRow | undefined> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-media-operations:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
  return queryOne<OperationsCommandRow>(
    client,
    `select operation, target_id, request_hash, result_payload
       from community_content.media_operations_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function canReplayMedia(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
): Promise<boolean> {
  const access = await queryOne<{ readonly allowed: boolean } & QueryResultRow>(
    client,
    `select viewer_user.status = 'ACTIVE'
            and coalesce(profile.permissions && array[
              'communities.content.moderation.decide'
            ]::text[], false) as allowed
       from identity.users viewer_user
       left join identity.user_access_profiles profile
         on profile.tenant_id = viewer_user.tenant_id and profile.user_id = viewer_user.id
      where viewer_user.tenant_id = $1 and viewer_user.id = $2`,
    [tenantId, actorUserId],
  );
  return access?.allowed === true;
}

async function recordOperationsCommand(
  client: PoolClient,
  input: CommunityMediaReplayInput,
  operation: OperationsCommandRow['operation'],
  result: CommunityMediaReplayResult,
): Promise<void> {
  await client.query(
    `insert into community_content.media_operations_commands (
       tenant_id, actor_user_id, operation, target_id,
       idempotency_key, request_hash, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      operation,
      input.targetId,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(result),
    ],
  );
}

function replayedOperationsResult(row: OperationsCommandRow): CommunityMediaReplayResult {
  if (!row.result_payload || typeof row.result_payload !== 'object') {
    throw new Error('COMMUNITY_MEDIA_REPLAY_RESULT_INVALID');
  }
  const result = row.result_payload as { readonly outcome?: unknown; readonly targetId?: unknown };
  if (result.outcome !== 'replayed' || typeof result.targetId !== 'string') {
    throw new Error('COMMUNITY_MEDIA_REPLAY_RESULT_INVALID');
  }
  return { outcome: 'replayed', targetId: result.targetId, replayed: true };
}

function replayedStatus(command: CommandRow): CommunityMediaStatus {
  return communityMediaStatusSchema.parse(command.result_payload);
}

export interface CommunityMediaScanClaim {
  readonly mediaId: string;
  readonly communityId: string;
  readonly sourceObjectKey: string;
  readonly sourceObjectVersion: string;
  readonly sourceEtag: string;
  readonly declaredContentType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly declaredByteSize: number;
  readonly declaredSha256: string;
  readonly scanAttempt: number;
}

export interface CommunityMediaReadyVariantInput {
  readonly variant: CommunityMediaVariantName;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly objectEtag: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface CommunityMediaGcClaim {
  readonly jobId: string;
  readonly mediaId: string;
  readonly objectKind: 'SOURCE' | 'VARIANT';
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly attempt: number;
}

export interface CommunityMediaExpiryClaim {
  readonly mediaId: string;
  readonly sourceObjectKey: string;
  readonly sourceObjectVersion?: string;
}

export type CommunityMediaAttachResult =
  | {
      readonly outcome: 'attached';
      readonly mediaIds: readonly string[];
      readonly replayed: boolean;
    }
  | { readonly outcome: 'post_revision_not_found' | 'media_not_ready' | 'media_not_owned' }
  | { readonly outcome: 'media_already_bound' }
  | { readonly outcome: 'revision_attachment_conflict' };

export interface CommunityMediaPersistenceRepository extends CommunityMediaRepository {
  claimScans(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly leaseSeconds: number;
    readonly limit: number;
  }): Promise<readonly CommunityMediaScanClaim[]>;
  completeScan(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly leaseOwner: string;
    readonly computedSourceSha256: string;
    readonly variants: readonly CommunityMediaReadyVariantInput[];
    readonly correlationId: string;
  }): Promise<'ready' | 'already_ready' | 'lease_lost' | 'source_checksum_mismatch'>;
  rejectScan(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly leaseOwner: string;
    readonly rejectionCode: string;
    readonly correlationId: string;
  }): Promise<'rejected' | 'already_rejected' | 'lease_lost'>;
  releaseScan(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly leaseOwner: string;
    readonly retryAt: string;
    readonly errorCode: string;
  }): Promise<boolean>;
  failScan(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly leaseOwner: string;
    readonly errorCode: string;
  }): Promise<boolean>;
  attachReadyMediaToPostRevision(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly postRevision: number;
    readonly mediaIds: readonly string[];
    readonly correlationId: string;
  }): Promise<CommunityMediaAttachResult>;
  expireDue(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<readonly CommunityMediaExpiryClaim[]>;
  scheduleExpiredSourceVersion(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly objectVersion: string;
  }): Promise<boolean>;
  confirmExpiredSourceAbsent(input: {
    readonly tenantId: string;
    readonly mediaId: string;
    readonly correlationId: string;
  }): Promise<boolean>;
  claimGc(input: {
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly leaseSeconds: number;
    readonly limit: number;
  }): Promise<readonly CommunityMediaGcClaim[]>;
  completeGc(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly correlationId: string;
  }): Promise<boolean>;
  failGc(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly retryAt: string;
    readonly errorCode: string;
  }): Promise<boolean>;
  deadLetterGc(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly errorCode: string;
  }): Promise<boolean>;
  replayFailedScan(input: CommunityMediaReplayInput): Promise<CommunityMediaReplayResult>;
  replayDeadGc(input: CommunityMediaReplayInput): Promise<CommunityMediaReplayResult>;
  getAuthorizedVariant(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly mediaId: string;
    readonly variant: CommunityMediaVariantName;
  }): Promise<
    | {
        readonly objectKey: string;
        readonly objectVersion: string;
        readonly objectEtag: string;
      }
    | undefined
  >;
  getModerationVariant(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly mediaId: string;
    readonly variant: CommunityMediaVariantName;
  }): Promise<
    | {
        readonly objectKey: string;
        readonly objectVersion: string;
        readonly objectEtag: string;
      }
    | undefined
  >;
}

export interface CommunityMediaReplayInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly reasonCode: string;
  readonly correlationId: string;
}

export type CommunityMediaReplayResult =
  | { readonly outcome: 'replayed'; readonly targetId: string; readonly replayed: boolean }
  | {
      readonly outcome:
        'idempotency_conflict' | 'permission_denied' | 'not_found' | 'invalid_state';
    };

function bounded(value: number, maximum: number, code: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(code);
}

function validCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(value);
}

async function scheduleSourceGc(client: PoolClient, tenantId: string, row: MediaRow) {
  if (!row.source_object_version) return;
  await client.query(
    `insert into community_content.media_gc_jobs (
       tenant_id, media_id, object_kind, object_key, object_version, available_at
     ) values ($1, $2, 'SOURCE', $3, $4, greatest(now(), $5::timestamptz))
     on conflict (tenant_id, object_key, object_version) do update
       set available_at = greatest(
         community_content.media_gc_jobs.available_at,
         excluded.available_at
       )
       where community_content.media_gc_jobs.state = 'PENDING'`,
    [
      tenantId,
      row.id,
      row.source_object_key,
      row.source_object_version,
      iso(row.upload_expires_at),
    ],
  );
}

async function scheduleVariantGc(client: PoolClient, tenantId: string, mediaId: string) {
  await client.query(
    `insert into community_content.media_gc_jobs (
       tenant_id, media_id, variant_id, object_kind, object_key, object_version
     )
     select tenant_id, media_id, id, 'VARIANT', object_key, object_version
       from community_content.media_variants
      where tenant_id = $1 and media_id = $2 and state = 'ACTIVE'
     on conflict (tenant_id, object_key, object_version) do nothing`,
    [tenantId, mediaId],
  );
}

export async function attachReadyMediaToPostRevisionWithClient(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly postId: string;
    readonly postRevision: number;
    readonly mediaIds: readonly string[];
    readonly correlationId: string;
  },
): Promise<CommunityMediaAttachResult> {
  if (
    input.mediaIds.length > COMMUNITY_MEDIA_MAX_PER_POST ||
    new Set(input.mediaIds).size !== input.mediaIds.length
  ) {
    return { outcome: 'revision_attachment_conflict' };
  }
  const post = await queryOne<{ readonly author_user_id: string } & QueryResultRow>(
    client,
    `select post.author_user_id
       from community_content.posts post
       join community_content.post_revisions revision
         on revision.tenant_id = post.tenant_id and revision.post_id = post.id
        and revision.revision = $4
      where post.tenant_id = $1 and post.community_id = $2 and post.id = $3
      for share`,
    [input.tenantId, input.communityId, input.postId, input.postRevision],
  );
  if (!post) return { outcome: 'post_revision_not_found' };
  if (post.author_user_id !== input.actorUserId) return { outcome: 'media_not_owned' };

  const existing = await client.query<{ readonly media_id: string } & QueryResultRow>(
    `select media_id
       from community_content.post_revision_media
      where tenant_id = $1 and post_id = $2 and post_revision = $3
      order by position`,
    [input.tenantId, input.postId, input.postRevision],
  );
  if (existing.rows.length > 0) {
    const ids = existing.rows.map((row) => row.media_id);
    return ids.length === input.mediaIds.length &&
      ids.every((id, index) => id === input.mediaIds[index])
      ? { outcome: 'attached', mediaIds: ids, replayed: true }
      : { outcome: 'revision_attachment_conflict' };
  }
  if (input.mediaIds.length === 0) {
    return { outcome: 'attached', mediaIds: [], replayed: false };
  }

  const locked = await client.query<
    {
      readonly id: string;
      readonly state: string;
      readonly uploader_user_id: string;
      readonly bound_post_id: string | null;
    } & QueryResultRow
  >(
    `select id, state, uploader_user_id, bound_post_id
       from community_content.media_assets
      where tenant_id = $1 and community_id = $2 and id = any($3::uuid[])
      order by id
      for update`,
    [input.tenantId, input.communityId, input.mediaIds],
  );
  if (
    locked.rows.length !== input.mediaIds.length ||
    locked.rows.some((row) => row.state !== 'READY')
  ) {
    return { outcome: 'media_not_ready' };
  }
  if (locked.rows.some((row) => row.uploader_user_id !== input.actorUserId)) {
    return { outcome: 'media_not_owned' };
  }
  if (locked.rows.some((row) => row.bound_post_id && row.bound_post_id !== input.postId)) {
    return { outcome: 'media_already_bound' };
  }
  await client.query(
    `update community_content.media_assets
        set bound_post_id = $4, unattached_expires_at = null,
            retention_until = null, updated_at = now()
      where tenant_id = $1 and community_id = $2 and id = any($3::uuid[])`,
    [input.tenantId, input.communityId, input.mediaIds, input.postId],
  );
  for (const [index, mediaId] of input.mediaIds.entries()) {
    await client.query(
      `insert into community_content.post_revision_media (
         tenant_id, community_id, post_id, post_revision, media_id, position
       ) values ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, input.communityId, input.postId, input.postRevision, mediaId, index + 1],
    );
  }
  await recordTransition(client, {
    tenantId: input.tenantId,
    communityId: input.communityId,
    mediaId: input.mediaIds[0] as string,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    action: 'COMMUNITY_MEDIA_ATTACHED',
    eventType: MEDIA_ATTACHED_EVENT,
    payload: {
      communityId: input.communityId,
      postId: input.postId,
      postRevision: input.postRevision,
      mediaIds: input.mediaIds,
    },
  });
  return { outcome: 'attached', mediaIds: input.mediaIds, replayed: false };
}

export function createCommunityMediaRepository(pool: Pool): CommunityMediaPersistenceRepository {
  return {
    issueUpload(input): Promise<CommunityIssueMediaUploadPersistenceResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockCommand(client, input);
        if (command) {
          if (
            command.command_type !== 'ISSUE_UPLOAD' ||
            command.request_hash !== input.requestHash
          ) {
            return { outcome: 'idempotency_conflict' };
          }
          const persistedIntent = communityMediaUploadIntentSchema.parse(command.result_payload);
          const context = await issueContext(client, input);
          if (!context?.actor_active) return { outcome: 'actor_not_active' };
          if (!context.community_found) return { outcome: 'community_not_found' };
          if (!context.member_active) return { outcome: 'membership_required' };
          if (!context.publishing_allowed) return { outcome: 'publishing_forbidden' };
          const current = await queryOne<MediaRow>(
            client,
            `select ${mediaColumns} from community_content.media_assets
              where tenant_id = $1 and id = $2 and community_id = $3
                and uploader_user_id = $4 and state = 'UPLOADING'
                and upload_expires_at > now()
              for update`,
            [input.tenantId, persistedIntent.id, input.communityId, input.actorUserId],
          );
          if (!current) return { outcome: 'upload_expired' };
          return {
            outcome: 'issued',
            intent: uploadIntent(current),
            replayed: true,
          };
        }
        const context = await issueContext(client, input);
        if (!context?.actor_active) return { outcome: 'actor_not_active' };
        if (!context.community_found) return { outcome: 'community_not_found' };
        if (!context.member_active) return { outcome: 'membership_required' };
        if (!context.publishing_allowed) return { outcome: 'publishing_forbidden' };

        await lockIssueQuota(client, input);
        const quota = await currentIssueQuota(client, input);
        if (Number(quota.outstanding_count) >= COMMUNITY_MEDIA_MAX_OUTSTANDING_UPLOADS_PER_USER) {
          return {
            outcome: 'outstanding_upload_quota_exceeded',
            retryAfterSeconds: quotaRetryAfter(quota.outstanding_retry_after_seconds, 60),
          };
        }
        if (Number(quota.actor_pipeline_count) >= COMMUNITY_MEDIA_MAX_PIPELINE_ITEMS_PER_USER) {
          return { outcome: 'actor_pipeline_quota_exceeded', retryAfterSeconds: 30 };
        }
        if (Number(quota.daily_issue_count) >= COMMUNITY_MEDIA_MAX_DAILY_ISSUES_PER_USER) {
          return {
            outcome: 'daily_issue_count_quota_exceeded',
            retryAfterSeconds: quotaRetryAfter(quota.daily_retry_after_seconds, 60),
          };
        }
        if (Number(quota.daily_bytes) + input.byteSize > COMMUNITY_MEDIA_MAX_DAILY_BYTES_PER_USER) {
          return {
            outcome: 'daily_declared_bytes_quota_exceeded',
            retryAfterSeconds: quotaRetryAfter(quota.daily_retry_after_seconds, 60),
          };
        }
        if (Number(quota.tenant_pipeline_count) >= COMMUNITY_MEDIA_MAX_TENANT_PIPELINE_ITEMS) {
          return { outcome: 'scan_backlog_quota_exceeded', retryAfterSeconds: 30 };
        }

        const mediaId = randomUUID();
        const sourceObjectKey = `community-media/quarantine/${input.tenantId}/${input.communityId}/${mediaId}/source`;
        const row = await queryOne<MediaRow>(
          client,
          `insert into community_content.media_assets (
             tenant_id, id, community_id, uploader_user_id, source_object_key,
             declared_content_type, declared_size_bytes, declared_sha256,
             upload_expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '15 minutes')
           returning ${mediaColumns}`,
          [
            input.tenantId,
            mediaId,
            input.communityId,
            input.actorUserId,
            sourceObjectKey,
            input.contentType,
            input.byteSize,
            input.sha256,
          ],
        );
        if (!row) throw new Error('COMMUNITY_MEDIA_ISSUE_WRITE_LOST');
        const intent = uploadIntent(row);
        await recordCommand(client, input, 'ISSUE_UPLOAD', mediaId, intent);
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: input.communityId,
          mediaId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_UPLOAD_REQUESTED',
          eventType: COMMUNITY_MEDIA_UPLOAD_REQUESTED_EVENT,
          payload: { communityId: input.communityId, mediaId, revision: intent.revision },
        });
        return { outcome: 'issued', intent, replayed: false };
      });
    },

    getFinalizeTarget(
      input: CommunityFinalizeMediaUploadInput,
    ): Promise<CommunityMediaFinalizeTargetResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockCommand(client, input);
        if (command) {
          if (
            command.command_type !== 'FINALIZE_UPLOAD' ||
            command.request_hash !== input.requestHash
          ) {
            return { outcome: 'idempotency_conflict' };
          }
          return { outcome: 'replayed', media: replayedStatus(command) };
        }
        const actor = await queryOne<{ readonly active: boolean } & QueryResultRow>(
          client,
          `select status = 'ACTIVE' as active from identity.users
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.actorUserId],
        );
        if (!actor?.active) return { outcome: 'actor_not_active' };
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and community_id = $2 and id = $3
              and uploader_user_id = $4`,
          [input.tenantId, input.communityId, input.mediaId, input.actorUserId],
        );
        if (!row) return { outcome: 'media_not_found' };
        if (Number(row.revision) !== input.expectedRevision) {
          return { outcome: 'invalid_state' };
        }
        if (row.state !== 'UPLOADING') return { outcome: 'invalid_state' };
        if (Date.parse(iso(row.upload_expires_at)) <= Date.now())
          return { outcome: 'upload_expired' };
        return { outcome: 'inspect', objectKey: row.source_object_key };
      });
    },

    finalizeUpload(input: CommunityFinalizeMediaUploadPersistenceInput) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockCommand(client, input);
        if (command) {
          if (
            command.command_type !== 'FINALIZE_UPLOAD' ||
            command.request_hash !== input.requestHash
          ) {
            return { outcome: 'idempotency_conflict' } as const;
          }
          return { outcome: 'finalized', media: replayedStatus(command), replayed: true } as const;
        }
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and community_id = $2 and id = $3
              and uploader_user_id = $4
            for update`,
          [input.tenantId, input.communityId, input.mediaId, input.actorUserId],
        );
        if (!row) return { outcome: 'media_not_found' } as const;
        if (Number(row.revision) !== input.expectedRevision) {
          return { outcome: 'revision_conflict', currentRevision: Number(row.revision) } as const;
        }
        if (row.state !== 'UPLOADING') return { outcome: 'invalid_state' } as const;
        if (Date.parse(iso(row.upload_expires_at)) <= Date.now()) {
          return { outcome: 'upload_expired' } as const;
        }
        if (
          input.observed.byteSize !== Number(row.declared_size_bytes) ||
          input.observed.contentType !== row.declared_content_type ||
          input.observed.checksumSha256 !== row.declared_sha256
        ) {
          return { outcome: 'object_mismatch' } as const;
        }
        const updated = await queryOne<MediaRow>(
          client,
          `update community_content.media_assets
              set state = 'SCANNING', source_object_version = $5,
                  source_etag = $6, source_content_type = $7,
                  source_size_bytes = $8, source_sha256 = $9,
                  finalized_at = now(), revision = revision + 1, updated_at = now()
            where tenant_id = $1 and community_id = $2 and id = $3
              and uploader_user_id = $4 and state = 'UPLOADING'
            returning ${mediaColumns}`,
          [
            input.tenantId,
            input.communityId,
            input.mediaId,
            input.actorUserId,
            input.observed.versionId,
            input.observed.etag,
            input.observed.contentType,
            input.observed.byteSize,
            input.observed.checksumSha256,
          ],
        );
        if (!updated) throw new Error('COMMUNITY_MEDIA_FINALIZE_WRITE_LOST');
        const status = await mediaStatus(client, input.tenantId, updated);
        await recordCommand(client, input, 'FINALIZE_UPLOAD', input.mediaId, status);
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: input.communityId,
          mediaId: input.mediaId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_SCAN_REQUESTED',
          eventType: COMMUNITY_MEDIA_SCAN_REQUESTED_EVENT,
          payload: {
            communityId: input.communityId,
            mediaId: input.mediaId,
            revision: status.revision,
          },
        });
        return { outcome: 'finalized', media: status, replayed: false } as const;
      });
    },

    getMedia(input: CommunityGetMediaInput): Promise<CommunityGetMediaResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const actor = await queryOne<{ readonly active: boolean } & QueryResultRow>(
          client,
          `select status = 'ACTIVE' as active from identity.users
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.actorUserId],
        );
        if (!actor?.active) return { outcome: 'actor_not_active' };
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and community_id = $2 and id = $3
              and uploader_user_id = $4`,
          [input.tenantId, input.communityId, input.mediaId, input.actorUserId],
        );
        return row
          ? { outcome: 'found', media: await mediaStatus(client, input.tenantId, row) }
          : { outcome: 'media_not_found' };
      });
    },

    claimScans(input) {
      bounded(input.limit, 100, 'COMMUNITY_MEDIA_SCAN_CLAIM_LIMIT_INVALID');
      bounded(input.leaseSeconds, 3_600, 'COMMUNITY_MEDIA_SCAN_LEASE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<MediaRow & { readonly scan_attempts: number | string }>(
          `with candidates as (
             select id
              from community_content.media_assets
              where tenant_id = $1 and state = 'SCANNING'
                and scan_failed_at is null
                and scan_available_at <= now()
                and (scan_lease_owner is null or scan_lease_expires_at <= now())
              order by finalized_at, id
              for update skip locked
              limit $2
           )
           update community_content.media_assets media
              set scan_lease_owner = $3,
                  scan_lease_expires_at = now() + make_interval(secs => $4),
                  scan_attempts = scan_attempts + 1,
                  last_scan_error_code = null,
                  updated_at = now()
             from candidates
            where media.tenant_id = $1 and media.id = candidates.id
           returning ${qualifiedMediaColumns}, media.scan_attempts`,
          [input.tenantId, input.limit, input.leaseOwner, input.leaseSeconds],
        );
        return result.rows.map((row) => {
          if (!row.source_object_version || !row.source_etag) {
            throw new Error('COMMUNITY_MEDIA_SOURCE_VERSION_MISSING');
          }
          return {
            mediaId: row.id,
            communityId: row.community_id,
            sourceObjectKey: row.source_object_key,
            sourceObjectVersion: row.source_object_version,
            sourceEtag: row.source_etag,
            declaredContentType: row.declared_content_type,
            declaredByteSize: Number(row.declared_size_bytes),
            declaredSha256: row.declared_sha256,
            scanAttempt: Number(row.scan_attempts),
          };
        });
      });
    },

    completeScan(input) {
      if (
        input.variants.length < 1 ||
        input.variants.length > 2 ||
        new Set(input.variants.map((item) => item.variant)).size !== input.variants.length
      ) {
        throw new Error('COMMUNITY_MEDIA_VARIANTS_INVALID');
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and id = $2 for update`,
          [input.tenantId, input.mediaId],
        );
        if (row?.state === 'READY') return 'already_ready';
        if (
          !row ||
          row.state !== 'SCANNING' ||
          !row.source_object_version ||
          row.source_etag === null
        ) {
          return 'lease_lost';
        }
        const lease = await queryOne<{ readonly valid: boolean } & QueryResultRow>(
          client,
          `select scan_lease_owner = $3 and scan_lease_expires_at > now() as valid
             from community_content.media_assets where tenant_id = $1 and id = $2`,
          [input.tenantId, input.mediaId, input.leaseOwner],
        );
        if (!lease?.valid) return 'lease_lost';
        if (input.computedSourceSha256 !== row.declared_sha256) {
          return 'source_checksum_mismatch';
        }
        for (const item of input.variants) {
          await client.query(
            `insert into community_content.media_variants (
               tenant_id, media_id, variant_name, object_key, object_version,
               object_etag, content_sha256, size_bytes, width, height
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              input.tenantId,
              input.mediaId,
              item.variant,
              item.objectKey,
              item.objectVersion,
              item.objectEtag,
              item.sha256,
              item.byteSize,
              item.width,
              item.height,
            ],
          );
        }
        const updated = await queryOne<MediaRow>(
          client,
          `update community_content.media_assets
              set state = 'READY', ready_at = now(),
                  unattached_expires_at = now() + make_interval(hours => $3),
                  scan_lease_owner = null, scan_lease_expires_at = null,
                  last_scan_error_code = null, revision = revision + 1, updated_at = now()
            where tenant_id = $1 and id = $2
            returning ${mediaColumns}`,
          [input.tenantId, input.mediaId, COMMUNITY_MEDIA_UNATTACHED_READY_TTL_HOURS],
        );
        if (!updated) throw new Error('COMMUNITY_MEDIA_READY_WRITE_LOST');
        await scheduleSourceGc(client, input.tenantId, row);
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: row.community_id,
          mediaId: row.id,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_READY',
          eventType: COMMUNITY_MEDIA_READY_EVENT,
          payload: {
            communityId: row.community_id,
            mediaId: row.id,
            revision: Number(updated.revision),
          },
        });
        return 'ready';
      });
    },

    rejectScan(input) {
      if (!validCode(input.rejectionCode))
        throw new Error('COMMUNITY_MEDIA_REJECTION_CODE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and id = $2 for update`,
          [input.tenantId, input.mediaId],
        );
        if (row?.state === 'REJECTED' && row.rejection_code === input.rejectionCode) {
          return 'already_rejected';
        }
        const lease =
          row?.state === 'SCANNING'
            ? await queryOne<{ readonly valid: boolean } & QueryResultRow>(
                client,
                `select scan_lease_owner = $3 and scan_lease_expires_at > now() as valid
                 from community_content.media_assets where tenant_id = $1 and id = $2`,
                [input.tenantId, input.mediaId, input.leaseOwner],
              )
            : undefined;
        if (!row || !lease?.valid) return 'lease_lost';
        const updated = await queryOne<MediaRow>(
          client,
          `update community_content.media_assets
              set state = 'REJECTED', rejection_code = $3, rejected_at = now(),
                  scan_lease_owner = null, scan_lease_expires_at = null,
                  revision = revision + 1, updated_at = now()
            where tenant_id = $1 and id = $2 returning ${mediaColumns}`,
          [input.tenantId, input.mediaId, input.rejectionCode],
        );
        if (!updated) throw new Error('COMMUNITY_MEDIA_REJECT_WRITE_LOST');
        await scheduleSourceGc(client, input.tenantId, row);
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: row.community_id,
          mediaId: row.id,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_REJECTED',
          eventType: COMMUNITY_MEDIA_REJECTED_EVENT,
          payload: {
            communityId: row.community_id,
            mediaId: row.id,
            revision: Number(updated.revision),
            rejectionCode: input.rejectionCode,
          },
        });
        return 'rejected';
      });
    },

    releaseScan(input) {
      if (!validCode(input.errorCode)) throw new Error('COMMUNITY_MEDIA_SCAN_ERROR_CODE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query(
          `update community_content.media_assets
              set scan_lease_owner = null, scan_lease_expires_at = null,
                  scan_available_at = $4::timestamptz,
                  last_scan_error_code = $5, updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'SCANNING'
              and scan_lease_owner = $3 and scan_lease_expires_at > now()`,
          [input.tenantId, input.mediaId, input.leaseOwner, input.retryAt, input.errorCode],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },

    failScan(input) {
      if (!validCode(input.errorCode)) throw new Error('COMMUNITY_MEDIA_SCAN_ERROR_CODE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query(
          `update community_content.media_assets
              set scan_lease_owner = null, scan_lease_expires_at = null,
                  scan_failed_at = now(), scan_failure_code = $4,
                  last_scan_error_code = $4, updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'SCANNING'
              and scan_failed_at is null
              and scan_lease_owner = $3 and scan_lease_expires_at > now()`,
          [input.tenantId, input.mediaId, input.leaseOwner, input.errorCode],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },

    attachReadyMediaToPostRevision(input) {
      return withTenantTransaction(pool, input.tenantId, (client) =>
        attachReadyMediaToPostRevisionWithClient(client, input),
      );
    },

    expireDue(input) {
      bounded(input.limit, 500, 'COMMUNITY_MEDIA_EXPIRY_LIMIT_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = await client.query<MediaRow>(
          `with candidates as (
             select id
               from community_content.media_assets
              where tenant_id = $1 and (
                (state = 'UPLOADING' and upload_expires_at <= now())
                or (state = 'READY' and bound_post_id is null and unattached_expires_at <= now())
                or (state = 'READY' and bound_post_id is not null and retention_until <= now())
              )
              order by coalesce(retention_until, unattached_expires_at, upload_expires_at), id
              for update skip locked
              limit $2
           )
           update community_content.media_assets media
              set state = 'EXPIRED', expired_at = now(), unattached_expires_at = null,
                  scan_lease_owner = null, scan_lease_expires_at = null,
                  revision = revision + 1, updated_at = now()
             from candidates
            where media.tenant_id = $1 and media.id = candidates.id
           returning ${qualifiedMediaColumns}`,
          [input.tenantId, input.limit],
        );
        for (const row of rows.rows) {
          await scheduleSourceGc(client, input.tenantId, row);
          await scheduleVariantGc(client, input.tenantId, row.id);
          await recordTransition(client, {
            tenantId: input.tenantId,
            communityId: row.community_id,
            mediaId: row.id,
            correlationId: input.correlationId,
            action: 'COMMUNITY_MEDIA_EXPIRED',
            eventType: COMMUNITY_MEDIA_EXPIRED_EVENT,
            payload: {
              communityId: row.community_id,
              mediaId: row.id,
              revision: Number(row.revision),
            },
          });
        }
        return rows.rows.map((row) => ({
          mediaId: row.id,
          sourceObjectKey: row.source_object_key,
          ...(row.source_object_version ? { sourceObjectVersion: row.source_object_version } : {}),
        }));
      });
    },

    scheduleExpiredSourceVersion(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and id = $2 and state = 'EXPIRED' for update`,
          [input.tenantId, input.mediaId],
        );
        if (!row || row.source_object_version) return false;
        await client.query(
          `update community_content.media_assets
              set source_object_version = $3, updated_at = now()
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.mediaId, input.objectVersion],
        );
        await scheduleSourceGc(client, input.tenantId, {
          ...row,
          source_object_version: input.objectVersion,
        });
        return true;
      });
    },

    confirmExpiredSourceAbsent(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<MediaRow>(
          client,
          `update community_content.media_assets
              set state = 'PURGED', purged_at = now(), revision = revision + 1, updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'EXPIRED'
              and source_object_version is null
              and not exists (
                select 1 from community_content.media_variants variant
                 where variant.tenant_id = $1 and variant.media_id = $2 and variant.state = 'ACTIVE'
              )
            returning ${mediaColumns}`,
          [input.tenantId, input.mediaId],
        );
        if (!row) return false;
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: row.community_id,
          mediaId: row.id,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_PURGED',
          eventType: COMMUNITY_MEDIA_PURGED_EVENT,
          payload: {
            communityId: row.community_id,
            mediaId: row.id,
            revision: Number(row.revision),
          },
        });
        return true;
      });
    },

    claimGc(input) {
      bounded(input.limit, 100, 'COMMUNITY_MEDIA_GC_CLAIM_LIMIT_INVALID');
      bounded(input.leaseSeconds, 3_600, 'COMMUNITY_MEDIA_GC_LEASE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<
          {
            readonly id: string;
            readonly media_id: string;
            readonly object_kind: 'SOURCE' | 'VARIANT';
            readonly object_key: string;
            readonly object_version: string;
            readonly attempts: number | string;
          } & QueryResultRow
        >(
          `with candidates as (
             select id
               from community_content.media_gc_jobs
              where tenant_id = $1 and available_at <= now()
                and dead_at is null
                and (state = 'PENDING' or (state = 'LEASED' and lease_expires_at <= now()))
              order by available_at, id
              for update skip locked
              limit $2
           )
           update community_content.media_gc_jobs job
              set state = 'LEASED', lease_owner = $3,
                  lease_expires_at = now() + make_interval(secs => $4),
                  attempts = attempts + 1, last_error_code = null
             from candidates
            where job.tenant_id = $1 and job.id = candidates.id
           returning job.id, job.media_id, job.object_kind, job.object_key,
                     job.object_version, job.attempts`,
          [input.tenantId, input.limit, input.leaseOwner, input.leaseSeconds],
        );
        return result.rows.map((row) => ({
          jobId: row.id,
          mediaId: row.media_id,
          objectKind: row.object_kind,
          objectKey: row.object_key,
          objectVersion: row.object_version,
          attempt: Number(row.attempts),
        }));
      });
    },

    completeGc(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const job = await queryOne<
          { readonly media_id: string; readonly variant_id: string | null } & QueryResultRow
        >(
          client,
          `update community_content.media_gc_jobs
              set state = 'DONE', lease_owner = null, lease_expires_at = null,
                  completed_at = now()
            where tenant_id = $1 and id = $2 and state = 'LEASED'
              and lease_owner = $3 and lease_expires_at > now()
            returning media_id, variant_id`,
          [input.tenantId, input.jobId, input.leaseOwner],
        );
        if (!job) return false;
        if (job.variant_id) {
          await client.query(
            `update community_content.media_variants
                set state = 'PURGED', purged_at = now()
              where tenant_id = $1 and id = $2 and state = 'ACTIVE'`,
            [input.tenantId, job.variant_id],
          );
        }
        const purged = await queryOne<MediaRow>(
          client,
          `update community_content.media_assets media
              set state = 'PURGED', purged_at = now(), revision = revision + 1, updated_at = now()
            where media.tenant_id = $1 and media.id = $2
              and media.state in ('REJECTED', 'EXPIRED')
              and not exists (
                select 1 from community_content.media_gc_jobs pending
                 where pending.tenant_id = media.tenant_id and pending.media_id = media.id
                   and pending.state <> 'DONE'
              )
            returning ${mediaColumns}`,
          [input.tenantId, job.media_id],
        );
        if (purged) {
          await recordTransition(client, {
            tenantId: input.tenantId,
            communityId: purged.community_id,
            mediaId: purged.id,
            correlationId: input.correlationId,
            action: 'COMMUNITY_MEDIA_PURGED',
            eventType: COMMUNITY_MEDIA_PURGED_EVENT,
            payload: {
              communityId: purged.community_id,
              mediaId: purged.id,
              revision: Number(purged.revision),
            },
          });
        }
        return true;
      });
    },

    failGc(input) {
      if (!validCode(input.errorCode)) throw new Error('COMMUNITY_MEDIA_GC_ERROR_CODE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query(
          `update community_content.media_gc_jobs
              set state = 'PENDING', lease_owner = null, lease_expires_at = null,
                  available_at = $4::timestamptz, last_error_code = $5
            where tenant_id = $1 and id = $2 and state = 'LEASED'
              and lease_owner = $3 and lease_expires_at > now()`,
          [input.tenantId, input.jobId, input.leaseOwner, input.retryAt, input.errorCode],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },

    deadLetterGc(input) {
      if (!validCode(input.errorCode)) throw new Error('COMMUNITY_MEDIA_GC_ERROR_CODE_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query(
          `update community_content.media_gc_jobs
              set state = 'PENDING', lease_owner = null, lease_expires_at = null,
                  dead_at = now(), failure_code = $4, last_error_code = $4
            where tenant_id = $1 and id = $2 and state = 'LEASED'
              and dead_at is null
              and lease_owner = $3 and lease_expires_at > now()`,
          [input.tenantId, input.jobId, input.leaseOwner, input.errorCode],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },

    replayFailedScan(input) {
      if (!validCode(input.reasonCode)) throw new Error('COMMUNITY_MEDIA_REPLAY_REASON_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockOperationsCommand(client, input);
        if (command) {
          if (
            command.operation !== 'REPLAY_SCAN' ||
            command.target_id !== input.targetId ||
            command.request_hash !== input.requestHash
          ) {
            return { outcome: 'idempotency_conflict' } as const;
          }
          return replayedOperationsResult(command);
        }
        if (!(await canReplayMedia(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'permission_denied' } as const;
        }
        const row = await queryOne<MediaRow>(
          client,
          `select ${mediaColumns} from community_content.media_assets
            where tenant_id = $1 and id = $2 for update`,
          [input.tenantId, input.targetId],
        );
        if (!row) return { outcome: 'not_found' } as const;
        const updated = await client.query(
          `update community_content.media_assets
              set scan_failed_at = null, scan_failure_code = null,
                  last_scan_error_code = null, scan_attempts = 0,
                  scan_available_at = now(), updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'SCANNING'
              and scan_failed_at is not null`,
          [input.tenantId, input.targetId],
        );
        if ((updated.rowCount ?? 0) !== 1) return { outcome: 'invalid_state' } as const;
        const result = { outcome: 'replayed', targetId: input.targetId, replayed: false } as const;
        await recordOperationsCommand(client, input, 'REPLAY_SCAN', result);
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: row.community_id,
          mediaId: row.id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_SCAN_REPLAYED',
          eventType: 'community.media.scan_replayed.v1',
          payload: {
            communityId: row.community_id,
            mediaId: row.id,
            reasonCode: input.reasonCode,
          },
        });
        return result;
      });
    },

    replayDeadGc(input) {
      if (!validCode(input.reasonCode)) throw new Error('COMMUNITY_MEDIA_REPLAY_REASON_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await lockOperationsCommand(client, input);
        if (command) {
          if (
            command.operation !== 'REPLAY_GC' ||
            command.target_id !== input.targetId ||
            command.request_hash !== input.requestHash
          ) {
            return { outcome: 'idempotency_conflict' } as const;
          }
          return replayedOperationsResult(command);
        }
        if (!(await canReplayMedia(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'permission_denied' } as const;
        }
        const job = await queryOne<
          {
            readonly media_id: string;
            readonly community_id: string;
            readonly dead_at: Date | string | null;
          } & QueryResultRow
        >(
          client,
          `select job.media_id, media.community_id, job.dead_at
             from community_content.media_gc_jobs job
             join community_content.media_assets media
               on media.tenant_id = job.tenant_id and media.id = job.media_id
            where job.tenant_id = $1 and job.id = $2 for update of job`,
          [input.tenantId, input.targetId],
        );
        if (!job) return { outcome: 'not_found' } as const;
        if (!job.dead_at) return { outcome: 'invalid_state' } as const;
        const updated = await client.query(
          `update community_content.media_gc_jobs
              set dead_at = null, failure_code = null, last_error_code = null,
                  attempts = 0, available_at = now()
            where tenant_id = $1 and id = $2 and state = 'PENDING' and dead_at is not null`,
          [input.tenantId, input.targetId],
        );
        if ((updated.rowCount ?? 0) !== 1) return { outcome: 'invalid_state' } as const;
        const result = { outcome: 'replayed', targetId: input.targetId, replayed: false } as const;
        await recordOperationsCommand(client, input, 'REPLAY_GC', result);
        await recordTransition(client, {
          tenantId: input.tenantId,
          communityId: job.community_id,
          mediaId: job.media_id,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'COMMUNITY_MEDIA_GC_REPLAYED',
          eventType: 'community.media.gc_replayed.v1',
          payload: {
            communityId: job.community_id,
            mediaId: job.media_id,
            gcJobId: input.targetId,
            reasonCode: input.reasonCode,
          },
        });
        return result;
      });
    },

    getAuthorizedVariant(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<
          {
            readonly object_key: string;
            readonly object_version: string;
            readonly object_etag: string;
          } & QueryResultRow
        >(
          client,
          `select variant.object_key, variant.object_version, variant.object_etag
             from community_content.media_variants variant
             join community_content.media_assets media
               on media.tenant_id = variant.tenant_id and media.id = variant.media_id
             join community_content.posts post
               on post.tenant_id = media.tenant_id and post.community_id = media.community_id
              and post.id = media.bound_post_id and post.status = 'PUBLISHED'
             join community_content.post_revision_media attachment
               on attachment.tenant_id = post.tenant_id and attachment.community_id = post.community_id
              and attachment.post_id = post.id and attachment.post_revision = post.revision
              and attachment.media_id = media.id
             join communities.communities community
               on community.tenant_id = media.tenant_id and community.id = media.community_id
              and community.status = 'ACTIVE'
            where variant.tenant_id = $1 and media.community_id = $2 and media.id = $3
              and variant.variant_name = $4 and variant.state = 'ACTIVE' and media.state = 'READY'
              and exists (
                select 1 from identity.users viewer
                 where viewer.tenant_id = $1 and viewer.id = $5 and viewer.status = 'ACTIVE'
              )
              and (
                community.visibility = 'PUBLIC'
                or exists (
                  select 1 from communities.memberships membership
                   where membership.tenant_id = $1 and membership.community_id = $2
                     and membership.user_id = $5 and membership.status = 'ACTIVE'
                )
              )`,
          [input.tenantId, input.communityId, input.mediaId, input.variant, input.viewerUserId],
        );
        return row
          ? {
              objectKey: row.object_key,
              objectVersion: row.object_version,
              objectEtag: row.object_etag,
            }
          : undefined;
      });
    },

    getModerationVariant(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<
          {
            readonly object_key: string;
            readonly object_version: string;
            readonly object_etag: string;
          } & QueryResultRow
        >(
          client,
          `select variant.object_key, variant.object_version, variant.object_etag
             from community_content.media_variants variant
             join community_content.media_assets media
               on media.tenant_id = variant.tenant_id and media.id = variant.media_id
             join community_content.posts post
               on post.tenant_id = media.tenant_id and post.community_id = media.community_id
              and post.id = media.bound_post_id
             join community_content.post_revision_media attachment
               on attachment.tenant_id = post.tenant_id and attachment.community_id = post.community_id
              and attachment.post_id = post.id and attachment.post_revision = post.revision
              and attachment.media_id = media.id
             join identity.users actor
               on actor.tenant_id = media.tenant_id and actor.id = $5 and actor.status = 'ACTIVE'
             join identity.user_access_profiles access
               on access.tenant_id = actor.tenant_id and access.user_id = actor.id
              and access.permissions && array[
                'communities.content.moderation.read',
                'communities.content.moderation.decide'
              ]::text[]
            where variant.tenant_id = $1 and media.community_id = $2 and media.id = $3
              and variant.variant_name = $4 and variant.state = 'ACTIVE' and media.state = 'READY'`,
          [input.tenantId, input.communityId, input.mediaId, input.variant, input.actorUserId],
        );
        return row
          ? {
              objectKey: row.object_key,
              objectVersion: row.object_version,
              objectEtag: row.object_etag,
            }
          : undefined;
      });
    },
  };
}
