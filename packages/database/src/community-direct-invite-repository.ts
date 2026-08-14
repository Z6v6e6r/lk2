import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export const COMMUNITY_DIRECT_INVITE_ISSUED_EVENT = 'community.direct_invite.issued.v1' as const;
export const COMMUNITY_DIRECT_INVITE_REDEEMED_EVENT =
  'community.direct_invite.redeemed.v1' as const;
export const COMMUNITY_DIRECT_INVITE_REVOKED_EVENT = 'community.direct_invite.revoked.v1' as const;
export const COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CREATED_EVENT =
  'community.direct_invite.quota_grant.created.v1' as const;
export const COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CONSUMED_EVENT =
  'community.direct_invite.quota_grant.consumed.v1' as const;
export const COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_EXPIRED_EVENT =
  'community.direct_invite.quota_grant.expired.v1' as const;

export interface CommunityDirectInviteView {
  readonly id: string;
  readonly communityId: string;
  readonly issuedByUserId: string;
  readonly tokenKeyId: string;
  readonly state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly revision: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommunityDirectInvitePreview {
  readonly inviteId: string;
  readonly inviteRevision: number;
  readonly communityId: string;
  readonly title: string;
  readonly logoUrl: string | null;
  readonly visibility: 'PUBLIC' | 'LISTED_PRIVATE' | 'HIDDEN';
  readonly isVerified: boolean;
  readonly expiresAt: string;
  readonly membershipRevision: number;
  readonly redeemAction: 'OPEN_COMMUNITY' | 'CONFIRM_MEMBERSHIP' | 'REQUEST_PENDING';
}

export interface CommunityDirectInviteMembership {
  readonly communityId: string;
  readonly status: 'ACTIVE';
  readonly role: 'MEMBER';
  readonly revision: number;
  readonly updatedAt: string;
  readonly joinAction: 'OPEN_COMMUNITY';
}

export interface CommunityDirectInviteQuotaGrantView {
  readonly id: string;
  readonly communityId: string;
  readonly authorizedByUserId: string;
  readonly state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  readonly revision: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly consumedAt: string | null;
}

interface CommandBase {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface CommunityDirectInviteIssueInput extends CommandBase {
  readonly communityId: string;
  readonly tokenHash: string;
  readonly tokenKeyId: string;
  readonly expectedIssuerMembershipRevision: number;
}

export interface CommunityDirectInviteQuotaGrantInput extends CommandBase {
  readonly communityId: string;
  readonly capability: 'communities.invite.quota.override';
  readonly reasonCode: string;
  readonly ticketId: string;
}

export interface CommunityDirectInvitePreviewInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly tokenHash: string;
  readonly correlationId: string;
}

export interface CommunityDirectInviteRedeemInput extends CommandBase {
  readonly tokenHash: string;
  readonly confirmed: boolean;
  readonly expectedMembershipRevision: number;
  readonly expectedInviteRevision: number;
}

export interface CommunityDirectInviteRevokeInput extends CommandBase {
  readonly inviteId: string;
  readonly expectedInviteRevision: number;
}

export interface CommunityDirectInviteListInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly correlationId: string;
}

export type CommunityDirectInviteIssueResult =
  | {
      readonly outcome: 'issued';
      readonly invite: CommunityDirectInviteView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'permission_denied' }
  | { readonly outcome: 'active_limit_exceeded'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'daily_limit_exceeded'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'issuer_membership_revision_conflict'; readonly currentRevision: number };

export type CommunityDirectInviteQuotaGrantResult =
  | {
      readonly outcome: 'granted';
      readonly grant: CommunityDirectInviteQuotaGrantView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | {
      readonly outcome: 'active_grant_exists';
      readonly currentGrantId: string;
      readonly currentRevision: number;
      readonly expiresAt: string;
    };

export type CommunityDirectInvitePreviewResult =
  | { readonly outcome: 'found'; readonly preview: CommunityDirectInvitePreview }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'membership_banned' };

export type CommunityDirectInviteRedeemResult =
  | {
      readonly outcome: 'redeemed';
      readonly invite: CommunityDirectInviteView;
      readonly membership: CommunityDirectInviteMembership;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'confirmation_required' }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'invalid_invite' }
  | { readonly outcome: 'membership_banned' }
  | { readonly outcome: 'request_pending' }
  | { readonly outcome: 'membership_already_active' }
  | { readonly outcome: 'invite_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'membership_revision_conflict'; readonly currentRevision: number };

export type CommunityDirectInviteRevokeResult =
  | {
      readonly outcome: 'revoked';
      readonly invite: CommunityDirectInviteView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'invite_not_found' }
  | { readonly outcome: 'permission_denied' }
  | { readonly outcome: 'invite_not_active' }
  | { readonly outcome: 'invite_revision_conflict'; readonly currentRevision: number };

export type CommunityDirectInviteListResult =
  | {
      readonly outcome: 'found';
      readonly items: readonly CommunityDirectInviteView[];
      readonly nextCursor?: string;
    }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'permission_denied' };

