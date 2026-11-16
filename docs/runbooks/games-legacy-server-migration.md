# Games legacy server migration runbook

Owner: Games backend / Platform
Scope: approved staging or production backfill only

## Purpose

Backfill a bounded legacy LK Games time window into the canonical tenant-scoped Games aggregate.
The server-side adapter reads only the allowlisted legacy fields needed for the aggregate and writes
the Game plus its outbox event in one PostgreSQL transaction. A valid legacy Viva exercise key is
stored only as an integration association, so a viewer's Viva Home booking can resolve a safe
canonical roster.

The import bootstraps a guarded roster mirror for matching scheduled Games. The separately gated
worker can later refresh only those rosters while their canonical revision has not changed. A
local change or unknown baseline is quarantined as a conflict; the worker never overwrites it.
This is not a client feature switch and never writes back to legacy Mongo/Node-RED.

## Preconditions

- A reviewed change and an approved backup/rollback plan exist for the target environment.
- The source URI is stored in the server secret manager and injected only as
  `LEGACY_GAMES_MONGODB_URI`; it is never placed in `.env`, Git, browser bundles or logs.
- `DATABASE_URL` points to the intended tenant-safe PadlHub database.
- `APP_ENV` is `staging` or `production`.
- `LEGACY_GAMES_IMPORT_TENANT_KEY`, `LEGACY_GAMES_IMPORT_FROM` and
  `LEGACY_GAMES_IMPORT_TO` describe one bounded, reviewed window. The command imports at most 500
  records per run.
- `LEGACY_GAMES_SERVER_IMPORT_CONFIRM=server-migration` is supplied by the operator for this run.

## Procedure

1. Run `npm run db:migrate:check` and capture the current service version/digest.
2. First run `npm run games:legacy:reconcile-server` with
   `LEGACY_GAMES_RECONCILIATION_CONFIRM=read-only-report`. It is read-only and prints only counts,
   discrepancy categories and PadlHub game UUID samples.
3. Run `npm run games:legacy:import-server` from the approved worker/admin image, never from a
   browser or a production shell that builds source code.
4. Repeat the reconciliation report. It must have no missing canonical Games or unresolved Viva
   exercise associations before a read gate can change.
5. Retain only the command's aggregate counts and PadlHub game UUID samples in the change record.
   Do not copy source documents, identifiers, phones, payment facts or source-media URLs.
6. Reconcile imported count, lifecycle, capacity and active roster count against an approved
   server-side report. Investigate every
   `VIVA_EXERCISE_GAME_ASSOCIATION_CONFLICT`; do not override it.
7. Project the affected Home components and verify the chosen participant card through an
   authenticated browser in staging. The API response may contain names, PadlHub avatar URLs,
   levels and free slots only.
8. Keep client read/command gates unchanged until the separate LK/CUP cutover review is approved.

## Staging roster mirror

Run this only after the initial reconciliation is clean and only in the staging worker deployment.
The Mongo URI belongs in the secret manager, never in a checked-in environment file.
On the Jetson staging node these settings live in the mode-`0600`
`/opt/phub/staging.games.env` file. The Home activation script owns a different non-secret override
and must never rewrite or copy the Mongo URI.

```text
GAMES_READ_ENABLED=true
GAMES_COMMANDS_ENABLED=false
LEGACY_GAMES_ROSTER_SYNC_ENABLED=true
LEGACY_GAMES_ROSTER_SYNC_SOURCE=mongo
LEGACY_GAMES_MONGODB_URI=<server-secret>
LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY=<approved-staging-tenant>
LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS=1
LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS=42
LEGACY_GAMES_ROSTER_SYNC_LIMIT=200
LEGACY_GAMES_PROFILE_PHOTO_SYNC_LOOKBACK_DAYS=30
LEGACY_GAMES_ROSTER_SYNC_INTERVAL_MS=120000
```

The worker reads the bounded window, imports previously unseen Games, and updates a roster only
when its prior mirror revision still matches. It writes canonical `game.scheduled.v1` outbox facts
for changed rosters. Investigate every `LEGACY_GAME_ROSTER_BASELINE_MISMATCH` and
`LEGACY_GAME_ROSTER_LOCAL_REVISION_CHANGED`; leave the game quarantined until an audited repair.
The separate profile-photo window reads at most 30 past days by default and copies images only for
participants that already have a PadlHub mapping. It does not import or mutate historical Games,
does not expose CUP media URLs to clients, and preserves a profile-owned avatar when the legacy
source differs or fails. Because a busy 30-day window can exceed the general 500-game read bound,
the worker also resolves up to 100 missing-avatar participants already present in completed
PadlHub history and asks the Mongo adapter for their newest CUP photo directly. Raw participant
aliases stay inside the integration layer; only the copied PadlHub media URL reaches projections.

