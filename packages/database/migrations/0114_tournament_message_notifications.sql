-- Concrete tournament notification custody. No backfill, enrollment, grant or activation.
-- Rollback keeps immutable sources, witnesses and dispatch markers; old workers cannot claim new states.
set local lock_timeout='3s';
set local statement_timeout='30s';
-- phub:reviewed-new-table-index
create table notifications.tournament_message_sources (
 tenant_id uuid not null references identity.tenants(id), id uuid not null,
 tournament_id uuid not null, owner_namespace text not null check(length(owner_namespace) between 1 and 200),
 incarnation_hash text not null check(incarnation_hash ~ '^[a-f0-9]{64}$'), stream_id uuid not null,
 replay_floor bigint not null check(replay_floor between 0 and 9007199254740991),
 after_sequence bigint not null, completed_sequence bigint not null, through_sequence bigint,
 enabled boolean not null default false, lease_token uuid, lease_until timestamptz,
 next_attempt_at timestamptz not null default now(),last_error_code text,created_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,tournament_id,incarnation_hash,stream_id),
 check(completed_sequence between replay_floor and after_sequence),
 check(after_sequence between replay_floor and 9007199254740991),
 check(through_sequence is null or through_sequence between after_sequence and 9007199254740991),
 check((lease_token is null)=(lease_until is null))
);
create table notifications.tournament_message_facts (
 tenant_id uuid not null,id uuid not null,source_id uuid not null,
 sequence bigint not null check(sequence between 1 and 9007199254740991), message_id uuid not null,author_user_id uuid not null,
 fact_hash text not null check(fact_hash ~ '^[a-f0-9]{64}$'),
 recipient_cursor text check(length(recipient_cursor)<=1800), snapshot_hash text check(snapshot_hash ~ '^[a-f0-9]{64}$'),
 recipient_through_sequence bigint check(recipient_through_sequence between sequence and 9007199254740991),
 fanout_complete boolean not null default false,lease_token uuid,lease_until timestamptz,
 next_attempt_at timestamptz not null default now(),last_error_code text,
 primary key(tenant_id,id),unique(tenant_id,source_id,sequence),unique(tenant_id,message_id),
 foreign key(tenant_id,source_id) references notifications.tournament_message_sources(tenant_id,id),
 check((lease_token is null)=(lease_until is null)),check((snapshot_hash is null)=(recipient_through_sequence is null))
);
create table notifications.tournament_message_recipient_outbox (
 tenant_id uuid not null,id uuid not null,fact_id uuid not null,witness jsonb not null,
 witness_hash text not null check(witness_hash ~ '^[a-f0-9]{64}$'),
 baseline_sequence bigint not null check(baseline_sequence between 0 and 9007199254740991),
 read_through_sequence bigint not null check(read_through_sequence between baseline_sequence and 9007199254740991),
 mapping_id uuid,user_id uuid,provider_client_id text,
 state text not null default 'PENDING' check(state in('PENDING','PROJECTED','SUPPRESSED')),
 lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz not null default now(),last_error_code text,
 completed_at timestamptz,created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,fact_id,witness_hash),unique(tenant_id,id,user_id),
 unique(tenant_id,fact_id,user_id),
 foreign key(tenant_id,fact_id) references notifications.tournament_message_facts(tenant_id,id),
 foreign key(tenant_id,mapping_id) references integration.external_entity_map(tenant_id,id),
 foreign key(tenant_id,user_id) references identity.users(tenant_id,id),
 check(coalesce(jsonb_typeof(witness)='object' and (
  (witness->>'kind'='PARTICIPANT' and witness - array['kind','generation','actorHash']='{}'::jsonb
   and jsonb_typeof(witness->'generation')='string' and witness->>'generation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   and jsonb_typeof(witness->'actorHash')='string' and witness->>'actorHash' ~ '^[a-f0-9]{64}$')
  or (witness->>'kind'='ORGANIZER' and witness - array['kind','revision','selectedUserId']='{}'::jsonb
   and jsonb_typeof(witness->'selectedUserId')='string' and witness->>'selectedUserId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   and jsonb_typeof(witness->'revision')='number' and witness->>'revision' ~ '^[1-9][0-9]{0,15}$'
   and length(witness->>'revision')<=16 and witness->>'revision' <= case when length(witness->>'revision')=16 then '9007199254740991' else '9999999999999999' end)
 ),false)),
 check((mapping_id is null)=(user_id is null) and (user_id is null)=(provider_client_id is null)),
 check((lease_token is null)=(lease_until is null)),check((state='PENDING')=(completed_at is null))
);
create index tournament_sources_due on notifications.tournament_message_sources(next_attempt_at) where enabled;
create index tournament_facts_due on notifications.tournament_message_facts(tenant_id,next_attempt_at) where not fanout_complete;
create index tournament_recipients_due on notifications.tournament_message_recipient_outbox(tenant_id,next_attempt_at) where state='PENDING';
alter table notifications.tournament_message_sources enable row level security;
alter table notifications.tournament_message_sources force row level security;
create policy tournament_sources_tenant on notifications.tournament_message_sources using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.tournament_message_facts enable row level security;
alter table notifications.tournament_message_facts force row level security;
create policy tournament_facts_tenant on notifications.tournament_message_facts using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.tournament_message_recipient_outbox enable row level security;
alter table notifications.tournament_message_recipient_outbox force row level security;
create policy tournament_recipients_tenant on notifications.tournament_message_recipient_outbox using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.intents add column tournament_notification_context_id uuid,
 add foreign key(tenant_id,tournament_notification_context_id,recipient_user_id) references notifications.tournament_message_recipient_outbox(tenant_id,id,user_id);
