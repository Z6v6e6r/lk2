-- Expand-only LOCAL_ONLY deferred friend request. A request aimed at an imported player row that
-- never signed in is stored against the legacy player association and delivered as a real
-- profile.friend_requests row once that association is proven for a live PadlHub account.
-- source_player_association_id is the same one-way 64-hex key already held by
-- integration.legacy_game_player_bindings; raw provider identifiers never enter this boundary.

create table profile.deferred_friend_requests (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  requester_user_id uuid not null,
  target_user_id uuid not null,
  source_player_association_id text not null check (source_player_association_id ~ '^[0-9a-f]{64}$'),
  state text not null default 'PENDING' check (state in ('PENDING', 'DELIVERED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  settled_reason text check (
    settled_reason is null
    or settled_reason in (
      'REQUEST_CREATED',
      'ALREADY_FRIEND',
      'RECIPROCAL_ACCEPTED',
      'SELF_TARGET',
      'TARGET_UNAVAILABLE',
      'WITHDRAWN'
    )
  ),
  delivered_request_id uuid,
  primary key (tenant_id, id),
  check (requester_user_id <> target_user_id),
  foreign key (tenant_id, requester_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, target_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, delivered_request_id) references profile.friend_requests(tenant_id, id),
  check (
    (
      state = 'PENDING'
      and settled_at is null
      and settled_reason is null
      and delivered_request_id is null
    )
    or (
      state = 'DELIVERED'
      and settled_at is not null
      and settled_reason is not null
    )
    or (
      state = 'CANCELLED'
      and settled_at is not null
      and settled_reason = 'WITHDRAWN'
      and delivered_request_id is null
    )
  )
);

-- One open deferred request per (requester, imported player row); mirrors friend_requests_pending_pair_idx.
-- phub:reviewed-new-table-index
create unique index deferred_friend_requests_pending_pair_idx
  on profile.deferred_friend_requests (tenant_id, requester_user_id, target_user_id)
  where state = 'PENDING';

-- The delivery sweep joins the stored association with a proven live account.
-- phub:reviewed-new-table-index
create index deferred_friend_requests_pending_association_idx
  on profile.deferred_friend_requests (tenant_id, source_player_association_id)
  where state = 'PENDING';

alter table profile.deferred_friend_requests enable row level security;

create policy profile_deferred_friend_requests_tenant_isolation
  on profile.deferred_friend_requests
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table profile.deferred_friend_requests force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'profile_deferred_friend_requests', 'LOCAL_ONLY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
