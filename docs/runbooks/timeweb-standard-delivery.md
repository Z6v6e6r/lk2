# Standard Timeweb Web delivery (disabled until enrollment)

This route uses the existing `publish-timeweb-amd64-images.yaml`, canonical V2 manifest and
Timeweb Compose. It does not activate itself. The infrastructure PR is CRITICAL and requires the
existing full checks plus independent security/release review. Changes to this runbook or
AGENTS.md do not authorize the current session to merge, publish, deploy or alter settings.

## Before and after

Before: task/Draft -> optional integration interpreted as a mandatory batch -> separately approved
merge -> full main CI -> separately dispatched publication with repeated source quality -> separate
host stages. The old production workflow demands retired FULL_LIVE_HOME and is not usable here.

After enrollment: independent ready PR -> native guarded merge/auto-merge under standing owner
scope -> full integrated main CI -> installed trusted controller -> existing immutable publisher
(reuse exact main checks) -> published Web image startup check -> Web-only Compose up -> request
observation -> durable receipt and product feedback. No unrelated integration batch, per-stage
approval, repeated source-quality run or PR Docker rebuild for presentation work.

The machine profile name `leaf-web` stays stable. It now covers JSX copy in seven existing render
surfaces, including the named ProfileSubscriptions function in ProfilePage. Literal JSX title/ARIA
copy is allowed; executable expressions, imports, links, command handlers, price and entitlement
logic remain exact. Small layout changes use `presentation-*` classes added only to enumerated
metadata/decorative nodes. Their standalone CSS rules allow bounded gap/padding/radius and a literal
background color. Global/complex CSS and unknown surfaces take full checks. This deliberately small
syntax rule is not a general proof of UI safety. Render/accessibility checks remain part of the
feature owner's work. No product UI is changed by this infrastructure task.

## Standard scope and custody

- Repository: Z6v6e6r/lk2; trusted source is exact successful first-attempt main push CI, with the
  stable pr-gate and both static and integration-quality jobs successful. The publisher still
  independently checks exact current main before building. PR-head CI is never reusable main proof.
- Target: existing Timeweb beta Compose project and network from target.json. The enrolled operator
  runs on that host, with fixed local Docker socket; no arbitrary SSH host, shell command or target
  is accepted by the launcher. API and Realtime must already be healthy; Worker/Migrator stay off.
- Pilot component: only Web presentation (FAST, or a SAFE feature whose deployed portion is entirely
  within the same presentation boundary). General SAFE backend business logic retains its relevant
  full tests and the critical/manual component release route until separately enrolled. A tier or
  PR label alone never widens the pilot component set.
- Risk is the complete no-renames diff from each of installed API, installed previous Web and
  enrolled controller source to candidate. A later safe PR cannot conceal accumulated critical,
  shared, deployment, auth, payment or migration changes. Installed release IDs come from running
  container labels and immutable refs; baseline release.env is root-owned and matched to API and
  Realtime. Rewritten ancestry, a dirty controller or unexpected paths stop the route.
- The publisher builds all five images once because the existing manifest requires one-source
  five-image custody. This first pilot makes no mixed-manifest or digest-reuse redesign. Only the
  candidate Web digest is installed. The receipt identifies the unchanged backend source/digests
  separately; it never claims the candidate's unused backend images are running.
- Compatibility: cumulative source checks keep backend, SDK, contracts, build/runtime inputs and
  flags unchanged; existing API/ref/container identity and readiness are verified before and after.
  No live provider transaction, migration, secret provisioning, API/Realtime/Worker restart, ingress
  activation or runtime flag mutation is a stage of this Web route.

## One-time owner activation checklist

Complete this as one bounded activation decision after this infrastructure PR's checks/reviews.
These steps are intentionally not executed by the implementation task.

1. Merge the reviewed infrastructure PR under existing rules. Establish a canonical, healthy
   installed baseline from that reviewed source through the current critical Timeweb procedure;
   retain its root-only release.env, API/Web release labels, runtime identity, backup/restore and
   existing monitoring. Enrollment must not invent a baseline or waive accumulated critical code.
2. Install a dedicated root-owned clone at `/opt/phub/timeweb-beta/standard/source`, detached at
   that exact reviewed source. Install its pinned npm dependencies with `npm ci --ignore-scripts`
   during enrollment (never from candidate code during a run). Require root ownership and no
   group/world write for controller, dependencies, Git metadata and all parent paths. Keep the
   controller checkout unchanged; updates to it require a new critical review and enrollment.
   Install `deploy/timeweb/run-standard-delivery.sh` as root-owned 0755
   `/usr/local/sbin/phub-standard-delivery`. Required fixed commands are `/usr/bin/node` (22), git,
   Docker, gh and unzip. Enroll the existing root Docker read credential for immutable GHCR pulls.
   Configure `/etc/phub/timeweb-beta/standard-delivery.json` (root:root 0600) from the example with
   enabled=true, named owner and exact controllerSha. This config is standing authority.
