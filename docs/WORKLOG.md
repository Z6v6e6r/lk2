# Worklog

## 2026-08-23 — Communities trusted INPUT_C offline Gate 4 preflight

- Added a buildable fail-closed CLI around the existing V13 pure gate verifier. It accepts one
  independently pinned gate and reads only the canonical gate, preparation,
  preparation-verification and connection-descriptor documents through the root-owned no-follow
  evidence reader.
- Bound the actual connection-descriptor file path back to the preparation envelope and rejected
  non-canonical verification bytes, path aliases and gate-pin drift before any producer, credential
  descriptor, output path, PostgreSQL connection or child process can be touched.
- Kept the result review-only: success is `READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY`, every
  execution/mutation authority remains false, and Gate 4 still requires separately reviewed V15
  evidence, approval, clock, ledger, host entrypoint and a separately authorized clean clone.

## 2026-08-23 — Communities disabled V15 staging installation evidence

- Installed and verified the disabled candidate for `4bb4279b4afddf807b829612fd63922b27e4d0da` on staging.
- Exact evidence: manifest `395b33e8b468a14d4eecb4e14e6e4418b90b8d654fe3af802b2cc96bf90ee768`,
  control `f19e4a68e25ed72d561d5cd5cf5ccccd114dbd3db282447fee2e7615e8c44c10`,
  artifacts `705fcda61633d91d958b7993b5bde1f8c418e8cd7049e74ea89de551ebd5cd6d`,
  receipt `87c41cdd2e8fbefae85191d2cdf565d75689d1180826ca9c10736cab9cd2839e`.
- The embedded installer install+verify flow passed. Independent read-only postcheck confirmed: exact thirty-nine payload files,
  root-owned installed tree, `active_link_count=0`, runtime bundle bytes match, and disabled command exit code `78`
  with `EXECUTION_NOT_AUTHORIZED`.
- `authorizes_ceremony=false`, `authorizes_database_mutation=false`, and no activation, key, workflow,
  PostgreSQL access, cleanup, ceremony execution, or runtime mutation occurred.
- No host Node runtime execution was required (`nodeRequired=false`, no installed runtime wiring).

## 2026-08-23 — Communities disabled V15 packaging checkpoint

- Advanced the immutable disabled installation candidate to schema V13 and added six exact
  mode-0444 source snapshots for the V13 gate, V14 request and V15 single-use authorization
  contracts/verifiers. The fixed POSIX installer reconstructs the exact thirty-nine-artifact
  policy under host-control V10 and creates no active link or runtime configuration.
- Advanced the self-contained runtime module to V2 and exposed the reviewed V15 issuer/loader API
  without composing it with the existing producer wiring. The bundle contains no concrete clock or
  durable-ledger adapter, approval, attested evidence, credentials, workflow, CLI or host
  entrypoint; direct execution still exits `78` with `EXECUTION_NOT_AUTHORIZED`.
- Added explicit unresolved bindings for the independent approval/evidence, fail-closed clock and
  durable single-use ledger. Installation remains the only true candidate authorization; ceremony,
  database mutation, role split, migration, deploy and activation remain false. No candidate was
  built from an uncommitted tree, installed, uploaded or exercised against staging/PostgreSQL.

## 2026-08-23 — Communities trusted INPUT_C issuer/loader gate checkpoint

- Added canonical independent evidence, approval, pending-authorization and single-use consumption
  receipt contracts. Evidence is bound without a circular request digest: the V14 request pins the
  exact evidence bytes, while approval separately pins the final request, re-verification and full
  evidence-set digests.
- Added a source-only issuer that re-executes the V14 verifier, validates all ten exact evidence
  bytes and canonical absolute paths, requires distinct issuer/approver/clock/ledger subjects and
  rejects an attestor that aliases any of them. The serialized authorization remains pending and
  grants no authority.
- Added an unwired root-custody loader that reads the request, approval, pending authorization and
  all evidence through the existing root-owned single-link reader. It captures the pinned clock and
  ledger methods, checks time before and after one `consumeOnce` call and returns only an immutable
  in-memory inventory connection/read/artifact-write capability after exact receipt validation.
  Ambiguous ledger results and post-consumption clock failure consume the attempt and are never
  retried.
- This checkpoint supplies no concrete clock or durable-ledger adapter, no independent approval or
  evidence bytes, no package export, CLI, build entry, key, workflow or installed runtime surface.
  Trusted-inventory designation and every role/ACL/shared-database/migration/deploy/activation
  authority remain false; no staging or PostgreSQL access was performed.

## 2026-08-23 — Communities trusted INPUT_C separate-authorization request checkpoint

- Added a canonical review-only authorization request that binds one exact V13 gate and its exact
  independently pinned verification, plus ten ordered evidence subject/content/path pins for the
  installed receipt, runtime, preparation provenance, clean clone, descriptors, executable and
  output custody/absence boundaries.
- The request fixes a one-shot policy (`maximumAttempts=1`, five-minute validity) and requires a
  durable consumption ledger, root-owned evidence, an independent approver and a fail-closed clock.
  Those requirements are policy inputs only; this checkpoint implements none of the four runtime
  controls and creates no authorization receipt.
- Added a pure verifier that re-executes the complete V13 gate verification, compares its exact
  canonical bytes, derives every evidence subject independently and rejects matching evidence,
  preparation or operational path hashes. Raw filesystem path semantics remain explicitly
  unattested for the later issuer/loader.
- Only inventory connection, inventory read and artifact write may be requested. Every actual
  authorization remains false, including trusted-inventory designation, role/ACL/shared-database
  mutation, migration, deploy and activation. The modules have no package export, CLI, build entry,
  filesystem/process/PostgreSQL access or installed runtime surface.

## 2026-08-22 — Communities trusted INPUT_C separate-authorization gate checkpoint

- Added a canonical review subject for one future `BEFORE` or `AFTER` trusted INPUT_C collection.
  It pins the installed-candidate receipt, self-contained runtime bundle, preparation and its
  review-only verification, connection descriptor, producer executable, descriptor paths,
  evidence paths, output paths and fixed timeout policy.
- Added a pure fail-closed verifier that revalidates the complete preparation-verification shape,
  cross-binds marker/request/mapping content and paths to the connection descriptor and rejects
  drift, widened keys, path aliases and output-directory substitution.
- The result is only `READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY`. Every authorization remains
  false; preparation-verification provenance, installed-candidate/runtime/descriptor/output
  custody and independently sourced clone provenance remain explicit non-attestations.
- The gate has no CLI or build entry and imports no filesystem, PostgreSQL or child-process API.
  This checkpoint does not create an authorization receipt, credential, descriptor, output,
  active link, key or workflow and does not access staging or a database.

## 2026-08-22 — Communities trusted-inventory V12 disabled staging installation evidence

- The exact V12 candidate at commit `4f8028e97a28aae32dfedfbd9ac6f4ecbe5fedea` was installed on
  staging and independently read back with receipt
  `9e02af1c5dbbb8c8ff8db1c10055cff63f19ba529f005891359c22e0e5b6e5ce`.
- The post-check retained `status=disabled`, `active_link=false`,
  `authorizes_ceremony=false` and `authorizes_database_mutation=false`. The tar extended-attribute
  warnings were informational; the exact manifest, control and artifact digest checks passed.
- This evidence records the completed disabled installation only. It does not authorize an active
  link, credential, trusted inventory collection, ceremony or database mutation.

## 2026-08-22 — Communities trusted-inventory immutable disabled runtime candidate checkpoint

- Added a dedicated Node 22 ESM build for the reviewed trusted-inventory runtime wiring. The
  checked-in bundle includes its PostgreSQL client dependency, rebuilds byte-for-byte, has no
  package imports, and exports only the reviewed construction surface; direct execution emits the
  fixed `COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED` denial and exits `78`.
- Bumped the private candidate manifest/digest contract to V12 and the dependency-free host control
  ledger to V9. Its exact allowlist appends the runtime-wiring source, the fail-closed module source
  and the self-contained bundle as root-owned mode-0444 bytes.
- Updated the Node and POSIX installers/verifiers for exactly thirty-three controlled artifacts,
  including separate immutable `source` and `runtime` directories. Installation remains the only
  true authorization: no runtime configuration, active link, credential, preparation/evidence
  input, key, workflow, ceremony or database-mutation authority is present.
- This checkpoint performs only local build and verification. It does not generate or install a
  host candidate, access staging or PostgreSQL, collect trusted inventory, run a ceremony, migrate,
  deploy or activate anything. The previously installed immutable V11 candidate remains unchanged.
- Integration verification found that a worktree-level `node_modules` symlink omitted the locked
  package-local dependency tree while producing the checked-in runtime bytes. The bundle was
  regenerated from the physical lockfile installation, and the build now rejects an absent or
  symlinked repository `node_modules` before `tsup` can emit candidate bytes.

## 2026-08-22 — Communities trusted-inventory source-only runtime wiring checkpoint

- Added a one-shot source-only runtime boundary that snapshots the canonical preparation,
  verification, read-only authorization, connection descriptor, evidence paths and output paths
  before any asynchronous dispatch. It cross-binds their exact digests and preserves the original
  credential/producer descriptor identities.
- The boundary accepts only a root Linux process, rejects runtime or descriptor drift, and invokes
  only the fixed supervised-producer composition. Its input data is recursively frozen and the same
  wiring object cannot be replayed after success or failure.
