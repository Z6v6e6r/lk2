-- Expand-only foundation for tenant-owned gift certificate catalog versions.
-- Orders, payment operations, issuance, delivery, activation and credit ledger remain disabled.

create schema if not exists gift_certificates;

create table gift_certificates.catalog_versions (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  catalog_number integer not null check (catalog_number > 0),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  public_enabled boolean not null default false,
  available_from timestamptz,
  available_to timestamptz,
  flow_steps jsonb not null check (
    jsonb_typeof(flow_steps) = 'array'
    and jsonb_array_length(flow_steps) between 3 and 6
  ),
  validity_start text not null check (validity_start in ('ISSUE', 'ACTIVATION')),
  validity_days integer not null check (validity_days between 1 and 3650),
  activation_deadline_days integer check (
    activation_deadline_days is null or activation_deadline_days between 1 and 3650
  ),
  scheduled_delivery_enabled boolean not null default false,
  email_attachment_enabled boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  archived_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, catalog_number),
  foreign key (tenant_id, created_by) references identity.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id),
  check (available_to is null or available_from is null or available_to > available_from),
  check (
    (validity_start = 'ISSUE' and activation_deadline_days is null)
    or (validity_start = 'ACTIVATION' and activation_deadline_days is not null)
  ),
  check (
    (status = 'DRAFT' and published_at is null and archived_at is null)
    or (status = 'PUBLISHED' and published_at is not null and archived_at is null)
    or (status = 'ARCHIVED' and published_at is null and archived_at is not null)
  )
);

create unique index gift_certificate_catalog_one_draft_idx
  on gift_certificates.catalog_versions (tenant_id)
  where status = 'DRAFT';

create unique index gift_certificate_catalog_one_published_idx
  on gift_certificates.catalog_versions (tenant_id)
  where status = 'PUBLISHED';

create index gift_certificate_catalog_admin_idx
  on gift_certificates.catalog_versions (tenant_id, status, catalog_number desc, id);

create table gift_certificates.designs (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  catalog_id uuid not null,
  design_key text not null check (design_key ~ '^[a-z][a-z0-9-]{1,62}$'),
  audience text not null check (audience in ('FOR_HER', 'FOR_HIM', 'UNIVERSAL')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text check (
    description is null or char_length(btrim(description)) between 1 and 500
  ),
  image_url text not null check (
    image_url ~ '^https://' and char_length(image_url) <= 2000
  ),
  alt_text text not null check (char_length(btrim(alt_text)) between 1 and 180),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 999),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, catalog_id, design_key),
  foreign key (tenant_id, catalog_id)
    references gift_certificates.catalog_versions(tenant_id, id) on delete cascade
);

create index gift_certificate_designs_catalog_idx
  on gift_certificates.designs (tenant_id, catalog_id, sort_order, id);

create table gift_certificates.denominations (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  catalog_id uuid not null,
  amount_minor bigint not null check (amount_minor between 10000 and 100000000),
  currency text not null check (currency = 'RUB'),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 999),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, catalog_id, amount_minor, currency),
  foreign key (tenant_id, catalog_id)
    references gift_certificates.catalog_versions(tenant_id, id) on delete cascade
);

create index gift_certificate_denominations_catalog_idx
  on gift_certificates.denominations (tenant_id, catalog_id, sort_order, amount_minor, id);

create table gift_certificates.admin_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (command_type in ('SAVE_DRAFT', 'PUBLISH_DRAFT')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  catalog_id uuid not null,
  result_revision integer not null check (result_revision > 0),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  completed_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, catalog_id)
    references gift_certificates.catalog_versions(tenant_id, id)
);

alter table gift_certificates.catalog_versions enable row level security;
alter table gift_certificates.designs enable row level security;
alter table gift_certificates.denominations enable row level security;
alter table gift_certificates.admin_commands enable row level security;

create policy gift_certificate_catalog_versions_tenant_isolation
  on gift_certificates.catalog_versions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_designs_tenant_isolation
  on gift_certificates.designs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_denominations_tenant_isolation
  on gift_certificates.denominations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy gift_certificate_admin_commands_tenant_isolation
  on gift_certificates.admin_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table gift_certificates.catalog_versions force row level security;
alter table gift_certificates.designs force row level security;
alter table gift_certificates.denominations force row level security;
alter table gift_certificates.admin_commands force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    values (current_tenant_id, 'gift_certificates', 'LOCAL_PRIMARY')
    on conflict (tenant_id, domain_name) do update
      set ownership_mode = excluded.ownership_mode,
          changed_at = now();
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
