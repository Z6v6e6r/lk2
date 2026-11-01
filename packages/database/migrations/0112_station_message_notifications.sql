-- Concrete station notifications: explicit source adoption, no data backfill or activation.
-- Rollback retains context and STATION_* states; old workers cannot claim them.
set local lock_timeout='3s';
set local statement_timeout='30s';
-- phub:reviewed-new-table-index
create table notifications.station_message_sources (
 tenant_id uuid not null references identity.tenants(id), id uuid not null,
 community_id uuid not null, mapping_id uuid not null, owner_namespace text not null check(owner_namespace='iSkq6G'),
 private_community_id text not null check(length(private_community_id) between 1 and 200),
 incarnation_hash text not null check(incarnation_hash ~ '^sha256:[a-f0-9]{64}$'), stream_id uuid not null,
 replay_floor bigint not null check(replay_floor between 0 and 9007199254740991),
 after_sequence bigint not null, through_sequence bigint, enabled boolean not null default false,
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default now(), last_error_code text,
 created_at timestamptz not null default now(), primary key(tenant_id,id),
 unique(tenant_id,private_community_id,incarnation_hash,stream_id),
 foreign key(tenant_id,mapping_id) references integration.external_entity_map(tenant_id,id),
 check(after_sequence between replay_floor and 9007199254740991),
 check(through_sequence is null or through_sequence between after_sequence and 9007199254740991),
 check((lease_token is null)=(lease_until is null))
);
create table notifications.station_message_facts (
 tenant_id uuid not null, id uuid not null, source_id uuid not null, sequence bigint not null check(sequence between 1 and 9007199254740991),
 message_id uuid not null, author_player_id text not null, proof_hash text not null check(proof_hash ~ '^sha256:[a-f0-9]{64}$'),
 after_player_id text, fanout_complete boolean not null default false,
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default now(), last_error_code text,
 primary key(tenant_id,id), unique(tenant_id,source_id,sequence), unique(tenant_id,source_id,message_id),
 foreign key(tenant_id,source_id) references notifications.station_message_sources(tenant_id,id),
 check((lease_token is null)=(lease_until is null))
);
create table notifications.station_message_recipient_outbox (
 tenant_id uuid not null, id uuid not null, fact_id uuid not null, player_id text not null,
 membership_epoch bigint not null check(membership_epoch between 0 and 9007199254740991),
 baseline_sequence bigint not null check(baseline_sequence between 0 and 9007199254740991),
 read_through_sequence bigint not null check(read_through_sequence between baseline_sequence and 9007199254740991),
 mapping_id uuid, user_id uuid, state text not null default 'PENDING' check(state in('PENDING','PROJECTED','SUPPRESSED')),
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default now(), last_error_code text,
 completed_at timestamptz, created_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,fact_id,player_id,membership_epoch), unique(tenant_id,id,user_id),
 foreign key(tenant_id,fact_id) references notifications.station_message_facts(tenant_id,id),
 foreign key(tenant_id,mapping_id) references integration.external_entity_map(tenant_id,id),
 foreign key(tenant_id,user_id) references identity.users(tenant_id,id),
 check((mapping_id is null)=(user_id is null)), check((lease_token is null)=(lease_until is null)),
 check((state='PENDING')=(completed_at is null))
);
create index station_sources_due on notifications.station_message_sources(next_attempt_at) where enabled;
create index station_facts_due on notifications.station_message_facts(tenant_id,next_attempt_at) where not fanout_complete;
create index station_recipients_due on notifications.station_message_recipient_outbox(tenant_id,next_attempt_at) where state='PENDING';
alter table notifications.station_message_sources enable row level security;
alter table notifications.station_message_sources force row level security;
create policy station_sources_tenant on notifications.station_message_sources using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.station_message_facts enable row level security;
alter table notifications.station_message_facts force row level security;
create policy station_facts_tenant on notifications.station_message_facts using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.station_message_recipient_outbox enable row level security;
alter table notifications.station_message_recipient_outbox force row level security;
create policy station_recipients_tenant on notifications.station_message_recipient_outbox using(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table notifications.intents add column station_notification_context_id uuid,
 add foreign key(tenant_id,station_notification_context_id,recipient_user_id) references notifications.station_message_recipient_outbox(tenant_id,id,user_id);
alter table notifications.deliveries add column station_notification_context_id uuid,
 add column station_claim_generation bigint not null default 0 check(station_claim_generation between 0 and 9007199254740991),
 add column station_dispatch_started_at timestamptz,
 add foreign key(tenant_id,station_notification_context_id) references notifications.station_message_recipient_outbox(tenant_id,id);
alter table notifications.deliveries drop constraint deliveries_state_check;
alter table notifications.deliveries add constraint deliveries_state_check check(state in('PENDING','SENDING','STATION_PENDING','STATION_SENDING','SENT','DELIVERED','FAILED','DEAD','SUPPRESSED'));
-- The existing unnamed completion CHECK is deliveries_check1 (channel/endpoint is check).
alter table notifications.deliveries drop constraint deliveries_check1;
alter table notifications.deliveries add constraint deliveries_check1 check(
 (state in('SENT','DELIVERED','FAILED','DEAD','SUPPRESSED') and completed_at is not null)
 or(state in('PENDING','SENDING','STATION_PENDING','STATION_SENDING') and completed_at is null));
create function notifications.station_intent_floor() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' and (new.station_notification_context_id is distinct from old.station_notification_context_id
   or (old.station_notification_context_id is not null and (new.tenant_id,new.id,new.recipient_user_id) is distinct from (old.tenant_id,old.id,old.recipient_user_id))) then
  raise exception 'STATION_CONTEXT_IMMUTABLE';
 end if;
 -- Ordinary/scenario callers retain their existing privileges; never probe station tables for NULL context.
 -- The UPDATE guard above still rejects stripping any previously bound station context.
 if new.station_notification_context_id is null then
  -- Existing generic projection can select an active station rule. It must not create an unbound station intent.
  -- These are existing projector-readable tables, not the private station recipient ledger.
  if exists(select 1 from notifications.templates where tenant_id=new.tenant_id and id=new.template_id and template_key='station.message.v1') then
   raise exception 'STATION_CONTEXT_REQUIRED';
  end if;
  -- Scenario writers with NULL rule need no trigger_rules privilege. A SQL OR does not avoid ACL checks.
  if new.trigger_rule_id is not null then
   if exists(select 1 from notifications.trigger_rules where tenant_id=new.tenant_id and id=new.trigger_rule_id and (rule_key='station.message.default.v1' or source_event_type='communities.station.message.published.v1')) then
    raise exception 'STATION_CONTEXT_REQUIRED';
   end if;
  end if;
  return new;
 end if;
 if new.station_notification_context_id is not null then
  if new.render_data ? 'scenarioRunId' then raise exception 'STATION_SCENARIO_FORBIDDEN'; end if;
  if new.source_event_id<>new.station_notification_context_id then raise exception 'STATION_SOURCE_CONTEXT_MISMATCH'; end if;
  if TG_OP='UPDATE' and (new.source_event_id,new.trigger_rule_id,new.template_id,new.dedupe_key,new.render_data,new.rendered_title,new.rendered_body,new.rendered_deep_link) is distinct from (old.source_event_id,old.trigger_rule_id,old.template_id,old.dedupe_key,old.render_data,old.rendered_title,old.rendered_body,old.rendered_deep_link) then raise exception 'STATION_INTENT_IMMUTABLE'; end if;
 end if;
 return new;
