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

## Targeted Viva Home Game bridge

Use this bridge in local or staging when Home must recognize a viewer's upcoming Viva booking as an
existing canonical Game without enabling the continuous roster-window importer:

```text
HOME_VIVA_SYNC_ENABLED=true
HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED=true
GAMES_READ_ENABLED=true
GAMES_COMMANDS_ENABLED=false
LEGACY_GAMES_ROSTER_SYNC_ENABLED=false
LEGACY_GAMES_ROSTER_SYNC_SOURCE=public
LEGACY_GAMES_PUBLIC_BASE_URL=https://padlhub.su
LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY=<approved-local-or-staging-tenant>
```

The worker asks the source only for the Viva exercise IDs already proven by the viewer's upcoming
booking page (at most six per user and at most 25 per bridge call). Public-source requests share one
bounded available-Games response for 60 seconds through process-local single-flight caching, may
serve stale data for up to ten minutes after an upstream failure, and stop retrying through a
circuit breaker after three failures. Therefore concurrent Home projection runs do not translate
one-for-one into legacy API reads. The client receives only the canonical PadlHub Game UUID and
opens `/games/{uuid}`; no Viva or legacy identifier enters the Home DTO.

Keep `LEGACY_GAMES_ROSTER_SYNC_ENABLED=false` unless the separately reviewed continuous import is
required. Recreate only the worker after changing the gate, then verify one canonical Game mapping,
a fresh Home snapshot, and an authenticated browser transition to the Game page.

## Rollback and repair

The command preserves an existing roster unless it is an already bootstrapped mirror whose
canonical revision still matches. If the run is stopped, rerun only the same bounded window after
correction. A bad new aggregate or quarantined roster must be repaired through an audited Games
operation and its outbox projection, not by deleting rows or reconnecting the browser to legacy
data.
