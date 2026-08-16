# Participation level eligibility: implementation checkpoint

Date: 2026-08-16
Base: `b7c430ab2c7236589bb62731d979c14b7b9c860b`
Delivery stage: isolated implementation, not integrated or deployed

## Delivered in this checkpoint

- One pure level-eligibility rule for `GAME`, `TOURNAMENT`, and `TRAINING` with
  `OFF`, `SHADOW`, `WARN`, and `BLOCK` modes.
- Canonical, versioned PADEL scale and player-level projection in PostgreSQL.
- Versioned policy history, optimistic publishing, idempotency, audit old/new values,
  impact preview, rollback-as-new-version, and readiness gates for `BLOCK`.
- Server-side enforcement for the native PadlHub game join, waitlist join, and
  waitlist promotion commands. Caller-supplied player/rank/bypass facts are rejected.
- Exact personal-invitation validation by tenant, activity, recipient, status, expiry,
  revocation, and use count. Public/community/team links do not bypass level checks.
- Immutable eligibility decision references on participation/reservation/waitlist records
  and payment snapshots before the native paid-game path continues.
- CUP section **Levels** with scale, policies, server preview, impact, history, and
  explicit commented publication.
- Bounded OpenTelemetry counters and structured decision logging without player or
  activity IDs in metric labels.

## Deliberately not activated

All seeded policies are `OFF`. Publishing `BLOCK` fails unless the four persisted
readiness gates are true:

1. the activity writer is authoritative;
2. the player-level projection is complete;
3. clients can recover from a missing or stale level;
4. paid-flow recovery and reconciliation are ready.

No migration was executed and no runtime setting was changed by this checkpoint.

## Remaining work before production enforcement

- Move the legacy LK/Node-RED join and waitlist writers behind the server command.
- Add authenticated self-level/onboarding mutation and the LK recovery modal that
  preserves and resumes the interrupted action.
- Migrate tournament and training registration writers; their current impact cards are
  intentionally marked unsupported.
- Define and migrate the activity personal-invitation creation/revocation command.
- Connect downstream payment callbacks/reconciliation to the stored eligibility snapshot.
- Reconcile the legacy letter/numeric/Viva mappings with the CUP-owned canonical rating
  ledger; legacy free text must remain informational until explicitly mapped.
- Add denied-waitlist-promotion user notification and operational alert thresholds.
- Run an anonymized production data-quality audit before moving `GAME` to `SHADOW`.

## Verification evidence

- Domain, database, API route, SDK, and CUP component regression tests passed.
- TypeScript typecheck and ESLint passed.
- Domain, database, API, and CUP production builds passed.
- Admin OpenAPI lint passed with only the existing unrelated warnings.
- Migration static safety check passed; the SQL was not applied.
- Browser QA passed for the CUP **Levels** rules and impact views at the default desktop
  viewport and at `390x844`. The check used a local mock API and made no external writes.

## Go/no-go

`NO-GO` for production `BLOCK`.

The native game path and policy control plane are implemented, but the legacy writers,
player recovery, tournament/training writers, and paid-flow reconciliation are not yet a
single authoritative contour. `OFF` is the only safe initial migration default.