end $$;
create trigger station_intent_floor before insert or update on notifications.intents for each row execute function notifications.station_intent_floor();
create function notifications.station_delivery_floor() returns trigger language plpgsql as $$
declare context_id uuid;
begin
 -- No parent row lock: delivery -> endpoint -> intent is the finalizer lock order.
 select station_notification_context_id into context_id from notifications.intents where tenant_id=new.tenant_id and id=new.intent_id;
 if not found then raise exception 'STATION_PARENT_MISSING'; end if;
 if TG_OP='UPDATE' and (new.station_notification_context_id is distinct from old.station_notification_context_id
   or (old.station_notification_context_id is not null and (new.tenant_id,new.id,new.intent_id,new.channel,new.endpoint_id) is distinct from (old.tenant_id,old.id,old.intent_id,old.channel,old.endpoint_id))) then
  raise exception 'STATION_CONTEXT_IMMUTABLE';
 end if;
 if context_id is distinct from new.station_notification_context_id then raise exception 'STATION_CONTEXT_MISMATCH'; end if;
 if TG_OP='UPDATE' and new.station_claim_generation<old.station_claim_generation then raise exception 'STATION_GENERATION_REGRESSION'; end if;
 if context_id is null then
  if new.state in('STATION_PENDING','STATION_SENDING') or new.station_dispatch_started_at is not null or new.station_claim_generation<>0 then raise exception 'STATION_CONTEXT_REQUIRED'; end if;
 else
  if new.scenario_available_at is not null or new.scenario_v2_available_at is not null or new.scenario_dispatch_started_at is not null then raise exception 'STATION_SCENARIO_FORBIDDEN'; end if;
  if new.channel='IN_APP' then
   if new.state not in('DELIVERED','SUPPRESSED') or new.attempt_count<>0 or new.station_dispatch_started_at is not null then raise exception 'STATION_IN_APP_TERMINAL_ONLY'; end if;
  elsif new.channel='PUSH' then
   if TG_OP='INSERT' and (new.state<>'STATION_PENDING' or new.attempt_count<>0 or new.station_claim_generation<>0 or new.station_dispatch_started_at is not null) then raise exception 'STATION_PUSH_BIRTH_INVALID'; end if;
   if new.state in('SENT','DELIVERED') and new.station_dispatch_started_at is null then raise exception 'STATION_DISPATCH_PROOF_REQUIRED'; end if;
   if new.state in('PENDING','SENDING') then raise exception 'STATION_OLD_WRITER_FORBIDDEN'; end if;
  else raise exception 'STATION_CHANNEL_FORBIDDEN'; end if;
 end if;
 return new;
