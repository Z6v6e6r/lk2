import { createHash } from 'node:crypto';

import { profilePhotoDeliveryUrl } from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';
import { profileReachableSql } from './profile-reachability-repository.js';

export type FriendshipStatus =
  'NONE' | 'FRIEND' | 'PENDING_OUTGOING' | 'PENDING_INCOMING' | 'PENDING_DEFERRED';

export interface FriendshipState {
  readonly userId: string;
  readonly status: FriendshipStatus;
  readonly createdAt: string | null;
  readonly requestId: string | null;
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

/**
 * An incoming request rendered in the "Уведомления" feed. The requester is addressed by PadlHub
 * UUID only; the accept/decline command uses `requestId` so the card never has to resolve state on
 * the client.
 */
export interface FriendRequestSummary {
  readonly requestId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly levelLabel: string | null;
  readonly createdAt: string;
  readonly route: string;
}

export interface FriendRequestPage {
  readonly items: readonly FriendRequestSummary[];
}

export interface RequestFriendInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface DeferredDeliveryResult {
  readonly delivered: number;
  readonly pending: number;
}

/** One phone proof can only ever name the few imported player keys that phone appears under. */
const MAX_DELIVERED_PLAYER_KEYS = 20;

export type RequestFriendResult =
  | {
      readonly outcome: 'applied';
      readonly friendship: FriendshipState;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'self_target' }
  | { readonly outcome: 'target_not_found' }
  | { readonly outcome: 'target_unreachable' };

export type RespondFriendRequestResult =
  | {
      readonly outcome: 'applied';
      readonly friendship: FriendshipState;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'idempotency_conflict' };

export interface ProfileFriendshipRepository {
  get(tenantId: string, viewerUserId: string, targetUserId: string): Promise<FriendshipState>;
  list(tenantId: string, viewerUserId: string, limit: number): Promise<FriendPage>;
  listIncoming(tenantId: string, viewerUserId: string, limit: number): Promise<FriendRequestPage>;
  listOutgoing(tenantId: string, viewerUserId: string, limit: number): Promise<FriendRequestPage>;
  request(input: RequestFriendInput): Promise<RequestFriendResult>;
  remove(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly expectedCreatedAt: string;
    readonly requestHash: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<RespondFriendRequestResult | { readonly outcome: 'friendship_changed' }>;
  respond(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly action: 'ACCEPT' | 'DECLINE';
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<RespondFriendRequestResult>;
  /**
   * Delivers deferred requests whose imported player association is now proven for a live account.
   * Each row is settled exactly once; rows whose live account is still unreachable stay pending.
   */
  deliverDeferredFriendRequests(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<DeferredDeliveryResult>;
  /** True while at least one saved request still waits for a proven live account. */
  hasPendingDeferredRequests(tenantId: string): Promise<boolean>;
  /**
   * Delivers the saved requests that target one of the given imported player associations to the
   * account that just proved them. The proof is supplied by the caller and is deliberately not
   * persisted as an identity binding: it may only route a friend request, never re-point an
   * imported player or a roster.
   */
  deliverDeferredFriendRequestsForPlayerKeys(input: {
    readonly tenantId: string;
    readonly deliveryUserId: string;
    readonly sourcePlayerAssociationIds: readonly string[];
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<DeferredDeliveryResult>;
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

interface FriendRequestRow extends QueryResultRow {
  readonly id: string;
  readonly peer_user_id: string;
  readonly display_name: string;
  readonly level_label: string | null;
  readonly delivery_id: string | null;
  readonly created_at: Date | string;
}

interface PendingRequestRow extends QueryResultRow {
  readonly id: string;
  readonly created_at: Date | string;
}

interface RequestCommandRow extends QueryResultRow {
  readonly target_user_id: string;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface ResponseCommandRow extends QueryResultRow {
  readonly request_id: string;
  readonly action: string;
  readonly result_payload: unknown;
}

function orderedPair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

function state(
  userId: string,
  status: FriendshipStatus,
  createdAt: Date | string | null,
  requestId: string | null = null,
): FriendshipState {
  return {
    userId,
    status,
    createdAt: createdAt === null ? null : new Date(createdAt).toISOString(),
    requestId,
  };
}

function storedState(value: unknown): FriendshipState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('userId' in value) ||
    typeof value.userId !== 'string' ||
    !('status' in value) ||
    typeof value.status !== 'string' ||
    !['NONE', 'FRIEND', 'PENDING_OUTGOING', 'PENDING_INCOMING', 'PENDING_DEFERRED'].includes(
      value.status,
    ) ||
    !('createdAt' in value) ||
    (value.createdAt !== null && typeof value.createdAt !== 'string') ||
    !('requestId' in value) ||
    (value.requestId !== null && typeof value.requestId !== 'string')
  ) {
    throw new Error('PROFILE_FRIENDSHIP_COMMAND_RESULT_INVALID');
  }
  return {
    userId: value.userId,
    status: value.status as FriendshipStatus,
    createdAt: value.createdAt,
    requestId: value.requestId,
  };
}

/**
 * Distinguishes an unknown target from an active but unreachable imported record: only the latter
 * can sign in nowhere, so a request addressed to it would never be seen.
 */
async function classifyTarget(
  client: PoolClient,
  tenantId: string,
  targetUserId: string,
): Promise<'ok' | 'not_found' | 'unreachable'> {
  const reachable = await queryOne<QueryResultRow>(
    client,
    `select 1
       from identity.users
      where tenant_id = $1 and id = $2 and status = 'ACTIVE'
        and ${profileReachableSql({ tenantParam: '$1', userParam: '$2' })}`,
    [tenantId, targetUserId],
  );
  if (reachable) return 'ok';
  const active = await queryOne<QueryResultRow>(
    client,
    `select 1
       from identity.users
      where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
    [tenantId, targetUserId],
  );
  return active ? 'unreachable' : 'not_found';
}

function acceptedState(targetUserId: string, createdAt: Date | string): FriendshipState {
  return state(targetUserId, 'FRIEND', createdAt);
}

/**
 * Resolves the legacy player association of an imported record. The game import stores the
 * one-way 64-hex association key next to the synthesized account, which is what a deferred
 * request keeps: after the owner signs in, the mapping is re-pointed to the live account and the
 * phantom id no longer resolves, while the association key still matches the binding.
 *
 * `internal_id` is deliberately not unique per canonical key, so only an unambiguous answer is
 * accepted; anything else keeps today's explicit refusal instead of guessing a recipient.
 */
async function resolveLegacyAssociation(
  client: PoolClient,
  tenantId: string,
  targetUserId: string,
): Promise<string | null> {
  const rows = await client.query<{ external_id: string }>(
    `select distinct mapping.external_id
       from integration.external_entity_map mapping
      where mapping.tenant_id = $1
        and mapping.external_system = 'LK_LEGACY_SNAPSHOT'
        and mapping.entity_type = 'game_player'
        and mapping.internal_id = $2
        and mapping.external_id ~ '^[0-9a-f]{64}$'
      order by mapping.external_id
      limit 2`,
    [tenantId, targetUserId],
  );
  if (rows.rows.length !== 1) return null;
  return rows.rows[0]?.external_id ?? null;
}

/**
 * Creates the symmetric friendship row. Accepting a request and accepting a mutual request both go
 * through here so the aggregate keeps exactly one writer and one ordered pair.
 */
async function insertFriendship(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly leftUserId: string;
    readonly rightUserId: string;
    readonly createdBy: string;
  },
): Promise<Date | string> {
  const inserted = await queryOne<FriendshipRow>(
    client,
    `insert into profile.friendships (
       tenant_id, left_user_id, right_user_id, created_by
     ) values ($1, $2, $3, $4)
     on conflict (tenant_id, left_user_id, right_user_id)
     do nothing
     returning created_at`,
    [input.tenantId, input.leftUserId, input.rightUserId, input.createdBy],
  );
  if (inserted) return inserted.created_at;
  const current = await queryOne<FriendshipRow>(
    client,
    `select created_at
       from profile.friendships
      where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
    [input.tenantId, input.leftUserId, input.rightUserId],
  );
  if (!current) throw new Error('PROFILE_FRIENDSHIP_INSERT_FAILED');
  return current.created_at;
}

async function auditFriendRequest(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly action: string;
    readonly correlationId: string;
    readonly newValue: unknown;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, 'PROFILE_FRIEND_REQUEST', $4, 'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.action,
      input.requestId,
      input.correlationId,
      JSON.stringify(input.newValue),
    ],
  );
}

async function announceFriendshipCreated(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly correlationId: string;
    readonly createdAt: string | null;
  },
): Promise<void> {
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
        createdAt: input.createdAt,
      }),
    ],
  );
}

