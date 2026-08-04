import {
  COMMUNITY_MEMBERSHIP_PIN_CHANGED_EVENT,
  communityMembershipPinStateSchema,
  type CommunityMembershipPinCommandResult,
  type CommunityMembershipPinRepository,
  type CommunityMembershipPinState,
} from '@phub/communities';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

interface MembershipRow extends QueryResultRow {
  readonly pinned_at: Date | string | null;
  readonly revision: number | string;
  readonly updated_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

function membershipState(communityId: string, row: MembershipRow): CommunityMembershipPinState {
  return communityMembershipPinStateSchema.parse({
    communityId,
    pinned: row.pinned_at !== null,
    revision: Number(row.revision),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function storedMembership(value: unknown): CommunityMembershipPinState {
  return communityMembershipPinStateSchema.parse(value);
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
    `select request_hash, result_payload
       from communities.membership_pin_commands
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
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly expectedRevision: number;
    readonly membership: CommunityMembershipPinState;
  },
): Promise<void> {
  await client.query(
    `insert into communities.membership_pin_commands (
       tenant_id, actor_user_id, community_id, idempotency_key,
       request_hash, expected_revision, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      input.idempotencyKey,
      input.requestHash,
      input.expectedRevision,
      JSON.stringify(input.membership),
    ],
  );
}

async function recordAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly correlationId: string;
    readonly previous: CommunityMembershipPinState;
    readonly membership: CommunityMembershipPinState;
    readonly changed: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, $3, 'COMMUNITY_MEMBERSHIP', $4,
               'SUCCESS', $5, $6::jsonb, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.changed ? 'COMMUNITY_MEMBERSHIP_PIN_CHANGED' : 'COMMUNITY_MEMBERSHIP_PIN_UNCHANGED',
      input.communityId,
      input.correlationId,
      JSON.stringify(input.previous),
      JSON.stringify(input.membership),
    ],
  );
}

async function recordOutboxEvent(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly correlationId: string;
    readonly membership: CommunityMembershipPinState;
  },
): Promise<void> {
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      COMMUNITY_MEMBERSHIP_PIN_CHANGED_EVENT,
      input.communityId,
      input.correlationId,
      JSON.stringify({
        communityId: input.communityId,
        userId: input.actorUserId,
        pinned: input.membership.pinned,
        revision: input.membership.revision,
        changedAt: input.membership.updatedAt,
      }),
    ],
  );
}

export function createCommunityMembershipPinRepository(
  pool: Pool,
): CommunityMembershipPinRepository {
  return {
    setPin(input): Promise<CommunityMembershipPinCommandResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `community-pin-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);

        const command = await currentCommand(client, input);
        if (command) {
          if (command.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'applied',
            membership: storedMembership(command.result_payload),
            replayed: true,
          };
        }

        const row = await queryOne<MembershipRow>(
          client,
          `select m.pinned_at, m.revision, m.updated_at
             from communities.memberships m
             join communities.communities c
               on c.tenant_id = m.tenant_id and c.id = m.community_id
            where m.tenant_id = $1
              and m.community_id = $2
              and m.user_id = $3
              and m.status = 'ACTIVE'
              and c.status = 'ACTIVE'
            for update of m`,
          [input.tenantId, input.communityId, input.actorUserId],
        );
        if (!row) return { outcome: 'membership_not_found' };

        const previous = membershipState(input.communityId, row);
        if (previous.revision !== input.expectedRevision) {
          return { outcome: 'revision_conflict', currentRevision: previous.revision };
        }

        let membership = previous;
        const changed = previous.pinned !== input.pinned;
        if (changed) {
          const updated = await queryOne<MembershipRow>(
            client,
            `update communities.memberships
                set pinned_at = case when $4 then now() else null end,
                    revision = revision + 1,
                    updated_at = now()
              where tenant_id = $1
                and community_id = $2
                and user_id = $3
                and status = 'ACTIVE'
                and revision = $5
              returning pinned_at, revision, updated_at`,
            [
              input.tenantId,
              input.communityId,
              input.actorUserId,
              input.pinned,
              input.expectedRevision,
            ],
          );
          if (!updated) {
            throw new Error('COMMUNITY_MEMBERSHIP_PIN_CONCURRENT_UPDATE');
          }
          membership = membershipState(input.communityId, updated);
        }

        await recordCommand(client, { ...input, membership });
        await recordAudit(client, { ...input, previous, membership, changed });
        if (changed) await recordOutboxEvent(client, { ...input, membership });

        return { outcome: 'applied', membership, replayed: false };
      });
    },
  };
}
