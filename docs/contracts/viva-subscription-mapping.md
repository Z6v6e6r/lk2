# Viva subscription mappings from an Admin read of the mapped client

Status: implemented, default off (`VIVA_SUBSCRIPTION_MAPPING_SYNC_ENABLED=false`). Decision: ADR
0029 D5. Owner boundary: `@phub/viva-adapter` `VivaClientSubscriptionMappingSource` +
`@phub/database/viva-subscription-mapping` `recordVivaSubscriptionMappings`, composed by
`apps/api/src/subscriptions/viva-subscription-mapping-sync.ts` and invoked by
`AuthService.verifyPhoneChallenge` right after the profile link
([viva-profile-phone-link](viva-profile-phone-link.md)).

## Why

Paid JOIN by subscription, training registration and quarter creation resolve the selected
subscription through a synced `VIVA/subscription` row in `integration.external_entity_map`. On lk2
nothing writes those rows for an OTP user, and the table has no owner column, so a row alone says
nothing about whose subscription it is.

## Flow

1. A Viva OTP login succeeds and the profile step ends as `linked`, `unchanged`, `already_mapped`
   or is disabled. Any other profile outcome (`not_found`, `ambiguous`, conflicts, `unavailable`)
   skips the sync (`skipped_profile_link`).
2. The server reads the user's single synced `VIVA/viva_profile` mapping. No mapping, more than one
   row or a non-UUID client id -> `unmapped`, no provider call. The client never supplies an id.
3. `GET /api/v1/clients/{clientId}/subscriptions?includeFinished=true&page=N&size=200` with the
   Admin key (the ADR 0027 source; never `/end-user/api/`, ADR 0023). At most 5 pages. The read is
   all-or-nothing:
   - an instance naming another client (`clientId` / `client.id`) -> `OWNERSHIP_CONFLICT`, the whole
     read is refused;
   - a non-UUID or duplicate id, a wrong page number, a non-JSON body -> `RESPONSE_INVALID`;
   - a `total` that does not match the rows read, or more pages than the budget -> `PARTIAL`.
     Only `NEW`, `ACTIVE` and `HOLD` instances are mapped; finished and unknown statuses are skipped
     (safe because nothing is ever unmapped).
4. One transaction under the canonical provider-client advisory lock (shared with
   `upsertExternalUser` and the phone link) re-checks that the same profile mapping is still the
   user's only synced one and that no other user maps the client; otherwise `profile_changed` and
   nothing is written.
5. Per instance:
   - no mapping -> insert a row in the Home worker format: `external_id` as Viva returned it,
     generated `internal_id`, `external_version` and `last_synced_at` = read time, `synced`, no
     error code;
   - an existing mapping -> its `internal_id` never changes (the picker and JOIN hold it); freshness
     only moves forward;
   - the owner binding in `integration.viva_subscription_owners` (migration 0117) is created or its
     `last_observed_at` advanced;
   - a binding to another user or another profile mapping -> conflict: nothing is changed for that
     instance, audit `VIVA_SUBSCRIPTION_MAPPING_OWNER_CONFLICT` (`DENIED`).
6. Audit `VIVA_SUBSCRIPTION_MAPPINGS_SYNCED` (`SUCCESS`, or `PARTIAL` with conflicts) carries counts
   only.

## Fail-closed rules

- A failed, partial or refused read writes nothing. An instance missing from a later read keeps its
  mapping and binding: this path never deletes and never marks a subscription absent.
- A binding is never moved between users or profile mappings by this path.
- Logs, metrics and audit rows carry outcome labels and counts only: no phone, provider ids or
  payloads. The owner table stores PadlHub ids only.
- The login never fails and waits at most 2.5 s for the sync; a slower sync finishes on its own.
- Provider budget (ADR 0029 D4): one read per OTP login, timeout <= 2 s, at most 2 attempts and only
  on 408/429/5xx (`Retry-After` capped at 1 s), no polling. The circuit breaker (3 failures / 60 s)
  counts transport, retryable and 401/403 failures only, so one client's 404 or malformed answer
  does not stop the sync for other users.

## Configuration and rollback

`VIVA_SUBSCRIPTION_MAPPING_SYNC_ENABLED=true` requires `VIVA_MODE=sandbox|production`,
`VIVA_API_URL` and `VIVA_API_KEY`. Rollback is the flag; written rows are valid for every reader and
stay. Migration 0117 is expand-only (one new table, RLS forced); the runtime role gets `SELECT`,
`INSERT` and `UPDATE(last_observed_at)`.

## Activation conditions (R4 review, 2026-11-10)

Before the flag is enabled anywhere with real users or money:

1. One PROVIDER/test-stand readback of this Admin method confirms that `subscriptionId` is the
   per-client instance id, byte-equal to the End User `subscriptionId` the readers compare with, and
   records whether rows carry an owner field. A wrong assumption fails closed for payment but leaves
   bindings on wrong ids with no repair path.
2. Readers require the owner binding (mapping, actor user, actor profile mapping), or PROVIDER
   evidence shows Viva refuses another client's instance id on the paid command.

## Evidence

- LOCAL: adapter, composition, AuthService and config unit tests; repository tests on a disposable
  `postgres:16-alpine` with all migrations applied, as superuser and as a non-superuser role (RLS).
- PROVIDER / STAGING: pending. The response shape is pinned from the ADR 0027 residency source, not
  from a fresh provider read of this method with these parameters.

## Known gaps (follow-ups, not part of this change)

- A subscription bought after login is mapped only at the next OTP login. A bounded refresh on the
  joinable/picker read is the next step.
- Readers (`game-join-conditions-context`, training registration, quarter create) still resolve the
  mapping tenant-wide; they do not yet require the owner binding. The LK1 owner check remains the
  ownership gate.
- The ADR 0028 attestation writer and the Home worker upsert subscription rows without a binding.
- The ADR 0029 D4 shared Redis rate limiter does not exist; the budget here is per process.
- The lk2 Home dashboard may list no subscriptions for an OTP user, so the picker can stay empty
  even with mappings present.