/**
 * Pending friend requests rendered in the "Уведомления" feed, from either side of the request. The
 * peer is addressed by PadlHub UUID only and the card never resolves state on the client.
 */
async function listPendingRequests(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly limit: number;
    readonly direction: 'incoming' | 'outgoing';
  },
): Promise<FriendRequestPage> {
  const viewerColumn =
    input.direction === 'incoming' ? 'request.target_user_id' : 'request.requester_user_id';
  const peerColumn =
    input.direction === 'incoming' ? 'request.requester_user_id' : 'request.target_user_id';
  const result = await client.query<FriendRequestRow>(
    `select request.id,
            ${peerColumn} as peer_user_id,
            coalesce(nullif(btrim(summary.display_name), ''), 'Игрок ПадлХАБ') as display_name,
            summary.level_label,
            photo.delivery_id,
            request.created_at
       from profile.friend_requests request
       left join profile.user_summaries summary
         on summary.tenant_id = request.tenant_id
        and summary.user_id = ${peerColumn}
       left join integration.user_profile_photo_sync photo
         on photo.tenant_id = request.tenant_id
        and photo.user_id = ${peerColumn}
      where request.tenant_id = $1
        and ${viewerColumn} = $2
        and request.state = 'PENDING'
      order by request.created_at desc
      limit $3`,
    [input.tenantId, input.viewerUserId, input.limit],
  );
  return {
    items: result.rows.map((row) => ({
      requestId: row.id,
      userId: row.peer_user_id,
      displayName: row.display_name,
      avatarUrl: row.delivery_id ? profilePhotoDeliveryUrl(input.tenantId, row.delivery_id) : null,
      levelLabel: row.level_label,
      createdAt: new Date(row.created_at).toISOString(),
      route: `/profile/${row.peer_user_id}`,
    })),
  };
}

