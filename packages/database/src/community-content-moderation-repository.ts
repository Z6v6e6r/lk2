import {
  COMMUNITY_COMMENT_MODERATION_HIDDEN_EVENT,
  COMMUNITY_COMMENT_MODERATION_RESTORED_EVENT,
  COMMUNITY_POST_MODERATION_APPROVED_EVENT,
  COMMUNITY_POST_MODERATION_REJECTED_EVENT,
  COMMUNITY_POST_MODERATION_HIDDEN_EVENT,
  COMMUNITY_POST_MODERATION_RESTORED_EVENT,
  communityCommentSchema,
  communityPendingModerationItemSchema,
  communityPostSchema,
  type CommunityComment,
  type CommunityContentModerationRepository,
  type CommunityModerateCommentInput,
  type CommunityModerateCommentResult,
  type CommunityModeratePostInput,
  type CommunityModeratePostResult,
  type CommunityReasonedModeratePostInput,
  type CommunityPost,
  type CommunityPostMedia,
} from '@phub/communities';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { appendCommunityEvent } from './community-event-store.js';
import {
  copyCommunityPostRevisionMediaWithClient,
  currentCommunityPostMediaWithClient,
} from './community-content-repository.js';
import { queryOne, withTenantTransaction } from './connection.js';

type ModerationCommand =
  | 'APPROVE_POST'
  | 'REJECT_POST'
  | 'HIDE_POST'
  | 'RESTORE_POST'
  | 'HIDE_COMMENT'
  | 'RESTORE_COMMENT';

interface PermissionRow extends QueryResultRow {
  readonly active: boolean;
  readonly authorized: boolean;
}

interface CommandRow extends QueryResultRow {
  readonly action: ModerationCommand;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface PostRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly author_user_id: string;
  readonly status: CommunityPost['status'];
  readonly body: string | null;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly published_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly archived_at: Date | string | null;
  readonly restore_until: Date | string | null;
  readonly retention_until: Date | string | null;
}

interface CommentRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly post_id: string;
  readonly author_user_id: string;
  readonly status: CommunityComment['status'];
  readonly body: string | null;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly published_at: Date | string;
  readonly updated_at: Date | string;
  readonly archived_at: Date | string | null;
  readonly restore_until: Date | string | null;
  readonly retention_until: Date | string | null;
}

const postColumns = `id, community_id, author_user_id, status, body, revision,
  created_at, published_at, updated_at, archived_at, restore_until, retention_until`;
const commentColumns = `id, community_id, post_id, author_user_id, status, body, revision,
  created_at, published_at, updated_at, archived_at, restore_until, retention_until`;

function timestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function postState(row: PostRow): CommunityPost {
  if (row.body === null) throw new Error('COMMUNITY_MODERATION_POST_BODY_PURGED');
  return communityPostSchema.parse({
    id: row.id,
    communityId: row.community_id,
    authorUserId: row.author_user_id,
    status: row.status,
    body: row.body,
    revision: Number(row.revision),
    createdAt: timestamp(row.created_at),
    publishedAt: timestamp(row.published_at),
    updatedAt: timestamp(row.updated_at),
    archivedAt: timestamp(row.archived_at),
    restoreUntil: timestamp(row.restore_until),
    retentionUntil: timestamp(row.retention_until),
  });
}

async function postStatesWithMedia(
  client: PoolClient,
  tenantId: string,
  rows: readonly PostRow[],
): Promise<readonly CommunityPost[]> {
  const mediaByPost = new Map<string, readonly CommunityPostMedia[]>();
  const rowsByCommunity = new Map<string, PostRow[]>();
  for (const row of rows) {
    const group = rowsByCommunity.get(row.community_id) ?? [];
    group.push(row);
    rowsByCommunity.set(row.community_id, group);
  }
  for (const [communityId, communityRows] of rowsByCommunity) {
    const current = await currentCommunityPostMediaWithClient(
      client,
      tenantId,
      communityId,
      communityRows.map((row) => row.id),
    );
    for (const [postId, media] of current) mediaByPost.set(postId, media);
  }
  return rows.map((row) => {
    const media = mediaByPost.get(row.id);
    return communityPostSchema.parse({
      ...postState(row),
      ...(media?.length ? { media } : {}),
    });
  });
}

