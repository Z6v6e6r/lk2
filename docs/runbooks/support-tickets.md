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

### Compatible runtime activation

The support owner is the pinned `phub_support_owner`: NOLOGIN, NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB/NOCREATEROLE/NOREPLICATION and no membership edges. It owns only the support schema,
its four tables/indexes and four SECURITY INVOKER guard functions; derived toast objects are allowed.
Its DDL capability preflight verifies database CREATE, identity USAGE, column REFERENCES on
`identity.tenants(id)` and `identity.users(tenant_id,id)`, and UUID/PLpgSQL use. This is a capability
minimum, not certification of every effective owner privilege. Role enrollment is a separate,
exact-target management action; the activation commands never create roles or passwords.

`SUPPORT_DATABASE_URL` is the sole activation capability, owned by the platform/release owner.
It must name a distinct restricted LOGIN principal over the same PostgreSQL target as `DATABASE_URL`.
API and Worker use a small separate support pool; support never falls back to the legacy main pool.
Realtime and the ordinary migrator environment must not receive this credential. Review/remove this
compatibility capability when the legacy main runtime role split is completed. It does not enable
station support, FCM or another provider.

Without the capability, authenticated support routes return the existing `SUPPORT_UNAVAILABLE`
503 and Worker never starts or schedules support close/purge. Configured but unsafe credentials
fail startup. Later support failures remain isolated: API support readiness returns 503, Worker
logs a body-free cycle failure and retries its bounded cycle. General authentication and existing
Worker jobs do not depend on support readiness. Health responses expose a separate `supportDatabase`
field only when configured; local contour attestation also binds its credential-free target.

The runtime verifier rejects elevated roles, membership in either direction, any ownership,
database/schema CREATE, unexpected effective table/column/schema privileges, grant options,
unsafe callable definers and support-function EXECUTE. Dependency privileges are column-scoped:

- tenants SELECT(id, active);
- users SELECT(tenant_id, id, status) and UPDATE(updated_at);
- access profiles SELECT(tenant_id, user_id, roles, permissions) and UPDATE(updated_at);
- only the INSERT columns used by support for audit/outbox and notifications;
- only template lookup columns and intent id are readable in notifications.

`UPDATE(updated_at)` is sufficient for PostgreSQL `FOR SHARE OF p,u`; table UPDATE and UPDATE of
status/roles/permissions are forbidden. `supportRuntimePrerequisiteGrantStatements()` is the exact
column inventory. Prerequisite and support grants execute in one ACL transaction, with subset-only
preimage admission and exact post-verification before commit. Unrelated grants are not repaired.
No human support permission assignment is performed by these tools.

The immutable migrator image builds `dist/support-activation.js` and
`dist/verify-support-runtime.js`. They are one-shot tools, not an automatic startup migration.
`support-activation` accepts a protected `PHUB_SUPPORT_ACTIVATION_BINDING` JSON object, current
bootstrap DATABASE_URL, one exact phase and a fresh expiry. It binds DB host/port/name/system id,
bootstrap principal, fixed support owner, runtime role, full ledger checksum and confirmation.
The result hashes the entire canonical binding; it does not claim that a self-supplied operation
hash proves human approval. It never emits DSN/SQL errors, ticket bodies or personal data.

The existing shared bootstrap is explicitly privileged (`EXISTING_PRIVILEGED_BOOTSTRAP`), never
represented as a bounded migrator. The new compatible phases are separate from the frozen old
99→101 controller; its pins and rejection of 102 remain unchanged:

1. `compatibility`: exact 99→101, applying only 0096/0097 under the approved legacy bootstrap.
   Their ownership stays with that executor. This is a separately approved compatibility transition,
   not a bypass or call to the frozen old controller.
2. `migrate`: exact 101→102, applying only 0098 under `SET LOCAL ROLE phub_support_owner`, then
   RESET ROLE before the bootstrap ledger insert. Zero owner default ACLs, capability/ownership,
   RLS/policy/trigger structure and runtime privilege inventory are checked before commit.
3. `acl`: exact102; dependency column grants and support table grants are verified atomically.
4. `verify`: read-only owner/ACL/ledger check. Runtime LOGIN verification uses the separate runtime
   tool and does not require access to `pg_control_system()` or the migration ledger.

