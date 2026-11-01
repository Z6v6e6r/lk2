# Explicit legacy training registration consumer

This packet implements PARTIAL B05: authenticated Web registration into an existing
GROUP_TRAINING using the canonical LK subscription writer. LK owner #271 business
commit `63cc80770cc913be86866d08447fc0ae1c5d7c17` and frozen owner fixture SHA-256
`ad6b0447943617233fd4677dc61205fef054e22d1b1d19a3fcf12ede3b7e88b8` define the private wire.
It does not implement training leave, a new participation owner, money, trial purchase,
CUP-managed training, or eligibility rules. The owner requires explicit CUP-unmanaged
and the existing LK1 LEGACY/UNMATCHED selector; matched rules including 100% discounts
are outside this subset. It verifies current owned subscription, category, capacity and
active target/booking. WAITLIST and cancellation never establish confirmation.

## Public and private authority

POST `/user/api/v1/:tenantKey/trainings/:trainingId/registrations` accepts only
`{dateHint,subscriptionId}` and the original `Idempotency-Key`. GET
`/.../:trainingId/registration-operation` reads by that key. Server authentication,
player permission, active tenant/session, and unique synced actor/subscription mappings
precede fresh user-scoped Viva delegation. Mapping is identity evidence, not subscription
ownership. Only LK proves ownership and suitability. Dates use the target's Moscow date;
the game HUB 90-minute eligibility helper is not used.

The private preparation capsule fixes actor, subscription, exact provider exercise,
target fingerprint, canonical legacy selection and 60-second validity. Hashes and
RS256 claim scopes match the frozen owner contract. The API validates the capsule against
the authenticated actor and immutable public request before storing it. Admission and
read use the original body/hash; recovery never prepares again after a possible write.
No provider IDs, capsule, receipt, JWT or token enter public DTOs, browser custody, audit
payloads or application metrics. The two private package subpaths prevent accidental
retention in unrelated frozen migration-runtime bundles.

## Durable transitions

Migration 0107 is additive and does not create a training aggregate or second provider
ledger. The table has tenant FK, composite actor FK, FORCE RLS, original-key uniqueness
and a partial actor/training uniqueness fence. Audit and outbox write in the same transaction.
API startup does not apply migrations. A missing table fails before provider access.

| State                       | Explicit command                                                                  | Result and authority                                                               |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Absent                      | POST original public request                                                      | PREPARING before nonbinding owner preparation                                      |
| PREPARING                   | Claim no active lease                                                             | New 120-second DB-clock preparation lease; no dispatch/capsule                     |
| PREPARING                   | Valid capsule, current unexpired lease                                            | PREPARED, immutable original capsule                                               |
| PREPARING                   | Exact prepare HTTP409 `TRAINING_REGISTRATION_UNSUPPORTED` envelope, current lease | REJECTED_NOT_DISPATCHED, retain original request/key, dispatch NULL                |
| PREPARING                   | Timeout/crash/unknown/foreign response                                            | Remain PREPARING; same key may repeat only nonbinding prepare after lease expiry   |
| PREPARED                    | POST with expired capsule and no dispatch                                         | EXPIRED_NOT_DISPATCHED by row lock + DB-clock CAS                                  |
| PREPARED                    | POST with valid capsule                                                           | DISPATCH_STARTED lease before sole owner admission                                 |
| DISPATCH_STARTED            | Fresh foreground retry after lease expiry                                         | Original read plus restrictive `recovery_only:true`; no new preparation or booking |
| DISPATCH_STARTED            | Exact owner receipt, current lease and original authority hash                    | CONFIRMED with immutable receipt                                                   |
| CONFIRMED                   | GET or POST same key                                                              | Preserve historical receipt; obtain separate fresh observation when possible       |
| Either no-dispatch terminal | Same key                                                                          | Stable exact terminal; no provider access                                          |

Only REJECTED_NOT_DISPATCHED and EXPIRED_NOT_DISPATCHED release the actor/training fence.
Both keep the original row/key. Late prepare success/refusal cannot win after lease
replacement or terminal settlement. Same-key changed selection remains a conflict even
in terminal states. All other attempts, including historical CONFIRMED, retain the fence
until a separate real training leave-generation contract exists. No cancellation endpoint
or automatic timeout-based replacement is introduced. Missing bearer, 404, unknown owner
outcome, malformed response or failed local acknowledgement never permits a new key.

GET does not claim, expire, dispatch or complete. `operation.status` derives only from
the durable local state; `registration.status/asOf` is a fresh owner observation. A stored
CONFIRMED operation plus unavailable/cancelled owner is CONFIRMED/UNKNOWN. Conversely,
a fresh CONFIRMED observation with unfinished local CAS is UNKNOWN/CONFIRMED. Neither
no-dispatch terminal asserts that the actor has no external attendance.

## Browser recovery

The browser saves only the public tuple and random original key under tenant/user/target
before HTTP, with Web Locks and an account-generation check before lock and dispatch.
No automatic 401 or network mutation retry occurs. Foreground continuation retains the
same key/body and obtains a fresh actor delegation. Reload reads; it does not submit.
Only a structurally valid matching no-dispatch terminal response clears matching custody,
allowing an explicit new selection. No error/404 clears custody. Browser lock/storage
unavailability fails closed. A denied localStorage getter is evaluated only inside guarded
custody operations, showing an error without crashing the page or dispatching a request. Native route/session companions are a separate prerequisite;
this packet does not widen Android/iOS allowlists.

