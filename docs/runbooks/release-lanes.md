# Release lanes (ADR-0026)

Status: target contract for the lane work; until the platform plan is implemented the current strict
profile remains the only executable deployment path. This runbook is intentionally short; the
canonical technical procedures stay in the existing Timeweb runbooks.

## Lanes

| Lane                                    | Delivers                                                | Authority                                                                               | Blocking gates                                                                                     | Budget   |
| --------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| `beta` (disposable)                     | any green main: API/Worker/Web + expand-only migrations | automatic after successful first-attempt main CI under owner-granted standing authority | readiness, 2–3 min smoke, rollback to the previous digest                                          | < 15 min |
| `web` (presentation / bounded safe-Web) | Web only                                                | automatic per main push under the standard route                                        | changed-file eligibility, Web tests/lint/typecheck/build, smoke                                    | < 5 min  |
| `production`                            | full release                                            | one exact-SHA approval per package and target                                           | immutable digests, verified backup/restore, readiness/smoke, rollback, post-activation observation | < 60 min |

A lane selects evidence and approvals. It never lowers the product risk tier: payments, identity,
bookings and migrations keep their existing gates.

## Common preflight (`--plan`)

Every operation must provide a read-only plan that runs in ≤ 2 minutes and reports GO/NO-GO by
category:

- exact source SHA/tree, source CI run and attempt, canonical manifest/artifact;
- image digests and the platform identity of every component;
- capacity: free disk vs required backup/restore (or object-storage availability);
- database ledger, roles/ACL closure and migration package identity;
- locks/leases and any active owned operation;
- rollback inputs and the exact previous digests;
- target identity and the approval record for this exact package.

A NO-GO category stops before any write. Missing live read access is reported, never worked around.

## Beta checklist

1. Select the green main SHA (first-attempt main CI success).
2. Confirm the owner's standing authority and record the approval reference.
3. `--plan` for the beta profile: capacity, backup, ledger, digests, locks.
4. Pull exact immutable digests; run expand-only migrations if the package requires them.
5. Start API/Worker/Web; verify readiness and the short smoke.
6. Record receipt and rollback digest. Provider/monitoring readbacks and the long observation are
   attached asynchronously; a failure after activation triggers the recorded rollback.
7. Stop on drift or a failed gate; do not repeat a mutation to "fix" an ambiguous result — reconcile.

## Web checklist

1. Compute eligibility from **changed files** (presentation / bounded safe-Web), not the cumulative
   diff since the installed baseline. No runtime change means no publication.
2. Run the Web tests/lint/typecheck/build contour.
3. Pull only the Web digest; keep API/Realtime/Worker identity unchanged.
4. Verify readiness and the Web smoke; record the receipt.
5. If the compatibility boundary fails, keep the current Web release and report the blocker.

## Production checklist

1. Approve the exact package once: source SHA, manifest, artifact, target, rollback inputs.
2. Fresh preflight before each write; inputs and hashes must match the approved package.
3. Backup/restore readiness is blocking. Migrations are expand/contract only.
4. Pull the same digests; activate in the canonical order; verify identity, readiness and smoke.
5. Start the long observation after activation with an automatic rollback trigger; attach provider
   evidence by hash instead of blocking on wall-clock readbacks.
6. Record the receipt, release identity and any follow-up findings. Never claim publication, staging
   or production evidence that was not actually observed.

## Approval rules

- `beta`: the owner may grant bounded standing authority for routine promotions through the
  protected route. Exact inputs are still re-verified and every drift stops the promotion.
- `production`: one approval per exact package and target. It covers the stages of that package while
  inputs and hashes are unchanged; per-stage re-approval is not required.
- Approval expiry may be extended by a fresh preflight when the exact request and inputs are
  unchanged. New inputs, source identity or target require a new approval.
- R4 (two independent risk perspectives) remains mandatory for payments, identity/authorization and
  destructive data operations. Routine application promotion uses one specialist.

## Evidence minimum per lane

| Lane       | Required                                                                | Attached / asynchronous                           |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| beta       | readiness, smoke, rollback digest, receipt                              | provider readbacks, alert tests, long observation |
| web        | Web build/tests, smoke, receipt                                         | monitoring snapshots                              |
| production | digests, backup/restore proof, readiness/smoke, rollback proof, receipt | provider evidence, extended observation           |

Source CI authority is verified once per operation and bound to the receipt. Do not re-run
source-quality at every stage; reuse the exact successful run when its source is unchanged.

## Failure handling

- No automatic replay of a failed or uncertain mutation; reconcile the exact owned operation first.
- Image rollback never reverses migrations or external writes; assess schema compatibility first.
- A failed post-deploy change returns to a focused task branch and a new package; never edit the host.
- Record the failing gate category in the receipt so the next attempt starts from evidence.

## Related documents

- [Timeweb beta runbook](timeweb-lk2-beta.md) — canonical target and current strict procedure.
- [Standard Timeweb delivery](timeweb-standard-delivery.md) — enrolled Web route.
- [Notification migration package](notification-migrations-0099-0101.md) — current migration profile.
- [Publication custody](timeweb-amd64-image-publication.md) — immutable images and manifests.
- [Delivery ownership](delivery-batches.md) — task/integration/release/deploy roles.
- ADR-0026 and [platform plan](../plans/release-lanes-platform-2026-10-25.md).
