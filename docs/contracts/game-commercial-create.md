# Managed commercial CREATE (WARN contour)

Status: source-only. Default `OFF`. Activation of the managed contour requires
`GAME_COMMERCIAL_CREATE_ENABLED=true` in `local`, `ci` or `staging`; `production` is rejected
by configuration until a separate approval exists for the LK1 reserve/confirm/release
contract. This branch does not call LK1 or Viva, does not charge, does not book and adds no
migration.

## Problem

`POST /user/api/v1/{tenantKey}/games` answered every non-`NO_PAYMENT` create with
`409 GAME_PAYMENT_REQUIRED`. The public Create screen therefore cannot offer a paid game,
even though the games write owner already has a commercial create state (`PROVISIONING` game,
`PENDING` operation, `game.provisioning.requested.v1` fact). The managed CREATE contour turns
that existing state into a server-owned commercial flow instead of a blanket refusal.

## Modes

| Mode            | Selection               | Create result                                                                                                                                                 |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OFF` (default) | flag off                | byte-identical to today: `409 GAME_PAYMENT_REQUIRED` for every non-`NO_PAYMENT` mode                                                                          |
| `WARN`          | flag on, advisory owner | game aggregate is created in `PROVISIONING`; operation stays `UNKNOWN`; advisory quote is observed, never binding; no reservation, receipt, charge or booking |
| `ENFORCE`       | not available           | would call the LK1 reserve/confirm contract below; configuration rejects it before the approval                                                               |

`NO_PAYMENT` create is not routed through this contour in either mode; its request parsing,
request hash and result are unchanged.

## Decision D1 — draft game id, `expectedRevision = 1`

For CREATE there is no game row before the command, so the owner needs a stable target. LK2
derives, from verified claims only:

```text
draftGameId = UUIDv8(sha256('game-commercial-create:v1\0draft-game-id\0' + tenantId + '\0' + userId + '\0' + keySha256))
operationId = bookedOperationAdmissionId(tenantId, userId, keySha256)   // existing derivation
```

A retry with the same `Idempotency-Key` therefore names the same draft game, the same
operation and the same owner target; a retry can never mint a second game or a second
purchase. The local write owner accepts an optional `gameId`/`operationId` and inserts the
draft with its default revision `1`, in `PROVISIONING`, in the same transaction as its
existing idempotency, audit, outbox and `game.provisioning.advance.v1` facts.

Alternative considered and rejected for this slice: quote by station/court without a game id.
The frozen LK1 quote contract takes `target.kind=GAME` with an `id`; a station-scoped draft
would need a second target kind, a second delegation claim set and a second target resolution
path. D1 keeps one target kind and one delegation shape.

## Sequence (WARN)

1. verified session, tenant membership, `games.play` and `Idempotency-Key` (existing handlers);
2. request parsing validates the canonical `paymentMode` enum; `ORGANIZER_PAYS` is not part of
   the managed contour and is refused with `409 GAME_PAYMENT_MODE_MISMATCH`
   (managed refusal, no provider work) instead of the generic payment refusal;
3. server-owned advisory quote through the owner port. WARN uses an advisory owner: no
   provider ID, no price authority, no network call. The quote is recorded for observation and
   never changes the create result (a WARN quote refusal does not block the create);
4. when a quote is authoritative (`basis = OWNER`, only reachable after the LK1 approval), the
   caller must echo exactly `{amountMinor, currency}` of a non-expired quote, otherwise
   `409 GAME_PRICE_CONFIRMATION_REQUIRED`; `SERVICE_BLOCKED` /
   `SUBSCRIPTION_SELECTION_REQUIRED` become their existing stable refusals;
5. local write owner under its existing per-principal advisory lock and idempotency row:
   `PROVISIONING` game + `PENDING` operation + `game.provisioning.requested.v1`, plus the
   organizer's own `ORGANIZER/ACTIVE/NOT_REQUIRED` participation row that every create writes;
   no player participation, no reservation and no card projection;
6. owner execution: WARN advisory owner reports `SKIPPED_ADVISORY`; it never reserves,
   confirms, releases or returns a receipt. A real transport answers `PENDING` / `UNKNOWN` /
   `REJECTED` only;
7. response: `202` with `operation.type = CREATE_GAME`, `status = UNKNOWN`,
   `nextAction = WAIT_FOR_RECONCILIATION`, `commercial.attemptState = WARN_OBSERVED`, the
   observed advisory quote and `gameId`; `SUCCEEDED`/`FAILED` are never reported by WARN.

A repeat with the same key replays the local idempotency row and returns the same
`commandId`/`gameId` with `replayed = true`; it never sends a second owner request.

The public operation view reuses the existing `GameOperationCommercial` shape. This release adds
the nullable `commercial.quote` observation, the `WARN_OBSERVED` attempt state and the existing
`UNKNOWN` + `WAIT_FOR_RECONCILIATION` next action. A trusted receipt is exposed only as
`{provider: 'VIVA', status: 'CONFIRMED', confirmedAt}`; the LK1 receipt identity fields
(`receiptId`, `appliedRule`, `usageRef`, `bookingRef`) stay inside the owner transport and never
reach a client.

## Unknown recovery

`GET /user/api/v1/{tenantKey}/game-operations/{operationId}` reports a still-provisioning paid
create as `UNKNOWN` with `WAIT_FOR_RECONCILIATION`, never `FAILED` and never a new POST. The
commercial attempt keeps the existing `PENDING` local operation; no writer deletes, cancels or
compensates it in WARN. A trusted receipt (`confirm` below) is the only future path to
`SUCCEEDED`; an owner HTTP 200 or booking id is not financial success.

## LK2 -> LK1 contract (frozen here, mandatory before ENFORCE)

All calls are server-to-server with an RS256, audience-bound, single-use actor delegation
issued by the existing `SubscriptionRuntimeActorDelegationIssuer` (same recipient/tenant/
request-sha/idempotency-sha binding as the existing booked-operation delegation), bounded
timeout, no automatic write retry, a bounded circuit breaker and redacted metrics
(outcome/duration/status class only).

Admission target for CREATE (the existing booked-operation admission request extended to the
second action, no other field changes):

```json
{
  "action": "CREATE_GAME",
  "target": { "id": "<draftGameId uuid>", "expectedRevision": 1 },
  "paymentIntent": "USE_SUBSCRIPTION"
}
```

`POST /api/internal/subscription-runtime/lk2/v1/reserve`

```json
{ "operationId": "uuid", "action": "CREATE_GAME",
  "target": { "kind": "GAME", "id": "uuid", "expectedRevision": 1 },
  "paymentMode": "SPLIT|SUBSCRIPTION", "paymentIntent": "USE_SUBSCRIPTION",
  "preferredSubscriptionInstanceId": "uuid|null",
  "priceSnapshot": { "amountMinor": 0, "currency": "RUB" } | null }
