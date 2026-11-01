-- Expand only. NULL is permanent pre-adoption, never backfill original commands.
-- No provider/game/roster writes. Keep markers and owner generation claims on rollback.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table games.quarter_create_attempts add column station_membership jsonb;
-- Old writers cannot prepare/dispatch an adopted pending intent or complete it without
-- the new immutable confirmation marker. Application reload validates canonical hashes.
alter table games.quarter_create_attempts add constraint quarter_create_station_marker_check
 check (station_membership is null or coalesce(
   jsonb_typeof(station_membership)='object'
   and octet_length(station_membership::text)<=32768
   and station_membership->'version'='1'::jsonb
   and case station_membership->>'outcome'
     when 'PENDING_ADMISSION' then
       state in ('PREPARING','REFUSED_NOT_DISPATCHED') and admission is null
       and station_membership='{"version":1,"outcome":"PENDING_ADMISSION"}'::jsonb
     when 'INTENT' then state in ('PREPARING','EXPIRED_NOT_DISPATCHED') and dispatch_started_at is null
     when 'OWNER_ADMISSION' then state in ('PREPARED','DISPATCH_STARTED','REJECTED','EXPIRED_NOT_DISPATCHED')
     when 'CONFIRMED_FACT' then state='CONFIRMED' and receipt is not null
       and jsonb_typeof(station_membership->'receiptSha256')='string'
       and station_membership->>'receiptSha256' ~ '^sha256:[a-f0-9]{64}$'
       and jsonb_typeof(station_membership->'generationId')='string'
       and station_membership->>'generationId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     else false end
   and (station_membership->>'outcome'='PENDING_ADMISSION' or (
     jsonb_typeof(station_membership->'admission')='object'
     and jsonb_typeof(station_membership->'admissionSha256')='string'
     and station_membership->>'admissionSha256' ~ '^sha256:[a-f0-9]{64}$'
     and (admission is null or (admission=station_membership->'admission'
       and admission_hash=station_membership->>'admissionSha256'))
   ))
   and (station_membership->>'outcome' in ('PENDING_ADMISSION','INTENT') or (
     jsonb_typeof(station_membership->'actor')='object'
     and jsonb_typeof(station_membership->'request')='object'
     and jsonb_typeof(station_membership->'response')='object'
     and station_membership#>>'{request,activity,kind}'='GAME_CREATE'
     and station_membership#>>'{request,activity,id}'=draft_id::text
     and station_membership#>>'{request,operationId}'=id::text
     and station_membership#>>'{actor,tenantId}'=tenant_id::text
     and station_membership#>>'{actor,canonicalUserId}'=actor_user_id::text
   )),false));
