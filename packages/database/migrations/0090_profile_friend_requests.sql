-- Expand-only LOCAL_ONLY friendship request aggregate. A friendship is created only after the
-- target accepts the request; both users are PadlHub user UUIDs and provider identifiers never
-- enter this boundary.

create table profile.friend_requests (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  requester_user_id uuid not null,
  target_user_id uuid not null,
  state text not null default 'PENDING' check (
    state in ('PENDING', 'ACCEPTED', 'DECLINED')
  ),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (tenant_id, id),
  check (requester_user_id <> target_user_id),
  foreign key (tenant_id, requester_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, target_user_id) references identity.users(tenant_id, id),
  check ((state = 'PENDING' and responded_at is null) or (state <> 'PENDING' and responded_at is not null))
);

-- phub:reviewed-new-table-index
create unique index friend_requests_pending_pair_idx
  on profile.friend_requests (tenant_id, requester_user_id, target_user_id)
  where state = 'PENDING';

-- phub:reviewed-new-table-index
create index friend_requests_incoming_idx
  on profile.friend_requests (tenant_id, target_user_id, created_at desc)
  where state = 'PENDING';

-- phub:reviewed-new-table-index
create unique index friend_requests_accepted_unique_idx
  on profile.friend_requests (tenant_id, requester_user_id, target_user_id)
  where state = 'ACCEPTED';

create table profile.friend_request_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  target_user_id uuid not null,
  request_id uuid,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  check (actor_user_id <> target_user_id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, target_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, request_id) references profile.friend_requests(tenant_id, id)
);

create table profile.friend_request_responses (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_id uuid not null,
  action text not null check (action in ('ACCEPT', 'DECLINE')),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, request_id) references profile.friend_requests(tenant_id, id)
);

alter table profile.friend_requests enable row level security;
alter table profile.friend_request_commands enable row level security;
alter table profile.friend_request_responses enable row level security;

create policy profile_friend_requests_tenant_isolation on profile.friend_requests
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy profile_friend_request_commands_tenant_isolation on profile.friend_request_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy profile_friend_request_responses_tenant_isolation on profile.friend_request_responses
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table profile.friend_requests force row level security;
alter table profile.friend_request_commands force row level security;
alter table profile.friend_request_responses force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'profile_friend_requests', 'LOCAL_ONLY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