If moving the Mongo credential to staging is not separately approved, a read-only test release may
instead set `LEGACY_GAMES_ROSTER_SYNC_SOURCE=public` and
`LEGACY_GAMES_PUBLIC_BASE_URL=https://padlhub.su`. This source contains real public CUP Games but
only the sanitized public roster surface. `GAMES_COMMANDS_ENABLED` and
`ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED` must remain `false`; use the Mongo mirror when private or
historical roster reconciliation is required.

## Retired Viva Home Game bridge

`HOME_VIVA_SYNC_ENABLED` and `HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED` are retired. Upcoming Viva
bookings are read through the authenticated browser job and normalized before they enter PadlHub.
Do not enable the former worker bridge as a fallback. The independent legacy roster importer remains
separately gated for PadlHub/CUP data and does not authorize Viva End User server traffic.

## Rollback and repair

The command preserves an existing roster unless it is an already bootstrapped mirror whose
canonical revision still matches. If the run is stopped, rerun only the same bounded window after
correction. A bad new aggregate or quarantined roster must be repaired through an audited Games
operation and its outbox projection, not by deleting rows or reconnecting the browser to legacy
data.

## Exact quarantined-roster recovery

For an approval naming individual Games, use the exact mode of the existing Worker repair
entrypoint, one canonical PadlHub UUID per invocation. A date window or broad `--limit` is not an
exact-target boundary. Use only a reviewed immutable Worker image through the approved controller;
this command does not authorize image publication, installation, or a bypass of production
backup/restore, source identity, monitoring and rollback prerequisites.

1. Keep a protected preimage of the selected Game, all participation states, card, sync state,
   relevant mappings and existing profiles. Record account/profile counts and hashes. Require a
   verified production backup and an audited compensating rollback plan; do not plan to restore the
   entire DB to undo a two-Game repair, since unrelated accounts may change concurrently.
2. Run the entrypoint with `--tenant-key <tenant> --game-id <canonical UUID>
--operation-id <stable-operation> --plan`. This is a read-only DB connection. It resolves only
   that Game's server-side source aliases and reads one complete roster from Mongo primary/majority.
   Reminder snapshots omit participants and are never accepted for this operation. Public-source
   fallback, redirects, cancelled/empty/ambiguous/truncated sources and non-baseline conflicts stop.
3. Review the returned plan SHA-256, canonical Game and count against the approved preimage/source.
   Apply with the same target/operation and `--plan-sha <reviewed hash>`. Default exact mode forbids local
   removals, checks the plan before writing and fences Game/sync revision and source versions again
   under the transaction lock. The plan also binds every existing player-alias/account mapping. Exact recovery locks and rechecks
   those identities before writing; unbound, conflicted or repointed aliases stop. No account or
   profile is created, merged or rewritten in exact mode. Existing profiles remain unchanged. Split player aliases stop rather
   than reassign another account. A deferred no-removal result cannot create/repoint identities.
4. On lost acknowledgement, retain the same operation and plan hash. The exact audit correlation and
   matching current MIRROR/source/revision/identity digest establish `ALREADY_REPAIRED` with no second write. Any
   drift stops for readback; do not automatically retry an ambiguous operation. A deferred result
   requires fresh review rather than a wider removal permission.
5. Check every old active participation ID remains ACTIVE, unique count and organizer match the
   approved source, the Game advanced exactly one revision, MIRROR/source/card revisions converge,
   one repair audit and one projection event exist, and existing profiles/account rows are retained.
   Confirm a subsequent unchanged source cycle advances verification and that both authenticated Web
   and Android upcoming reads contain the participants. Keep raw source IDs/names/phones/media URLs
   out of stdout, Git and CI; the exact report contains only canonical UUID, counts, operation and
   plan hash. The exact process has a 90-second hard deadline, 5-second DB connection deadline,
   15-second statement, 3-second lock and 20-second idle-transaction/query limits; timeout requires
   audited readback with no automatic retry. Redacted source outcome/duration metrics retain the
   operation ID. Compensating rollback bumps revision and emits an audit/outbox event; never delete
   accounts, audit/outbox history or decrement a Game revision.

