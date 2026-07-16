# ADR 0008: server-owned client routing plan during Viva migration

- Status: accepted, feature-gated
- Date: 2026-07-15
- Amends: [ADR 0005](0005-viva-user-delegation-and-direct-transport.md)

## Context

Until PadlHub owns every user operation, the LK still needs selected Viva End User reads. Sending
all of those calls through shared PadlHub egress can trigger Viva rate or anti-abuse controls. A
temporary mixed transport is therefore required, but the client must not choose the source, receive
a system key or turn a Viva identifier into a public identifier.

## Decision

An authenticated user client requests `GET /user/api/v1/{tenantKey}/routing-plan`. PadlHub resolves
the tenant, user delegation, client platform, global gate and stored tenant mode, then returns a
versioned plan valid for 30 to 300 seconds.

The modes are:

- `PADLHUB_ONLY`: every product operation uses PadlHub APIs;
- `MIXED_END_USER_READS`: only the explicit read vocabulary below uses Viva from the user agent.

The routing vocabulary is read-only and each operation is evaluated independently:

1. `profile.read` -> Viva `GET /v1/{providerTenantKey}/profile`;
2. `bookings.read` -> Viva `GET /v2/{providerTenantKey}/bookings`;
3. `bookings.details.read` -> Viva `GET /v1/{providerTenantKey}/bookings/list`;
4. `subscriptions.read` -> Viva `GET /v1/{providerTenantKey}/subscriptions`;
5. `schedule.read` -> Viva `GET /v1/{providerTenantKey}/exercises`.

Vocabulary does not mean rollout eligibility. `DIRECT_VIVA_CONTRACT_READY_OPERATIONS` is a second,
fail-closed build allowlist shared by the API, operator command and client adapter. At present it
contains only `profile.read`. Viva bookings, booking details, subscriptions and schedule responses
contain provider identifiers and therefore remain on PadlHub APIs even if an invalid stored plan
tries to select them. Enabling one of those reads requires a Viva contract that returns PadlHub
identifiers; disguising, hashing or carrying a Viva ID through the browser is not acceptable.

There is no generic URL executor. Query names and bounds are fixed in `@phub/viva-client-adapter`.
Unknown operations, commands, expired/malformed plans, CUP/internal platforms and users without a
valid delegation always use PadlHub APIs. The browser receives only a short-lived user access-token
in memory; the Viva refresh-token remains encrypted server-side.

The client adapter must normalize a direct response before it leaves the integration boundary.
External identifiers remain in server-side integration storage. An operation remains outside the
contract-ready build allowlist until the provider response, normalizer and staging preflight prove
that no external identifier reaches browser state. One aggregate is never assembled from mixed
source versions.

`GET /user/api/v1/{tenantKey}/bookings/upcoming` is the initial safe bookings boundary. It reads one
PadlHub-owned projection version and returns PadlHub UUIDs only. `/bookings` consumes this aggregate
separately; it does not replace or merge fields in the Home snapshot.

## Failure and load behaviour

The plan itself fails closed to PadlHub. Once a valid mixed plan explicitly selects direct Viva,
Viva `429`, `5xx`, timeout or network failure returns a stable unavailable error. It does not
silently retry through PadlHub backend egress, because that would amplify the exact load this mode
is designed to avoid. A Viva `401` permits one access-token refresh and one replay only.

Viva's current browser CORS policy accepts the tested LK origins and the `Authorization` header but
does not accept `X-Correlation-ID`. Direct requests therefore send only `Authorization`. The client
retains its PadlHub correlation ID locally for redacted telemetry; it never puts tokens or payloads
in logs.

## Server switch

`integration.client_routing_plans` is tenant scoped, protected by forced RLS and starts in
`PADLHUB_ONLY` with an empty operation allowlist. Changes use the dry-run-by-default
`routing:plan:set` command with an explicit `--operations` list, actor UUID, reason, correlation ID
and idempotency key. The plan revision increments atomically with a metadata-only audit record. A
global `VIVA_DIRECT_READ_ENABLED=false` override immediately makes every effective plan
PadlHub-only and prevents issuance of new delegated Viva access-tokens.

The later migration to PadlHub-only requires no LK release: switch the tenant plan, wait through the
maximum plan/token TTL, verify zero direct Viva calls and keep the same product API contracts.

## Consequences

This preserves a bounded escape from shared backend egress without making data source selection a
client concern. Mixed mode is deliberately temporary and operationally visible. It adds plan and
token refresh handling to user clients, while commands, authorization, auditing and write ownership
remain fully PadlHub controlled.
