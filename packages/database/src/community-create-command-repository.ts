import {
  COMMUNITY_CREATE_QUOTA_GRANT_CONSUMED_EVENT,
  COMMUNITY_CREATE_QUOTA_GRANT_CREATED_EVENT,
  COMMUNITY_CREATE_QUOTA_GRANT_EXPIRED_EVENT,
  COMMUNITY_CREATED_EVENT,
  communityCreateQuotaGrantSchema,
  communityCreateStateSchema,
  type CommunityCreateCommandInput,
  type CommunityCreateCommandResult,
  type CommunityCreateQuotaGrant,
  type CommunityCreateQuotaGrantInput,
  type CommunityCreateQuotaScope,
  type CommunityCreateRepository,
  type CommunityCreateState,
} from '@phub/communities';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface ActorRow extends QueryResultRow {
  readonly status: string;
}

interface CountRow extends QueryResultRow {
  readonly count: number | string;
}

interface DailyQuotaRow extends QueryResultRow {
  readonly retry_after_seconds: number | string;
}

interface GrantCommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface GrantRow extends QueryResultRow {
  readonly id: string;
  readonly subject_user_id: string;
  readonly authorized_by_user_id: string;
  readonly scopes: CommunityCreateQuotaScope[];
  readonly state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  readonly revision: number | string;
  readonly expires_at: Date | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly consumed_at: Date | string | null;
}

interface CommunityRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly visibility: CommunityCreateState['visibility'];
  readonly join_policy: CommunityCreateState['joinPolicy'];
  readonly publishing_preset: CommunityCreateState['publishingPreset'];
  readonly status: 'ACTIVE';
  readonly revision: number | string;
  readonly created_by: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function communityState(row: CommunityRow): CommunityCreateState {
  return communityCreateStateSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    joinPolicy: row.join_policy,
    publishingPreset: row.publishing_preset,
    status: row.status,
    revision: Number(row.revision),
    ownerUserId: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function storedCommunity(value: unknown): CommunityCreateState {
  return communityCreateStateSchema.parse(value);
}

function grantState(row: GrantRow): CommunityCreateQuotaGrant {
  return communityCreateQuotaGrantSchema.parse({
    id: row.id,
    subjectUserId: row.subject_user_id,
    authorizedByUserId: row.authorized_by_user_id,
    scopes: row.scopes,
    state: row.state,
    revision: Number(row.revision),
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
  });
}

function storedGrant(value: unknown): CommunityCreateQuotaGrant {
  return communityCreateQuotaGrantSchema.parse(value);
}

async function lockOwnerQuota(client: PoolClient, tenantId: string, userId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `community-owner-quota:${tenantId}:${userId}`,
  ]);
}

