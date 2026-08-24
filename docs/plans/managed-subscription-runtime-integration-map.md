# LK2 managed subscription runtime integration map

Canonical cross-repository plan:
`Z6v6e6r/ph-admin/docs/subscriptions/lk1-lk2-runtime-integration-plan.md`.

Base: `d6f772b0a9f57888923b3640e751bf4b5f2b95aa`
Target role: public API/Web/Mobile orchestration client
Activation: default `OFF`

## Current truth

- Games roster/capacity is `LOCAL_PRIMARY` PostgreSQL state with transactions, RLS,
  idempotency, audit and outbox.
- `SUBSCRIPTION` is only a payment/evidence mode; there is no entitlement evaluator,
  reservation, counter or ledger.
- Home subscriptions are display projections and must not drive commands.
- JOIN/WAITLIST/LEAVE are reachable. CREATE has a repository writer but no public
  command route. Training and tournament are read-only; add-on is absent.
- Two separate level-evaluation paths exist. A managed action must select one
  orchestrator and cannot evaluate subscription policy in both repositories.

## Target boundary

One server-only runtime client is constructed at API composition and injected into a
single participation orchestrator. It uses audience-bound service authentication,
tenant scope, bounded timeout/retry, circuit-breaker behavior and redacted metrics.
Web and Mobile use only the additive public LK2 contract/SDK.

Sequence for a routed action:

1. verified session, tenant membership and permission;
2. canonical actor/activity and expected revision;
3. availability/capacity preflight;
4. one authoritative level decision;
5. central subscription quote/selection/price decision;
6. central entitlement reserve;
7. under-lock local writer recheck and mutation;
8. central confirm/consume or compensation/reconciliation;
9. local outbox/operation response.

Local `games.seat_reservations` remain capacity-only. LK2 must not store policy,
subscription balance, entitlement counters or a second usage ledger. If crash recovery
requires persistence, store only an opaque orchestration receipt and runtime/writer
operation references.

## Contract insertion points

- API composition: `apps/api/src/app.ts`, `apps/api/src/main.ts`;
- current JOIN routes: `apps/api/src/games/game-routes.ts`;
- local writer: `packages/database/src/game-roster-repository.ts`;
- existing level command boundary:
  `packages/database/src/participation-command-repository.ts`;
- OpenAPI: `contracts/openapi/user/v1/games.yaml` plus a new additive quote resource;
- SDK: `packages/api-sdk/src/index.ts`;
- Web gateway/action state: `apps/web/src/auth-gateway.ts`, `apps/web/src/GamesPage.tsx`;
- Mobile consumes the same SDK contract when action screens are introduced.

The client request carries action, PadlHub activity ID, expected revision, quote ID
and optional opaque selection only. It never carries trusted provider IDs, balance,
policy, discount, final price or counters.

## Action readiness

| Action                  | Current                | Managed status                                                       |
| ----------------------- | ---------------------- | -------------------------------------------------------------------- |
| JOIN_GAME               | Reachable local writer | Best first SHADOW slice; ENFORCE blocked by reserve/confirm/recovery |
| JOIN_WAITLIST           | Reachable local writer | Unsafe until promotion uses same runtime boundary                    |
| CREATE_GAME             | Repository writer only | Blocked by missing command route                                     |
| LEAVE/CANCEL            | Leave only             | Managed return/refund lifecycle missing                              |
| BOOK_GROUP_TRAINING     | Read-only catalog      | Blocked                                                              |
| BOOK_TOURNAMENT         | Read-only summary      | Blocked                                                              |
| PURCHASE_ADD_ON_PRODUCT | No domain/writer       | Blocked                                                              |

## First source-only slice

Define provider-free runtime port/contracts, add a default-off service-authenticated
client, add quote/operation OpenAPI and generated SDK types, and route only JOIN through
one orchestrator in SHADOW. Add negative tests for tenant mismatch, stale revision,
selection required, price change, runtime timeout and redaction. Do not add entitlement
persistence, migrate a database, call Viva or enable production.
