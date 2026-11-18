# LK2 public media: conditional GET (304) — change, tests, compatibility plan

Date: 2026-11-17. Branch: `codex/lk2-performance-media`, split out of PR #670.
Companion client change: `codex/lk2-performance-client` (PR will be linked here).

## What was wrong

`GET /public/api/v1/media/profile-photos/:tenantId/:deliveryId` and
`GET /public/api/v1/media/community-logos/:tenantId/:communityId` already answered with
`Cache-Control: public, max-age=300, stale-while-revalidate=600` and an `ETag`, but the API never
looked at `If-None-Match`. A browser or a Capacitor WebView that revalidated an unchanged avatar or
logo after the five-minute freshness window received the whole WebP body again. Nothing in the repo
answered a conditional media request (`grep if-none-match apps/api/src` had no hits), so this was a
missing response, not a tuning value.

## What changed

- `apps/api/src/media/conditional-media-get.ts` — matching for `If-None-Match`.
- `apps/api/src/profile/profile-photo-media-routes.ts` and
  `apps/api/src/communities/community-logo-media-routes.ts` — answer an unchanged object with a
  bodyless `304` that still carries `ETag` and `Cache-Control`; keep the normal streamed `200`
  when the object changed; release the already-opened object stream before the 304.
- `contracts/openapi/public/v1/openapi.yaml` — the `If-None-Match` header (including `*`), the `304`
  response and the `ETag`/`Cache-Control` headers of the `200` are documented for both routes.

### Supported header grammar (a subset, not full RFC 9110)

The parser accepts what browsers and WebViews actually send: an optional weak prefix (`W/`),
double-quoted opaque tags, comma-separated lists and `*`. Specific behaviour, all covered by
`conditional-media-get.test.ts`:

| Header                                               | Stored ETag           | Result                                               |
| ---------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| `"v1"`                                               | `"v1"`                | 304                                                  |
| `W/"v1"` or stored `W/"v1"`                          | `"v1"`                | 304 (weak comparison on both sides)                  |
| `"other", W/"v1"`                                    | `"v1"`                | 304 (list)                                           |
| `*`                                                  | any, including absent | 304 while the object exists (404 stays 404)          |
| `"v0"`                                               | `"v1"`                | 200 with the new body                                |
| `avatar-v1` (unquoted), `W/`, `"unterminated`, empty | `"v1"`                | 200 — malformed input fails safe                     |
| `"a,b"`                                              | `"a"`                 | 200 — a comma inside a quoted tag is part of the tag |

Token boundaries are explicit, not implied by a split on commas:

- a lone `*` (surrounded only by optional whitespace) is the wildcard; `*, "v1"` or `"v1", *` is a
  malformed field and does not match;
- tags must be double-quoted and separated by commas; space-separated tags, a trailing comma, an
  unquoted tag or a tag followed by garbage (`"v1"x`, `W/"v1"junk`) make the field malformed;
- one malformed entry fails the whole field (normal `200`), instead of matching a healthy-looking
  prefix.

This implementation does not claim full RFC 9110 conformance: it has no parser for every listed
production, it compares the quoted opaque value literally after stripping `W/`, and it does not
implement `If-Match` / `If-Modified-Since`. Within that subset it is deterministic and fails towards
`200`, never towards a false `304`.

### What this does not change

- **No fewer S3 requests.** The route still resolves the object key and calls `store.read` before it
  can compare tags, so the storage GET still happens. Only the client response body is avoided. A
  cheaper path (forward the tag to the store or add a metadata read) is deliberately not attempted
  here; it needs an evidenced reason and a transport change, not a guess.
- No change to authorization, tenant scoping, object mapping, identifiers or visibility rules.
- No change to which bytes are served for a changed object.
- No caching of private data: these two routes are the public media routes and their URLs are
  already the stable first-party delivery URLs.

## Tests

`apps/api/src/media/conditional-media-get.test.ts` (9), `profile-photo-media-routes.test.ts` (15),
`community-logo-media-routes.test.ts` (5). Route-level coverage includes: wildcard 304 without a
stored ETag, wildcard 404 when the object is missing, changed tag streaming the new body, 304 with no
body and with `ETag`/`Cache-Control`, and the existing upload/delete/grant tests unchanged.

## Compatibility deployment plan

The change is add-only at the HTTP level: a client that never sends `If-None-Match` sees the same
`200`, the same body and the same headers as before. Conditional requests answered with 304 are
standard browser-cache behaviour; no first-party client sets the header manually.

1. **Pre-merge evidence (required before any release):** `npm run check` on the exact head or the
   equivalent CI job; contract lint; the media route tests above. Independent review of the caching
   semantics (already performed once on #670; repeat on this head).
2. **Release lane:** the change touches `contracts/**`, so the Timeweb release validator
   (`scripts/timeweb-api-web-upgrade.js`) classifies it as a protected runtime-definition change.
   Evidence: the release window `4b8dbaa1..origin/main` contains **0** paths matching
   `contracts/`, `packages/database/migrations/`, `openapi.yaml` or the protected deploy scripts;
   this head contains **1** (`contracts/openapi/public/v1/openapi.yaml`).

   On CI, `quality-full` passed on head `fadd8865e`: the release-tooling tests stay paused unless the
   change also touches their activation inputs (`scripts/**`, `vitest.config.ts`), and this branch
   touches neither. Running the validator directly on the same head **fails** with
   `callback_runtime_bridge` (`npx vitest run scripts/timeweb-api-web-upgrade.test.ts`: 1 failed,
   77 passed): the release window now contains a `contracts/` path where `origin/main` had none.
   The guard is not weakened and no historical check was edited.

   **Applicable release route.** This source cannot be admitted by the automatic publication lane:
   the lane's validator rejects the candidate, and a green `quality-full` does not change that. The
   only applicable route is an owner-approved release package in which the release owner explicitly
   records the doc-only, add-only contract delta and admits it for the exact source SHA and target
   (fresh preflight, then publication). While the production lane is paused by the owner decision in
   `AGENTS.md`, this PR stays Draft and is not published. The alternative — moving the OpenAPI hunk
   into a separate release-owner PR so this one can pass the automatic lane — was rejected: it would
   ship the 304 while leaving the public contract describing only 200, which is the inaccuracy this
   change exists to remove.

3. **Order of deployment:** API first (the 304 originates there), Web/Android later are unaffected.
   No migration, no schema change, no backfill, no cache purge needed.
4. **Observation after deployment:** share of `304` versus `200` on the two media routes, error rate
   (5xx/4xx) on the same routes, and API p95 for them. Client bytes saved are visible as the drop in
   media response size in CDN/edge logs; S3 GET volume is expected to stay flat, which is the check
   that this change did what it claims and nothing more.
5. **Rollback:** revert the commit (single API change). Clients fall back to the previous behaviour
   (full body on revalidation); no stored state depends on the new response. Already cached 304s are
   not harmful because the ETag remains the version signal.

## Evidence and limits

LOCAL/CI evidence only. No production traffic was measured, no staging deployment was made, and no
claim is made about the resulting p95 or about S3 call reduction.
