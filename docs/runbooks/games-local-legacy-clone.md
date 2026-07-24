# Games local legacy-data clone runbook

Owner: Games backend / QA
Scope: local development only

## Goal

Copy a bounded, sanitized snapshot of public real LK game data into the local PadlHub PostgreSQL database
so reusable game cards and roster actions can be tested against realistic states.

This is not synchronization and not a dual write. The importer uses the public LK API without
production credentials. Every imported aggregate receives new PadlHub UUIDs; source identifiers are
one-way pseudonymized while player display names are retained for the roster UI. Phones, payment URLs
and Viva or legacy booking identifiers are never copied to Games tables, API payloads, logs or outbox events.
The importer may retain an anonymized Viva exercise association in the tenant-scoped
`integration.external_entity_map` solely for local Home-roster test coverage; it is not a Games
field and cannot resolve to a real Viva booking.

The local Home and activity-history bridges can use that association without storing the raw Viva
exercise UUID. They match the raw IDs from the in-memory Viva and public LK/CUP responses, persist
only the deterministic local pseudonym, and then render the canonical Games roster from PostgreSQL.
For history, Viva first proves a bounded set of exercises for the authenticated viewer. The server
reads paginated CUP history for that viewer, filters it in memory to the full Viva page and discards
the lookup phone with the response; the generic provider record is replaced only after the full
aggregate and participant binding have been saved. Browser clients still receive only PadlHub
UUIDs. Participant photo source URLs stay in the trusted worker and
integration metadata. The worker accepts only allowlisted HTTPS hosts, strips image metadata,
converts the source to WebP and stores it under
`profile-photos/{tenant}/{user}/{sha256}.webp`; `profile.user_summaries.photo_url` receives only a
stable PadlHub profile-photo delivery path for that private local object. The API resolves and
streams the current WebP; no S3 signature is stored in profile or Games projections. A legacy photo
never replaces an already stored profile-owned avatar.

## Safety gates

- `APP_ENV` must be `local`.
- `LEGACY_GAMES_IMPORT_CONFIRM` must equal `local-clone`.
- `DATABASE_URL` must resolve to `localhost`, `127.0.0.1`, `postgres` or `phub-postgres`.
- The importer accepts only an HTTPS source (`LEGACY_GAMES_PUBLIC_BASE_URL`).
- Repeated imports never overwrite an existing local game or roster. They refresh the profile
  summary for an already mapped participant, then rebuild the card projection from the current
  local aggregate. Game reads overlay that current PadlHub display name so stock avatars use real
  initials even when an older projection contains `Организатор` or `Игрок N`.

## Procedure

1. Start local PostgreSQL and apply migrations with `npm run db:migrate`.
2. Set a bounded limit (maximum 500).
3. Run `npm run games:legacy:import-local`.
4. Enable `GAMES_READ_ENABLED=true` and `GAMES_COMMANDS_ENABLED=true` only in the local API runtime.
5. Verify the public list, card detail, authenticated join/leave and waitlist flows.
6. To exercise Viva + legacy roster composition locally, enable
   `LEGACY_GAMES_ROSTER_SYNC_ENABLED=true`, set `LEGACY_GAMES_ROSTER_SYNC_SOURCE=public` and keep
   `LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY` aligned with the imported tenant. Restart only the worker;
   the next due Home sync imports the exact matching public game, stores its available participant
   avatars as local WebP objects, fills an omitted level only for the exactly matched authenticated
   Viva viewer, persists normalized numeric ratings for ring progress, and then rebuilds the
   projection.
7. With `ACTIVITY_HISTORY_ENABLED=true`, `ACTIVITY_HISTORY_SYNC_ENABLED=true` and
   `ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED=true`, opening an uncovered or stale history page also
   backfills missing past games for that page. This does not require continuous
   `LEGACY_GAMES_ROSTER_SYNC_ENABLED`. Repeating the refresh is safe: the legacy game mapping, Viva
   exercise association and card projector are idempotent. A fresh Viva exercise reference first
   advances and projects an already-associated local game from its canonical start/end timestamps;
   this works even when CUP no longer returns that old snapshot. A CUP miss without an existing
   association remains a provider-only history record and never receives result actions.

Relevant variables:

- `LEGACY_GAMES_IMPORT_LIMIT`: `1..500`, default `500`.
- `LEGACY_GAMES_IMPORT_TENANT_KEY`: default `local-padel`.
- `LEGACY_GAMES_PUBLIC_BASE_URL`: default `https://padlhub.su`.
- `LEGACY_GAMES_ROSTER_SYNC_SOURCE`: must be `public` locally; staging uses the separately guarded
  `mongo` mirror.

## Expected result

The command prints counts and PadlHub game UUIDs only. Newly imported games have canonical Games
rows, participants, a safe audit record, a domain outbox event and a current card projection.
Every future imported game also has idempotent `game.lifecycle.start.v1` and
`game.lifecycle.finish.v1` scheduled commands. A later exact CUP snapshot that proves the game is
finished or cancelled advances the aggregate and completes any superseded pending lifecycle work.
Participants with an approved source photo also have an `integration.user_profile_photo_sync` row,
a private `image/webp` object and a stable PadlHub delivery URL in
`profile.user_summaries.photo_url`.
Participants without a stored photo render the supplied neutral placeholder in the client. A known
level renders its badge, while the four-segment ring reflects the fractional part of the normalized
rating; a truly unknown rating remains at zero rather than being inferred.

Unknown waitlist members are deliberately not cloned: the source identifies them by phone, which is
outside the approved snapshot contract. Payment URLs and payment-provider state are also excluded.

## Verification and cleanup

Run targeted tests, then `npm run check`. To start over, recreate the local database through the normal
local Compose lifecycle; never point cleanup commands at a shared or production database.
