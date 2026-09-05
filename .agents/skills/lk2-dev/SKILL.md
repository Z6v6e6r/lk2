---
name: lk2-dev
description: Implement LK2 product changes through an isolated local worktree, mock preview, risk-based checks and a Draft PR. Use for ordinary UI, feature and bugfix requests; release publication and deployment are separate operations.
---

# LK2 development

Read the current root and applicable nested `AGENTS.md`. Follow its FAST/SAFE/CRITICAL boundary
classification and execution route; a UI change alone does not require release certification.
Use existing orchestration guidance when available, without copying it into this skill.

- Record fresh `origin/main` and its actual SHA when beginning a new task. Inspect worktrees, dirty
  changes and active PR ownership; reuse the task's existing branch/worktree if continuing.
  Work in your own clean `codex/*` branch/worktree. Preserve other tasks' changes.
- Inspect the actual Node/npm, lockfile and Docker context/endpoint. Follow
  [local development](../../../docs/runbooks/local-development.md) for setup, preview, status,
  stop and conflict recovery. Never copy production secrets or silently select another daemon.
  New database initialization needs explicit authority for a fresh disposable local database;
  neither this skill nor ordinary worktree setup grants migration authority.
- Implement the requested behavior and validate the affected boundary. Use the available browser
  for rendered behavior/accessibility; a build or HTTP 200 alone is not visual proof. Record browser,
  Docker or access limitations and continue independent work. Preview must mount this task's source.
- Inspect the actual diff for unrelated files, secrets and PII. Apply the repository's secret scanner
  before task-branch push and required independent review for CRITICAL boundaries. Run affected
  checks first and the full gate only when `AGENTS.md` requires it. Do not repeat unchanged checks.
- Commit, push only this task branch, open/update one Draft PR and inspect exact-head automatic CI
  within the user's task authority. Fix in-scope failures. Do not manually dispatch release workflows.
  Use [delivery batches](../../../docs/runbooks/delivery-batches.md) only when multiple ready heads
  really need integration; do not invent an integration batch for one UI task.

Report the outcome, changed files, preview URL and worktree, actual checks, unavailable/skipped
checks and residual risks, branch/head SHA, PR and exact-head CI results. Label evidence `LOCAL`,
`CI`, `STAGING`, `PROVIDER`, `PRODUCTION` separately. Include the required `MODEL_ROUTE` and Git/live
operation status. Development readiness grants no merge, publication, deployment or live-write
permission. Stop before those transitions; never perform them as part of this skill.
