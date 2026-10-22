-- Expand-only. No providers, credentials, grants or runtime gates are activated here.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table notifications.deliveries add column scenario_dispatch_started_at timestamptz;
alter table support.tickets add column internal_only boolean not null default false;
-- System-created internal tasks may have internal SYSTEM messages; user/agent rules stay intact.
alter table support.messages drop constraint messages_check;
alter table support.messages add constraint messages_check check (not internal or author_role in ('AGENT','SYSTEM')) not valid;
alter table notifications.scenario_contexts drop constraint scenario_contexts_kind_check;
alter table notifications.scenario_contexts add constraint scenario_contexts_kind_check check(kind in ('BOOKING','GAME','LIFECYCLE')) not valid;
alter table notifications.scenario_runs drop constraint scenario_runs_context_kind_check;
alter table notifications.scenario_runs add constraint scenario_runs_context_kind_check check(context_kind in ('BOOKING','GAME','LIFECYCLE')) not valid;
-- phub:reviewed-new-table-index: these indexes belong only to new empty tables.
create table notifications.scenario_source_sync (
 tenant_id uuid not null references identity.tenants(id), user_id uuid not null,
 source_owner text not null default 'VIVA_PRIMARY' check(source_owner='VIVA_PRIMARY'),
 checked_at timestamptz, attempted_at timestamptz not null default now(),
 error_code text check(error_code is null or error_code ~ '^[A-Z][A-Z0-9_]*$'),
 primary key(tenant_id,user_id), foreign key(tenant_id,user_id) references identity.users(tenant_id,id)
);
create table notifications.scenario_source_keys (
 tenant_id uuid not null, user_id uuid not null, fact_key text not null check(fact_key ~ '^[0-9a-f]{64}$'),
 target_id uuid not null default gen_random_uuid(),
 primary key(tenant_id,user_id,fact_key), unique(tenant_id,target_id),
 foreign key(tenant_id,user_id) references identity.users(tenant_id,id)
);
create table notifications.scenario_staff_tasks (
 tenant_id uuid not null, run_id uuid not null, ticket_id uuid not null,
 primary key(tenant_id,run_id), unique(tenant_id,ticket_id),
 foreign key(tenant_id,run_id) references notifications.scenario_runs(tenant_id,id),
 foreign key(tenant_id,ticket_id) references support.tickets(tenant_id,id)
);
alter table notifications.scenario_source_sync enable row level security;
alter table notifications.scenario_source_sync force row level security;
create policy scenario_source_sync_tenant on notifications.scenario_source_sync using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.scenario_source_keys enable row level security;
alter table notifications.scenario_source_keys force row level security;
create policy scenario_source_keys_tenant on notifications.scenario_source_keys using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.scenario_staff_tasks enable row level security;
alter table notifications.scenario_staff_tasks force row level security;
create policy scenario_staff_tasks_tenant on notifications.scenario_staff_tasks using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Old API binaries cannot see internal tasks: they never set this transaction-local admin capability.
create policy support_internal_ticket_access on support.tickets as restrictive
 using(not internal_only or current_setting('app.support_internal_access',true)='on')
 with check(not internal_only or current_setting('app.support_internal_access',true)='on');
create function support.guard_internal_task() returns trigger language plpgsql as $$
declare private_ticket boolean;
begin
 if TG_TABLE_NAME='tickets' then
   if new.internal_only is distinct from old.internal_only then raise exception 'SUPPORT_INTERNAL_VISIBILITY_IMMUTABLE'; end if;
 elsif TG_TABLE_NAME='scenario_staff_tasks' then
   select internal_only into private_ticket from support.tickets where tenant_id=new.tenant_id and id=new.ticket_id;
   if private_ticket is distinct from true then raise exception 'SUPPORT_INTERNAL_TASK_REQUIRED'; end if;
   if not exists(select 1 from notifications.scenario_runs r join support.tickets t on t.tenant_id=r.tenant_id and t.owner_user_id=r.recipient_user_id where r.tenant_id=new.tenant_id and r.id=new.run_id and t.id=new.ticket_id) then raise exception 'SUPPORT_INTERNAL_TASK_RECIPIENT_MISMATCH'; end if;
 else
   select internal_only into private_ticket from support.tickets where tenant_id=new.tenant_id and id=new.ticket_id;
   if private_ticket is null then raise exception 'SUPPORT_TICKET_UNAVAILABLE'; end if;
   if private_ticket and not new.internal then raise exception 'SUPPORT_INTERNAL_MESSAGE_REQUIRED'; end if;
   if new.author_role='SYSTEM' and new.internal and private_ticket is distinct from true then raise exception 'SUPPORT_INTERNAL_TASK_REQUIRED'; end if;
 end if;
 return new;
end $$;
create trigger support_internal_visibility_guard before update of internal_only on support.tickets for each row execute function support.guard_internal_task();
create trigger support_internal_message_guard before insert or update on support.messages for each row execute function support.guard_internal_task();
create trigger scenario_staff_ticket_guard before insert or update on notifications.scenario_staff_tasks for each row execute function support.guard_internal_task();
revoke all on function support.guard_internal_task() from public;

-- Mixed-worker fence: old binaries only discover active=true, PENDING and scenario_available_at.
-- Extended definitions/runs/deliveries live in disjoint discovery fields until new workers claim them.
alter table notifications.scenarios add column extended_runtime boolean not null default false;
alter table notifications.scenarios add column extended_active boolean not null default false;
alter table notifications.scenario_runs drop constraint scenario_runs_state_check;
alter table notifications.scenario_runs add constraint scenario_runs_state_check check(state in ('PENDING','EXTENDED_PENDING','QUEUED','SUPPRESSED','CANCELLED','EXPIRED')) not valid;
alter table notifications.deliveries add column scenario_v2_available_at timestamptz;
alter table notifications.deliveries add constraint scenario_v2_legacy_parked check(scenario_v2_available_at is null or (scenario_available_at is null and next_attempt_at='infinity'::timestamptz)) not valid;
create function notifications.guard_extended_scenario() returns trigger language plpgsql as $$
begin
 if new.extended_runtime or new.extended_active or (TG_OP='UPDATE' and (old.extended_runtime or old.extended_active)) then
  if current_setting('app.notification_extended_writer',true) is distinct from 'on' then raise exception 'SCENARIO_EXTENDED_WRITER_REQUIRED'; end if;
  new.extended_runtime:=true;new.active:=false;
 end if;
 return new;
end $$;
create trigger extended_scenario_writer_guard before insert or update on notifications.scenarios for each row execute function notifications.guard_extended_scenario();
revoke all on function notifications.guard_extended_scenario() from public;

alter table notifications.scenarios add constraint scenario_extended_discovery check(not extended_active or extended_runtime) not valid;
alter table notifications.scenarios add constraint scenario_extended_legacy_hidden check(not extended_runtime or not active) not valid;
-- phub:reviewed-blocking-index: existing tables, bounded lock/statement timeouts; size/duration review before real apply.
create index scenario_runs_v2_due_idx on notifications.scenario_runs(tenant_id,least(due_at,expires_at),id) where state='EXTENDED_PENDING';
-- phub:reviewed-blocking-index: existing deliveries; old rows are excluded and old index stays intact.
create index notification_scenario_v2_due_idx on notifications.deliveries(tenant_id,scenario_v2_available_at,id) where scenario_v2_available_at is not null and state in ('PENDING','SENDING');
