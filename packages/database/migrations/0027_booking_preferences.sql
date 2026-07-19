-- Expand-only LOCAL_ONLY preferences used to personalize PadlHub booking discovery.
-- Provider identifiers and subscription state are deliberately absent from this aggregate.

create table profile.booking_preferences (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  favorite_station_ids uuid[] not null default '{}'::uuid[]
    check (cardinality(favorite_station_ids) <= 3),
  preferred_time_windows jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(preferred_time_windows) = 'array'
      and jsonb_array_length(preferred_time_windows) <= 14
    ),
  use_history boolean not null default true,
  version integer not null default 1 check (version > 0),
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id)
);

create table profile.booking_preference_commands (
  tenant_id uuid not null,
  user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  expected_version integer not null check (expected_version >= 0),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, user_id, idempotency_key),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

alter table profile.booking_preferences enable row level security;
alter table profile.booking_preference_commands enable row level security;

create policy profile_booking_preferences_tenant_isolation on profile.booking_preferences
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy profile_booking_preference_commands_tenant_isolation
  on profile.booking_preference_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table profile.booking_preferences force row level security;
alter table profile.booking_preference_commands force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'booking_preferences', 'LOCAL_ONLY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
