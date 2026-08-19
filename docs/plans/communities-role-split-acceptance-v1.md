# Communities role-split acceptance contract v1

## Status and authority boundary

This document defines a review-only contract for classifying evidence and comparing a proposed
clone-only PostgreSQL role split. It deliberately contains no role name, role OID, current owner,
ACL, grant or membership assertion. Those facts remain `UNKNOWN` until a trusted inventory from
INPUT_C supplies observed evidence. The machine-readable envelope is
[`communities-role-split-acceptance-v1.schema.json`](communities-role-split-acceptance-v1.schema.json).

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

All six categories are mandatory. A concrete review must map each category through a private
evidence channel to both a role-name observation and an OID observation. The tracked envelope keeps
only the SHA-256 of each value and the SHA-256 of its provenance; raw values do not enter Git,
reports, chat or logs.

The mapping also contains all 15 unordered category pairs exactly once, ordered by category token.
Each pair is `SAME`, `DISTINCT`, `UNKNOWN` or `UNOBSERVED`, with a provenance digest only for an
observed `SAME` or `DISTINCT` result. Absence of an observation never implies `SAME`. The pair
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

INPUT_C must be one canonical, UTF-8, LF-terminated, deterministically sorted artifact. The raw-byte
SHA-256 must be pinned independently before review. Its schema and sort versions are part of the
digest. The acceptance envelope requires all of the following:

1. Provenance: producer contract version; clone marker and marker-request digests; confirmed clone
   name-pattern match; clone OID and source OID bindings; redacted cluster system-identifier digest;
   PostgreSQL major `16`; exact object-manifest digest; source ledger digest and count.
2. Normalized categories: roles, membership edges, database ACL, schemas, default ACLs, relations,
   column ACLs, RLS policies, sequences, functions, types and extensions. Every record needs a
   canonical key, observation state, value digest and provenance digest.
3. A complete anomaly list with stable codes and evidence digests. An empty list must be explicit;
   absence of the field is not equivalent to no anomalies.
4. The normalized manifest SHA-256, schema version and deterministic sort version.
5. A deterministic comparison object containing before/after manifest SHA-256 values; changed,
   added and removed counts; and the complete sorted list of forbidden transition codes.
6. A private, independently pinned lookup that resolves the six category identity digests and all
   pairwise identity observations to the observed role names/OIDs for DBA review. It is not part of
   the redacted envelope and must not be committed or pasted into the report.

Until every input above exists and matches the same marker, request, clone OID, source OID, cluster,
manifest and ledger, every role/owner/ACL cell stays `UNKNOWN` and the decision is `FAIL` with
`INPUT_C_INCOMPLETE` or `INPUT_C_BINDING_INVALID`.

## Ownership rules

The before manifest records the observed owner of every in-scope object. The ownership plan then
contains exactly one row per manifest object and no extra row. There is no implicit default:

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

1. Validate the envelope against the v1 schema and independently recompute the INPUT_C raw-byte and
   normalized-manifest SHA-256 values.
2. Verify every provenance binding and require PostgreSQL major `16`. Any false, absent or mismatched
   binding fails.
3. Require the exact six categories, each with `OBSERVED` name, OID and capability fields. Require
   all 15 pairwise relations exactly once. A `REQUIRED_DISTINCT` pair without an observed
   `DISTINCT` result is `REQUIRED_DISTINCT_NOT_OBSERVED`; `UNKNOWN`, `UNOBSERVED` and an absent pair
   are never treated as `SAME`.
4. Require all twelve normalized inventory categories, unique canonical keys and the declared byte
   sorting order. Any `UNKNOWN`, `UNOBSERVED`, duplicate, missing or out-of-order record fails.
5. Require an empty INPUT_C anomaly list and no preimage forbidden condition.
6. Require ownership-plan set equality with the object manifest. Every before owner must be observed;
   every target must be `PRESERVE_CURRENT` or an allowed category under the ownership rules.
7. Build an after manifest by applying only the exact ownership/grant decisions. No create, remove,
   rename, RLS/policy, extension, column ACL or default ACL transition is allowed.
8. Canonicalize before and after with the same schema/sort version; recompute both manifest digests
   and all changed/added/removed counts.
9. Require exact equality between the recomputed comparison and the supplied comparison. Require
   `addedCount=0`, `removedCount=0` and an empty `forbiddenTransitionCodes` list.
10. Require every authorization boolean to be literal `false`. `PASS` remains a review result only.

Suggested stable blockers for input failures are `INPUT_C_INCOMPLETE`,
`INPUT_C_BINDING_INVALID`, `INPUT_C_DIGEST_INVALID`, `INPUT_C_SORT_INVALID`,
`INPUT_C_ANOMALY_PRESENT`, `MAPPING_INCOMPLETE`, `MAPPING_NOT_DISTINCT`,
`MANIFEST_COVERAGE_INVALID` and `NON_DETERMINISTIC_COMPARISON`. Object/grant failures use the exact
forbidden transition codes from the schema.

## Deterministic before/after diff

The producer serializes one UTF-8 LF-terminated record per line. Fields use JSON string escaping;
there is no locale collation, insignificant whitespace or omitted nullable field. Sort records by
the UTF-8 byte order of `(objectKind, canonicalKey, field, ruleCode)`. Sort blocker and transition
codes by UTF-8 byte order and reject duplicates. Hash the exact bytes including the final LF.

```text
COMMUNITIES_ROLE_SPLIT_DIFF_V1
sort_version=<INPUT_C_SORT_VERSION>
before_manifest_sha256=<SHA256>
after_manifest_sha256=<SHA256>
counts changed=<COUNT> added=<COUNT> removed=<COUNT> forbidden=<COUNT>
CHANGE|<OBJECT_KIND>|<CANONICAL_KEY>|<FIELD>|<BEFORE_STATE>|<BEFORE_VALUE_SHA256_OR_NULL>|<AFTER_STATE>|<AFTER_VALUE_SHA256_OR_NULL>|<RULE_CODE>|<PROVENANCE_SHA256>
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
input_c_contract=<VERSION>
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
