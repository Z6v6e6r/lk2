-- KYA-01a: contact addresses are not verified login claims or login bindings.
-- Expand only. Existing profile.user_summaries and identity mappings are untouched.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table profile.contacts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  type text not null check (type in ('PHONE', 'EMAIL')),
  normalized_value text not null check (
    (type = 'PHONE' and normalized_value ~ '^\+[1-9][0-9]{7,14}$')
    or (type = 'EMAIL' and char_length(normalized_value) between 3 and 254
        and normalized_value = lower(normalized_value)
        and normalized_value !~ '[[:space:]]'
        and normalized_value like '%@%.%')
  ),
  source_kind text not null check (source_kind in ('LOCAL', 'VIVA')),
  source_updated_at timestamptz,
  check (source_kind <> 'VIVA' or source_updated_at is not null),
  version integer not null default 1 check (version > 0),
  created_by_actor_id uuid not null,
  updated_by_actor_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, user_id, type, normalized_value)
);

-- phub:reviewed-new-table-index
create index contacts_value_lookup_idx
  on profile.contacts (tenant_id, type, normalized_value);

-- Replacing an address inserts a new unverified row; old verification never follows it.
create function profile.reject_contact_identity_change() returns trigger
language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.type is distinct from old.type
     or new.normalized_value is distinct from old.normalized_value then
    raise exception 'CONTACT_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger contacts_identity_immutable
  before update on profile.contacts
  for each row execute function profile.reject_contact_identity_change();

-- A command receipt contains identifiers and a request digest, never a raw address.
create table profile.contact_commands (
  tenant_id uuid not null references identity.tenants(id),
  actor_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('CREATE', 'UPDATE_PROVENANCE')),
  contact_id uuid not null,
  outcome text not null check (outcome in ('created', 'existing', 'updated')),
  result_version integer not null check (result_version > 0),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_id, idempotency_key),
  foreign key (tenant_id, contact_id) references profile.contacts(tenant_id, id)
);

alter table profile.contacts enable row level security;
alter table profile.contact_commands enable row level security;

create policy contacts_tenant_isolation on profile.contacts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy contact_commands_tenant_isolation on profile.contact_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table profile.contacts force row level security;
alter table profile.contact_commands force row level security;
