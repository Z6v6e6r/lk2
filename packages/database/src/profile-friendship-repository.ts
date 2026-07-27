import { profilePhotoDeliveryUrl } from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type FriendshipStatus = 'NONE' | 'FRIEND';

export interface FriendshipState {
  readonly userId: string;
  readonly status: FriendshipStatus;
  readonly createdAt: string | null;
}

export interface FriendSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly levelLabel: string | null;
  readonly addedAt: string;
  readonly route: string;
}

export interface FriendPage {
  readonly items: readonly FriendSummary[];
}

export type AddFriendResult =
  | {
      readonly outcome: 'applied';
      readonly friendship: FriendshipState;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'self_target' }
  | { readonly outcome: 'target_not_found' };

export interface ProfileFriendshipRepository {
  get(tenantId: string, viewerUserId: string, targetUserId: string): Promise<FriendshipState>;
  list(tenantId: string, viewerUserId: string, limit: number): Promise<FriendPage>;
  add(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<AddFriendResult>;
}

interface FriendshipRow extends QueryResultRow {
  readonly created_at: Date | string;
}

interface FriendRow extends QueryResultRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly level_label: string | null;
  readonly delivery_id: string | null;
  readonly created_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

function orderedPair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

function state(userId: string, createdAt: Date | string | null): FriendshipState {
  return {
    userId,
    status: createdAt === null ? 'NONE' : 'FRIEND',
    createdAt: createdAt === null ? null : new Date(createdAt).toISOString(),
  };
}

function storedState(value: unknown): FriendshipState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('userId' in value) ||
    typeof value.userId !== 'string' ||
    !('status' in value) ||
    value.status !== 'FRIEND' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('PROFILE_FRIENDSHIP_COMMAND_RESULT_INVALID');
  }
  return { userId: value.userId, status: value.status, createdAt: value.createdAt };
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
       from profile.friendship_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

export function createProfileFriendshipRepository(pool: Pool): ProfileFriendshipRepository {
  return {
    get(tenantId, viewerUserId, targetUserId) {
      if (viewerUserId === targetUserId) return Promise.resolve(state(targetUserId, null));
      const [leftUserId, rightUserId] = orderedPair(viewerUserId, targetUserId);
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<FriendshipRow>(
          client,
          `select created_at
             from profile.friendships
            where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
          [tenantId, leftUserId, rightUserId],
        );
        return state(targetUserId, row?.created_at ?? null);
      });
    },

    list(tenantId, viewerUserId, limit) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<FriendRow>(
          `with friend_ids as (
             select case
                      when left_user_id = $2 then right_user_id
                      else left_user_id
                    end as user_id,
                    created_at
               from profile.friendships
              where tenant_id = $1
                and (left_user_id = $2 or right_user_id = $2)
              order by created_at desc
              limit $3
           )
           select f.user_id,
                  coalesce(nullif(btrim(s.display_name), ''), 'Игрок ПадлХАБ') as display_name,
                  s.level_label,
                  p.delivery_id,
                  f.created_at
             from friend_ids f
             left join profile.user_summaries s
               on s.tenant_id = $1 and s.user_id = f.user_id
             left join integration.user_profile_photo_sync p
               on p.tenant_id = $1 and p.user_id = f.user_id
            order by f.created_at desc`,
          [tenantId, viewerUserId, limit],
        );
        return {
          items: result.rows.map((row) => ({
            userId: row.user_id,
            displayName: row.display_name,
            avatarUrl: row.delivery_id ? profilePhotoDeliveryUrl(tenantId, row.delivery_id) : null,
            levelLabel: row.level_label,
            addedAt: new Date(row.created_at).toISOString(),
            route: `/profile/${row.user_id}`,
          })),
        };
      });
    },

    add(input) {
      if (input.actorUserId === input.targetUserId) {
        return Promise.resolve({ outcome: 'self_target' });
      }
      const [leftUserId, rightUserId] = orderedPair(input.actorUserId, input.targetUserId);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await currentCommand(client, input);
        if (command) {
          if (command.request_hash !== input.requestHash) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'applied',
            friendship: storedState(command.result_payload),
            replayed: true,
          };
        }
        const target = await queryOne<QueryResultRow>(
          client,
          `select 1
             from identity.users
            where tenant_id = $1 and id = $2`,
          [input.tenantId, input.targetUserId],
        );
        if (!target) return { outcome: 'target_not_found' };
        const inserted = await queryOne<FriendshipRow>(
          client,
          `insert into profile.friendships (
             tenant_id, left_user_id, right_user_id, created_by
           ) values ($1, $2, $3, $4)
           on conflict (tenant_id, left_user_id, right_user_id)
           do nothing
           returning created_at`,
          [input.tenantId, leftUserId, rightUserId, input.actorUserId],
        );
        const current =
          inserted ??
          (await queryOne<FriendshipRow>(
            client,
            `select created_at
               from profile.friendships
              where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
            [input.tenantId, leftUserId, rightUserId],
          ));
        if (!current) throw new Error('PROFILE_FRIENDSHIP_INSERT_FAILED');
        const friendship = state(input.targetUserId, current.created_at);
        await client.query(
          `insert into profile.friendship_commands (
             tenant_id, actor_user_id, target_user_id, idempotency_key, request_hash, result_payload
           ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            input.targetUserId,
            input.idempotencyKey,
            input.requestHash,
            JSON.stringify(friendship),
          ],
        );
        if (inserted) {
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id,
               result, correlation_id, new_value
             ) values ($1, $2, 'PROFILE_FRIEND_ADDED', 'PROFILE_FRIENDSHIP', $3,
                       'SUCCESS', $4, $5::jsonb)`,
            [
              input.tenantId,
              input.actorUserId,
              input.targetUserId,
              input.correlationId,
              JSON.stringify(friendship),
            ],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'profile.friendship.created.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              input.actorUserId,
              input.correlationId,
              JSON.stringify({
                actorUserId: input.actorUserId,
                targetUserId: input.targetUserId,
                createdAt: friendship.createdAt,
              }),
            ],
          );
        }
        return { outcome: 'applied', friendship, replayed: false };
      });
    },
  };
}