alter table notifications.deliveries add column tournament_notification_context_id uuid,
 add column tournament_claim_generation bigint not null default 0 check(tournament_claim_generation between 0 and 9007199254740991),
 add column tournament_dispatch_started_at timestamptz,
 add foreign key(tenant_id,tournament_notification_context_id) references notifications.tournament_message_recipient_outbox(tenant_id,id);
alter table notifications.deliveries drop constraint deliveries_state_check;
alter table notifications.deliveries add constraint deliveries_state_check check(state in('PENDING','SENDING','STATION_PENDING','STATION_SENDING','TOURNAMENT_PENDING','TOURNAMENT_SENDING','SENT','DELIVERED','FAILED','DEAD','SUPPRESSED'));
-- The existing unnamed completion CHECK is deliveries_check1 (channel/endpoint is check).
alter table notifications.deliveries drop constraint deliveries_check1;
alter table notifications.deliveries add constraint deliveries_check1 check(
 (state in('SENT','DELIVERED','FAILED','DEAD','SUPPRESSED') and completed_at is not null)
 or(state in('PENDING','SENDING','STATION_PENDING','STATION_SENDING','TOURNAMENT_PENDING','TOURNAMENT_SENDING') and completed_at is null));
create function notifications.tournament_intent_floor() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' and (new.tournament_notification_context_id is distinct from old.tournament_notification_context_id
   or (old.tournament_notification_context_id is not null and (new.tenant_id,new.id,new.recipient_user_id) is distinct from (old.tenant_id,old.id,old.recipient_user_id))) then
  raise exception 'TOURNAMENT_CONTEXT_IMMUTABLE';
 end if;
 -- Ordinary/scenario callers retain their existing privileges; never probe tournament tables for NULL context.
 -- The UPDATE guard above still rejects stripping any previously bound tournament context.
 if new.tournament_notification_context_id is null then
  -- Existing generic projection can select an active tournament rule. It must not create an unbound tournament intent.
  -- These are existing projector-readable tables, not the private tournament recipient ledger.
  if exists(select 1 from notifications.templates where tenant_id=new.tenant_id and id=new.template_id and template_key='tournament.message.v1') then
   raise exception 'TOURNAMENT_CONTEXT_REQUIRED';
  end if;
  -- Scenario writers with NULL rule need no trigger_rules privilege. A SQL OR does not avoid ACL checks.
  if new.trigger_rule_id is not null then
   if exists(select 1 from notifications.trigger_rules where tenant_id=new.tenant_id and id=new.trigger_rule_id and (rule_key='tournament.message.default.v1' or source_event_type='tournaments.chat.message.published.v1')) then
    raise exception 'TOURNAMENT_CONTEXT_REQUIRED';
   end if;
  end if;
  return new;
 end if;
 if new.tournament_notification_context_id is not null then
  if new.station_notification_context_id is not null then raise exception 'NOTIFICATION_CONTEXT_MIXED'; end if;
  if new.render_data ? 'scenarioRunId' then raise exception 'TOURNAMENT_SCENARIO_FORBIDDEN'; end if;
  if new.source_event_id<>new.tournament_notification_context_id then raise exception 'TOURNAMENT_SOURCE_CONTEXT_MISMATCH'; end if;
  if TG_OP='UPDATE' and (new.source_event_id,new.trigger_rule_id,new.template_id,new.dedupe_key,new.render_data,new.rendered_title,new.rendered_body,new.rendered_deep_link) is distinct from (old.source_event_id,old.trigger_rule_id,old.template_id,old.dedupe_key,old.render_data,old.rendered_title,old.rendered_body,old.rendered_deep_link) then raise exception 'TOURNAMENT_INTENT_IMMUTABLE'; end if;
 end if;
 return new;