function commentState(row: CommentRow): CommunityComment {
  if (row.body === null) throw new Error('COMMUNITY_MODERATION_COMMENT_BODY_PURGED');
  return communityCommentSchema.parse({
    id: row.id,
    communityId: row.community_id,
    postId: row.post_id,
    authorUserId: row.author_user_id,
    status: row.status,
    body: row.body,
    revision: Number(row.revision),
    createdAt: timestamp(row.created_at),
    publishedAt: timestamp(row.published_at),
    updatedAt: timestamp(row.updated_at),
    archivedAt: timestamp(row.archived_at),
    restoreUntil: timestamp(row.restore_until),
    retentionUntil: timestamp(row.retention_until),
  });
}

async function permission(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string },
  mode: 'read' | 'decide',
) {
  return queryOne<PermissionRow>(
    client,
    `select current_user.status = 'ACTIVE' as active,
            exists (
              select 1 from identity.user_access_profiles access
               where access.tenant_id = current_user.tenant_id
                 and access.user_id = current_user.id
                 and access.permissions && $3::text[]
            ) as authorized
       from identity.users current_user
      where current_user.tenant_id = $1 and current_user.id = $2`,
    [
      input.tenantId,
      input.actorUserId,
      mode === 'read'
        ? ['communities.content.moderation.read', 'communities.content.moderation.decide']
        : ['communities.content.moderation.decide'],
    ],
  );
}

async function readCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-content-moderation:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
  return queryOne<CommandRow>(
    client,
    `select action, request_hash, result_payload
       from community_content.moderation_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function record(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  },
  details: {
    readonly command: ModerationCommand;
    readonly action: 'APPROVE' | 'REJECT' | 'HIDE' | 'RESTORE';
    readonly targetType: 'POST' | 'COMMENT';
    readonly targetId: string;
    readonly previousStatus: string;
    readonly reasonCode?: string;
    readonly eventType: string;
    readonly state: CommunityPost | CommunityComment;
  },
) {
  const event = await appendCommunityEvent(client, {
    tenantId: input.tenantId,
    communityId: input.communityId,
    eventType: details.eventType,
    targetType: details.targetType,
    targetId: details.targetId,
    targetRevision: details.state.revision,
    targetStatus: details.state.status,
  });
  await client.query(
    `insert into community_content.moderation_commands (
       tenant_id, actor_user_id, community_id, action, target_id,
       idempotency_key, request_hash, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      details.command,
      details.targetId,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(details.state),
    ],
  );
  await client.query(
    `insert into community_content.moderation_actions (
       tenant_id, community_id, actor_user_id, target_type, target_id,
       action, previous_status, resulting_status, reason_code,
       target_revision, correlation_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.tenantId,
      input.communityId,
      input.actorUserId,
      details.targetType,
      details.targetId,
      details.action,
      details.previousStatus,
      details.state.status,
      details.reasonCode ?? null,
      details.state.revision,
      input.correlationId,
    ],
  );
  const evidence = {
    communityId: input.communityId,
    sequence: event.sequence,
    targetType: details.targetType,
    targetId: details.targetId,
    revision: details.state.revision,
    status: details.state.status,
    ...(details.reasonCode ? { reasonCode: details.reasonCode } : {}),
  };
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      `COMMUNITY_CONTENT_MODERATION_${details.action}`,
      `COMMUNITY_${details.targetType}`,
      details.targetId,
      input.correlationId,
      JSON.stringify(evidence),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      details.eventType,
      details.targetId,
      input.correlationId,
      JSON.stringify(evidence),
    ],
  );
}

function replayPost(
  command: CommandRow,
  expected: ModerationCommand,
  requestHash: string,
  outcome: 'approved' | 'rejected' | 'hidden' | 'restored',
): CommunityModeratePostResult {
  if (command.action !== expected || command.request_hash !== requestHash)
    return { outcome: 'idempotency_conflict' };
  return { outcome, post: communityPostSchema.parse(command.result_payload), replayed: true };
}

function replayComment(
  command: CommandRow,
  expected: ModerationCommand,
  requestHash: string,
  outcome: 'hidden' | 'restored',
): CommunityModerateCommentResult {
  if (command.action !== expected || command.request_hash !== requestHash)
    return { outcome: 'idempotency_conflict' };
  return { outcome, comment: communityCommentSchema.parse(command.result_payload), replayed: true };
}

export function createCommunityContentModerationRepository(
  pool: Pool,
): CommunityContentModerationRepository {
  return {
    listPending(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const access = await permission(client, input, 'read');
        if (!access?.active) return { outcome: 'actor_not_active' as const };
        if (!access.authorized) return { outcome: 'permission_denied' as const };
        if (input.communityId) {
          const community = await queryOne(
            client,
            `select id from communities.communities where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
            [input.tenantId, input.communityId],
          );
          if (!community) return { outcome: 'community_not_found' as const };
        }
        const result = await client.query<PostRow>(
          `select ${postColumns}
             from community_content.posts
            where tenant_id = $1 and status = 'PENDING_MODERATION'
              and ($2::uuid is null or community_id = $2)
              and ($3::timestamptz is null or (updated_at, id) > ($3::timestamptz, $4::uuid))
            order by updated_at, id
            limit $5`,
          [
            input.tenantId,
            input.communityId ?? null,
            input.after?.updatedAt ?? null,
            input.after?.id ?? null,
            input.limit + 1,
          ],
        );
        const pageRows = result.rows.slice(0, input.limit);
        const posts = await postStatesWithMedia(client, input.tenantId, pageRows);
        return {
          outcome: 'found' as const,
          items: posts.map((post) => communityPendingModerationItemSchema.parse({ post })),
          hasMore: result.rows.length > input.limit,
        };
      });
    },
    approvePost(input) {
      return changePost(pool, input, 'APPROVE_POST');
    },
    rejectPost(input) {
      return changePost(pool, input, 'REJECT_POST');
    },
    hidePost(input) {
      return changePost(pool, input, 'HIDE_POST');
    },
    restorePost(input) {
      return changePost(pool, input, 'RESTORE_POST');
    },
    hideComment(input) {
      return changeComment(pool, input, 'HIDE_COMMENT');
    },
    restoreComment(input) {
      return changeComment(pool, input, 'RESTORE_COMMENT');
    },
  };
}