export interface CommunityDirectInviteRepository {
  issue(input: CommunityDirectInviteIssueInput): Promise<CommunityDirectInviteIssueResult>;
  createQuotaGrant(
    input: CommunityDirectInviteQuotaGrantInput,
  ): Promise<CommunityDirectInviteQuotaGrantResult>;
  preview(input: CommunityDirectInvitePreviewInput): Promise<CommunityDirectInvitePreviewResult>;
  redeem(input: CommunityDirectInviteRedeemInput): Promise<CommunityDirectInviteRedeemResult>;
  revoke(input: CommunityDirectInviteRevokeInput): Promise<CommunityDirectInviteRevokeResult>;
  listActive(input: CommunityDirectInviteListInput): Promise<CommunityDirectInviteListResult>;
}

type CommandType = 'ISSUE' | 'REDEEM' | 'REVOKE';

interface ActorRow extends QueryResultRow {
  readonly status: string;
}

interface InviteRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly issued_by_user_id: string;
  readonly token_key_id: string;
  readonly state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly revision: number | string;
  readonly expires_at: Date | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface PreviewRow extends QueryResultRow {
  readonly invite_id: string;
  readonly community_id: string;
  readonly title: string;
  readonly logo_url: string | null;
  readonly visibility: 'OPEN' | 'CLOSED' | CommunityDirectInvitePreview['visibility'];
  readonly is_verified: boolean;
  readonly expires_at: Date | string;
  readonly invite_revision: number | string;
  readonly viewer_status: MembershipRow['status'] | null;
  readonly viewer_revision: number | string | null;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: CommandType;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface GrantCommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface GrantRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly authorized_by_user_id: string;
  readonly state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  readonly revision: number | string;
  readonly expires_at: Date | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly consumed_at: Date | string | null;
}

interface MembershipRow extends QueryResultRow {
  readonly status: 'PENDING' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
  readonly role: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
  readonly revision: number | string;
  readonly updated_at: Date | string;
}

interface InviteLocatorRow extends QueryResultRow {
  readonly id: string;
  readonly community_id: string;
  readonly issued_by_user_id: string;
}

interface InviteListRow extends InviteRow {
  readonly sort_created_at: string;
}

interface InviteCursor {
  readonly v: 1;
  readonly communityId: string;
  readonly createdAt: string;
  readonly id: string;
}

interface QuotaRow extends QueryResultRow {
  readonly active_count: number | string;
  readonly active_retry_after_seconds: number | string | null;
  readonly daily_count: number | string;
  readonly daily_retry_after_seconds: number | string | null;
}

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OVERRIDE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OVERRIDE_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function canonicalVisibility(
  value: PreviewRow['visibility'],
): CommunityDirectInvitePreview['visibility'] {
  if (value === 'OPEN') return 'PUBLIC';
  if (value === 'CLOSED') return 'LISTED_PRIVATE';
  return value;
}

function assertTokenHash(value: string): void {
  if (!TOKEN_HASH_PATTERN.test(value))
    throw new Error('COMMUNITY_DIRECT_INVITE_TOKEN_HASH_INVALID');
}

function assertTokenKeyId(value: string): void {
  if (!TOKEN_KEY_ID_PATTERN.test(value)) {
    throw new Error('COMMUNITY_DIRECT_INVITE_TOKEN_KEY_ID_INVALID');
  }
}

function assertQuotaGrantAuthorization(input: CommunityDirectInviteQuotaGrantInput): void {
  if (
    input.capability !== 'communities.invite.quota.override' ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !OVERRIDE_REASON_PATTERN.test(input.reasonCode) ||
    !OVERRIDE_TICKET_PATTERN.test(input.ticketId)
  ) {
    throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_AUTHORIZATION_INVALID');
  }
}

function encodeCursor(value: InviteCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string, communityId: string): InviteCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<InviteCursor>;
    if (
      parsed.v === 1 &&
      parsed.communityId === communityId &&
      typeof parsed.createdAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.createdAt)) &&
      typeof parsed.id === 'string' &&
      UUID_PATTERN.test(parsed.id)
    ) {
      return parsed as InviteCursor;
    }
  } catch {
    // Malformed and cross-community cursors share one fail-closed error.
  }
  throw new Error('COMMUNITY_DIRECT_INVITE_CURSOR_INVALID');
}

