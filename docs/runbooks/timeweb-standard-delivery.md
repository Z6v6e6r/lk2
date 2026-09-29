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
- Target: existing Timeweb beta Compose project and network from target.json. The enrolled
  controller runs on that host against the fixed local Docker socket. The delivery workflow never
  addresses the host directly: it joins the operator tailnet, sends one token and one numeric run id
  over stdin to a forced SSH entry, and that entry may only invoke the fixed launcher, which accepts
  nothing but the run id. No arbitrary SSH host, shell command or target is accepted. API must
  already be healthy; Realtime may remain absent, or must retain its existing healthy identity. The
  migrator never runs. A worker may run or not: Compose keeps it behind its own profile while the
  renderer always declares it, so presence is the baseline's business. A running worker must however
  use exactly the declared `WORKER_IMAGE_DIGEST`, and its identity (container id, image, restart
  count and start time) is asserted at preflight, in every observation round, and after activation
  or rollback, so it cannot appear, disappear or restart while a release is delivered; the receipt
  records it as unchanged backend.
- Pilot components: Web presentation and the bounded tuning of the already-installed safe-Web
  modules listed in `scripts/safe-web-boundary.js`. Presentation is proven copy/ARIA/bounded styling;
  safe-Web is proven structurally: its syntax is frozen and only literal values may change, with
  dependencies restricted to allowlisted modules and, for `apps/web/src/App.tsx`, only literals
  inside the named attachment-upload command functions. Everything else — general SAFE backend
  logic, API/SDK, contracts, migrations, auth, payment, deployment files — retains its relevant full
  tests and the critical/manual component release route until separately enrolled. A tier, a path or
  a PR label alone never widens the pilot component set.
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

### Delivery classes and their owner

| Class                     | Source of proof                                                                                                         | Owner                           | Review condition                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| Presentation              | `scripts/presentation-boundary.js`: literal JSX copy/`aria-label`/`title`, bounded `presentation-*` styling             | enrolled owner (`config.owner`) | re-review when a surface is added or the syntactic rule changes                    |
| Safe Web (bounded tuning) | `scripts/safe-web-boundary.js`: syntax frozen, only literal values may change, dependencies only to allowlisted modules | enrolled owner (`config.owner`) | re-review at least every 90 days, and on every allowlist entry or invariant change |

The safe-Web class is structural rather than a capability denylist:

- the printed syntax tree with literal values replaced by placeholders must be identical; a new
  statement, call, property, helper, alias, control-flow branch or API use changes it and fails
  closed, so an added capability cannot ride along with a "tuning" change;
- an existing dependency declaration may only be edited in place, and only when its resolved target
  is an allowlisted module; adding or removing a declaration fails closed. A new dependency, SDK
  entry or network client therefore keeps the full contour;
- in `apps/web/src/App.tsx` only literals inside `handleAttachChatFiles` and `uploadChatAttachment`
  may change. That path does call the API gateway (`issueConversationMediaUpload`,
  `finalizeConversationMediaUpload`); it is an explicit, named, owner-reviewed entry, and every other
  part of the shell is compared;
- a module that is absent at the installed baseline is a first landing: new modules keep the
  critical/manual component release route;
- a range that ships no runtime code (documentation only, or only test files of an allowlisted
  module) is not a Web release and never starts a publication.

What the class does not prove, and what a review must therefore still check:

- a changed literal value is trusted by construction, and literal values can be security-relevant:
  the declared upload content type, the decode and pixel budgets, the encode quality, a selector or a
  call target that a later revision introduces. The media API re-validates the content type, but the
  constant itself is a review responsibility;
- whitespace and comments are not compared, so a directive such as `@ts-nocheck` can ride along with
  a legitimate literal change. It cannot add runtime code, and the mandatory typecheck still runs;
- literals are neutralised by value, not by position, so once a revision introduces a literal-driven
  call target, MIME type or element tag into an allowlisted module, later deliveries can retarget it
  without a structural signal. Introducing such a literal is an invariant change and needs explicit
  re-review;
- a module's existing capabilities are not re-argued on every delivery. Adding an allowlist entry or relaxing an invariant is a reviewable
  change of `scripts/safe-web-boundary.js`; both it and a removal or hardening reach the operator only
  through a new critical review and enrollment of the controller source (`controllerSha`). The full Web
  quality contour stays mandatory for both classes, and the entire main-push CI must still pass before
  the controller publishes anything.

## One-time owner activation checklist

Complete this as one bounded activation decision after this infrastructure PR's checks/reviews.
These steps are intentionally not executed by the implementation task.

1. Merge the reviewed infrastructure PR under existing rules. Establish a canonical, healthy
   installed baseline from that reviewed source through the current critical Timeweb procedure;
   retain its root-only release.env, API/Web release labels, runtime identity, backup/restore and
   existing monitoring. Enrollment must not invent a baseline or waive accumulated critical code.