3. Enroll a dedicated trusted self-hosted Linux x64 Actions runner with label
   `lk2-standard-operator`, restricted by runner group to **only** this repository's
   `timeweb-standard-delivery.yaml` on protected main. Do not use it for PR code or other workflows.
   Its account gets sudo only for the fixed launcher, with `GH_TOKEN` preservation; never generic
   root shell/node/git/Docker rights. The controller always executes installed code, never checks
   out or runs a candidate on this runner. Workflow token grants are actions write for publisher
   dispatch, contents read and packages read; the token expires with the run and no production
   secrets are passed into PR execution. Existing one-shot human reader-token policy is unchanged.
4. Preserve required `pr-gate`, main protection and review of critical workflow/deploy/policy paths.
   Enable native auto-merge for eligible ready PRs and grant the named outcome owner standing
   authority to queue those merges. No arbitrary PR label grants production authority. Configure
   environment `timeweb-standard-delivery` and the existing `timeweb-amd64-publication` environment
   for the bounded standing route, main only, without repetitive human review for eligible ordinary
   runs; retain independent review/protection for changes to the mechanism. Set repository variable
   `LK2_STANDARD_DELIVERY_ENABLED=true` last. Rehearse one synthetic eligible change and a forced
   Web-health failure on an isolated fixture before live enrollment, then observe the first pilot.

GitHub settings, runner registration, sudo/host installation, baseline deployment and actual enable
are external owner actions. Adding source files does none of them. If repository/plan capabilities
cannot restrict runner workflow access, do not enroll a broadly accessible privileged runner.

## Failure, observation and compatible recovery

The workflow and host controller serialize releases. Main drift before publication/deployment stops
that candidate. Failed/cancelled/missing required jobs stop before publication. A previous
publication for the same source, partial run, rerun, ambiguous artifact or expired inventory stops
instead of silently publishing again. The per-host `standard/active` directory remains on any
uncertain failure, preventing subsequent propagation; no automatic destructive cleanup.

Before Web activation a pending receipt is fsynced. The published image is pulled by digest and
checked with nginx and index.html, not rebuilt. Web starts with `--no-deps`; its exact image/release
label and health are required. Sixty actual GETs to both API readiness and Web root over at least a
minute must succeed, with p95 <=1500ms API and <=1000ms Web. Backend IDs/images/config and restart
counts remain exact. This Web smoke is independent of existing fleet monitoring; it does not
replace provider, authenticated user-journey or 15-minute API/ingress activation evidence.

A Web failure after activation restores the previously running Web digest and release label with
another `--no-deps` update, verifies its health and unchanged backend, and records rolled-back or
rollback-failed. It never reverts data, payment, migration, backend configuration or external writes.
The owner reconciles pending/failed receipts and the actual running identity before clearing the
active lock under explicit recovery authority. Disabling the repository variable stops new
scheduling; set config enabled=false and reconcile any in-progress run before revoking credentials
or changing the host. A failed rollback needs owner intervention, not another blind rollout.

Each receipt records source CI, canonical publication/artifact/manifest identity, actual previous
Web and unchanged backend provenance, outcome and request counts. HTTP smoke proves serving/health,
not actual user value: the feature owner records target operation/user feedback next. No traffic,
mock/WARN or an uncalled writer is not successful enforcement. Existing cohorts/flags, if used,
need owner, audience, expansion criterion, disable condition and review date; no new flag system.

## Measured baseline and verification

Before optimization, successful main CI run 33948348630 took 7m19s elapsed. Jobs: source-quality
411s, quality-full 310s; five no-push Docker jobs 152–206s. Publication 33959055382 took 12m27s:
verify-source 467s, builds 175–234s, manifest 14s. These are observed Actions durations, not an
estimate of personal work or a claimed speedup. Source reuse removes that repeated verifier only
when the new exact main-run verifier accepts its full inputs. Final PR CI and local scenario
results are reported with the PR; production latency remains unmeasured until activation.

The local disposable Compose rehearsal is executable (no shared endpoints, ports or volumes):

```sh
TIMEWEB_STANDARD_DOCKER_VERIFY=1 node scripts/rehearse-timeweb-standard-compose.js
```

It uses the pinned nginx base, verifies a successful Web transition, injects observation failure,
restores the previous release label even when the digest is identical, and proves the unrelated API
container ID stayed unchanged. The full CI integration job opts into this rehearsal. This is LOCAL
Compose/rollback evidence, not canonical publication or production evidence.
