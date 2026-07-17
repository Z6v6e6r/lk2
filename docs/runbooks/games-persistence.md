# Games persistence expand-release runbook

Migration: `packages/database/migrations/0023_games_foundation.sql`
Owner: Games backend / Platform
Write mode after migration: `LOCAL_PRIMARY` in storage, client command routes still disabled

## Purpose

Install the canonical tenant-safe Games schema and repository foundation without cutting traffic
over from the working LK. This is an expand release: it creates new objects and ownership metadata;
it does not alter or delete legacy records and does not enable user-facing writes.

## Preconditions

1. Use the immutable migrator image for the target release; API processes do not run migrations.
2. Verify a current PostgreSQL backup and record its restore test.
3. Run `npm run db:migrate:check` and `npm run check` for the exact image digest.
4. Confirm no other pending migration uses sequence `0023`.
5. Keep Games API/client feature gates off during the expand release.

## Apply

1. Apply all migrations sequentially through `npm run db:migrate` from the migrator process.
2. Confirm `0023_games_foundation.sql` appears once in `public.schema_migrations` with its checksum.
3. Confirm all twelve regular tables in schema `games` have both `relrowsecurity` and
   `relforcerowsecurity` set.
4. Confirm `integration.domain_ownership` contains `games = LOCAL_PRIMARY` for each tenant.
5. Run a synthetic transaction through `createGameRepository().create` for a non-production test
   tenant. Verify one game, one organizer, one operation, one idempotency record, one scheduled
   command, one audit row and exactly two outbox events.
6. Replay the same request/key and verify the original `gameId`, `operationId` and revision. Reuse
   the key with a different request hash and verify `idempotency_conflict`.
7. Against a disposable database whose name ends in `_verify`, run
   `scripts/verify-games-roster-concurrency.ts`. Verify that parallel joins produce exactly one
   winner at the final seat, the loser is durably rejected with `GAME_FULL`, a leave promotes only
   the queue head, a split-payment reservation expires once, all replays are idempotent and the
   winning user's operation is readable through tenant/actor ownership.
8. The same verification script creates local profile/station dependencies, projects the final
   game fact twice and verifies `applied` then `duplicate`, a two-player public snapshot and a
   viewer-owned upcoming list. This extended projector assertion must be rerun on clean PostgreSQL
   before enabling the read runtime.

## Isolation and safety checks

- Query as a non-owner runtime role with tenant A context: only tenant A rows must be visible.
- Switch to tenant B in a new transaction: only tenant B rows must be visible.
- Verify outbox payloads contain PadlHub UUIDs/revision/correlation facts but not the raw
  idempotency key, Viva/provider IDs, phone, payment URL or token.
- Keep payment obligations outside Games. Creation must never mark payment `PAID`; only a verified
  Commerce event may do so.
- Keep production Games repository injection off until Commerce can supply a durable payment next
  action. A paid reservation may be reported as `PROCESSING`, but the API must never fabricate a
  URL or claim payment success.
- Keep public and User Games read repository injection off until the extended projector script has
  passed on clean PostgreSQL for the release digest. An empty projection is not permission to fall
  back to Viva, mock cards or a client-selected source.
- Verify due commands are claimed with `FOR UPDATE SKIP LOCKED`, `attempts < 20` and `locked_by`.

## Rollback

This expand release is rolled back operationally, not by dropping tables:

1. Keep or return all Games API/client gates to off.
2. Stop Games process-manager/projector consumers if they were enabled.
3. Redeploy the previous application image digest; the unused additive tables remain compatible.
4. Preserve new rows and outbox facts for diagnosis. Do not truncate or manually delete them.
5. A later reviewed contract migration may remove unused objects only after retention and backup
   requirements are satisfied.

## Gate to the next release

Do not enable command traffic until API authorization/response mapping, Commerce reservation
confirmation, projector inbox replay, remaining lifecycle handlers, migration of the approved
legacy population, load testing and backup/restore rehearsal all pass for the target environment.
