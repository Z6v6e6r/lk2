# Support tickets

Support is a `LOCAL_ONLY` tenant-owned aggregate. `/support` is the dedicated user chat/queue;
CUP's technical-support panel owns categorization, priority, assignment, tags, statuses, public
replies and internal notes. Station support remains a separate provider bridge.

## Access and privacy

User reads/commands always qualify the authenticated owner in the same tenant-scoped SQL query.
Other users' tickets return `SUPPORT_TICKET_NOT_FOUND`; UUID existence is not disclosed. User views
mask staff assignment/tags, exclude internal messages/history and cannot search internal tags.
The separate user OpenAPI schemas enforce these properties.

CUP requires its admin audience, `cup-admin` platform, tenant membership, `admin` role and current
`support.read` or `support.manage`. Manage implies read. Each repository operation rechecks an
ACTIVE user's stored access profile and holds the checked grant through the transaction. Replies,
internal notes and metadata writes require `support.manage`; assignment accepts only a currently
ACTIVE same-tenant admin with that permission. Adding strings to the admin permission catalog does
not grant any real operator access. This PR makes no default or live user-permission grant.

Message bodies and subject text remain in the support store. Audit/outbox/notification payloads
never contain message/note bodies. Metadata audits record status/category/priority/assignment and
tag counts/change indicators, without copying staff tag text or content-derived tag hashes. Notification bodies are generic in-app messages;
intent, delivery and inbox rows are created atomically with valid tenant-scoped foreign keys.
Internal notes emit no user notification.

## Commands, bounds and recovery

Every command uses `Idempotency-Key`; replies/metadata updates also require `expectedVersion`.
The canonical request hash includes operation, target ticket (null for create) and parsed body.
A tenant/actor/key transaction advisory lock precedes ledger lookup, including absent receipts.
Exact retry returns the original immutable compact receipt until retention retires it; changed operation/target/body yields
`IDEMPOTENCY_KEY_REUSED`. Fresh admin authorization precedes replay. Receipts contain no message
history and the database requires empty messages/history arrays and at most 8192 serialized bytes.
Exact replay also locks its ticket and rechecks the receipt after that lock, so a concurrent purge cannot return a pre-purge text snapshot. Mismatched active keys are rejected before any ticket lock.
After command success, clients clear the pending command and GET the canonical thread. A failed
refresh does not authorize or trigger another POST.

Actor-bound durable quota windows are serialized across distinct command keys: five new tickets
and thirty user replies per hour; 120 admin commands per hour. Exact replays precede quota checks.
A user may have ten nonclosed tickets; each ticket accepts at most 1000 messages. These limits
return `SUPPORT_RATE_LIMITED` (429), `SUPPORT_TICKET_LIMIT` or `SUPPORT_TICKET_CONTENT_LIMIT` (409)
without side effects. Replying to an existing closed/resolved ticket does not require a new-ticket
slot. Quotas bind tenant/user, so token refresh cannot reset them. A ticket at the message cap
requires a new ticket or an operator disposition; the existing thread remains readable.

Messages use descending timestamp/UUID keyset queries and chronological page output. Cursors keep
PostgreSQL timestamp microseconds to avoid skipped ties. Ticket list cursors include update timestamp
and UUID. Concurrent updates may move a ticket to an earlier list page; refresh the queue to see it.

Resolving a ticket sets `auto_close_at` for 72 hours. Metadata-only updates and internal notes preserve
that deadline. A public agent reply moves it to `WAITING_USER`; a user reply moves it to `OPEN`,
including from `CLOSED`, and clears the deadline. The worker closes only due `RESOLVED` rows using
`FOR UPDATE SKIP LOCKED` and rechecks the predicate under lock. If close wins first, a stale reply
gets `SUPPORT_TICKET_VERSION_CONFLICT`; the user refreshes and explicitly resubmits. If reply wins,
close observes the new state and does nothing. One tenant's failure does not starve later tenants;
the fair cycle rotates its starting offset. No raw ticket content is logged.

Closed conversations are removed after 24 months from the system-generated close timestamp. The
bounded worker locks/rechecks due CLOSED tickets, deletes public/internal messages, removes subject,
assignment and tag text, and retires every old command receipt and content-derived request hash in
one transaction. It retains the ticket UUID/number, category and body-free status history. Retired
keys return `SUPPORT_COMMAND_EXPIRED` (410) and never execute again, even with another body. Clients
refresh canonical state and preserve the user's draft before an explicit fresh command.

Reopening resets the close timestamp; the next close starts a new 24-month lifecycle. The purge
marker lets clients discard cached old pages and show the archived conversation state. A purged
CLOSED ticket cannot accept an internal note or staff tags/assignment until it is reopened. Public
or user replies reopen before inserting new text. A worker failure rolls back the whole purge;
no marker can hide unpurged messages or active receipts. LOCAL/CI evidence does not establish
production activation or actual production cleanup.

## Expand migration and runtime ACL

`0098_support_tickets.sql` adds only the `support` schema/tables/indexes. It is expand-only and
backward compatible with prior binaries. It never assigns user permissions or widens a real runtime
role by itself. Migration/real-target ACL execution needs exact target authority and the existing
migrator process; do not issue direct shared-target grants.