- The module remains absent from `tsup`, package scripts and the installed disabled candidate. It
  owns no file opening, credential reading, process creation, CLI or workflow, and focused tests
  mock the fixed composition without connecting to PostgreSQL or publishing an artifact.
- The previously approved V11 candidate `f5345982e4d6b8024ac814047a236768e7537054` was installed on
  staging with receipt `c6122e1f20531219e9ed0f406b1b34ef32ef86b2b736186fafece86134598903`;
  it remains disabled with no active link and no ceremony or database-mutation authority. This new
  source file is not part of that immutable installation.

## 2026-08-22 — Communities trusted-inventory composition disabled candidate checkpoint

- Bumped the private installation manifest/digest contract to V11 and the dependency-free host
  control ledger to V8. The exact allowlist adds the reviewed supervised producer composition only
  as a root-owned mode-0444 source snapshot.
- Replaced the now-packaged source-composition binding with the still-absent supervised producer
  runtime-wiring binding. Credential FD custody, independently pinned output, marker/evidence/mapping
  inputs and private output custody remain separately required for execution.
- Updated the Node review helper, POSIX installer/verifier and regression coverage for the exact
  thirty-artifact candidate and thirty-two-entry installed tree. Installation remains the only true
  authorization; the candidate contains no Node runtime, compiled entrypoint, credential, key,
  workflow, active link or database authority.
- This checkpoint creates no generated candidate directory and performs no installation, SSH,
  staging access, PostgreSQL access, inventory collection, migration, deploy or activation.

## 2026-08-22 — Communities trusted-inventory supervised producer composition checkpoint

- Added an unwired source-only composition that connects the existing trusted-inventory host to
  one supervised producer process without adding a CLI or migrator build entry. It executes the
  exact producer descriptor as an ESM bundle through the current Linux Node runtime, maps the
  credential descriptor only to child FD 3 and the producer only to child FD 4, disables shell
  execution and supplies an exact password-free environment with session-level read-only and
  timeout controls.
- Bound the three canonical evidence paths to the existing preparation path digests and revalidated
  the canonical connection descriptor before process creation. The concrete wrapper always selects
  the canonical descriptor validator and root-custody file output store rather than accepting those
  collaborators from a caller.
- Added single-use process state, a dedicated process group, idempotent TERM/KILL signaling, bounded
  stdout/stderr and post-KILL confirmation. Focused tests use mocked child processes only; they do
  not execute a producer, open evidence files or connect to PostgreSQL.
- This checkpoint does not update or install the disabled candidate, add an entrypoint, credential,
  key, workflow or independent artifact pin, attest the current Node runtime, or grant inventory,
  trusted designation, ceremony, database mutation, migration, deploy or activation authority.

## 2026-08-22 — Communities trusted-inventory disabled installation candidate checkpoint

- Bumped the private installation manifest/digest contract to V10 and the dependency-free host
  control ledger to V7. The exact allowlist now adds only the trusted-inventory canonical contract
  and host-boundary sources as root-owned mode-0444 snapshots.
- Added five explicit `REQUIRED_FOR_EXECUTION` bindings for the absent credential FD reader,
  supervised producer composition, private output custody, marker/evidence/mapping inputs and
  independent artifact pin. They do not block installation of disabled bytes and cannot grant
  execution.
- Updated the Node review helper, POSIX installer/verifier and regression coverage for the exact
  twenty-nine-artifact candidate and thirty-one-entry installed tree. Installation remains the
  only true authorization; key/workflow/staging access, trusted designation, database mutation,
  ceremony, cleanup, role split, migration, deploy and activation all remain false.
- This checkpoint commits no generated candidate directory, key, workflow, CLI, runtime
  composition or active link. Local candidate build/verify is evidence only; no SSH, staging
  access, PostgreSQL access, inventory collection, installation, migration, deploy or activation
  is performed.

## 2026-08-22 — Communities trusted INPUT_C custody boundary checkpoint

- Added canonical, fail-closed connection, read-only collection authorization and receipt
  contracts for a future independently sourced clean-clone INPUT_C run. The receipt never grants
  trusted designation, role/ACL/shared-database mutation, migration, deploy or activation.
- Added an unwired host library that binds the complete preparation verification, exact producer
  and credential descriptors, fixed timeout/termination behavior, exclusive root-owned publication,
  exact readback, deterministic replay and retained partial-output ambiguity.
- Added focused tests for canonical contract rejection, authority widening, exact replay without
  recollection, one-sided response loss, path drift, noncanonical output, timeout escalation and
  output-directory substitution/custody drift.
- This checkpoint has no CLI or concrete subprocess/credential/PostgreSQL composition and was not
  added to the migrator build entries. No SSH, staging access, database connection, inventory
  collection, role/ACL change, key, workflow, deploy or activation was performed.

## 2026-08-22 — Communities Gate 6 fail-closed remediation checkpoint

- Reclassified the reported restore-role OID gap against current `main`: the clone preflight already
  binds both login and restore-role names and OIDs, and the focused regression remains in place. No
  OID-path code change was required.
- Closed the archive TOCTOU boundary in the descriptor runner and V3 executor. A restore archive is
  now accepted only by a non-root Linux runtime from an already-open, root-owned, single-link
  `root:<runtime-primary-gid> 0440` regular file whose Linux descriptor access mode is `O_RDONLY`;
  exact size and SHA-256 are still checked before and after dispatch. A same-UID mutable `0600`
  archive or root-opened writable descriptor fails before `pg_restore` spawn.
- Removed the privileged `LOCK TABLE pg_catalog.pg_database` statement from the clone-owner marker
  writer. The canonical host's already-held two-key advisory fence remains the cooperative DDL
  serialization boundary; `COMMENT ON DATABASE` supplies PostgreSQL's object lock, and exact marker,
  owner name/OID and system identifier are read back before commit.
- Bumped external-anchor subjects to V2. The Linux-local provider is explicitly
  `REHEARSAL_ONLY`; the production subject is
  `BLOCKED_EXTERNAL_MONOTONIC_AUTHORITY_REQUIRED` and the local factory rejects it before custody
  filesystem access. Whole-host rollback protection remains false and requires a separately chosen,
  reviewed and provisioned external CAS/WORM/monotonic provider before production execution.
- This checkpoint is local code and documentation only. It does not install a candidate, change
  staging, access PostgreSQL, create a key/workflow, authorize a ceremony or mutate a database.

## 2026-08-22 — Communities V10 non-authorizing external-anchor rehearsal readback

- Installed `phub-role-split` V10 input-set candidate
  `0bd3e73bb31eda2dda77b1419cdd3ac86979d987` on staging as a root-owned, non-authorizing
  state: `authorizesCeremony=false`, `authorizesDatabaseMutation=false`, and no active link.
- Recorded immutable pins and runner: `bundle=453c24fbf0403a969fa08b44add03220442e8b8cfe33b588a1ccd4deebc80c1d`,
  `runner=fe82939e7d60075cb676a978ddfcfdf143e5cdd0f5441fca3b517d845b77ad73`,
  `node image sha256:80b4f469419504008b350a81108bfb29950fc12b4714fe397eb12096dd124e71`.
- The corresponding production/rehearsal subjects remain pinned as exact bytes:
  production `078103b490907098b0815185a2442d5744ecf124c89aa92e103b94aef34dff77`,
  rehearsal `035f03b71776c475e90236f90f789d44eb491fa4af67a34289ced9833f42e7cb`.
- V10 rehearsal run with execution candidate `74478e8f2ec91443709159ced1ee123345eb29e6`
  completed as non-authorizing. Run key
  `3c7fac6ed955b674af7d2c1ef9e702243d4fad023622fccafc52e1312c477849` was retained
  root-owned with a one-line canonical JSON report (`764` bytes), SHA-256
  `3e64dd52cded3a41a4570593e2fd412e7cfc681ddddf31f7fff912fe27721514`.
- Report evidence fields: `beforeAnchorCrash=RECOVERED_TO_RESTORE_PENDING`,
  `afterAnchorCrash=RECOVERED_TO_RESTORED`, `completeLocalRollback=STATE_ROLLBACK_DETECTED`,
  `retainedAnchorPhase=RESTORED`, `wholeHostCrashTested=false`, `productionAnchorTouched=false`,
  `authorizesCeremony=false`, `authorizesLeaseRemoval=false`,
  `authorizesDatabaseMutation=false`, `authorizesProductionActivation=false`.
- A later duplicate invocation was blocked with
  `COMMUNITIES_ROLE_SPLIT_ANCHOR_REHEARSAL_OUTPUT_ALREADY_PRESENT`; read-only reconciliation
  confirmed the exact report, `production_anchor=absent`, `container=absent`, and that no retry or
  cleanup was performed.
- The earlier first input bundle `e460eac816dfeba41afd2b4ca3b747eedf9a1ae91786a6557462cfe54f29dce9` failed
  before scenario execution because `pg` remained external to the bundle and was unavailable in
  the networkless runner container. That failed run remains retained; the production anchor and
  database were not accessed.
- V10 gate status: non-authorizing supervision crash rehearsal complete. It validates only
  `SUPERVISED_WORKER_PROCESS` `SIGKILL` behavior and is not a ceremony, whole-host, or database-mutating
  rehearsal.