/**
 * Creates a pending request, or keeps it as a deferred request when the target record belongs to
 * somebody who never signed in and its imported player association is known.
 */
function requestPendingFriendship(
  client: PoolClient,
  input: RequestFriendInput,
): Promise<RequestFriendResult> {
  // Deliveries resolve an imported legacy row to the live account, which can be the requester's own
  // account; the aggregate forbids a self request, so that row must settle instead of failing.
  if (input.actorUserId === input.targetUserId) {
    return Promise.resolve({ outcome: 'self_target' });
  }
  const [leftUserId, rightUserId] = orderedPair(input.actorUserId, input.targetUserId);
  return (async () => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.tenantId}:friend-request:${input.actorUserId}:${input.idempotencyKey}`,
    ]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.tenantId}:${leftUserId}:${rightUserId}`,
    ]);
    const previous = await queryOne<RequestCommandRow>(
      client,
      `select target_user_id, request_hash, result_payload
             from profile.friend_request_commands
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
            for update`,
      [input.tenantId, input.actorUserId, input.idempotencyKey],
    );
    if (previous) {
      if (previous.target_user_id !== input.targetUserId) {
        return { outcome: 'idempotency_conflict' };
      }
      if (previous.request_hash !== input.requestHash) {
        return { outcome: 'idempotency_conflict' };
      }
      return {
        outcome: 'applied',
        friendship: storedState(previous.result_payload),
        replayed: true,
      };
    }
    const targetState = await classifyTarget(client, input.tenantId, input.targetUserId);
    if (targetState === 'not_found') return { outcome: 'target_not_found' };
    if (targetState === 'unreachable') {
      // The record belongs to somebody who never signed in, so a durable request row would be
      // addressed to an account nobody opens. When the imported player association is known the
      // request is kept against it and delivered once that person signs in and is bound.
      const associationId = await resolveLegacyAssociation(
        client,
        input.tenantId,
        input.targetUserId,
      );
      if (!associationId) return { outcome: 'target_unreachable' };
      const pending = await queryOne<PendingRequestRow>(
        client,
        `select id, created_at
               from profile.deferred_friend_requests
              where tenant_id = $1 and requester_user_id = $2 and target_user_id = $3
                and state = 'PENDING'
              for update`,
        [input.tenantId, input.actorUserId, input.targetUserId],
      );
      const deferred =
        pending ??
        (await queryOne<PendingRequestRow>(
          client,
          `insert into profile.deferred_friend_requests (
                 tenant_id, requester_user_id, target_user_id, source_player_association_id
               ) values ($1, $2, $3, $4)
               returning id, created_at`,
          [input.tenantId, input.actorUserId, input.targetUserId, associationId],
        ));
      if (!deferred) throw new Error('PROFILE_DEFERRED_FRIEND_REQUEST_INSERT_FAILED');
      const current = state(input.targetUserId, 'PENDING_DEFERRED', deferred.created_at, null);
      if (!pending) {
        await auditFriendRequest(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          requestId: deferred.id,
          action: 'PROFILE_FRIEND_REQUEST_DEFERRED',
          correlationId: input.correlationId,
          newValue: current,
        });
      }
      // The command ledger keeps the client idempotency key replayable; `request_id` stays null
      // because no profile.friend_requests row exists yet.
      await recordRequestCommand(client, input, null, current);
      return { outcome: 'applied', friendship: current, replayed: false };
    }
    const friendship = await queryOne<FriendshipRow>(
      client,
      `select created_at
             from profile.friendships
            where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
      [input.tenantId, leftUserId, rightUserId],
    );
    if (friendship) {
      const current = state(input.targetUserId, 'FRIEND', friendship.created_at);
      await recordRequestCommand(client, input, null, current);
      return { outcome: 'applied', friendship: current, replayed: false };
    }
    // The other player already asked first: both sides want the friendship, so finish it.
    const reciprocal = await queryOne<PendingRequestRow>(
      client,
      `select id, created_at
             from profile.friend_requests
            where tenant_id = $1 and requester_user_id = $2 and target_user_id = $3
              and state = 'PENDING'
            for update`,
      [input.tenantId, input.targetUserId, input.actorUserId],
    );
    if (reciprocal) {
      const createdAt = await insertFriendship(client, {
        tenantId: input.tenantId,
        leftUserId,
        rightUserId,
        createdBy: input.targetUserId,
      });
      await client.query(
        `update profile.friend_requests
                set state = 'ACCEPTED', responded_at = now()
              where tenant_id = $1 and id = $2`,
        [input.tenantId, reciprocal.id],
      );
      const current = acceptedState(input.targetUserId, createdAt);
      await auditFriendRequest(client, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: reciprocal.id,
        action: 'PROFILE_FRIEND_REQUEST_ACCEPTED',
        correlationId: input.correlationId,
        newValue: current,
      });
      await announceFriendshipCreated(client, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        targetUserId: input.targetUserId,
        correlationId: input.correlationId,
        createdAt: current.createdAt,
      });
      await recordRequestCommand(client, input, reciprocal.id, current);
      return { outcome: 'applied', friendship: current, replayed: false };
    }
    const existing = await queryOne<PendingRequestRow>(
      client,
      `select id, created_at
             from profile.friend_requests
            where tenant_id = $1 and requester_user_id = $2 and target_user_id = $3
              and state = 'PENDING'`,
      [input.tenantId, input.actorUserId, input.targetUserId],
    );
    if (existing) {
      const current = state(
        input.targetUserId,
        'PENDING_OUTGOING',
        existing.created_at,
        existing.id,
      );
      await recordRequestCommand(client, input, existing.id, current);
      return { outcome: 'applied', friendship: current, replayed: false };
    }
    const inserted = await queryOne<PendingRequestRow>(
      client,
      `insert into profile.friend_requests (
             tenant_id, requester_user_id, target_user_id
           ) values ($1, $2, $3)
           returning id, created_at`,
      [input.tenantId, input.actorUserId, input.targetUserId],
    );
    if (!inserted) throw new Error('PROFILE_FRIEND_REQUEST_INSERT_FAILED');
    const current = state(input.targetUserId, 'PENDING_OUTGOING', inserted.created_at, inserted.id);
    await auditFriendRequest(client, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: inserted.id,
      action: 'PROFILE_FRIEND_REQUEST_CREATED',
      correlationId: input.correlationId,
      newValue: current,
    });
    await announceFriendRequestCreated(client, input, inserted.id, current);
    await recordRequestCommand(client, input, inserted.id, current);
    return { outcome: 'applied', friendship: current, replayed: false };
  })();
}

export function createProfileFriendshipRepository(pool: Pool): ProfileFriendshipRepository {
  return {
    get(tenantId, viewerUserId, targetUserId) {
      if (viewerUserId === targetUserId) {
        return Promise.resolve(state(targetUserId, 'NONE', null));
      }
      const [leftUserId, rightUserId] = orderedPair(viewerUserId, targetUserId);
      return withTenantTransaction(pool, tenantId, async (client) => {
        const friendship = await queryOne<FriendshipRow>(
          client,
          `select created_at
             from profile.friendships
            where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
          [tenantId, leftUserId, rightUserId],
        );
        if (friendship) return state(targetUserId, 'FRIEND', friendship.created_at);
        const outgoing = await queryOne<PendingRequestRow>(
          client,
          `select id, created_at
             from profile.friend_requests
            where tenant_id = $1 and requester_user_id = $2 and target_user_id = $3
              and state = 'PENDING'`,
          [tenantId, viewerUserId, targetUserId],
        );
        if (outgoing) {
          return state(targetUserId, 'PENDING_OUTGOING', outgoing.created_at, outgoing.id);
        }
        const incoming = await queryOne<PendingRequestRow>(
          client,
          `select id, created_at
             from profile.friend_requests
            where tenant_id = $1 and requester_user_id = $2 and target_user_id = $3
              and state = 'PENDING'`,
          [tenantId, targetUserId, viewerUserId],
        );
        if (incoming) {
          return state(targetUserId, 'PENDING_INCOMING', incoming.created_at, incoming.id);
        }
        const deferred = await queryOne<PendingRequestRow>(
          client,
          `select id, created_at
             from profile.deferred_friend_requests
            where tenant_id = $1 and requester_user_id = $2 and target_user_id = $3
              and state = 'PENDING'`,
          [tenantId, viewerUserId, targetUserId],
        );
        if (deferred) {
          return state(targetUserId, 'PENDING_DEFERRED', deferred.created_at, null);
        }
        // The worker has already turned a saved request into a real one addressed to the live
        // account. The imported row still has to report that waiting request, otherwise the
        // requester is invited to send the same invitation again.
        const delivered = await queryOne<PendingRequestRow>(
          client,
          `select request.id, request.created_at
             from profile.deferred_friend_requests deferred
             join profile.friend_requests request
               on request.tenant_id = deferred.tenant_id
              and request.id = deferred.delivered_request_id
            where deferred.tenant_id = $1 and deferred.requester_user_id = $2
              and deferred.target_user_id = $3
              and deferred.state = 'DELIVERED' and request.state = 'PENDING'`,
          [tenantId, viewerUserId, targetUserId],
        );
        if (delivered) {
          return state(targetUserId, 'PENDING_OUTGOING', delivered.created_at, delivered.id);
        }
        return state(targetUserId, 'NONE', null);
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

    listIncoming(tenantId, viewerUserId, limit) {
      return withTenantTransaction(pool, tenantId, (client) =>
        listPendingRequests(client, { tenantId, viewerUserId, limit, direction: 'incoming' }),
      );
    },

    listOutgoing(tenantId, viewerUserId, limit) {
      return withTenantTransaction(pool, tenantId, (client) =>
        listPendingRequests(client, { tenantId, viewerUserId, limit, direction: 'outgoing' }),
      );
    },

    request(input) {
      if (input.actorUserId === input.targetUserId) {
        return Promise.resolve({ outcome: 'self_target' });
      }
      return withTenantTransaction(pool, input.tenantId, (client) =>
        requestPendingFriendship(client, input),
      );
    },
    remove(input) {
      if (input.actorUserId === input.targetUserId)
        return Promise.resolve({ outcome: 'not_found' });
      const [leftUserId, rightUserId] = orderedPair(input.actorUserId, input.targetUserId);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:friendship-remove:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const previous = await queryOne<RequestCommandRow>(
          client,
          `select target_user_id, request_hash, result_payload from profile.friendship_commands
           where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3 for update`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (previous) {
          if (
            previous.target_user_id !== input.targetUserId ||
            previous.request_hash !== input.requestHash
          ) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'applied',
            friendship: storedState(previous.result_payload),
            replayed: true,
          };
        }
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${leftUserId}:${rightUserId}`,
        ]);
        const friendship = await queryOne<FriendshipRow>(
          client,
          `select created_at from profile.friendships
           where tenant_id = $1 and left_user_id = $2 and right_user_id = $3 for update`,
          [input.tenantId, leftUserId, rightUserId],
        );
        if (
          friendship &&
          new Date(friendship.created_at).toISOString() !== input.expectedCreatedAt
        ) {
          return { outcome: 'friendship_changed' };
        }
        // A fresh command against an absent friendship must not cancel a pending request.
        if (!friendship) return { outcome: 'not_found' };
        await client.query(
          `delete from profile.friendships
           where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
          [input.tenantId, leftUserId, rightUserId],
        );
        // DECLINED also retires a previously accepted request. Keep its row and command receipts,
        // and preserve its former state in the removal audit so a new request can be accepted.
        const retired = await client.query<{ id: string }>(
          `update profile.friend_requests set state = 'DECLINED'
           where tenant_id = $1 and state = 'ACCEPTED'
             and ((requester_user_id = $2 and target_user_id = $3)
               or (requester_user_id = $3 and target_user_id = $2)) returning id`,
          [input.tenantId, leftUserId, rightUserId],
        );
        const result = state(input.targetUserId, 'NONE', null);
        await client.query(
          `insert into profile.friendship_commands
           (tenant_id, actor_user_id, target_user_id, idempotency_key, request_hash, result_payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            input.targetUserId,
            input.idempotencyKey,
            input.requestHash,
            JSON.stringify(result),
          ],
        );
        const payload = {
          actorUserId: input.actorUserId,
          targetUserId: input.targetUserId,
          removedCreatedAt: input.expectedCreatedAt,
          retiredAcceptedRequestIds: retired.rows.map((row) => row.id),
        };
        await client.query(
          `insert into audit.audit_log
           (tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id, new_value)
           values ($1, $2, 'PROFILE_FRIENDSHIP_REMOVED', 'PROFILE_FRIENDSHIP', $3, 'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            input.targetUserId,
            input.correlationId,
            JSON.stringify(payload),
          ],
        );
        await client.query(
          `insert into audit.outbox_events (tenant_id, event_type, aggregate_id, correlation_id, payload)
           values ($1, 'profile.friendship.removed.v1', $2, $3, $4::jsonb)`,
          [input.tenantId, input.actorUserId, input.correlationId, JSON.stringify(payload)],
        );
        return { outcome: 'applied', friendship: result, replayed: false };
      });
    },

    respond(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:friend-response:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const previous = await queryOne<ResponseCommandRow>(
          client,
          `select request_id, action, result_payload
             from profile.friend_request_responses
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
            for update`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (previous) {
          if (previous.request_id !== input.requestId || previous.action !== input.action) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'applied',
            friendship: storedState(previous.result_payload),
            replayed: true,
          };
        }
        const identity = await queryOne<{ requester_user_id: string; target_user_id: string }>(
          client,
          `select requester_user_id, target_user_id from profile.friend_requests
           where tenant_id = $1 and id = $2`,
          [input.tenantId, input.requestId],
        );
        if (!identity || identity.target_user_id !== input.actorUserId)
          return { outcome: 'not_found' };
        const [pairLeft, pairRight] = orderedPair(
          identity.requester_user_id,
          identity.target_user_id,
        );
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:${pairLeft}:${pairRight}`,
        ]);
        const request = await queryOne<{
          readonly id: string;
          readonly requester_user_id: string;
          readonly target_user_id: string;
          readonly state: string;
        }>(
          client,
          `select id, requester_user_id, target_user_id, state
             from profile.friend_requests
            where tenant_id = $1 and id = $2
            for update`,
          [input.tenantId, input.requestId],
        );
        if (!request || request.target_user_id !== input.actorUserId) {
          return { outcome: 'not_found' };
        }
        if (request.state !== 'PENDING') {
          // A repeat answer for an already answered request keeps the aggregate idempotent.
          const settled = await settledState(client, input.tenantId, request, input.actorUserId);
          await recordResponseCommand(client, input, settled);
          return { outcome: 'applied', friendship: settled, replayed: false };
        }
        const [leftUserId, rightUserId] = orderedPair(
          request.requester_user_id,
          request.target_user_id,
        );
        if (input.action === 'DECLINE') {
          await client.query(
            `update profile.friend_requests
                set state = 'DECLINED', responded_at = now()
              where tenant_id = $1 and id = $2`,
            [input.tenantId, request.id],
          );
          const declined = state(request.requester_user_id, 'NONE', null);
          await auditFriendRequest(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            requestId: request.id,
            action: 'PROFILE_FRIEND_REQUEST_DECLINED',
            correlationId: input.correlationId,
            newValue: declined,
          });
          await recordResponseCommand(client, input, declined);
          return { outcome: 'applied', friendship: declined, replayed: false };
        }
        const createdAt = await insertFriendship(client, {
          tenantId: input.tenantId,
          leftUserId,
          rightUserId,
          createdBy: request.requester_user_id,
        });
        await client.query(
          `update profile.friend_requests
              set state = 'ACCEPTED', responded_at = now()
            where tenant_id = $1 and id = $2`,
          [input.tenantId, request.id],
        );
        const accepted = acceptedState(request.requester_user_id, createdAt);
        await auditFriendRequest(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          requestId: request.id,
          action: 'PROFILE_FRIEND_REQUEST_ACCEPTED',
          correlationId: input.correlationId,
          newValue: accepted,
        });
        await announceFriendshipCreated(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          targetUserId: request.requester_user_id,
          correlationId: input.correlationId,
          createdAt: accepted.createdAt,
        });
        await recordResponseCommand(client, input, accepted);
        return { outcome: 'applied', friendship: accepted, replayed: false };
      });
    },

    async deliverDeferredFriendRequests(input) {
      const candidates = await withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = await client.query<DeferredDeliveryCandidate>(
          `select deferred.id, deferred.requester_user_id, binding.user_id as live_user_id
             from profile.deferred_friend_requests deferred
             join integration.legacy_game_player_bindings binding
               on binding.tenant_id = deferred.tenant_id
              and binding.source_player_association_id = deferred.source_player_association_id
            where deferred.tenant_id = $1
              and deferred.state = 'PENDING'
            order by deferred.created_at
            limit $2`,
          [input.tenantId, input.limit],
        );
        return rows.rows;
      });
      return deliverDeferredCandidates(pool, input.tenantId, candidates, input.correlationId);
    },

    hasPendingDeferredRequests(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<{ readonly pending: boolean } & QueryResultRow>(
          client,
          `select exists (
                    select 1
                      from profile.deferred_friend_requests deferred
                     where deferred.tenant_id = $1 and deferred.state = 'PENDING'
                  ) as pending`,
          [tenantId],
        );
        return row?.pending === true;
      });
    },

    async deliverDeferredFriendRequestsForPlayerKeys(input) {
      const sourcePlayerAssociationIds = [
        ...new Set(input.sourcePlayerAssociationIds.map((id) => id.trim())),
      ]
        .filter((id) => /^[0-9a-f]{64}$/.test(id))
        .slice(0, MAX_DELIVERED_PLAYER_KEYS);
      if (sourcePlayerAssociationIds.length === 0) return { delivered: 0, pending: 0 };
      const candidates = await withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = await client.query<DeferredDeliveryCandidate>(
          `select deferred.id, deferred.requester_user_id, $3::uuid as live_user_id
             from profile.deferred_friend_requests deferred
            where deferred.tenant_id = $1
              and deferred.state = 'PENDING'
              and deferred.source_player_association_id = any($2::text[])
              and not exists (
                    select 1
                      from integration.legacy_game_player_bindings binding
                     where binding.tenant_id = deferred.tenant_id
                       and binding.source_player_association_id = deferred.source_player_association_id
                       and binding.user_id <> $3
                  )
            order by deferred.created_at
            limit $4`,
          [input.tenantId, sourcePlayerAssociationIds, input.deliveryUserId, input.limit],
        );
        return rows.rows;
      });
      return deliverDeferredCandidates(pool, input.tenantId, candidates, input.correlationId);
    },
  };
}

interface DeferredDeliveryCandidate {
  readonly id: string;
  readonly requester_user_id: string;
  readonly live_user_id: string;
}

/**
 * Delivers each candidate to its proven live account under the deterministic per-row idempotency key
 * and settles the row exactly once. A row the delivery cannot settle yet stays pending, because the
 * requester was told the request was saved.
 */
async function deliverDeferredCandidates(
  pool: Pool,
  tenantId: string,
  candidates: readonly DeferredDeliveryCandidate[],
  correlationId: string,
): Promise<DeferredDeliveryResult> {
  let delivered = 0;
  for (const candidate of candidates) {
    const requestId = `deferred-friend-request:${candidate.id}`;
    const result = await withTenantTransaction(pool, tenantId, (client) =>
      requestPendingFriendship(client, {
        tenantId,
        actorUserId: candidate.requester_user_id,
        targetUserId: candidate.live_user_id,
        idempotencyKey: requestId,
        requestHash: createHash('sha256').update(`DEFERRED:${candidate.id}`).digest('hex'),
        correlationId,
      }),
    );
    const settlement = deferredSettlement(result);
    if (!settlement) continue;
    const settled = await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update profile.deferred_friend_requests
            set state = 'DELIVERED', settled_at = now(), settled_reason = $3,
                delivered_request_id = $4
          where tenant_id = $1 and id = $2 and state = 'PENDING'`,
        [tenantId, candidate.id, settlement.reason, settlement.deliveredRequestId],
      ),
    );
    if ((settled.rowCount ?? 0) > 0) delivered += 1;
  }
  return { delivered, pending: candidates.length - delivered };
}

