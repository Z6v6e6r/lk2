---
name: lk2-release
description: Explicitly prepare or verify an LK2 release source and, only with separate exact-source publication authority, follow the existing Timeweb immutable publication process. Does not deploy.
---

# LK2 release

Default to read-only source preparation and validation. An explicit skill invocation, “prepare a
release”, green CI or a Draft PR is not publication authority.

Read `AGENTS.md`, [delivery batches](../../../docs/runbooks/delivery-batches.md), and the current
[Timeweb publication runbook](../../../docs/runbooks/timeweb-amd64-image-publication.md).
Use their canonical tools and gates; do not create a parallel manifest or publication workflow.

1. Identify the selected source SHA, Git tree, source/workflow identity and exact-head CI. Refresh
   volatile facts from Git/GitHub; historical runbook SHAs are not current evidence. The current
   publisher requires exact current `main`, not a Draft PR or an older approved main. Report an
   ineligible candidate and complete independent preparation without merging it.
2. Include a temporary integration batch only for actual multiple ready task heads requiring common
   integration. Follow the existing runbook and its separate merge authority; a single task/source
   does not need an artificial batch.
3. Prepare a reviewable publication plan with exact source/workflow SHA, required CI, five-image
   closure, canonical artifact identities and current runbook confirmation input. Stop before
   workflow dispatch or registry mutation unless the user separately authorized publication of that
   concrete source SHA. Invocation alone never grants dispatch, rerun or reconciliation authority.
4. If that publication is explicitly authorized, execute only the existing Timeweb publication
   procedure. Re-read identity immediately before dispatch; drift invalidates that transition.
   Verify the successful same-run, first-attempt artifact and all custody gates. A partial/failed
   publication is a blocker, never permission for an automatic retry.

For preparation, report source eligibility, CI, gaps and the concrete pending approval. For an
actual authorized publication, return the existing canonical `release-manifest.json` and
`release-manifest.sha256`, `PHUB_TIMEWEB_RELEASE_MANIFEST_V2`, exact source/tree/run identity and
five verified image digests. Follow the runbook if its canonical contract changes. Publication is
neither host installation nor STAGING/PROVIDER/PRODUCTION proof. Never automatically deploy, SSH,
provision secrets, migrate, enable background services or widen access.
