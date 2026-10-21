# P2: recovery of the original CREATE

Stream B owns this UI, SDK and HTTP read change. The immutable dependency is PR #388,
`6d761edd61b8f7dad4cac51d57016d74cc733ba6`, specifically the two
`packages/games/src/booked-game-consumer-contract*` files. They are unchanged. The
accepted-operation ledger/component work from PR #355 is reused on that baseline;
its old POST replay expectation is replaced by GET-only recovery.

## Implemented native path

`CreateGamePage` → `AuthGateway.getGameCreateOperation` →
`PadlHubApiClient.getGameCreateOperation` →
`GET /user/api/v1/:tenantKey/game-create-operation` →
`GameRepository.getCreateOperation` → `games.command_idempotency` joined to
`games.games` in the existing tenant transaction.

The original key is a header, never a URL/query field. Authentication, active-session,
`games.play` and tenant admission use the existing handlers. The reader selects the
exact tenant, actor, `user:actor` principal, key and `game.create.v1` command. It checks
stored operation/game IDs against the result payload, requires the same organizer,
`NO_PAYMENT` and no booking. No writer, retry, new association, schema, queue,
projection rebuild or provider call is added. The response identifies only the
committed native beta command; it is not the financial contract from PR #388.

The browser saves the original payload, fingerprint, key and assigned operation/game
IDs under the original tenant/actor ledger. Resolved custody retains the operation ID.
Recovery reads the original key even if its POST response was lost before an ID was
saved. CREATE makes one HTTP request, disables network and auth-refresh replay, and
receives the page AbortSignal. A persisted attempt is never resent. Concurrent tabs
use Web Locks; only the callback that first stores an attempt may dispatch CREATE.
Saved resolved entries are re-read before reopening the game. A GET 404, unavailable
API, invalid response or conflicting binding preserves custody and UNKNOWN.

Waiting is bounded to eight seconds per user action. There is no automatic poll,
replacement purchase or replacement CREATE. Later responses cannot override a newer
check or account/logout lifecycle. Form edits do not alter the stored command during
recovery. Storage includes no credentials or provider responses, and errors do not
expose keys, private payloads or raw backend exceptions.

## Independent commercial UI and remaining dependency

`GameCreationOperation` renders processing, booking, benefit and settlement separately
through the exact PR #388 nonfinal parser and original binding. Missing legs remain
UNKNOWN; every SUCCEEDED input and changed quote/revision/tenant binding is refused.
This component is exercised with synthetic partial claims. It is not connected to a
pretend successful commercial endpoint.

There is no canonical commercial CREATE→quote/revision→operation→game source in this
baseline. B1 `/booked-operations/:id` returns receipt-only status, not this aggregate,
and is not wired in `main.ts`. Its current legacy receipts lack the required durable
PadlHub association. Stream C owns the authoritative resolver and financial evidence;
sequential integration must verify its actual source, API-compatible projection and
finance acceptance first. Neither gameId nor native beta SUCCEEDED closes that gate.
Commercial CREATE and real P2 acceptance remain unproven. JOIN remains excluded.

## Reproduction and evidence levels

Run from this task worktree, using the committed lockfile:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run apps/web/src/p2-create-recovery-http.test.tsx apps/web/src/CreateGamePage.test.tsx apps/web/src/GameCreationOperation.test.tsx apps/web/src/create-game-attempt.test.ts --maxWorkers=1 --no-file-parallelism
NODE_OPTIONS=--no-experimental-webstorage npx vitest run apps/api/src/games/game-routes.test.ts packages/database/src/game-repository.test.ts packages/api-sdk/src/index.test.ts --maxWorkers=1 --no-file-parallelism
NODE_OPTIONS=--no-experimental-webstorage npm run check
```

The HTTP integration test uses the actual UI, SDK, authenticated HTTP handler and
canonical repository against an instrumented in-memory SQL fixture. It discards the
first POST response after the repository stores its result, reloads/reopens twice,
and asserts exactly one POST, one game insertion, unchanged business-write count and
identical key/operation/game custody. This is LOCAL synthetic HTTP integration, not
physical PostgreSQL or provider evidence. Page tests cover timeout, repeat checks,
out-of-order responses, API loss, missing/conflicting operations, malformed success,
account/tenant switch and logout. Component tests cover independent partial claims.
API/SQL tests check auth, scope, no writes and corrupt canonical relations.

A task-owned Docker preview is requested through the existing local launcher. Only
its owned readiness, source and actual rendered/DB readback may establish that extra
LOCAL evidence. CI is evaluated separately on the final pushed head. No real operation
is selected or read in this task; no STAGING, PROVIDER or PRODUCTION claim follows.