### Explicit source-roster replacement

When an operator has reviewed a specific source roster and the default exact repair returns
`LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL`, a separate exact replacement mode can retain
old participation rows as `LEFT` and make the source participants `ACTIVE`. This is a live roster
mutation requiring exact Game/source/preimage approval; choosing which roster is correct does not
itself approve executing the replacement. Prepare and review the plan before requesting execution.

- Plan with the same exact target arguments plus `--replace-source-roster --plan`.
- Apply only the reviewed plan with `--replace-source-roster --plan-sha <reviewed hash>
--confirm REPLACE_SOURCE_ROSTER_KEEP_ACCOUNTS_AND_PAYMENTS`. The confirmation is an operator
  acknowledgement, not an authorization credential. `--limit`, batch `--allow-local-removals`,
  duplicate options and confirmation on a read-only plan are rejected.
- The Game must still be `SCHEDULED` and strictly before its canonical start. Source and canonical
  start/end/capacity must match. The source must be complete, uncancelled and fit capacity; all source
  and current active payment states must be `PAID` or `NOT_REQUIRED`. An overlapping participant's
  payment state must remain identical. The transaction checks server time again after taking locks.
- Replacement requests opt into strict primary/majority roster reading. The raw game, organizer and
  every raw participant must explicitly be `PAID`; generic mapper defaults are not payment proof.
  Missing/unknown/`ACTIVE`/pending/cancelled participant statuses, malformed rows, non-array rosters,
  conflicting duplicates and over-capacity sources stop the entire read instead of dropping or
  truncating participants. One identical paid organizer repeated in the array represents the same
  seat. Verify this raw-status evidence for the selected live source before execution; do not infer
  it from a generic snapshot whose mapper synthesizes `paymentState: PAID`.
- Every source alias must already resolve bijectively to an active existing account with an existing
  profile. No account, profile, player mapping or payment is created, rewritten or merged. Game alias
  disagreement, changed bindings, missing identities, changed revisions, any participation tuple
  change, or source/sync version drift stops the operation.
- Any `ACTIVE` seat reservation (including an expired one) or `ACTIVE` waitlist entry stops the plan
  and the locked writer. This operation does not confirm, cancel, expire or promote pending seats.
- The plan binds all existing participation IDs, users, roles, states and payment states. The writer
  locks and rechecks that preimage. Missing source members become `LEFT` with the same participation
  ID, user, role and payment state. Existing non-active rows stay unchanged. No rows or accounts are
  deleted, and there is no refund, payment/provider call or result/rating/lifecycle change.
- One transaction advances the Game revision once, returns sync ownership to `MIRROR`, and writes
  the existing projection outbox event and success audit. Audit evidence includes before/after roster
  digests, retained row-ID digest, retained count and retained paid-row count. A post-write retention
  mismatch rolls the entire transaction back. These row/audit guarantees do not guarantee a visible
  personal-history entry for the retired participants; review that product effect separately.
- The existing `game.scheduled.v1` event also reaches messaging membership and notification consumers.
  Downstream chat membership, lifecycle scheduling and enabled Game reminder/scenario rules can
  therefore change for the source roster. This is not a card-only write. Review those configured
  effects and obtain the necessary external-message authority before live execution; this mode
  neither suppresses notifications nor bypasses their normal runtime and recipient checks.
- After a lost acknowledgement, retain the same operation ID and reviewed hash. A single matching
  success audit, unchanged source/mapping/revision and exact post-roster digest permit readback as
  `ALREADY_REPAIRED` without a second mutation. A different plan for the same successful replacement
  operation, changed post-state or a new plan request stops. Do not automatically retry an ambiguous
  outcome, reuse a new operation ID to evade a fence, or rewind a started/finished Game.

### Reviewed Viva UI settlement observations

Some LK1 create records contain `CONFIRMED` seats and a synthetic game-level paid flag, even when
Viva has settled each booking with an entitlement. Those fields alone never authorize paid seats.
The exact replacement CLI additionally accepts `--ui-observation-stdin --reviewed-proof-sha <sha>`.
Only this mode reads complete membership without inferring payment from LK1. It requires exactly
four distinct, existing beneficiaries and a closed, canonical JSON observation envelope, delivered
on bounded stdin. Keep the envelope and original UI excerpts in private operator storage, outside
Git, logs, command arguments and public DTOs. Never copy OAuth/address history or authentication data.

