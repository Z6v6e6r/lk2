-- Expand only. NULL is permanent pre-adoption, never backfill old registrations.
-- Rollback disables the producer/consumer and retains markers and owner ledgers.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table booking.training_registration_attempts
 add column station_membership jsonb
 check(station_membership is null or
   (jsonb_typeof(station_membership)='object' and octet_length(station_membership::text)<=32768));
