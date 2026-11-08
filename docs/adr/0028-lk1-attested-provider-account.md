# ADR 0028: LK1-attested Viva account and subscription mappings

- Status: proposed (design only; no implementation, migration or activation)
- Date: 2026-11-08
- Related: [ADR 0005](0005-viva-user-delegation-and-direct-transport.md),
  [ADR 0020](0020-client-assisted-booking-screen-snapshots.md),
  [ADR 0023](0023-browser-only-viva-end-user-transport.md),
  [ADR 0026](0026-delivery-lanes.md)
- Risk tier: CRITICAL (identity/provider mapping, subscription write-off inputs, new LK1 contract)

## Context

Commercial JOIN, quarter CREATE, training registration and the subscription runtime resolve the
actor's Viva identity through two `integration.external_entity_map` rows:

- `VIVA/viva_profile`: PadlHub user -> Viva `clientId`;
- `VIVA/subscription`: PadlHub subscription UUID -> Viva `clientSubscriptionId`.

A read-only check of lk2 on 2026-11-08 (`LOCAL` investigation over the `beta` lane database) found
**zero** rows of either type, while games, exercises and booking history are mapped by the thousands.

Why:

1. OTP login (ADR 0023) establishes identity from verified token claims. The Viva token carries
   `sub`, `azp`, `tenant_key` and the phone number, but no `clientId`, and the server performs no
   profile read. `ensureCanonicalProviderMapping` therefore never runs.
2. The only `subscription` mapping writer is `apps/worker/src/viva-home-repository.ts`, reached only
   through the retired `HOME_VIVA_SYNC_ENABLED` reader. The configuration rejects that flag.
3. `GameJoinSubscriptionPicker` reads subscriptions from `GET /home`. No Home projection is ever
   built (its `profile`/`upcoming`/`subscriptions` components came from the same retired reader),
   so `/home` returns `HOME_PROJECTION_NOT_READY` for every user.

As a result, no lk2 user can select a subscription, and the join-conditions context query
(`game-join-conditions-context-repository.ts`) can never return a row.

The browser can read `/profile` and `/subscriptions` (ADR 0020 transport), but PadlHub cannot
verify a relayed response: it is unsigned, and a modified client could claim another person's
`clientId`. `viva_profile` is also consumed as an authoritative identity by tournaments,
notifications, residency and the booking-screen mapper. A browser-asserted mapping would let one
user receive another user's PII and records there.

LK1 is the write owner of booked operations (see the commercial-acceptance runbook). Its Node-RED
already reads `/end-user/api/v1/{tenant}/profile`, `/subscriptions` and `/exercises` from LK1
egress with the actor's own Viva token. It compares `profile.id` with the delegated
`provider_client_id` before every v2 preflight. LK1 egress is not affected by the PadlHub egress
block described in ADR 0023.

## Decision

Mappings that downstream commands rely on are written **only from an LK1 owner attestation**. The
browser never supplies identity or subscription identifiers.

### Contract (LK1 v1, read-only)

`POST /lk/integrations/v1/provider-account-attestations` on the existing LK1 integration receiver.

- Headers:
  - `X-Subscription-Actor-Delegation`: an RS256 delegation JWT with the existing issuer, audience
    and key ring, but a new `typ` `phub-provider-account-attestation+jwt` and `action`
    `READ_PROVIDER_ACCOUNT`. The JWT carries `operation_id`, `correlation_id`, `tenant_key=iSkq6G`,
    the PadlHub `sub`/`sid`, `exp <= 60 s` and `actor_token_expires_at`;
  - `X-Subscription-Actor-Token`: the actor's short-lived Viva access token issued by
    `authService.issueVivaAccessToken`, which PadlHub already uses for JOIN.
- Body: `{ "contractVersion": 1, "operationId": "<uuid>" }`. It carries no client or subscription
  identifiers.
- LK1 verifies the signature, the `typ`/`action`, expiry and replay (it stores the operation id
  for its TTL). Then it calls Viva `profile` and `subscriptions` with the actor token and
  responds with:

```json
{
  "contractVersion": 1,
  "operationId": "<uuid>",
  "providerTenantKey": "iSkq6G",
  "providerClientId": "<viva client id>",
  "subscriptions": [
    {
      "clientSubscriptionId": "<id>",
      "productId": "<uuid|null>",
      "title": "<string<=120>",
      "state": "ACTIVE|PAUSED|FINISHED",
      "remainingUnits": 0,
      "validUntil": "<ISO|null>"
    }
  ],
  "attestedAt": "<ISO>"
}
```

