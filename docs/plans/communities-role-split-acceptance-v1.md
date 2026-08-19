# Communities role-split acceptance contract v1

## Status and authority boundary

This document defines a review-only contract for classifying evidence and comparing a proposed
clone-only PostgreSQL role split. It deliberately contains no role name, role OID, current owner,
ACL, grant or membership assertion. Those facts remain `UNKNOWN` until a trusted inventory from
INPUT_C supplies observed evidence. The machine-readable envelope is
[`communities-role-split-acceptance-v1.schema.json`](communities-role-split-acceptance-v1.schema.json).
The authoritative cross-field evaluator is
[`communities-role-split-acceptance.ts`](../../packages/database/src/communities-role-split-acceptance.ts).
Schema validation alone is insufficient for `PASS`.

This contract does not create or alter a role, change ownership or ACLs, apply a migration, connect
to a database, run the inventory collector, install a command, modify a shared database, deploy an
application or activate runtime behavior. A `PASS` means only that a separately reviewed candidate
is complete and internally consistent enough to request a new, separately versioned execution
design. It grants no execution authority.

The existing `29_V1`, `32_V1`, `33_V1` and `34_V1` rehearsal contracts are frozen. This contract
does not change their confirmations, pending sets, matrix digests, evidence line counts, probes or
`authorizes*=false` boundary. In particular, the report below is a sidecar bound to the exact
`34_V1` evidence bytes; it is not an extra line in the frozen 36-line `34_V1` report.

## Role categories

Categories describe responsibilities, not observed database facts. They never imply that a role
exists, that two categories map to the same or different principals, or that any privilege is
present.

