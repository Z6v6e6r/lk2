# Phone attestation and account linking

Status: design for review. Scope: how a PadlHub account acquires a **trusted** phone, and how two
accounts of one person are linked once that trust exists. No provider change is assumed: the Viva
integration exposes only the phone-OTP login today (a signed token with `phone_number_verified`), and
the OAuth path carries no phone claim for our client. Everything below therefore builds on the
attestation we already perform ourselves.

## Why

The CUP resolves a recipient by phone through two sources with different proof strength:

1. `profile.user_summaries.phone_e164` — a phone that a **phone login verified**. The identity
   provider's access token is checked against the realm JWKS and must carry
   `phone_number_verified === true`, so this value is server-attested. The resolver always prefers it.
2. `integration.external_entity_map` (`VIVA` / `legacy_viewer_phone`) — the phone the provider profile
   reported, relayed by our own client without server attestation. Fallback only.

An OAuth-only account (VK ID / Yandex) never obtains source 1, because the brokered token has no phone
claim. Such an account is reachable only through the client-relayed source 2 or by user id. When one
person owns two accounts — one that logged in by phone, one that actually has the app sessions and Web
Push endpoints — a phone campaign resolves to the account that cannot receive it. That happened in the
beta contour and is what this design removes, without asking the provider for anything.

A second invariant now exists in the schema: `profile.user_summaries (tenant_id, phone_e164)` is unique
(migration 0091), and `integration.external_entity_map` is already unique per
`(tenant_id, external_system, entity_type, external_id)`. In other words, **one phone can belong to one
account per tenant, and the only way to move it is a deliberate, audited operation** — which is exactly
what the flow below provides.

## Part 1 — Phone confirmation (the account proves a phone it already controls)

Today only a _login_ challenge can verify a phone, and verifying one creates or switches the session to
the account that the phone-login subject maps to. That is the wrong primitive for an already
authenticated user: it can silently move the operator (or the person) to another account instead of
attaching the phone to the account they are using.

### API

Two authenticated endpoints, deliberately separate from the login challenges so that verifying a code
can never change the session identity:

- `POST /user/api/v1/:tenantKey/profile/phone/challenges`
  body `{ phone }` → `202 { challengeId, expiresAt, phoneMasked }`
  - authenticated user; rate limited like `auth/challenges`; `Idempotency-Key` required;
  - the challenge is stored with `purpose = 'PHONE_CONFIRMATION'` **and** `userId`, so a challenge
    issued for one account cannot be verified for another (the login challenge has no owner).
- `POST /user/api/v1/:tenantKey/profile/phone/challenges/:challengeId/verify`
  body `{ code, acceptance? }` → `200 { phoneMasked, confirmedAt }`
  - verifies the code with the identity provider server-side (signed token, `phone_number_verified`);
  - **free phone** → writes `profile.user_summaries.phone_e164` on the authenticated account, writes an
    audit event (`PROFILE_PHONE_CONFIRMED`, source `LOGIN_ATTESTED`) and returns the masked phone;
  - **phone already bound to another account in the tenant** → no write; `409
PROFILE_PHONE_ALREADY_BOUND` with `{ candidateUserId? }` only when that account is reachable under
    the caller's own claims, and a hint that linking is required (Part 2). The unique index is the
    atomic guard: a concurrent claim surfaces as the same stable code, never as a raw `23505`.
  - **provider subject belongs to another account** → this is the interesting case: the person proved a
    phone that another account holds. Nothing moves automatically; the response reports the situation so
    Part 2 can link the accounts with that proof.

### Invariants

- Confirming a phone never creates, disables or merges an account, and never touches the session.
- The phone is never returned in full and never logged; only `phoneMasked` (`•••• 1234`).
- A challenge is single-use, expires (existing TTL policy) and is bound to `(tenant, user, phone)`.
- `PROFILE_PHONE_ALREADY_BOUND` is the same stable code the provider-profile sync path already returns
  when the unique index rejects a duplicate (`AUTH_PHONE_ALREADY_BOUND` for the login/sync path).

### Acceptance criteria

- After a phone confirmation, the CUP resolves that phone to **this** account and shows its channels.
- A second confirmation of the same phone by another account fails closed with
  `PROFILE_PHONE_ALREADY_BOUND` and leaves both accounts untouched.