async function currentCommand(
  client: PoolClient,
  input: Pick<CommunityCreateCommandInput, 'tenantId' | 'actorUserId' | 'idempotencyKey'>,
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select request_hash, result_payload
       from communities.create_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function currentGrantCommand(
  client: PoolClient,
  input: CommunityCreateQuotaGrantInput,
): Promise<GrantCommandRow | undefined> {
  return queryOne<GrantCommandRow>(
    client,
    `select request_hash, result_payload
       from communities.create_quota_grant_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function activeGrant(
  client: PoolClient,
  tenantId: string,
  subjectUserId: string,
): Promise<GrantRow | undefined> {
  return queryOne<GrantRow>(
    client,
    `select id, subject_user_id, authorized_by_user_id, scopes, state, revision,
            expires_at, created_at, updated_at, consumed_at
       from communities.create_quota_grants
      where tenant_id = $1 and subject_user_id = $2
        and state = 'ACTIVE' and expires_at > now()
      for update`,
    [tenantId, subjectUserId],
  );
}

async function recordGenericAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  },
  action: string,
  resourceType: string,
  resourceId: string,
  previous: unknown,
  next: unknown,
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7::jsonb, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      action,
      resourceType,
      resourceId,
      input.correlationId,
      JSON.stringify(previous),
      JSON.stringify(next),
    ],
  );
}

async function recordGenericOutbox(
  client: PoolClient,
  input: { readonly tenantId: string; readonly correlationId: string },
  eventType: string,
  aggregateId: string,
  payload: unknown,
): Promise<void> {
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [input.tenantId, eventType, aggregateId, input.correlationId, JSON.stringify(payload)],
  );
}

async function expireStaleGrant(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
  },
  subjectUserId: string,
): Promise<void> {
  const row = await queryOne<GrantRow>(
    client,
    `update communities.create_quota_grants
        set state = 'EXPIRED', revision = revision + 1, updated_at = now()
      where tenant_id = $1 and subject_user_id = $2
        and state = 'ACTIVE' and expires_at <= now()
      returning id, subject_user_id, authorized_by_user_id, scopes, state, revision,
                expires_at, created_at, updated_at, consumed_at`,
    [input.tenantId, subjectUserId],
  );
  if (!row) return;
  const grant = grantState(row);
  await recordGenericAudit(
    client,
    input,
    'COMMUNITY_CREATE_QUOTA_GRANT_EXPIRED',
    'COMMUNITY_CREATE_QUOTA_GRANT',
    grant.id,
    null,
    grant,
  );
  await recordGenericOutbox(
    client,
    input,
    COMMUNITY_CREATE_QUOTA_GRANT_EXPIRED_EVENT,
    grant.subjectUserId,
    {
      grantId: grant.id,
      subjectUserId: grant.subjectUserId,
      scopes: grant.scopes,
      revision: grant.revision,
      expiredAt: grant.updatedAt,
    },
  );
}

async function insertCommunity(
  client: PoolClient,
  input: CommunityCreateCommandInput,
): Promise<CommunityCreateState> {
  const row = await queryOne<CommunityRow>(
    client,
    `insert into communities.communities (
       tenant_id, title, description, visibility, join_policy,
       publishing_preset, status, revision, created_by
     ) values ($1, $2, $3, $4, $5, $6, 'ACTIVE', 1, $7)
     returning id, title, description, visibility, join_policy, publishing_preset,
               status, revision, created_by, created_at, updated_at`,
    [
      input.tenantId,
      input.title,
      input.description ?? null,
      input.visibility,
      input.joinPolicy,
      input.publishingPreset,
      input.actorUserId,
    ],
  );
  if (!row) throw new Error('COMMUNITY_CREATE_INSERT_FAILED');
  return communityState(row);
}

async function insertOwnerMembership(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  community: CommunityCreateState,
): Promise<void> {
  await client.query(
    `insert into communities.memberships (
       tenant_id, community_id, user_id, role, status, joined_at, revision
     ) values ($1, $2, $3, 'OWNER', 'ACTIVE', $4::timestamptz, 1)`,
    [input.tenantId, community.id, input.actorUserId, community.createdAt],
  );
}

async function recordCommand(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  community: CommunityCreateState,
  quotaGrantId?: string,
): Promise<void> {
  await client.query(
    `insert into communities.create_commands (
       tenant_id, actor_user_id, community_id, idempotency_key,
       request_hash, quota_override, quota_grant_id, result_payload
     ) values ($1, $2, $3, $4, $5, false, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      community.id,
      input.idempotencyKey,
      input.requestHash,
      quotaGrantId ?? null,
      JSON.stringify(community),
    ],
  );
}

async function recordAudit(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  community: CommunityCreateState,
  quotaGrant?: CommunityCreateQuotaGrant,
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, 'COMMUNITY_CREATED', 'COMMUNITY', $3,
               'SUCCESS', $4, $5::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      community.id,
      input.correlationId,
      JSON.stringify({
        ...community,
        quotaGrantId: quotaGrant?.id ?? null,
        quotaGrantScopes: quotaGrant?.scopes ?? [],
      }),
    ],
  );
}

async function recordOutboxEvent(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  community: CommunityCreateState,
  quotaGrant?: CommunityCreateQuotaGrant,
): Promise<void> {
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      COMMUNITY_CREATED_EVENT,
      community.id,
      input.correlationId,
      JSON.stringify({
        communityId: community.id,
        ownerUserId: input.actorUserId,
        title: community.title,
        visibility: community.visibility,
        joinPolicy: community.joinPolicy,
        publishingPreset: community.publishingPreset,
        revision: community.revision,
        createdAt: community.createdAt,
        quotaGrantId: quotaGrant?.id ?? null,
        quotaGrantScopes: quotaGrant?.scopes ?? [],
      }),
    ],
  );
}