| Category           | Responsibility represented by the category                         | v1 target constraint                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RESTORE_OWNER`    | Principal observed as owner of the isolated clone restore boundary | May own only the isolated clone database and objects explicitly preserved from the restore preimage; its observed capabilities and memberships must still pass the same fail-closed review |
| `RESTORE_EXECUTOR` | Session identity that executes the isolated restore ceremony       | Does not imply ownership or equality with `RESTORE_OWNER`; any identity relation must be observed                                                                                          |
| `SHARED_OWNER`     | Existing owner boundary of the separately named shared database    | Shared database and shared objects are comparison-only and must not change                                                                                                                 |
| `FUTURE_MIGRATOR`  | Candidate release identity for future schema evolution             | May be selected as target owner only per exact manifest object; no wildcard ownership transfer or inferred ACL                                                                             |
| `FUTURE_RUNTIME`   | Candidate application identity for future data-plane SQL           | Must own no database object and may receive only an exact workload-derived object privilege set decided after INPUT_C                                                                      |
| `INVENTORY_READER` | Read-only identity used only to collect redacted catalog evidence  | Must own no object, inherit no other role and receive no write, DDL or grant capability                                                                                                    |

All six categories are mandatory. The producer verifies a private raw name/OID mapping against the
catalog and places only a canonical redacted mapping artifact in each INPUT_C snapshot: category,
name/OID digests, capability booleans, pair relations and evidence digests. Raw values do not enter
Git, reports, chat or logs. The evaluator recomputes `mappingDigest`, requires identical before and
after mapping artifacts, and compares them with an independently supplied expected digest.

The mapping also contains all 15 unordered category pairs exactly once, ordered by category token.
Each pair is producer-derived `SAME` or `DISTINCT` with an evidence digest. Absence of an
observation never implies `SAME`. The pair
`FUTURE_MIGRATOR|FUTURE_RUNTIME` is `REQUIRED_DISTINCT`: until trusted evidence reports
`DISTINCT`, acceptance is `FAIL` with `REQUIRED_DISTINCT_NOT_OBSERVED`. Other pairs are
`ALIAS_ALLOWED`, which means only that this contract does not predetermine the answer; their actual
relation must still be observed before `PASS`.

Each observation has exactly one state:

- `OBSERVED`: the producer queried the exact catalog field, bound it to the clone provenance and
  supplied value/provenance digests. This state does not mean the value is acceptable.
- `UNKNOWN`: the producer attempted the observation but cannot establish one unambiguous value.
- `UNOBSERVED`: the required field was not queried or was omitted from the trusted evidence.

`UNKNOWN` and `UNOBSERVED` carry null value/provenance digests and always fail acceptance. They
must never be replaced with a guessed name, OID, owner, ACL or grant.

## INPUT_C evidence required before a concrete matrix

Both `observedBefore` and `observedAfter` INPUT_C snapshots use
`schemaVersion=communities-role-split-input-c-v1`, `canonicalizationVersion=utf8-byte-digest-v1`
and `sortVersion=sha256-byte-v1`. Each is shared-package canonical JSON plus one LF. External
`beforeArtifactSha256` and `afterArtifactSha256` values are independently pinned outside the
envelope; both normalized-manifest digests are separately recomputed by the evaluator.
The acceptance envelope requires all of the following:

1. Provenance: strict `communities-role-split-clone-marker-evidence-v2`; clone marker,
   marker-request, marker-evidence and `creationReceiptSha256` digests; confirmed clone
   name-pattern match; clone OID and source OID bindings; redacted cluster system-identifier digest;
   PostgreSQL major `16`; exact object-manifest digest; source ledger digest and count.
2. Exactly twelve normalized categories, with no extra category: `roles`, `memberships`,
   `databaseAcl`, `schemas`, `defaultAcls`, `relations`, `columnAcls`, `rlsPolicies`, `sequences`,
   `functions`, `types` and `extensions`. Every record has exactly
   `{objectKeySha256, fieldKeySha256, fieldKind, observationState, valueSha256,
provenanceSha256, semantic}`. Owner, metadata, ACL and extension-member fields for one object share its
   `objectKeySha256`; records are ordered by `(objectKeySha256, fieldKeySha256)`. A null column ACL
   is an empty explicit semantic ACL, not a forbidden grant. Each ACL-bearing object has one stable
   `explicitAcl` and one stable `effectiveAcl` field. Every sorted occurrence binds
   `{granteeCategory, granteeEvidenceSha256, grantorCategory, grantorEvidenceSha256, privilege,
grantOption, occurrenceSha256}`. Principal evidence is a one-way digest of the verified catalog
   identity, so distinct third-party grantors and duplicate ACL occurrences cannot collapse while
   raw names/OIDs remain absent; only anomaly codes carry forbidden semantics.
3. A complete anomaly list with stable codes and evidence digests. An empty list must be explicit;
   absence of the field is not equivalent to no anomalies. The trusted producer must emit an
   anomaly for every observed wildcard/`ALL`, grant option, PUBLIC grant, unclassified third-party
   grantee, column grant, explicit default ACL, forbidden membership/capability, mixed owner or
   unobserved required field; digested values do not waive that obligation.
4. Both normalized manifest SHA-256 values, exact versions and both independently controlled
   external artifact SHA-256 values.
5. The complete redacted mapping artifact embedded in INPUT_C plus an independently supplied
   `expectedMappingDigest`; the acceptance envelope cannot supply a replacement mapping.

Until every input above exists and matches the same marker, request, clone OID, source OID, cluster,
manifest and ledger, every role/owner/ACL cell stays `UNKNOWN` and the decision is `FAIL` with
`INPUT_C_INCOMPLETE` or `INPUT_C_BINDING_INVALID`.

## Ownership rules

The before and after manifests record a distinct `OWNER` field for every in-scope object. The ownership plan then
contains exactly one row per database, schema, relation, sequence, function, type and extension key
digest and no extra row. Each row binds the exact `objectKeySha256`, `ownerFieldKeySha256`, owner
value/evidence digests and observed before-owner category,
an explicit target category or `PRESERVE_CURRENT` and producer evidence digests. There is no implicit
default:

1. The shared database and every object outside the isolated clone are immutable. Any observed
   change is `SHARED_DATABASE_CHANGE_FORBIDDEN`.
2. `RESTORE_EXECUTOR`, `FUTURE_RUNTIME` and `INVENTORY_READER` may never be a target owner.
3. The isolated clone database may remain with `RESTORE_OWNER`; a different target requires
   a new contract. No database ownership change is accepted by v1.
4. Each application-owned schema, relation, sequence, function or type may target
   `FUTURE_MIGRATOR` only through an exact row naming the canonical manifest key and an observed
   before owner. A schema-wide or database-wide rule is forbidden.
5. `PRESERVE_CURRENT` is an explicit target decision, not an omission. `UNKNOWN` and `UNOBSERVED`
   are blockers.
6. Extension ownership and extension membership are preserved exactly. Any extension transition is
   `EXTENSION_CHANGE_FORBIDDEN` until separately designed and reviewed.
7. RLS enablement, FORCE RLS, policy definitions and policy role lists are preservation inputs, not
   an ownership side effect. A change is `RLS_POLICY_CHANGE_FORBIDDEN`.

The contract does not predetermine which manifest objects are application-owned. INPUT_C and a DBA
review must classify every object before a concrete target owner can be selected.

## Exact-manifest grant plan

`grantPlan` contains exactly one row for every observed ACL field of every database, schema,
relation, sequence, function and type, and no row for an extension or an out-of-manifest field.
Empty, partial, duplicate and extra plans fail. Each row contains:

- `objectKind` from the finite lower-case vocabulary `database`, `schema`, `relation`, `sequence`,
  `function`, `type`;
- `objectKeySha256`, `fieldKeySha256`, `beforeStateSha256`, `targetStateSha256` and
  `evidenceSha256` as lowercase SHA-256 values;
- one explicit action: `PRESERVE`, `ADD` or `REMOVE`;
- one of the six abstract grantee categories, never a raw name, `PUBLIC` or an unclassified role;
- exact grantee/grantor evidence and occurrence digests plus a grantor category for `ADD`/`REMOVE`;
  `PRESERVE` carries null entry bindings because it preserves the full field state;
- a sorted, duplicate-free subset of the per-object privilege vocabulary;
- literal `grantOption=false`.

`PRESERVE` has an empty privilege list. `ADD` and `REMOVE` have at least one exact privilege. The
finite vocabulary is database `CONNECT/TEMPORARY`, schema `USAGE/CREATE`, relation
`SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER`, sequence `USAGE/SELECT/UPDATE`, function
`EXECUTE`, and type `USAGE`. Wildcards and `ALL` are not values. `FUTURE_RUNTIME` may never receive
schema `CREATE`; `INVENTORY_READER` may not receive an `ADD` transition.

The evaluator computes exact semantic ACL multiset additions/removals and requires exact equality
with the action, grantee/grantor evidence, occurrence, category, privilege and grant-option tuples
in the plan. An observed `UPDATE` cannot satisfy a declared `SELECT`, a grantor-only transition is
not preservation, and unchanged field keys support both `ADD` and `REMOVE`.
`beforeStateSha256` and `targetStateSha256` must equal those observed values; the evaluator never
manufactures an after state from a transition-description hash. The planned changed set must equal
the actual full twelve-category snapshot delta.

## Forbidden capabilities, grants and edges

Acceptance fails when either the trusted preimage contains an unresolved forbidden condition or the
candidate introduces one. Removing a preimage anomaly is not authorized by this contract; it first
requires a separately reviewed remediation design.

- No category may be `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE` or `REPLICATION` in the
  accepted v1 matrix. A required elevated restore capability must live outside this matrix and be
  separately authorized.
- No membership edge, inherited privilege, `SET ROLE` path or admin option may connect any of the
  six categories or an unclassified third party. Identity sameness is decided only by the complete
  pairwise observation matrix; `FUTURE_MIGRATOR` and `FUTURE_RUNTIME` must be observed distinct.
  `SAME` relations form equivalence classes and every prohibition is inherited by aliases; a
  runtime alias is forbidden from ownership and schema `CREATE` exactly like `FUTURE_RUNTIME`.
- `GRANT ALL`, wildcard selection, grant option and owner-derived substitution for an explicit
  grant are forbidden.
- PUBLIC grants, third-party grants and column-level grants are forbidden for every in-scope
  database, schema, relation, sequence, function and type.
- Creation or mutation of a default ACL is forbidden. An observed explicit default ACL is a preimage
  anomaly and blocks mutation until separately resolved.
- `FUTURE_RUNTIME` may not receive database/schema creation capability. Its relation, sequence and
  function privileges must be an exact per-object workload-derived list; a missing decision is
  `ACL_PRIVILEGE_UNDECIDED`.
- `INVENTORY_READER` may not receive DDL or data-write privileges, grant option or ownership. This
  document does not invent the minimum catalog-read privileges; they must be observed and reviewed
  from INPUT_C.

The authoritative forbidden-code vocabulary is the sorted `x-forbidden-transition-codes` array in
the schema. Producers must not collapse multiple findings into a generic warning.

## Exact decision algorithm

The result is binary. A conforming evaluator returns `PASS` only when all steps below pass; every
other result is `FAIL` with one or more stable blocker codes.

1. Validate the envelope against the v1 schema, verify both external independently pinned INPUT_C
   artifact SHA-256 values, and independently recompute both normalized-manifest SHA-256 values.
2. Verify every provenance binding and require PostgreSQL major `16`. Any false, absent or mismatched
   binding fails.
3. Require the exact producer-redacted six-category mapping artifact, recompute its digest and all
   15 pairwise relations, and apply prohibitions to every `SAME` equivalence class.
4. Require exactly all twelve normalized inventory categories, exact seven-field records, unique object/field
   digests and the declared SHA-256 byte sorting order. Any `UNKNOWN`, `UNOBSERVED`, duplicate,
   missing, extra or out-of-order record fails.
5. Require an empty INPUT_C anomaly list and no preimage forbidden condition.
6. Require ownership-plan set equality with the seven object categories. Every before owner must be
   observed; every target must be `PRESERVE_CURRENT` or an allowed category under the ownership
   rules.
7. Require grant-plan set equality with the six grantable object categories. Reject every unknown
   action, kind, privilege, grantee, grant option, empty/partial/duplicate/extra row or mismatched
   before digest.
8. Join each decision to exact before/after evidence and require the plan changed set to equal the
   observed full-snapshot delta; extension states remain unchanged.
9. Canonicalize both full INPUT_C snapshots with the exact sort version; recompute both manifest digests and all
   changed/added/removed counts.
10. Require byte-for-byte field equality between the recomputed and supplied comparison, including
    an empty `forbiddenTransitionCodes` list. Supplied hashes are never sufficient evidence.
11. Require `status=PASS`, an empty blocker list and every authorization boolean literal `false`.
    `PASS` remains a review result only.

Suggested stable blockers for input failures are `INPUT_C_INCOMPLETE`,
`INPUT_C_BINDING_INVALID`, `INPUT_C_DIGEST_INVALID`, `INPUT_C_SORT_INVALID`,
`INPUT_C_ANOMALY_PRESENT`, `MAPPING_INCOMPLETE`, `MAPPING_NOT_DISTINCT`,
`MANIFEST_COVERAGE_INVALID` and `NON_DETERMINISTIC_COMPARISON`. Object/grant failures use the exact
forbidden transition codes from the schema.

## Deterministic before/after diff

The producer serializes one UTF-8 LF-terminated record per line. Fields use JSON string escaping;
there is no locale collation, insignificant whitespace or omitted nullable field. Sort object-state
records by the UTF-8 byte order of `(objectKind, objectKeySha256, fieldKeySha256)` and diff records by
the same stable tuple. Sort blocker and transition codes by UTF-8
byte order and reject duplicates. Hash the exact bytes including the final LF.

```text
COMMUNITIES_ROLE_SPLIT_DIFF_V1
sort_version=<INPUT_C_SORT_VERSION>
before_manifest_sha256=<SHA256>
after_manifest_sha256=<SHA256>
counts changed=<COUNT> added=<COUNT> removed=<COUNT> forbidden=<COUNT>
CHANGE|<OBJECT_KIND>|<OBJECT_KEY_SHA256>|<FIELD_KEY_SHA256>|<BEFORE_STATE_SHA256>|<AFTER_STATE_SHA256>|<RULE_SHA256>|<PROVENANCE_SHA256>
FORBIDDEN|<STABLE_CODE>
```

`CHANGE` lines are present only for changed fields. `FORBIDDEN` lines contain the complete sorted
set and make the decision `FAIL`. An empty set emits no `FORBIDDEN` line; the header count remains
zero. Raw role names, OIDs, ACL text, policy expressions, object definitions and connection values
are never emitted.

## Redacted `34_V1` sidecar template

The sidecar is separately hashed and retained beside, not inside, the frozen 36-line `34_V1`
evidence. Placeholder tokens are mandatory until trusted evidence exists.

```text
COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_REPORT_V1
staged_contract=34_V1
staged_evidence_sha256=<SHA256>
input_c_contract=communities-role-split-input-c-v1
input_c_canonicalization=utf8-byte-digest-v1 sort=sha256-byte-v1
input_c_artifact_sha256=<INDEPENDENT_SHA256>
input_c_manifest_sha256=<SHA256>
role_mapping_sha256=<SHA256>
role_categories=6 observed=<COUNT> unknown=<COUNT> unobserved=<COUNT>
identity_relations=15 same=<COUNT> distinct=<COUNT> unknown=<COUNT> unobserved=<COUNT> required_distinct_unmet=<COUNT>
before_manifest_sha256=<SHA256>
after_manifest_sha256=<SHA256>
comparison changed=<COUNT> added=<COUNT> removed=<COUNT> forbidden=<COUNT>
anomalies=<COUNT> blockers=<COUNT> decision=<PASS_OR_FAIL>
authorizes_role_creation=false authorizes_role_alteration=false authorizes_acl_mutation=false authorizes_migration=false authorizes_deploy=false authorizes_runtime_activation=false
```

The report is valid only if its `staged_evidence_sha256` hashes the unchanged exact `34_V1`
evidence and every other digest is recomputed from retained evidence. It contains no role name, OID,
owner, ACL, membership, grant, policy expression, SQL, credential, database name or system
identifier.

## Handoff to a future design

After a `PASS`, a future independently reviewed contract may consume the private category lookup,
the normalized before manifest, an explicit ownership plan and a workload-derived runtime privilege
matrix. That future contract must define transaction/rollback behavior and prove the same
deterministic after manifest on a disposable clone. This v1 artifact cannot be used as a provisioner
input, forced command, migration confirmation or deployment confirmation.