## 2026-08-21 — Communities V10 external-anchor custody and crash rehearsal gate

- Pinned separate canonical production and rehearsal subjects for candidate
  `74478e8f2ec91443709159ced1ee123345eb29e6`. The production anchor path is under the root-owned
  `/var/lib/phub-role-split-external-anchor` contour and is pairwise disjoint from both the existing
  durable state and backup roots. Exact staging ownership is retained: `phub-preflight` uid/gid
  `998:993` for the anchor/state leaves and `root:993 0750` for the existing backup root.
- Added a custody-bound file-provider constructor and a deterministic rehearsal entrypoint. It
  kills a supervised worker with `SIGKILL` before anchor advance and after anchor advance, proves
  the two exact one-step recoveries, restores the complete local `OWNED` snapshot and requires
  `STATE_ROLLBACK_DETECTED` while the independent anchor remains `RESTORED`.
- Added a root-only Linux/Docker runner that requires exact root-owned mode-0444 bundle and subject
  pins plus an immutable local image ID. It runs as uid/gid `998:993` with no network, read-only
  rootfs, dropped capabilities and three isolated rehearsal mounts. The production anchor is not
  mounted and must remain absent before and after the run.
- This checkpoint tests the `SUPERVISED_WORKER_PROCESS` crash domain only. It does not test a whole
  host/container crash and grants no stale-lease removal, ceremony, database mutation, production
  activation, key, workflow, deployment or staging execution authority.

## 2026-08-21 — Communities V9 external monotonic runtime gate

- Added an independently bound external phase-anchor to the V3 durable state store. The local
  journal is published first, the external anchor advances second and the mutable head is published
  last; the two exact one-step crash shapes reconcile, while a complete local rollback to `OWNED`,
  an anchor rollback or any larger divergence fails before another restore, marker or evidence
  operation.
- Bumped clone-creation and execution authorization envelopes to V2 and bound the exact external
  anchor subject in both contours. The file-backed implementation uses separate private
  process-owner custody,
  append-only phase files, an exclusive retained-on-crash lock, canonical exact bytes and no reset,
  delete or rewrite operation.
- Added the anchor only as a mode-0444 source snapshot in a V9/V6 disabled candidate. The candidate
  still contains no runtime loader, compiled entrypoint, active link, key, workflow, credential,
  connection or execution authority; ceremony and every database mutation remain false.
- No candidate installation, SSH mutation, trusted inventory, ceremony, PostgreSQL operation,
  role/ACL change, migration, deploy or activation was performed by this checkpoint.

## 2026-08-21 — Communities V8 durable continuation and executor-source candidate

- Upgraded the post-restore continuation envelope to V2 and persisted the exact full V3
  attested-evidence SHA-256 only at `EVIDENCED`; restart readback rejects marker-only or replaced
  evidence before consulting the evidence sink.
- Added an append-only, phase-indexed canonical journal beside the replaceable durable head. Every
  read requires the head to equal the latest uninterrupted journal entry; the unique crash state
  with the journal exactly one phase ahead atomically promotes the head, while larger divergence is
  rejected. The continuation reconciles the exact external marker before granting any restored
  marker-dispatch capability. Restart regressions prove zero repeated marker/evidence writes even
  when a complete older journal snapshot must be reconciled.
- Added both the durable continuation host/envelope and the descriptor-pinned restore executor to
  a new immutable V8/V5 disabled candidate. The candidate remains source-only and unwired and
  grants no ceremony, database, role-split, migration, deploy or activation authority.
- Replaced selective JSON line checks in the POSIX installer with deterministic reconstruction of
  the complete canonical manifest from the fixed allowlist and exact control ledger. Freshly
  pinned authorization changes and V7 schema downgrade are rejected before target creation.
- The twenty-six-artifact allowlist, Node verifier, dependency-free shell verifier and installed
  readback reject added files or empty directories as well as missing, linked, special or modified
  entries. Building, verifying or installing this disabled version does not authorize ceremony
  execution or PostgreSQL mutation.

## 2026-08-21 — Communities V6 disabled V3 source candidate

- Bumped the private installation manifest, digest and host-control contracts to V6/V3 and added
  ten exact mode-0444 production-source snapshots for the reviewed V3 durable host, coordinator,
  executable composition, state/authorization envelopes and attested evidence.
- Kept the POSIX installer and installed command fail-closed. The expanded candidate has no Node
  runtime, compiled entrypoint, active link, key, workflow, connection, credential or database
  access, and every execution/database/ceremony authorization remains false.
- The V6 candidate is a new immutable disabled version only; producing and verifying it locally
  does not authorize installation, staging access, inventory, ceremony or database mutation.

## 2026-08-21 — Communities V3 security boundary hardening

- Replaced the V3 attested-evidence V1 shape with V2. Ownership/ACL and source-write-denial
  evidence must now match the exact corresponding bindings in the current host authorization,
  whose digest is carried in the evidence envelope and is already bound by the execution
  authorization. A valid digest from another request, receipt, clone or execution subject is
  rejected before `VERIFIED` persistence and again on readback.
- The executable composition and durable restore coordinator now clone and deeply freeze all
  security-relevant data at their entry boundaries and capture the exact collaborator methods
  before the first asynchronous operation. The coordinator revalidates its immutable authorization
  snapshot immediately before runner dispatch.
- Added regressions for replayed attestation digests, nested authorization/request mutation and
  host/runner method substitution across awaited callbacks. The checkpoint remains code-only and
  does not add a concrete runner, command, key, installation, database access or ceremony authority.

## 2026-08-20 — Communities V3 executable composition checkpoint

- Added separate canonical clone-creation and continuation authorizations. Clone creation can only
  persist `CANDIDATE/OWNED`; continuation independently binds the reviewed host, durable-restore
  authorization, the exact preceding clone authorization and all executable collaborator subjects.
- Added a code-only two-mode V3 composition for the full forward state lifecycle, exact marker
  response-loss reconciliation, evidence resume and a distinct V3 attested-evidence envelope.
- Added the durable restore coordinator that creates its one-shot execution edge only after the
  successful `OWNED -> RESTORE_PENDING` CAS under the held fence, binds one already-open archive
  before and after the runner, and never retries an ambiguous restore.
- This checkpoint has no CLI, environment parser, forced command, credential, workflow or staging
  configuration. It was not added to the installed disabled V5 candidate and authorizes no role or
  ACL change, shared-database mutation, migration, deploy, activation or automatic cleanup.

## 2026-08-20 — Communities V5 installed-count hotfix

- Corrected the dependency-free V5 installer readback from the retained V4 counts to twelve
  controlled artifacts and fourteen installed entries.
- Added platform-independent source-contract assertions for both install/verify control loops and
  the installed file-set count so macOS tests catch this Linux-only shell regression.
- The failed staging attempt remains retained as an unpublished `.incomplete` version; this hotfix
  does not authorize cleanup, retry, inventory, ceremony or database access.

## 2026-08-20 — Communities disabled preparation candidate V5

- Extended the exact disabled installation candidate from nine to twelve artifacts by adding
  immutable source snapshots of the inventory-preparation contract, verifier and CLI.
- Bumped the manifest, digest and host-control versions so the older V4 contour cannot accept the
  expanded file set. The POSIX installer still requires no Node runtime and installs no runnable
  preparation command, credential, evidence or database configuration.
- Installation remains the only true authorization; inventory access, artifact publication,
  ceremony, role/ACL mutation, migration, deploy and activation remain false.

## 2026-08-20 — Communities root-custody inventory preparation

- Added a disabled canonical preparation envelope that binds one future before/after INPUT_C run
  to eight exact root-custody evidence paths and contents plus the planned output path.
- Added a non-executing CLI that validates the envelope and all paths before evidence access, reads
  evidence with the existing bounded no-follow reader and cross-checks the V2 marker
  request/evidence and role-mapping shape.
- External provenance, connection, credential, executable and output-custody claims remain opaque
  and explicitly unattested. The verifier does not read credentials, connect to PostgreSQL, create
  an artifact or authorize inventory/role/ACL/migration/deploy/activation activity.

## 2026-08-20 — Communities trusted-inventory acceptance gate

- Added a read-only acceptance-artifact verifier that binds independently retained canonical
  before/after INPUT_C files to the envelope's embedded snapshots and to one separately pinned,
  canonical digest ledger before running the authoritative cross-field evaluator.
- Fixed the evaluator's comparison check to use canonical object equality, so a valid canonical
  envelope survives a JSON round trip instead of failing because of JavaScript key insertion order.
- The redacted result reports only digests, counts, verified bindings, external-review limitations
  and false authorizations. It does not designate inventory as trusted, build an execution
  candidate, connect to PostgreSQL, create a key or authorize ceremony/database mutation.

## 2026-08-20 — Communities staging mawk compatibility

- Replaced the disabled installer's AWK character-class validation with fail-closed POSIX-shell
  numeric matching. Read-only staging reproduction proved that its legacy `mawk 1.3.3` rejects
  `[[:space:]]` and `[[:digit:]]` even for the valid candidate entry count `14`.
- Added a regression contract that requires the shell validator and forbids AWK POSIX character
  classes in the host installer. The retained root-owned candidate remained disabled; no install
  target, partial target, activation link, ceremony or database mutation was created.

## 2026-08-20 — Communities dependency-free disabled installer

