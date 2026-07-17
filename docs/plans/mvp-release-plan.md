# Web-first MVP release plan

Status: working release contract
Date: 2026-07-18
Release surface: web/Tilda only

## 1. Purpose and release decision

This plan defines the smallest deployable PadlHub user release and the evidence required to approve it. It narrows the larger target described in the domain documents; it does not declare the current implementation release-ready.

The MVP is a **discover-and-participate** web release:

- a user can authenticate, see a truthful Home snapshot, discover a published game, open its details, and join, leave, or enter its waitlist when the game does not require payment;
- the user can inspect bookings, profile, locations, communities, and in-app notifications only to the depth explicitly listed below;
- unfinished product contours are hidden or fail closed, not represented by placeholder routes or synthetic records;
- web and Tilda clients call only PadlHub APIs and use only PadlHub public identifiers;
- Games remain `LOCAL_PRIMARY`: canonical writes and the outbox are committed in one PostgreSQL transaction. Commerce and other external domains are separate owners and are not synchronously dual-written.

`P0` means a mandatory release gate. Any failed P0 makes the release `NO-GO`. `P1` is a required hardening item for the next increment, but it also becomes `NO-GO` when the corresponding optional feature is enabled in the release.

## 2. MVP scope

### In scope

1. **Identity and session**
   - Viva-backed OAuth and/or phone OTP, according to the enabled tenant runtime configuration;
   - session restoration, logout, deterministic auth errors, and a working retry path;
   - versioned legal documents and recorded acceptance for every auth path that requires it.
2. **Home**
   - server-owned Home projection with real upcoming activity, active memberships, and unread notification count;
   - honest loading, empty, stale, partial, and error states;
   - navigation only to routes included in this release.
3. **Games: read and no-payment participation**
   - public discovery list and game details;
   - authenticated upcoming/history list and game details;
   - join, leave, waitlist join, and waitlist leave for eligible `NO_PAYMENT` games;
   - idempotent commands, durable operation status, audit, tenant isolation, and stable error codes.
4. **Bookings**
   - authenticated upcoming booking list;
   - deep links only to supported PadlHub game details.
5. **Profiles**
   - authenticated self profile;
   - viewer-filtered public profile when the profile projection is healthy;
   - owner privacy settings already supported by the server contract.
6. **Locations**
   - tenant-scoped location list and details.
7. **Communities**
   - read-only membership summary/directory already used by Home;
   - no community detail or management workflow.
8. **Notifications**
   - in-app inbox, unread count, mark read, and mark all read;
   - only allowlisted deep links to routes included in this release.
9. **Operator dependencies**
   - CUP location administration and notification campaign operations only where required to support the web journeys;
   - no general CUP release is implied by this MVP.

The release requires at least one tenant-scoped, published `NO_PAYMENT` game suitable for the acceptance journey. How that game is provisioned is an operator concern for this slice; end-user game creation is not included.

### Out of scope

- native iOS or Android distribution;
- end-user game creation, publication, cancellation, result entry, rating finalization, or game lifecycle administration;
- paid participation, split payment, subscriptions, refunds, and any Commerce-owned payment workflow;
- tournaments, trainings, coaches, subscription purchase, promotions, gift certificates, and offers;
- chats, direct messaging, community messaging, game messaging, and realtime conversation delivery;
- community details, creation, join/leave commands, feed, ratings, and member management;
- APNs, FCM, notification moderation, and a general-purpose CUP support interface;
- favorites, persistent sharing state, or any decorative action that has no complete backend contract;
- merging local, cached, and Viva data to construct one aggregate.

Moving an item from out of scope into the release requires an explicit scope change and the same P0 evidence as the existing journeys.

## 3. Feature and route gating

Production navigation is an allowlist, not a list of future product intentions. The web release may expose only:

- `/`, `/profile`, and a viewer-filtered `/profile/{padlhubUserId}` when its projection is healthy;
- `/bookings`;
- `/games` and `/games/{padlhubGameId}`;
- `/locations` and `/locations/{padlhubLocationId}`;
- `/communities` as a read-only directory;
- `/notifications`.

