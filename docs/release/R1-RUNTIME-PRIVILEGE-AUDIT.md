# R1 runtime privilege diagnostic

The closed migration chain106→119 does not supply runtime grants for the14 new tail tables. RLS policies do not grant SQL access. `scripts/r1-runtime-privilege-audit.js` now supplies a catalog-only query and strict offline assessment for the actual API or Worker connection. It does not connect, grant privileges, change schema, select business rows, or admit activation.

Use the actual application connection inside a bounded READ ONLY transaction. `r1RuntimePrivilegeQuery('api' | 'worker')` returns parameterized SQL and source-owned parameters. The query uses current/session user; no caller-supplied role or arbitrary relation enters SQL. Pass the captured JSON to `assessR1RuntimePrivileges()` with the independently observed component, database name and connection role. Do not derive these expected bindings from the incoming capture itself. Keep actual role/capture metadata private, outside Git and CI artifacts.

The read-only collection remains a separate authorized operation. This module supplies no live CLI or credentials. Capture origin, host/container/secret custody, freshness and immutable migration/source binding must be established by the execution owner; a self-consistent JSON object is not authenticated evidence.

## Fixed scope

The audit covers18 new relations from0103–0115 and the reviewed row-lock parents used by these consumers. API and Worker requirements are separate. Worker SELECT on `booking.tournament_local_attempts` is required by the tournament recipient witness. API location binding requires SELECT and a row-lock UPDATE capability. Station/tournament source INSERT belongs to explicit administrative provisioning and is not required from the runtime Worker. Reminder recipient synchronization requires DELETE.

API command completion uses UPDATE only on `identity.external_subject_link_commands.outcome/completed_at`; broad command UPDATE, DELETE or another UPDATE column is rejected, matching the existing phone-subject-link PostgreSQL contract. Monthly launch consumption needs UPDATE on `used_at`. A row-locking SELECT may use UPDATE on any column; a table-wide UPDATE grant is not required for that purpose.

For ordinary SELECT/INSERT/UPDATE requirements, table privilege or effective privilege on every live nondropped column is a sufficient baseline. Partial column privileges produce `COLUMN_SCOPE_REVIEW_REQUIRED`, not an asserted missing grant: a separately reviewed query-column map may prove them sufficient. SELECT on just one column never substitutes for SELECT coverage. DELETE is table-only. The tool never emits GRANT SQL or silently expands permissions.

All18 new relations require ENABLE/FORCE RLS and no PUBLIC DML. Historical parent RLS facts are captured without imposing the new-table FORCE predicate on tenant roots. Unsafe runtime role flags/membership, schema CREATE, assumable schema/relation owners, TRUNCATE/TRIGGER, a changed connection binding, role override or writable/replica capture block the assessment. A separate catalog column count fences truncated column lists before full-column capability is inferred. Missing, duplicate, extra or malformed evidence fails closed.

## Evidence limits

`SATISFIED` means only the fixed catalog requirements are satisfied in the supplied capture. Every result has `activationAllowed:false`. This is not a complete historical DML, audit/outbox, trigger/function, tenant-policy-body, provider-gate or cross-tenant runtime test. Cleaned119 identity/catalog proof, actual role binding, transaction-level negative tests, backup/restore, four-component recovery and business/provider acceptance remain separate.

Unit tests cover identity/shape failures, role and tenant guards, two-column completion, single-use launch, row locks and partial-column classification. The existing owned PG16 tail suite exercises the SQL after both119 golden checkpoints: missing rights, synthetic restricted-role grants, successful diagnostic, missing completion column and partial UPDATE coverage. These fixture-only changes occur after golden comparisons; migration SQL, catalog goldens and live ACLs remain unchanged. Physical results must be reported from the actual CI/local run, not inferred from test source.

## Post119 transaction

`scripts/r1-runtime-grants119.js` supplies a fixed, reversible ACL transaction for the18 new relations and the existing shared `phub_runtime` role. It contains no database connector or live CLI. It does not change parents, roles, credentials, schema privileges, owners, RLS, defaults or application flags. The actual parent capabilities must already pass the connection diagnostic; a missing parent capability requires a separately scoped correction.

Capture `R1_RUNTIME_GRANT_CATALOG_SQL` only after the authenticated119 migration terminal and cleanup. The planner requires the exact119 inventory, ordinary FORCE-RLS tables owned by `phub_migrator`, schema USAGE without CREATE/ownership, no runtime memberships or elevated role flags, and no PUBLIC DML or runtime grant options. Snapshot and receipt custody, database/system/container identity and the common delivery locks remain the caller's responsibility. A JSON plan is not authority to execute.

The source-owned API/Worker matrix produces only missing grants. The one normalization removes broad UPDATE/DELETE and unrelated column UPDATE from `identity.external_subject_link_commands`, preserving only completion columns. This is necessary because existing identity defaults can supply broad rights when the table is created. Every removal and addition is recorded with inverse behavior; no other existing right is removed.

Apply and recovery reconstruct SQL from the matrix and authenticated preimage, never from supplied statements. Both use one bounded PostgreSQL transaction, the fixed migrator role, locks on all18 relations, and full pre/post catalog comparison. An ambiguous connection loss requires catalog reconciliation against these two snapshots before any retry. Recovery rejects unrelated ACL drift and restores only the recorded delta. Null/default ACL representation is normalized to effective explicit grants; recovery promises the original privileges/grantors, not PostgreSQL's internal null representation.

The owned PG16 tail suite exercises actual apply, replay rejection, recovery and reapply after119 golden comparisons. The local unit suite covers scope, command normalization, forged plans, ledger/owner/role/tenant drift and unchanged rights. These source checks do not establish live grants or application acceptance.
