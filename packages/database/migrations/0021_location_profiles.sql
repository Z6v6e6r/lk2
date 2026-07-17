-- Expand-only editorial location profiles. Operational stations and availability remain
-- VIVA_PRIMARY; this separate LOCAL_ONLY aggregate owns only the PadlHub public presentation.

create schema if not exists locations;

create table locations.profiles (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  short_title text check (
    short_title is null or char_length(btrim(short_title)) between 1 and 80
  ),
  city text check (city is null or char_length(btrim(city)) between 1 and 120),
  court_count integer not null default 0 check (court_count between 0 and 999),
  address text check (address is null or char_length(btrim(address)) between 1 and 500),
  latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(10, 6) check (longitude is null or longitude between -180 and 180),
  timezone text not null default 'Europe/Moscow'
    check (char_length(timezone) between 1 and 100),
  metro_name text check (
    metro_name is null or char_length(btrim(metro_name)) between 1 and 160
  ),
  metro_distance_meters integer check (
    metro_distance_meters is null or metro_distance_meters between 0 and 100000
  ),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  working_hours jsonb not null default '[]'::jsonb
    check (jsonb_typeof(working_hours) = 'array' and jsonb_array_length(working_hours) <= 7),
  amenities jsonb not null default '[]'::jsonb
    check (jsonb_typeof(amenities) = 'array' and jsonb_array_length(amenities) <= 16),
  gallery jsonb not null default '[]'::jsonb
    check (jsonb_typeof(gallery) = 'array' and jsonb_array_length(gallery) <= 12),
  publication_status text not null default 'DRAFT'
    check (publication_status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  show_on_home boolean not null default false,
  sort_order integer not null default 0 check (sort_order between 0 and 9999),
  version integer not null default 1 check (version > 0),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  archived_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, slug),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id),
  check ((latitude is null) = (longitude is null)),
  check (
    (publication_status = 'DRAFT' and published_at is null and archived_at is null)
    or (publication_status = 'PUBLISHED' and published_at is not null and archived_at is null)
    or (publication_status = 'ARCHIVED' and published_at is null and archived_at is not null)
  )
);

create index locations_profiles_admin_idx
  on locations.profiles (tenant_id, publication_status, sort_order, updated_at desc, id);

create index locations_profiles_home_idx
  on locations.profiles (tenant_id, sort_order, id)
  where publication_status = 'PUBLISHED' and show_on_home = true;

create table locations.admin_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (command_type in ('CREATE', 'UPDATE')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  location_id uuid not null,
  result_version integer not null check (result_version > 0),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, location_id) references locations.profiles(tenant_id, id)
);

create table locations.home_projection_state (
  tenant_id uuid primary key references identity.tenants(id),
  component_revision bigint not null check (component_revision > 0),
  updated_at timestamptz not null default now()
);

alter table locations.profiles enable row level security;
alter table locations.admin_commands enable row level security;
alter table locations.home_projection_state enable row level security;

create policy location_profiles_tenant_isolation on locations.profiles
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy location_admin_commands_tenant_isolation on locations.admin_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy location_home_projection_state_tenant_isolation
  on locations.home_projection_state
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table locations.profiles force row level security;
alter table locations.admin_commands force row level security;
alter table locations.home_projection_state force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'location_profiles', 'LOCAL_ONLY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
