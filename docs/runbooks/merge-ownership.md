# Runbook: exclusive merge ownership

The root `AGENTS.md` is authoritative. This runbook applies its organizational `merge-owner` rule;
it does not create a GitHub lock or grant any live-operation authority.

## When a merge-owner is required

Normal implementation needs no merge-owner. A task must acquire merge ownership before it merges
fresh `main` into a PR branch, performs an explicitly authorized restack, changes PR base or
lifecycle, moves a PR to or from Ready, closes or reopens a PR, merges into `main`, or coordinates a
stacked merge.

Only one task may own a repository's merge contour at a time. Merge ownership is scoped to its
declared task and ends only through the release procedure below.

## What parallel implementation tasks may do

They may research, use separate clean worktrees, commit and push their own feature branches, update
their own Draft PRs, run local checks, and receive automatic PR CI. They start with a fresh fetch,
record the starting `origin/main`, avoid dirty user checkouts, and never modify another task's
branch.

While a merge-owner is active, they do not sync with `main`, rebase, merge-from-main, change PR
bases or lifecycle, move a PR to Ready, close or merge a PR, update stacked bases, or trigger manual
CI. They may continue independent work that stays outside the merge contour.

## Acquire ownership

Before the first merge-related mutation:

1. Fresh-fetch the repository and inventory all open PRs.
2. Record the fresh `main` SHA/tree and target PR head SHA.
3. Check mergeability, unresolved review threads, and CI.
4. Confirm through task coordination that no other merge-owner is active.
5. Declare the repository, task identifier, frozen `main`, frozen PR head, allowed merge-contour
   operations, and prohibited live operations.

Use `Merge owner: NONE` for an ordinary Draft PR. Do not claim ownership until a task actually needs
the merge contour.

## Freeze identity before merge

Immediately before an authorized controlled merge, record:

- pre-merge `main` SHA and tree;
- PR head SHA and tree;
- merge-base;
- exact-head CI run and conclusion;
- PR state and mergeability.

Do not use earlier evidence if any frozen field changes.

## Handle drift

Treat an unknown change to `main`, PR head/base, required checks, review state, or an applicable
workflow definition as drift. Stop the affected controlled merge and dependent stacked sequence,
then refresh the full identity before deciding how to continue. This STOP does not freeze unrelated
research, branches, local tests, or repositories.

During queue cleanup or a mass merge, an unknown new PR after inventory is `EXTERNAL DRIFT`. Record
its number, head SHA, and discovery time; do not close or merge it automatically. A repository-wide
writer freeze exists only when the task explicitly declared one.

## Handle stacked PRs

Use one merge-owner for the whole stack and merge bottom-up. After each merge, synchronize the next
PR with the new `main`, obtain CI for its new exact head, and freeze identity again. Never reuse CI
from before a base/effective-input change, and never merge two levels of one stack in parallel.

## Release ownership

After the final authorized merge:

1. Wait for successful automatic post-merge CI.
2. Fresh-fetch and record the final `main` SHA/tree.
3. Inventory open PRs again.
4. Record every performed mutation and verify that no unknown drift remains.
5. Explicitly announce that the task releases merge ownership.

If the task stops before a merge, it may release as `ABORTED` after a fresh fetch and PR inventory,
recording current identity, the stop reason, any mutations already made, and confirmation that no
merge-related action is in flight. If a completed merge has failed or blocked post-merge CI and the
owner cannot continue, fresh-fetch, inventory current open PRs, and record `BLOCKED_POST_MERGE`,
current `main` SHA/tree, target PR identity, failed checks, known drift, every mutation, and the
absence of in-flight actions before an explicit release or handoff. Do not report the normal
successful release gate as passed. A successor must acquire ownership from scratch and revalidate
the full inventory and frozen identity.

Deploy, publication, reconciliation, migration apply, activation, provider/production mutation,
manual workflow action, force-push, rebase, and branch deletion remain separately authorized even
for the merge-owner.

## Examples

### Independent Web and Mobile PRs

Web and Mobile tasks start from their recorded baselines in separate worktrees and open Draft PRs
with `Merge owner: NONE`. Both continue implementation and automatic CI in parallel. When Web is
selected for integration, one task acquires merge ownership. The Mobile task keeps developing but
does not sync with the new `main` or change PR lifecycle until the Web merge-owner releases the
contour. It can acquire ownership later and refresh its own identity.

### Stacked Games PRs

Games PR B depends on Games PR A. One task acquires merge ownership for both. It freezes and merges
A first, waits for post-merge evidence, then synchronizes B with the resulting `main`. B's earlier CI
is stale, so its new exact head receives CI and a new freeze before B is merged. No other task merges
or rebases either level during this sequence.