/**
 * Maps a delivery attempt to the terminal reason of the deferred row. `undefined` keeps the row
 * pending: the live account may still become reachable (or the binding may appear) later, and a
 * silent drop would contradict what the requester was told.
 */
function deferredSettlement(
  result: RequestFriendResult,
): { readonly reason: string; readonly deliveredRequestId: string | null } | undefined {
  if (result.outcome === 'idempotency_conflict') {
    throw new Error('PROFILE_DEFERRED_FRIEND_REQUEST_COMMAND_CONFLICT');
  }
  if (result.outcome === 'target_not_found') {
    return { reason: 'TARGET_UNAVAILABLE', deliveredRequestId: null };
  }
  if (result.outcome === 'self_target') {
    return { reason: 'SELF_TARGET', deliveredRequestId: null };
  }
  if (result.outcome === 'target_unreachable') return undefined;
  if (result.friendship.status === 'FRIEND') {
    return { reason: 'ALREADY_FRIEND', deliveredRequestId: null };
  }
  if (result.friendship.status === 'PENDING_DEFERRED') return undefined;
  return { reason: 'REQUEST_CREATED', deliveredRequestId: result.friendship.requestId };
}

async function settledState(
  client: PoolClient,
  tenantId: string,
  request: {
    readonly requester_user_id: string;
    readonly target_user_id: string;
    readonly state: string;
  },
  viewerUserId: string,
): Promise<FriendshipState> {
  const [leftUserId, rightUserId] = orderedPair(request.requester_user_id, request.target_user_id);
  const friendship = await queryOne<FriendshipRow>(
    client,
    `select created_at
       from profile.friendships
      where tenant_id = $1 and left_user_id = $2 and right_user_id = $3`,
    [tenantId, leftUserId, rightUserId],
  );
  const targetUserId =
    request.requester_user_id === viewerUserId ? request.target_user_id : request.requester_user_id;
  if (friendship) return state(targetUserId, 'FRIEND', friendship.created_at);
  return state(targetUserId, 'NONE', null);
}

