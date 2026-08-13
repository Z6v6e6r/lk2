-- Expand-only idempotency state for contextual GAME conversations.
-- The existing contextual tenant gate defaults to false in 0057; this migration does not expose routes.

create table if not exists messaging.game_conversation_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  game_id uuid not null,
  conversation_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id)
);

create index if not exists game_conversation_commands_context_idx
  on messaging.game_conversation_commands (tenant_id, game_id, conversation_id);

alter table messaging.game_conversation_commands enable row level security;

create policy game_conversation_commands_tenant_isolation
  on messaging.game_conversation_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table messaging.game_conversation_commands force row level security;
