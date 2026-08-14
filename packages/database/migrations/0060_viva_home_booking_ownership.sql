-- Expand-only trusted ownership evidence for bounded booking roster enrichment.
-- Raw Viva identifiers remain server-side in the integration schema and never cross API DTOs.

create table integration.viva_home_booking_ownership (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  booking_external_id text not null check (char_length(booking_external_id) between 1 and 200),
  exercise_external_id text not null check (char_length(exercise_external_id) between 1 and 200),
  correlation_id text not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, booking_external_id, exercise_external_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create index viva_home_booking_ownership_fresh_idx
  on integration.viva_home_booking_ownership (tenant_id, user_id, fetched_at desc);

alter table integration.viva_home_booking_ownership enable row level security;

create policy viva_home_booking_ownership_tenant_isolation
  on integration.viva_home_booking_ownership
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.viva_home_booking_ownership force row level security;
