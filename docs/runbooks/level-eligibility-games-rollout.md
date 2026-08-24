# Games level eligibility rollout

This runbook covers the source-ready GAME slice. It does not authorize a shared-database migration,
flag change, policy publication, provider operation, deployment, or production audit.

## Preconditions

- Deploy one immutable build with Games commands and the roster process manager available, while
  every active GAME policy remains `OFF`.
- Verify the exact image digest, migration/RLS evidence, rollback image, queue health and notification
  rule provisioning. Do not infer deployment from CI or an uploaded artifact.
- Deploy the notification consumer contract before the Games producer build. The consumer binds the
  explicit denial routing key before removing its legacy wildcard, so rolling instances do not create
  a routing gap.
- Run `scripts/audit-level-eligibility-readiness.sql` only with separately authorized read-only access.
  Supply an approved `stale_before`; the product has no default freshness TTL.
- CUP must show `readyForBlock=true` for GAME before BLOCK can be published. Readiness rows are
  evidence, not a substitute for observing the active runtime.

## Production execution gate

Source approval, CI and a Draft PR do not authorize this gate. Before any production migration or
deployment, record all of the following against the exact immutable image and migration ledger:

- a completed backup identifier, completion time, WAL/PITR coverage and a successful restore rehearsal;
- clone-derived tenant/partial-shape counts, lock evidence and a measured migration duration budget;
- an approved node-by-node order with a health/readiness hold point after each node and explicit stop
  thresholds for migration errors, queue lag, policy-unavailable decisions and cross-tenant evidence;
- the active runtime digest after each promotion, plus served API and rendered Web smoke evidence from
  that exact digest rather than from CI or an uploaded artifact;
- a rehearsed rollback to the previously verified compatible image and a forward schema recovery that
  preserves eligibility rows and immutable decisions.

The rollout remains `NO-GO` if any item is absent, if backup restore is unverified, or if the live role,
ledger preimage, runtime digest or observed UI differs from the reviewed candidate. Each migration,
deployment, flag/policy change and rollback transition requires its own explicit live authority.

## Denied-promotion notification rule

The source-controlled provisioner is dry-run unless the exact confirmation token is supplied. It is
tenant-scoped, permission-checked, idempotent and audited, and it never changes notification runtime
settings:

```sh
npm run notifications:game-eligibility:provision -- \
  --tenant-key=<tenant> --actor-id=<admin-uuid> --idempotency-key=<unique-key>
```

Applying the preview with `--confirm=APPLY_GAME_ELIGIBILITY_NOTIFICATION_RULESET` is a shared-data
mutation and requires separate authorization. After apply, verify the exact template/rule contract and
an independently observed replay-safe delivery before WARN/BLOCK. This task does not run that command.

## OFF to SHADOW

1. Confirm one explicit active GAME policy exists; absence is `POLICY_UNAVAILABLE`, never implicit OFF.
2. Verify command worker leases, poison-command alerts and waitlist denial events on the target runtime.
3. Publish a new immutable `SHADOW` policy version for one tenant through CUP.
4. Observe evaluation, allow and explicit `shadow_would_block` counters plus sanitized decision logs.
5. Compare the anonymized audit distribution with decision facts. Stop on missing policy, mapping drift,
   queue stalls, cross-tenant evidence, PII labels or unexplained decision volume.

## SHADOW to WARN

1. Require an approved freshness policy for each player-level source and populate stale evidence.
2. Verify Web recovery for missing/unknown/stale levels and the server-owned trusted assessment.
3. Verify notification rules for denied waitlist promotion and replay-safe delivery.
4. Publish a new `WARN` version. Confirm commands remain successful and display the server warning once.
5. Roll back by publishing a new OFF version if warning volume, recovery failures or queue lag exceed the
   agreed operating threshold.

## WARN to BLOCK

1. Require every GAME readiness gate: authoritative writer, player projection, client recovery and
   payment recovery. Recheck-on-promotion is an immutable GAME invariant.
2. Verify legacy/external writers are routed through the approved gateway and callback-loss
   reconciliation is healthy. A default-off adapter or a successful callback sample is not proof.
3. Rehearse BLOCK in a disposable environment, including paid reservation replay, two free seats,
   denied head advancement, invalid invitations and rollback-as-new-version.
4. Obtain explicit live authorization and publish a new BLOCK version. Never edit policy history.

## Rollback and recovery

- Publish a new OFF version; do not mutate an active historical row.
- Keep the roster worker running while reservations and promotion commands drain or are reconciled.
- Promote the previously verified compatible image if code rollback is required.
- Retain eligibility decisions, payment snapshots, command idempotency, outbox and audit rows.
- A poison scheduled command is terminal; diagnose it and create a new repaired command only through an
  approved recovery procedure. Do not reset its attempt counter blindly.

## Unsupported writers and next package

- Tournament has only the read adapter `apps/api/src/tournaments/tournament-summary-routes.ts`; its
  future trusted registration command must call the gateway immediately before mutation.
- Training and GAME+TRAINER currently enter discovery through
  `apps/api/src/bookings/training-event-catalog.ts`; their future server writer/trusted adapter must
  authorize eligibility before mutation. The read/catalog path is not an interception point.
- Tournament and Training remain unsupported and must not use BLOCK.

The next bounded technical package is provider/payment recovery convergence: implement the default-off
external-writer adapter, callback-loss reconciliation and authoritative read-back, then prove that a paid
operation preserves its immutable decision across callback replay, actor mismatch and timeout-after-accept.