```

response `{ reservationId, expiresAt, policyVersion, priceSnapshot }`, or a typed refusal
(`{ reason: "<code>" }`) / conflict (409) / unavailable (503). A lost response is recovered
only by repeating the same `operationId` + `Idempotency-Key`.

`POST /api/internal/subscription-runtime/lk2/v1/confirm` ->
`{ receiptId, confirmedAt, appliedRule, usageRef, bookingRef }` — the trusted receipt.

`POST /api/internal/subscription-runtime/lk2/v1/release` and `.../compensate` — idempotent
rollback of a reservation by `reservationId`/`operationId`; used only by recovery, never as an
automatic retry of a write.

The LK1 receiver for CREATE is not implemented in this branch. The LK2 admission route accepts
and validates `CREATE_GAME` targets but answers `503
BOOKED_OPERATION_CREATE_ADMISSION_UNAVAILABLE` instead of minting a delegation for an
unimplemented receiver.

## Local persistence (no migration)

WARN reuses `games.command_idempotency`, `games.operations`, `games.games` and
`game.provisioning.requested.v1`. No policy, balance, counter or second usage ledger is stored
in LK2. Nothing in the WARN path advances `PROVISIONING` to `SCHEDULED`; that transition and
the receipt binding are the future ENFORCE slice.

## Known limits of this slice

- The authoritative quote is evaluated before the local idempotency replay. In WARN the quote has no
  authority, so a repeat always returns the same operational result; the future ENFORCE slice must
  decide the repeat ordering explicitly (replay before a price re-evaluation) before it can refuse a
  repeat on a changed price.
- The public booked-operation admission endpoint (`POST /user/api/v1/{tenantKey}/booked-operation-admissions`)
  now parses and resolves `CREATE_GAME` drafts but fails closed with
  `503 BOOKED_OPERATION_CREATE_ADMISSION_UNAVAILABLE`; it mints no delegation and calls no owner.
  The route is not composed in production runtime configuration in this release.
- `game.provisioning.advance.v1` still has no consumer, so a WARN-created game stays in
  `PROVISIONING` (not card-visible, not joinable) until the ENFORCE slice advances or cancels it.

## Review outcomes and operational notes

- The public observation is response-scoped: the first accepted response carries
  `attemptState = WARN_OBSERVED` and the advisory quote, a same-key repeat and the readback carry
  `attemptState = UNKNOWN` with `quote = null`. Operational ids/status stay identical; a future UI
  must not key its state on the advisory observation.
- JOIN and CREATE share the `bookedOperationAdmissionId(tenant, user, keySha)` operation identity.
  A request key can only name one local command (`games.command_idempotency`), so a second action
  with the same key is a local `409` before any write. The ENFORCE slice must decide whether to add
  the action to the derivation or to reject cross-action key reuse at the admission receiver.
- The owner `subscriptionInstanceId` selection is only shape-validated here; ownership and
  eligibility must be resolved by the owner/LK1 (as paid JOIN already does) before ENFORCE. WARN
  never sends it anywhere.
- A WARN create leaves a `PROVISIONING` game, a `PENDING` operation and a queued
  `game.provisioning.advance.v1` with no consumer. This is intentional for the WARN slice, but an
  operator attention query is required before enabling the flag on a shared staging environment:
  `select count(*) from games.games where lifecycle_state='PROVISIONING' and payment_mode in
