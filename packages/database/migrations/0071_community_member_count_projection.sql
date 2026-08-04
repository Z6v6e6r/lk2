-- Expand-only, rebuildable active-member count projection. Canonical memberships remain
-- the source of truth; projection rows never authorize access.

create table if not exists communities.member_count_projections (
  tenant_id uuid not null,
  community_id uuid not null,
  active_member_count bigint not null default 0 check (active_member_count >= 0),
  projection_revision bigint not null default 0 check (projection_revision >= 0),
  state text not null default 'BUILDING' check (state in ('BUILDING', 'READY', 'STALE')),
  reconciliation_cursor uuid,
  reconciliation_started_at timestamptz,
  reconciled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, community_id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  check (state <> 'READY' or (reconciled_at is not null and reconciliation_cursor is null))
);

create table if not exists communities.member_count_contributions (
  tenant_id uuid not null,
  community_id uuid not null,
  user_id uuid not null,
  membership_revision bigint not null check (membership_revision > 0),
  is_active boolean not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, community_id, user_id),
  foreign key (tenant_id, community_id, user_id)
    references communities.memberships(tenant_id, community_id, user_id)
);

create index if not exists community_member_count_reconciliation_idx
  on communities.member_count_projections (tenant_id, state, reconciled_at, community_id);

alter table communities.member_count_projections enable row level security;
alter table communities.member_count_contributions enable row level security;

create policy community_member_count_projections_tenant_isolation
  on communities.member_count_projections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy community_member_count_contributions_tenant_isolation
  on communities.member_count_contributions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table communities.member_count_projections force row level security;
alter table communities.member_count_contributions force row level security;
