-- Expand-only durable Communities event stream. PostgreSQL remains authoritative;
-- RabbitMQ/Redis carry hints and never replace this recovery log.

create table if not exists community_content.event_heads (
  tenant_id uuid not null,
  community_id uuid not null,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, community_id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create table if not exists community_content.events (
  tenant_id uuid not null,
  community_id uuid not null,
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type ~ '^community\.[a-z0-9_.-]+\.v[1-9][0-9]*$'),
  target_type text not null check (target_type in ('POST', 'COMMENT', 'REACTION')),
  target_id uuid not null,
  target_revision bigint not null check (target_revision > 0),
  target_status text,
  occurred_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, community_id, sequence),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create index if not exists community_content_events_retention_idx
  on community_content.events (tenant_id, occurred_at, community_id, sequence);

alter table community_content.event_heads enable row level security;
alter table community_content.events enable row level security;

create policy community_content_event_heads_tenant_isolation on community_content.event_heads
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_events_tenant_isolation on community_content.events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table community_content.event_heads force row level security;
alter table community_content.events force row level security;
