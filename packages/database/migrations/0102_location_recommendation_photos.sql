-- phub:reviewed-new-table-index
-- Tenant-scoped reusable media bindings for station recommendation cards.
-- Asset URLs are resolved by the API; clients persist only the location media asset id.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table locations.recommendation_card_photos (
  tenant_id uuid not null,
  location_id uuid not null,
  asset_id uuid not null,
  event_type text not null check (event_type in ('GAME', 'COACH_GAME', 'TRAINING', 'TOURNAMENT')),
  is_active boolean not null default false,
  sort_order integer not null default 0 check (sort_order between 0 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, location_id, event_type, asset_id),
  foreign key (tenant_id, location_id) references locations.profiles(tenant_id, id) on delete cascade,
  foreign key (tenant_id, asset_id) references locations.media_assets(tenant_id, id)
);

create index locations_recommendation_card_photos_read_idx
  on locations.recommendation_card_photos (tenant_id, location_id, event_type, is_active, sort_order, asset_id);

alter table locations.recommendation_card_photos enable row level security;

create policy location_recommendation_card_photos_tenant_isolation
  on locations.recommendation_card_photos
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table locations.recommendation_card_photos force row level security;