## Rollout and rollback

`TRAINING_REGISTRATION_ENABLED` is default false. Owner: booking integration maintainers.
Purpose: isolate the narrow legacy training write/recovery path without enabling WARN
quotes or game commands. Activation requires reviewed migration 0107 after integration
of 0105/0106; exact LK training graph/capability; existing actor OAuth/session mapping;
existing RS256 issuer/audience/key custody; explicit valid legacy selector configuration;
verified owner/provider and device acceptance; and separate owner approval. This source
packet creates or reads no signing secrets and authorizes no activation.

Complete signing configuration, owned tenant `iSkq6G`, sandbox/production Viva mode and
trusted owner URL are required when enabled. Production uses the exact HTTPS owner
origin. Flag-off serves only retained local status; no provider call is issued. It does not
alter `SUBSCRIPTION_RUNTIME_WARN_MODE` or historical LK1 behavior. Review/remove this flag
only after the supported subset and recovery have accepted runtime evidence and its
independent hold is no longer needed; broadening eligibility requires a separate contract.

Rollback disables the flag first and retains journal rows and keys. Do not drop/backfill
attempts or replay bookings. Old API processes ignore the additive table; new code on an
old schema returns unavailable without DDL/provider calls. Restoring compatible code and
fresh foreground authentication resumes original attempts. There is no automatic service
account compensation or background recovery claim.

## Evidence boundaries

Focused tests cover exact wire/hash parity, current actor/tuple, no-downgrade selection,
preparation leases/refusal/late ACK, original dispatch/recovery, historical versus current
status, stable browser custody, 401/network nonretry, and public privacy. The physical
PostgreSQL suite runs only in the existing migrated localhost CI PostgreSQL with strict
CI/mock credentials and unique task tenant; it is skipped locally and provisions no DB.
It exercises independent connections, dispatch/expiry/prepare races, stale ACK, atomic
outbox rollback, original-key replacement rules, constraints and RLS metadata. It does not
claim provider capacity, live signing, device acceptance, deployment or production proof.

## Android catalogue companion

The Android TRAININGS entry uses `GET /user/api/v1/:tenantKey/trainings/catalog` for initial
and cursor reads. The existing Web client-assisted catalogue stays unchanged. The displayed
seven-day date window is Europe/Moscow on both clients. Registration remains the exact #271
legacy-subscription contract above; neither discovery, a zero displayed price, category names,
nor an observed free seat authorizes a reservation.

The API composes the server catalogue only under the existing `GAMES_READ_ENABLED` gate and
`sandbox`/`production` Viva mode. No new flag, credential or activation is introduced. The existing
`TRAINING_REGISTRATION_ENABLED` gate independently controls registration. An active actor session,
existing encrypted OAuth delegation, verified `TenantAuthBinding` and Redis snapshot store are
prerequisites. The helper checks tenant/provider binding before and after token refresh; only
server code receives the user token and provider tenant. No system credential or provider read-job
is sent to Android. OAuth refresh can update its existing delegation/session linkage; this is a
business-read catalogue, not a claim of zero authentication/cache writes.

The server keeps at most 64 adapters keyed by authoritative provider tenant, retaining circuit
state instead of recreating it per request. Each request reads at most seven dates, in parallel,
once per date with a maximum 2.5-second timeout and a 12-second overall budget including access
acquisition. A late access refresh cannot start schedule reads after that budget. Refresh already
in flight may finish its existing session bookkeeping. Full provider failure gives a redacted
unavailable error; incomplete days give `PARTIAL` with no exact totals/facets.

The strict adapter currently supports only the existing bare-array day representation, with at
most 500 source entries. It rejects wrappers/pagination, malformed entries, duplicate source IDs,
wrong-day training instants, missing end times, unknown explicit states, redirects and non-200
responses. Known cancelled/archived training records are excluded. This does not certify the
provider's undocumented pagination or completeness behavior: real schedule-format acceptance is
still required. Unsupported shapes remain unavailable rather than inventing a continuation API.
The recommendation adapter's permissive legacy `readDate` behavior is unchanged.

Snapshots retain the existing ten-minute observation lifetime, tenant/actor/query identity and
page-size binding. The new route enforces original `staleAt` even when cursor storage TTL is
extended. Its internal catalogue marker rejects cursors from other catalogue producers. Neither
cursor reuse nor a partial result refreshes attendance, price or entitlement authority. Public
UUIDs use the existing exercise hash that #271 independently verifies with the Moscow date hint;
station/court aliases remain display data and are not CREATE location bindings.

Android permits only this catalogue GET and the existing exact training registration POST/original
operation GET. POST has exactly `dateHint` and public `subscriptionId`; operation GET retains the
original idempotency key. Unknown query keys, duplicate parameters, malformed bodies and other
provider/native routes remain rejected. The #520 custody controller persists the key before HTTP,
keeps it across ambiguity/reload, checks account lifetime and requires explicit retry. It never
replays a mutation after 401 or network failure. Historical operation completion remains separate
from the fresh registration observation; WAITLIST/cancellation/unavailable never becomes current
confirmed attendance from a cached receipt.

Rollback is source-compatible: an older API returns unavailable/404 for the new catalogue; Android
must not fall back to direct Viva. An unresolved registration key remains retained if its read
endpoint is unavailable. No schema, migration, provider configuration, signing, store publication,
iOS capability or production activation is part of this packet. Source/host-JVM/synthetic UI/CI
checks do not replace device, real authenticated provider, or production acceptance.
