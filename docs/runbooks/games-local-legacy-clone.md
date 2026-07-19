# Games local legacy-data clone runbook

Owner: Games backend / QA
Scope: local development only

## Goal

Copy a bounded, anonymized snapshot of public real LK game data into the local PadlHub PostgreSQL database
so reusable game cards and roster actions can be tested against realistic states.

This is not synchronization and not a dual write. The importer uses the public LK API without
production credentials. Every imported aggregate receives new PadlHub UUIDs; source identifiers are
one-way pseudonymized and player names are replaced with role labels. Phones, payment URLs and Viva or
legacy booking identifiers are never copied to Games tables, API payloads, logs or outbox events.

## Safety gates

- `APP_ENV` must be `local`.
- `LEGACY_GAMES_IMPORT_CONFIRM` must equal `local-clone`.
- `DATABASE_URL` must resolve to `localhost`, `127.0.0.1`, `postgres` or `phub-postgres`.
- The importer accepts only an HTTPS source (`LEGACY_GAMES_PUBLIC_BASE_URL`).
- Repeated imports never overwrite an existing local game or roster. They only rebuild its card
  projection from the current local aggregate.

## Procedure

1. Start local PostgreSQL and apply migrations with `npm run db:migrate`.
2. Set a bounded limit (maximum 500).
3. Run `npm run games:legacy:import-local`.
4. Enable `GAMES_READ_ENABLED=true` and `GAMES_COMMANDS_ENABLED=true` only in the local API runtime.
5. Verify the public list, card detail, authenticated join/leave and waitlist flows.

Relevant variables:

- `LEGACY_GAMES_IMPORT_LIMIT`: `1..500`, default `500`.
- `LEGACY_GAMES_IMPORT_TENANT_KEY`: default `local-padel`.
- `LEGACY_GAMES_PUBLIC_BASE_URL`: default `https://padlhub.su`.

## Expected result

The command prints counts and PadlHub game UUIDs only. Newly imported games have canonical Games
rows, participants, a safe audit record, a domain outbox event and a current card projection.

Unknown waitlist members are deliberately not cloned: the source identifies them by phone, which is
outside the approved snapshot contract. Payment URLs and payment-provider state are also excluded.

## Verification and cleanup

Run targeted tests, then `npm run check`. To start over, recreate the local database through the normal
local Compose lifecycle; never point cleanup commands at a shared or production database.
