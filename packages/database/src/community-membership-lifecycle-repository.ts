import {
  COMMUNITY_JOIN_APPROVED_EVENT,
  COMMUNITY_JOIN_CANCELLED_EVENT,
  COMMUNITY_JOIN_REJECTED_EVENT,
  COMMUNITY_JOIN_REQUESTED_EVENT,
  COMMUNITY_MEMBER_JOINED_EVENT,
  COMMUNITY_MEMBER_LEFT_EVENT,
  communityDecidedJoinRequestSchema,
  communityOwnMembershipStateSchema,
  communityPendingJoinRequestSchema,
  type CommunityApproveJoinInput,
  type CommunityApproveJoinResult,
  type CommunityCancelPendingInput,
  type CommunityCancelPendingResult,
  type CommunityDecidedJoinRequest,
  type CommunityGetOwnStateInput,
  type CommunityGetOwnStateResult,
  type CommunityLeaveInput,
  type CommunityLeaveResult,
  type CommunityListPendingInput,
  type CommunityListPendingResult,
  type CommunityMembershipLifecycleRepository,
  type CommunityOwnMembershipState,
  type CommunityPendingJoinRequest,
  type CommunityRejectJoinInput,
  type CommunityRejectJoinResult,
  type CommunitySelfJoinInput,
  type CommunitySelfJoinResult,
} from '@phub/communities';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

type CommandType = 'JOIN' | 'CANCEL_JOIN_REQUEST' | 'LEAVE' | 'DECIDE_JOIN_REQUEST';
type MembershipStatus = 'PENDING' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
type MembershipRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
type RequestOrigin = 'ABSENT' | 'LEFT' | 'REMOVED';
type JoinPolicy = CommunityRow['join_policy'];
type RestoredMembership = Extract<
  CommunityOwnMembershipState,
  { status: 'ABSENT' | 'LEFT' | 'REMOVED' }
>;
type MemberActiveMembership = Extract<CommunityOwnMembershipState, { status: 'ACTIVE' }> & {
  readonly role: 'MEMBER';
};
type DecidedRequestWithState<TState extends 'APPROVED' | 'REJECTED' | 'CANCELLED'> =
  CommunityDecidedJoinRequest & { readonly state: TState };

interface ActorRow extends QueryResultRow {
  readonly status: string;
}

interface CommunityRow extends QueryResultRow {
  readonly join_policy: 'INSTANT' | 'MODERATED' | 'INVITE_ONLY';
  readonly visibility: 'OPEN' | 'CLOSED' | 'PUBLIC' | 'LISTED_PRIVATE' | 'HIDDEN';
}

interface MembershipRow extends QueryResultRow {
  readonly status: MembershipStatus;
  readonly role: MembershipRole;
  readonly revision: number | string;
  readonly updated_at: Date | string;
}

interface JoinRequestRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly user_id: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  readonly origin_status: RequestOrigin;
  readonly revision: number | string;
  readonly requested_at: Date | string;
  readonly decided_by: string | null;
  readonly decided_at: Date | string | null;
  readonly decision_reason_code: string | null;
}

interface PendingQueueRow extends JoinRequestRow {
  readonly membership_revision: number | string;
  readonly sort_requested_at: string;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: CommandType;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface PermissionRow extends QueryResultRow {
  readonly authorized: boolean;
}

interface RequestLocatorRow extends QueryResultRow {
  readonly community_id: string;
  readonly user_id: string;
}

interface CursorValue {
  readonly v: 1;
  readonly communityId: string | null;
  readonly requestedAt: string;
  readonly id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function inactiveJoinAction(
  status: 'ABSENT' | 'LEFT' | 'REMOVED' | 'BANNED',
  joinPolicy: JoinPolicy,
) {
  if (status === 'BANNED') return 'UNAVAILABLE' as const;
  if (status === 'REMOVED') {
    return joinPolicy === 'INVITE_ONLY'
      ? ('INVITE_REQUIRED' as const)
      : ('REQUEST_REJOIN' as const);
  }
  if (joinPolicy === 'INSTANT') return 'JOIN_NOW' as const;
  if (joinPolicy === 'MODERATED') return 'REQUEST_TO_JOIN' as const;
  return 'INVITE_REQUIRED' as const;
}

function absentMembership(
  communityId: string,
  joinPolicy: JoinPolicy,
): CommunityOwnMembershipState {
  return communityOwnMembershipStateSchema.parse({
    communityId,
    status: 'ABSENT',
    role: null,
    revision: 0,
    pendingRequest: null,
    joinAction: inactiveJoinAction('ABSENT', joinPolicy),
    updatedAt: null,
  });
}

function pendingRequest(row: JoinRequestRow): CommunityPendingJoinRequest {
  return communityPendingJoinRequestSchema.parse({
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    state: 'PENDING',
    originStatus: row.origin_status,
    revision: Number(row.revision),
    requestedAt: timestamp(row.requested_at),
  });
}

function decidedRequest(row: JoinRequestRow): CommunityDecidedJoinRequest {
  if (!row.decided_by || !row.decided_at || row.status === 'PENDING') {
    throw new Error('COMMUNITY_JOIN_REQUEST_DECISION_INVALID');
  }
  return communityDecidedJoinRequestSchema.parse({
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    state: row.status,
    originStatus: row.origin_status,
    revision: Number(row.revision),
    requestedAt: timestamp(row.requested_at),
    decidedByUserId: row.decided_by,
    decidedAt: timestamp(row.decided_at),
    ...(row.decision_reason_code ? { reasonCode: row.decision_reason_code } : {}),
  });
}

function membershipState(
  communityId: string,
  row: MembershipRow,
  joinPolicy: JoinPolicy,
  request?: CommunityPendingJoinRequest,
): CommunityOwnMembershipState {
  const revision = Number(row.revision);
  if (row.status === 'PENDING') {
    if (!request) throw new Error('COMMUNITY_PENDING_MEMBERSHIP_REQUEST_MISSING');
    return communityOwnMembershipStateSchema.parse({
      communityId,
      status: 'PENDING',
      role: 'MEMBER',
      revision,
      updatedAt: timestamp(row.updated_at),
      pendingRequest: request,
      joinAction: 'MEMBERSHIP_PENDING',
    });
  }
  if (row.status === 'ACTIVE') {
    return communityOwnMembershipStateSchema.parse({
      communityId,
      status: 'ACTIVE',
      role: row.role,
      revision,
      updatedAt: timestamp(row.updated_at),
      pendingRequest: null,
      joinAction: 'OPEN_COMMUNITY',
    });
  }
  return communityOwnMembershipStateSchema.parse({
    communityId,
    status: row.status,
    role: 'MEMBER',
    revision,
    updatedAt: timestamp(row.updated_at),
    pendingRequest: null,
    joinAction: inactiveJoinAction(row.status, joinPolicy),
  });
}

function memberActiveMembership(value: CommunityOwnMembershipState): MemberActiveMembership {
  if (value.status !== 'ACTIVE' || value.role !== 'MEMBER') {
    throw new Error('COMMUNITY_MEMBER_ACTIVE_STATE_INVALID');
  }
  return { ...value, role: 'MEMBER' };
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string, communityId: string | undefined): CursorValue {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<CursorValue>;
    if (
      parsed.v === 1 &&
      parsed.communityId === (communityId ?? null) &&
      typeof parsed.requestedAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.requestedAt)) &&
      typeof parsed.id === 'string' &&
      UUID_PATTERN.test(parsed.id)
    ) {
      return parsed as CursorValue;
    }
  } catch {
    // All malformed or cross-community cursors map to one stable repository error.
  }
  throw new Error('COMMUNITY_PENDING_CURSOR_INVALID');
}

