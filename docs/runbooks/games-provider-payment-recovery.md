# Games provider/payment recovery runbook

This runbook is source-only while provider recovery is synthetic/default OFF. It authorizes no
provider, payment, refund, callback provisioning, migration, deploy, or state mutation.

## Read-only inspection

Run `scripts/audit-game-provider-recovery.sql` through an approved read-only database session with
the target tenant context. Record operation UUID, state, action, attempt counts, age and bounded
error class. Do not copy provider IDs, player IDs, phones, tokens or raw payloads into tickets.

Interpretation:

- `READY`: intent exists and no dispatch is leased.
- `SUBMITTING`: wait for the lease; after expiry the worker must classify it `UNKNOWN`.
- `UNKNOWN`: read-back is due; do not submit again.
- `RECONCILING`: read-back lease is active.
- `MANUAL_REVIEW`: automation exhausted without claiming failure.
- `CONFIRMED/REJECTED`: terminal and monotonic.

`UNKNOWN`, `RECONCILING`, and unresolved `MANUAL_REVIEW` hold the reservation even after its normal
TTL. This is intentional payment safety: capacity is not reallocated until payment absence/rejection
is proven or a separately approved operator procedure resolves the case.

## Callback loss and mismatch

Callback loss is inferred only when read-back later recovers a terminal result. Duplicate callback
dedupe is a no-op. Actor, tenant, game, reservation, payment or reference mismatch never confirms
payment; retain the seat/operation and escalate with internal operation UUID plus mismatch class.
Conflicting terminal evidence is an incident and never reverses the first terminal state
automatically.

## Retry rules

- Submit retry: only a proven `NOT_SENT`, exponential/bounded by the configured maximum.
- Timeout/reset/crash after claim: read-back first; never blind resubmit.
- Read-back unavailable/ambiguous: bounded attempts with backoff, then `MANUAL_REVIEW`.
- A manual retry must use the existing operation/idempotency key and requires a separately approved
  operator command. No such mutation command is included in this package.

## Escalation

Escalate when a lease is older than its expiry, `UNKNOWN` is past `next_attempt_at`, duplicate
correlations exist, a mismatch occurs, or `MANUAL_REVIEW` is reached. Include active source SHA,
runtime gates, adapter contract version and read-only audit output. Never include secrets or PII.

## Rollback boundary

Turn off new writer submissions first. Keep read-back active until every nonterminal intent is
terminal or explicitly handed to an operator. Do not expire/reallocate an uncertain paid seat merely
because the writer is disabled. Database rollback is not performed; migration is additive.

## Future rollout order

No rollout is authorized by this runbook. If separately approved, apply migration 0090 first while
all flags remain false, verify old and new application compatibility, then promote the immutable
application digest. Code-first activation is prohibited. Callback reconciliation remains
configuration-invalid until an authenticated consumer contract and replay test exist.