async function recordRequestCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
  requestId: string | null,
  result: FriendshipState,
): Promise<void> {
  await client.query(
    `insert into profile.friend_request_commands (
       tenant_id, actor_user_id, idempotency_key, target_user_id, request_id,
       request_hash, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (tenant_id, actor_user_id, idempotency_key) do nothing`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      input.targetUserId,
      requestId,
      input.requestHash,
      JSON.stringify(result),
    ],
  );
}

async function recordResponseCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly action: 'ACCEPT' | 'DECLINE';
    readonly idempotencyKey: string;
  },
  result: FriendshipState,
): Promise<void> {
  await client.query(
    `insert into profile.friend_request_responses (
       tenant_id, actor_user_id, idempotency_key, request_id, action, result_payload
     ) values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (tenant_id, actor_user_id, idempotency_key) do nothing`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      input.requestId,
      input.action,
      JSON.stringify(result),
    ],
  );
}

async function announceFriendRequestCreated(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly correlationId: string;
  },
  requestId: string,
  result: FriendshipState,
): Promise<void> {
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, 'profile.friend_request.created.v1', $2, $3, $4::jsonb)`,
    [
      input.tenantId,
      requestId,
      input.correlationId,
      JSON.stringify({
        requestId,
        requesterUserId: input.actorUserId,
        targetUserId: input.targetUserId,
        // The notification ruleset addresses the account that has to answer, so the recipient is
        // resolved from the same `recipientUserIds` field every other trigger event uses.
        recipientUserIds: [input.targetUserId],
        createdAt: result.createdAt,
      }),
    ],
  );
}
