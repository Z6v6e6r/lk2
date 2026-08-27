# Task, integration, release and deploy batches

This runbook separates ordinary task development from common integration, image publication and
live deployment. It does not authorize a merge, publication, deploy or live mutation.

## Task branches

- Up to four independent task branches may be developed in parallel from a recorded base.
- Each task owner changes only its branch/worktree and Draft PR. A task branch does not chase every
  movement of `main`; it synchronizes for a relevant dependency, real conflict or common batch.
- At most one platform/release task changes workflows, deploy files, root dependencies or release
  scripts. Public contracts, migration chains and auth boundaries have one write owner.
- Overlapping UI entry points are allowed when the PRs record their integration order. The task
  branches are not repeatedly merged into one another.

## Temporary integration batch

Use a temporary branch such as `integration/lk2-beta-20260827-01`; do not create a permanent
`develop` branch.

1. Start from fresh `main` and record the exact task heads and intended order.
2. Add two to four exact task heads sequentially without rewriting the task branches.
3. Resolve cross-task conflicts once in the integration branch.
4. Every new `integration/**` head automatically runs the full quality contour, exact-range secret
   scan, dependency security, Timeweb deployment contract, all five no-push Docker builds and the
   stable `pr-gate`.
5. If one task changes, certify only the new combined integration head. Do not make every source PR
   repeat full certification solely because the batch head moved.
6. After a green head, open one batch PR. Merge still needs separate authority.
7. Delete the temporary integration branch only after its release train is complete and deletion is
   separately authorized.

## Authorized merge boundary

Immediately before a separately authorized batch merge, refresh and bind the current `main`, exact
batch head, merge-base, mergeability and exact-head `pr-gate` result. Use a guarded ordinary merge
that refuses a changed head. Drift stops that merge boundary and requires a fresh read; it does not
freeze unrelated task branches. After merge, read back the merge commit/tree and automatic
post-merge CI. A successful merge still does not authorize publication or deploy.

## Publication and deploy

PR and integration Docker jobs build with `push: false`; they are not published release artifacts.
After an authorized batch merge, a release owner freezes one exact source and may perform one
separately authorized publication of all five images plus one canonical immutable manifest. A
deploy owner consumes that manifest by digest and never rebuilds on Timeweb. Backup, readiness,
smoke, rollback and live approval remain deploy gates independent of source, CI and publication.

## Handoff evidence

Git and GitHub Actions retain commit, tree, merge-base and run identities. PR descriptions should
record outcome, scope, changed ownership, checks, dependencies/order and recovery without copying a
universal SHA ledger or production checklist into every FAST or SAFE change.