- Bounds: at most 50 subscriptions, a 32 KiB body, `no-store`, and no phone, name or raw provider
  payload. Viva errors map to the closed codes `PROVIDER_ACCOUNT_UNAVAILABLE` (503),
  `PROVIDER_ACCOUNT_FORBIDDEN` (403) and `PROVIDER_ACCOUNT_INVALID` (409).
- LK1 makes no provider write, journal entry or reservation.

PadlHub calls LK1 server to server. This is not Viva End User traffic, so ADR 0023 is unchanged.

### PadlHub writer

A new API-owned service, `ProviderAccountAttestationService`, runs on login completion and on a
new `POST /user/api/v1/:tenantKey/profile/provider-account/refresh` (Idempotency-Key, rate-limited
to 1 per 60 s per session). It:

1. issues the delegation and actor token for the current session;
2. calls LK1 with a 5 s timeout, one retry on 503 only, and a circuit breaker (3 failures, 30 s);
3. validates the response strictly: exact keys, the same `operationId`, the tenant key and the
   bounds;
4. in one PostgreSQL transaction under `app.tenant_id`:
   - upserts `viva_profile` for the actor with `sync_status='synced'`. If the same `clientId` is
     already mapped to another active user, it **fails** with `PROVIDER_ACCOUNT_CONFLICT` and an
     audit event, and never moves the mapping;
   - upserts the `subscription` mappings and writes an attestation row to a new table
     `integration.provider_account_attestations (tenant_id, user_id, provider_client_id,
operation_id, attested_at, expires_at)` and `…_subscriptions (attestation_id,
subscription_internal_id, client_subscription_id, product_id, state, remaining_units,
valid_until)`. The migration is expand-only;
   - writes an outbox event `provider_account.attested.v1` without provider ids.

### Read surface

`GET /user/api/v1/:tenantKey/subscriptions/joinable` returns the actor's subscriptions from the
latest unexpired attestation (TTL 15 min): PadlHub UUID, title, state, remaining units and
`validUntil`. `GameJoinSubscriptionPicker` and the acceptance script switch from `/home` to it. An
expired or missing attestation returns `PROVIDER_ACCOUNT_REFRESH_REQUIRED`, and the client calls
`refresh` once. The response is never assembled from local, cached and Viva fields together.

### Actor binding

The join, CREATE and training context queries gain one join: the subscription must appear in the
actor's latest unexpired attestation. Today `external_entity_map` is not user-bound, so a known
UUID of another user's subscription would pass the PadlHub context; LK1 rejects it later. After
this change PadlHub rejects it first with the existing not-found outcome.

## Failure behavior

- LK1 unavailable or invalid: no mappings are written, the picker shows "Абонементы временно
  недоступны", and JOIN/CREATE with a subscription stays unavailable. There is no browser or server
  Viva fallback.
- `clientId` conflict: fail closed with an audit event. Support reconciles it by hand.
- Attestation expired: reads require a refresh. Commands keep their own LK1 re-verification, which
  stays authoritative.
- Rollback: disable the flag. The written mappings stay compatible because their shape is
  unchanged.

## Flag

`PROVIDER_ACCOUNT_ATTESTATION_ENABLED`:

- default `false`;
- owner: the product owner;
- purpose: lk2 commercial JOIN/CREATE acceptance;
- activation: LK1 attestation endpoint live, plus a signed smoke with one test account;
- removal: review 30 days after lk2 enters the production lane.

## Required evidence before activation

- **LK1:**
  - negative tests for a bad `typ`/`action`, an expired delegation, replay and a token for another
    tenant;
  - a Viva 401 maps to 403;
  - `profile.id` is returned only from the actor-token read;
  - no logging of the token or ids.
- **PadlHub:**
  - strict-parser negatives;
  - `clientId` conflict;
  - a cross-user subscription UUID is rejected by every context query;
  - TTL expiry;
  - a circuit-breaker and timeout partial-failure test;
  - migration apply and reapply on disposable PostgreSQL;
  - `npm run check`.
- **Review:** an identity/authorization specialist, plus a second independent perspective (R4,
  because identity and subscription write-offs are both touched).

## Alternatives rejected

- **Browser-relayed `profile`/`subscriptions` as the mapping source.** It is unverifiable and turns
  a modified client into an identity takeover of `viva_profile` consumers.
- **Re-enabling the server Viva reader.** ADR 0023 forbids it, and Viva blocks PadlHub egress.
- **A CUP runtime context.** No managed subscriptions are active in production CUP. It would also
  require the paused CUP custody lane and new secrets.

## Open questions

1. Is the exact Viva `subscriptions` response shape (fields for remaining units and validity) the
   same as the one LK1 `Route atomic subscription booking` already parses? Pin it with a redacted
   fixture.
2. Should Home Base gain a `subscriptions` section from the same attestation, so `/home` can be
   retired? (FAST follow-up; not required for JOIN.)
