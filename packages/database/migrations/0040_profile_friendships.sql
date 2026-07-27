-- Expand-only LOCAL_ONLY friendship aggregate. A friendship is symmetric and stores
-- PadlHub user UUIDs only; provider identifiers never enter this boundary.

create table profile.friendships (
  tenant_id uuid not null references identity.tenants(id),
  left_user_id uuid not null,
  right_user_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, left_user_id, right_user_id),
  check (left_user_id < right_user_id),
  foreign key (tenant_id, left_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, right_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id)
);

create table profile.friendship_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  target_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  check (actor_user_id <> target_user_id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, target_user_id) references identity.users(tenant_id, id)
);

create index profile_friendships_left_idx
  on profile.friendships (tenant_id, left_user_id, created_at desc);

create index profile_friendships_right_idx
  on profile.friendships (tenant_id, right_user_id, created_at desc);

alter table profile.friendships enable row level security;
alter table profile.friendship_commands enable row level security;

create policy profile_friendships_tenant_isolation on profile.friendships
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy profile_friendship_commands_tenant_isolation on profile.friendship_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table profile.friendships force row level security;
alter table profile.friendship_commands force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'profile_friendships', 'LOCAL_ONLY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
