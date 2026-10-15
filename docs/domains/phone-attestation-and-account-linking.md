# Phone attestation and account linking

Status: design for review. Scope: how an account acquires a **trusted** phone, and which account-linking
operations are safe on top of that trust. No provider change is assumed: the Viva integration exposes
only the phone-OTP login, and the OAuth path carries no phone claim for our client.

## Review outcome (what changed after the first review round)

An independent review rejected the first version of Part 2 and found nine blocking issues. They are
recorded here because they define the boundary of what may be built:

1. **A confirmed phone is not proof for taking over another account's history.** The OTP path proves
   current possession of the number (`phone_number_verified` on a JWKS-verified token), not that the
   confirmer is the person behind the account that already holds it. A recycled, shared or borrowed
   number would let its new holder absorb a victim's history. Account-linking therefore needs stronger
   evidence than Part 1 alone (dual authentication of both accounts, a cooling-off window, notification
   to the affected account's live channels), and the first version's "operator moves the rows" flow is
   withdrawn.
2. **Part 1 must resolve the provider subject first.** If the phone column is free but the subject
   returned by the code exchange already maps to another account, writing the phone to the caller
   creates a split brain: the CUP resolves by the new phone while a phone login still lands on the other
   account. The subject check runs before any write and fails closed.
3. **A forward-only canonical pointer does not preserve readability.** Reads filter `user_id = <caller>`
   in many places (`notifications.inbox_items` list/unread/mark-read, `user_read_state`,
   `booking.activity_history_projection`, the home snapshot, `eligibility.cup_player_level_projections`,
   `notifications.user_preferences`, `identity.refresh_sessions`), so "history is not rewritten" is
   false for every reader except the three tables the first version named.
4. **`integration.external_entity_map` cannot simply be re-pointed.** Besides the
   `(tenant, system, type, external_id)` key, migration 0042 created the partial unique index
   `external_entity_map_canonical_internal_idx` on `(tenant, system, type, internal_id)`, so both
   accounts' `viva_profile` rows cannot move to one owner; leaving the secondary's row lets provider
   login resolve to the disabled account.
5. **`integration.user_delegations` is not movable** (two unique keys, `on conflict … do update`, and a
   `subject <> $4` delete on every persist). A merge would either collide or leave a live Viva refresh
   credential on a disabled account. Part 1 must therefore **not** persist a delegation at all: doing so
   would delete the caller's existing one and contradict "confirmation never touches the session".
6. **Endpoints are revoked, not transferred.** The live-address owner index has no `user_id`, deliveries
   reference endpoints by foreign key, the per-user quota can overflow, and the projector selects
   endpoints by `user_id = recipientUserId`. The repository already documents the intended rule ("do not
   transfer a row: pending deliveries retain the original endpoint owner").
7. **The first version's rollback was not implementable**: deduplicated or revoked endpoints cannot be
   restored by moving rows, preference rows have no before-image, and the replaced delegation is deleted
   on write.
8. **New identity tables need RLS and a defined chain**: `enable` + `force row level security` with the
   `app.tenant_id` policy, plus explicit transitive-resolution and re-link rules. `DISABLED` alone does
   not contain already-issued access tokens, so revocation is part of the operation.
9. **CRITICAL command requirements were missing**: a durable idempotency record, a defined dry-run token
   (there is no precedent in the repository), a rate limit, observability, an expand/migrate/contract
   migration sequence, and the permission wiring beyond `ADMIN_ONLY_PERMISSIONS` (a hand-written route
   guard wired after `authenticateAdmin`, plus an operator grant path).

Consequently this document now has **Part 1 (build now)** and **Part 2 (data repair without merging)**;
the row-moving merge is deferred to a separate project, not designed here.

## Why a trusted phone matters

The CUP resolves a recipient by phone through two sources with different proof strength:

1. `profile.user_summaries.phone_e164` — server-attested: the identity provider's access token is
   verified against the realm JWKS and must carry `phone_number_verified === true`. The resolver always
   prefers it.
2. `integration.external_entity_map` (`VIVA` / `legacy_viewer_phone`) — relayed by our own client
   without server attestation. Fallback only.

An OAuth-only account (VK ID / Yandex) never obtains source 1, because the brokered token has no phone
claim. When one person owns two accounts — one that logged in by phone, one that holds the app sessions
and Web Push endpoints — a phone campaign resolves to the account that cannot receive it. That is the
beta case this work removes, without asking the provider for anything.

Both sources are unique per tenant (`profile.user_summaries (tenant_id, phone_e164)` since migration
0091, and `integration.external_entity_map` per `(tenant, system, type, external_id)`), so one phone
belongs to one account and moving it is always a deliberate operation.

## Part 1 — Phone confirmation (build now)

Confirmation attaches a phone the person demonstrably controls to the account they are using. It never
creates, disables or merges an account, never switches the session, and never persists a provider
delegation.

### API

- `POST /user/api/v1/:tenantKey/profile/phone/challenges`
  body `{ phone }` → `202 { challengeId, expiresAt, phoneMasked }`
- `POST /user/api/v1/:tenantKey/profile/phone/challenges/:challengeId/verify`
  body `{ code }` → `200 { phoneMasked, confirmedAt }`

Both are authenticated, rate limited, require `Idempotency-Key`, and reuse the login challenge store
with two added, **optional** fields:

- `purpose` (`LOGIN` default, `PHONE_CONFIRMATION`) and `userId`. Making `purpose` optional with a
  `LOGIN` default is what keeps in-flight login challenges valid across the deploy;
- the challenge id derivation must include `purpose` and `userId`, otherwise the two endpoints collide
  on a reused idempotency key;
- the resend cooldown key must include the purpose, because today it is `(tenant, sha256(phone))` and a
  fresh login OTP would block a confirmation request.

### Verify order (fail closed at every step)

1. The challenge exists, is unexpired, unused, belongs to the caller and to this tenant, and its
   purpose is `PHONE_CONFIRMATION`. Otherwise `AUTH_CODE_EXPIRED` / `INVALID_REQUEST` as today.
2. The code is verified server-side with the identity provider; a provider failure leaves the challenge
   usable (no consumption) and returns `AUTH_PROVIDER_UNAVAILABLE`.
3. **The provider subject from the code exchange is resolved to a PadlHub account first.** If it maps to
   a different account than the caller, the request stops with `AUTH_PHONE_ALREADY_BOUND` and no write —
   even when the phone column is free (blocking finding 2).
4. If another account already holds the phone in `profile.user_summaries` **or** as its
   `legacy_viewer_phone` provider value, the request stops with the same code and no write. The unique
   index is the atomic guard: a concurrent claim surfaces as the same stable code, never a raw `23505`.
5. Otherwise the phone is written on the caller's `profile.user_summaries.phone_e164`, with one audit
   event (`PROFILE_PHONE_CONFIRMED`, `source = LOGIN_ATTESTED`, the challenge id as evidence) and a
   masked response.

### Rules and failure modes

- Re-confirming the phone the account already holds is idempotent: no second audit event, no error.
- Confirming a **different** phone replaces the previous one only when no other account claims it, and
  the response says which masked number was released; the released number is never audited in full.
- A disabled caller is refused (`AUTH_USER_NOT_ACTIVE`); a cross-tenant challenge id is
  `INVALID_REQUEST`; a challenge owned by another user is refused with the same code as a missing one.
- The response never contains the full phone and never a candidate account id: an operator-only view may
  report which account holds the number, the self-service response may not (enumeration/PII).
- The existing `AUTH_PHONE_ALREADY_BOUND` code is reused for "this phone belongs to another account"; no
  second code is introduced for the same condition.
- Existing invariants that describe `phone_e164` as "a phone that a phone login verified" are updated
  with this change (the repository, the resolver and the migration header now say: verified by a
  phone-OTP exchange, not necessarily a login), and `docs/domains/profiles.md` plus
  `docs/domains/chats-and-notifications.md` are corrected in the same pull request.

### Tests

Challenge owned by another user; expired challenge; attempts exhausted; provider unavailable leaves the
challenge usable; concurrent verify has one winner; concurrent claim of the same phone by two accounts
returns the stable code, never a raw `23505`, and leaves both accounts untouched; caller already holds a
different phone (replacement plus audit); caller disabled; confirmation is idempotent and audits once;
the subject-elsewhere case performs no write; responses are masked and no phone reaches the logs; the
login flow, sessions and the resolver behave exactly as before.

## Part 2 — Data repair without merging (build now)

For the accounts the Step 1 report already flags, the repair the beta needed needs no schema: the person
confirms their phone on the account they actually use (Part 1), and the operator re-registers the Web
Push endpoints on that account with the existing supported operations (revoke on the old account,
register on the new one) instead of moving rows. That path reuses the endpoint repository's
revoke/register semantics, keeps the live-address invariant, leaves every delivery foreign key intact,
and needs no read-path change.

Operator guidance and the acceptance check:

- the report (`npm run identity:phone-anomalies:report`) lists the affected accounts;
- after the repair the report shows no "verified phone without an endpoint" / "provider phone without a
  verified phone" pair for that person, and the CUP preview resolves the phone to the account that holds
  the endpoints;
- the old account keeps its history; nothing is deleted and no row changes owner.

## Part 3 — Account merge (separate project, not designed here)

A true merge is possible but is a project of its own, and the review's findings are its requirements:
read-path expansion (or real row moves with collision rules) for every user-keyed table, endpoint
re-registration rather than transfer, delegation re-derivation, preference precedence with before-images,
RLS on new tables, transitive link semantics, revocation of the secondary's sessions, a durable
idempotency record, a defined dry-run token, observability, and a tested reversal. It needs dual
authentication of both accounts as its evidence, because a confirmed phone alone is not ownership proof.

## Delivery order

1. Part 1 (confirmation) with the tests above, plus the documentation corrections.
2. Part 2 (operator repair guidance; no code beyond what exists).
3. Part 3 only as a separately approved project with its own design and review.
