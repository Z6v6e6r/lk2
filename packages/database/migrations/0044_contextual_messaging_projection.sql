-- Expand-only inbox for contextual messaging projectors. Context conversations stay hidden
-- behind the per-tenant contextual runtime gate until their full vertical slice is activated.

create table messaging.context_projection_events (
  tenant_id uuid not null references identity.tenants(id),
  projector text not null check (projector in ('GAME', 'TOURNAMENT', 'COMMUNITY')),
  event_id uuid not null,
  context_id uuid not null,
  conversation_id uuid,
  projected_at timestamptz not null default now(),
  primary key (tenant_id, projector, event_id),
  foreign key (tenant_id, conversation_id)
    references messaging.conversations(tenant_id, id)
);

create index context_projection_events_context_idx
  on messaging.context_projection_events (tenant_id, projector, context_id, projected_at desc);

alter table messaging.context_projection_events enable row level security;

create policy context_projection_events_tenant_isolation
  on messaging.context_projection_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table messaging.context_projection_events force row level security;
