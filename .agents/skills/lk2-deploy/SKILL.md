---
name: lk2-deploy
description: Explicitly validate LK2 Timeweb deployment inputs and prepare a deployment plan; execute only separately authorized exact-target transitions through the canonical Timeweb process.
---

# LK2 deployment

Default to input validation and a reviewable plan. “Check deployment readiness”, a skill invocation,
a published release or green CI never authorizes server changes, pull/up stages or live writes.

Read `AGENTS.md`, the current [Timeweb beta runbook](../../../docs/runbooks/timeweb-lk2-beta.md),
[publication custody](../../../docs/runbooks/timeweb-amd64-image-publication.md) and
[delivery ownership](../../../docs/runbooks/delivery-batches.md). Reuse their canonical manifest,
renderer, controllers and stage order. Do not write a second deployment system.

- Bind the exact canonical manifest/checksum/archive to its source/tree/workflow/run/attempt and
  verified five-image digests. Resolve the target environment and host through the canonical target
  contract; refresh volatile evidence. Do not substitute a similar artifact or stale runbook fact.
- Prepare exact service/target scope, prerequisites, sequence, abort conditions and recovery. Before
  server mutation, require separate authority for that concrete manifest and target plus the
  runbook's verified backup/restore proof, rollback inputs, monitoring and abort thresholds.
  After each authorized transition, verify its running digests, readiness, logs/metrics, smoke and
  observability in the canonical stage order; source checks are not post-start live evidence.
  When live read access is unavailable or prohibited, report it; local contract tests cannot prove
  live readiness. Do not run host-writing “prepare” commands during a readiness-only request.
- Execute only already authorized transitions with the canonical Timeweb controllers. Pull the
  same verified digests; never `latest`, rebuild on the host or replace manifest contents. Respect
  each fresh identity check and stop on drift or a failed gate.
- Keep secret provisioning, network/ingress, migrations, provider operations, Realtime topology,
  Worker/background activity and user access outside the scope unless individually approved.
  Permission for an API/Web update does not enable the rest of the system.
- Prove the runbook's rollback path before activation. Reverting images does not undo database
  migrations or restore data; separately assess old/new schema compatibility and database recovery.
  Follow only the explicitly authorized recovery scope on failure.

Report input validity and missing prerequisites separately from actual execution. For an authorized
execution, record exact targets/digests, transitions, readbacks, smoke/observability and recovery
outcome. Keep `LOCAL`, `CI`, `STAGING`, `PROVIDER` and `PRODUCTION` evidence separate. No implied merge,
publication, deployment, migration, rollback or permission widening follows from this skill.