- Replaced the V3 host entrypoint, which required an unavailable `/usr/bin/node` on the ARM64
  staging node, with a V4 POSIX shell installer bound to the exact GNU coreutils paths observed by
  read-only host preflight. Node remains a local candidate-builder/test dependency only.
- Added an independently pinned canonical control ledger. It binds the exact nine-artifact
  allowlist, target-relative paths, modes, byte counts, SHA-256 values and the still-false ceremony
  and database-mutation authorizations without parsing JSON on the host.
- Kept root custody, single-link candidate files, new-version-only publication, retained partial
  state, exact installed readback, durable receipt and denial exit 78. No activation link, key,
  workflow, connection, credential or execution authority was added.
- Local TypeScript and candidate regressions pass. A network-disabled disposable Debian contour
  completed install, read-only verify, denial exit 78 and repeat-install refusal without Node. No
  candidate was transferred and staging was not modified by this checkpoint.

## 2026-08-20 — Communities disabled installable candidate

- Added a V3 candidate that authorizes only a new, versioned, root-owned code installation. It
  contains an exact installer, an always-denied command and read-only source snapshots of the
  reviewed canonical host components; it creates no activation link or runtime configuration.
- The installer requires independent manifest and artifact-set pins, refuses existing or partial
  targets, verifies every candidate byte before mutation, fsyncs and hashes installed readback,
  and publishes only a canonical `INSTALLED_DISABLED` receipt.
- Installation is the sole true authorization. Forced-command/key wiring, staging access,
  ceremony, database mutation, cleanup, role split, migration, deploy and activation remain false;
  all twelve runtime evidence bindings remain mandatory before any future executable candidate.
- No installation, SSH, workflow dispatch, ceremony, database access, migration, deploy or
  activation was performed by this checkpoint.

## 2026-08-20 — Communities canonical evidence security hardening

- Bumped the unwired canonical host authorization to V2. Every one of its twelve evidence files is
  now an exact canonical envelope bound to the candidate commit, marker request, creation receipt,
  complete execution subject, binding subject, payload digest and independently reviewed absolute
  custody path; legacy opaque evidence is rejected even when its digest is copied into a receipt.
- Replaced marker-only publication/readback with an authorization-bound attested envelope. Both the
  ownership/ACL/RLS and source-write-denial attestations are rerun on every recovery observation,
  so a preexisting marker-evidence file cannot advance `MARKED` to `EVIDENCED` by itself.
- Pinned evidence-file operations to one root-owned mode-0700 directory descriptor through
  `/proc/self/fd`, with path/inode/mode/owner rechecks before and after the operation. Bound marker
  writes to the authorized clone-only connection factory and verified database, session/current
  role names and OIDs, and system identifier inside the COMMENT transaction before catalog lock.
- This remains a code-only checkpoint. No composition entrypoint, installation, SSH, staging
  ceremony, role/ACL change, migration, deploy, import or activation was performed; the V2
  installation candidate remains `REVIEW_ONLY`, `installable=false` and non-authorizing.

## 2026-08-20 — Communities canonical host adapter checkpoint

- Added a strict canonical host-authorization receipt and root-owned loader that requires all
  twelve independently supplied evidence byte streams before returning execution authority.
- Added a canonical partial-failure host wrapper, reviewed FD-pinned restore adapter, borrowed
  execution-wide fence semantics, clone-only loopback connection factory, cooperative PostgreSQL
  advisory fence and transactional exact-OID marker writer.
- Added an independent root-only evidence sink plus source-write-denial and ownership/ACL/RLS
  attestation gates. Marker and evidence response-loss tests preserve readback without replay.
- Kept automatic clone cleanup, role/ACL changes, migration, deploy, import and activation false.
  The existing V2 installation candidate remains `REVIEW_ONLY` and `installable=false`.
- Kept the backup custody handoff, dedicated key, known-host pin, real staging roles/connections,
  executable and trusted attestation artifacts outside this checkpoint. No staging access,
  installation, ceremony, inventory collection or database mutation was performed.

## 2026-08-20 — Communities role-split review-only installation candidate

- Added a deterministic local builder/verifier that reads the exact ceremony artifacts from an
  independently supplied lk2 Git commit and emits only a private canonical candidate manifest,
  digest receipt and mode-0600 artifact copies.
- Corrected the candidate to V2 after independent review: Git replacement refs are rejected and
  replacement-object resolution is disabled before exact-commit bytes are read.
- Removed all new install targets and the forced command. The preparation, legacy shell ceremony
  and cleanup files are retained only as `REVIEW_ONLY` source evidence; the existing restore helper
  remains `VERIFY_EXISTING` without overwrite authority.
- Kept the candidate permanently `REVIEW_ONLY` and `installable=false`, with every authorization
  false and twelve exact blockers, including the canonical partial-failure adapter and
  ownership/ACL/RLS attestation.
- Bound the incompatible producer and ceremony archive modes/owners explicitly and requires a
  separately reviewed root-owned atomic custody handoff. No directory ownership, archive, state,
  database, role, ACL or host configuration is changed by this checkpoint.

## 2026-08-20 — Communities real PG16 archive and inventory handoff gate

- Replaced the disposable template clone with a private custom-format `pg_dump`, real TOC readback,
  empty `template0` target and `pg_restore --exit-on-error` through the custody-checked archive
  descriptor, without `--no-owner` or `--no-acl` and with archive session authorization.
- Made the synthetic fixture pre-seed its exact `pg_trgm` security baseline because `pg_dump`
  recreates an extension but does not preserve arbitrary owner/ACL changes on every member; the
  real clean-clone preimage remains mandatory before generalizing that extension step.
- Kept the synthetic owner, ACL, extension, empty-ACL, FORCE-RLS, policy and ledger assertions after
  restore, while retaining exact labelled Docker cleanup and loopback-only SCRAM isolation.
- Extended the same disposable PG16 gate with a real-side-effect failure matrix: a completed
  `pg_restore` whose response is lost remains `RESTORE_PENDING` and is never retried automatically;
  failed pre-marker cleanup retains the exact clone and durable state; marker and evidence response
  loss reconcile by authoritative database/file readback without rewriting either artifact.
- Kept every failure injection in the local test adapter. The unwired production host still cannot
  write a marker, publish evidence or drop a clone, and the matrix grants no installation or
  execution authority.
- Added an INPUT_C artifact verifier that accepts only canonical bytes matching an independently
  supplied SHA-256 and emits a redacted digest/count/boolean report with all mutation, migration,
  deploy and activation authorizations false. The report explicitly does not attest independent
  custody or clean-clone provenance; those remain operator evidence gates.
- Kept actual trusted inventory collection, staging installation, ceremony execution, role/ACL
  mutation, migration, deployment and activation outside this local checkpoint. A trusted artifact
  still requires a separately authorized and independently sourced clean clone and independent pin
  custody.

## 2026-08-19 — Communities role-split clone evidence checkpoint

- Added an isolated local PostgreSQL 16 runner that owns and removes one labelled container, one
  dedicated labelled network and one loopback-only random port, then verifies the real catalog,
  marker readback, receipt restart fence, deterministic INPUT_C output and no-change evaluator on a
  synthetic template clone. It requires checkout-local dependencies and refuses parent/global
  Vitest resolution.
- Fixed real PG16 catalog incompatibilities found by that gate: `name`-typed UNION truncation of ACL
  JSON and invalid empty-array `aclexplode`; extension-managed and implicit type objects are no
  longer duplicated into an impossible ownership/ACL mutation plan.
- Added an uninstalled, two-invocation V2 restore-marker ceremony: CREATE always stops for an
  independently retained creation receipt, while RESUME binds that receipt to the exact clone,
  restore and transactional COMMENT evidence.
- Added fail-closed negative coverage and quarantine-only cleanup; no code path authorizes database
  rename or deletion, and a separate DBA primitive is still required to resolve retained clones.
- Added deterministic INPUT_C inventory, catalog-derived redacted role mapping, structured object
  identities, semantic explicit/effective ACL evidence, and a before/after acceptance evaluator.
- Kept installation, workflow wiring, archive `pg_restore`, trusted inventory collection,
  role/ownership/grant changes, shared migration, deployment and feature activation outside this
  implementation checkpoint. Local template-clone evidence is not a substitute for those gates.

## 2026-08-19 — Isolated Communities rehearsal credential contour

- Replaced direct forced-command access to the shared API/migrator environment files with two
  root-owned, single-line, read-only database credential projections for `phub-preflight`.
- Added a root-only atomic prepare/verify command and a metadata-only realtime-isolation receipt
  that becomes invalid when a bound runtime, override, verifier or projected credential changes.
- Kept role/grant creation, staging installation, rehearsal, shared migration, deployment and all
  feature activation outside this implementation checkpoint.

## 2026-08-19 — Default-off participation command foundation

- Added durable server-owned participation authorization, payment snapshot binding, writer ACK and
  expiry semantics without routing any current writer.
- Added migration 0088, exact tenant RLS, ACL matrix v3, and a new 34-file disposable-clone rehearsal
  contract while preserving frozen v1/v2 and 29/32/33 contracts.
- Kept API and worker flags false by default and production activation fail-closed.

## 2026-08-19 — Exact 33-file CUP projection clone rehearsal contract

- Added a separately versioned `33_V1` clone-only rehearsal for the exact
  `16+5+8+3+1` pending migration chain through `0087_cup_player_level_projection.sql`; the older
  `29_V1` evidence contract remains unchanged and `32_V1` remains fail-closed.
