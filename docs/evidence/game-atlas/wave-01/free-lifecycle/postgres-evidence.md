# PostgreSQL evidence

## Environment

- Disposable local Compose project: `phub-pr135-clean`.
- PostgreSQL 16.15; repository migrations reapplied successfully with `npm run db:migrate`.
- Test suite: `packages/database/src/game-create-recovery-postgres.test.ts`.
- Seven tests passed on multiple pool connections. No shared/live target was used.

## Observed outcomes

1. Concurrent same-key create produced one game/organizer/operation/idempotency row, two lifecycle commands, three outbox facts, and one canonical replay.
2. Same key with a different payload returned conflict with no extra durable rows; a past-start new key left zero rows.
3. Two concurrent last-seat joins produced one applied result and one `GAME_FULL`; ACTIVE count and distinct users remained exactly capacity.
4. Two promotion workers produced lease cardinality `[0,1]`; one waitlisted user became ACTIVE, the queue entry became terminal, replay returned the stored result, and capacity stayed exact.
5. Two distinct events for one game completed as `applied + stale` under a five-second bound; both inbox rows were processed and one current projection remained.
6. A temporary role was verified `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`; `games.games` was FORCE RLS; another tenant row was invisible and an attempted update affected zero rows. The role and grants were removed after the test.

## Lock order

- User/process command advisory and idempotency fence.
- Canonical game row `FOR UPDATE`.
- Exact roster/waitlist/reservation row.
- Dependent evidence when applicable.
- Revision, audit, outbox and process result.
- Card projector: inbox claim, game `FOR UPDATE`, projection row, aggregate projection revision, inbox completion.

## Not proven in this run

Join-vs-cancel, direct-join-vs-promotion, cancel-vs-promotion, lock-timeout HTTP mapping, and broker DLX crash points remain follow-up evidence. Expiry-vs-confirmation and stale reservation generation are deliberately not exercised because the unsafe expiry executor is not enabled. Runtime production role/grants are not inferred from the disposable role.
