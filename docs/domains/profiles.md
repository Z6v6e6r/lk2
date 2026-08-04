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
The browser does not select a provider or request a wider DTO. The authenticated-self read follows
the server-issued routing plan: a direct Viva result is strictly normalized, bound to the already
authenticated PadlHub user UUID and kept in browser memory only. It is not combined with the local
avatar or written into a PadlHub projection. Cross-user reads always stay on the PadlHub API.

`avatarUrl` is either null or the stable PadlHub path
`/public/api/v1/media/profile-photos/{tenantId}/{deliveryId}`. The opaque delivery UUID is not the
player UUID. The media handler resolves the current private
object under tenant RLS and streams WebP bytes; temporary object-storage signatures never enter
profile rows, Home snapshots or Games card projections.
Home, Games and Activity History read boundaries also replace legacy participant-photo values with
the current opaque delivery path in one batched tenant lookup while older projections are refreshed.

The owner manages the independently versioned privacy aggregate through
`GET /{tenantKey}/profile/privacy` and idempotent `PUT /{tenantKey}/profile/privacy`. It is
`LOCAL_ONLY`; profile identity and rating can remain `VIVA_PRIMARY` without creating a dual write.

Friendships are a separate symmetric `LOCAL_ONLY` aggregate. `GET /{tenantKey}/profile/friends`
lists the authenticated user's friends, `GET /{tenantKey}/profile/friends/{userId}` returns the
relationship state for a player profile, and idempotent
`POST /{tenantKey}/profile/friends/{userId}` creates the relationship. The aggregate stores only
tenant-scoped PadlHub user UUIDs. Its business row, command result, audit entry and
`profile.friendship.created.v1` outbox event commit in one PostgreSQL transaction.

Level history is an immutable PadlHub read-model exposed only to the authenticated owner through
`GET /{tenantKey}/profile/level-history`. `profile.level_history` stores the normalized level label,
optional numeric value and change time under tenant RLS. Migration backfill creates one baseline
point from the existing profile summary; it does not invent earlier dates or levels. Future
`profile.user_summaries` level changes append a point in the same database transaction. The web
opens `/profile/level-history` as a separate protected page and plots date on X and level on Y.
Historical game imports may initialize a snapshot-only player summary, but they never overwrite
`level_label` or `level_value` on an existing summary. In particular, activity-history backfill
must not manufacture level-history points while replaying old Games snapshots.

## Visibility tiers

| Tier          | Visible data                                                 | Contact/chat                     |
| ------------- | ------------------------------------------------------------ | -------------------------------- |
| `BASIC`       | name, PadlHub-owned avatar, level label and assessment state | locked                           |
| `EXTENDED`    | basic fields plus numeric player rating                      | locked unless separately allowed |
| `INTERACTION` | permitted visible fields plus server-approved action routes  | independently permitted          |
| `SELF`        | complete own level plus self-only account fields in the API  | hidden as self-actions           |

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

Adding a friend does not grant contact, chat, extended-profile or commercial permissions.
Friendship state is not derived from subscriptions, community memberships or Viva data.

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

## Multi-sport isolation

The chosen sport is an account context, not a colour theme. A switch from padel to squash must
replace the complete sport-owned slice: level/rating, match history, communities, recommendations,
subscriptions and any future sport-specific permissions. The client must never reuse or relabel a
padel response as squash data, nor merge the two aggregates on one screen.

The current web selector demonstrates this boundary: the squash and badminton screens use their
own artwork and do not render padel memberships, friends, communities, level history or booking
preferences. They deliberately remain empty states until the API supplies server-owned sport
profile projections. Persisting the active sport and serving sport data require an
expand/migrate/contract backend change with tenant-scoped sport identifiers and sport-filtered
profile/community reads.

## Rollout

1. ✅ Ship the read DTO, policy and locked-action UI with deny-by-default permissions.
2. ✅ Add domain-owned privacy preference persistence and its audited self-service command.
3. Define the interaction-access contour, source of truth and permission lifecycle in a separate
   ADR; do not connect subscriptions or memberships before that decision.
4. Implement mediated contact and direct-chat commands with current-state revalidation.
5. Move the source from the Home component to a dedicated profile projection.
