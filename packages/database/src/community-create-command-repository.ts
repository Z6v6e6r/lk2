import {
  COMMUNITY_CREATED_EVENT,
  communityCreateStateSchema,
  type CommunityCreateCommandInput,
  type CommunityCreateCommandResult,
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
): Promise<void> {
  await client.query(
    `insert into communities.create_commands (
       tenant_id, actor_user_id, community_id, idempotency_key,
       request_hash, quota_override, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      community.id,
      input.idempotencyKey,
      input.requestHash,
      input.quotaOverride,
      JSON.stringify(community),
    ],
  );
}

async function recordAudit(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  community: CommunityCreateState,
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
      JSON.stringify({ ...community, quotaOverride: input.quotaOverride }),
    ],
  );
}

async function recordOutboxEvent(
  client: PoolClient,
  input: CommunityCreateCommandInput,
  community: CommunityCreateState,
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
      }),
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

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `community-create-quota:${input.tenantId}:${input.actorUserId}`,
        ]);

        const actor = await queryOne<ActorRow>(
          client,
          `select status
             from identity.users
            where tenant_id = $1 and id = $2
            for share`,
          [input.tenantId, input.actorUserId],
        );
        if (actor?.status !== 'ACTIVE') return { outcome: 'actor_not_active' };

        if (!input.quotaOverride) {
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
          if (Number(ownerCount?.count ?? 0) >= 3) {
            return { outcome: 'active_owner_quota_exceeded' };
          }

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
          if (dailyQuota) {
            return {
              outcome: 'daily_create_quota_exceeded',
              retryAfterSeconds: Math.max(1, Number(dailyQuota.retry_after_seconds)),
            };
          }
        }

        const community = await insertCommunity(client, input);
        await insertOwnerMembership(client, input, community);
        await recordCommand(client, input, community);
        await recordAudit(client, input, community);
        await recordOutboxEvent(client, input, community);

        return { outcome: 'created', community, replayed: false };
      });
    },
  };
}