- Bound the ceremony to an immutable 12-relation ACL v2 matrix, a clone-only schema/table grant
  provisioner and pre/post catalog verification under distinct non-privileged migrator/runtime
  identities.
- Added synthetic clone fixtures and a real repository probe for apply, replay, immutable event
  idempotency and cross-tenant RLS, while preserving all false authorization markers. No shared
  migration, deployment, feature activation, roster write or payment action is part of this change.

## 2026-07-30 — Games lifecycle process manager

- Activated the existing server-owned `game.lifecycle.start.v1` and
  `game.lifecycle.finish.v1` scheduled-command path in the worker instead of deriving elapsed state
  in clients or coupling it to Viva Activity History refreshes.
- Lifecycle execution now locks the claimed command and aggregate, verifies the canonical deadline
  and revision, writes the aggregate transition, audit row and outbox event, and completes the
  command in one tenant transaction.
- Added stale-claim recovery, bounded retries, canonical rescheduling for changed revisions or
  deadlines, and sequential start-before-finish processing for workers catching up after downtime.

## 2026-07-30 — Home community rail ten-item bootstrap and cursor continuation

- Expanded both compatibility Home and partial HomeBase community projections from five to ten
  bounded `CommunitySummary` items without changing identifiers or introducing a client-selected
  data source. Added an expand migration that validates the ten-item source constraint before
  removing the previous five-item database limit.
- Restored the authenticated directory hydration removed during the HomeBase transition: ten
  projected summaries render immediately, the first canonical ten-item page replaces that fallback
  and supplies an opaque cursor, and the next page loads near the horizontal scroll boundary. An
  unavailable HomeBase community component now falls back to that canonical directory read.
- Kept the standalone communities directory on twenty-item pages and isolated first-page request
  coalescing by page size.

## 2026-07-29 — HomeBase recovery and trusted Viva egress gate

- Recorded Gate 0 with redacted correlation/status/latency evidence: delegated token issuance was
  `200`, while exact server/worker profile, booking-list and subscription reads returned `403`;
  booking details were not attempted because the list read did not authorize an identifier.
- Accepted additive `GET /home/base` / `HomeBase` semantics: quick actions, locations, additional
  links and capabilities stay local; community/promotion envelopes use `READY`, `STALE` and
  `UNAVAILABLE`, with required `revision`, `observedAt` and `staleAt` on available values. Profile
  is routed separately; balance, messaging, counters, bookings and subscriptions are omitted. The
  partial snapshot has no global `staleAt`.
- Kept the complete `GET /home` contract during expand/migrate and rejected browser relay, immediate
  direct booking/subscription enablement, silent mock/stale fallback and advancing a fresh snapshot
  around an old profile component.
- Made trusted user-delegated server/worker egress plus strict schemas and PadlHub UUID mapping the
  required Gate B before legacy complete-Home Viva components recover or a Viva-backed section is
  added to HomeBase.

## 2026-07-29 — Viva mixed OAuth bootstrap for server-blocked profile reads

- Confirmed by correlation-stage metrics that Viva OAuth token exchange and JWT verification
  succeeded while the server-side End User `/profile` read returned `403`.
- Added a direct-read-gated callback path that can resolve only an already-linked
  `(tenant_id, issuer, subject)` identity and then issue the existing one-time browser handoff.
- Kept new and unknown subjects fail-closed with `AUTH_IDENTITY_LINK_REQUIRED`; this path never
  creates users, trusts browser-supplied Viva identifiers or changes canonical mappings.
- Connected the self-profile page to the allowlisted direct `profile.read` while other-player
  profiles remain server-authorized PadlHub reads, and kept Home in a bounded bootstrap-loading
  state until its single local projection becomes ready.

## 2026-07-18 — Progressive Home controls restored

- Restored the three Home quick actions (`Игры`, `Турниры`, `Тренировки`) and the
  `Мои записи / Абонементы` tabs at the product owner's request so their verticals can be completed
  incrementally.
- Kept truthful server-backed booking cards and restored only an explicit work-in-progress shell
  for those staged sections; no synthetic records or unsupported commands were reintroduced.
- Restored the seven-day booking date filter with dates derived from the user's current week,
  markers derived from real `upcoming` items, and a working all-dates reset.
- Recorded that these visible shells remain a production `NO-GO` until their journeys are complete.

## 2026-07-18 — Viva OTP runtime error boundary repair

- Traced live staging OTP verification by correlation ID: Viva returned `401` and the adapter
  classified it as `AUTH_CODE_INVALID`, while the API incorrectly exposed
  `AUTH_PROVIDER_UNAVAILABLE`.
- Declared `@phub/auth` as a runtime dependency of `@phub/viva-adapter`, preventing the package
  build from embedding a second `IdentityProviderError` class that failed API `instanceof` mapping.
- Added a post-build runtime check that exercises the adapter's `401` path and proves both packages
  share the same error class before an image can pass `npm run check`.

## 2026-07-18 — MVP Home and phone-auth launch safety

- Removed synthetic Home event cards and made the web dashboard render only the bounded server
  `upcoming` projection, including an honest empty state.
- Made client phone verification require and persist versioned legal acceptances, while production
  now rejects unpublished `pending` document versions.
- Preserved a Viva phone grant refresh-token only as an encrypted server-side delegation so the
  worker can build a fresh user's Home projection. Required Viva Home deployments fail closed when
  the provider does not return that credential.
- Added an executable web-first MVP scope, acceptance matrix and release NO-GO gates.
- Removed placeholder section screens and links to unfinished create-game, chat, training,
  tournament, subscription and community-detail journeys; unsupported deep links now fail closed
  at the web router until their complete client vertical is enabled.

## 2026-07-18 — Nano Public and Admin ingress guard

- Routed the PadlHub Public and CUP Admin API boundaries through the Jetson Nginx ingress while
  keeping the Internal API private and preserving User API, realtime and SPA fallback behavior.
- Strengthened the deployment smoke test to require JSON, exact HTTP status and stable semantic
  codes from Public and Admin probes, preventing a successful HTML SPA fallback from masking an
  ingress regression.

## 2026-07-18 — verifiable Nano release identity

- Passed the immutable Git commit SHA into ARM64 image builds as `PHUB_RELEASE`, so the web
  bootstrap manifest identifies the exact source release instead of the generic `development`
  fallback.
- Added a public post-deploy manifest check to the staging workflow. A Nano rollout now fails if
  the served `/manifest.json` release differs from the commit whose image digests were deployed.

## 2026-07-17 — CUP advertising on the LK Home page

- Expanded Home from one placeholder promotion to an ordered deck of active CUP cards while
  retaining the first-card field for backward-compatible rollout.
- Added a bounded worker-side bridge to the existing public CUP `cabinet_home` placement, stable
  PadlHub UUID mapping, tenant-RLS producer state, transactional Home outbox events and delayed
  media garbage collection. The browser still performs only the single authenticated Home request.
- Added metadata-free content-addressed WebP delivery with separate bounded desktop and exact
  750×480 mobile derivatives; legacy asset URLs never reach the client.
- Added accessible automatic rotation that honors the CUP switch, pauses during interaction and for
  reduced motion, plus manual pagination controls and focused source/media/UI regression tests.

## 2026-07-17 — locations editorial vertical slice

- Added a tenant-RLS `LOCAL_ONLY` public location profile aggregate, idempotent/versioned admin
  commands, audit metadata and transactional `locations.profile.changed.v1` events without Viva IDs.
- Published separate CUP Admin and authenticated User Location APIs with PadlHub UUIDs, draft and
  archive isolation, completeness-gated publication and server-computed open status/navigation.
- Added ЦУП → Настройки → Станции with list, search, create/edit, HTTPS gallery, weekly hours,
  amenities, contacts, Home order, publication controls and a mobile card preview.
- Added the cabinet location directory and reference-shaped detail card, plus a touch-native
  scroll-snapped Home locations carousel backed by the stored Home projection.
- Added the worker fan-out from published tenant profiles to existing user Home components, strict
  contracts, regression tests, ADR, domain ownership documentation and a publication runbook.

## 2026-07-17 — games domain and API contract foundation

- Added the dependency-free `@phub/games` kernel with independent lifecycle, roster, viewer,
  payment, result and presentation states plus strict aggregate/card invariants.
- Added one server-owned card policy with explicit registration-closed and waitlist-leave states,
  stable actions and separate safe anonymous projection.
- Published anonymous discovery and authenticated Games OpenAPI contracts. Ten state-changing User
  API commands require correlation, PadlHub JWT, `Idempotency-Key` and stable conflict codes.
- Added durable operation resources for booking/payment work without exposing Viva, booking,
  payment or caller-selected identity identifiers.
- Added 16 strict Games domain events, six provider-neutral internal commands and an explicit
  consumer routing matrix. Events reuse the standard outbox envelope and expose no PII/provider
  fields or complete card payloads.
- Added service-only command submission and read-only event inspection to Internal OpenAPI, with
  generated public/User/Internal types and contract/domain drift tests. No database, handlers or UI
  are enabled by this foundation release.

## 2026-07-17 — games persistence and command foundation

- Added expand-only migration `0023_games_foundation.sql` with twelve Games-owned tables for the
  aggregate, roster/reservations/waitlist, immutable result workflow, invitations, operations,
  card projections, idempotency and scheduled commands.