function inviteView(row: InviteRow): CommunityDirectInviteView {
  return {
    id: row.id,
    communityId: row.community_id,
    issuedByUserId: row.issued_by_user_id,
    tokenKeyId: row.token_key_id,
    state: row.state,
    revision: Number(row.revision),
    expiresAt: timestamp(row.expires_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function membershipView(communityId: string, row: MembershipRow): CommunityDirectInviteMembership {
  if (row.status !== 'ACTIVE' || row.role !== 'MEMBER') {
    throw new Error('COMMUNITY_DIRECT_INVITE_MEMBERSHIP_RESULT_INVALID');
  }
  return {
    communityId,
    status: 'ACTIVE',
    role: 'MEMBER',
    revision: Number(row.revision),
    updatedAt: timestamp(row.updated_at),
    joinAction: 'OPEN_COMMUNITY',
  };
}

function grantView(row: GrantRow): CommunityDirectInviteQuotaGrantView {
  return {
    id: row.id,
    communityId: row.community_id,
    authorizedByUserId: row.authorized_by_user_id,
    state: row.state,
    revision: Number(row.revision),
    expiresAt: timestamp(row.expires_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    consumedAt: row.consumed_at ? timestamp(row.consumed_at) : null,
  };
}

function storedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('COMMUNITY_DIRECT_INVITE_COMMAND_RESULT_INVALID');
  }
  return value as Record<string, unknown>;
}

function storedInvite(value: unknown): CommunityDirectInviteView {
  const record = storedRecord(value);
  if (
    typeof record.id !== 'string' ||
    typeof record.communityId !== 'string' ||
    typeof record.issuedByUserId !== 'string' ||
    typeof record.tokenKeyId !== 'string' ||
    !TOKEN_KEY_ID_PATTERN.test(record.tokenKeyId) ||
    !['ACTIVE', 'REVOKED', 'EXPIRED'].includes(String(record.state)) ||
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.expiresAt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('COMMUNITY_DIRECT_INVITE_COMMAND_RESULT_INVALID');
  }
  return record as unknown as CommunityDirectInviteView;
}

function storedMembership(value: unknown): CommunityDirectInviteMembership {
  const record = storedRecord(value);
  if (
    typeof record.communityId !== 'string' ||
    record.status !== 'ACTIVE' ||
    record.role !== 'MEMBER' ||
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 0 ||
    typeof record.updatedAt !== 'string' ||
    record.joinAction !== 'OPEN_COMMUNITY'
  ) {
    throw new Error('COMMUNITY_DIRECT_INVITE_COMMAND_RESULT_INVALID');
  }
  return record as unknown as CommunityDirectInviteMembership;
}

function storedGrant(value: unknown): CommunityDirectInviteQuotaGrantView {
  const record = storedRecord(value);
  if (
    typeof record.id !== 'string' ||
    typeof record.communityId !== 'string' ||
    typeof record.authorizedByUserId !== 'string' ||
    !['ACTIVE', 'CONSUMED', 'EXPIRED'].includes(String(record.state)) ||
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.expiresAt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !(record.consumedAt === null || typeof record.consumedAt === 'string')
  ) {
    throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_COMMAND_RESULT_INVALID');
  }
  return record as unknown as CommunityDirectInviteQuotaGrantView;
}

async function actorIsActive(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
): Promise<boolean> {
  const row = await queryOne<ActorRow>(
    client,
    `select status from identity.users where tenant_id = $1 and id = $2 for share`,
    [tenantId, actorUserId],
  );
  return row?.status === 'ACTIVE';
}

async function lockIdempotency(client: PoolClient, input: CommandBase): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-direct-invite-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
}

async function lockQuotaGrantIdempotency(
  client: PoolClient,
  input: CommunityDirectInviteQuotaGrantInput,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-direct-invite-quota-grant-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
  ]);
}

async function lockInvite(client: PoolClient, tenantId: string, inviteId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-direct-invite:${tenantId}:${inviteId}`,
  ]);
}

async function lockCommunityInviteIssuance(
  client: PoolClient,
  tenantId: string,
  communityId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-direct-invite-issuance:${tenantId}:${communityId}`,
  ]);
}

async function lockMembership(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  userId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-membership:${tenantId}:${communityId}:${userId}`,
  ]);
}

async function lockMemberships(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of [...new Set(userIds)].sort()) {
    await lockMembership(client, tenantId, communityId, userId);
  }
}

async function applyTransactionBudgets(client: PoolClient): Promise<void> {
  await client.query("set local lock_timeout = '2s'");
  await client.query("set local statement_timeout = '5s'");
}

async function currentCommand(
  client: PoolClient,
  input: CommandBase,
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from communities.direct_invite_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function currentQuotaGrantCommand(
  client: PoolClient,
  input: CommunityDirectInviteQuotaGrantInput,
): Promise<GrantCommandRow | undefined> {
  return queryOne<GrantCommandRow>(
    client,
    `select request_hash, result_payload
       from communities.direct_invite_quota_grant_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function recordQuotaGrantCommand(
  client: PoolClient,
  input: CommunityDirectInviteQuotaGrantInput,
  grantId: string,
  resultPayload: unknown,
): Promise<void> {
  await client.query(
    `insert into communities.direct_invite_quota_grant_commands (
       tenant_id, actor_user_id, idempotency_key, request_hash,
       community_id, grant_id, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      input.requestHash,
      input.communityId,
      grantId,
      JSON.stringify(resultPayload),
    ],
  );
}

async function recordCommand(
  client: PoolClient,
  input: CommandBase,
  commandType: CommandType,
  inviteId: string,
  communityId: string,
  subjectUserId: string | null,
  resultPayload: unknown,
  quotaGrantId?: string,
): Promise<void> {
  await client.query(
    `insert into communities.direct_invite_commands (
       tenant_id, actor_user_id, idempotency_key, command_type,
       request_hash, invite_id, community_id, subject_user_id, result_payload,
       quota_grant_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      commandType,
      input.requestHash,
      inviteId,
      communityId,
      subjectUserId,
      JSON.stringify(resultPayload),
      quotaGrantId ?? null,
    ],
  );
}

async function currentIssueQuota(
  client: PoolClient,
  tenantId: string,
  communityId: string,
): Promise<QuotaRow> {
  const row = await queryOne<QuotaRow>(
    client,
    `with active_quota as (
       select count(*) as active_count,
              ceil(extract(epoch from greatest(
                min(invite.expires_at) - now(), interval '1 second'
              )))::bigint as active_retry_after_seconds
         from communities.direct_invites invite
        where invite.tenant_id = $1
          and invite.community_id = $2
          and invite.state = 'ACTIVE'
          and invite.expires_at > now()
     ), issue_window as (
       select cmd.created_at
         from communities.direct_invite_commands cmd
        where cmd.tenant_id = $1
          and cmd.community_id = $2
          and cmd.command_type = 'ISSUE'
          and cmd.created_at > now() - interval '24 hours'
       union all
       select cmd.created_at
         from communities.direct_invite_commands cmd
         join communities.direct_invites invite
           on invite.tenant_id = cmd.tenant_id
          and invite.id = cmd.invite_id
        where cmd.tenant_id = $1
          and cmd.community_id is null
          and invite.community_id = $2
          and cmd.command_type = 'ISSUE'
          and cmd.created_at > now() - interval '24 hours'
     ), issue_quota as (
       select count(*) as daily_count,
              ceil(extract(epoch from greatest(
                min(created_at) + interval '24 hours' - now(), interval '1 second'
              )))::bigint as daily_retry_after_seconds
         from issue_window
     )
     select active_quota.active_count, active_quota.active_retry_after_seconds,
            issue_quota.daily_count, issue_quota.daily_retry_after_seconds
       from active_quota cross join issue_quota`,
    [tenantId, communityId],
  );
  if (!row) throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_RESULT_INVALID');
  return row;
}

function retryAfterSeconds(value: number | string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_RESULT_INVALID');
  }
  return Math.ceil(parsed);
}

