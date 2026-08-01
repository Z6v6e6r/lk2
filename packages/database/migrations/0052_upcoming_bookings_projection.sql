-- Dedicated local projection for the authenticated user's upcoming bookings.
-- Browser-relayed Viva payloads are normalized before this table is written;
-- provider identifiers are never stored in the public projection.

create table booking.upcoming_booking_projection (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  version text not null check (version ~ '^[a-f0-9]{64}$'),
  generated_at timestamptz not null,
  stale_at timestamptz not null,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check (stale_at > generated_at)
);

create index upcoming_booking_projection_stale_idx
  on booking.upcoming_booking_projection (tenant_id, stale_at, user_id);

alter table booking.upcoming_booking_projection enable row level security;

create policy upcoming_booking_projection_tenant_isolation
  on booking.upcoming_booking_projection
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table booking.upcoming_booking_projection force row level security;
