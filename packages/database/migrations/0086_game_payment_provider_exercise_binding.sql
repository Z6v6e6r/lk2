-- Expand-only provider activity binding for trusted payment evidence.
-- Existing evidence remains readable; all new bridge commands require this field.

alter table games.payment_confirmation_evidence
  add column if not exists provider_exercise_id text;

alter table games.payment_confirmation_evidence
  drop constraint if exists payment_confirmation_evidence_provider_exercise_id_check;

alter table games.payment_confirmation_evidence
  add constraint payment_confirmation_evidence_provider_exercise_id_check
  check (
    provider_exercise_id is null
    or char_length(btrim(provider_exercise_id)) between 1 and 200
  ) not valid;

alter table games.payment_confirmation_evidence
  validate constraint payment_confirmation_evidence_provider_exercise_id_check;
