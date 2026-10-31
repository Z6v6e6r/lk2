# CUP LOCAL_ONLY tournament consumer

Source dependency: CUP #64 `9d728414428bd5f02f7acbad5d07b1cff8e59d17`.
This consumer does not enable its owner or any provider. No money, subscription,
linked exercise, VIVA_SOURCE, WAITLIST, organizer cancellation or native admission.
MALE/FEMALE and canonical level are enforced by the owner; MIXED is unrestricted.

## Authority and identity

The existing trusted Keycloak actor token and CUP integration token authenticate the
private owner protocol. No new signer or browser-selected provider identity exists.
The actual identity response must match the session's synced VIVA profile and
provider tenant binding. The original provider mapping ID/client ID/tenant are
pinned and rechecked before every explicit dispatch and scoped read. A new session
of the same actor can recover; a different mapped client cannot inherit an operation.
The browser never receives phone, provider IDs, owner key or bearer.

The public tournament UUID uses `phub-public-tournament-v1:` in both implementations.
The discovery adapter retains its exact original dated-feed query association. It
refreshes that same date and refuses missing/ambiguous association. UTC startsAt is
not a source of date authority. CUP preparation is only a current observation; actual
command revalidates mapping, LOCAL_ONLY rules, eligibility and capacity under owner CAS.
A process restart without rediscovery leaves a NEW command unavailable; rediscovery
restores the private association. Original operations never need a new preparation.

## Durable command and recovery

Migration0109 expands after0108 with one concrete command/receipt table. It does not
copy the CUP roster. Actor/key uniqueness, original JOIN self-FK and a pending
actor/target unique fence prevent parallel local generations. The journal binds the
public request, original dated command, provider mapping and deterministic owner
operation ID before dispatch. A transaction claims one lease before the owner POST.
On timeout, parsing failure, 4xx or missing owner result, retain the original row/key.
Lease expiry permits only exact same-body/key replay, not a new admission target.
CUP's existing atomic command replay checks request hash before current rules.

GET returns an explicit `commandsEnabled` alongside the scoped result. New browser commands
remain disabled until a successful availability read; disabled/missing-table/error never
creates new browser custody. Historical receipts remain readable with commands disabled.
GET only reads. Owner404 never proves no write and does not erase custody. In
particular, an unacknowledged command is not completed from the thinner read receipt:
explicit POST retry validates the original body through owner command replay, then
reads current registration. The retry route requires a public Idempotency-Key scoped
to the fixed original operation; it cannot create a row or change the private CUP key.
Audit/outbox entries contain only local identifiers and state, in the same transaction.
Only one completion event is emitted even after a lost local ACK.

LEAVE names the original local JOIN operation. Its CUP command uses the stored date
and owner generation. Replaying a terminal old LEAVE after rejoin cannot leave the new
registration. A historical REGISTERED result is not proof of current membership;
UI displays confirmation only with a fresh matching owner registration observation.
When the newest command is terminal REJECTED, a default (unkeyed) read may recover the
newest own original REGISTERED JOIN only if its pinned identity still matches and a fresh
owner read confirms that exact generation. Explicit key/operation reads remain exact;
pending commands are never bypassed. There is no adoption of pre-existing LK1/CUP
registrations without original evidence.

Browser custody stores only public IDs/request/key. Web Locks serialize tabs;
principal snapshot checks run after lock acquisition, before HTTP, and before applying
response/storage changes. Tournament-only epoch invalidates synchronously when logout
starts, even if revocation is delayed or fails. Late session refresh cannot reopen the
tournament gate. Authentication started during logout cannot reopen it after revocation;
only a genuinely new accepted authentication outside logout can. Denied browser storage
renders an unavailable state without HTTP or a command lacking durable custody. SDK mutations have one request and no
automatic network/401 refresh retry. The Android native bridge exposes the bounded surface below; iOS remains closed.

Availability limitation: unsupported or pre-dispatch failures keep browser custody;
HTTP404/409 alone never clears it. Such attempts can block another JOIN until supported
reconciliation. Typed refusal is shown without claiming the owner received a request.
A malformed or changed discovery date stays unavailable rather than guessing.

