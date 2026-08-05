# C-16 — Community create quota grants and owner limit

Status: accepted, 2026-08-05.

## Decision

- Standard creation permits fewer than three ACTIVE owned communities and no successful create in
  the preceding rolling 24 hours.
- ЦУП may issue a one-use, user-scoped grant only with an admin-audience principal, the exact
  `communities.create.quota.override` capability, an idempotency key, `reasonCode` and `ticketId`.
- A grant contains `DAILY_CREATE_LIMIT`, `ACTIVE_OWNER_LIMIT`, or both, expires exactly 24 hours
  after creation, and only one ACTIVE grant may exist for a user.
- User API accepts no override, grant ID, scope or capability field. The create repository discovers
  an eligible grant server-side and consumes it only after the community and OWNER membership are
  written; the entire operation, command ledger, audit and outbox remain one tenant transaction.
- A grant must cover every exceeded limit. An in-quota creation leaves it ACTIVE.
- Normal ownership transfer always enforces the three-owner limit and never accepts or consumes an
  exception.
- Create, grant issuance and transfer serialize owner-count decisions with
  `community-owner-quota:<tenantId>:<targetUserId>`.

## Consequences

`communities.create_quota_grants` is the canonical grant state and PostgreSQL remains the source of
truth. Grant creation, expiry and consumption emit identifier-only outbox events and durable audit
evidence. `communities.create_commands.quota_grant_id` links the successful create to the consumed
grant while the legacy `quota_override` column remains false for compatibility.
