-- Expand-only ownership binding for VIVA/subscription integration mappings (ADR 0029 D5).
-- `integration.external_entity_map` maps a Viva client-subscription instance to a PadlHub UUID but
-- records no owner. This table binds a mapping to the PadlHub user and the exact `viva_profile`
-- mapping whose server Viva Admin read observed it. One owner per mapping: a later read by another
-- client is a conflict and never moves the row.
-- Rows are never deleted by the sync: an absent or failed read keeps the last binding.
-- Rollback is the writer flag (VIVA_SUBSCRIPTION_MAPPING_SYNC_ENABLED=false); existing readers do
-- not depend on this table, so no destructive cleanup is needed.
-- phub:reviewed-new-table-index
create table integration.viva_subscription_owners (
  tenant_id uuid not null references identity.tenants(id),
  subscription_mapping_id uuid not null,
  profile_mapping_id uuid not null,
  user_id uuid not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  primary key (tenant_id, subscription_mapping_id),
  foreign key (tenant_id, subscription_mapping_id)
    references integration.external_entity_map(tenant_id, id),
  foreign key (tenant_id, profile_mapping_id)
    references integration.external_entity_map(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check (last_observed_at >= first_observed_at)
);
create index viva_subscription_owners_user_idx
  on integration.viva_subscription_owners (tenant_id, user_id);
alter table integration.viva_subscription_owners enable row level security;
alter table integration.viva_subscription_owners force row level security;
create policy viva_subscription_owner_tenant_isolation on integration.viva_subscription_owners
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
