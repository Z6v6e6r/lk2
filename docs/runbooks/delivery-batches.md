# Feature delivery and optional integration batches

One independent feature follows task branch -> PR -> main -> release -> feedback. One task owner
owns that user result; integration, release and deploy are responsibilities, not mandatory queues.
Draft marks unfinished work. Never wait for an unrelated batch of PRs.

## Checks and review

| Change                                                | PR checks                                                                                                          | Release                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Documentation/policy                                  | formatting, policy scenarios, planner/gate regressions, secret scan                                                | merge; no runtime rollout for docs alone                                             |
| Presentation copy/style in registered render surfaces | Web tests, affected lint/types/build, secret scan                                                                  | standard Web pilot after green integrated source                                     |
| SAFE recoverable business logic                       | relevant positive/negative tests and dependency closure; full source contour until a narrower module is registered | standard only within enrolled component scope; other components use reviewed release |
| Payment/auth/tenant/write/schema/shared/unknown       | full source, integration coverage, contracts, security, relevant Docker/deployment checks and specialist review    | critical route                                                                       |
| CI classifier, gates, release mechanism               | full pre-existing checks, independent security/release review                                                      | explicit owner activation                                                            |

`source-quality` does static checks/build; `quality-full` runs unit and integration coverage once.
The stable `pr-gate` requires every selected job. Failure, cancellation, missing result or unexpected
skip rejects the gate. PR `push: false` builds are diagnostics, never published artifacts.
Main push verifies integrated source with full checks. Publication may reuse a successful
first-attempt main push run for the exact SHA, workflow and required job set; otherwise it runs
source quality. A different merge result needs current checks. Never reuse a PR-head run as main
source proof. No production activation occurs before source checks succeed.

## Optional temporary integration

Use `integration/**` only for actual dependencies/conflicts between two to four tasks. Record the
heads/order, resolve conflicts once, check the integrated source, then use one PR. There is no
permanent develop branch or mandatory integration train for a single feature.

Immediately before an authorized merge, refresh current `main`, exact
batch head, merge-base (or the independent feature head), mergeability and required checks.
Drift stops that merge boundary until affected inputs are rechecked; it does not freeze all tasks.
Ordinary main movement repeats checks only for changed source, dependencies, environment or inputs.

## Publication and deployment

The current route is Timeweb amd64 publication and the Timeweb host controller. The older
`deploy-production.yaml` requires retired `FULL_LIVE_HOME` and is not the standard route.
FULL_LIVE_HOME covered provider/Home/routing and shared runtime activation. A presentation-only
Web update does not change these properties: preserve running API/config/flags, prove unchanged
backend/API contracts from installed source, check Web runtime/readiness and observe real requests.
Do not delete the old gate to make an unrelated workflow green.

The pilot keeps the existing five-component canonical V2 manifest. It never rebuilds on Timeweb,
never substitutes a PR Docker build, and never calls a migration or backend restart for Web.
See [standard Timeweb route](timeweb-standard-delivery.md) for enrollment, cumulative risk,
component provenance, source reuse, stopping and compatible Web rollback.

## Outcome and follow-up

Ship the useful minimum. Subscription explanation and real enforcement are separate outcomes;
mock/WARN/disabled writer does not enforce and ambiguous money operations stay fail-closed.
For a bounded audience use existing flags only when needed, with owner/audience, expansion/disable
criteria and review date. Observe target requests, errors and user outcome; no traffic is not PASS.
Record unrelated findings as `Follow-up finding`. Blocking review states a concrete consequence
and the minimum fix. Do not broaden the feature into platform or architecture work.