async function consumeGrant(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  row: GrantRow,
  community: CommunityCreateState,
): Promise<CommunityCreateQuotaGrant> {
  const consumed = await queryOne<GrantRow>(
    client,
    `update communities.create_quota_grants
        set state = 'CONSUMED', revision = revision + 1,
            consumed_by_community_id = $3, consumed_at = now(), updated_at = now()
      where tenant_id = $1 and id = $2 and subject_user_id = $4
        and state = 'ACTIVE' and revision = $5 and expires_at > now()
      returning id, subject_user_id, authorized_by_user_id, scopes, state, revision,
                expires_at, created_at, updated_at, consumed_at`,
    [input.tenantId, row.id, community.id, input.actorUserId, Number(row.revision)],
  );
  if (!consumed) throw new Error('COMMUNITY_CREATE_QUOTA_GRANT_CONCURRENT_UPDATE');
  const previous = grantState(row);
  const grant = grantState(consumed);
  await recordGenericAudit(
    client,
    input,
    'COMMUNITY_CREATE_QUOTA_GRANT_CONSUMED',
    'COMMUNITY_CREATE_QUOTA_GRANT',
    grant.id,
    previous,
    { grant, communityId: community.id },
  );
  await recordGenericOutbox(
    client,
    input,
    COMMUNITY_CREATE_QUOTA_GRANT_CONSUMED_EVENT,
    grant.subjectUserId,
    {
      grantId: grant.id,
      subjectUserId: grant.subjectUserId,
      communityId: community.id,
      scopes: grant.scopes,
      revision: grant.revision,
      consumedAt: grant.consumedAt,
    },
  );
  return grant;
}