async function recordAudit(
  client: PoolClient,
  input: CommandBase,
  action: string,
  inviteId: string,
  previous: unknown,
  next: unknown,
  resourceType = 'COMMUNITY_DIRECT_INVITE',
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, $3, $4, $5,
               'SUCCESS', $6, $7::jsonb, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      action,
      resourceType,
      inviteId,
      input.correlationId,
      JSON.stringify(previous),
      JSON.stringify(next),
    ],
  );
}

async function recordOutbox(
  client: PoolClient,
  input: CommandBase,
  eventType: string,
  communityId: string,
  payload: unknown,
): Promise<void> {
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [input.tenantId, eventType, communityId, input.correlationId, JSON.stringify(payload)],
  );
}

async function expireStaleQuotaGrant(
  client: PoolClient,
  input: CommandBase,
  communityId: string,
): Promise<void> {
  const row = await queryOne<GrantRow>(
    client,
    `update communities.direct_invite_quota_grants
        set state = 'EXPIRED', revision = revision + 1, updated_at = now()
      where tenant_id = $1 and community_id = $2
        and state = 'ACTIVE' and expires_at <= now()
      returning id, community_id, authorized_by_user_id, state, revision,
                expires_at, created_at, updated_at, consumed_at`,
    [input.tenantId, communityId],
  );
  if (!row) return;
  const grant = grantView(row);
  await recordAudit(
    client,
    input,
    'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_EXPIRED',
    grant.id,
    null,
    grant,
    'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT',
  );
  await recordOutbox(
    client,
    input,
    COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_EXPIRED_EVENT,
    communityId,
    {
      grantId: grant.id,
      communityId,
      grantRevision: grant.revision,
      expiredAt: grant.updatedAt,
    },
  );
}

async function activeQuotaGrant(
  client: PoolClient,
  tenantId: string,
  communityId: string,
): Promise<GrantRow | undefined> {
  return queryOne<GrantRow>(
    client,
    `select id, community_id, authorized_by_user_id, state, revision,
            expires_at, created_at, updated_at, consumed_at
       from communities.direct_invite_quota_grants
      where tenant_id = $1 and community_id = $2
        and state = 'ACTIVE' and expires_at > now()
      for update`,
    [tenantId, communityId],
  );
}

async function consumeQuotaGrant(
  client: PoolClient,
  input: CommandBase,
  row: GrantRow,
  invite: CommunityDirectInviteView,
): Promise<CommunityDirectInviteQuotaGrantView> {
  const consumed = await queryOne<GrantRow>(
    client,
    `update communities.direct_invite_quota_grants
        set state = 'CONSUMED', revision = revision + 1,
            consumed_by_invite_id = $3, consumed_at = now(), updated_at = now()
      where tenant_id = $1 and id = $2 and state = 'ACTIVE'
        and revision = $4 and expires_at > now()
      returning id, community_id, authorized_by_user_id, state, revision,
                expires_at, created_at, updated_at, consumed_at`,
    [input.tenantId, row.id, invite.id, Number(row.revision)],
  );
  if (!consumed) throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CONCURRENT_UPDATE');
  const previous = grantView(row);
  const grant = grantView(consumed);
  await recordAudit(
    client,
    input,
    'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CONSUMED',
    grant.id,
    previous,
    { grant, inviteId: invite.id, issuedByUserId: input.actorUserId },
    'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT',
  );
  await recordOutbox(
    client,
    input,
    COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CONSUMED_EVENT,
    invite.communityId,
    {
      grantId: grant.id,
      communityId: invite.communityId,
      inviteId: invite.id,
      issuedByUserId: input.actorUserId,
      grantRevision: grant.revision,
      consumedAt: grant.consumedAt,
    },
  );
  return grant;
}

async function actorCanManageInvites(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  actorUserId: string,
): Promise<boolean> {
  const row = await managementMembership(client, tenantId, communityId, actorUserId);
  return row !== undefined;
}

async function managementMembership(
  client: PoolClient,
  tenantId: string,
  communityId: string,
  actorUserId: string,
): Promise<MembershipRow | undefined> {
  return queryOne<MembershipRow>(
    client,
    `select status, role, revision, updated_at
       from communities.memberships membership
      where membership.tenant_id = $1
        and membership.community_id = $2
        and membership.user_id = $3
        and membership.status = 'ACTIVE'
        and membership.role in ('OWNER', 'ADMIN')`,
    [tenantId, communityId, actorUserId],
  );
}

