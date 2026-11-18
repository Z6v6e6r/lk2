-- v3 owner receipts are verified by the LK1 settlement owner, not by the legacy Node-RED callback.
alter table games.payment_confirmation_evidence
  drop constraint payment_confirmation_evidence_verified_by_check;

alter table games.payment_confirmation_evidence
  add constraint payment_confirmation_evidence_verified_by_check
  check (verified_by in ('LEGACY_NODE_RED', 'LK1_OWNER_V3'));