async function recordGrantCommand(
  client: PoolClient,
  input: CommunityCreateQuotaGrantInput,
  grant: CommunityCreateQuotaGrant,
): Promise<void> {
  await client.query(
    `insert into communities.create_quota_grant_commands (
       tenant_id, actor_user_id, subject_user_id, idempotency_key,
       request_hash, grant_id, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.subjectUserId,
      input.idempotencyKey,
      input.requestHash,
      grant.id,
      JSON.stringify({ outcome: 'granted', grant }),
    ],
  );
}

export function createCommunityCreateRepository(pool: Pool): CommunityCreateRepository {
  return {
    create(input): Promise<CommunityCreateCommandResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `community-create-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);

        const command = await currentCommand(client, input);
        if (command) {
          if (command.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'created',
            community: storedCommunity(command.result_payload),
            replayed: true,
          };
        }

        await lockOwnerQuota(client, input.tenantId, input.actorUserId);

        const actor = await queryOne<ActorRow>(
          client,
          `select status
             from identity.users
            where tenant_id = $1 and id = $2
            for share`,
          [input.tenantId, input.actorUserId],
        );
        if (actor?.status !== 'ACTIVE') return { outcome: 'actor_not_active' };

        const ownerCount = await queryOne<CountRow>(
          client,
          `select count(*)::integer as count
             from communities.memberships m
             join communities.communities c
               on c.tenant_id = m.tenant_id and c.id = m.community_id
            where m.tenant_id = $1
              and m.user_id = $2
              and m.role = 'OWNER'
              and m.status = 'ACTIVE'
              and c.status = 'ACTIVE'`,
          [input.tenantId, input.actorUserId],
        );
        const ownerExceeded = Number(ownerCount?.count ?? 0) >= 3;

        const dailyQuota = await queryOne<DailyQuotaRow>(
          client,
          `select greatest(
                    1,
                    ceil(extract(epoch from (created_at + interval '24 hours' - now())))::integer
                  ) as retry_after_seconds
             from communities.create_commands
            where tenant_id = $1
              and actor_user_id = $2
              and created_at > now() - interval '24 hours'
            order by created_at asc
            limit 1`,
          [input.tenantId, input.actorUserId],
        );

        let quotaGrant: GrantRow | undefined;
        if (ownerExceeded || dailyQuota) {
          await expireStaleGrant(client, input, input.actorUserId);
          quotaGrant = await activeGrant(client, input.tenantId, input.actorUserId);
        }
        if (ownerExceeded && !quotaGrant?.scopes.includes('ACTIVE_OWNER_LIMIT')) {
          return { outcome: 'active_owner_quota_exceeded' };
        }
        if (dailyQuota && !quotaGrant?.scopes.includes('DAILY_CREATE_LIMIT')) {
          return {
            outcome: 'daily_create_quota_exceeded',
            retryAfterSeconds: Math.max(1, Number(dailyQuota.retry_after_seconds)),
          };
        }

        const community = await insertCommunity(client, input);
        await insertOwnerMembership(client, input, community);
        const consumedGrant = quotaGrant
          ? await consumeGrant(client, input, quotaGrant, community)
          : undefined;
        await recordCommand(client, input, community, consumedGrant?.id);
        await recordAudit(client, input, community, consumedGrant);
        await recordOutboxEvent(client, input, community, consumedGrant);

        return { outcome: 'created', community, replayed: false };
      });
    },
    createQuotaGrant(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `community-create-quota-grant-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const command = await currentGrantCommand(client, input);
        if (command) {
          if (command.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' as const };
          }
          const payload = command.result_payload as { outcome?: unknown; grant?: unknown };
          if (payload.outcome !== 'granted') {
            throw new Error('COMMUNITY_CREATE_QUOTA_GRANT_COMMAND_RESULT_INVALID');
          }
          return { outcome: 'granted' as const, grant: storedGrant(payload.grant), replayed: true };
        }

        await lockOwnerQuota(client, input.tenantId, input.subjectUserId);
        const identities = await client.query<ActorRow & { readonly id: string }>(
          `select id, status from identity.users
            where tenant_id = $1 and id in ($2, $3)
            order by id for share`,
          [input.tenantId, input.actorUserId, input.subjectUserId],
        );
        if (
          !identities.rows.some((row) => row.id === input.actorUserId && row.status === 'ACTIVE')
        ) {
          return { outcome: 'actor_not_active' as const };
        }
        if (
          !identities.rows.some((row) => row.id === input.subjectUserId && row.status === 'ACTIVE')
        ) {
          return { outcome: 'subject_not_active' as const };
        }

        await expireStaleGrant(client, input, input.subjectUserId);
        const existing = await activeGrant(client, input.tenantId, input.subjectUserId);
        if (existing) {
          return {
            outcome: 'active_grant_exists' as const,
            currentGrantId: existing.id,
            expiresAt: new Date(existing.expires_at).toISOString(),
          };
        }

        const row = await queryOne<GrantRow>(
          client,
          `insert into communities.create_quota_grants (
             tenant_id, subject_user_id, authorized_by_user_id,
             capability, scopes, reason_code, ticket_id, expires_at
           ) values ($1, $2, $3, $4, $5::text[], $6, $7, now() + interval '24 hours')
           returning id, subject_user_id, authorized_by_user_id, scopes, state, revision,
                     expires_at, created_at, updated_at, consumed_at`,
          [
            input.tenantId,
            input.subjectUserId,
            input.actorUserId,
            input.capability,
            [...input.scopes],
            input.reasonCode,
            input.ticketId,
          ],
        );
        if (!row) throw new Error('COMMUNITY_CREATE_QUOTA_GRANT_INSERT_FAILED');
        const grant = grantState(row);
        await recordGrantCommand(client, input, grant);
        await recordGenericAudit(
          client,
          input,
          'COMMUNITY_CREATE_QUOTA_GRANT_CREATED',
          'COMMUNITY_CREATE_QUOTA_GRANT',
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
        );
        await recordGenericOutbox(
          client,
          input,
          COMMUNITY_CREATE_QUOTA_GRANT_CREATED_EVENT,
          input.subjectUserId,
          {
            grantId: grant.id,
            subjectUserId: grant.subjectUserId,
            authorizedByUserId: grant.authorizedByUserId,
            scopes: grant.scopes,
            revision: grant.revision,
            createdAt: grant.createdAt,
            expiresAt: grant.expiresAt,
          },
        );
        return { outcome: 'granted' as const, grant, replayed: false };
      });
    },
  };
}