- Added tenant-aware foreign keys, capacity/active-membership uniqueness constraints, discovery and
  due-work indexes, forced RLS on every table and `LOCAL_PRIMARY` Games ownership.
- Implemented an atomic create repository that stores canonical `PROVISIONING` state, organizer,
  operation, replayable command result, audit, `game.created.v1`,
  `game.provisioning.requested.v1` and the process-manager command in one transaction.
- Added monotonic card projection writes, public keyset reads, bounded `SKIP LOCKED` scheduling and
  worker-owned completion/retry operations.
- Verified all migrations against a clean PostgreSQL 16 database, forced-RLS visibility with two
  tenants, exact idempotent replay/conflict behavior and one aggregate transaction producing one
  audit row and two safe outbox events without the raw idempotency key.

## 2026-07-17 — games concurrent roster commands

- Added persistence-safe join, waitlist, leave and waitlist-leave policies that use canonical game
  facts rather than presentation cards and keep capacity, cutoff and membership rules in one domain
  policy.
- Implemented transactionally serialized roster commands. A final seat can be won only once;
  no-payment/organizer-paid joins become participants, while split/subscription joins create a
  15-minute reservation and a durable expiry command.
- Persisted both successful and rejected user commands with matching idempotent replay, audit rows,
  aggregate revision changes and safe outbox facts in the same PostgreSQL transaction.
- Added explicit waitlist joined, left and promoted facts. Leave and expiry reopen capacity and
  schedule process-manager promotion; promotion revalidates the locked queue head and capacity
  before creating a participant or reservation.
- Added process-manager expiry/promotion handlers with a service principal, replay safety and
  no-op/not-due behavior, plus domain/repository tests for all paths.
- Verified real PostgreSQL races in a disposable `_verify` database: parallel final-seat joins and
  reservations each had exactly one winner, waitlist promotion happened once, reservation expiry
  happened once, and the final audit/outbox state matched the asserted transaction history.

## 2026-07-17 — games roster User API foundation

- Registered explicit join, join-waitlist, leave and leave-waitlist User API handlers backed by the
  roster repository; no generic roster mutation or caller-selected user identity was introduced.
- Required verified JWT tenant membership, the server-issued `games.play` permission,
  `Idempotency-Key`, strict request fields and server-generated correlation/request hashes before
  any command reaches persistence.
- Added stable domain/idempotency error mapping and runtime validation of the operation-shaped HTTP
  response. Immediate commands return `200`; paid reservations return an honest `202 PROCESSING`
  with no fabricated payment URL.
- Added tenant-and-actor-scoped durable operation reads from command idempotency, including exact
  committed timestamps and replayed results.
- Kept production Games repository injection disabled until Commerce can create a durable payment
  next action and consume verified payment confirmation; unconfigured routes fail closed with 503.
- Re-ran the disposable PostgreSQL race scenario and additionally proved the winning operation can
  be read only through its tenant/user ownership; the temporary verification database was dropped.

## 2026-07-17 — games card projector and read API slice

- Added an atomic Games card projector consumer on a bounded quorum queue. Inbox deduplication,
  aggregate/roster dependency reads, monotonic projection write and inbox completion share one
  tenant transaction.
- Built one canonical projection snapshot from Games, active roster/reservations/waitlist, local
  profile summaries and station presentation; no Viva/provider identifiers or client-selected
  sources enter the card.
- Added anonymous public list/detail reads with future public/scheduled isolation, strict filters,
  bounded scan and filter-bound opaque keyset cursors. Public cards remove PadlHub user UUIDs and
  the private result summary before serialization.
- Added authenticated upcoming/history list and owned-detail reads. Viewer membership is selected
  from the same versioned projection JSON; outsiders receive not found, and Messaging-owned
  conversation data remains explicitly null.
- Kept both public/User read repositories unconfigured in production wiring, so the new routes fail
  closed until release verification and load evidence are complete.
- Unit, API, domain, lint and TypeScript checks passed. The extended clean-PostgreSQL projector
  script was prepared, but its rerun was blocked by the execution approval usage limit; the empty
  temporary database was dropped and this postcheck remains open.

## 2026-07-18 — games read PostgreSQL, load and staging-mode gates

- Applied all 25 migrations to a disposable `_verify` database and passed the complete roster and
  projector scenario: one final-seat winner, durable rejection/replay, deterministic waitlist
  promotion, one reservation expiry, projector `applied` then `duplicate`, a two-player snapshot
  and the viewer-owned upcoming read.
- Removed overlapping `pg` queries from the projector transaction. Participant, reservation and
  waitlist dependencies now read sequentially on the single transaction connection.
- Added a reproducible 10,000-card read load script. At concurrency 20 over 200 operations per
  surface, public p95 was 85.2 ms and viewer p95 was 56.9 ms against a 200 ms target; two keyset
  pages returned 200 unique cards.
- Added `GAMES_READ_ENABLED=false` as a fail-closed runtime gate. It may be enabled in staging but
  configuration rejects it in production until the production gate is explicitly lifted.
- Started a separate staging-mode API process against the verify database and received readiness
  `200` plus a public Games list `200` with 20 cards, a next cursor, the public cache policy and no
  participant user UUID. The temporary process was stopped after the smoke.
- The required full `npm run check` gate passed: formatting, lint, all TypeScript targets, OpenAPI,
  66 test files with 364 tests, all packages/apps builds and runtime imports. The three existing
  OpenAPI warnings remain non-blocking.
- Dropped `phub_games_cards_20260718_verify` after the checks, confirmed it is absent and confirmed
  the normal local PostgreSQL service remains healthy. No remote staging or production runtime was
  changed by this verification.

## 2026-07-17 — viewer-filtered player profiles

- Added the canonical `/profiles/{padlHubUserId}` User API while retaining `/profile` as the
  migration-compatible self aggregate.
- Introduced a server-owned `PlayerProfileView` policy with `BASIC`, `EXTENDED`, `INTERACTION` and
  `SELF` access tiers and stable capability lock reasons.
- Moved balance and phone suffix into an optional self-only `privateAccount`; other viewers never
  receive those fields, and numeric rating is omitted without extended access.
- Added separate server permissions for extended data, mediated contact and direct chat. Target
  privacy can still fail closed, and future commands must revalidate current access.
- Added `/profile/{userId}` UI routing, neutral locked-action states and privacy wording
  without loading or merging the Home dashboard.
- Updated the canonical OpenAPI, generated SDK contract, policy/API/web regression tests, ADR and
  profile domain documentation.
- Added the `LOCAL_ONLY` tenant-RLS profile privacy aggregate with `AUTHORIZED`/`NOBODY` policy,
  optimistic/idempotent self-service updates, audit and transactional outbox event.
- Applied persisted target policy to viewer-filtered reads and added owner switches for contact and
  direct chat on `/profile` without exposing raw contact data.
- Explicitly left the source of interaction permissions outside the profile contour: subscriptions
  and memberships are not read, inferred or connected until a separate architecture decision.

## 2026-07-17 — community directory foundation and legacy read bridge

- Reduced the Home community summary to five stable fields plus PadlHub UUID/route, removed role,
  member count and presentation color, and kept continuation cursors out of the Home response.
- Added canonical tenant-RLS community and membership tables that prevent duplicate active owners
  and provide an expand-only `LOCAL_ONLY` ownership foundation.
- Added a shared community domain package with strict summaries, deterministic pinned/activity
  ordering and opaque keyset pagination.
- Published the protected `/communities/mine` User API/OpenAPI/SDK operation and a responsive LK
  directory that loads 20 memberships and continues on demand without requesting Home.
- Added an explicit temporary legacy read mode. Server-resolved identity is sent only from the API;
  returned memberships are mapped to PadlHub UUIDs and stripped of phones, client IDs, members,
  graph connections, invites and legacy media URLs.
- Added response limits, timeout, bounded retry, circuit breaker, redacted metrics and normalized
  short caching around the current LK source. Mock memberships are forbidden in production.
- Kept rollout backward-compatible with persisted Home snapshots by normalizing the previous
  community-card shape until all projections have been rebuilt.
- Applied migration `0018` locally, activated `COMMUNITIES_READ_MODE=legacy`, recreated the API
  with the existing Web Push secrets override and verified the authenticated `/communities` page:
  18 current memberships, PadlHub UUID routes, no UI error and a successful redacted legacy read.
- Replaced the seeded Home community component with a background producer fed by the same real
  directory. The worker persists a five-item normalized source component, advances safely beyond
  older revisions and emits it through outbox/projector without adding legacy fan-out to Home.
- Applied migration `0019` locally and verified the full projection path: worker source revision 2
  produced `home-v1-236`, and authenticated Home rendered five real memberships with no seeded
  community cards remaining.
- Added the community-logo media bridge: legacy logo URLs stay worker-only, while allowlisted images
  are bounded, converted to WebP and stored under content-addressed PadlHub UUID object keys.
- Added tenant-RLS logo mapping and delayed object-GC state in migration `0020`. Logo metadata and
  the Home community component commit together; unchanged assets are reused and transient failures
  retain the last local logo.
- Split community projection into its own bounded worker cycle so a Viva authentication/provider
  outage cannot block community membership or logo refresh.
