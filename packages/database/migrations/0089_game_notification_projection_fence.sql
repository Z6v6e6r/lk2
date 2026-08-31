-- A per-game delivery fence for at-least-once GAME notification source events.
-- This expand-only migration deliberately creates no tenant configuration or notification rules.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table notifications.game_notification_projection_fences (
  tenant_id uuid not null references identity.tenants(id),
  game_id uuid not null,
  recipient_user_id uuid not null,
  game_revision numeric not null check (game_revision::text ~ '^[1-9][0-9]*$'),
  game_event_type text not null check (
    game_event_type in (
      'game.participation.confirmed.v1',
      'game.participation.left.v1',
      'game.cancelled.v1'
    )
  ),
  game_fingerprint text not null check (game_fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, game_id, recipient_user_id)
);

alter table notifications.game_notification_projection_fences enable row level security;

create policy game_notification_projection_fences_tenant_isolation
  on notifications.game_notification_projection_fences
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.game_notification_projection_fences force row level security;
