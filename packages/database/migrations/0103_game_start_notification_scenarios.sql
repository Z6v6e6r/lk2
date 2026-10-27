-- Expand-only GAME_START reminder ownership and isolated legacy-source mirror.
-- Runtime activation remains off until source coverage and role grants are admitted separately.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table notifications.scenario_contexts drop constraint scenario_contexts_kind_check;
alter table notifications.scenario_contexts add constraint scenario_contexts_kind_check
  check (kind in ('BOOKING','GAME','GAME_START','LIFECYCLE')) not valid;
alter table notifications.scenario_runs drop constraint scenario_runs_context_kind_check;
alter table notifications.scenario_runs add constraint scenario_runs_context_kind_check
  check (context_kind in ('BOOKING','GAME','GAME_START','LIFECYCLE')) not valid;

-- phub:reviewed-new-table-index -- the source tables and their indexes are empty at creation.
create table notifications.legacy_game_reminder_source_status (
  tenant_id uuid primary key references identity.tenants(id),
  generation_id uuid not null,
  healthy boolean not null default false,
  attempt_started_at timestamptz not null,
  checked_at timestamptz,
  tracked_count integer not null default 0 check (tracked_count >= 0),
  observed_count integer not null default 0 check (observed_count >= 0),
  skipped_unmapped_count integer not null default 0 check (skipped_unmapped_count >= 0),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]*$'),
  updated_at timestamptz not null default now()
);

create table notifications.legacy_game_reminder_sources (
  tenant_id uuid not null,
  game_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  source_external_version text not null check (source_external_version ~ '^[0-9a-f]{64}$'),
  source_updated_at timestamptz not null,
  source_checked_at timestamptz not null,
  generation_id uuid not null,
  source_state text not null check (
    source_state in ('SCHEDULED','CANCELLED','MISSING','OUT_OF_WINDOW')
  ),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  timezone text not null check (char_length(btrim(timezone)) between 1 and 64),
  location_name text not null check (char_length(btrim(location_name)) between 1 and 160),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,game_id),
  foreign key (tenant_id,game_id) references games.games(tenant_id,id)
);

create table notifications.legacy_game_reminder_recipients (
  tenant_id uuid not null,
  game_id uuid not null,
  user_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,game_id,user_id),
  foreign key (tenant_id,game_id)
    references notifications.legacy_game_reminder_sources(tenant_id,game_id) on delete cascade,
  foreign key (tenant_id,user_id) references identity.users(tenant_id,id)
);

create index legacy_game_reminder_sources_due_idx
  on notifications.legacy_game_reminder_sources(tenant_id,starts_at,game_id)
  where source_state='SCHEDULED';
create index legacy_game_reminder_recipients_user_idx
  on notifications.legacy_game_reminder_recipients(tenant_id,user_id,game_id);

alter table notifications.legacy_game_reminder_source_status enable row level security;
alter table notifications.legacy_game_reminder_source_status force row level security;
create policy legacy_game_reminder_source_status_tenant
  on notifications.legacy_game_reminder_source_status
  using (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.legacy_game_reminder_sources enable row level security;
alter table notifications.legacy_game_reminder_sources force row level security;
create policy legacy_game_reminder_sources_tenant
  on notifications.legacy_game_reminder_sources
  using (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.legacy_game_reminder_recipients enable row level security;
alter table notifications.legacy_game_reminder_recipients force row level security;
create policy legacy_game_reminder_recipients_tenant
  on notifications.legacy_game_reminder_recipients
  using (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- At most one reminder row per configured scenario, game and participant. A source revision may
-- rearm that same row only before an intent exists; queued/ambiguous/provider-visible work remains
-- a permanent dedupe fence across later roster revisions.
-- phub:reviewed-blocking-index -- existing runtime table; both timeouts above bound failure.
create unique index scenario_runs_game_start_once_uidx
  on notifications.scenario_runs(tenant_id,scenario_id,target_id,recipient_user_id)
  where context_kind='GAME_START';