- Applied migration `0020` locally and imported all five visible Home logos from legacy relative
  media paths. Verified private `image/webp` objects at 512 by 512, component revision 5,
  `home-v1-243`, five rendered Home images and the same five local images in the 18-item directory.
- Made Home community labels deterministic two-line captions with balanced word-boundary splits,
  per-line ellipsis for long text and vertical centering for single-word names without changing the
  fixed community-section height.
- Turned the Home community row into a touch-native horizontal carousel. It keeps the five-item
  Home snapshot as an immediate fallback, hydrates the row from the real membership directory and
  automatically requests the next opaque-cursor page when the user swipes near the end.
- Extended the bounded community worker read across every directory page so local WebP logo
  mappings are prepared for carousel items beyond the five summaries retained in the Home snapshot.
- Added explicit desktop mouse dragging to the Home carousel. Native touch/trackpad scrolling stays
  enabled, drag movement suppresses the following link click, and scroll snapping pauses while the
  pointer is held so the row follows the cursor directly.

## 2026-07-16 — CUP manual notification campaigns

- Replaced the CUP placeholder with an authenticated notification workspace at port `5174`:
  recipient phone preview, Web Push/Android/iOS capability cards, optional in-app delivery,
  message composition and accepted-campaign result.
- Added the dedicated `phub-admin` JWT audience. Admin API requires both role `admin`, permission
  `notifications.manage` and the CUP platform header; normal client tokens have administrative
  claims stripped.
- Added tenant-RLS access profiles and manual campaign/recipient/idempotency tables. Phone inputs
  are normalized for lookup but are not persisted; ambiguous duplicates fail closed.
- Added capability, recipient-resolution and idempotent campaign Admin API operations. Campaign,
  intents, inbox, push deliveries, audit and identifier-only outbox events commit in one
  transaction; APNs/FCM remain explicitly unavailable.
- Added a dry-run/apply/audited access-grant command and documented CUP enablement and rollback.
- Added a fail-closed local-only CUP OTP override so Docker can keep Viva sandbox projections while
  one explicitly configured, already-authorized operator signs in without a real SMS. Non-local
  configuration is rejected and normal web/mobile auth remains on Viva.
- Applied migration `0017` locally, granted the internal operator, started the Docker CUP and ran a
  live campaign: one inbox delivery reached `DELIVERED`, one Web Push reached `SENT`, and the same
  idempotency key replayed the original campaign.

## 2026-07-16 — iPhone-safe authentication entry

- Diagnosed the Viva OAuth failure before the PadlHub callback: iPhone attempts launched from
  Telegram reached Keycloak but lost its restart cookie during the external identity-provider
  round trip.
- Made phone OTP the default unauthenticated entry on iPhone and iPadOS while preserving explicit
  access to VK ID and Yandex OAuth.
- Added visible Safari guidance before external OAuth on iOS, kept the same preference after logout
  and covered iPhone, iPadOS desktop mode and non-iOS behavior with regression tests.

## 2026-07-16 — Web Push/VAPID notification vertical slice

- Added encrypted, per-installation Web Push subscription storage with durable registration and
  revocation idempotency, tenant RLS, user attribution and audit records that never contain the
  plaintext endpoint or subscription keys.
- Added protected User API/OpenAPI/SDK operations for capabilities, subscription registration and
  revocation, plus a browser notification screen, explicit permission flow and same-origin service
  worker for display and deep-link navigation.
- Extended notification projection to create PUSH deliveries only when both the tenant Web Push
  gate and an active matching provider account exist; in-app delivery remains independently
  available.
- Added the VAPID adapter with bounded payloads, timeout, retry/backoff, a provider-account circuit
  breaker, terminal subscription invalidation, delivery attempts and honest `PROVIDER_ACCEPTED`
  receipts.
- Added dry-run-by-default commands for the provider account and tenant gate. Global, tenant and
  provider gates remain disabled until sandbox credentials and the rollout smoke tests are approved.
- Added file-backed runtime secret loading and a local provisioner that creates protected VAPID and
  endpoint-encryption files outside Git, then mounts them through a Docker Compose secrets override.
- Applied migration 0016 to the local development database, recreated API/worker/web with the
  sandbox override, activated the `local-padel` Web provider account and tenant gate, and verified
  live capability plus encrypted register/replay/revoke behavior. Provider acceptance/display still
  requires a real user-granted browser subscription.
- Enabled the matching in-app gate after the live `/notifications` screen exposed a `404` inbox
  dependency, and made the Web screen tolerate independent inbox/config/browser-state failures
  instead of replacing all working controls with one generic error.

## 2026-07-16 — Repeat Viva OAuth delegation repair

- Diagnosed callback failure `23505` after a successful Viva token exchange: a legacy delegation
  still belonged to a duplicate PadlHub user while the canonical Viva profile resolved to the
  reconciled user.
- Made delegation persistence idempotent by serializing replacement per canonical user/issuer,
  removing an obsolete subject for that user, and transferring the issuer/subject-owned row to the
  canonical PadlHub user in the same transaction.
- Added a regression test covering the canonical-user transfer conflict path.
- Removed query strings from structured request logs so OAuth `code`/`state` values and other
  sensitive query parameters never enter application logs.
- Scoped profile-photo storage validation to the worker so enabling Home synchronization cannot
  crash API/realtime processes that never receive MinIO credentials.
- Wired the staging worker to the existing private Nano MinIO using Compose-time credential
  projection, kept the bucket private behind signed URLs, and added bounded multi-process readiness
  diagnostics before public smoke tests.
- Added explicit ESM package exports for `@phub/auth/viva-delegation` and a post-build runtime import
  gate after the ARM64 image exposed that dev-time TypeScript resolution had masked the missing
  production subpath contract.

## 2026-07-16 — first in-app notification vertical slice

- Added a tenant-gated RabbitMQ notification projector that resolves active rules/templates,
  validates an explicit event-user audience, renders an immutable snapshot and writes intent,
  in-app delivery, inbox item, audit and identifier-only outbox events atomically.
- Added durable consumer deduplication, per-user preferences, inactive-user rejection and a shared
  push delivery port while keeping Web Push, APNs and FCM runtime gates disabled.
- Added the protected, non-cacheable notification inbox API with newest-first opaque pagination and
  a user-scoped unread count.
- Added an idempotent, monotonic and audited read-cursor command with durable replay/conflict state
  and a stable outbox event for downstream counters.
- Published the User OpenAPI/SDK surface and a dry-run-by-default, actor-attributed operator command
  for enabling or disabling the in-app gate on one tenant.

## 2026-07-16 — PadlHub-owned profile photo synchronization

- Added strict support for Viva `profile.photo` as a server-only integration input.
- Added bounded HTTPS fetching with a CDN host allowlist, timeout, redirect validation, byte and
  pixel limits; images are autorotated, resized, stripped of metadata and encoded as WebP.
- Added private S3/MinIO content-addressed storage and short-lived signed delivery URLs, using
  separate internal and client-reachable endpoints.
- Added tenant-RLS photo sync metadata with source validators, SHA-256 and object key. The local
  profile URL, sync metadata and Home profile outbox component now update atomically.
- Reused unchanged objects through conditional requests, retained the local avatar on transient
  failures, cleared it when Viva removes the photo and deferred superseded-object deletion until
  signed URLs and stale projections can no longer reference it.

## 2026-07-15 — server-owned mixed Viva client transport

- Added a protected, short-lived and versioned `GET /user/api/v1/{tenantKey}/routing-plan`
  contract. The server, not the LK, selects `PADLHUB_ONLY` or `MIXED_END_USER_READS`.
- Restricted direct Viva transport to five explicit GET operations. Commands, CUP/internal clients,
  unknown operations, missing/expired plans and users without a valid delegation fail closed to the
  PadlHub API.
- Added the browser transport executor with strict URL/query construction, in-memory user access
  tokens, one 401 refresh and no hidden backend fallback after Viva 429/5xx responses.
- Added tenant-RLS routing plan storage and a dry-run-by-default, idempotent, actor-attributed,
  audited switch command. The global direct-read gate remains disabled until the full staging
  preflight and PadlHub UUID normalization are proven.
- Verified Viva browser CORS for the configured LK origins. Viva currently accepts
  `Authorization` but not `X-Correlation-ID`, so direct requests send only the permitted header and
  retain correlation locally for client telemetry.
- Added per-operation rollout in migration 0012, keeping existing plans on an empty safe allowlist.
  Implemented the first complete `profile.read` slice: canonical `/profile` fallback, strict Viva
  schema validation, removal of the external profile ID, rebinding to the authenticated PadlHub UUID
  and a dedicated `/profile` screen that never requests or merges the Home snapshot.
- Added a second fail-closed contract-readiness allowlist shared by API, operator tooling and the
  browser adapter. Only `profile.read` is currently direct-capable; bookings, details, subscriptions
  and schedule stay behind PadlHub even if storage is misconfigured because Viva exposes provider
  identifiers in those payloads.
- Added the protected `/bookings/upcoming` PadlHub aggregate and `/bookings` screen. The response is
  bound to one Home projection version, contains only mapped PadlHub UUIDs and is loaded separately
  without replacing or merging fields from the Home snapshot.
- Replaced the web route fallthrough with explicit protected route resolution: `/profile`,
  `/bookings` and `/` load only their own aggregate, known unfinished sections render a bounded
  section state, and unknown paths render a 404 without requesting Home.