- Confirming a phone that the account already holds is idempotent (no second audit event for the same
  value, no error).
- The phone-login flow, sessions, and the resolver keep their current behaviour.

## Part 2 — Account linking (two accounts of one person become one)

Proof: a completed phone confirmation (Part 1) is evidence that the caller controls a phone another
account claims. That is a human-verifiable claim, not an inference from the client-relayed value.

### Model

Expand-only schema additions:

- `identity.account_links (tenant_id, primary_user_id, secondary_user_id, reason, evidence, created_by,
created_at, status)` — append-only ledger of every link with its evidence;
- `identity.users.merged_into_user_id uuid null` — the canonical-account pointer reads use;
- a single resolver helper `resolveCanonicalUserId(tenantId, userId)` used by notification reads and the
  CUP so historical rows (intents, deliveries, inbox items) keep resolving after a merge.

### Semantics

- **Primary** is the account the person actually uses: the one that owns the attested phone and/or has
  app activity. The link operation takes the primary explicitly; nothing is inferred silently.
- Moves to the primary: `integration.notification_endpoints` (respecting the live-address unique index
  and the per-user quota), `notifications.user_preferences`, `integration.external_entity_map` and
  `integration.external_identity_map` (so future logins of the secondary's subjects land on the
  primary), and the secondary's attested phone when the primary has none.
- History is **not** rewritten: intents, deliveries and inbox items keep their original `user_id` and
  resolve through `merged_into_user_id`.
- The secondary becomes `DISABLED` with `merged_into_user_id = primary`; it is not deleted, so audit and
  history stay explainable.
- The operation is idempotent (same link replay returns the previous result), audited
  (`IDENTITY_ACCOUNT_LINKED`, with the evidence and the moved-row counts), and refuses cross-tenant
  pairs, cycles, disabled primaries and self-links.

### Command surface

- Operator (CUP): `POST /admin/api/v1/:tenantKey/identity/account-links` with a **dry-run** mode that
  reports what would move (endpoint counts per channel, preferences, provider links, phone move) and an
  execute mode that requires the dry-run token — so an operator sees the effect before changing
  identity. Permission `identity.accounts.link`, added to `ADMIN_ONLY_PERMISSIONS` in
  `packages/auth/src/index.ts` (admin-audience only, like `notifications.manage`), plus the existing CUP
  audience and `X-App-Platform: cup-admin`.
- Self-service: after a successful phone confirmation that hits `PROFILE_PHONE_ALREADY_BOUND`, the
  person may request the link ("это мой аккаунт"); it still needs the operator (or an explicit policy)
  to execute, because a phone alone is not proof of ownership of the _other_ account's history.

### Acceptance criteria

- After a link, a campaign addressed by the person's phone reaches the primary account's endpoints and
  the CUP preview shows one recipient.
- The secondary's endpoints/preferences/links exist on the primary; the live-address uniqueness holds
  (two identical endpoints collapse to one, never an error).
- Historical notifications of the secondary are still readable by the person after the merge.
- A replayed link command changes nothing and returns the same result; a link of the same pair in the
  opposite direction is refused once a direction exists.

## Risks and boundaries

- Identity and PII: R3/R4. Every write is audited, the phone is masked everywhere it is returned, and
  no automatic merge happens without an explicit primary and a recorded evidence.
- No provider dependency: only the existing signed-token attestation is used; the OAuth gap is closed
  by asking the person to confirm a phone once, not by waiting for a claim Viva does not send.
- Rollback: the link ledger plus `merged_into_user_id` make a link reversible in data terms (move rows
  back, clear the pointer, restore the secondary's status) — the reversal is coded and tested with the
  same command surface, because "merge" without a tested way back is not acceptable on identity.
- `schemas`/`phone_e164` uniqueness remains the hard guard: no flow above can create two accounts with
  the same verified phone.

## Delivery order

1. Part 1 (phone confirmation): challenge purpose, endpoints, audit, real-PG and route tests.
2. Part 2a (link model + canonical resolution + audited operator command with dry-run).
3. Part 2b (self-service request after a bound-phone confirmation).