All mutations share advisory fence 7140221 with the ordinary migrator, with 5s lock and 120s
statement limits. DDL and ledger are one transaction. Timeout or uncertain command outcome means
STOP and protected readback/reconciliation; never blindly rerun a phase. Partial/foreign ledgers,
foreign namespace/owners/grants and expired bindings are refused.

The support-specific secret delta validator permits only addition of the same SUPPORT_DATABASE_URL
to candidate API/Worker env files. Removing that line must recover every previous env byte.
Realtime/migrator bytes and all FCM/provider settings stay identical. Prepared sets still use the
existing source-bound provisioner, immutable release markers and recoverable atomic swap helper.

Before live work, require exact source/CI/manifest authority, role/credential enrollment, pre99 and
pre101 backup/isolated restore proofs, retained one-shot migration/ACL/runtime receipts, post102
backup/restore plus live ACL proof, the enrolled closed controller, rollback image/secret custody,
and readiness/smoke/observation. These source tools alone are not an enrolled deployment controller.
The existing dump/restore uses no-owner/no-acl: it does not prove restored role grants. Reapply and
verify the exact ACL before serving restored support data. Inventory backup/WAL/replica retention
and reconcile overdue cleanup before restored data is served; primary cleanup does not erase old
backup copies. A permitted rollback leaves schema/data/FORCE RLS intact and uses only an attested gate-safe binary, as described below.

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

The rollback target must be an immutable API/Worker baseline that either contains this separate-pool
shutdown gate or predates all support wiring. The predecessor containing a main-pool support
repository and unconditional support lifecycle is not eligible after 0098: removing the support
secret or revoking its ACL cannot constrain the legacy SUPERUSER connection. Schema presence alone
activates that predecessor's support paths.

Required order: install the gate-safe API and Worker with SUPPORT_DATABASE_URL absent, prove the
exact installed digests and that every old API/Worker process has drained, then execute the
99→101 compatibility phase, 101→102 support migration and ACL phases. Only after restricted LOGIN
verification may the support secret be installed and the support lifecycle enabled. The closed
controller must enforce this order and retain the gate-safe rollback digests; ordinary
migrations-before-process-replacement ordering is not eligible. The standalone database tools do
not prove process drainage or supply this controller authority.

Rollback removes the support secret and stays on the gate-safe baseline. It leaves the schema,
data and FORCE-RLS policies in place; do not drop tables or delete tickets. Forward recovery resumes
due-row processing. Any privilege removal is a separate authorized operation after support processes
stop, limited to the exact runtime role and followed by inventory verification. Disaster restore
is a separate transition and can lose writes after the backup. No direct shared-target SQL,
default grant or broad permission rollback is authorized by this development PR.

The compatibility phase also creates the empty profile contact store and local-password credential
store (0096/0097); it performs no backfill, credential enrollment or provider switch. Existing local
password logins remain invalid without enrolled credentials. The refresh-session identity guard
permits existing revoke/rotation writes; its DDL lock remains bounded by the phase's 5s timeout.

### Activation PostgreSQL fixture

`apps/migrator/src/support-activation.pg.test.ts` requires an explicitly provisioned fresh
loopback database at `127.0.0.1:65439/phub_support_activation_verify`, the synthetic
`fixture_admin` bootstrap, `SUPPORT_ACTIVATION_PG_WRITES=AUTHORIZED` and
`SUPPORT_ACTIVATION_PG_URL`. Its caller must pre-provision phub_support_owner (NOLOGIN) and
support_fixture_activation (restricted LOGIN, synthetic password); the fixture validates these
roles and never creates them. It proves the separate 99→101/101→102 phases, NOLOGIN ownership,
5s lock abort, rollback after DDL and partial ACL, restricted LOGIN and rejected identity updates.
The existing repository fixture also uses the exact column grant helper; for SCRAM it accepts
`SUPPORT_TICKET_PG_RUNTIME_PASSWORD`, never borrowed from the bootstrap URL. These fixtures do not
provision/drop their database or roles, connect to a provider or prove a production deployment.