All release gates are server-owned capabilities combined with deploy-time feature flags. Flags default to off and failure to load capabilities fails closed. Client-side hiding alone is not authorization.

Before release:

- hide `/games/new` and every create-game action;
- hide `/tournaments`, `/trainings`, `/coaches`, `/subscriptions`, `/promotions`, `/gift-certificates`, `/offers`, and `/chats` from navigation, Home, profile, and deep-link entry points;
- hide the Home subscription tab rather than render sample or empty future UI;
- render community membership rows without a detail link until community details are implemented;
- hide profile contact/chat actions until their server commands and access source exist;
- reject or safely redirect notification deep links outside the route allowlist;
- hide Web Push controls unless global, tenant, provider, browser, and same-origin service-worker gates have all passed;
- return a real `404`/stable domain error for unsupported deep links; do not render “section is connecting” placeholders;
- never show hardcoded dates, times, addresses, participants, memberships, bookings, or notifications as production data.

## 4. Acceptance matrix

| Journey                          | Required release behaviour                                                                                                   | Current baseline                                                    | Acceptance evidence                                                                            | Accountable contour                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| OAuth/OTP sign-in                | Legal documents are reachable; required acceptance is recorded; login, retry, restore, and logout are deterministic          | Partial vertical exists                                             | Browser trace for every enabled path, acceptance record, redacted API log, auth smoke          | Identity/Auth + Legal/Product             |
| Home after login                 | Real server projection; correct empty/stale/error states; no fabricated cards; all links are allowlisted                     | Partial; production-visible hardcoded fallbacks must be removed     | Seeded-user screenshots, API payload/DOM comparison, empty/error/stale tests                   | Home Projection + Web Client              |
| Public game discovery            | Published tenant games can be listed and opened without leaking external identifiers                                         | Domain/API foundation exists; runtime/client integration incomplete | OpenAPI test, anonymous browser trace, tenant-isolation test, PadlHub UUID check               | Games + API SDK + Web Client              |
| Authenticated game participation | Eligible user can join/leave/waitlist a `NO_PAYMENT` game; repeated requests are idempotent; capacity conflicts are stable   | Command/domain foundation exists; full vertical incomplete          | E2E trace, DB transaction/outbox proof, operation polling, conflict and duplicate-submit tests | Games + Database/Platform + Web Client    |
| Bookings                         | Upcoming list is truthful and supported deep links resolve to PadlHub game details                                           | Partial read contour exists                                         | Authenticated browser trace, empty/error tests, ID/source audit                                | Bookings + Web Client                     |
| Self and public profile          | Self data loads; public profile is viewer-filtered; privacy settings are server enforced; unsupported actions are hidden     | Self/privacy slice exists; projection health needs proof            | Two-viewer privacy matrix, RLS test, browser trace, projection readiness check                 | Profiles + Database/Platform + Web Client |
| Locations                        | Tenant list/detail work and missing locations return a stable error                                                          | API/CUP slice exists                                                | Browser trace, cross-tenant negative test, operator CRUD-to-web visibility check               | Locations + CUP                           |
| Communities directory            | Membership summary is read-only and truthful; rows do not imply an unavailable detail workflow                               | Partial Home/directory slice exists                                 | Membership and empty-state screenshots, API comparison, link audit                             | Communities + Web Client                  |
| In-app notifications             | Inbox/unread/read-all are consistent; deep links are allowlisted                                                             | In-app slice exists                                                 | Browser E2E, counter consistency test, invalid-link test                                       | Notifications + Web Client                |
| Web Push, if enabled             | Same-origin service worker, provider, permission, subscribe, delivery, display, and open flow pass on the release origin     | Conditional/partial                                                 | Real-browser end-to-end recording and provider delivery evidence                               | Notifications + SRE/Release               |
| Tilda delivery                   | Loader selects one immutable compatible bundle; clients call PadlHub only; rollback selects the previous known-good artifact | Delivery tooling exists                                             | Release manifest, bundle digest, network trace, rollback rehearsal                             | Web Delivery + SRE/Release                |
| Operator readiness               | Required tenant, location, game fixture, notification settings, support owner, and rollback contact are ready                | Must be checked per environment                                     | Signed environment checklist and smoke transcript                                              | CUP + Product Operations + SRE/Release    |