The source-only `supportTicketRuntimeGrantStatements()` and `inspectSupportTicketAclBoundary()` /
`assertSupportTicketAclBoundary()` define the bounded activation inventory. The explicit runtime
role must be NOSUPERUSER/NOBYPASSRLS, have no CREATEDB/CREATEROLE/REPLICATION, no membership allowing
it to assume the migrator owner and no schema CREATE. The migrator owns schema/tables. Runtime
gets schema USAGE and exactly these direct table privileges, without grant options:

| Table              | Runtime privileges     |
| ------------------ | ---------------------- |
| `support.tickets`  | SELECT, INSERT, UPDATE |
| `support.messages` | SELECT, INSERT, DELETE |
| `support.history`  | SELECT, INSERT         |
| `support.commands` | SELECT, INSERT, UPDATE |

There is no ticket/history DELETE, message UPDATE, TRUNCATE/TRIGGER/REFERENCES/default ACL or column
grant. The message DELETE and command UPDATE exceptions support retention only and require four
migrator-owned, enabled SECURITY INVOKER triggers. They reject deletion before a CLOSED ticket is
24 months old, forged/backdated close timestamps, changes to receipt identity/command data, and
any receipt update except exact due-ticket retirement. The ticket purge marker is allowed only
once messages and unretired receipts are gone. The archived-message guard rejects adding text to
a purged CLOSED ticket. Runtime cannot disable triggers or assume their owner. PUBLIC and
unrelated grantees are rejected. All four tables have enabled FORCE RLS and exactly one PUBLIC
permissive tenant policy with identical `USING` and `WITH CHECK`, requiring `app.tenant_id`. Missing
context and cross-tenant operations must fail before activation. The verifier supports PostgreSQL16;
ACL rows reject unexpected privileges, including newer privilege names.

Existing identity, audit and in-app notification prerequisites remain separate: support checks read
identity users/access profiles; SHARE row locks need their existing SELECT/UPDATE privileges; audit
needs INSERT; notifications templates/intents/deliveries/inbox need SELECT/INSERT. No identity update
is executed by support. Verify these existing grants against the authorized runtime inventory.
Before production activation, inventory the existing support-permission assignments, backup/WAL
retention/access and replica policies, and document restoration followed by reconciling/reapplying
overdue cleanup before restored data is served. Primary-table cleanup does not promise immediate
erasure from preexisting backup/WAL/replica copies. No
real permission grant or backup-policy change is part of this PR.
API/worker/realtime currently share the runtime DATABASE_URL by the deployment contract. The worker
uses only `SupportTicketAutoclosePort` in code; this is not a claim of separate worker credentials.

## Disposable physical rehearsal

The fixture is `packages/database/src/support-ticket-repository.pg.test.ts`. It is skipped without
`SUPPORT_TICKET_PG_VERIFY_URL`. Execution also requires `SUPPORT_TICKET_PG_WRITES=AUTHORIZED` and
`SUPPORT_TICKET_PG_RUNTIME_ROLE` matching `support_fixture_[a-z0-9_]+`. The URL must be query-free
loopback PostgreSQL and its database name must end in `_support_verify`.

The caller must first explicitly authorize and provision the fresh disposable database and synthetic
runtime role, separate from every shared/live database. The fixture creates/drops neither database
nor role. It runs the canonical migrator twice (fresh apply/ledger-safe reapply), applies only the
matrix above and explicit synthetic integration prerequisites, checks actual owner/runtime/RLS,
and inserts synthetic tenants/users/tickets. The runtime pool authenticates as the actual restricted
LOGIN role (`current_user = session_user`), not as the owner followed by SET ROLE. The retention
fixture alone temporarily disables the lifecycle timestamp guard inside an owner transaction to
age its synthetic closed rows; it re-enables the guard before commit. This fixture mechanism is
never an application or shared-target operation. Run the database package build first so the migrator
consumes this task's exports, then run the single fixture through Vitest. Never reuse real credentials
or `.env` for this rehearsal. Fixture data stays in the owned disposable database for inspection;
disposal belongs to the explicitly authorized fixture owner.

The physical checks cover same-key concurrent create, replay after version advance, changed hash,
missing tenant context, cross-tenant read/write, owner hiding, guarded retention grants, internal-note
visibility/no notification, fresh grant revocation, compact receipt database constraints,
per-actor concurrent quota, 72-hour preservation, notification foreign keys and overlapping close/reply.
Retention checks cover early deletion/forged timestamps/marker-only denial, immutable receipts,
24-month text/hash removal, archived-note/tag denial, reopen clock reset, and replay/reply overlapping
purge. Physical fixture execution remains owned by the explicitly authorized local fixture operator.
Mock/unit tests remain distinct from physical PostgreSQL evidence.

## Rollback and forward recovery

An application/worker rollback uses the prior immutable binaries and leaves the support schema,
tables, data and FORCE-RLS policies in place. Do not drop tables or delete ticket data. The old
worker stops auto-close and retention work; later forward recovery resumes due-row processing safely. If activation
rollback needs support privilege removal, remove only the exact support grants through the separately
authorized migrator process and exact runtime role, then verify the bounded inventory. No direct
shared-target SQL, default grant or broad permission rollback is authorized by this development PR.
