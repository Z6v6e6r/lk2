# Existing-game subscription advisory (B2 JOIN)

`GET /user/api/v1/{tenantKey}/games/{gameId}/join-conditions` accepts only a canonical
PadlHub game UUID, expected LK2 revision and canonical subscription instance UUID.
The normal API authenticates the JWT, `games.play` and tenant membership. The production
entry point does not inject the owner; it remains `503 GAME_JOIN_CONDITIONS_DISABLED`.
This source change activates no real-account read, provider write or commercial command.

## Exact selection and ownership

The concrete repository uses a short tenant-scoped PostgreSQL read-only transaction with
local statement timeout 1500 ms. It requires the active tenant/account/unrotated session,
exact trusted VIVA tenant binding, synced actor and subscription integration mappings,
and the current MIRROR roster revision. A future PUBLIC/SCHEDULED 90-minute game must
have four seats, an open join window and SPLIT or SUBSCRIPTION payment mode.

A subscription mapping locates its provider key; it does not prove actor ownership.
The game mapping must contain exactly one raw/hash pair across all aliases, with equal
synced source versions. The hash is exactly
`sha256('phub-local-public-clone-v1:game:' + rawGameId)`. Ambiguity, conflict and drift
fail closed; neither row order nor a Home display label selects a game or product.

The server-only token broker supplies existing user context. The provider adapter proves
its exact mapped profile and one owned instance in a complete page-zero subscription
response. This bounded scenario selects annual HUB product
`db7a5250-7369-4f43-8ac5-9111be24bc74`, ACTIVE/BY_VISITS, at least one visit, no freeze or
hold, exact activation at/before now and event start, and expiration through event end.
Every provided product/owner/instance alias must agree. Moscow purchase-date evidence
must agree and be on/after 2026-09-01 for the handed post-enforcement scenario. This cohort
restriction is not a new general annual-subscription policy. Missing provider product
identity refuses selection; metadata or product titles are never guessed.

No transaction is held during token/provider/LK1 requests. The whole advisory operation
has a 28-second deadline, no retries and bounded streamed bodies. The fixed existing LK1
`POST /lk/subscriptions/game-price-preview` receives only targetKind, owner game ID,
Moscow startsAt, 90-minute duration and one owned subscription ID. It is an advisory
owner read, not a booking or payment POST. The exact production resolver runs again
after evaluation; mapping/source/revision/owned-record drift refuses the response.
The route limits the authenticated tenant/principal to 10 requests per minute; transport
circuits open after three failures for 30 seconds. Logs expose only stable refusal codes.

## Public response and consumer

The SDK and GameDetailView display server eligibility/refusal, subscription application,
amount in minor units or missing price, LK2 revision and expiresAt. Raw game IDs,
provider instance/profile IDs, bearer tokens and records never enter the DTO. The screen
formats minor units; it performs no discount calculation or missing-to-zero substitution.
Selection/revision change or expiration removes the previous advisory price.

LK1 provides no owner revision or payable mandate in this preview contract. Therefore
`ownerRevision` is null, price.confirmed is false, nonBinding is true and
requiresReservationRecheck is true. AVAILABLE requires non-null amount/base, amount at
most base and free + paid minutes equal 90. A refusal has null amount, zero minutes and
an explicit reason. Malformed AVAILABLE never becomes free.

GameDetailView has optional canonical selection and SDK client props. The frozen P1
GamesPage integration has not supplied them in this change; main.ts wiring is also absent.
Commercial JOIN/CREATE/leave, capacity mutation, settlement and subscription write-off
remain outside this source outcome. The token broker may refresh/persist OAuth
infrastructure credentials if later wired; live activation requires its own authority.

## Evidence boundaries

Focused LOCAL tests execute the concrete production resolver with inert Pool/provider
captures, the actual Fastify handler, SDK and GameDetailView. An optional LOCAL test
executes the existing LK1 evaluator from a supplied path only after verifying source hash
`404fc3c087820bc28f794702ead9ddfba4eba62ca72c834729356441fc552243`.
CI without that private source explicitly skips that owner-source proof. The handed
synthetic 12000 RUB total / four shares / 90 minutes / 60 free minutes yields 700 RUB.
It proves source parity for that input, not live game price or provider acceptance.

These tests do not prove physical PostgreSQL RLS/runtime role, live Viva field shape,
LK1 deployed generation, real selected game/subscription coverage, browser rendering,
commercial participation, STAGING, PROVIDER or PRODUCTION readiness.
