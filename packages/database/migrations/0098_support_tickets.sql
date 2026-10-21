-- Local-only support aggregate. User-visible text remains in messages and never enters audit/outbox payloads.
create schema if not exists support;
-- phub:reviewed-new-table-index
create table support.tickets (
  tenant_id uuid not null references identity.tenants(id), id uuid not null default gen_random_uuid(),
  owner_user_id uuid not null, subject text not null check (char_length(btrim(subject)) between 1 and 300),
  category text not null check (category in ('TECHNICAL','ACCOUNT','BOOKING','BILLING','OTHER')),
  status text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','WAITING_USER','RESOLVED','CLOSED')),
  priority text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  assigned_to uuid, tags text[] not null default '{}', version integer not null default 1 check (version > 0),
  resolved_at timestamptz, auto_close_at timestamptz, closed_at timestamptz, conversation_purged_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (tenant_id,id), foreign key (tenant_id,owner_user_id) references identity.users(tenant_id,id),
  foreign key (tenant_id,assigned_to) references identity.users(tenant_id,id),
  check ((status = 'RESOLVED' and resolved_at is not null and auto_close_at is not null) or status <> 'RESOLVED')
);
create index support_tickets_owner_idx on support.tickets (tenant_id, owner_user_id, updated_at desc, id);
create index support_tickets_autoclose_idx on support.tickets (tenant_id, auto_close_at) where status = 'RESOLVED';
-- phub:reviewed-new-table-index
create table support.messages (
  tenant_id uuid not null references identity.tenants(id), id uuid not null default gen_random_uuid(), ticket_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 8000), author_id uuid, author_role text not null check (author_role in ('USER','AGENT','SYSTEM')),
  internal boolean not null default false, created_at timestamptz not null default now(), primary key (tenant_id,id),
  foreign key (tenant_id,ticket_id) references support.tickets(tenant_id,id), foreign key (tenant_id,author_id) references identity.users(tenant_id,id),
  check (not internal or author_role = 'AGENT')
);
create index support_messages_ticket_idx on support.messages (tenant_id,ticket_id,created_at desc,id desc);
-- phub:reviewed-new-table-index
create table support.history (
  tenant_id uuid not null references identity.tenants(id), id uuid not null default gen_random_uuid(), ticket_id uuid not null, kind text not null,
  description text check(description is null), internal boolean not null default false, actor_id uuid, created_at timestamptz not null default now(), primary key (tenant_id,id),
  foreign key (tenant_id,ticket_id) references support.tickets(tenant_id,id), foreign key (tenant_id,actor_id) references identity.users(tenant_id,id)
);
create index support_history_ticket_idx on support.history (tenant_id,ticket_id,created_at desc,id desc);
-- phub:reviewed-new-table-index
create table support.commands (
 tenant_id uuid not null references identity.tenants(id), actor_id uuid not null, idempotency_key text not null check(char_length(idempotency_key) between 16 and 128),
 request_hash text check(request_hash ~ '^[0-9a-f]{64}$'), ticket_id uuid not null, result_version integer not null check (result_version > 0), result_json jsonb not null check(jsonb_typeof(result_json)='object' and result_json ?& array['messages','history'] and octet_length(result_json::text)<=8192 and jsonb_typeof(result_json->'messages')='array' and jsonb_array_length(result_json->'messages')=0 and jsonb_typeof(result_json->'history')='array' and jsonb_array_length(result_json->'history')=0), retired_at timestamptz, command_kind text not null check(command_kind in ('CREATE','USER_MESSAGE','ADMIN_MESSAGE','UPDATE')), completed_at timestamptz not null default now(),
 check ((retired_at is null and request_hash is not null) or (retired_at is not null and request_hash is null)),
 primary key(tenant_id,actor_id,idempotency_key), foreign key(tenant_id,ticket_id) references support.tickets(tenant_id,id),
 foreign key(tenant_id,actor_id) references identity.users(tenant_id,id)
);
create index support_commands_quota_idx on support.commands (tenant_id,actor_id,completed_at desc);
alter table support.tickets enable row level security; alter table support.messages enable row level security; alter table support.history enable row level security; alter table support.commands enable row level security;
create policy support_tickets_tenant on support.tickets using(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy support_messages_tenant on support.messages using(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy support_history_tenant on support.history using(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy support_commands_tenant on support.commands using(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table support.tickets force row level security; alter table support.messages force row level security; alter table support.history force row level security; alter table support.commands force row level security;

-- Retention guards are source-only until separately authorized migration execution.
-- The shared runtime cannot forge close/purge dates or delete a younger/nonclosed conversation.
create function support.guard_ticket_lifecycle() returns trigger language plpgsql as $$
begin
  if TG_OP='INSERT' then
    new.closed_at := case when new.status='CLOSED' then now() else null end;
    if new.conversation_purged_at is not null then raise exception 'SUPPORT_PURGE_MARKER_FORBIDDEN'; end if;
  else
    if new.closed_at is distinct from old.closed_at then raise exception 'SUPPORT_CLOSED_AT_SYSTEM_OWNED'; end if;
    new.closed_at := case when new.status='CLOSED' then case when old.status='CLOSED' then old.closed_at else now() end else null end;
    if old.status='CLOSED' and new.status='CLOSED' and old.conversation_purged_at>=old.closed_at and (new.subject is distinct from old.subject or new.tags is distinct from old.tags or new.assigned_to is distinct from old.assigned_to) then raise exception 'SUPPORT_CONVERSATION_ARCHIVED'; end if;
    if new.conversation_purged_at is distinct from old.conversation_purged_at then
      if old.status<>'CLOSED' or old.closed_at is null or old.closed_at>now()-interval '24 months'
         or new.status<>old.status or new.closed_at is distinct from old.closed_at
         or new.conversation_purged_at is distinct from now() or new.subject is distinct from 'Обращение #'||old.id::text
         or new.tags is distinct from '{}'::text[] or new.assigned_to is not null
         or exists(select 1 from support.messages where tenant_id=old.tenant_id and ticket_id=old.id)
         or exists(select 1 from support.commands where tenant_id=old.tenant_id and ticket_id=old.id and retired_at is null)
         or (to_jsonb(new)-array['subject','tags','assigned_to','conversation_purged_at','version','updated_at']) is distinct from (to_jsonb(old)-array['subject','tags','assigned_to','conversation_purged_at','version','updated_at']) then
        raise exception 'SUPPORT_PURGE_MARKER_FORBIDDEN';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger support_ticket_lifecycle_guard before insert or update on support.tickets for each row execute function support.guard_ticket_lifecycle();

create function support.guard_retention_message_delete() returns trigger language plpgsql as $$
declare eligible boolean;
begin
  select status='CLOSED' and closed_at<=now()-interval '24 months' into eligible from support.tickets
    where tenant_id=old.tenant_id and id=old.ticket_id for share;
  if eligible is distinct from true then raise exception 'SUPPORT_RETENTION_NOT_DUE'; end if;
  return old;
end $$;
create trigger support_message_retention_guard before delete on support.messages for each row execute function support.guard_retention_message_delete();

create function support.guard_receipt_retirement() returns trigger language plpgsql as $$
declare ticket support.tickets%rowtype; expected_result jsonb;
begin
  select * into ticket from support.tickets where tenant_id=old.tenant_id and id=old.ticket_id for share;
  expected_result := jsonb_build_object('id',old.ticket_id,'category',ticket.category,'status',ticket.status,'messages','[]'::jsonb,'history','[]'::jsonb);
  if ticket.status is distinct from 'CLOSED' or ticket.closed_at is null or ticket.closed_at>now()-interval '24 months'
     or old.retired_at is not null or new.request_hash is not null or new.retired_at is distinct from now()
     or new.result_json is distinct from expected_result
     or (to_jsonb(new)-array['request_hash','retired_at','result_json']) is distinct from (to_jsonb(old)-array['request_hash','retired_at','result_json']) then
    raise exception 'SUPPORT_RECEIPT_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger support_receipt_retention_guard before update on support.commands for each row execute function support.guard_receipt_retirement();
revoke all on function support.guard_ticket_lifecycle() from public;
revoke all on function support.guard_retention_message_delete() from public;
revoke all on function support.guard_receipt_retirement() from public;
create index support_tickets_retention_idx on support.tickets(tenant_id,closed_at,id) where status='CLOSED';

create function support.guard_archived_message_insert() returns trigger language plpgsql as $$
declare ticket support.tickets%rowtype;
begin
  select * into ticket from support.tickets where tenant_id=new.tenant_id and id=new.ticket_id for share;
  if ticket.status='CLOSED' and ticket.conversation_purged_at>=ticket.closed_at then raise exception 'SUPPORT_CONVERSATION_ARCHIVED'; end if;
  return new;
end $$;
create trigger support_archived_message_guard before insert on support.messages for each row execute function support.guard_archived_message_insert();
revoke all on function support.guard_archived_message_insert() from public;
