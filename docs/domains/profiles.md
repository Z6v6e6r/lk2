# Player profiles

## Boundary

Profile is a server-owned read boundary for player identity, level presentation, privacy and
viewer-specific actions. Clients call only PadlHub APIs and use only PadlHub user UUIDs.

The two reads intentionally serve different purposes:

| Read                                 | Purpose                                           | Private account fields   |
| ------------------------------------ | ------------------------------------------------- | ------------------------ |
| `GET /{tenantKey}/profile`           | migration-compatible authenticated-self aggregate | yes                      |
| `GET /{tenantKey}/profiles/{userId}` | canonical viewer-filtered player card             | only when viewer is self |

Web maps `/profile` to the signed-in user's UUID and `/profile/{userId}` to another player's UUID.
The browser does not select a provider or request a wider DTO.

The owner manages the independently versioned privacy aggregate through
`GET /{tenantKey}/profile/privacy` and idempotent `PUT /{tenantKey}/profile/privacy`. It is
`LOCAL_ONLY`; profile identity and rating can remain `VIVA_PRIMARY` without creating a dual write.

## Visibility tiers

| Tier          | Visible data                                                      | Contact/chat                     |
| ------------- | ----------------------------------------------------------------- | -------------------------------- |
| `BASIC`       | name, PadlHub-owned avatar, level label and assessment state      | locked                           |
| `EXTENDED`    | basic fields plus numeric player rating                           | locked unless separately allowed |
| `INTERACTION` | permitted visible fields plus server-approved action routes       | independently permitted          |
| `SELF`        | complete own level plus `privateAccount` balance and phone suffix | hidden as self-actions           |

The tier is about viewer access. It must never be derived from, or confused with, the target
player's sporting level.

## Access permissions

The profile policy consumes verified permissions:

- `profile.extended.read` reveals the numeric rating;
- `profile.contact.request` enables the mediated contact action;
- `chat.direct.create` enables the direct-chat entry action.

This release does not define the source, lifecycle or commercial meaning of these permissions.
In particular, it does not connect profile access to subscriptions or memberships. Until a
separate contour and ADR establish a source of truth, clients and profile code must treat the
permissions as opaque server decisions and must not derive them from account or product data.

JWT permissions are short-lived hints for the profile read. Contact and chat commands must
revalidate the permission and target policy at execution time, require authorization,
`Idempotency-Key`, audit and a stable error code.

## Target privacy and safety

The target policy can reduce visibility or disable contact/chat even for a permitted viewer. The
stable lock reasons are:

- `ACCESS_REQUIRED`: the viewer lacks the required server permission;
- `PROFILE_RESTRICTED`: the target policy forbids the action;
- `SELF_PROFILE`: the action is not meaningful on the viewer's own profile.

Future block, safety and moderation decisions join this server policy before a capability is
returned and are rechecked by the command. Raw phone/email values are never part of another
player’s `PlayerProfileView`; an enabled contact capability leads to a mediated PadlHub operation.

`profile.privacy_settings` stores `contactPolicy`, `chatPolicy` and an optimistic version under
tenant RLS. Missing rows resolve to `AUTHORIZED` for both actions; this does not expose contact
data and still requires a separate server permission. Owners may change either action to `NOBODY`.

Updates require the authenticated owner, `Idempotency-Key` and `expectedVersion`. Business state,
the command result, `PROFILE_PRIVACY_UPDATED` audit record and
`profile.privacy.changed.v1` outbox event commit in one PostgreSQL transaction. The User API never
accepts a target user id for this command, so one user cannot write another user’s policy.

## Source consistency

`PlayerProfileView` is assembled from one PadlHub-owned profile projection version plus verified
viewer claims. It is never merged from live Viva, cached Home fields and local tables in the same
response. Cross-user reads cannot use the temporary browser-direct Viva transport.

The current implementation reuses the validated local Home profile component as an incremental
read source. The target state is a dedicated profile projection containing the normalized profile
and target privacy version. Moving to that projection is an internal change; the public DTO and
reason codes remain stable.

## Rollout

1. ✅ Ship the read DTO, policy and locked-action UI with deny-by-default permissions.
2. ✅ Add domain-owned privacy preference persistence and its audited self-service command.
3. Define the interaction-access contour, source of truth and permission lifecycle in a separate
   ADR; do not connect subscriptions or memberships before that decision.
4. Implement mediated contact and direct-chat commands with current-state revalidation.
5. Move the source from the Home component to a dedicated profile projection.