async function inviteLocatorByHash(
  client: PoolClient,
  tenantId: string,
  tokenHash: string,
): Promise<InviteLocatorRow | undefined> {
  return queryOne<InviteLocatorRow>(
    client,
    `select id, community_id, issued_by_user_id
       from communities.direct_invites
      where tenant_id = $1 and token_hash = $2`,
    [tenantId, tokenHash],
  );
}

async function lockedEligibleInvite(
  client: PoolClient,
  tenantId: string,
  tokenHash: string,
): Promise<InviteRow | undefined> {
  return queryOne<InviteRow>(
    client,
    `select invite.id, invite.community_id, invite.issued_by_user_id,
            invite.token_key_id, invite.state, invite.revision,
            invite.expires_at, invite.created_at, invite.updated_at
       from communities.direct_invites invite
       join communities.communities community
         on community.tenant_id = invite.tenant_id
        and community.id = invite.community_id
        and community.status = 'ACTIVE'
       join identity.users issuer
         on issuer.tenant_id = invite.tenant_id
        and issuer.id = invite.issued_by_user_id
        and issuer.status = 'ACTIVE'
       join communities.memberships issuer_membership
         on issuer_membership.tenant_id = invite.tenant_id
        and issuer_membership.community_id = invite.community_id
        and issuer_membership.user_id = invite.issued_by_user_id
        and issuer_membership.status = 'ACTIVE'
        and issuer_membership.role in ('OWNER', 'ADMIN')
      where invite.tenant_id = $1
        and invite.token_hash = $2
        and invite.state = 'ACTIVE'
        and invite.expires_at > now()
      for share of invite`,
    [tenantId, tokenHash],
  );
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

function replayIssue(
  command: CommandRow,
  input: CommunityDirectInviteIssueInput,
): CommunityDirectInviteIssueResult {
  if (command.command_type !== 'ISSUE' || command.request_hash !== input.requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  const payload = storedRecord(command.result_payload);
  if (payload.outcome !== 'issued')
    throw new Error('COMMUNITY_DIRECT_INVITE_COMMAND_RESULT_INVALID');
  return { outcome: 'issued', invite: storedInvite(payload.invite), replayed: true };
}

function replayQuotaGrant(
  command: GrantCommandRow,
  input: CommunityDirectInviteQuotaGrantInput,
): CommunityDirectInviteQuotaGrantResult {
  if (command.request_hash !== input.requestHash) return { outcome: 'idempotency_conflict' };
  const payload = storedRecord(command.result_payload);
  if (payload.outcome !== 'granted') {
    throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_COMMAND_RESULT_INVALID');
  }
  return { outcome: 'granted', grant: storedGrant(payload.grant), replayed: true };
}

function replayRedeem(
  command: CommandRow,
  input: CommunityDirectInviteRedeemInput,
): CommunityDirectInviteRedeemResult {
  if (command.command_type !== 'REDEEM' || command.request_hash !== input.requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  const payload = storedRecord(command.result_payload);
  if (payload.outcome !== 'redeemed')
    throw new Error('COMMUNITY_DIRECT_INVITE_COMMAND_RESULT_INVALID');
  return {
    outcome: 'redeemed',
    invite: storedInvite(payload.invite),
    membership: storedMembership(payload.membership),
    replayed: true,
  };
}

function replayRevoke(
  command: CommandRow,
  input: CommunityDirectInviteRevokeInput,
): CommunityDirectInviteRevokeResult {
  if (command.command_type !== 'REVOKE' || command.request_hash !== input.requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  const payload = storedRecord(command.result_payload);
  if (payload.outcome !== 'revoked')
    throw new Error('COMMUNITY_DIRECT_INVITE_COMMAND_RESULT_INVALID');
  return { outcome: 'revoked', invite: storedInvite(payload.invite), replayed: true };
}

export function createCommunityDirectInviteRepository(pool: Pool): CommunityDirectInviteRepository {
  return {
    issue(input): Promise<CommunityDirectInviteIssueResult> {
      assertTokenHash(input.tokenHash);
      assertTokenKeyId(input.tokenKeyId);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await applyTransactionBudgets(client);
        await lockIdempotency(client, input);
        const command = await currentCommand(client, input);
        if (command) return replayIssue(command, input);
        await lockCommunityInviteIssuance(client, input.tenantId, input.communityId);
        await lockMembership(client, input.tenantId, input.communityId, input.actorUserId);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await queryOne<{ readonly id: string } & QueryResultRow>(
          client,
          `select id from communities.communities
            where tenant_id = $1 and id = $2 and status = 'ACTIVE' for share`,
          [input.tenantId, input.communityId],
        );
        if (!community) return { outcome: 'community_not_found' };
        const issuerMembership = await managementMembership(
          client,
          input.tenantId,
          input.communityId,
          input.actorUserId,
        );
        if (!issuerMembership) {
          return { outcome: 'permission_denied' };
        }
        if (Number(issuerMembership.revision) !== input.expectedIssuerMembershipRevision) {
          return {
            outcome: 'issuer_membership_revision_conflict',
            currentRevision: Number(issuerMembership.revision),
          };
        }
        const quota = await currentIssueQuota(client, input.tenantId, input.communityId);
        const activeExceeded = Number(quota.active_count) >= 5;
        const dailyExceeded = Number(quota.daily_count) >= 20;
        let quotaGrant: GrantRow | undefined;
        if (activeExceeded || dailyExceeded) {
          await expireStaleQuotaGrant(client, input, input.communityId);
          quotaGrant = await activeQuotaGrant(client, input.tenantId, input.communityId);
          if (!quotaGrant && activeExceeded) {
            return {
              outcome: 'active_limit_exceeded',
              retryAfterSeconds: retryAfterSeconds(quota.active_retry_after_seconds),
            };
          }
          if (!quotaGrant && dailyExceeded) {
            return {
              outcome: 'daily_limit_exceeded',
              retryAfterSeconds: retryAfterSeconds(quota.daily_retry_after_seconds),
            };
          }
        }
        const row = await queryOne<InviteRow>(
          client,
          `insert into communities.direct_invites (
             tenant_id, community_id, token_hash, token_key_id, issued_by_user_id, expires_at
           ) values ($1, $2, $3, $4, $5, now() + interval '7 days')
           returning id, community_id, issued_by_user_id, token_key_id, state,
                     revision, expires_at, created_at, updated_at`,
          [input.tenantId, input.communityId, input.tokenHash, input.tokenKeyId, input.actorUserId],
        );
        if (!row) throw new Error('COMMUNITY_DIRECT_INVITE_INSERT_FAILED');
        const invite = inviteView(row);
        const consumedGrant = quotaGrant
          ? await consumeQuotaGrant(client, input, quotaGrant, invite)
          : undefined;
        const payload = { outcome: 'issued' as const, invite };
        await recordCommand(
          client,
          input,
          'ISSUE',
          invite.id,
          invite.communityId,
          null,
          payload,
          consumedGrant?.id,
        );
        await recordAudit(client, input, 'COMMUNITY_DIRECT_INVITE_ISSUED', invite.id, null, {
          invite,
          quotaGrantId: consumedGrant?.id ?? null,
        });
        await recordOutbox(
          client,
          input,
          COMMUNITY_DIRECT_INVITE_ISSUED_EVENT,
          invite.communityId,
          {
            inviteId: invite.id,
            communityId: invite.communityId,
            issuedByUserId: invite.issuedByUserId,
            tokenKeyId: invite.tokenKeyId,
            inviteRevision: invite.revision,
            expiresAt: invite.expiresAt,
            issuedAt: invite.createdAt,
          },
        );
        return { ...payload, replayed: false };
      });
    },

    createQuotaGrant(
      input: CommunityDirectInviteQuotaGrantInput,
    ): Promise<CommunityDirectInviteQuotaGrantResult> {
      assertQuotaGrantAuthorization(input);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await applyTransactionBudgets(client);
        await lockQuotaGrantIdempotency(client, input);
        const command = await currentQuotaGrantCommand(client, input);
        if (command) return replayQuotaGrant(command, input);
        await lockCommunityInviteIssuance(client, input.tenantId, input.communityId);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await queryOne<{ readonly id: string } & QueryResultRow>(
          client,
          `select id from communities.communities
            where tenant_id = $1 and id = $2 and status = 'ACTIVE' for share`,
          [input.tenantId, input.communityId],
        );
        if (!community) return { outcome: 'community_not_found' };
        await expireStaleQuotaGrant(client, input, input.communityId);
        const active = await activeQuotaGrant(client, input.tenantId, input.communityId);
        if (active) {
          return {
            outcome: 'active_grant_exists',
            currentGrantId: active.id,
            currentRevision: Number(active.revision),
            expiresAt: timestamp(active.expires_at),
          };
        }
        const row = await queryOne<GrantRow>(
          client,
          `insert into communities.direct_invite_quota_grants (
             tenant_id, community_id, authorized_by_user_id,
             capability, reason_code, ticket_id, expires_at
           ) values ($1, $2, $3, $4, $5, $6, now() + interval '24 hours')
           returning id, community_id, authorized_by_user_id, state, revision,
                     expires_at, created_at, updated_at, consumed_at`,
          [
            input.tenantId,
            input.communityId,
            input.actorUserId,
            input.capability,
            input.reasonCode,
            input.ticketId,
          ],
        );
        if (!row) throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_INSERT_FAILED');
        const grant = grantView(row);
        const payload = { outcome: 'granted' as const, grant };
        await recordQuotaGrantCommand(client, input, grant.id, payload);
        await recordAudit(
          client,
          input,
          'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CREATED',
          grant.id,
          null,
          {
            grant,
            authorization: {
              capability: input.capability,
              reasonCode: input.reasonCode,
              ticketId: input.ticketId,
            },
          },
          'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT',
        );
        await recordOutbox(
          client,
          input,
          COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_CREATED_EVENT,
          input.communityId,
          {
            grantId: grant.id,
            communityId: grant.communityId,
            authorizedByUserId: grant.authorizedByUserId,
            grantRevision: grant.revision,
            expiresAt: grant.expiresAt,
            createdAt: grant.createdAt,
          },
        );
        return { ...payload, replayed: false };
      });
    },

    preview(input): Promise<CommunityDirectInvitePreviewResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await applyTransactionBudgets(client);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        if (!TOKEN_HASH_PATTERN.test(input.tokenHash)) return { outcome: 'invalid' };
        const row = await queryOne<PreviewRow>(
          client,
          `select invite.id as invite_id, invite.revision as invite_revision,
                  invite.community_id, community.title, community.logo_url,
                  community.visibility, community.is_verified, invite.expires_at,
                  viewer.status as viewer_status, viewer.revision as viewer_revision
             from communities.direct_invites invite
             join communities.communities community
               on community.tenant_id = invite.tenant_id
              and community.id = invite.community_id
              and community.status = 'ACTIVE'
             join identity.users issuer
               on issuer.tenant_id = invite.tenant_id
              and issuer.id = invite.issued_by_user_id
              and issuer.status = 'ACTIVE'
             join communities.memberships issuer_membership
               on issuer_membership.tenant_id = invite.tenant_id
              and issuer_membership.community_id = invite.community_id
              and issuer_membership.user_id = invite.issued_by_user_id
              and issuer_membership.status = 'ACTIVE'
              and issuer_membership.role in ('OWNER', 'ADMIN')
             left join communities.memberships viewer
               on viewer.tenant_id = invite.tenant_id
              and viewer.community_id = invite.community_id
              and viewer.user_id = $3
            where invite.tenant_id = $1
              and invite.token_hash = $2
              and invite.state = 'ACTIVE'
              and invite.expires_at > now()`,
          [input.tenantId, input.tokenHash, input.actorUserId],
        );
        if (!row) return { outcome: 'invalid' };
        if (row.viewer_status === 'BANNED') return { outcome: 'membership_banned' };
        const membershipRevision = Number(row.viewer_revision ?? 0);
        return {
          outcome: 'found',
          preview: {
            inviteId: row.invite_id,
            inviteRevision: Number(row.invite_revision),
            communityId: row.community_id,
            title: row.title,
            logoUrl: row.logo_url,
            visibility: canonicalVisibility(row.visibility),
            isVerified: row.is_verified,
            expiresAt: timestamp(row.expires_at),
            membershipRevision,
            redeemAction:
              row.viewer_status === 'ACTIVE'
                ? 'OPEN_COMMUNITY'
                : row.viewer_status === 'PENDING'
                  ? 'REQUEST_PENDING'
                  : 'CONFIRM_MEMBERSHIP',
          },
        };
      });
    },

    listActive(input): Promise<CommunityDirectInviteListResult> {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
        return Promise.reject(new Error('COMMUNITY_DIRECT_INVITE_LIST_LIMIT_INVALID'));
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await applyTransactionBudgets(client);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const community = await queryOne<{ readonly id: string } & QueryResultRow>(
          client,
          `select id from communities.communities
            where tenant_id = $1 and id = $2 and status = 'ACTIVE' for share`,
          [input.tenantId, input.communityId],
        );
        if (!community) return { outcome: 'community_not_found' };
        if (
          !(await actorCanManageInvites(
            client,
            input.tenantId,
            input.communityId,
            input.actorUserId,
          ))
        ) {
          return { outcome: 'permission_denied' };
        }
        const cursor = input.cursor ? decodeCursor(input.cursor, input.communityId) : undefined;
        const result = await client.query<InviteListRow>(
          `select id, community_id, issued_by_user_id, token_key_id, state,
                  revision, expires_at, created_at,
                  created_at::text as sort_created_at, updated_at
             from communities.direct_invites
            where tenant_id = $1 and community_id = $2
              and state = 'ACTIVE' and expires_at > now()
              and (
                $3::timestamptz is null
                or created_at < $3::timestamptz
                or (created_at = $3::timestamptz and id < $4::uuid)
              )
            order by created_at desc, id desc
            limit $5`,
          [
            input.tenantId,
            input.communityId,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            input.limit + 1,
          ],
        );
        const page = result.rows.slice(0, input.limit);
        const items = page.map(inviteView);
        const last = page.at(-1);
        const nextCursor =
          result.rows.length > input.limit && last
            ? encodeCursor({
                v: 1,
                communityId: input.communityId,
                createdAt: last.sort_created_at,
                id: last.id,
              })
            : undefined;
        return { outcome: 'found', items, ...(nextCursor ? { nextCursor } : {}) };
      });
    },

    redeem(input): Promise<CommunityDirectInviteRedeemResult> {
      if (!input.confirmed) return Promise.resolve({ outcome: 'confirmation_required' });
      if (!TOKEN_HASH_PATTERN.test(input.tokenHash))
        return Promise.resolve({ outcome: 'invalid_invite' });
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await applyTransactionBudgets(client);
        await lockIdempotency(client, input);
        const command = await currentCommand(client, input);
        if (command) return replayRedeem(command, input);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const locator = await inviteLocatorByHash(client, input.tenantId, input.tokenHash);
        if (!locator) return { outcome: 'invalid_invite' };
        await lockMemberships(client, input.tenantId, locator.community_id, [
          locator.issued_by_user_id,
          input.actorUserId,
        ]);
        const lockedInvite = await lockedEligibleInvite(client, input.tenantId, input.tokenHash);
        if (!lockedInvite) return { outcome: 'invalid_invite' };
        if (Number(lockedInvite.revision) !== input.expectedInviteRevision) {
          return {
            outcome: 'invite_revision_conflict',
            currentRevision: Number(lockedInvite.revision),
          };
        }
        const previous = await lockedMembership(
          client,
          input.tenantId,
          locator.community_id,
          input.actorUserId,
        );
        if (previous?.status === 'BANNED') return { outcome: 'membership_banned' };
        if (previous?.status === 'PENDING') return { outcome: 'request_pending' };
        if (previous?.status === 'ACTIVE') return { outcome: 'membership_already_active' };
        const currentRevision = Number(previous?.revision ?? 0);
        if (currentRevision !== input.expectedMembershipRevision) {
          return { outcome: 'membership_revision_conflict', currentRevision };
        }

        let membershipRow: MembershipRow | undefined;
        if (!previous) {
          membershipRow = await queryOne<MembershipRow>(
            client,
            `insert into communities.memberships (
               tenant_id, community_id, user_id, role, status, joined_at, revision
             ) values ($1, $2, $3, 'MEMBER', 'ACTIVE', now(), 1)
             returning status, role, revision, updated_at`,
            [input.tenantId, locator.community_id, input.actorUserId],
          );
        } else {
          membershipRow = await queryOne<MembershipRow>(
            client,
            `update communities.memberships
                set status = 'ACTIVE', role = 'MEMBER', joined_at = now(), left_at = null,
                    requested_at = null, pinned_at = null,
                    revision = revision + 1, updated_at = now()
              where tenant_id = $1 and community_id = $2 and user_id = $3
                and status in ('LEFT', 'REMOVED') and revision = $4
              returning status, role, revision, updated_at`,
            [
              input.tenantId,
              locator.community_id,
              input.actorUserId,
              input.expectedMembershipRevision,
            ],
          );
        }
        if (!membershipRow) throw new Error('COMMUNITY_DIRECT_INVITE_MEMBERSHIP_CONCURRENT_UPDATE');
        const membership = membershipView(locator.community_id, membershipRow);
        const invite = inviteView(lockedInvite);
        const payload = { outcome: 'redeemed' as const, invite, membership };
        await recordCommand(
          client,
          input,
          'REDEEM',
          invite.id,
          invite.communityId,
          input.actorUserId,
          payload,
        );
        await recordAudit(client, input, 'COMMUNITY_DIRECT_INVITE_REDEEMED', invite.id, previous, {
          invite,
          membership,
        });
        await recordOutbox(
          client,
          input,
          COMMUNITY_DIRECT_INVITE_REDEEMED_EVENT,
          invite.communityId,
          {
            inviteId: invite.id,
            communityId: invite.communityId,
            userId: input.actorUserId,
            inviteRevision: invite.revision,
            membershipRevision: membership.revision,
            redeemedAt: membership.updatedAt,
          },
        );
        return { ...payload, replayed: false };
      });
    },

    revoke(input): Promise<CommunityDirectInviteRevokeResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await applyTransactionBudgets(client);
        await lockIdempotency(client, input);
        if (!(await actorIsActive(client, input.tenantId, input.actorUserId))) {
          return { outcome: 'actor_not_active' };
        }
        const command = await currentCommand(client, input);
        if (command) return replayRevoke(command, input);
        const locator = await queryOne<InviteLocatorRow>(
          client,
          `select id, community_id, issued_by_user_id
             from communities.direct_invites
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.inviteId],
        );
        if (!locator) return { outcome: 'invite_not_found' };
        await lockInvite(client, input.tenantId, locator.id);
        await lockMembership(client, input.tenantId, locator.community_id, input.actorUserId);
        if (
          !(await actorCanManageInvites(
            client,
            input.tenantId,
            locator.community_id,
            input.actorUserId,
          ))
        ) {
          return { outcome: 'permission_denied' };
        }
        const current = await queryOne<InviteRow>(
          client,
          `select id, community_id, issued_by_user_id, token_key_id, state,
                  revision, expires_at, created_at, updated_at
             from communities.direct_invites
            where tenant_id = $1 and id = $2 and state = 'ACTIVE' and expires_at > now()
            for update`,
          [input.tenantId, input.inviteId],
        );
        if (!current) return { outcome: 'invite_not_active' };
        if (Number(current.revision) !== input.expectedInviteRevision) {
          return {
            outcome: 'invite_revision_conflict',
            currentRevision: Number(current.revision),
          };
        }
        const previous = inviteView(current);
        const row = await queryOne<InviteRow>(
          client,
          `update communities.direct_invites
              set state = 'REVOKED', revision = revision + 1,
                  revoked_at = now(), updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'ACTIVE' and revision = $3
              and expires_at > now()
            returning id, community_id, issued_by_user_id, token_key_id, state,
                      revision, expires_at, created_at, updated_at`,
          [input.tenantId, input.inviteId, input.expectedInviteRevision],
        );
        if (!row) throw new Error('COMMUNITY_DIRECT_INVITE_REVOKE_CONCURRENT_UPDATE');
        const invite = inviteView(row);
        const payload = { outcome: 'revoked' as const, invite };
        await recordCommand(client, input, 'REVOKE', invite.id, invite.communityId, null, payload);
        await recordAudit(
          client,
          input,
          'COMMUNITY_DIRECT_INVITE_REVOKED',
          invite.id,
          previous,
          invite,
        );
        await recordOutbox(
          client,
          input,
          COMMUNITY_DIRECT_INVITE_REVOKED_EVENT,
          invite.communityId,
          {
            inviteId: invite.id,
            communityId: invite.communityId,
            revokedByUserId: input.actorUserId,
            inviteRevision: invite.revision,
            revokedAt: invite.updatedAt,
          },
        );
        return { ...payload, replayed: false };
      });
    },
  };
}
