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
- Authenticated self-service level read/write for the JWT player. The write accepts only
  a current canonical `levelId`, records `SELF_DECLARED`, updates the profile projection
  and sport-level projection atomically, and is concurrency-safe and idempotent.
- Native Games UX for `PLAYER_LEVEL_REQUIRED`: the interrupted game/action/invitation
  context is retained, the player can choose a canonical level, stale client caches are
  invalidated, and the original JOIN or WAITLIST command is retried against the server.
- Versioned trusted level assessment for native Games. The browser receives only renderable
  questions/options and submits selected option IDs; the server validates branch integrity,
  computes the established result once in `@phub/domain`, records `ONBOARDING`, updates the
  numeric/profile projection, invalidates client caches and retries the interrupted command.
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
- Route the legacy onboarding UI to the trusted PadlHub assessment command. A fresh read-only
  server-147 audit confirms the current `/lk/onboarding/level` handler accepts client-computed
  level/numeric/provenance fields and therefore cannot safely be reused as proof.
- Add a transactional outbox/adapter if the trusted PadlHub assessment result must also be shown
  in Viva-backed legacy profile views.
- Migrate tournament and training registration writers; their current impact cards are
  intentionally marked unsupported.
- Define and migrate the activity personal-invitation creation/revocation command.
- Connect downstream payment callbacks/reconciliation to the stored eligibility snapshot.
- Reconcile the legacy letter/numeric/Viva mappings with the CUP-owned canonical rating
  ledger; legacy free text must remain informational until explicitly mapped.
- Add denied-waitlist-promotion user notification and operational alert thresholds.
- Run an anonymized production data-quality audit before moving `GAME` to `SHADOW`.

## Verification evidence

- Full Vitest suite passed: 328 files passed, 4 skipped; 2192 tests passed,
  41 skipped. Targeted domain, database, API route, SDK, web recovery, and CUP component
  regressions are included in that run.
- TypeScript typecheck and ESLint passed.
- All package and application production builds passed, followed by the runtime import check.
- Admin OpenAPI lint passed with only the existing unrelated warnings.
- Migration static safety check passed; the SQL was not applied.
- Browser QA passed for the CUP **Levels** rules and impact views at the default desktop
  viewport and at `390x844`. The check used a local mock API and made no external writes.

## Go/no-go

`NO-GO` for production `BLOCK`.

The native game path, both recovery methods, and policy control plane are implemented, but the
legacy writers, tournament/training writers, Viva profile convergence and paid-flow reconciliation
are not yet a single authoritative contour. `OFF` is the only safe initial migration default.