async function authorizeCommand(
  client: PoolClient,
  input: { tenantId: string; actorUserId: string; communityId: string },
) {
  const access = await permission(client, input, 'decide');
  if (!access?.active) return 'actor_not_active' as const;
  if (!access.authorized) return 'permission_denied' as const;
  const community = await queryOne(
    client,
    `select id from communities.communities where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
    [input.tenantId, input.communityId],
  );
  return community ? undefined : ('community_not_found' as const);
}

async function changePost(
  pool: Pool,
  input: CommunityModeratePostInput | CommunityReasonedModeratePostInput,
  commandType: 'APPROVE_POST' | 'REJECT_POST' | 'HIDE_POST' | 'RESTORE_POST',
): Promise<CommunityModeratePostResult> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const denied = await authorizeCommand(client, input);
    if (denied) return { outcome: denied };
    const command = await readCommand(client, input);
    const outcome =
      commandType === 'APPROVE_POST'
        ? 'approved'
        : commandType === 'REJECT_POST'
          ? 'rejected'
          : commandType === 'HIDE_POST'
            ? 'hidden'
            : 'restored';
    if (command) return replayPost(command, commandType, input.requestHash, outcome);
    const current = await queryOne<PostRow>(
      client,
      `select ${postColumns} from community_content.posts where tenant_id = $1 and community_id = $2 and id = $3 for update`,
      [input.tenantId, input.communityId, input.postId],
    );
    if (!current) return { outcome: 'post_not_found' };
    const revision = Number(current.revision);
    if (revision !== input.expectedRevision)
      return { outcome: 'revision_conflict', currentRevision: revision };
    const expectedStatus =
      commandType === 'APPROVE_POST' || commandType === 'REJECT_POST'
        ? 'PENDING_MODERATION'
        : commandType === 'HIDE_POST'
          ? 'PUBLISHED'
          : 'HIDDEN';
    if (current.status !== expectedStatus) return { outcome: 'invalid_state' };
    const resultingStatus =
      commandType === 'REJECT_POST' || commandType === 'HIDE_POST' ? 'HIDDEN' : 'PUBLISHED';
    const row = await queryOne<PostRow>(
      client,
      `update community_content.posts
          set status = $4, revision = revision + 1, updated_at = now(),
              published_at = case when $4 = 'PUBLISHED' then coalesce(published_at, now()) else published_at end,
              hidden_at = case when $4 = 'HIDDEN' then now() else null end
        where tenant_id = $1 and community_id = $2 and id = $3 and revision = $5
      returning ${postColumns}`,
      [input.tenantId, input.communityId, input.postId, resultingStatus, input.expectedRevision],
    );
    if (!row) throw new Error('COMMUNITY_MODERATION_POST_UPDATE_FAILED');
    const initialState = postState(row);
    await client.query(
      `insert into community_content.post_revisions (tenant_id, post_id, revision, body, lifecycle_status, changed_by_user_id) values ($1, $2, $3, $4, $5, $6)`,
      [
        input.tenantId,
        initialState.id,
        initialState.revision,
        initialState.body,
        initialState.status,
        input.actorUserId,
      ],
    );
    await copyCommunityPostRevisionMediaWithClient(client, {
      tenantId: input.tenantId,
      communityId: input.communityId,
      postId: initialState.id,
      fromRevision: revision,
      toRevision: initialState.revision,
    });
    const state = (await postStatesWithMedia(client, input.tenantId, [row]))[0] as CommunityPost;
    const action =
      commandType === 'APPROVE_POST'
        ? 'APPROVE'
        : commandType === 'REJECT_POST'
          ? 'REJECT'
          : commandType === 'HIDE_POST'
            ? 'HIDE'
            : 'RESTORE';
    const eventType =
      commandType === 'APPROVE_POST'
        ? COMMUNITY_POST_MODERATION_APPROVED_EVENT
        : commandType === 'REJECT_POST'
          ? COMMUNITY_POST_MODERATION_REJECTED_EVENT
          : commandType === 'HIDE_POST'
            ? COMMUNITY_POST_MODERATION_HIDDEN_EVENT
            : COMMUNITY_POST_MODERATION_RESTORED_EVENT;
    await record(client, input, {
      command: commandType,
      action,
      targetType: 'POST',
      targetId: state.id,
      previousStatus: current.status,
      ...('reasonCode' in input ? { reasonCode: input.reasonCode } : {}),
      eventType,
      state,
    });
    return { outcome, post: state, replayed: false };
  });
}

async function changeComment(
  pool: Pool,
  input: CommunityModerateCommentInput,
  commandType: 'HIDE_COMMENT' | 'RESTORE_COMMENT',
): Promise<CommunityModerateCommentResult> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const denied = await authorizeCommand(client, input);
    if (denied) return { outcome: denied };
    const command = await readCommand(client, input);
    const outcome = commandType === 'HIDE_COMMENT' ? 'hidden' : 'restored';
    if (command) return replayComment(command, commandType, input.requestHash, outcome);
    const current = await queryOne<CommentRow>(
      client,
      `select ${commentColumns} from community_content.comments where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4 for update`,
      [input.tenantId, input.communityId, input.postId, input.commentId],
    );
    if (!current) return { outcome: 'comment_not_found' };
    const revision = Number(current.revision);
    if (revision !== input.expectedRevision)
      return { outcome: 'revision_conflict', currentRevision: revision };
    const expectedStatus = commandType === 'HIDE_COMMENT' ? 'PUBLISHED' : 'HIDDEN';
    if (current.status !== expectedStatus) return { outcome: 'invalid_state' };
    if (commandType === 'RESTORE_COMMENT') {
      const parent = await queryOne(
        client,
        `select id from community_content.posts where tenant_id = $1 and community_id = $2 and id = $3 and status = 'PUBLISHED' for share`,
        [input.tenantId, input.communityId, input.postId],
      );
      if (!parent) return { outcome: 'post_not_found' };
    }
    const resultingStatus = commandType === 'HIDE_COMMENT' ? 'HIDDEN' : 'PUBLISHED';
    const row = await queryOne<CommentRow>(
      client,
      `update community_content.comments
          set status = $5, revision = revision + 1, updated_at = now(),
              hidden_at = case when $5 = 'HIDDEN' then now() else null end
        where tenant_id = $1 and community_id = $2 and post_id = $3 and id = $4 and revision = $6
      returning ${commentColumns}`,
      [
        input.tenantId,
        input.communityId,
        input.postId,
        input.commentId,
        resultingStatus,
        input.expectedRevision,
      ],
    );
    if (!row) throw new Error('COMMUNITY_MODERATION_COMMENT_UPDATE_FAILED');
    const state = commentState(row);
    await client.query(
      `insert into community_content.comment_revisions (tenant_id, comment_id, revision, body, lifecycle_status, changed_by_user_id) values ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, state.id, state.revision, state.body, state.status, input.actorUserId],
    );
    const action = commandType === 'HIDE_COMMENT' ? 'HIDE' : 'RESTORE';
    const eventType =
      commandType === 'HIDE_COMMENT'
        ? COMMUNITY_COMMENT_MODERATION_HIDDEN_EVENT
        : COMMUNITY_COMMENT_MODERATION_RESTORED_EVENT;
    await record(client, input, {
      command: commandType,
      action,
      targetType: 'COMMENT',
      targetId: state.id,
      previousStatus: current.status,
      reasonCode: input.reasonCode,
      eventType,
      state,
    });
    return { outcome, comment: state, replayed: false };
  });
}