async function lockIdempotency(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-membership-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
}

async function lockAggregate(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  subjectUserId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-membership:${tenantId}:${communityId}:${subjectUserId}`,
  ]);
}

async function currentCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from communities.membership_lifecycle_commands
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
    readonly communityId: string;
    readonly subjectUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
  commandType: CommandType,
  resultPayload: unknown,
): Promise<void> {
  await client.query(
    `insert into communities.membership_lifecycle_commands (
       tenant_id, actor_user_id, community_id, subject_user_id,
       command_type, idempotency_key, request_hash, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      input.subjectUserId,
      commandType,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(resultPayload),
    ],
  );
}

async function actorIsActive(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
): Promise<boolean> {
  const actor = await queryOne<ActorRow>(
    client,
    `select status from identity.users where tenant_id = $1 and id = $2 for share`,
    [tenantId, actorUserId],
  );
  return actor?.status === 'ACTIVE';
}

async function activeCommunity(
  client: PoolClient,
  tenantId: string,
  communityId: string,
): Promise<CommunityRow | undefined> {
  return queryOne<CommunityRow>(
    client,
    `select join_policy, visibility
       from communities.communities
      where tenant_id = $1 and id = $2 and status = 'ACTIVE'
      for share`,
    [tenantId, communityId],
  );
}

async function actorHasPlatformPermission(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string },
  mode: 'read' | 'decide',
): Promise<boolean> {
  const permissions =
    mode === 'read'
      ? ['communities.moderation.read', 'communities.join.decide']
      : ['communities.join.decide'];
  const row = await queryOne<PermissionRow>(
    client,
    `select exists (
       select 1
         from identity.user_access_profiles access
        where access.tenant_id = $1
          and access.user_id = $2
          and access.permissions && $3::text[]
     ) as authorized`,
    [input.tenantId, input.actorUserId, permissions],
  );
  return row?.authorized === true;
}

async function lockedMembership(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  return queryOne<MembershipRow>(
    client,
    `select status, role, revision, updated_at
       from communities.memberships
      where tenant_id = $1 and community_id = $2 and user_id = $3
      for update`,
    [tenantId, communityId, userId],
  );
}

async function lockedRequest(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  requestId: string,
  userId: string,
): Promise<JoinRequestRow | undefined> {
  return queryOne<JoinRequestRow>(
    client,
    `select id, community_id, user_id, status, origin_status, revision,
            requested_at, decided_by, decided_at, decision_reason_code
       from communities.join_requests
      where tenant_id = $1 and community_id = $2 and id = $3 and user_id = $4
      for update`,
    [tenantId, communityId, requestId, userId],
  );
}

async function recordAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly resourceId: string;
    readonly action: string;
    readonly resourceType: 'COMMUNITY_MEMBERSHIP' | 'COMMUNITY_JOIN_REQUEST';
    readonly previous: unknown;
    readonly next: unknown;
    readonly reasonCode?: string;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, reason, correlation_id, old_value, new_value
     ) values ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7, $8::jsonb, $9::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.reasonCode ?? null,
      input.correlationId,
      JSON.stringify(input.previous),
      JSON.stringify(input.next),
    ],
  );
}

