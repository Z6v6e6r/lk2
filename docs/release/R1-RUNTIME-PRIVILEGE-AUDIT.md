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