The trust label is `OPERATOR_REVIEWED_VIVA_UI_SUBSCRIPTION_OBSERVATION_V1`, with
`originAuthenticated: false`: this is an independently reviewed authenticated-session observation,
not a provider-signed receipt. Each seat binds the complete actual Viva client UUID through an
unchanged original UI capture to the exact exercise, venue/court/time, one active paid booking and
one applied subscription usage. The reviewer verifies beneficiary ownership, acquisition class,
one-unit debit, no duplicate/family ambiguity, cancellation, reversal or outstanding charge.
Hidden booking/subscription/usage identifiers stay explicitly unavailable; never invent UUIDs.
The unique compound observation uses the client/exercise/occurrence and booking/usage creation
times, entitlement and before/after balance. Cash-purchased and administratively issued zero-price
entitlements both settle a seat; this does not assert that every participant paid cash.

The proof binds tenant/Game/operation/source versions and snapshot, all existing alias mappings,
capture and reviewer hashes. Reader and independent reviewer differ. Its maximum lifetime is
15 minutes, and the locked writer checks database time immediately before mutation. Renew captures
only after the selected immutable artifact is ready. Existing raw UUID/pseudonym aliases may
establish the supported legacy identity fallback; no direct Viva profile mapping is created.
Existing optional Viva mappings must agree. Identity bindings, mapping presence/absence and the
exercise mapping are rechecked under the writer's exclusion/row locks. Only after all evidence is
validated are these four seats materialized as `PAID`. No provider, payment, subscription or identity
mutation is performed. The audit stores hashes and non-sensitive custody metadata, not UI excerpts
or raw provider identities.

For apply only, the first business lock is `EXCLUSIVE NOWAIT` on the physical external mapping
table, followed by nonblocking import/client advisory locks. Busy means rollback and manual
readback, never automatic retry. This also excludes attestation writers and same-user/different-
client phantoms. Ordinary SELECT remains available, but mapping/login/attestation writers for all
tenants can briefly wait. Measure the physical successful critical section before live use; require
low-single-second duration. Statement timeout is per query, not a 15-second total transaction
bound; the catastrophic outer process deadline remains 90 seconds. Verify the actual runtime role
has the necessary existing lock privileges. Do not add grants to make recovery pass.

### Finished, unscored exact UI recovery

`--finished-unscored-ui` is an additional explicit flag accepted only with the reviewed UI-proof
replacement mode. Generic, additive and raw-PAID replacements remain `SCHEDULED` only. A finished
Game is eligible only while its original 12-hour result window is open according to database time,
with `AWAITING_SUBMISSION`, original start/finish timestamps, and precisely the quarantined baseline
followed by its two native completed START/FINISH commands, matching success audits and outbox
events. The plan binds that entire preimage. A different lifecycle predecessor or any result
submission, review, result, set, player fact, result audit/event or result-derived history stops.

The transaction locks the exact mapping, lifecycle commands, Game and sync state in compatible
order, rechecks the preimage and result absence, and serializes with result submission on the same
Game lock. It changes only roster/organizer, advances revision once and restores `MIRROR`. It never
rewinds lifecycle/time, changes the result deadline, reconciles or replays scheduled commands, emits
a second `game.finished.v1`, or backfills a missed notification. Review actual runtime consumers of
the one existing `game.scheduled.v1` projection event before live execution. Delayed events must
project the current aggregate; they must not replace the restored roster with an old payload.
After restoration a normal result submission must use the restored four-member roster.

Lost-ACK recognition requires the unchanged current postimage. If a legitimate later result has
already advanced the Game, the retry stops for manual audit/readback and never reapplies the repair.
Do not widen the mode or use another operation ID to evade this stop.

Native START/FINISH transitions carry `last_synced_game_revision` forward only for an exact clean
`MIRROR` old revision. They do not refresh source timestamps/version, validate stale evidence or
clear a conflict. This preserves roster visibility in Web/Android across lifecycle transitions
without claiming a new provider read.

After an approved apply, verify source membership and organizer, every retained row/payment, account
and profile preimages, one revision/audit/outbox, MIRROR and converged card projection. Verify the
actual authenticated Web and Android reads separately. This command does not authorize merge,
publication, deployment, replay of reminders/results, or compensating rollback. Production evidence
must come from the reviewed immutable Worker artifact, not a locally copied script.
