import {
  COMMUNITY_OWNER_TRANSFERRED_EVENT,
  communityOwnershipTransferStateSchema,
  type CommunityOwnershipTransferInput,
  type CommunityOwnershipTransferRepository,
  type CommunityOwnershipTransferResult,
  type CommunityOwnershipTransferState,
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

interface CommunityRow extends QueryResultRow {
  readonly status: string;
}

interface MembershipRow extends QueryResultRow {
  readonly user_id: string;
  readonly role: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
  readonly status: 'PENDING' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
  readonly revision: number | string;
}

interface UpdatedMembershipRow extends QueryResultRow {
  readonly revision: number | string;
  readonly updated_at: Date | string;
}

interface CountRow extends QueryResultRow {
  readonly count: number | string;
}

function storedTransfer(value: unknown): CommunityOwnershipTransferState {
  return communityOwnershipTransferStateSchema.parse(value);
}

async function currentCommand(
  client: PoolClient,
  input: CommunityOwnershipTransferInput,
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select request_hash, result_payload
       from communities.ownership_transfer_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

async function recordTransfer(
  client: PoolClient,
  input: CommunityOwnershipTransferInput,
  transfer: CommunityOwnershipTransferState,
): Promise<void> {
  await client.query(
    `insert into communities.ownership_transfer_commands (
       tenant_id, actor_user_id, community_id, target_user_id, idempotency_key,
       request_hash, expected_owner_revision, expected_target_revision, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      input.targetUserId,
      input.idempotencyKey,
      input.requestHash,
      input.expectedOwnerRevision,
      input.expectedTargetRevision,
      JSON.stringify(transfer),
    ],
  );

  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, 'COMMUNITY_OWNER_TRANSFERRED', 'COMMUNITY', $3,
               'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.communityId,
      input.correlationId,
      JSON.stringify({
        ownerUserId: input.actorUserId,
        ownerRevision: input.expectedOwnerRevision,
        targetUserId: input.targetUserId,
        targetRevision: input.expectedTargetRevision,
        targetRole: transfer.owner.previousRole,
      }),
      JSON.stringify(transfer),
    ],
  );

  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      COMMUNITY_OWNER_TRANSFERRED_EVENT,
      input.communityId,
      input.correlationId,
      JSON.stringify(transfer),
    ],
  );
}

export function createCommunityOwnershipTransferRepository(
  pool: Pool,
): CommunityOwnershipTransferRepository {
  return {
    transfer(input): Promise<CommunityOwnershipTransferResult> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `community-owner-transfer-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);

        const command = await currentCommand(client, input);
        if (command) {
          if (command.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'transferred',
            transfer: storedTransfer(command.result_payload),
            replayed: true,
          };
        }

        const actor = await queryOne<ActorRow>(
          client,
          `select status from identity.users
            where tenant_id = $1 and id = $2
            for share`,
          [input.tenantId, input.actorUserId],
        );
        if (actor?.status !== 'ACTIVE') return { outcome: 'actor_not_active' };

        const community = await queryOne<CommunityRow>(
          client,
          `select status from communities.communities
            where tenant_id = $1 and id = $2 and status = 'ACTIVE'
            for update`,
          [input.tenantId, input.communityId],
        );
        if (!community) return { outcome: 'community_not_found' };

        const membershipResult = await client.query<MembershipRow>(
          `select user_id, role, status, revision
             from communities.memberships
            where tenant_id = $1 and community_id = $2 and user_id in ($3, $4)
            order by user_id
            for update`,
          [input.tenantId, input.communityId, input.actorUserId, input.targetUserId],
        );
        const owner = membershipResult.rows.find((row) => row.user_id === input.actorUserId);
        const target = membershipResult.rows.find((row) => row.user_id === input.targetUserId);
        if (owner?.status !== 'ACTIVE' || owner.role !== 'OWNER') {
          return { outcome: 'actor_not_owner' };
        }
        if (!target || target.status !== 'ACTIVE' || target.role === 'OWNER') {
          return { outcome: 'target_not_active' };
        }

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `community-owner-quota:${input.tenantId}:${input.targetUserId}`,
        ]);

        const targetOwnerCount = await queryOne<CountRow>(
          client,
          `select count(*)::integer as count
             from communities.memberships membership
             join communities.communities community
               on community.tenant_id = membership.tenant_id
              and community.id = membership.community_id
            where membership.tenant_id = $1
              and membership.user_id = $2
              and membership.role = 'OWNER'
              and membership.status = 'ACTIVE'
              and community.status = 'ACTIVE'`,
          [input.tenantId, input.targetUserId],
        );
        if (Number(targetOwnerCount?.count ?? 0) >= 3) {
          return { outcome: 'target_active_owner_quota_exceeded' };
        }

        const ownerRevision = Number(owner.revision);
        if (ownerRevision !== input.expectedOwnerRevision) {
          return { outcome: 'owner_revision_conflict', currentRevision: ownerRevision };
        }
        const targetRevision = Number(target.revision);
        if (targetRevision !== input.expectedTargetRevision) {
          return { outcome: 'target_revision_conflict', currentRevision: targetRevision };
        }

        const previousOwner = await queryOne<UpdatedMembershipRow>(
          client,
          `update communities.memberships
              set role = 'ADMIN', revision = revision + 1, updated_at = now()
            where tenant_id = $1 and community_id = $2 and user_id = $3
              and status = 'ACTIVE' and role = 'OWNER' and revision = $4
          returning revision, updated_at`,
          [input.tenantId, input.communityId, input.actorUserId, input.expectedOwnerRevision],
        );
        if (!previousOwner) throw new Error('COMMUNITY_OWNER_TRANSFER_SOURCE_UPDATE_FAILED');

        const nextOwner = await queryOne<UpdatedMembershipRow>(
          client,
          `update communities.memberships
              set role = 'OWNER', revision = revision + 1, updated_at = now()
            where tenant_id = $1 and community_id = $2 and user_id = $3
              and status = 'ACTIVE' and role = $4 and revision = $5
          returning revision, updated_at`,
          [
            input.tenantId,
            input.communityId,
            input.targetUserId,
            target.role,
            input.expectedTargetRevision,
          ],
        );
        if (!nextOwner) throw new Error('COMMUNITY_OWNER_TRANSFER_TARGET_UPDATE_FAILED');

        const transfer = communityOwnershipTransferStateSchema.parse({
          communityId: input.communityId,
          previousOwner: {
            userId: input.actorUserId,
            role: 'ADMIN',
            revision: Number(previousOwner.revision),
          },
          owner: {
            userId: input.targetUserId,
            previousRole: target.role,
            role: 'OWNER',
            revision: Number(nextOwner.revision),
          },
          transferredAt: new Date(nextOwner.updated_at).toISOString(),
        });
        await recordTransfer(client, input, transfer);
        return { outcome: 'transferred', transfer, replayed: false };
      });
    },
  };
}