('SPLIT','SUBSCRIPTION');` plus the matching `games.operations` rows in `PENDING`/`RUNNING`.
- Readback treats any operation state other than a trusted-receipt completion (`PENDING`,
  `RUNNING`) as `UNKNOWN`; only a trusted receipt may ever produce `SUCCEEDED`.
- When the contour is disabled, the two new request fields are not accepted (the old strict body
  allowlist applies, so a paid request still gets `409 GAME_PAYMENT_REQUIRED`, while a request
  carrying a managed-only field gets `400 INVALID_REQUEST`). Clients must only send them when the
  managed contour is enabled.
- Owner failures after the durable local write are observability-only in WARN; the future ENFORCE
  slice must reconcile or release that reservation instead of replaying it as success.

## Staging WARN acceptance plan (requires separate deploy/staging authority)

This plan is preparation only. It grants no deploy, migration, activation, credential or live-write
authority; none of these steps has been executed by the A1/A2 task branches.

Preconditions (all verified through the existing beta/staging delivery runbook, never a new one):

1. Source: the reviewed A1 head (server) and A2 head (Web) after their PRs merge; record the exact
   SHA and, for any image-based lane, the immutable digest.
2. Configuration on the target: `GAMES_READ_ENABLED=true`, `GAMES_COMMANDS_ENABLED=true`,
   `GAME_COMMERCIAL_CREATE_ENABLED=true`, `GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT=ADVISORY`
   (default), `GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS` untouched (3000).
   `BOOKED_OPERATION` must make config load fail, and `APP_ENV=production` must make load fail.
   No `GAME_COMMERCIAL_CREATE_OWNER_BASE_URL` is needed for the advisory transport.
3. Fixtures: synthetic tenant/user/station/court only. No real member data, no provider account.
4. A disposable/pre-approved staging database with the existing schema; this slice adds no migration.

Acceptance matrix (record request, correlation id, operation id, game id and DB readback per case):

| #   | Case                                      | Expected                                                                                                                                                                                                                           |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Flag OFF (or absent)                      | `POST /games` paid body -> `409 GAME_PAYMENT_REQUIRED`, same message as before; free create still `202`; no new `PROVISIONING` row                                                                                                 |
| 2   | WARN `SPLIT` and `SUBSCRIPTION` create    | `202` `CREATE_GAME`, `status=UNKNOWN`, `nextAction=WAIT_FOR_RECONCILIATION`, `commercial.attemptState=WARN_OBSERVED`, `gameId` returned                                                                                            |
| 3   | Local write readback                      | `games.games` row `lifecycle_state=PROVISIONING`, `revision=1`; `games.operations` `kind=CREATE_GAME`, `state=PENDING`, `completed_at IS NULL`; `games.command_idempotency` `COMPLETED`; one `game.provisioning.advance.v1` queued |
| 4   | No booking/charge/provider effect         | no `games.seat_reservations` row, no `games.card_projections` row, no `game.published.v1`, no provider/Viva/LK1 call (owner is advisory), no receipt in the response                                                               |
| 5   | Repeat with the same key and body         | same `commandId`/`gameId`, `replayed=true`, no second game/operation/command row                                                                                                                                                   |
| 6   | Repeat with the same key and changed body | `409 GAME_COMMERCIAL_ATTEMPT_CONFLICT`, no second write                                                                                                                                                                            |
| 7   | Operation readback                        | `GET /game-operations/{id}` -> `UNKNOWN` + `WAIT_FOR_RECONCILIATION`; never `FAILED`/`SUCCEEDED`; another user gets `404`                                                                                                          |
| 8   | Unsupported mode                          | `ORGANIZER_PAYS` -> `409 GAME_PAYMENT_MODE_MISMATCH`; malformed managed fields -> `400 INVALID_REQUEST`                                                                                                                            |
| 9   | CREATE admission fail-closed              | own draft -> `503 BOOKED_OPERATION_CREATE_ADMISSION_UNAVAILABLE`, no delegation minted, owner untouched; foreign/non-organizer draft -> `409`                                                                                      |
| 10  | Web (optional, beta Web only)             | `/games/new?commercialCreate=1` offers paid modes; submit shows the pending panel; reload restores it; "Проверить статус" performs readback; `/games/new` without the intent is unchanged                                          |

Operator attention (read-only) while WARN is enabled: count/list `PROVISIONING` paid drafts and their
`PENDING`/`RUNNING` operations, and confirm they have no reservation/projection rows. WARN has no
consumer of `game.provisioning.advance.v1`, so these drafts stay until the ENFORCE slice; do not
delete or advance them manually without a separate approved cleanup decision.

Rollback: set `GAME_COMMERCIAL_CREATE_ENABLED=false` and redeploy the reviewed image; paid create
returns to the `409 GAME_PAYMENT_REQUIRED` path, existing WARN drafts are left untouched. Code
rollback does not reverse any reservation, payment or provider state (none exists in WARN).

Evidence to attach: environment, exact source SHA/digest, flag state, per-case request/response
(no tokens, no PII), redacted DB readbacks, the operator query output, CI run id, reviewer names.

Not proven by this plan: ENFORCE, LK1 reserve/confirm/release, real price/charge/booking, price
echo against an authoritative quote, production readiness, capacity/roster effects.

## LK1 handoff checklist (mandatory before ENFORCE)

The LK1 implementation of the frozen contract must provide, and LK2 will verify against it in a
separate approved slice:

- `POST /api/internal/subscription-runtime/lk2/v1/reserve` with the exact request/response shapes in
  the section above; idempotent by `operationId` + `Idempotency-Key`, explicit 409 conflict and 503
  unavailable semantics, typed refusal body `{reason:<stable code>}` restricted to the documented
  managed failure codes.
- `.../confirm` returning the trusted receipt `{receiptId, confirmedAt, appliedRule, usageRef,
bookingRef}`; LK2 exposes only `{provider:'VIVA', status:'CONFIRMED', confirmedAt}` publicly.
- `.../release` and `.../compensate` idempotent by `reservationId`/`operationId`, safe to repeat,
  never used as an automatic retry of a write.
- Receiver replay protection for the single-use RS256 delegation (same binding set as the existing
  quote/booked-operation delegation: recipient, tenant, request sha, correlation id, key sha, JTI).
- Ownership/eligibility resolution for the selected `subscriptionInstanceId`; a foreign selection is
  a typed refusal, never a charge against another member's entitlement.
- Provider identity for a CREATE draft: the reserve/confirm contract must not require a Viva
  exercise mapping for the draft before the owner creates it; the confirm receipt names the created
  booking reference.

LK2 obligations once LK1 exists: wire the booked-operation transport behind a new explicit approval,
add the `confirm`/`release` orchestration (reconcile `UNKNOWN`, never FAILED), extend the admission
delegation claims with the action (or reject cross-action key reuse at the receiver), decide the
`PENDING`→`SCHEDULED` transition and a bounded cleanup/compensation path for abandoned drafts.

## Verification and non-goals

A dedicated PostgreSQL verifier (`apps/api/src/games/game-commercial-create-warn-postgres.test.ts`,
enabled only with an explicitly supplied query-free loopback `*_verify`
`GAME_COMMERCIAL_CREATE_TEST_DATABASE_URL`) executes the composed HTTP boundary against a disposable
schema: it proves the `PROVISIONING` draft, the `PENDING` create operation with `completed_at` null,
the single `game.provisioning.advance.v1` command, the organizer-only participation, zero
reservations/card projections, the `game.created.v1` + `game.provisioning.requested.v1` outbox facts
with no publish, idempotent same-key replay with no duplicate rows, the changed-body conflict, the
actor-scoped `UNKNOWN` readback and the organizer/tenant/revision scoping of the draft target. It was
run LOCAL against a disposable `postgres:16-alpine` database with the full migration chain; the
existing lifecycle PostgreSQL verifier also passed on the same database. CI skips it by default
because it requires that explicitly supplied disposable database URL.

Focused LOCAL tests cover: advisory WARN create (game created, no booking, no receipt, owner
never called), authoritative price echo mismatch/expiry, managed mode refusal, idempotent
repeat, writer rejection mapping, owner `PENDING`/`UNKNOWN`/`REJECTED`, quote failure
observation, admission `CREATE_GAME` parsing, draft target resolution and the route matrix.
`OFF` behavior is covered by the pre-existing 409 tests.

Non-goals: real LK1/Viva calls, ENFORCE, price/commission changes, removal of the existing
`GAME_PAYMENT_REQUIRED` path, Web create UI (separate A2 sub-branch), migrations, production
activation.
