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
- A default-off legacy Games bridge candidate for JOIN/WAITLIST and split-payment confirmation.
  Payment confirmation accepts browser locators only, re-reads Viva server-side, binds provider
  operation, booking and phone to the JWT actor and reservation, and consumes the stored
  eligibility snapshot before canonical participation is created.
- Canonical game creation now resolves the configured level codes to IDs from one active scale
  before writing the aggregate. Automatic organizer participation remains non-blocking, performs
  no organizer-level lookup, and records `ORGANIZER_CREATION_BYPASS` in the creation audit.

## Deliberately not activated

All seeded policies are `OFF`. Publishing `BLOCK` fails unless the four persisted
readiness gates are true:

1. the activity writer is authoritative;
2. the player-level projection is complete;
3. clients can recover from a missing or stale level;
4. paid-flow recovery and reconciliation are ready.

No migration was executed and no runtime setting was changed by this checkpoint.

## Remaining work before production enforcement

- Validate, deploy and separately activate the default-off legacy Games/Node-RED bridge candidate;
  the live flow remains unchanged.
- Route the legacy onboarding UI to the trusted PadlHub assessment command. A fresh read-only
  server-147 audit confirms the current `/lk/onboarding/level` handler accepts client-computed
  level/numeric/provenance fields and therefore cannot safely be reused as proof.
- Add a transactional outbox/adapter if the trusted PadlHub assessment result must also be shown
  in Viva-backed legacy profile views.
- Migrate tournament and training registration writers; their current impact cards are
  intentionally marked unsupported.
- Define and migrate the activity personal-invitation creation/revocation command.
- Add scheduled reconciliation for provider-confirmed payments whose browser callback never
  reaches the default-off bridge.
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

The native game path, both recovery methods, policy control plane and isolated legacy bridge
candidate are implemented, but the candidate is not live and tournament/training writers, Viva
profile convergence and callback-loss reconciliation are not yet a single authoritative contour.
`OFF` is the only safe initial migration default.

## Continuation checkpoint: CUP projection sync (2026-08-19)

Implemented in isolation and still not activated:

- expand-only CUP projection inbox/revision fence plus append-only event-id ledger migration;
- strict server-only ingestion contract with a dedicated default-off token;
- server-side Viva identity and canonical-scale resolution;
- atomic profile, sport-level, ordering-fence and audit writes;
- safe replay/stale handling for coalesced full-snapshot revision jumps and conflicts;
- ownership fence that prevents self-declared/onboarding writes from replacing a CUP-authoritative
  level;
- targeted repository, route, config and contract tests plus an activation runbook.

The matching ph-ab branch contains the transactional sender outbox and bounded reconciliation for
existing canonical rating states. Neither branch has been committed, integrated, pushed, migrated,
deployed or enabled at this checkpoint.
