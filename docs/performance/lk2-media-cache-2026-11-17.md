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

## Status on 2026-11-18 (head after the main merge, 8c1920b9e)

### Code and behaviour checks

- Parser boundaries and routes: `conditional-media-get` 10 tests, profile-photo routes 15,
  community-logo routes 5 - 30 pass. Typecheck, API build, contracts lint, eslint and prettier pass.
- Handler-level HTTP behaviour is covered: `200` with the body for a new object, bodyless `304` with
  `ETag`/`Cache-Control` for a matching tag or a lone `*` (including a stored object without an ETag),
  `404` for a missing object under `*`, and `200` for a changed object.
- **Not verified on a real path.** No PadlHub API instance was available in this task (no live or
  staging access, Docker daemon unavailable), so the conditional re-fetch was not exercised through a
  proxy or a browser HTTP cache against the real media routes. The evidence above is handler-level and
  must be labelled that way. A live check still needs a running API + object store and a request pair
  (`curl -sI`, then `curl -sI -H 'If-None-Match: <etag>'`) against the deployed media URL.

### CI after merging main

The branch now includes `origin/main` at `1bd9d6c5c2dfc0c3f1d6f178317037342da36a4a` (PRs #680 and
#681), merged into `8c1920b9e`. No supervisor, publication-workflow or release-guard file was edited
in this branch; the main fixes are carried unchanged.

- **CI on `8c1920b9e` is fully green** (run 44283445144): `ci-plan`, `secret-scan`,
  `source-quality`, `quality-full`, `dependency-security`, `deployment-contract`,
  `docker-selection`, all `docker-build` jobs, Android unsigned build + JVM, and iOS simulator.
- The earlier `quality-full` `ETIMEDOUT` in `scripts/run-ci-tests-with-diagnostics.test.ts` was the
  CI supervisor wall-clock defect, not this change. It is fixed by #681 (the supervisor finalisation
  is bounded by one declared budget), so the test now passes on the unchanged media diff. This branch
  did not edit, skip or re-time that test.

### Contract gate: BLOCKED

1. **Rejected delta:** `contracts/openapi/public/v1/openapi.yaml` (documentation of `If-None-Match`,
   the 304 response and the 200 cache headers). The release window `4b8dbaa1..origin/main` (main is
   now `1bd9d6c5c2dfc0c3f1d6f178317037342da36a4a`) contains 0 paths matching the protected set; this
   head contains 1.
2. **Condition:** `scripts/timeweb-api-web-upgrade.js` `validateRuntimeDelta` fails with
   `runtime_definition_changed` for any path matching
   `^(deploy/timeweb/(?!operator-entry|run-standard)|contracts/|packages/database/migrations/|openapi\.yaml$)`.
   `validateRuntimeUpgrade` then only admits the exact historical `CALLBACK_RUNTIME_BRIDGE` identity
   (`previousSha`/`candidateSha` `0d6078be7a50ed3f5761d66071527be003bd568f` / candidateTree
   `5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4`), which cannot match a new candidate. Result:
   `callback_runtime_bridge`.
3. **Existing allowed path for these SHAs/target:** none found. The bridge is pinned to an old candidate;
   no runbook or script admits a new contract delta without changing the release tooling itself.
4. **Exact evidence:** rerun on the merged code head `8c1920b9e` (the later commits are
   documentation only and do not change validator inputs):
   `npx vitest run scripts/timeweb-api-web-upgrade.test.ts` -> 1 failed, 77 passed,
   `Error: callback_runtime_bridge`.
5. **Decision required from the owner / release owner:** whether a doc-only, add-only contract delta
   may be admitted for this exact source SHA and target, and through which approved mechanism. A new
   attestation/bridge is itself a release-tooling change and needs its own review; it is not made here.
6. **Verification after a decision:** the same validator command must pass for the exact SHA and target
   (or the approved package must carry the recorded admission), followed by the normal release
   preflight/approval. This PR is not merge-ready until that decision exists.

### Release-owner handoff (exact blocker and required decision)

- **Candidate:** the exact head of PR #679, recorded in the PR body at handoff (code head
  `8c1920b9e`, then documentation-only commits). **Target:** the production lane for
  `lk2.padlhub.su`; no publication, deploy or live operation is requested by this PR.
- **Blocked input:** the add-only `contracts/openapi/public/v1/openapi.yaml` delta for the media
  routes.
- **Mechanism failure:** `validateRuntimeDelta` rejects any `contracts/` path
  (`runtime_definition_changed`), and the only admitted non-canonical predecessor is pinned to
  `CALLBACK_RUNTIME_BRIDGE` `0d6078be…` / tree `5e50be3c…`, so this candidate ends in
  `callback_runtime_bridge`. No existing runbook admits a new contract delta without changing the
  release tooling.
- **Required decision:** either (a) the release owner records an explicit admission of this doc-only,
  add-only contract delta for the exact candidate SHA and production target, with the verification
  that admission requires; or (b) the release owner directs the OpenAPI hunk into a separate
  release-owner change so this PR can ship under the automatic lane. Weakening the guard, editing
  the historical bridge, or splitting the 304 from its documented contract is not offered as a fix.
- **After a decision:** the same validator must pass for the exact SHA and target (or the approved
  package must carry the recorded admission), followed by the normal release preflight and exact
  approval. Until then this PR remains Draft.

### What this means for the PR

- Code, tests and the documented behaviour are complete; the media change is not published.
- The PR stays Draft. Merge needs owner approval because it touches the public contract; publication
  needs the release-owner decision above.
- The OpenAPI change and its separate contract-gate status are preserved; no release tooling, guard,
  workflow or historical check was modified.
