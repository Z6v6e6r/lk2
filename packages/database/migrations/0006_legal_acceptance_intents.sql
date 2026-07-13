create table if not exists legal.document_acceptance_intents (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references identity.tenants(id),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('vkid', 'yandex')),
  public_offer_version text not null,
  personal_data_policy_version text not null,
  correlation_id text not null,
  accepted_at timestamptz not null default now(),
  completed_at timestamptz,
  user_id uuid,
  primary key (tenant_id, id),
  unique (tenant_id, state_hash),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check ((completed_at is null and user_id is null) or (completed_at is not null and user_id is not null))
);

create index if not exists document_acceptance_intents_pending_idx
  on legal.document_acceptance_intents (tenant_id, accepted_at)
  where completed_at is null;

alter table legal.document_acceptance_intents enable row level security;

create policy document_acceptance_intents_tenant_isolation on legal.document_acceptance_intents
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table legal.document_acceptance_intents force row level security;