end $$;
create trigger tournament_intent_floor before insert or update on notifications.intents for each row execute function notifications.tournament_intent_floor();
create function notifications.tournament_delivery_floor() returns trigger language plpgsql as $$
declare context_id uuid;
begin
 -- No parent row lock: delivery -> endpoint -> intent is the finalizer lock order.
 select tournament_notification_context_id into context_id from notifications.intents where tenant_id=new.tenant_id and id=new.intent_id;
 if not found then raise exception 'TOURNAMENT_PARENT_MISSING'; end if;
 if TG_OP='UPDATE' and (new.tournament_notification_context_id is distinct from old.tournament_notification_context_id
   or (old.tournament_notification_context_id is not null and (new.tenant_id,new.id,new.intent_id,new.channel,new.endpoint_id) is distinct from (old.tenant_id,old.id,old.intent_id,old.channel,old.endpoint_id))) then
  raise exception 'TOURNAMENT_CONTEXT_IMMUTABLE';
 end if;
 if context_id is distinct from new.tournament_notification_context_id then raise exception 'TOURNAMENT_CONTEXT_MISMATCH'; end if;
 if TG_OP='UPDATE' and new.tournament_claim_generation<old.tournament_claim_generation then raise exception 'TOURNAMENT_GENERATION_REGRESSION'; end if;
 if context_id is null then
  if new.state in('TOURNAMENT_PENDING','TOURNAMENT_SENDING') or new.tournament_dispatch_started_at is not null or new.tournament_claim_generation<>0 then raise exception 'TOURNAMENT_CONTEXT_REQUIRED'; end if;
 else
  if new.scenario_available_at is not null or new.scenario_v2_available_at is not null or new.scenario_dispatch_started_at is not null then raise exception 'TOURNAMENT_SCENARIO_FORBIDDEN'; end if;
  if new.channel='IN_APP' then
   if new.state not in('DELIVERED','SUPPRESSED') or new.attempt_count<>0 or new.tournament_dispatch_started_at is not null then raise exception 'TOURNAMENT_IN_APP_TERMINAL_ONLY'; end if;
  elsif new.channel='PUSH' then
   if TG_OP='INSERT' and (new.state<>'TOURNAMENT_PENDING' or new.attempt_count<>0 or new.tournament_claim_generation<>0 or new.tournament_dispatch_started_at is not null) then raise exception 'TOURNAMENT_PUSH_BIRTH_INVALID'; end if;
   if new.state in('SENT','DELIVERED') and new.tournament_dispatch_started_at is null then raise exception 'TOURNAMENT_DISPATCH_PROOF_REQUIRED'; end if;
   if new.state in('PENDING','SENDING','STATION_PENDING','STATION_SENDING') then raise exception 'TOURNAMENT_OLD_WRITER_FORBIDDEN'; end if;
  else raise exception 'TOURNAMENT_CHANNEL_FORBIDDEN'; end if;
 end if;
 return new;
end $$;
create trigger tournament_delivery_floor before insert or update on notifications.deliveries for each row execute function notifications.tournament_delivery_floor();
-- phub:reviewed-blocking-index: bounded lock/statement timeouts; actual table size reviewed before apply.
create index tournament_delivery_due on notifications.deliveries(tenant_id,next_attempt_at,id) where state in('TOURNAMENT_PENDING','TOURNAMENT_SENDING');
-- phub:reviewed-blocking-index: bounded lock/statement timeouts; table size must be checked before real apply.
create unique index tournament_intent_context_unique on notifications.intents(tenant_id,tournament_notification_context_id) where tournament_notification_context_id is not null;
create function notifications.tournament_source_identity() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new)-array['enabled','after_sequence','completed_sequence','through_sequence','lease_token','lease_until','next_attempt_at','last_error_code']) is distinct from (to_jsonb(old)-array['enabled','after_sequence','completed_sequence','through_sequence','lease_token','lease_until','next_attempt_at','last_error_code']) or new.after_sequence<old.after_sequence or new.completed_sequence<old.completed_sequence then raise exception 'TOURNAMENT_SOURCE_IMMUTABLE'; end if;
 return new;
end $$;
create trigger tournament_source_identity before update on notifications.tournament_message_sources for each row execute function notifications.tournament_source_identity();
create function notifications.tournament_fact_identity() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new)-array['recipient_cursor','snapshot_hash','recipient_through_sequence','fanout_complete','lease_token','lease_until','next_attempt_at','last_error_code']) is distinct from (to_jsonb(old)-array['recipient_cursor','snapshot_hash','recipient_through_sequence','fanout_complete','lease_token','lease_until','next_attempt_at','last_error_code']) or (old.fanout_complete and not new.fanout_complete) then raise exception 'TOURNAMENT_FACT_IMMUTABLE'; end if;
 return new;
end $$;
create trigger tournament_fact_identity before update on notifications.tournament_message_facts for each row execute function notifications.tournament_fact_identity();
create function notifications.tournament_recipient_identity() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new)-array['mapping_id','user_id','provider_client_id','state','lease_token','lease_until','next_attempt_at','last_error_code','completed_at']) is distinct from (to_jsonb(old)-array['mapping_id','user_id','provider_client_id','state','lease_token','lease_until','next_attempt_at','last_error_code','completed_at'])
 or ((old.user_id is not null or old.state<>'PENDING') and (new.user_id,new.mapping_id,new.provider_client_id) is distinct from (old.user_id,old.mapping_id,old.provider_client_id))
 or (old.state<>'PENDING' and new.state<>old.state) then raise exception 'TOURNAMENT_RECIPIENT_IMMUTABLE'; end if;
 return new;
end $$;
create trigger tournament_recipient_identity before update on notifications.tournament_message_recipient_outbox for each row execute function notifications.tournament_recipient_identity();
