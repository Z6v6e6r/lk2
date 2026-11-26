import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { queryOne } from './connection.js';

export async function lockGameFriendPair(
  client: PoolClient,
  tenantId: string,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  const [left, right] = [firstUserId, secondUserId].sort();
  // Friendship changes and chat blocks serialize on this same canonical pair.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${tenantId}:${left}:${right}`,
  ]);
}

export async function lockInviteableGameFriends(
  client: PoolClient,
  tenantId: string,
  organizerId: string,
  recipientIds: readonly string[],
): Promise<readonly string[]> {
  for (const recipientId of [...recipientIds].sort()) {
    await lockGameFriendPair(client, tenantId, organizerId, recipientId);
  }
  const result = await client.query<{ id: string }>(
    `select recipient.id
       from identity.users recipient
       join profile.friendships friendship
         on friendship.tenant_id = recipient.tenant_id
        and friendship.left_user_id = least($2::uuid, recipient.id)
        and friendship.right_user_id = greatest($2::uuid, recipient.id)
      where recipient.tenant_id = $1 and recipient.id = any($3::uuid[])
        and recipient.status = 'ACTIVE' and recipient.id <> $2
        and not exists (
          select 1 from messaging.user_blocks block
           where block.tenant_id = $1
             and ((block.blocker_user_id = $2 and block.blocked_user_id = recipient.id)
               or (block.blocked_user_id = $2 and block.blocker_user_id = recipient.id))
        )
      order by recipient.id
      for share of recipient`,
    [tenantId, organizerId, recipientIds],
  );
  return result.rows.map((row) => row.id);
}

export async function readGameFriendInvitation(
  client: PoolClient,
  tenantId: string,
  gameId: string,
  viewerId: string,
): Promise<{ readonly restricted: boolean; readonly invited: boolean }> {
  const row = await queryOne<{ restricted: boolean; invited: boolean }>(
    client,
    `select exists (
         select 1 from games.friend_invitations invite
          where invite.tenant_id = $1 and invite.game_id = $2
       ) as restricted,
       exists (
         select 1 from games.friend_invitations invite
         join games.games game on game.tenant_id = invite.tenant_id and game.id = invite.game_id
         join profile.friendships friendship
           on friendship.tenant_id = invite.tenant_id
          and friendship.left_user_id = least(game.organizer_user_id, invite.recipient_user_id)
          and friendship.right_user_id = greatest(game.organizer_user_id, invite.recipient_user_id)
          where invite.tenant_id = $1 and invite.game_id = $2 and invite.recipient_user_id = $3
            and invite.issued_at is not null and game.lifecycle_state = 'SCHEDULED'
            and coalesce(game.join_cutoff_at, game.starts_at) > now()
            and not exists (
              select 1 from messaging.user_blocks block where block.tenant_id = $1
                and ((block.blocker_user_id = game.organizer_user_id and block.blocked_user_id = $3)
                  or (block.blocked_user_id = game.organizer_user_id and block.blocker_user_id = $3))
            )
       ) as invited`,
    [tenantId, gameId, viewerId],
  );
  if (!row) throw new Error('GAME_FRIEND_INVITATION_READ_LOST');
  return row;
}

// The caller holds the game/create lock and is committing the scheduled state in this transaction.
export async function issueGameFriendInvitations(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly organizerId: string;
    readonly correlationId: string;
  },
  recipientIds: readonly string[],
): Promise<void> {
  const { tenantId, gameId, organizerId, correlationId } = input;
  if (recipientIds.length === 0) return;
  const issued = await client.query<{ recipient_user_id: string }>(
    `update games.friend_invitations invite set issued_at = now()
       from games.games game
      where invite.tenant_id = $1 and invite.game_id = $2
        and invite.recipient_user_id = any($3::uuid[]) and invite.issued_at is null
        and game.tenant_id = $1 and game.id = $2 and game.organizer_user_id = $4
        and game.lifecycle_state = 'SCHEDULED'
        and coalesce(game.join_cutoff_at, game.starts_at) > now()
      returning invite.recipient_user_id`,
    [tenantId, gameId, recipientIds, organizerId],
  );
  if (issued.rows.length === 0) return;
  await client.query(
    `insert into audit.audit_log
       (tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id, new_value)
     values ($1, $2, 'GAME_FRIEND_INVITATIONS_ISSUED', 'GAME', $3, 'SUCCESS', $4, $5::jsonb)`,
    [tenantId, organizerId, gameId, correlationId, JSON.stringify({ count: issued.rows.length })],
  );
  const title = 'Приглашение в игру';
  const body = 'Друг приглашает вас сыграть. Откройте игру, чтобы посмотреть детали.';
  const link = `/games/${gameId}`;
  await client.query(
    `insert into notifications.templates
       (tenant_id, template_key, version, locale, category, channels, title_template,
        body_template, deep_link_template, active)
     values ($1, 'game.friend.invited', 1, 'ru-RU', 'GAME', array['IN_APP']::text[], $2, $3,
             '/games/{{gameId}}', false)
     on conflict (tenant_id, template_key, version, locale) do nothing`,
    [tenantId, title, body],
  );
  const sourceEventId = randomUUID();
  await client.query(
    `with intents as (
       insert into notifications.intents
         (tenant_id, recipient_user_id, source_event_id, template_id, dedupe_key, render_data,
          rendered_title, rendered_body, rendered_deep_link, state, completed_at)
       select $1, recipient.id, $2, template.id, concat('game-friend-invite:', $3::uuid, ':', recipient.id),
              '{}'::jsonb, $4, $5, $6, 'DELIVERED', now()
         from unnest($7::uuid[]) recipient(id)
         join notifications.templates template on template.tenant_id = $1
           and template.template_key = 'game.friend.invited' and template.version = 1
           and template.locale = 'ru-RU'
         join notifications.tenant_runtime_settings runtime on runtime.tenant_id = $1
           and runtime.in_app_enabled
        where not exists (
           select 1 from notifications.user_preferences preference
            where preference.tenant_id = $1 and preference.user_id = recipient.id
              and preference.category = 'GAME' and preference.channel = 'IN_APP'
              and not preference.enabled
        )
       on conflict (tenant_id, dedupe_key) do nothing returning id, recipient_user_id
     ), deliveries as (
       insert into notifications.deliveries (tenant_id, intent_id, channel, state, completed_at)
       select $1, id, 'IN_APP', 'DELIVERED', now() from intents returning id
     ), inbox as (
       insert into notifications.inbox_items (tenant_id, intent_id, user_id, category, title, body, deep_link)
       select $1, id, recipient_user_id, 'GAME', $4, $5, $6 from intents returning id, user_id
     )
     insert into audit.outbox_events (tenant_id, event_type, aggregate_id, correlation_id, payload)
     select $1, 'notifications.inbox.created.v1', id, $8,
            jsonb_build_object('inboxItemId', id, 'recipientUserId', user_id) from inbox
     union all
     select $1, 'notifications.delivery.changed.v1', id, $8,
            jsonb_build_object('deliveryId', id, 'state', 'DELIVERED') from deliveries`,
    [
      tenantId,
      sourceEventId,
      gameId,
      title,
      body,
      link,
      issued.rows.map((row) => row.recipient_user_id),
      correlationId,
    ],
  );
}
