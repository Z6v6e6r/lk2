# ADR 0011: Return viewer-filtered player profiles with server-owned access policy

- Status: Accepted
- Date: 2026-07-17

## Context

The existing `/profile` operation returns the authenticated user's account-oriented aggregate. It
contains balance, a phone suffix and a complete player rating, which is appropriate for the owner
but unsafe as the DTO for viewing another player.

PadlHub needs a stable profile URL for every user while allowing visible data and available actions
to vary by the viewer's access level. Contact and direct-chat actions are especially sensitive:
hiding a phone in React after returning it from the API is not an access-control boundary, and
clients must not implement access policy.

## Decision

1. Keep `GET /{tenantKey}/profile` as the account-oriented authenticated-self aggregate during the
   migration period.
2. Add `GET /{tenantKey}/profiles/{padlHubUserId}` as the canonical viewer-aware profile read. The
   web routes are `/profile` for self and `/profile/{padlHubUserId}` for another player.
3. The API returns a `PlayerProfileView`, not a complete profile plus UI flags. Fields that the
   viewer cannot receive are omitted before serialization.
4. Self-only balance and phone suffix live in optional `privateAccount`. That object is absent for
   every other viewer, including viewers with interaction access.
5. Viewer tiers are `BASIC`, `EXTENDED`, `INTERACTION` and `SELF`. They describe access to this DTO;
   they are not the player's padel rating.
6. The API derives field visibility and action capabilities from verified PadlHub permissions.
   The initial permission vocabulary is `profile.extended.read`, `profile.contact.request` and
   `chat.direct.create`.
7. The source and lifecycle of interaction permissions are intentionally outside this release.
   Subscription and membership state are not read, inferred or connected to profile access. A
   future contour may grant the same neutral permissions without changing this DTO.
8. A target user's privacy policy can only reduce access. It can return
   `PROFILE_RESTRICTED` even when the viewer otherwise holds a permission.
9. `AVAILABLE`, `LOCKED` and `HIDDEN` plus stable reason codes are presentation-safe hints. The
   eventual contact/chat command must revalidate current permission, target policy, block state
   and moderation state; a read capability is never command authorization.
10. Cross-user profile reads are PadlHub-API-only. They never use browser-direct Viva reads and
    expose only PadlHub UUIDs and PadlHub-owned media URLs.
11. Owner privacy is a separate `LOCAL_ONLY` aggregate. Missing rows use `AUTHORIZED`: the owner
    allows an action only if a separate server policy authorizes the viewer. Authenticated self
    updates are optimistic, idempotent, audited and emit an outbox event in the same PostgreSQL
    transaction.

## Consequences

Positive:

- private fields never cross the API boundary for an unauthorized viewer;
- web, mobile and future clients share one visibility policy and one set of reason codes;
- the future access-grant contour can evolve without changing profile components;
- target privacy controls and moderation can fail closed;
- the old self aggregate can migrate incrementally without breaking existing direct-read work.

Costs:

- the source of interaction permissions still needs a separate ADR and domain owner;
- access JWTs must remain short-lived and command handlers must query current policy when needed;
- chat/contact commands require a separate idempotent, audited implementation;
- a dedicated profile projection will eventually replace reuse of the Home profile component.

## Validation

- policy tests prove that other viewers never receive `privateAccount` or a hidden numeric rating;
- API tests cover self, basic-other and explicitly permissioned responses;
- repository/API tests cover default privacy, optimistic conflict, idempotent replay, audit and
  transactional outbox behavior;
- web tests cover `/profile` and `/profile/{userId}` without loading Home;
- OpenAPI/SDK generation and contract lint must pass;
- the complete repository change still requires `npm run check` before promotion.