end $$;
create trigger station_delivery_floor before insert or update on notifications.deliveries for each row execute function notifications.station_delivery_floor();
-- phub:reviewed-blocking-index: bounded lock/statement timeouts; actual table size reviewed before apply.
create index station_delivery_due on notifications.deliveries(tenant_id,next_attempt_at,id) where state in('STATION_PENDING','STATION_SENDING');
create function notifications.station_source_identity() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new)-array['enabled','after_sequence','through_sequence','lease_token','lease_until','next_attempt_at','last_error_code']) is distinct from (to_jsonb(old)-array['enabled','after_sequence','through_sequence','lease_token','lease_until','next_attempt_at','last_error_code']) or new.after_sequence<old.after_sequence then raise exception 'STATION_SOURCE_IMMUTABLE'; end if;
 return new;
end $$;
create trigger station_source_identity before update on notifications.station_message_sources for each row execute function notifications.station_source_identity();
create function notifications.station_fact_identity() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new)-array['after_player_id','fanout_complete','lease_token','lease_until','next_attempt_at','last_error_code']) is distinct from (to_jsonb(old)-array['after_player_id','fanout_complete','lease_token','lease_until','next_attempt_at','last_error_code']) or (old.fanout_complete and not new.fanout_complete) then raise exception 'STATION_FACT_IMMUTABLE'; end if;
 return new;
end $$;
create trigger station_fact_identity before update on notifications.station_message_facts for each row execute function notifications.station_fact_identity();
create function notifications.station_recipient_identity() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new)-array['mapping_id','user_id','state','lease_token','lease_until','next_attempt_at','last_error_code','completed_at']) is distinct from (to_jsonb(old)-array['mapping_id','user_id','state','lease_token','lease_until','next_attempt_at','last_error_code','completed_at'])
 or (old.user_id is not null and (new.user_id,new.mapping_id) is distinct from (old.user_id,old.mapping_id))
 or (old.state<>'PENDING' and new.state<>old.state) then raise exception 'STATION_RECIPIENT_IMMUTABLE'; end if;
 return new;
end $$;
create trigger station_recipient_identity before update on notifications.station_message_recipient_outbox for each row execute function notifications.station_recipient_identity();
