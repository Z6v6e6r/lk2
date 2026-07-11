# ADR 0002: Viva anti-corruption layer and per-domain ownership

- Status: accepted
- Date: 2026-07-11

## Decision

Only `@phub/viva-adapter` knows Viva requests and DTOs. PadlHub UUIDs and normalized aggregates are used everywhere else. Each tenant/domain has exactly one ownership mode. Independent dual-write is forbidden.

Direct client reads are a dormant capability, not a default. They require a backend-issued short-lived user delegation, remain read-only and cannot be trusted for commands or pricing. If Viva cannot provide delegation, server-side edge relays may be evaluated only with Viva's contractual approval.

## Consequences

The migration can proceed one domain at a time. Rate-limit pressure is primarily solved by local read models, coalescing, caching, background synchronization, batch methods and webhooks.
