-- Expand the community-logo bridge from persisted expiring object-store URLs to a stable
-- PadlHub media route. Old runtimes may keep writing both columns during a rolling release;
-- new runtimes resolve object_key and leave the legacy delivery metadata empty.

set local lock_timeout = '5s';

alter table integration.community_logo_sync
  alter column delivery_url drop not null,
  alter column delivery_expires_at drop not null,
  add constraint community_logo_sync_delivery_pair_chk
    check ((delivery_url is null) = (delivery_expires_at is null)) not valid;

create table integration.community_logo_observation_watermarks (
  tenant_id uuid not null references identity.tenants(id),
  community_id uuid not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, community_id)
);

alter table integration.community_logo_observation_watermarks enable row level security;

create policy community_logo_observation_watermarks_tenant_isolation
  on integration.community_logo_observation_watermarks
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.community_logo_observation_watermarks force row level security;

create table integration.media_cutover_state (
  feature text primary key,
  active boolean not null,
  updated_at timestamptz not null default now(),
  constraint media_cutover_state_feature_chk
    check (feature in ('community_logo_stable_delivery'))
);
