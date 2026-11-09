# ADR 0029: LK2 transition ownership — LK1 owner for games, Viva Admin reads for profile

- Status: Proposed (owner direction 2026-11-09; becomes accepted on owner approval in the PR)
- Date: 2026-11-09
- Amends: [ADR 0010](0010-games-domain-and-card-state-model.md),
  [ADR 0016](0016-lk-games-migration-and-viva-roster-association.md),
  [ADR 0023](0023-browser-only-viva-end-user-transport.md)
- Builds on: [ADR 0002](0002-viva-boundary.md), [ADR 0019](0019-home-base-and-viva-egress-gate.md),
  [ADR 0027](0027-client-residency-read.md)
- Supersedes as primary mapping source: ADR 0028 (LK1-attested provider account, PR #611, proposed) — see D5

## Context

LK2 must reach users before Viva is replaced. Today the data needed by LK2 lives in three places:

| Data                                                     | Where it lives today  |
| -------------------------------------------------------- | --------------------- |
| Schedule, player profile, bookings, subscriptions        | Viva                  |
| Custom tournament cards, open-game cards                 | LK1 + CUP (LK1 store) |
| Subscription usage rules, level/eligibility restrictions | LK1 + CUP (LK1 owner) |

Constraints confirmed by the owner and by Gate 0 evidence in ADR 0019:

1. Viva rejects End User API traffic from PadlHub server/worker egress and may block such
   addresses. ADR 0023 already forbids `/end-user/api/...` from API and worker processes.
2. LK2 cannot obtain Viva user data by proxying through LK1 (LK1 reads it in the user's browser).
3. The browser-direct reads of ADR 0023 keep LK2 dependent on browser CORS, on a delegated Viva
   token in the client and on per-platform native exceptions (Android `MY_BOOKINGS`,
   `profile.read`), and give PadlHub no control over provider load.

Current code already contains the building blocks this ADR relies on:

- the LK1 owner integration at `https://padlhub.su`:
  `/api/internal/subscription-runtime/lk2/v1/{quote,reserve,confirm,release}`,
  `/api/internal/subscriptions/policy-registry`, `/api/internal/tournaments/local-operations`,
  `/api/internal/tournaments/owner-preparations`, `/api/internal/lk/identity/verify`, and the game
  owner commands `/lk/integrations/v1/game-create-{preparations,operations/admissions}` (quarter
  CREATE), `/lk/integrations/v2/booked-operation-{preflights,admissions}` (managed JOIN) and
  `/lk/integrations/v1/managed-self-leave-admissions` (self-leave);
  LK2 authorizes those calls with its own short-lived RS256 actor delegation, not a Viva token;
- server-side Viva **Admin** reads with the system key: client subscriptions (ADR 0027) and the
  CUP client-record reads of PR #623 (`profile`, `summary`, `subscriptions`, `bookings`,
  `transactions`, GET only);
- the synced `integration.external_entity_map` `VIVA/viva_profile` mapping as the only source of a
  user's Viva client ID.

Current open-game command paths (source on `main`, 2026-11-09):

| Command | Free game (`NO_PAYMENT`)                     | Paid game (`SPLIT`/`SUBSCRIPTION`)                                                                                                     |
| ------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CREATE  | LK2 PostgreSQL only; LK1 never sees the game | quarter CREATE: LK1 owner creates and books; LK2 keeps only a journal; the game reaches LK2 through the legacy importer (default off)  |
| JOIN    | LK2 PostgreSQL roster only                   | LK2 reserves the seat locally, LK1 owner preflights/admits the booking and write-off; only for imported `MIRROR` games (`WARN` on lk2) |
| LEAVE   | LK2 PostgreSQL roster only                   | managed self-leave through the LK1 owner                                                                                               |
| CANCEL  | organizer cancel in LK2 PostgreSQL only      | refused with `GAME_PAYMENT_REQUIRED`; no owner path                                                                                    |

A local LK2 command on an imported `MIRROR` game moves its roster sync to `CONFLICT`
(`LEGACY_GAME_ROSTER_LOCAL_REVISION_CHANGED`): from then on LK1 and LK2 show different rosters.
Paid commands also depend on `VIVA/viva_profile` and `VIVA/subscription` mappings, of which lk2 has
none (ADR 0028 context).

The open question is which system owns each write during the transition, so that the apps are not
rebuilt again when the backend implementation changes.

## Decision

### D1. One executor per write; LK1 owner stays the executor for games and tournaments

For existing tournaments and open games, LK2 uses **the same operations as LK1**, executed by the
LK1 owner and reached only through the PadlHub API and a server-side adapter. LK2 clients never
call LK1 or Viva directly.

- Game/tournament create, join, leave, waitlist and cancel have exactly one executor: the LK1
  owner. LK2 does not copy LK1 logic and does not write LK1 documents itself.
- Subscription usage rules, daily limits and level restrictions are decided only by the existing
  LK1 owner contour (`subscription-runtime`, `policy-registry`) together with the LK2 join-condition
  read. The Viva Admin key is never used to bypass that contour.
- Viva booking and subscription write-off remain performed by the LK1 owner. **LK2 API and worker
  send no Viva `POST`/`PATCH`/`DELETE`.**
- A game or tournament created from LK2 is the same object LK1 shows. Its PadlHub UUID is mapped to
  the LK1 identifier in `integration.external_entity_map`; LK1/Viva identifiers never appear in a
  client DTO.
- Every LK2 command keeps `Idempotency-Key`, a durable attempt row and `UNKNOWN`-until-receipt
  recovery (as in the commercial JOIN and quarter-create contracts). Because LK1 and LK2 users can
  press the same button with different keys, the executor additionally enforces at most one active
  participation per `(game, user)` and an atomic capacity check-and-reserve.

Paid commands already follow this rule. The gap is the free path and CANCEL: free CREATE, JOIN,
LEAVE and organizer CANCEL must move behind the same LK1 owner (new owner operations for
`NO_PAYMENT`, or the existing ones with a zero-price mode), and a local LK2 roster write on a
`MIRROR` game is refused instead of splitting the roster.

This amends ADR 0010/0016 for the transition: `games.*` stays `LOCAL_PRIMARY` at the PadlHub
platform level (LK1 is a PadlHub system, not a provider), but the executor of record is the LK1
owner. LK2 PostgreSQL game rows are a projection/operation journal, not a second writer. The
`MIRROR` import of ADR 0016 remains read-only.

### D2. Viva user data is read server-side through Viva Admin methods only

Profile, bookings and subscriptions shown to the user in LK2 are read by `@phub/viva-adapter` with
the server system key through Viva **Admin** methods (the source used by ADR 0027 and PR #623).

- `/end-user/api/...` from API and worker stays forbidden (ADR 0023 unchanged on this point).
- The Viva client ID comes only from the synced `viva_profile` mapping of the authenticated user;
  no request field selects it. A row naming a different client fails closed.
- Two consumers of one adapter source, with separate authorization and projections:
  - CUP operator view (PR #623): no names/phones/emails/provider IDs;
  - user self view: the authenticated user's own data, normalized to PadlHub DTOs.
- Reads land in local projections. Screens read projections; they do not trigger a provider call
  per render. Each section records `observedAt` and sync state; a failed refresh keeps the last
  known value and never turns into "no subscription", zero debt or a new user.
- Displayed balance/visits remain `VIVA_PRIMARY` presentation values. The executor in D1 makes the
  final booking/write-off decision; a projection is never an entitlement.

The browser-direct reads and native exceptions of ADR 0023 are superseded per operation once the
matching server Admin read is accepted at PROVIDER level, and then retired. Until then they stay
as they are; this ADR does not enable a server fallback to End User.

### D3. Schedule stays in Viva and is read as shared data

The schedule is read through Viva Admin methods into one shared projection per station and period,
not per viewer. Personal prices, limits and subscription availability never enter that shared
cache. Moving schedule ownership to CUP is a separate later decision.

### D4. Shared provider budget

All server Viva traffic (API, worker, CUP refresh) passes one Redis-backed limiter shared across
replicas, with priority: user command follow-ups and reconciliation > user-visible reads >
background refresh and history. Identical concurrent reads are coalesced by
`(tenant, user, section, filters, page)`. `429` honours `Retry-After`; retries use jittered backoff
from one shared retry budget; `401/403` stop and alert instead of retrying. Background refresh
covers active users only and never re-downloads full history.

### D5. Viva account mapping from a server Admin lookup by verified phone

Owner decision 2026-11-09: the `VIVA/viva_profile` mapping is written from a server-side Viva Admin
lookup by the OTP-verified phone. Every paid command and every D2 read needs this mapping, which
lk2 does not have today. This supersedes the LK1 owner attestation of ADR 0028 (PR #611) as the
primary mapping source; ADR 0028 was written before Admin API access was confirmed.

- Trigger: a successful OTP login (ADR 0023) whose signed Viva token carries
  `phone_number_verified=true` and a normalized E.164 phone equal to the challenged phone. The
  phone is taken only from that verified token, never from a request body or the browser.
- Lookup: `@phub/viva-adapter` queries Viva clients by that exact phone through an Admin method,
  within the D4 budget, with timeout, bounded retry and circuit breaker. The exact Admin method
  and its phone-matching semantics are pinned with a redacted fixture before implementation
  (PROVIDER check).
- Write: only when exactly one active client matches. The mapping is written through the existing
  `ensureCanonicalProviderMapping` path in the login transaction or an idempotent follow-up job,
  bound to `(tenant, PadlHub user)`.
- Fail closed: zero matches leaves the user unmapped (paid commands and Viva reads unavailable);
  several matches go to audited support reconciliation. A later lookup that returns a different
  client for an already mapped user is a `clientId` conflict that blocks paid commands; it is never
  an overwrite.
- Phone change in Viva or PadlHub does not move an existing mapping automatically.
- Subscription mappings (`VIVA/subscription`) are written by the same server read of the mapped
  client's subscriptions (the ADR 0027 Admin source), bound to that user.
- Audit: each mapping write, refusal and conflict is an audit event without phone or provider IDs
  in logs.

The LK1 attestation of ADR 0028 is not on the critical path; it may be kept as a later recovery
path for ambiguous phones. This is a CRITICAL identity change: R4 review (identity/authorization
and data integrity), negative tests for zero/many/changed matches, unverified phone and cross-user
subscription IDs.

### D6. Authentication is unchanged by this ADR

OTP and OAuth token exchange through Viva Keycloak and server-side token verification stay as in
ADR 0023. Retiring the delegated browser token is a follow-up identity decision (CRITICAL) once no
client read depends on it.

## Preconditions

1. Viva consent to server Admin reads — **confirmed by the owner on 2026-11-09** (owner statement;
   the written agreement and quota should be linked here when available).
2. `VIVA_API_KEY` authorized for the Admin methods used, including `bookings` and v2
   `transactions` — **confirmed by the owner on 2026-11-09**; a PROVIDER readback on the test
   stand is still required before traffic moves.
3. LK1 owner operations for free (`NO_PAYMENT`) create/join/leave and for organizer cancel of any
   game, with the same delegation, idempotency and receipt model as the existing paid ones.
4. The D5 Admin lookup is implemented; its Viva Admin search method is confirmed on the stand.

## Alternatives rejected

- **LK2 browser calls Viva End User API like LK1** — violates "clients call only PadlHub APIs",
  gives no load or rule control, and needs per-platform exceptions. Kept only as the existing
  ADR 0023 path until D2 replaces it.
- **Server End User calls with stored user tokens** — blocked by Viva; forbidden by ADR 0023.
- **LK2 copies LK1 game logic and writes the same store** — two writers with identical code today
  diverge tomorrow; violates single write owner.
- **LK2 sends Viva writes with the Admin key on the user's behalf** — moves entitlement and payment
  authority to a new path without Viva's check; would duplicate the LK1 owner.

## Consequences

- LK2 release no longer waits for Viva replacement: create/join/leave work across LK1 and LK2 with
  one roster, one restriction decision and one write-off.
- The system key becomes a single point of failure and of provider attention; D4 and the Viva
  agreement are mandatory, not optional tuning.
- LK1 backend work (precondition 3) and the mapping (D5) are on the LK2 critical path; the paid
  owner commands already exist.
- Each D1 command path and the user self-read of D2 are CRITICAL boundaries (booking/roster,
  PII/identity) and keep their gates; this ADR authorizes no flag flip, provider write or deploy.

## Acceptance

- End-to-end on the test stand: create in LK2 → visible in LK1 → join from LK1 → roster in LK2 →
  leave → exactly one correct restoration of the entitlement.
- Race: LK1 and LK2 compete for the last seat and the last subscription visit; exactly one wins,
  the other gets a stable refusal.
- Provider readback: zero `/end-user/api/` requests from API/worker; Viva Admin request rate stays
  within the agreed quota under the stand load.