- Fixed repeat Viva OAuth through different social providers: the adapter now verifies the OAuth
  subject and obtains the stable Viva profile ID, while the auth repository resolves that ID to one
  canonical PadlHub UUID. Added an expand migration allowing multiple issuer subjects per canonical
  user and a fail-closed conflict response.
- Reconciled the one local duplicate only after confirming it had no Home, messaging or notification
  business state: its refresh sessions and identity link moved to the existing canonical user, its
  conflicting delegation was revoked, the duplicate was disabled and the operation was audited.

## 2026-07-15 — authenticated Home dashboard contract and interface

- Audited the legacy LK Home request graph: duplicate subscription reads, N+1 name hydration,
  overlapping game windows, tournament date scanning, an independent community widget and chat
  polling made the browser responsible for aggregation.
- Added the protected `GET /user/api/v1/{tenantKey}/home` contract with one consistent snapshot for
  profile, counters, quick actions, upcoming events, subscriptions, communities, promotion and
  capabilities.
- Kept community feeds, rankings, history and details lazy; current memberships are now represented
  by a bounded Home block on the same soft-green surface as the dashboard.
- Added a `VIVA_MODE=mock` synthetic read model and prevented it from running in non-mock modes.
- Replaced the temporary authenticated context card with a responsive desktop/mobile Home interface
  and coalesced concurrent browser reads so the page performs one Home request after authentication.
- Rebuilt the web Home presentation against Figma node `743:2014` on its canonical 375 by 1859
  frame: profile hero, four navigation cards, booking filters/cards, campaign, locations and bottom
  navigation now share the exported dimensions, typography and gradient.
- Extended the same Home snapshot with locations and server-approved additional links, and fitted
  the requested communities strip into the lower white surface without adding another client read.
- Removed simulated iOS system chrome from the web rendering and pinned the application bottom
  navigation to the browser viewport so it remains available while the long Home feed scrolls.
- Moved current communities directly below the profile on the purple Hero surface and added round
  logo support with a generated branded fallback, without introducing a separate communities read.
- Decoupled Home source selection from Viva authentication with `HOME_READ_MODE=mock|projection`;
  production configuration now requires the persisted projection and never falls back to mock.
- Added a forced-RLS, tenant/user-scoped Home snapshot table with monotonic revisions, event IDs,
  checksums, freshness metadata and metadata-only audit records.
- Added runtime contract/user/version/freshness validation and stable not-ready, invalid and stale
  API failures for the real projection path.
- Added a dry-run-by-default projection importer and a switch/rollback runbook for controlled
  initial fill and recovery while the continuous event-driven builder is implemented.
- Added the continuous Home projector contract and shared runtime validator for nine normalized
  domain components; counters are derived in the builder and external identifiers are rejected.
- Added a tenant-RLS component inbox, per-component monotonic revisions, per-user transactional
  rebuild locking and RabbitMQ inbox deduplication with a bounded quorum-queue delivery limit.
- Wired the projector into `apps/worker` and added a dry-run/apply outbox enqueue utility for
  controlled backfill and smoke tests; normal producers remain part of their domain transaction.
- Applied the component migration locally and verified the real Docker path end to end: outbox
  publish, quorum-queue consume, inbox completion and `waiting` without a partial snapshot.
- Added feature-gated server-side Viva producers for profile, enriched active bookings and active
  subscriptions, sharing the API refresh-token lease and encrypted delegation rotation path.
- Added transactional Viva source state, PadlHub UUID mapping and outbox emission; signed balances,
  optional phone suffixes and paused subscriptions now preserve the real upstream semantics.
- Applied the source migration locally and enabled worker sync against two active delegations. One
  user completed profile/upcoming/subscription projection events end to end; the second was safely
  rejected because the same Viva profile is already mapped to another PadlHub UUID.
- Backfilled communities, promotion, locations, navigation and capabilities through five validated,
  idempotent audited-outbox events. The worker published and consumed all five and assembled a full
  nine-component Home snapshot with the live Viva profile, bookings and subscription components.
- Switched the local API runtime to `HOME_READ_MODE=projection` after projection readiness. Real-user
  smoke checks returned HTTP 200 from `/home` and `/bookings/upcoming`, both bound to the same
  `LOCAL_PROJECTION` snapshot, with PadlHub UUIDs only and no integration identifiers exposed.

## 2026-07-14 — chats and notifications architecture

- Added the dedicated product/domain contour for trigger notifications, CUP connector
  correspondence, game/tournament/community chats and direct user conversations.
- Separated canonical messaging state from notification intents/delivery history and kept all
  external connector identifiers and encrypted endpoints inside the integration boundary.
- Defined server-side ordering, command idempotency, transactional outbox, connector deduplication,
  recoverable realtime delivery, attachment safety, privacy, metrics and phased rollout/rollback.
- Added explicit Web Push/VAPID, iOS/APNs and Android/FCM endpoint and receipt mechanics.
- Added PadlHub-owned moderation/control with user reports, CUP cases, reversible automated policy,
  immutable actions and signal-only external moderation providers.
- Added an expand-only tenant-scoped PostgreSQL foundation and an editable architecture diagram.
- Added a staged enablement, smoke, incident-control and digest rollback runbook.

## 2026-07-12 — Viva OAuth cabinet entry and delegation design

- Reworked the web authentication entry screen around Viva OAuth through VK ID/Mail.ru and Yandex,
  while retaining SMS as an explicit fallback.
- Implemented the feature-gated server-owned OAuth start/callback, one-time Redis PKCE state,
  authorization-code exchange in the Viva adapter, PadlHub session issuance and encrypted
  server-side Viva refresh-token persistence.
- Added a one-time callback handoff and authenticated Viva access broker: the browser keeps only a
  short-lived access-token in memory, while multi-node refresh is serialized by a Redis lease and
  rotated refresh credentials are encrypted before replacement. Logout revokes the local Viva
  delegation alongside the PadlHub refresh session.
- Added required public-offer and personal-data-policy confirmations before an OAuth start request;
  the browser sends only the confirmation intent to the PadlHub-owned OAuth start endpoint.
- Persisted that confirmation immediately as a tenant-scoped legal intent keyed by a hash of OAuth
  state; a successful callback binds it to the PadlHub user and creates the two final versioned
  document-acceptance rows.
- Recorded the feature-gated Viva user-delegation model: server-encrypted Viva refresh-token,
  in-memory short-lived browser access-token and refresh/revocation behavior. ADR 0008 later
  narrowed the temporary direct transport to read-only operations.
- Documented an immediate per-tenant/per-operation switch from `DIRECT_VIVA` to `LOCAL`,
  `SERVER_VIVA`, or `UNAVAILABLE`, including reconciliation for already pending commands.

## 2026-07-11 — platform baseline

- Imported and hashed the pre-existing Cabinet OpenAPI draft without altering it.
- Established TypeScript monorepo boundaries for API, worker, realtime, migrator and React/Capacitor clients.
- Added PadlHub JWT/tenant/correlation/rate-limit middleware baseline, source routing, Viva ACL, outbox/inbox tables and tenant RLS.
- Added Docker Compose local services, digest-only deployment definitions, monitoring baseline, Terraform boundary and Ansible host baseline.
- Added CI/CD scaffolding, ADRs, domain ownership and operational runbooks.
- Added canonical OpenAPI 3.1 user/admin/internal roots; SDK generation now uses only the first safe read-only user operation.
- Forced tenant RLS even for table owners, added bounded Viva retry/circuit/ID-mapping enforcement and removed realtime tickets from URLs.
- Pinned dependency and container versions; production promotion now consumes only digests from a successful staging workflow run.
- Verified all local dependencies, API/worker/realtime readiness, real JWT tenant resolution, realtime ticket authentication and a non-root production image.

## 2026-07-11 — first user authentication vertical

- Defined a provider-neutral phone-authentication and PadlHub-session boundary for the protected
  home page; schedule remains out of scope.
- Kept all client traffic on PadlHub APIs; Viva traffic and tokens stay inside
  `@phub/viva-adapter`, while provider bindings and external subjects stay in integration storage.
- Defined per-tenant `VIVA`/`LOCAL` binding, stable PadlHub UUID mapping by provider issuer/subject,
  in-memory web access JWTs and opaque rotating `HttpOnly` refresh cookies stored as hashes.
- Documented ephemeral Redis challenges, production secure-cookie enforcement, synthetic local
  credentials and the Viva timeout/retry/circuit-breaker/telemetry policy.
- Added the provider switch, rollback and local mock verification runbook.
- Added atomic single-use verification, per-phone cooldowns, shared Redis rate limits, correlated
  security audit, retry-safe idempotent session rotation and a full auth smoke test.

# 2026-07-18 — My bookings and For me first slice

- Replaced the static Home `Абонементы` tab with a lazy `Для меня` Games recommendation surface.
- Added LOCAL_ONLY, tenant-RLS booking preferences with favorite stations, weekday/time windows,
  history control, optimistic versioning, idempotency, audit and transactional outbox.
- Added deterministic level/station/time ranking over one local Games projection snapshot; only
  completed recent Games may supply learned signals and clients receive reasons rather than scores.
- Added `/bookings` upcoming/history/For me navigation. History is explicitly Games-only until the
  provider-wide history contract is verified.
- Expanded authenticated public-game details so a non-participant can open and join a public game;
  private outsider details still fail closed.