2. Install a dedicated root-owned, full-history clone (never `--depth`) at
   `/opt/phub/timeweb-beta/standard/source`, detached at that exact reviewed source: the controller
   needs `git merge-base --is-ancestor` between the installed baseline and the candidate. Install its pinned npm dependencies with `npm ci --ignore-scripts`
   during enrollment (never from candidate code during a run); this requires npm on the host
   alongside `/usr/bin/node`. Require root ownership and no
   group/world write for controller, dependencies, Git metadata and all parent paths. Keep the
   controller checkout unchanged; updates to it require a new critical review and enrollment.
   Install `deploy/timeweb/run-standard-delivery.sh` as root-owned 0755
   `/usr/local/sbin/phub-standard-delivery`. Required fixed commands are `/usr/bin/node` (22), git,
   Docker, gh and unzip. Enroll the existing root Docker read credential for immutable GHCR pulls.
   Configure `/etc/phub/timeweb-beta-standard-delivery.json` (root:root 0600) from the example with
   enabled=true, named owner and exact controllerSha. This config is standing authority. It lives
   **outside** `/etc/phub/timeweb-beta` on purpose: the critical runtime-secret provisioner requires
   that directory to contain exactly its four service env files plus `.release-identity.json`, so any
   extra entry there — including this config — would stop every future critical release with
   `target_file_set`. A legacy `standard-delivery.json` at the old inside path **must be removed from
   `/etc/phub/timeweb-beta`** before the next critical provision, and the post-condition is that the
   directory holds exactly `api.env`, `worker.env`, `realtime.env`, `migrator.env` and
   `.release-identity.json` (root:root, directory 0700, files 0600). The one intended transient extra
   entry there is the short-lived `github-release-reader.token`, which the critical procedure moves
   out before provisioning and removes afterwards.
3. Enroll the SSH operator transport instead of any privileged runner, in this order, before any
   key is installed. Create an unprivileged account named `phub-operator` (never the distro
   `operator` group) with no Docker group and no general sudo. Install
   `deploy/timeweb/operator-entry.sh` — reviewed verbatim in this repository — as root-owned 0755
   `/home/phub-operator/bin/operator-entry`, with its directory root-owned and traversable (`0755`),
   and then set that file as the account's login shell. A forced `authorized_keys` command alone is
   not enough: sshd still starts the account's login shell (with `-c`), so a `nologin` shell would
   refuse the delivery, and any shell would be a real shell. With the entry as the login shell every
   connection — with or without a forced command, and with any requested remote command — ends in the
   entry, which ignores arguments and reads only stdin. Set the shell with `usermod -s` (or `vipw`);
   `chsh` refuses a shell that is not listed in `/etc/shells`, and this one is not. Confirm the sshd
   PAM stack does not load `pam_shells` (stock Ubuntu does not), otherwise the login shell must be
   listed there too. Only then add the `authorized_keys` entry, as defence in depth, with
   `command="/home/phub-operator/bin/operator-entry",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`.
   The entry reads the token and the run id as two stdin lines. It accepts the token as any printable
   non-space byte string (an assumed alphabet rejected real GitHub tokens) and rejects whitespace or
   control bytes with their byte codes; the run id must be decimal. It then exports `GH_TOKEN`
   and `PHUB_SOURCE_CI_RUN_ID` and `exec`s
   `sudo -n --preserve-env=GH_TOKEN,PHUB_SOURCE_CI_RUN_ID /usr/local/sbin/phub-standard-delivery`
   with **no arguments**: sudoers cannot express a wildcard argument safely, and the launcher
   validates the decimal run id itself. sudoers grants exactly
   `phub-operator ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/phub-standard-delivery` and nothing
   else. `TIMEWEB_OPERATOR_KNOWN_HOSTS` must be a complete `known_hosts` line whose host field
   matches `TIMEWEB_OPERATOR_HOST` (for example
   `phub-timeweb-staging.<tailnet>.ts.net,100.77.212.57` followed by the ed25519 `ssh-ed25519` key
   whose fingerprint `deploy/timeweb/target.json` pins), because the delivery uses
   `StrictHostKeyChecking=yes` without a merge of the runner's own known-hosts. All four transport
   secrets
   (`TAILSCALE_AUTHKEY`, `TIMEWEB_OPERATOR_SSH_KEY`, `TIMEWEB_OPERATOR_KNOWN_HOSTS`,
   `TIMEWEB_OPERATOR_HOST`) must be environment secrets of `timeweb-standard-delivery` — never
   repository secrets, because `pull-request.yaml` executes branch code on `pull_request`. The operator key, the pinned host key, the tailnet host name and the tailnet auth
   key live only in the `timeweb-standard-delivery` environment (`TIMEWEB_OPERATOR_SSH_KEY`,
   `TIMEWEB_OPERATOR_KNOWN_HOSTS`, `TIMEWEB_OPERATOR_HOST`, `TAILSCALE_AUTHKEY`), so the job runs on
   a GitHub-hosted runner and no self-hosted surface exists to be reached by another workflow. The
   controller always executes installed code; the transport never checks out or runs a candidate.
   Workflow token grants are actions write for publisher dispatch, contents read and packages read;
   the token expires with the run and no production secrets are passed into PR execution. Existing
   one-shot human reader-token policy is unchanged.
4. Preserve required `pr-gate`, main protection and review of critical workflow/deploy/policy paths.
   Enable native auto-merge for eligible ready PRs and grant the named outcome owner standing
   authority to queue those merges. No arbitrary PR label grants production authority. Configure
   environment `timeweb-standard-delivery` and the existing `timeweb-amd64-publication` environment
   for the bounded standing route, main only, without repetitive human review for eligible ordinary
   runs; retain independent review/protection for changes to the mechanism. Set repository variable
   `LK2_STANDARD_DELIVERY_ENABLED=true` last. Rehearse one synthetic eligible change and a forced
   Web-health failure on an isolated fixture before live enrollment, then observe the first pilot.

GitHub settings, sudo/host installation, baseline deployment and actual enable are external owner
actions. Adding source files does none of them. This SSH transport exists precisely because a
user-owned repository cannot scope a self-hosted runner to a single workflow: never enroll a broadly
accessible privileged runner as a shortcut.

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
