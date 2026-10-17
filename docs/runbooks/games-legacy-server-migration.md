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

## One-game private observation

For an independently authorized read, reuse `LegacyGamesMongoAdapter.readGameObservation({
tenantKey, gameId, operationId? })` with the operator's selected LK1 source ID. Resolve the existing
tenant-owned `integration.external_entity_map` (`LK_LEGACY_SNAPSHOT`, `game`) first; its raw/hash
aliases must point to the same canonical `games.games.id`. Do not infer a mapping from a phone,
court time, hash alone or a supplied request. This method neither verifies authorization nor creates
a mapping. The internal CLI below calls this existing method; no HTTP endpoint, credential
acquisition or import is added.

The source is fixed to `games.lk_games`. The read uses primary/majority, no retries, a single-client
pool and 1–5000ms connection/socket/query timeouts. It selects exactly `tenantKey + id`, caps results
at two to detect duplicates, and retrieves at most five pseudonymized participant IDs plus the
source array count. Names, phones, avatars, payment payloads, keys and tokens are excluded. Null
tenant requires an explicitly selected BSON-null tenant; missing tenant is never a wildcard. Legacy
rows without that field remain unobserved under this selector.

An optional selected operation is read only from `games.lk_legacy_game_commands`, by exact
tenant/game/operation, after matching `game.legacyCommand.lastOperationId`. Other operation owners,
an older operation, absence, ambiguity or unavailable permission stay `UNKNOWN`; no ledger search
or fallback is attempted. Source game/command state is an observation, never booking, benefit or
settlement proof. Those three remain explicitly `UNKNOWN`, including for source state `PAID` or
`SUCCEEDED`. The game and operation have separate observation timestamps; these reads do not form
an atomic snapshot. Participant-row count is not an active-membership count, and five keys are a
bounded diagnostic sample, not a full roster when the source count is larger.

Retain results only at the approved protected evidence destination: pseudonyms and source game ID
remain private integration identifiers. A real read still requires the exact selected target,
operator, IDs, allowed fields, read-only database/network role and time window. Do not inspect or
export credential/URI values, probe production writes, create a fixture or enable a writer. Database
ACL/network enforcement belongs to the operator; a read-only method is not an ACL guarantee.

### Internal one-game CLI

Source entrypoint: `packages/legacy-games-adapter/src/game-observation-cli.ts`. From the reviewed
checkout with the existing Node/tsx dependencies, the exact command shape is:

```sh
node --import tsx packages/legacy-games-adapter/src/game-observation-cli.ts \
  --game-id APPROVED_LK1_SOURCE_GAME_ID \
  --tenant-key APPROVED_EXACT_SOURCE_TENANT_KEY \
  --operation-id APPROVED_LINKED_BRIDGE_OPERATION_UUID
```

These placeholders are not executable target evidence. The command must be run only by the
authorized operator, on the selected target and within its approved read scope/time window, after
verifying the existing tenant-owned canonical mapping and database/network read-only role. Missing
target, operator/role, exact IDs, mapping or actual read grant is **DEFERRED**. Source readiness or
LOCAL synthetic IDs never supply those inputs. CLI flags neither assert nor establish a role or
authorization; there is no `--read-only` authorization flag.

The URI is read only from the existing protected, injected `LEGACY_GAMES_MONGODB_URI` locator.
Do not put its value in command arguments, shell history, files, stdout/stderr or a report. The CLI
does not load `.env`, retrieve secrets, provision credentials, verify ACLs, create a role, or open
SSH. Run this source command only where execution of the reviewed checkout/dependencies is
approved; it does not add a built image or install source on a host. Do not substitute a production
env for a LOCAL validation run.

`--game-id` and exactly one of `--tenant-key` or `--tenant-null` are required. `--tenant-null`
selects explicit BSON-null only and requires separately verified evidence for that source tenant;
it never matches a missing tenant field. `--operation-id` is optional and accepts one UUID for the
existing `lk_legacy_game_commands` bridge owner only. Omit it if no exact bridge receipt is selected;
the observer reports `NOT_SELECTED`. Subscription-booking and split-leave operations have different
owners; this CLI does not follow them. All other/duplicate flags, positional arguments, URI,
collection/projection/query overrides, wildcards, ranges and malformed selectors are rejected
before reading the locator or constructing a client.

The CLI executes one observer invocation. Fixed collections, result limits, projection,
primary/majority reads, 5000ms deadlines, no retries and client close in `finally` are owned by that
existing method. stdout contains one line of its existing private JSON evidence only; retain it
only at the operator-approved protected destination, never shared logs or a public PR. stderr
contains constant CLI error codes, never a raw exception, URI, contacts or provider payload. Exit
`2` means selector/config unavailable; `1` means unavailable/ambiguous observation or a redacted
execution/output error; `0` means a completed `FOUND` or `NOT_FOUND` read. `NOT_FOUND` is neither
no-effects proof nor permission to retry a business command. Partial/unlinked command evidence and
booking/benefit/settlement remain `UNKNOWN` even with exit `0`.

LOCAL verification uses only owned synthetic driver I/O, including the real CLI parser/dispatch,
failure redaction, fixed reads/limits and close. The actual Node/tsx launch is checked only with
invalid selectors or no protected env, so it cannot connect. Existing observer checks remain
separate reused evidence; no actual Mongo/SSH/DB/provider read, fixture, provisioning, container,
signing, host install, merge or deploy is performed by this development step.

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
