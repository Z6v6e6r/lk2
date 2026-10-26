# Platform plan: delivery lanes (ADR-0026)

Status: implementation plan, not an execution authorization. One platform owner at a time; it touches
`.github/workflows/**`, `deploy/**` and release scripts, so it stays a single active platform task.

## Goal

Make routine delivery cheap: beta promotion in < 15 minutes, Web-only in < 5 minutes, production in
< 60 minutes, with no capacity/lease deadlocks, one manual approval per production package, and
evidence that remains immutable and auditable.

## Phase 0 — rules and ADR (this change)

- ADR-0026, `AGENTS.md` delivery lanes, short lane runbook, skills update.
- No runtime behavior change.

Acceptance: docs format check, diff review, no contradictions with ADR-0025 production constraints.

## Phase 1 — unblock the current beta (highest priority)

Current measured blockers: 4.52 GB capacity shortfall; successful-but-unadmitted backup `966` cannot
be renewed; human approval window expired; global backup lease.

1. **Capacity**
   - Provision disk to ≥ 3.5× database (or move backups/restore to object storage).
   - Add a provisioning invariant and an alert when free < 2× database.
   - Touchpoints: Timeweb target/provisioning contract, `deploy/timeweb/target.json`,
     `scripts/plan-timeweb-beta-bootstrap.ts`, `scripts/plan-timeweb-beta-restore.ts`.
2. **Backup renewal**
   - Support an idempotent renewal of a successful, unadmitted backup under a new release identity;
     keep the original canonical bytes and native-path proof for the old identity.
   - Read-only eligibility preflight implemented: `scripts/timeweb-backup-renewal.ts` +
     `npm run release:backup-renewal-plan` (see `docs/runbooks/backup-renewal.md`). The live
     metadata-only retirement mode remains a reviewed controller change.
   - Touchpoints: `scripts/control-timeweb-database-backup.py`,
     `scripts/timeweb-api-worker-migration.js`, request schema and tests.
3. **Approval TTL**
   - Allow a fresh preflight to extend the exact request's expiry when inputs/hashes are unchanged;
     new inputs require a new approval.
   - Touchpoints: `scripts/run-timeweb-standard-delivery.js`, migration/backup request validation,
     operator packet templates.
4. **Per-stage leases**
   - Split the single global backup lease into backup → migration → rollout ownership transfer.
   - Touchpoints: `scripts/control-timeweb-database-backup.py`,
     `scripts/timeweb-api-worker-migration.js`, `scripts/timeweb-api-worker-upgrade.js`.
5. **Beta smoke instead of 900 s**
   - For the beta profile: readiness + 2–3 minute smoke blocking; the 61-round observation runs
     asynchronously with automatic rollback.
   - Touchpoints: `scripts/timeweb-api-worker-upgrade.js`, observation policy, receipts.

Acceptance: a fresh beta promotion completes < 15 min from a green main on the current host, with
capacity and renewal gates passing and no manual expiry race.

## Phase 2 — beta lane

- Enrolled controller becomes a versioned stable service; candidate is a signed descriptor (source,
  manifest, artifact, digests, target). Enrollment is not repeated per candidate SHA; support N–2
  controller versions.
- Automatic promotion after a successful first-attempt main CI, under owner-granted standing
  authority; stop on drift, failed gate or ambiguous outcome.
- Touchpoints: `scripts/run-timeweb-standard-delivery.js`,
  `deploy/timeweb/run-standard-delivery.sh`, `.github/workflows/timeweb-standard-delivery.yaml`,
  enrollment/config contracts, receipt schema.

Acceptance: three consecutive beta promotions without manual intervention; median < 15 min; zero
capacity/lease failures.

## Phase 3 — per-component publication

- Build/publish only changed components; reuse unchanged digests from the previous canonical
  manifest. The manifest still lists all five components and records `reusedFrom` provenance.
- Touchpoints: `.github/workflows/publish-timeweb-amd64-images.yaml`,
  `scripts/timeweb-release-manifest-contract.js`, manifest schema, publisher tests, publication
  inventory.
- Compatibility: old manifests remain readable; a consumer that expects a freshly built digest must
  accept the explicit reused provenance.

Acceptance: a one-component change publishes one image plus a five-component manifest in < 3 minutes;
unchanged digests are byte-identical; existing consumers pass compatibility tests.

## Phase 4 — Web eligibility by changed files

- Replace cumulative baseline diff with a changed-file boundary for the Web lane; keep the frozen
  safe-Web syntax rule.
- Fast-forward the installed baseline after a full deploy, so Web eligibility does not depend on the
  whole backend history.
- Touchpoints: `scripts/safe-web-boundary.js`, `scripts/presentation-boundary.js`,
  eligibility planner in `scripts/run-timeweb-standard-delivery.js`, boundary tests.

Acceptance: a Web-only change on top of a mixed backend main is eligible; any new module or outside
allowlist path keeps the critical route; a no-runtime docs/test-only change publishes nothing.

## Phase 5 — production promotion

- One exact-package approval covering the package's stages while inputs/hashes are unchanged.
- Async long observation with automatic rollback; provider evidence attached by hash, not a
  wall-clock gate (except payment scenarios).
- Touchpoints: production profile in controller/runbooks, approval record schema, receipt schema,
  runbook rewrite (≤ 200 lines target).

Acceptance: production promotion median < 60 min; one manual approval per release; rollback path
rehearsed; no weakening of backup/readiness/migration gates.

## Cross-cutting work

- **Runbook shrink**: replace narrative with `--plan` outputs for the canary and migration paths;
  keep the existing strict runbooks until their features are covered by tests.
- **Documentation truth**: every lane claims only implemented behavior. Until a phase lands, the
  current strict profile remains the only executable path (as stated in `AGENTS.md`).
- **Metrics**: capture lead time change→beta, beta→production, first-attempt success rate, manual
  approvals per release, time in capacity/lease blockers, Web-lane share.

## Risks and mitigations

| Risk                                             | Mitigation                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Lowering production safety                       | lane never changes product risk; backup/readiness/rollback remain blocking; two specialists for money/identity/data operations |
| Stable controller accepts an untrusted candidate | signed descriptor, exact source CI, immutable digests, drift checks on every stage                                             |
| Per-component reuse hides a broken digest        | manifest `reusedFrom` provenance + compatibility test; consumer verifies full manifest                                         |
| Approval TTL extension bypasses human intent     | only when exact request/inputs/hashes unchanged; fresh preflight; new inputs need new approval                                 |
| Async observation misses a regression            | automatic rollback trigger on readiness/latency/error thresholds; receipt records observation                                  |
| Phase 1 touches live host machinery              | local rehearsals, disposable DB, one platform owner, no parallel host operations                                               |

## Sequencing

1. Merge Phase 0 (this ADR/rules/runbook).
2. Phase 1 as the next platform PR — it also unblocks the current stuck beta release.
3. Phase 2 + 4 can proceed in parallel only if they do not touch the same controller files; otherwise
   keep one platform task at a time.
4. Phase 3 before Phase 5 if per-component publication is required for the production budget.
5. Run one pilot beta release after Phase 1 and one after Phase 2; publish metrics before changing
   the production path.