async function recordOutbox(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly correlationId: string;
    readonly eventType: string;
    readonly payload: unknown;
  },
): Promise<void> {
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

function replaySelfJoin(
  command: CommandRow,
  input: CommunitySelfJoinInput,
): CommunitySelfJoinResult {
  if (command.command_type !== 'JOIN' || command.request_hash !== input.requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  const stored = command.result_payload as { outcome?: unknown; membership?: unknown };
  const membership = communityOwnMembershipStateSchema.parse(stored.membership);
  if (stored.outcome === 'joined' && membership.status === 'ACTIVE') {
    return { outcome: 'joined', membership, replayed: true };
  }
  if (stored.outcome === 'requested' && membership.status === 'PENDING') {
    return { outcome: 'requested', membership, replayed: true };
  }
  throw new Error('COMMUNITY_MEMBERSHIP_COMMAND_RESULT_INVALID');
}

function replayCancel(
  command: CommandRow,
  input: CommunityCancelPendingInput,
): CommunityCancelPendingResult {
  if (
    command.command_type !== 'CANCEL_JOIN_REQUEST' ||
    command.request_hash !== input.requestHash
  ) {
    return { outcome: 'idempotency_conflict' };
  }
  const stored = command.result_payload as {
    outcome?: unknown;
    membership?: unknown;
    request?: unknown;
  };
  const membership = communityOwnMembershipStateSchema.parse(stored.membership);
  const request = communityDecidedJoinRequestSchema.parse(stored.request);
  if (
    stored.outcome !== 'cancelled' ||
    !['ABSENT', 'LEFT', 'REMOVED'].includes(membership.status) ||
    request.state !== 'CANCELLED'
  ) {
    throw new Error('COMMUNITY_MEMBERSHIP_COMMAND_RESULT_INVALID');
  }
  return {
    outcome: 'cancelled',
    membership: membership as Extract<
      CommunityOwnMembershipState,
      { status: 'ABSENT' | 'LEFT' | 'REMOVED' }
    >,
    request: request as CommunityDecidedJoinRequest & { readonly state: 'CANCELLED' },
    replayed: true,
  };
}

function replayLeave(command: CommandRow, input: CommunityLeaveInput): CommunityLeaveResult {
  if (command.command_type !== 'LEAVE' || command.request_hash !== input.requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  const stored = command.result_payload as { outcome?: unknown; membership?: unknown };
  const membership = communityOwnMembershipStateSchema.parse(stored.membership);
  if (stored.outcome !== 'left' || membership.status !== 'LEFT') {
    throw new Error('COMMUNITY_MEMBERSHIP_COMMAND_RESULT_INVALID');
  }
  return { outcome: 'left', membership, replayed: true };
}

function replayDecision(
  command: CommandRow,
  input: CommunityApproveJoinInput | CommunityRejectJoinInput,
  expected: 'approved' | 'rejected',
): CommunityApproveJoinResult | CommunityRejectJoinResult {
  if (
    command.command_type !== 'DECIDE_JOIN_REQUEST' ||
    command.request_hash !== input.requestHash
  ) {
    return { outcome: 'idempotency_conflict' };
  }
  const stored = command.result_payload as {
    outcome?: unknown;
    membership?: unknown;
    request?: unknown;
  };
  if (stored.outcome !== expected) return { outcome: 'idempotency_conflict' };
  const membership = communityOwnMembershipStateSchema.parse(stored.membership);
  const request = communityDecidedJoinRequestSchema.parse(stored.request);
  if (expected === 'approved' && membership.status === 'ACTIVE' && request.state === 'APPROVED') {
    return {
      outcome: 'approved',
      membership: memberActiveMembership(membership),
      request: request as DecidedRequestWithState<'APPROVED'>,
      replayed: true,
    };
  }
  if (
    expected === 'rejected' &&
    ['ABSENT', 'LEFT', 'REMOVED'].includes(membership.status) &&
    request.state === 'REJECTED'
  ) {
    return {
      outcome: 'rejected',
      membership: membership as RestoredMembership,
      request: request as DecidedRequestWithState<'REJECTED'>,
      replayed: true,
    };
  }
  throw new Error('COMMUNITY_MEMBERSHIP_COMMAND_RESULT_INVALID');
}

async function insertPendingMembership(
  client: PoolClient,
  input: CommunitySelfJoinInput,
  previous: MembershipRow | undefined,
): Promise<MembershipRow> {
  if (!previous) {
    const row = await queryOne<MembershipRow>(
      client,
      `insert into communities.memberships (
         tenant_id, community_id, user_id, role, status, requested_at, revision
       ) values ($1, $2, $3, 'MEMBER', 'PENDING', now(), 1)
       returning status, role, revision, updated_at`,
      [input.tenantId, input.communityId, input.actorUserId],
    );
    if (!row) throw new Error('COMMUNITY_PENDING_MEMBERSHIP_INSERT_FAILED');
    return row;
  }
  const row = await queryOne<MembershipRow>(
    client,
    `update communities.memberships
        set status = 'PENDING', role = 'MEMBER', requested_at = now(),
            pinned_at = null, revision = revision + 1, updated_at = now()
      where tenant_id = $1 and community_id = $2 and user_id = $3 and revision = $4
      returning status, role, revision, updated_at`,
    [input.tenantId, input.communityId, input.actorUserId, input.expectedMembershipRevision],
  );
  if (!row) throw new Error('COMMUNITY_PENDING_MEMBERSHIP_CONCURRENT_UPDATE');
  return row;
}

async function insertActiveMembership(
  client: PoolClient,
  input: CommunitySelfJoinInput,
  previous: MembershipRow | undefined,
): Promise<MembershipRow> {
  if (!previous) {
    const row = await queryOne<MembershipRow>(
      client,
      `insert into communities.memberships (
         tenant_id, community_id, user_id, role, status, joined_at, revision
       ) values ($1, $2, $3, 'MEMBER', 'ACTIVE', now(), 1)
       returning status, role, revision, updated_at`,
      [input.tenantId, input.communityId, input.actorUserId],
    );
    if (!row) throw new Error('COMMUNITY_ACTIVE_MEMBERSHIP_INSERT_FAILED');
    return row;
  }
  const row = await queryOne<MembershipRow>(
    client,
    `update communities.memberships
        set status = 'ACTIVE', role = 'MEMBER', joined_at = now(), left_at = null,
            requested_at = null, pinned_at = null, revision = revision + 1, updated_at = now()
      where tenant_id = $1 and community_id = $2 and user_id = $3 and revision = $4
      returning status, role, revision, updated_at`,
    [input.tenantId, input.communityId, input.actorUserId, input.expectedMembershipRevision],
  );
  if (!row) throw new Error('COMMUNITY_ACTIVE_MEMBERSHIP_CONCURRENT_UPDATE');
  return row;
}

async function createJoinRequest(
  client: PoolClient,
  input: CommunitySelfJoinInput,
  originStatus: RequestOrigin,
): Promise<JoinRequestRow> {
  const row = await queryOne<JoinRequestRow>(
    client,
    `insert into communities.join_requests (
       tenant_id, community_id, user_id, request_kind, origin_status, requested_by
     ) values ($1, $2, $3, $4, $5, $3)
     returning id, community_id, user_id, status, origin_status, revision,
               requested_at, decided_by, decided_at, decision_reason_code`,
    [
      input.tenantId,
      input.communityId,
      input.actorUserId,
      originStatus === 'ABSENT' ? 'JOIN' : 'REJOIN',
      originStatus,
    ],
  );
  if (!row) throw new Error('COMMUNITY_JOIN_REQUEST_INSERT_FAILED');
  return row;
}

async function restoreOriginMembership(
  client: PoolClient,
  input: { readonly tenantId: string; readonly communityId: string },
  subjectUserId: string,
  expectedRevision: number,
  originStatus: RequestOrigin,
  joinPolicy: JoinPolicy,
): Promise<CommunityOwnMembershipState> {
  if (originStatus === 'ABSENT') {
    const deleted = await queryOne<{ readonly user_id: string } & QueryResultRow>(
      client,
      `delete from communities.memberships
        where tenant_id = $1 and community_id = $2 and user_id = $3
          and status = 'PENDING' and revision = $4
      returning user_id`,
      [input.tenantId, input.communityId, subjectUserId, expectedRevision],
    );
    if (!deleted) throw new Error('COMMUNITY_PENDING_MEMBERSHIP_CONCURRENT_DELETE');
    return absentMembership(input.communityId, joinPolicy);
  }
  const row = await queryOne<MembershipRow>(
    client,
    `update communities.memberships
        set status = $5, role = 'MEMBER', requested_at = null, pinned_at = null,
            revision = revision + 1, updated_at = now()
      where tenant_id = $1 and community_id = $2 and user_id = $3
        and status = 'PENDING' and revision = $4
      returning status, role, revision, updated_at`,
    [input.tenantId, input.communityId, subjectUserId, expectedRevision, originStatus],
  );
  if (!row) throw new Error('COMMUNITY_PENDING_MEMBERSHIP_CONCURRENT_RESTORE');
  return membershipState(input.communityId, row, joinPolicy);
}

async function decideRequest(
  client: PoolClient,
  input: CommunityApproveJoinInput | CommunityRejectJoinInput | CommunityCancelPendingInput,
  communityId: string,
  subjectUserId: string,
  state: 'APPROVED' | 'REJECTED' | 'CANCELLED',
  reasonCode?: string,
): Promise<JoinRequestRow> {
  const row = await queryOne<JoinRequestRow>(
    client,
    `update communities.join_requests
        set status = $6, revision = revision + 1, decided_by = $5,
            decided_at = now(), decision_reason_code = $7, updated_at = now()
      where tenant_id = $1 and community_id = $2 and id = $3 and user_id = $4
        and status = 'PENDING' and revision = $8
      returning id, community_id, user_id, status, origin_status, revision,
                requested_at, decided_by, decided_at, decision_reason_code`,
    [
      input.tenantId,
      communityId,
      input.requestId,
      subjectUserId,
      input.actorUserId,
      state,
      reasonCode ?? null,
      input.expectedRequestRevision,
    ],
  );
  if (!row) throw new Error('COMMUNITY_JOIN_REQUEST_CONCURRENT_DECISION');
  return row;
}

export function createCommunityMembershipLifecycleRepository(
  pool: Pool,
): CommunityMembershipLifecycleRepository {
  return {
    getOwnState(input: CommunityGetOwnStateInput): Promise<CommunityGetOwnStateResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await activeCommunity(client, input.tenantId, input.communityId);
        if (!community) return { outcome: 'community_not_found' };
        const membership = await queryOne<MembershipRow>(
          client,
          `select status, role, revision, updated_at
             from communities.memberships
            where tenant_id = $1 and community_id = $2 and user_id = $3`,
          [input.tenantId, input.communityId, input.actorUserId],
        );
        if (!membership && community.visibility === 'HIDDEN') {
          return { outcome: 'community_not_found' };
        }
        if (!membership)
          return {
            outcome: 'found',
            membership: absentMembership(input.communityId, community.join_policy),
          };
        let request: CommunityPendingJoinRequest | undefined;
        if (membership.status === 'PENDING') {
          const row = await queryOne<JoinRequestRow>(
            client,
            `select id, community_id, user_id, status, origin_status, revision,
                    requested_at, decided_by, decided_at, decision_reason_code
               from communities.join_requests
              where tenant_id = $1 and community_id = $2 and user_id = $3 and status = 'PENDING'`,
            [input.tenantId, input.communityId, input.actorUserId],
          );
          if (!row) throw new Error('COMMUNITY_PENDING_MEMBERSHIP_REQUEST_MISSING');
          request = pendingRequest(row);
        }
        return {
          outcome: 'found',
          membership: membershipState(
            input.communityId,
            membership,
            community.join_policy,
            request,
          ),
        };
      });
    },

    selfJoin(input: CommunitySelfJoinInput): Promise<CommunitySelfJoinResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockIdempotency(client, input);
        const command = await currentCommand(client, input);
        if (command) return replaySelfJoin(command, input);
        await lockAggregate(client, input.tenantId, input.communityId, input.actorUserId);

        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await activeCommunity(client, input.tenantId, input.communityId);
        if (!community) return { outcome: 'community_not_found' };
        const previousRow = await lockedMembership(
          client,
          input.tenantId,
          input.communityId,
          input.actorUserId,
        );
        const previousRevision = Number(previousRow?.revision ?? 0);
        if (!previousRow && community.visibility === 'HIDDEN') {
          return { outcome: 'community_not_found' };
        }
        if (previousRow?.status === 'BANNED') return { outcome: 'membership_banned' };
        if (previousRevision !== input.expectedMembershipRevision) {
          return { outcome: 'revision_conflict', currentRevision: previousRevision };
        }
        if (previousRow?.status === 'ACTIVE') return { outcome: 'membership_already_active' };
        if (previousRow?.status === 'PENDING') return { outcome: 'request_already_pending' };
        if (community.join_policy === 'INVITE_ONLY') return { outcome: 'invite_required' };

        const originStatus: RequestOrigin = previousRow?.status ?? 'ABSENT';
        const mustRequest = community.join_policy === 'MODERATED' || originStatus === 'REMOVED';
        const previous = previousRow
          ? membershipState(input.communityId, previousRow, community.join_policy)
          : absentMembership(input.communityId, community.join_policy);

        if (!mustRequest) {
          const updated = await insertActiveMembership(client, input, previousRow);
          const membership = membershipState(input.communityId, updated, community.join_policy);
          if (membership.status !== 'ACTIVE') throw new Error('COMMUNITY_JOIN_RESULT_INVALID');
          const payload = { outcome: 'joined' as const, membership };
          await recordCommand(
            client,
            { ...input, subjectUserId: input.actorUserId },
            'JOIN',
            payload,
          );
          await recordAudit(client, {
            ...input,
            resourceId: input.communityId,
            action: 'COMMUNITY_MEMBER_JOINED',
            resourceType: 'COMMUNITY_MEMBERSHIP',
            previous,
            next: membership,
          });
          await recordOutbox(client, {
            ...input,
            eventType: COMMUNITY_MEMBER_JOINED_EVENT,
            payload: {
              communityId: input.communityId,
              userId: input.actorUserId,
              membershipRevision: membership.revision,
              joinedAt: membership.updatedAt,
            },
          });
          return { ...payload, replayed: false };
        }

        const updated = await insertPendingMembership(client, input, previousRow);
        const insertedRequest = await createJoinRequest(client, input, originStatus);
        const request = pendingRequest(insertedRequest);
        const membership = membershipState(
          input.communityId,
          updated,
          community.join_policy,
          request,
        );
        if (membership.status !== 'PENDING')
          throw new Error('COMMUNITY_JOIN_REQUEST_RESULT_INVALID');
        const payload = { outcome: 'requested' as const, membership };
        await recordCommand(
          client,
          { ...input, subjectUserId: input.actorUserId },
          'JOIN',
          payload,
        );
        await recordAudit(client, {
          ...input,
          resourceId: request.id,
          action: 'COMMUNITY_JOIN_REQUESTED',
          resourceType: 'COMMUNITY_JOIN_REQUEST',
          previous,
          next: { membership, request },
        });
        await recordOutbox(client, {
          ...input,
          eventType: COMMUNITY_JOIN_REQUESTED_EVENT,
          payload: {
            communityId: input.communityId,
            userId: input.actorUserId,
            requestId: request.id,
            originStatus: request.originStatus,
            membershipRevision: membership.revision,
            requestRevision: request.revision,
            requestedAt: request.requestedAt,
          },
        });
        return { ...payload, replayed: false };
      });
    },

    cancelPending(input: CommunityCancelPendingInput): Promise<CommunityCancelPendingResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockIdempotency(client, input);
        const command = await currentCommand(client, input);
        if (command) return replayCancel(command, input);
        await lockAggregate(client, input.tenantId, input.communityId, input.actorUserId);

        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await activeCommunity(client, input.tenantId, input.communityId);
        if (!community) return { outcome: 'community_not_found' };
        const membershipRow = await lockedMembership(
          client,
          input.tenantId,
          input.communityId,
          input.actorUserId,
        );
        if (membershipRow?.status === 'BANNED') return { outcome: 'membership_banned' };
        if (!membershipRow || membershipRow.status !== 'PENDING')
          return { outcome: 'request_not_pending' };
        if (Number(membershipRow.revision) !== input.expectedMembershipRevision) {
          return {
            outcome: 'membership_revision_conflict',
            currentRevision: Number(membershipRow.revision),
          };
        }
        const requestRow = await lockedRequest(
          client,
          input.tenantId,
          input.communityId,
          input.requestId,
          input.actorUserId,
        );
        if (!requestRow) return { outcome: 'request_not_found' };
        if (requestRow.status !== 'PENDING') return { outcome: 'request_not_pending' };
        if (Number(requestRow.revision) !== input.expectedRequestRevision) {
          return {
            outcome: 'request_revision_conflict',
            currentRevision: Number(requestRow.revision),
          };
        }
        const previousRequest = pendingRequest(requestRow);
        const previousMembership = membershipState(
          input.communityId,
          membershipRow,
          community.join_policy,
          previousRequest,
        );
        const decidedRow = await decideRequest(
          client,
          input,
          input.communityId,
          input.actorUserId,
          'CANCELLED',
        );
        const request = decidedRequest(decidedRow);
        if (request.state !== 'CANCELLED') throw new Error('COMMUNITY_CANCEL_RESULT_INVALID');
        const cancelledRequest = request as DecidedRequestWithState<'CANCELLED'>;
        const membership = await restoreOriginMembership(
          client,
          input,
          input.actorUserId,
          input.expectedMembershipRevision,
          requestRow.origin_status,
          community.join_policy,
        );
        if (!['ABSENT', 'LEFT', 'REMOVED'].includes(membership.status)) {
          throw new Error('COMMUNITY_CANCEL_MEMBERSHIP_RESULT_INVALID');
        }
        const payload = { outcome: 'cancelled' as const, membership, request: cancelledRequest };
        await recordCommand(
          client,
          { ...input, subjectUserId: input.actorUserId },
          'CANCEL_JOIN_REQUEST',
          payload,
        );
        await recordAudit(client, {
          ...input,
          resourceId: cancelledRequest.id,
          action: 'COMMUNITY_JOIN_CANCELLED',
          resourceType: 'COMMUNITY_JOIN_REQUEST',
          previous: { membership: previousMembership, request: previousRequest },
          next: { membership, request: cancelledRequest },
        });
        await recordOutbox(client, {
          ...input,
          eventType: COMMUNITY_JOIN_CANCELLED_EVENT,
          payload: {
            communityId: input.communityId,
            userId: input.actorUserId,
            requestId: cancelledRequest.id,
            membershipRevision: membership.revision,
            requestRevision: cancelledRequest.revision,
            cancelledAt: cancelledRequest.decidedAt,
          },
        });
        return {
          outcome: 'cancelled',
          membership: membership as RestoredMembership,
          request: cancelledRequest,
          replayed: false,
        };
      });
    },

    leave(input: CommunityLeaveInput): Promise<CommunityLeaveResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockIdempotency(client, input);
        const command = await currentCommand(client, input);
        if (command) return replayLeave(command, input);
        await lockAggregate(client, input.tenantId, input.communityId, input.actorUserId);

        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await activeCommunity(client, input.tenantId, input.communityId);
        if (!community) return { outcome: 'community_not_found' };
        const previousRow = await lockedMembership(
          client,
          input.tenantId,
          input.communityId,
          input.actorUserId,
        );
        if (!previousRow || previousRow.status !== 'ACTIVE') {
          return { outcome: 'membership_not_active' };
        }
        if (previousRow.role === 'OWNER') return { outcome: 'owner_cannot_leave' };
        if (Number(previousRow.revision) !== input.expectedMembershipRevision) {
          return { outcome: 'revision_conflict', currentRevision: Number(previousRow.revision) };
        }
        const previous = membershipState(input.communityId, previousRow, community.join_policy);
        const updated = await queryOne<MembershipRow>(
          client,
          `update communities.memberships
              set status = 'LEFT', role = 'MEMBER', left_at = now(), requested_at = null,
                  pinned_at = null, revision = revision + 1, updated_at = now()
            where tenant_id = $1 and community_id = $2 and user_id = $3
              and status = 'ACTIVE' and revision = $4
            returning status, role, revision, updated_at`,
          [input.tenantId, input.communityId, input.actorUserId, input.expectedMembershipRevision],
        );
        if (!updated) throw new Error('COMMUNITY_LEAVE_CONCURRENT_UPDATE');
        const membership = membershipState(input.communityId, updated, community.join_policy);
        if (membership.status !== 'LEFT') throw new Error('COMMUNITY_LEAVE_RESULT_INVALID');
        const payload = { outcome: 'left' as const, membership };
        await recordCommand(
          client,
          { ...input, subjectUserId: input.actorUserId },
          'LEAVE',
          payload,
        );
        await recordAudit(client, {
          ...input,
          resourceId: input.communityId,
          action: 'COMMUNITY_MEMBER_LEFT',
          resourceType: 'COMMUNITY_MEMBERSHIP',
          previous,
          next: membership,
        });
        await recordOutbox(client, {
          ...input,
          eventType: COMMUNITY_MEMBER_LEFT_EVENT,
          payload: {
            communityId: input.communityId,
            userId: input.actorUserId,
            membershipRevision: membership.revision,
            leftAt: membership.updatedAt,
          },
        });
        return { ...payload, replayed: false };
      });
    },

    listPending(input: CommunityListPendingInput): Promise<CommunityListPendingResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        if (!(await actorHasPlatformPermission(client, input, 'read')))
          return { outcome: 'permission_denied' };
        if (
          input.communityId &&
          !(await activeCommunity(client, input.tenantId, input.communityId))
        ) {
          return { outcome: 'community_not_found' };
        }
        const cursor = input.cursor ? decodeCursor(input.cursor, input.communityId) : undefined;
        const result = await client.query<PendingQueueRow>(
          `select r.id, r.community_id, r.user_id, r.status, r.origin_status, r.revision,
                  r.requested_at, r.requested_at::text as sort_requested_at,
                  r.decided_by, r.decided_at, r.decision_reason_code,
                  m.revision as membership_revision
             from communities.join_requests r
             join communities.memberships m
               on m.tenant_id = r.tenant_id
              and m.community_id = r.community_id
              and m.user_id = r.user_id
              and m.status = 'PENDING'
             join communities.communities c
               on c.tenant_id = r.tenant_id and c.id = r.community_id and c.status = 'ACTIVE'
            where r.tenant_id = $1
              and ($2::uuid is null or r.community_id = $2::uuid)
              and r.status = 'PENDING'
              and (
                $3::timestamptz is null
                or r.requested_at > $3::timestamptz
                or (r.requested_at = $3::timestamptz and r.id > $4::uuid)
              )
            order by r.requested_at asc, r.id asc
            limit $5`,
          [
            input.tenantId,
            input.communityId ?? null,
            cursor?.requestedAt ?? null,
            cursor?.id ?? null,
            input.limit + 1,
          ],
        );
        const page = result.rows.slice(0, input.limit);
        const items = page.map((row) => ({
          request: pendingRequest(row),
          membershipRevision: Number(row.membership_revision),
        }));
        const last = page.at(-1);
        const nextCursor =
          result.rows.length > input.limit && last
            ? encodeCursor({
                v: 1,
                communityId: input.communityId ?? null,
                requestedAt: last.sort_requested_at,
                id: last.id,
              })
            : undefined;
        return { outcome: 'found', items, ...(nextCursor ? { nextCursor } : {}) };
      });
    },

    approve(input: CommunityApproveJoinInput): Promise<CommunityApproveJoinResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockIdempotency(client, input);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        if (!(await actorHasPlatformPermission(client, input, 'decide')))
          return { outcome: 'permission_denied' };
        const command = await currentCommand(client, input);
        if (command)
          return replayDecision(command, input, 'approved') as CommunityApproveJoinResult;
        const locator = await queryOne<RequestLocatorRow>(
          client,
          `select community_id, user_id from communities.join_requests
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.requestId],
        );
        if (!locator) return { outcome: 'request_not_found' };
        const community = await activeCommunity(client, input.tenantId, locator.community_id);
        if (!community) return { outcome: 'community_not_found' };
        await lockAggregate(client, input.tenantId, locator.community_id, locator.user_id);
        const requestRow = await lockedRequest(
          client,
          input.tenantId,
          locator.community_id,
          input.requestId,
          locator.user_id,
        );
        if (!requestRow) return { outcome: 'request_not_found' };
        if (requestRow.status !== 'PENDING') return { outcome: 'request_not_pending' };
        const membershipRow = await lockedMembership(
          client,
          input.tenantId,
          locator.community_id,
          locator.user_id,
        );
        if (membershipRow?.status === 'BANNED') return { outcome: 'membership_banned' };
        if (!membershipRow || membershipRow.status !== 'PENDING') {
          return { outcome: 'request_not_pending' };
        }
        if (Number(membershipRow.revision) !== input.expectedMembershipRevision) {
          return {
            outcome: 'membership_revision_conflict',
            currentRevision: Number(membershipRow.revision),
          };
        }
        if (Number(requestRow.revision) !== input.expectedRequestRevision) {
          return {
            outcome: 'request_revision_conflict',
            currentRevision: Number(requestRow.revision),
          };
        }
        const previousRequest = pendingRequest(requestRow);
        const previousMembership = membershipState(
          locator.community_id,
          membershipRow,
          community.join_policy,
          previousRequest,
        );
        const decidedRow = await decideRequest(
          client,
          input,
          locator.community_id,
          locator.user_id,
          'APPROVED',
        );
        const request = decidedRequest(decidedRow);
        if (request.state !== 'APPROVED')
          throw new Error('COMMUNITY_APPROVE_REQUEST_RESULT_INVALID');
        const approvedRequest = request as DecidedRequestWithState<'APPROVED'>;
        const updated = await queryOne<MembershipRow>(
          client,
          `update communities.memberships
              set status = 'ACTIVE', role = 'MEMBER', joined_at = now(), left_at = null,
                  requested_at = null, pinned_at = null,
                  revision = revision + 1, updated_at = now()
            where tenant_id = $1 and community_id = $2 and user_id = $3
              and status = 'PENDING' and revision = $4
            returning status, role, revision, updated_at`,
          [input.tenantId, locator.community_id, locator.user_id, input.expectedMembershipRevision],
        );
        if (!updated) throw new Error('COMMUNITY_APPROVE_MEMBERSHIP_CONCURRENT_UPDATE');
        const membership = membershipState(locator.community_id, updated, community.join_policy);
        if (membership.status !== 'ACTIVE' || membership.role !== 'MEMBER') {
          throw new Error('COMMUNITY_APPROVE_MEMBERSHIP_RESULT_INVALID');
        }
        const approvedMembership = memberActiveMembership(membership);
        const payload = {
          outcome: 'approved' as const,
          membership: approvedMembership,
          request: approvedRequest,
        };
        await recordCommand(
          client,
          { ...input, communityId: locator.community_id, subjectUserId: locator.user_id },
          'DECIDE_JOIN_REQUEST',
          payload,
        );
        await recordAudit(client, {
          ...input,
          resourceId: approvedRequest.id,
          action: 'COMMUNITY_JOIN_APPROVED',
          resourceType: 'COMMUNITY_JOIN_REQUEST',
          previous: { membership: previousMembership, request: previousRequest },
          next: { membership: approvedMembership, request: approvedRequest },
        });
        await recordOutbox(client, {
          ...input,
          communityId: locator.community_id,
          eventType: COMMUNITY_JOIN_APPROVED_EVENT,
          payload: {
            communityId: locator.community_id,
            userId: locator.user_id,
            requestId: approvedRequest.id,
            membershipRevision: approvedMembership.revision,
            requestRevision: approvedRequest.revision,
            decidedAt: approvedRequest.decidedAt,
          },
        });
        return { ...payload, replayed: false };
      });
    },

    reject(input: CommunityRejectJoinInput): Promise<CommunityRejectJoinResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockIdempotency(client, input);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        if (!(await actorHasPlatformPermission(client, input, 'decide')))
          return { outcome: 'permission_denied' };
        const command = await currentCommand(client, input);
        if (command) return replayDecision(command, input, 'rejected') as CommunityRejectJoinResult;
        const locator = await queryOne<RequestLocatorRow>(
          client,
          `select community_id, user_id from communities.join_requests
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.requestId],
        );
        if (!locator) return { outcome: 'request_not_found' };
        const community = await activeCommunity(client, input.tenantId, locator.community_id);
        if (!community) return { outcome: 'community_not_found' };
        await lockAggregate(client, input.tenantId, locator.community_id, locator.user_id);
        const requestRow = await lockedRequest(
          client,
          input.tenantId,
          locator.community_id,
          input.requestId,
          locator.user_id,
        );
        if (!requestRow) return { outcome: 'request_not_found' };
        if (requestRow.status !== 'PENDING') return { outcome: 'request_not_pending' };
        const membershipRow = await lockedMembership(
          client,
          input.tenantId,
          locator.community_id,
          locator.user_id,
        );
        if (membershipRow?.status === 'BANNED') return { outcome: 'membership_banned' };
        if (!membershipRow || membershipRow.status !== 'PENDING') {
          return { outcome: 'request_not_pending' };
        }
        if (Number(membershipRow.revision) !== input.expectedMembershipRevision) {
          return {
            outcome: 'membership_revision_conflict',
            currentRevision: Number(membershipRow.revision),
          };
        }
        if (Number(requestRow.revision) !== input.expectedRequestRevision) {
          return {
            outcome: 'request_revision_conflict',
            currentRevision: Number(requestRow.revision),
          };
        }
        const previousRequest = pendingRequest(requestRow);
        const previousMembership = membershipState(
          locator.community_id,
          membershipRow,
          community.join_policy,
          previousRequest,
        );
        const decidedRow = await decideRequest(
          client,
          input,
          locator.community_id,
          locator.user_id,
          'REJECTED',
          input.reasonCode,
        );
        const request = decidedRequest(decidedRow);
        if (request.state !== 'REJECTED')
          throw new Error('COMMUNITY_REJECT_REQUEST_RESULT_INVALID');
        const rejectedRequest = request as DecidedRequestWithState<'REJECTED'>;
        const membership = await restoreOriginMembership(
          client,
          { tenantId: input.tenantId, communityId: locator.community_id },
          locator.user_id,
          input.expectedMembershipRevision,
          requestRow.origin_status,
          community.join_policy,
        );
        if (!['ABSENT', 'LEFT', 'REMOVED'].includes(membership.status)) {
          throw new Error('COMMUNITY_REJECT_MEMBERSHIP_RESULT_INVALID');
        }
        const payload = { outcome: 'rejected' as const, membership, request: rejectedRequest };
        await recordCommand(
          client,
          { ...input, communityId: locator.community_id, subjectUserId: locator.user_id },
          'DECIDE_JOIN_REQUEST',
          payload,
        );
        await recordAudit(client, {
          ...input,
          resourceId: rejectedRequest.id,
          action: 'COMMUNITY_JOIN_REJECTED',
          resourceType: 'COMMUNITY_JOIN_REQUEST',
          reasonCode: input.reasonCode,
          previous: { membership: previousMembership, request: previousRequest },
          next: { membership, request: rejectedRequest },
        });
        await recordOutbox(client, {
          ...input,
          communityId: locator.community_id,
          eventType: COMMUNITY_JOIN_REJECTED_EVENT,
          payload: {
            communityId: locator.community_id,
            userId: locator.user_id,
            requestId: rejectedRequest.id,
            reasonCode: input.reasonCode,
            membershipRevision: membership.revision,
            requestRevision: rejectedRequest.revision,
            decidedAt: rejectedRequest.decidedAt,
          },
        });
        return {
          outcome: 'rejected',
          membership: membership as RestoredMembership,
          request: rejectedRequest,
          replayed: false,
        };
      });
    },
  };
}
