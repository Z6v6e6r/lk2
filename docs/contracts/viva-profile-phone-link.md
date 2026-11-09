# Viva profile mapping from an Admin lookup by verified phone

Status: implemented, default off (`VIVA_PROFILE_PHONE_LINK_ENABLED=false`). Decision: ADR 0029 D5
(PR #626). Owner boundary: `@phub/viva-adapter` `VivaClientPhoneLookupAdapter` +
`@phub/database` `linkVivaProfileByVerifiedPhone`, invoked by `AuthService.verifyPhoneChallenge`.

## Why

OTP login (ADR 0023) proves the phone but carries no Viva `clientId`, so lk2 has no
`VIVA/viva_profile` rows. Paid JOIN/CREATE, residency and the server Admin reads need that mapping.

## Flow

1. A Viva OTP login succeeds. The phone used is the challenged phone, and only when the
   provider-verified identity (`phone_number_verified=true`, exact E.164 match) reports the same
   phone. The client never supplies it. CUP dev authentication never triggers the lookup.
2. If the user already has a `viva_profile` mapping, nothing is called (`already_mapped`).
3. `GET /api/v2/search/clients?q=<11 digits>` (Admin key). This is a relevance search: a full
   phone also returns near matches (pinned from a redacted cabinet HAR, 2026-11-09). The result is
   only a candidate list.
   - 0 rows -> `NOT_FOUND`;
   - 20 rows (a full page that may be truncated) or more than 5 distinct candidates -> `AMBIGUOUS`.
4. `GET /api/v1/clients/{id}` for each candidate. The card `id` must equal the candidate. Deleted
   cards are ignored. A card without a `phone` field is an error; an explicit `null` is a non-match.
   Cards are read in parallel. The card `phone` (11 digits, `7…`; a leading `8` and formatting are
   normalized) must equal the verified phone exactly.
   - exactly one -> `MATCHED`; none -> `NOT_FOUND`; more than one -> `AMBIGUOUS`.
5. `MATCHED` writes the mapping under the canonical provider-client advisory lock used by
   `upsertExternalUser`:
   - new pair -> `linked` (audit `VIVA_PROFILE_LINKED_BY_PHONE`, `SUCCESS`);
   - same pair -> `unchanged`;
   - client owned by another user -> `client_conflict` (audit, `DENIED`), nothing changes;
   - user mapped to another client -> `user_conflict` (audit, `DENIED`), nothing changes;
   - concurrent writer -> unique violation -> `user_conflict` when the canonical internal-id index
     (0042) fired, otherwise `client_conflict`. That transaction rolls back, so this case has no audit
     row, only the logged outcome label.

   The Viva client id is stored exactly as Viva returned it (as the other `viva_profile` writers
   do); ownership checks compare it case-insensitively.

## Failure behavior

The step never fails the login. Provider errors, timeouts, an open circuit, malformed bodies,
a missing card and database errors report `unavailable`; `NOT_FOUND`/`AMBIGUOUS`/conflicts write
nothing. Every uncertainty is an error, never `NOT_FOUND`. The next OTP login retries. Logs carry
only the outcome label and bounded metrics; no phone, name, provider ID or payload.

Login latency: only unmapped users pay it. The whole lookup has a 3 s deadline (`unavailable` on
expiry); each GET is capped at `min(VIVA_TIMEOUT_MS, 2000)` ms with no retry, card reads run in
parallel, and the circuit opens after 3 failures for 60 s. A `NOT_FOUND`/`AMBIGUOUS` user repeats
the lookup on each OTP login (no negative cache).

## Known risk

Recycled phone numbers: if Viva still holds a former owner's card under a number that now belongs
to someone else, the new holder is mapped to that card. Viva's own OTP login has the same exposure,
but here the mapping also feeds subscription write-offs. Mitigation is on the Viva side (stale
cards updated or deleted); the audit rows `VIVA_PROFILE_LINKED_BY_PHONE` identify every mapping
written by this path for review or reversal.

## Configuration

`VIVA_PROFILE_PHONE_LINK_ENABLED=true` requires `VIVA_MODE=sandbox|production`, `VIVA_API_URL`
and `VIVA_API_KEY` (startup refuses otherwise). Rollback: set the flag to `false`; written
mappings stay valid canonical rows and need no cleanup.

## Evidence and gaps

- LOCAL: adapter unit tests (exact owner among near matches, zero/two exact, deleted, truncated
  page, candidate budget, id mismatch, 429 retry, 401/403 no retry, timeout, circuit); auth route
  tests (link, already mapped, not found/ambiguous, failures and conflicts keep the login,
  disabled, unverified phone); PostgreSQL tests on a disposable database (link/idempotent,
  client conflict, user conflict, concurrent claim, invalid id).
- PROVIDER (pending): a stand readback of one `MATCHED` login with the server key.
- Not covered: users who never log in again by OTP stay unmapped; a backfill from stored verified
  phones is a separate follow-up.