## 5. P0 release gates

### P0-1. Scope and UX truth

- Product and architecture approve this exact scope and route allowlist.
- Every visible control has a complete supported journey.
- No placeholder section, synthetic production record, inert tab, or link to an excluded contour remains.

### P0-2. Identity, consent, and access

- All enabled auth paths pass sign-in, retry, restore, expiry, and logout acceptance.
- Required legal documents are versioned, reachable, and their acceptance is auditable.
- PadlHub JWT, tenant context, authorization, and privacy rules are enforced server-side.

### P0-3. Games end-to-end vertical

- Production API construction injects the Games read/roster dependencies and readiness reports them accurately.
- OpenAPI, generated contracts, API SDK, web screens, and command/error handling are aligned.
- Public discovery, authenticated details, and `NO_PAYMENT` participation pass the matrix on staging.
- Critical commands require `Idempotency-Key`, emit audit/outbox evidence, and never dual-write another owner’s state.

### P0-4. Truthful projections and tenant isolation

- Home, bookings, profiles, locations, communities, and notifications use one consistent source/version per aggregate.
- Empty, stale, degraded, and unavailable states are distinguishable.
- Cross-tenant and unauthorized tests prove that private rows and integration identifiers are not exposed.

### P0-5. Quality and contract verification

- `npm run check` passes on the release commit.
- Migration tests pass from a clean PostgreSQL database and from the supported upgrade path.
- OpenAPI validation, secret/dependency scans, unit/integration tests, and mapped browser E2E journeys pass.
- If Compose changes, `docker compose config` passes for every changed file.

### P0-6. Performance and operational safety

- Agreed latency/error-rate thresholds pass under representative MVP load; the threshold and result are recorded, not inferred from a local smoke test.
- External calls have timeout, bounded retry, circuit-breaker behaviour, metrics, and redacted logs.
- Correlation IDs connect browser, API, worker, outbox/projector, and notification evidence.

### P0-7. Immutable promotion and rollback

- CI builds one immutable image/bundle set and promotes the same digests to staging and production.
- Staging readiness and all acceptance journeys pass on the candidate digests.
- A verified backup exists; sequential rollout and rollback to the previous known-good digests have been rehearsed.
- No `latest` tag and no production-server build is used.

### P0-8. Release ownership

- Every contour in the acceptance matrix has an accountable owner and a named operational rotation outside this document.
- Support runbook, alert destinations, incident severity rules, and release/rollback decision authority are acknowledged before rollout.

## 6. P1 hardening gates

- Web Push completes the real-origin end-to-end flow before its flag is enabled.
- Accessibility smoke covers keyboard navigation, focus, labels, contrast, reduced motion, and screen-reader landmarks.
- Web performance budgets cover cold load, authenticated Home, game list/detail, and roster command feedback.
- Observability dashboards separate auth, Home projection, Games reads, Games commands, outbox/projector lag, and notification delivery.
- CUP/operator tasks are converted from tribal procedure into a tested runbook.
- Public profile projection resilience and data-repair procedure are proven.

## 7. Required evidence package

The release candidate folder or release record must contain:

1. Git commit, image digests, web/Tilda bundle digests, release manifest, and environment capability/flag snapshot.
2. CI output for `npm run check`, OpenAPI and migration validation, scans, image builds, and mapped tests.
3. Clean-install and upgrade migration transcripts, plus RLS/cross-tenant negative-test results.
4. Browser recordings or screenshots and redacted network traces for every acceptance-matrix journey, including empty/error/stale cases.
5. Proof that web/Tilda traffic targets only PadlHub APIs and that public payloads contain no Viva keys or externally primary identifiers.
6. Games command evidence: idempotency replay, capacity conflict, authorization failure, audit event, business-state/outbox transaction, and projector convergence.
7. Home payload-to-render comparison for seeded users and proof that no synthetic fallback becomes visible data.
8. Staging readiness/smoke results on the exact release digests, representative load results, and alert/dashboard links.
9. Backup verification, sequential rollout checklist, rollback rehearsal transcript, and previous known-good digests.
10. Legal document versions, acceptance audit example, production route/link audit, and signed release decision.

