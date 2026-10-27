# Authenticated phone subject link (0104)

## Boundary

This is an expand-only, default-off authentication repair for an existing PadlHub account. An
already authenticated **client-audience** owner supplies the account's current canonical phone,
receives a fresh Viva OTP, and may add one missing `(issuer, subject)` mapping to that same user.
The phone is never a target lookup key. The flow cannot create, merge or transfer users and cannot
change profiles, phone, roles, sessions, legal acceptances, delegations or `external_entity_map`.

Schema `0104_identity_external_subject_link_commands.sql` adds only durable idempotency receipts.
The application flag and advertised runtime capability are `AUTH_PHONE_SUBJECT_LINK_ENABLED`; both
are false by default. An admin/CUP token, temporary CUP handoff or header alone cannot call these
routes because the existing client JWT/session prehandlers remain the authentication boundary.

## Source of truth and coexistence

- `profile.user_summaries.phone_e164` for the authenticated active user is the canonical phone.
- `integration.external_identity_map (tenant_id, issuer, subject)` is the subject ownership source
  of truth. Existing mappings are never moved.
- `identity.refresh_sessions` proves the presented session and its one current, unrevoked family.
- `identity.external_subject_link_commands` is the durable retry/reconciliation receipt.
- The existing login path and the link path take the same subject advisory lock first. Login keeps
  its existing canonical provider-user lock second. Old applications and normal login remain
  compatible while the new flag is off or during a mixed-version rollout.
- Redis uses the isolated `phub:auth:subject-link:challenge:` namespace and purpose
  `SUBJECT_LINK`. The generic login challenge store cannot read it. Redis holds a phone HMAC, never
  the phone.

## Required read-only preflight

Stop if the target database/cluster, migration ledger, runtime role, current release or activation
owner is not exact. Before any shared-state action, record:

1. Target database/system identifier and the installed API/Web image identities.
2. An exact, checksum-verified ledger through `0103_game_start_notification_scenarios.sql`; `0104`
   must be absent before the forward migration and present exactly once afterward.
3. A fresh recoverable database backup that includes `identity`, `profile`, `integration`, `audit`
   and the migration ledger, plus a tested restore procedure. Backup custody must not expose phone,
   provider subject or tokens in the operator report.
4. Aggregate-only invariants (no row values): duplicate non-null canonical phones = 0; duplicate
   external `(tenant_id, issuer, subject)` = 0; incomplete subject-link commands = 0; target table
   row count = 0 before first activation.
5. `phub_runtime` is login/no-superuser/no-bypass-RLS and has no role memberships. Confirm its
   existing least privileges needed by the transaction: SELECT and one UPDATE-capable column for
   row locks on `identity.users`, `profile.user_summaries`, and `identity.refresh_sessions`; SELECT
   and INSERT plus column `UPDATE(last_seen_at)` on `integration.external_identity_map` (required
   by its row lock and already used by ordinary login); INSERT on `audit.audit_log`. Do not grant
   DELETE, role/admin privileges, schema CREATE, or access to legal/delegation tables.
6. No long transaction or conflicting lock on the receipt, user, profile, refresh-session,
   external-identity or audit relations. The runtime transaction has a 2-second lock timeout and a
   5-second statement timeout; this is a fail-safe, not admission evidence.
7. The API is deployed with the flag still false, the Web UI hides the action, and the authenticated
   context reports `phoneSubjectLink: false`.

Suggested verification queries must return only counts, catalog metadata and privilege booleans.
Do not select phone, issuer, subject, token, OTP, request hash or raw audit rows into an operator log.

## Forward execution

