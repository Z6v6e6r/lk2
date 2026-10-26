# ADR 0026: Delivery lanes and release budgets

Status: Proposed (25.10.2026). Supersedes the beta/production split of ADR-0025 only where stated;
keeps ADR-0025 immutable-binding and evidence rules.

## Context

A week of product changes has now spent more than two days on delivery and is still not deployed.
Measured evidence:

- the Web-only standard route has produced **47 failures / 0 successes** since it was introduced;
- publication of five images takes **~5 minutes** — publication is not the bottleneck;
- the full beta deploy is blocked by a **4.52 GB** capacity shortfall; the restore image is
  **37.7 GB** for an **11.2 GB** database (the 3×-DB local-disk rule);
- a migration approval arrived at 08:05 while its window had closed at 00:11 — the run restarted;
- one global backup lease is held from backup creation until the final API/Worker reconciliation;
- the controller is pinned to the candidate SHA, so every new merge invalidates enrollment and
  publication identity;
- a blocking observation requires 61 rounds × 15 s (≥ 900 s) before success;
- the operators implement ~13.7k lines of controller code against ~3k lines of runbook narrative.

ADR-0025 already diagnosed the same coupling and proposed a disposable `beta` profile
(merge → working beta under one hour) plus a strict `production` profile. That decision was never
implemented; every delivery still uses the strict path, so routine changes pay production-custody
cost.

## Decision

### 1. Three explicit delivery lanes

| Lane                                    | Delivers                                                  | Trigger and authority                                                                                        | Blocking gates                                                                                              | Budget   |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- |
| `beta` (disposable)                     | any green main: API/Worker/Web and expand-only migrations | automatic after successful first-attempt main CI, under owner-granted standing authority                     | readiness, 2–3 min smoke, rollback to previous digest; provider/monitoring readbacks recorded, not blocking | < 15 min |
| `web` (presentation / bounded safe-Web) | Web only                                                  | automatic per main push, eligibility computed from **changed files**, not the cumulative diff since baseline | Web tests/lint/typecheck/build, smoke; no publication when no runtime code changed                          | < 5 min  |
| `production`                            | full release                                              | one exact-SHA approval **per release package and target**                                                    | immutable digests, verified backup/restore, readiness/smoke, rollback, post-activation observation          | < 60 min |

Beta is disposable: its evidence is operational, not production custody. Production keeps every
existing immutability, backup, rollback and migration rule.

### 2. Approvals

- The owner may grant bounded standing authority for `beta` promotions through the protected
  standard route. Each promotion still re-verifies its exact inputs and stops on drift; authority is
  not a bypass.
- `production` requires **one** approval of the exact package (source SHA, manifest, artifact,
  target). Re-approval per stage is not required while the exact request, inputs and hashes are
  unchanged; a fresh preflight is mandatory before each write.
- Approval expiry may be extended by a fresh preflight when the exact request/inputs/hashes are
  unchanged. New inputs, a new source identity or a changed target require a new approval.
- R4 (two independent risk perspectives) remains required for payments, identity/authorization and
  destructive data operations. A routine application promotion with an existing migration path uses
  one specialist.

### 3. Controller, publication and leases

- The enrolled controller is a **versioned stable service**; the candidate is data in a signed
  descriptor. Enrollment is not repeated per candidate SHA. At least N–2 controller versions remain
  supported.
- Publication is **per component**: only changed images are built and published; unchanged digests
  are reused from the previous canonical manifest. The manifest still describes all components.
- Custody uses **per-stage leases** (backup → migration → rollout) with explicit ownership transfer,
  not one global lease held until the final reconciliation.
- A successful but unadmitted backup supports a first-class, idempotent **renewal** operation; it is
  not a special R4 project.
- Capacity is a provisioning property: disk ≥ 3.5× database (or backups/restore in object storage),
  with an alert below 2× database free. Capacity must not become a per-release gate.

### 4. Observation and evidence

- Beta: readiness, smoke and rollback proof are blocking; provider monitoring, alert readbacks and
  15-minute observation are recorded asynchronously after activation.
- Production: backup/restore, readiness, smoke and rollback are blocking; the long observation runs
  after activation with an automatic rollback trigger, and provider evidence is attached, not used
  as a wall-clock gate.
- Source CI authority is verified once per operation and bound into the immutable receipt; it is not
  re-fetched at every stage.
- Each lane has one minimal evidence set (see the delivery-lanes runbook). More evidence stays
  available; it is not mandatory by default.

### 5. Documentation and checks

- Each runbook is a short contract: target **≤ 200 lines**, invariants and decisions; the executable
  detail lives in code.
- Every operation exposes `--plan`/preflight that completes in **≤ 2 minutes** and prints GO/NO-GO by
  category (capacity, backup, roles, ledger, locks, digests, source identity).
- One release checklist per lane replaces overlapping narrative documents.

## Consequences

- Routine beta delivery becomes a 15-minute operation and stops paying production-custody cost.
- The standard Web route becomes usable for mixed repositories because eligibility follows changed
  files; a fast-forward baseline operation replaces repeated full deploys.
- Production keeps its safety properties with fewer human hand-offs and fewer repeated checks.
- Platform work is required before these lanes are fully active. Until the beta controller and
  per-stage leases are enrolled, the existing strict profile remains the only executable path; rules
  in `AGENTS.md` describe the target and the mandatory properties of that platform work.

## Implementation phases

1. **Rules and ADR** (this change): lanes, budgets, approval and evidence expectations, runbook.
2. **Quick unblock**: capacity, backup renewal, approval TTL extension, per-stage lease, beta-only
   smoke instead of the 900 s gate.
3. **Beta lane**: stable versioned controller, signed candidate descriptor, automatic promotion after
   main CI.
4. **Web eligibility**: changed-files boundary and fast-forward baseline.
5. **Production promotion**: one package approval, async observation with automatic rollback.

## Metrics

- change → beta lead time (< 30 min), beta → production (< 1 business day);
- first-attempt deploy success (> 90%);
- manual approvals per release (0 for beta, 1 for production);
- time lost to capacity/lease blockers (0);
- share of presentation changes delivered by the `web` lane (> 80%).
