-- Expand-only notifications-owned scenarios; 0099 is reserved by the password-reset task.
-- phub:reviewed-new-table-index: scenario-table indexes cover new empty tables. The delivery index is reviewed separately below.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table notifications.scenarios (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  version integer not null check (version > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  active boolean not null default false,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id)
);
create table notifications.scenario_versions (
  tenant_id uuid not null,
  scenario_id uuid not null,
  version integer not null check (version > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  template_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, scenario_id, version),
  foreign key (tenant_id, scenario_id) references notifications.scenarios(tenant_id, id),
  foreign key (tenant_id, template_id) references notifications.templates(tenant_id, id),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id)
);
create table notifications.scenario_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id)
);
create table notifications.scenario_contexts (
  tenant_id uuid not null references identity.tenants(id),
  target_id uuid not null,
  kind text not null check (kind in ('BOOKING', 'GAME')),
  revision numeric(30,0) not null check (revision > 0),
  event_type text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  occurred_at timestamptz not null,
  source_event_id uuid not null,
  fanout_pending boolean not null default false,
  recipient_cursor uuid,
  primary key (tenant_id, kind, target_id)
);
create table notifications.scenario_runs (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  scenario_id uuid not null,
  scenario_version integer not null,
  recipient_user_id uuid not null,
  target_id uuid not null,
  source_event_id uuid not null,
  context_kind text not null check (context_kind in ('BOOKING', 'GAME')),
  context_revision numeric(30,0) not null,
  rendered_title text not null,
  rendered_body text not null,
  deep_link text not null,
  state text not null default 'PENDING' check (state in ('PENDING','QUEUED','SUPPRESSED','CANCELLED','EXPIRED')),
  reason text check (reason is null or reason ~ '^[A-Z][A-Z0-9_]*$'),
  due_at timestamptz not null,
  expires_at timestamptz not null,
  intent_id uuid,
  queued_at timestamptz,
  goal_state text not null default 'NONE' check (goal_state in ('NONE','WAITING','ACHIEVED','EXPIRED')),
  goal_deadline timestamptz,
  goal_achieved_at timestamptz,
  goal_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,id),
  foreign key (tenant_id,scenario_id,scenario_version) references notifications.scenario_versions(tenant_id,scenario_id,version),
  foreign key (tenant_id,recipient_user_id) references identity.users(tenant_id,id),
  foreign key (tenant_id,intent_id) references notifications.intents(tenant_id,id),
  unique (tenant_id,scenario_id,source_event_id,recipient_user_id),
  check (
    (goal_state in ('NONE','WAITING','EXPIRED') and goal_achieved_at is null and goal_event_id is null)
    or (goal_state='ACHIEVED' and goal_achieved_at is not null and goal_event_id is not null)
  ),
  check ((goal_state='NONE' and goal_deadline is null) or (goal_state<>'NONE' and goal_deadline is not null and queued_at is not null)),
  check (goal_achieved_at is null or (goal_achieved_at >= queued_at and goal_achieved_at <= goal_deadline)),
  check ((state='QUEUED' and intent_id is not null and queued_at is not null) or state<>'QUEUED')
);
create index scenario_runs_due_idx on notifications.scenario_runs(tenant_id,least(due_at,expires_at),id) where state='PENDING';
create index scenario_runs_target_idx on notifications.scenario_runs(tenant_id,target_id,recipient_user_id);
create index scenario_runs_intent_idx on notifications.scenario_runs(tenant_id,intent_id) where intent_id is not null;

-- All access is tenant scoped, including the owning role. No grants or runtime activation.
alter table notifications.scenarios enable row level security;
alter table notifications.scenarios force row level security;
create policy scenarios_tenant on notifications.scenarios using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.scenario_versions enable row level security;
alter table notifications.scenario_versions force row level security;
create policy scenario_versions_tenant on notifications.scenario_versions using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.scenario_commands enable row level security;
alter table notifications.scenario_commands force row level security;
create policy scenario_commands_tenant on notifications.scenario_commands using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.scenario_contexts enable row level security;
alter table notifications.scenario_contexts force row level security;
create policy scenario_contexts_tenant on notifications.scenario_contexts using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.scenario_runs enable row level security;
alter table notifications.scenario_runs force row level security;
create policy scenario_runs_tenant on notifications.scenario_runs using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Published versions are append-only, including for a table-owning runtime role.
create function notifications.scenario_version_immutable() returns trigger language plpgsql as $$
begin raise exception 'SCENARIO_VERSION_IMMUTABLE'; end $$;
create trigger scenario_versions_immutable before update or delete on notifications.scenario_versions for each row execute function notifications.scenario_version_immutable();

-- Deferred only within save: the head and its new immutable version commit together.
alter table notifications.scenarios add constraint scenario_current_version_fk
  foreign key (tenant_id,id,version) references notifications.scenario_versions(tenant_id,scenario_id,version)
  deferrable initially deferred;
create index scenario_contexts_fanout_idx on notifications.scenario_contexts(tenant_id,occurred_at,target_id) where kind='GAME' and fanout_pending=true;
create index scenario_runs_goal_due_idx on notifications.scenario_runs(tenant_id,goal_deadline,id) where goal_state='WAITING';
create index scenario_runs_recipient_queued_idx on notifications.scenario_runs(tenant_id,recipient_user_id,queued_at,target_id) where queued_at is not null;

-- Older workers only inspect next_attempt_at: park new scenario deliveries permanently there.
-- The new executor alone uses the nullable availability column; old rows remain unchanged.
alter table notifications.deliveries add column scenario_available_at timestamptz;
alter table notifications.deliveries add constraint scenario_delivery_legacy_parked
  check (scenario_available_at is null or next_attempt_at = 'infinity'::timestamptz) not valid;
-- phub:reviewed-blocking-index: existing table; lock/statement timeouts bound an aborted rehearsal.
create index notification_scenario_delivery_due_idx on notifications.deliveries(tenant_id,scenario_available_at,id)
  where scenario_available_at is not null and state in ('PENDING','SENDING');