Evidence must identify the environment, tenant, timestamp, commit/digest, expected result, actual result, and accountable contour. A screenshot without a matching request/runtime identity is supporting material, not sufficient proof.

## 8. Release NO-GO criteria

The release is `NO-GO` if any of the following is true:

- any P0 gate is incomplete, waived without written architecture/product/security approval, or supported only by local mocks;
- Home or another production surface can show fabricated dates, times, addresses, people, bookings, memberships, or notifications;
- a visible route/control ends in a placeholder, unsupported workflow, inert action, or unallowlisted deep link;
- Games discovery/detail/participation is enabled while its runtime dependency is unavailable, its SDK/client contract is missing, or its readiness can still return `GAMES_RUNTIME_UNAVAILABLE` for the acceptance path;
- paid participation or another Commerce workflow can be selected without a complete Commerce-owned contract and evidence set;
- an auth path lacks reachable legal text, required versioned acceptance, deterministic error recovery, or session restoration;
- a client receives a Viva system key, treats a Viva identifier as primary, selects a data source, or observes a mixed-source aggregate;
- tenant isolation, server authorization, privacy filtering, idempotency, audit, or outbox atomicity has a known failure;
- required browser E2E, migration, contract, security, or representative-load evidence is red;
- staging did not run the exact production candidate digests, the backup is unverified, or rollback was not rehearsed;
- critical alerts, support ownership, correlation tracing, or release decision authority are absent;
- Web Push is enabled without a successful same-origin real-browser delivery/display/open proof;
- the release is described as a native mobile, paid Games, chat, tournament, training, subscription, or full CUP launch.

## 9. Ownership by contour

| Contour                | Accountable deliverables                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Product/Architecture   | Scope, route allowlist, acceptance decisions, ownership boundaries, release GO/NO-GO record            |
| Legal/Product          | Document text/versioning, required-consent policy, acceptance auditability                             |
| Identity/Auth          | OAuth/OTP/session lifecycle, tenant/JWT verification, auth errors and audit                            |
| Web Client             | Route gating, honest UI states, accessibility, browser E2E, PadlHub-only API usage                     |
| API SDK/Contracts      | OpenAPI compatibility, generated types, SDK methods, stable errors and correlation IDs                 |
| Home Projection        | Source consistency, readiness/staleness semantics, truthful aggregation                                |
| Games                  | Discovery/details, roster commands, lifecycle invariants, idempotency and audit                        |
| Bookings               | Upcoming projection and PadlHub game linkage                                                           |
| Profiles               | Self/public views, privacy enforcement, projection readiness                                           |
| Locations              | Tenant list/details and operator-to-user visibility                                                    |
| Communities            | Read-only membership summary and directory semantics                                                   |
| Notifications          | In-app inbox/counters/deep links; Web Push only when separately gated                                  |
| Database/Platform      | Migrations, constraints, RLS, outbox/projector consistency, backup/restore                             |
| CUP/Product Operations | Tenant/location/game-fixture/runtime configuration and operator checklist                              |
| QA                     | Acceptance traceability, negative/empty/error coverage, evidence package completeness                  |
| Security               | Threat review, secrets/dependency scans, authorization and data-exposure approval                      |
| SRE/Release            | Immutable artifacts, staging/prod promotion, readiness, observability, sequential rollout and rollback |

Personal names do not belong in this document. The release record maps each contour to the current accountable team/rotation and approver.

## 10. Relationship to current plans

- `README.md` describes the initial Viva-backed auth-to-protected-Home vertical. This plan extends it only enough to create a releasable web user journey and makes truthful Home behaviour a P0 condition.
- `docs/plans/games-module-rebuild-plan.md` remains the implementation plan for the broader Games module. Its unfinished Commerce, command, UI, lifecycle, backup/restore, and immutable-promotion work is not silently included here.
- Domain documents remain the target-state contracts. Where their target is wider than this plan, feature gates preserve the narrower MVP boundary.
- Passing unit tests or a clean PostgreSQL load is necessary evidence, but it does not replace staging browser, runtime-injection, promotion, backup, or rollback proof.