Each trust-boundary action needs its own approved target and immutable release identity.
This source package is not an executable production migration package. Before step 2, the
canonical Timeweb controller needs a separately reviewed closed 0104 operation binding exact
runtime/migrator identities, ledger 107, catalog 108, backup/restore receipt and lease. Its
migrator-role preflight/bootstrap/cleanup must prove only the required temporary `CREATE` on
schema `identity` and `REFERENCES (tenant_id,id)` on `identity.users`, preserve all existing ACLs,
and reconcile ambiguous outcomes without rerunning DDL. No such live authority or receipt is
supplied by this feature. The ordinary runner applies every pending migration: never run it
for this step unless 0104 is the sole pending approved migration.

1. Publish and install application images with the feature flag false.
2. Run the repository migrator once for 0104. The migration creates an empty receipt table, its
   tenant/actor foreign key, two tenant-scoped uniqueness constraints, actor/time index and forced
   tenant RLS. It neither backfills data nor grants runtime access.
3. Verify the exact table/constraints/index/RLS policy and ledger checksum. Expected affected data
   rows are zero.
4. In a separately approved ACL transaction, grant only:

   ```sql
   grant select, insert, update (outcome, completed_at)
     on identity.external_subject_link_commands to phub_runtime;
   ```

   Preserve all existing ACLs and default ACLs. Re-read the normalized ACL and effective
   privileges after commit.

5. Keep the flag off while authenticated route-negative checks prove missing/wrong Origin,
   session intent, audience and active-session binding all fail without Viva or DB side effects.
6. Enable `AUTH_PHONE_SUBJECT_LINK_ENABLED=true` only in an approved API/Web rollout after a Viva
   sandbox or separately approved real-phone acceptance target exists. UI activation and real SMS
   are not authorized by the source change or schema/ACL approval.

No startup code creates tables, indexes or privileges. Do not substitute documentation, generated
contracts, image publication, health checks or CI for the ledger and catalog readback.

## Idempotency, partial execution and reconciliation

- Start challenge ID is derived from tenant, actor, session family and Idempotency-Key. If Viva may
  have accepted the SMS before an error, the challenge and cooldown remain. Same-key retry returns
  the same challenge and never calls Viva again automatically.
- Verify first revalidates a current session in the same family, then reads the durable receipt.
  Same-key replay returns its redacted `linked|unchanged` result without Redis or Viva. A different
  key for the used challenge fails.
- After OTP verification the database transaction takes the shared subject advisory lock, locks
  the active user/profile/presented and current sessions, rereads the unique canonical phone,
  rejects a foreign mapping, inserts only a missing identity mapping, and atomically completes one
  receipt and one identifier-only audit row.
- Transaction failure rolls back mapping, receipt and audit together. A Redis cleanup failure after
  commit remains success; the durable receipt is authoritative.
- Logs, receipts, audit and API responses contain no phone, issuer, subject, OTP, provider token or
  delegation. A missing/drifted phone returns the same generic unavailable class.

Reconciliation for an ambiguous verify response is only a same-key authenticated retry from the
same active family. Never repeat provider verification under a new key and never repair by phone
lookup, merge, transfer or direct mapping write.

## Acceptance and rollback/recovery

Acceptance requires source checks plus disposable PostgreSQL/Redis evidence for exact RLS and
privileges, one mapping/receipt/audit, same-key replay, alternate-key rejection, wrong/expired OTP,
revoked/foreign-family/phone-drift denial, foreign-subject denial, concurrent normal-login/link
serialization, zero forbidden-table writes, and no sensitive output.

Immediate rollback is application-only: set the flag false and confirm capability false. If runtime
access itself must be removed, separately approve and run:

```sql
revoke select, insert, update (outcome, completed_at)
  on identity.external_subject_link_commands from phub_runtime;
```

Do not drop 0104 or delete receipts during rollback: older apps ignore the additive table, and its
history is needed for recovery. Do not automatically delete a successfully linked identity; that
could remove the only valid login subject. A proven erroneous mapping needs a distinct, guarded
data-repair plan tied to exact tenant/user/issuer/subject preimage, backup and audit authorization.
Database restore is reserved for a wider failed migration/corruption event and must reconcile any
post-backup identity links before cutover to avoid silent loss.
