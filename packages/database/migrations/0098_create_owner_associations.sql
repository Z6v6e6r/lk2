-- Expand-only CREATE custody. No backfill, dispatcher, proof writer or runtime activation.
-- Insert ONLY in the canonical Games CREATE transaction, after the immutable owner quote
-- and command receipt exist and before any owner effect. Current Games writer is unchanged.
-- phub:reviewed-new-table-index
create table games.create_owner_associations (
  tenant_id uuid not null,
  operation_id uuid not null,
  game_id uuid not null,
  actor_user_id uuid not null,
  owner_contract_version text not null check (owner_contract_version = 'C1-v1.2'),
  binding_schema_version smallint not null check (binding_schema_version = 1),
  game_request_hash text not null check (game_request_hash ~ '^[a-f0-9]{64}$'),
  intent_sha256 text not null check (intent_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  key_sha256 text not null check (key_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, operation_id),
  unique (tenant_id, game_id),
  unique (tenant_id, actor_user_id, intent_sha256),
  unique (tenant_id, actor_user_id, key_sha256),
  foreign key (tenant_id, operation_id) references games.operations(tenant_id, id),
  foreign key (tenant_id, operation_id) references games.command_idempotency(tenant_id, id),
  foreign key (tenant_id, game_id) references games.games(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  check ((binding->>'tenantId' = tenant_id::text
    and binding->>'operationId' = operation_id::text
    and binding->>'gameId' = game_id::text
    and binding->>'actorUserId' = actor_user_id::text
    and binding->>'intentSha256' = intent_sha256
    and binding->>'keySha256' = key_sha256) is true),
  -- Safe identifiers only. Full private provider mappings remain in Integration.
  check (binding ?& array['tenantId','actorUserId','operationId','gameId','quoteId',
    'quoteRevision','slotId','slotVersion','subscriptionInstanceId','visits','amountMinor',
    'currency','keySha256','intentSha256','requestSha256','bindingSha256',
    'mappingBindingSha256','mappings']),
  check (binding - array['tenantId','actorUserId','operationId','gameId','quoteId',
    'quoteRevision','slotId','slotVersion','subscriptionInstanceId','visits','amountMinor',
    'currency','keySha256','intentSha256','requestSha256','bindingSha256',
    'mappingBindingSha256','mappings'] = '{}'::jsonb),
  check ((binding->>'currency' = 'RUB') is true),
  check (jsonb_typeof(binding->'mappings') = 'object'),
  check ((binding->'mappings') ?& array['actor','subscription','slot']),
  check ((binding->'mappings') - array['actor','subscription','slot'] = '{}'::jsonb),
  check ((binding->'mappings'->'actor') - array['tenantId','id','revision','internalId'] = '{}'::jsonb
    and (binding->'mappings'->'subscription') - array['tenantId','id','revision','internalId'] = '{}'::jsonb
    and (binding->'mappings'->'slot') - array['tenantId','id','revision','internalId'] = '{}'::jsonb)
);

create function games.guard_create_owner_association() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'CREATE_ORIGINAL_IMMUTABLE' using errcode = '23514';
  end if;
  if not exists (
    select 1 from games.operations op
    join games.games game on game.tenant_id = op.tenant_id and game.id = op.game_id
    join games.command_idempotency command on command.tenant_id = op.tenant_id and command.id = op.id
    where op.tenant_id = new.tenant_id and op.id = new.operation_id
      and op.kind = 'CREATE_GAME' and op.game_id = new.game_id
      and op.state = 'PENDING'
      and op.requested_by_user_id = new.actor_user_id
      and game.organizer_user_id = new.actor_user_id
      and game.payment_mode = 'SUBSCRIPTION' and game.lifecycle_state = 'PROVISIONING'
      and game.kind = 'FRIENDLY' and game.visibility = 'PUBLIC' and game.capacity = 4
      and command.actor_user_id = new.actor_user_id and command.aggregate_id = new.game_id
      and command.principal_key = 'user:' || new.actor_user_id::text
      and command.command_type = 'game.create.v1' and command.state = 'COMPLETED'
      and command.request_hash = new.game_request_hash
      and command.result_payload->>'operationId' = new.operation_id::text
      and command.result_payload->>'gameId' = new.game_id::text
      and new.key_sha256 = 'sha256:' || encode(public.digest(command.idempotency_key, 'sha256'), 'hex')
  ) then
    raise exception 'CREATE_CANONICAL_BINDING_CONFLICT' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger create_owner_association_custody
before insert or update or delete on games.create_owner_associations
for each row execute function games.guard_create_owner_association();

alter table games.create_owner_associations enable row level security;
alter table games.create_owner_associations force row level security;
create policy create_owner_associations_tenant_isolation on games.create_owner_associations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
