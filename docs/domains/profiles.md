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
authenticated PadlHub user UUID and kept in browser memory only. Profile identity and provider
identifiers are not relayed or written into a PadlHub projection. When that response contains an
HTTPS photo URL on the server-issued media-host allowlist, the browser may fetch only the bounded image bytes with `credentials: omit` and no
authorization header, then send those bytes to the authenticated idempotent
`POST /{tenantKey}/profile/photo` command with the short-lived, one-time user-bound media grant
issued together with the Viva delegated access token. The API validates the grant and image again, strips metadata,
normalizes it to WebP and persists only the PadlHub object mapping. The provider URL is never sent
to or persisted by this client-assisted path. Cross-user reads always stay on the PadlHub API.
The command is rollout-gated by `PROFILE_PHOTO_CLIENT_SYNC_ENABLED`, which defaults to `false` and
must remain disabled until the migration and every compatible worker are deployed.

Before object storage is written, the API reserves the idempotency key, one-time grant, request
digest and content-addressed object key in PostgreSQL and queues that key for delayed GC. Exact
retries resume the same pending command; conflicts and stale grants fail before S3. Finalization
activates the mapping and removes its GC record in one tenant transaction. API and worker writers
share the same per-user advisory lock, and a worker observation newer than the grant wins. Expired
command rows are removed in bounded worker batches after their replay/GC window.

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
must not overwrite the current profile level while replaying old Games snapshots. Legacy import
and roster-sync transactions declare transaction-local `LK_LEGACY_SNAPSHOT` provenance as a
compatibility seam for a later history-trigger migration. That migration must not ship until every
relevant API and worker instance sets the provenance marker and remains a safe rollback target.
Until that second phase, initializing a previously missing snapshot-only summary may still create
one technical baseline point at import time.

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
