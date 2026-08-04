# C-14 — Community content lifecycle and retention

Status: accepted, 2026-08-04.

## Decision

- An author action archives a post or comment; it never hard-deletes business state synchronously.
- `ARCHIVED` content is absent from feed, detail, search, counters and realtime recipient views.
- Archived body, media references and immutable revisions are retained for exactly five years from
  `archived_at`. After that deadline a bounded worker may purge body/media while preserving the
  tombstone and audit metadata. Legal hold, when introduced, overrides purge.
- The author may restore their archived content for 30 days from `archived_at`. Restore after that
  deadline is rejected even though the retained body still exists.
- An author may edit a published post or comment without a time limit. Every edit appends an
  immutable revision; revisions are never overwritten.
- In `MODERATED_FEED`, an edit by a MEMBER changes the material to `PENDING_MODERATION`; staff edits
  follow the publishing capability matrix.
- A moderator action uses `HIDDEN`, not `ARCHIVED`. Restore of hidden content is a separately audited
  moderation command from ЦУП.
- State, revision, idempotency result, audit record and outbox event commit in one tenant-bound
  PostgreSQL transaction.

## Governance decisions used by the content authorization boundary

- A former OWNER becomes ADMIN after normal ownership transfer.
- Emergency ownership transfer is issued only through PadlHub Admin API from ЦУП, requires two
  distinct staff approvals, a mandatory reason and an audit event.
- Unban produces LEFT membership; it never restores ACTIVE access implicitly.

## Consequences

The schema must carry `archived_at`, `restore_until`, `retention_until`, current revision and an
append-only revision table. Feed queries exclude `ARCHIVED`, `HIDDEN` and `PENDING_MODERATION` before
pagination. A retention worker is not permitted to purge a body before `retention_until`, and no
client can select retention or restore timestamps.

The initial content contract is also accepted:

- post body: 1–10,000 Unicode characters;
- comment body: 1–2,000 Unicode characters;
- comments are flat in GA and therefore do not carry a parent/thread identifier;
- reactions are `LIKE` or `DISLIKE`;
- one current reaction exists per tenant, target and user; setting a different reaction replaces
  the previous value atomically, and removal preserves an audited tombstone.
