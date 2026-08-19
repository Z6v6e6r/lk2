# Participation command foundation

## Purpose

This is the default-off server boundary that evaluates the shared level rule before a legacy or
cross-service writer changes a game, waitlist, tournament, or training roster. It is infrastructure
for later writer adapters; installing it does not route or authorize any existing writer.

## Contract

- `POST /internal/api/v1/{tenantKey}/participation-commands` persists one decision and optional
  payment snapshot under `Idempotency-Key`.
- `POST /internal/api/v1/{tenantKey}/participation-commands/{commandId}/acknowledgements` records the
  trusted writer result as `APPLIED` or `FAILED`.
- `GET /internal/api/v1/{tenantKey}/participation-commands/{commandId}` is server-only recovery.
- `X-Phub-Participation-Token` is a dedicated secret bound to one configured tenant and one stable
  writer principal. It must never be exposed to Tilda, web, mobile, logs, query strings, or CUP.
- Requests contain canonical actor/activity IDs and action only. Level, rank, constraint, policy,
  invitation/bypass and result fields are rejected by the strict schema.

An `AUTHORIZED` result is not a roster mutation. The writer must apply its own mutation and ACK the
same command. Unacknowledged authorizations expire; the worker writes a durable `EXPIRED` outcome.
Payment-bearing commands bind the immutable eligibility decision to one payment operation ID.

## Configuration

Safe defaults are all disabled:

```text
PARTICIPATION_COMMANDS_ENABLED=false
PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED=false
```

Staging API enablement additionally requires a secret of at least 32 characters,
`PARTICIPATION_COMMAND_TENANT_KEY`, and `PARTICIPATION_COMMAND_PRINCIPAL_KEY`. The token should be
provided through `PARTICIPATION_COMMAND_TOKEN_FILE`. Production enablement is rejected by config in
this foundation release. The initial authorization TTL is 300 seconds and is bounded to 30–900.

## Required order

1. Keep API and worker flags false.
2. Build from one reviewed SHA and run the 34-file disposable-clone rehearsal. Do not infer shared
   migration authority from a successful clone.
3. Under a separate database-migration approval, apply migration 0088 and the exact v3 ACL grants;
   verify migration ledger, table owners, FORCE RLS, policies and runtime privileges.
4. Deploy with both flags false and verify existing registration paths are unchanged.
5. Implement and test one writer adapter. It must derive canonical identity after standard user
   authentication, call authorize before mutation, use the returned decision/payment snapshot, and
   ACK after the writer transaction.
6. Enable API and expiry worker on one synthetic staging tenant. Exercise authorize, reject, replay,
   stale activity revision, payment-operation conflict, ACK, expiry and recovery without real
   booking or payment.
7. Only after reconciliation and client recovery evidence may the corresponding readiness flags be
   published and policy advance independently from `OFF` to `SHADOW`, `WARN`, then `BLOCK`.

## Stop conditions

Stop without enabling a writer if any authorization lacks a decision, a payment operation can bind
twice, an ACK can apply after expiry, cross-tenant reads are visible, activity revisions regress,
metrics contain player/activity identifiers as labels, or an existing writer can mutate without the
new boundary. Do not delete commands or decisions during rollback.

## Rollback

Disable the writer adapter first, then `PARTICIPATION_COMMANDS_ENABLED`; leave the expiry worker on
long enough to expire outstanding authorizations, or reconcile them explicitly. Application rollback
does not remove migration 0088 or ACLs. Policies remain `OFF`; no existing participant is removed and
no payment/refund is initiated by this foundation.