Private transport has independent identity/preparation/command/read circuit state: three
unavailable responses open that phase for30seconds, then one probe is permitted. Business
4xx refusals do not trip a shared circuit. Every request carries correlation; fixed
phase/outcome/duration observations omit actors, keys, bodies and URLs. Observation errors
cannot alter a committed ACK. No automatic mutation retry is introduced.

## Activation and rollback

`TOURNAMENT_LOCAL_COMMANDS_ENABLED` defaults off. Owner: LK2 participation maintainer.
Activation requires deployed compatible CUP #64, approved owner adoption/writer guards,
trusted actor claims with clientId, matching service credential, fresh dated snapshots,
0109 deployment and separate runtime acceptance. Review/remove the temporary flag only
after production acceptance and a documented rollback decision. No activation is part
of this source packet. Existing owner journal limit512 and bounded catalog limit500
remain capability limits; no eligibility bypass or catalog fallback is added.

Expand only: new table/FK/index/RLS, no existing row rewrite or backfill. Migration
uses lock/statement timeouts; an operational apply still requires its own approval.
Old0108 code ignores0109; disabling the new consumer retains every pending and terminal
row, audit and receipt. Do not drop/truncate the journal or remove owner adoption guards
on rollback. Default-off GET uses to_regclass and reports commands disabled and a null result only for genuine missing
table; DB/authorization/corruption errors are not swallowed as legacy absence.

LOCAL tests use synthetic transports/storage only. The dedicated PostgreSQL suite
runs only on existing guarded quality CI's migrated loopback fixture, creates a unique
tenant and cleans only its facts; it is skipped locally. It also uses an isolated temporary
non-superuser/no-bypass role (the existing CI fixture pattern) to verify cross-tenant
SELECT hiding and INSERT denial, then drops only that role and its grants. This new
physical coverage is source-only until its CI execution is observed. Full CI, provider/runtime, actual user membership,
physical-device/store and production acceptance remain separate evidence levels.

## Android concrete consumer (stacked after #529)

Android exposes a dated tournament directory and the existing detail/registration panel.
It does not enable the mixed Event Catalog, TRAINING, iOS or a generic public fetch.
JS and Java independently allow only the fixed configured PadlHub origin/tenant and:
public tournament list/detail GET with exact calendar-valid dateFrom/dateTo (1–15 days,
exclusive end), plus the existing authenticated participants/status/command/original-retry
routes. Public discovery has no bearer/cookie/idempotency key. Dates use the existing
Moscow-day helper; the backend retains the original authoritative feed date, never a date
inferred from displayed startsAt. Only public UUIDs reach the client.

JOIN/LEAVE use exact body fields, and LEAVE keeps originalJoinOperationId. Native commands
require the stored authenticated session and caller's stable key. The bridge/engine do not
automatically retry a mutation or refresh/replay it after401. Manual original retry keeps
the original operation/key. Android's HTTP implementation otherwise adds a form content
type to an empty POST; the concrete retry policy sets text/plain. The API accepts only
undefined body or exact empty string with text/plain (optional charset=UTF-8), never
nonempty/whitespace text, JSON or form data. No sender/engine or owner wire is changed.

The Android directory reaches the existing custody controller: availability must succeed
before a new command, unavailable storage/locks deny dispatch, ambiguity retains custody,
relaunch reads without creating a command, and manual retry uses the same original operation.
Tournament principal invalidates at the start of the outer native logout, before async
booking/push cleanup. Existing page/account/lock/late-ACK fences remain in effect.

Rollback removes native exposure while retaining backend journals and browser custody;
never erase unresolved requests. Runtime flag/owner deployment/identity acceptance remain
the #529 gates. This branch does not integrate pending #524/#526 TRAINING/unsigned-build
work. Their shared App/auth/native-policy changes require the designated integration owner.
The actual base Android workflow is dispatch/tag-only: no automatic unsigned build is
claimed here. Host-JVM policy/engine and synthetic JS/UI results are LOCAL, not an APK,
device, provider, store or production result. Full applicable CI remains required.
