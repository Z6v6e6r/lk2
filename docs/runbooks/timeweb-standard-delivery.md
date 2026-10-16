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

## Standard invocation diagnostics

After trusted source, Git metadata and dependency path checks, the standard controller creates a
separate `0700` directory `/opt/phub/timeweb-beta/standard/attempts` and a unique `0600` invocation
receipt (`PHUB_STANDARD_DELIVERY_DIAGNOSTIC_V1`). It pins source CI and executing controller SHA;
candidate SHA and publication run are added when known. `STARTED` records the current stage and is
never success evidence. Controlled failure codes, bounded failure history, command exit status and
allowlisted signals identify failure and recovery stages without retaining error text, stacks,
arguments, environment, stdout or stderr. Early untrusted-path failures have no durable receipt.

The existing Actions job logs a diagnostic ID and SHA-256 only after file fsync, directory fsync and
readback. That job log binds the unique invocation to its outer workflow run; the existing two-line
SSH transport is unchanged. Reconciliation reads the exact root-only file by ID and checks the
logged checksum. `diagnostic=unavailable` makes no readback claim. A persistence failure during
rollout never triggers an extra rollback. Initial or terminal diagnostic failure reports
`unavailable`; canonical delivery success and its lock release remain unchanged. The canonical
rollout receipt remains separate evidence. These files are not automatically deleted.
Changing this source requires reviewed enrollment before a future authorized attempt; it neither
repairs an old missing diagnostic nor authorizes a retry, publication, enrollment or live rollout.

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
container ID stayed unchanged. It exercises one delayed Web startup and gates its API/Web nginx
fixtures with HTTP healthchecks and bounded Compose `--wait` before strict observation. An HTTP-unavailable
fixture must fail that gate; the production Compose arguments and observation policy are unchanged.
The full CI integration job opts into this rehearsal. This is LOCAL Compose/rollback evidence, not
canonical publication or production evidence. For the frozen Android API/Worker and migration
bridge, this inert correction is admitted only as its exact atomic two-blob tuple, mirrored in
Node and the Python backup producer. Missing peers, changed blobs or non-regular modes are rejected;
the generic controller path lists remain closed.

## Explicit critical API/Web upgrade

The automatic numeric CI-run entry remains Web-only and uses the same eligibility rules above.
Authentication, lockfile and deployment changes do not become eligible for that automatic route.
An explicitly approved API/Web deployment may instead invoke the root-only manual mode in the
same enrolled controller. This mode consumes an existing canonical first-attempt publication;
it never publishes, reruns a workflow, renders a candidate secret set or runs candidate scripts.

The controller is reviewed, merged, passes full main CI and is installed as a clean root-owned
checkout at `/opt/phub/timeweb-beta/standard/source`; its enrolled `controllerSha` must match HEAD.
The published candidate may precede the controller only when it is an ancestor and every intervening
change is an addition/modification of the controller, its focused tests/rehearsal or this runbook.
The sole closed exception is candidate `5429a69c` through bridge
`9bbe61d63ba078f54d683d561ff097e96b59274e`: exactly nine reviewed additions from PRs #340/#342,
with pinned `100644 blob` identities. They are never imported or executed by the controller.
The bridge-to-controller range remains controller-only; subsequent changes to these files reject.
This ancestry exception does not alter runtime validation, admit 0096, publish a different image
or authorize another bridge. The separate exact runtime proof below is the sole 0096 allowance.
A second, independent one-time runtime compatibility proof is closed to previous API and Web
source `c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf`, candidate
`0d6078be7a50ed3f5761d66071527be003bd568f`, tree `5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4`.
It checks the full old/new Git mode, object type, blob identity, status and unique path for exactly
three otherwise-prohibited transitions: addition of `0096_profile_contacts.sql` blob
`dc9171185f0a7b75d80ecde64c6b08b4f3baa4c1`, and the reviewed observability verifier `.d.ts`
`d282e352bc8cba454302bbaf5665b8341f67f78a` to `b6146afd73c86210bb1799dcd42a0e1760b346e1`
and `.js` `84b77275876866a14c3da9983d6d965a26c0f3e5` to
`e7f8d4bbc520a459b1d389b4ee9fd87aee04a7bd`. Every remaining path passes the unchanged runtime
validator. Any altered or missing transition, duplicate path, additional migration or runtime
contract change rejects. Each prior service identity is checked separately; the proof expires
naturally once either prior source differs.

The candidate API entrypoints, API/migrator Dockerfiles, database package exports/build and index
are byte-identical to the prior source. Contact SQL/source is physically copied into the API image
but unreachable from this fixed runtime entrypoint: only tests import the contact repository.
The controller still requires `PHUB_MIGRATOR_ENABLED=false`, refuses an active migrator and can
activate only API/Web with `--no-deps`. No migration is executed. The verifier scripts are operator
control-plane code, absent from candidate API/Web final images; the executing verifier is always
from the reviewed, pinned root-owned controller checkout. This runtime exception itself does not relax provider monitoring, alert delivery, backup,
rollback, excluded component or secret-lineage checks. The separate owner-approved callback
observation policy below changes only its two explicitly named provider evidence requirements.

Publish the exact candidate while it is current main, then merge and enroll the reviewed
controller-only compatibility change. Candidate-to-controller ancestry must still contain only
`CONTROLLER_FILES`; a later active contact reader (including PR #344), package export, API contract
or any unrelated product change stops this rollout. The controller change has its own full CI and
review; source publication and controller enrollment remain distinct authorized transitions.
The candidate also contains the reviewed runtime `@grpc/grpc-js` patch, so full API CI and the
900-second API/Web observation are required. Worker/Realtime, secrets, ingress and provider
configuration remain outside this operation.

Any other product, dependency, workflow, Compose, manifest validator or runtime-contract drift stops the
operation. Source main CI and canonical publication custody are checked independently.

The operator installs the original archive at the fixed candidate release path
`releases/<candidate-sha>-<publication-run>-1/artifact/canonical-artifact.zip` under the beta root,
with root-owned non-writable parents and a single-link `0600` file. The controller reads public
GitHub metadata without credentials, verifies the exact run/artifact identity and archive digest,
and accepts exactly `release-manifest.json` plus `release-manifest.sha256`. All five canonical
image entries remain required. No GitHub token is provisioned on the host. GHCR pulls use the
existing Docker configuration or anonymous access; missing access stops before activation.

The fixed root-only request `/opt/phub/timeweb-beta/operator/api-web-upgrade.json` contains exactly:

- `schema`: `PHUB_TIMEWEB_API_WEB_OPERATION_V1`;
- `target`: `lk2.padlhub.su`;
- `controllerSha`, `candidateSha`, `candidateTree`: full Git identities;
- `sourceCiRunId`, `publicationRunId`, `artifactId`: decimal strings;
- `artifactDigest`: GitHub archive `sha256:` digest; `manifestSha256`: manifest checksum;
- `expectedApi` and `expectedWeb`: each actual prior container `id`, immutable `image`, and `releaseId`;
- `confirmation`: `DEPLOY_API_WEB_<CANDIDATE12>_FROM_<API12>_<WEB12>` using uppercase SHA prefixes.

The previous API and Web releases are independent. Success installs a root-only
`installed-components.env` descriptor bound by checksum to the successful rollout receipt. It records
the updated API/Web and actual unchanged Worker/Realtime digests plus `PHUB_RUNTIME_SECRET_SET_RELEASE_ID`
for the existing secret set. Both automatic and manual controllers validate this descriptor on the
next release. The original five-image canonical manifest remains untouched and separate; the descriptor
never represents itself as that manifest. The current API release environment supplies
unchanged runtime paths and excluded component declarations. Separate previous overlays preserve
each service's actual release label and digest. The runtime-secret files and `.release-identity.json`
remain byte-identical and bound to that baseline secret set; a successful component update does not
claim to have rotated the complete runtime secret set.

Before activation, create root-owned `0700`
`backups/<candidate-sha>-<publication-run>-1-api-web` under the beta root. Required inputs are:

- `database.pgcustom` (`0600`) and `database-backup-receipt.json` (`0600`), with schema
  `PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1`, `baselineReleaseId`, fresh `completedAt` (at most one hour),
  exact `backupFile`, `backupSha256`, `restoreVerified: true`, immutable PostgreSQL `restoreImage`,
  and identical `restoredLedgerSha256`/`sourceLedgerSha256`. The backup must have been independently
  restored into an isolated disposable database. Backup hashing streams files up to 64 GiB in
  bounded memory and rejects descriptor changes during the read. Binary rollback never restores the live database.
- For V1, the existing canonical provider inputs under `observability/timeweb-monitor-readback.json` and
  `observability/alert-test-readback.json` (root-only `0600`). The controller reuses their original
  strict validators: project `262717`, exact intended API/Web monitor IDs, configuration, at least
  two regions, three healthy rounds, no incident, fresh provider capture (at most 30s), and recent
  real email/Telegram delivery, release-owner acknowledgement and recovery proof. All prior alert
  deadlines remain enforced. No alternate timestamp-only PASS schema is accepted.

The shared `standard/active` path excludes all standard/manual releases: the automatic route owns a
directory; this manual route atomically installs a single-link root-only pointer file. Each route
refuses an existing path of either type. The operation copy is durable before atomic lock acquisition; the plan, overlays, backup marker and
`PREPARING` journal are written only by its winner and must be complete before activation. A losing
contender writes no plan/journal. A crash during preparation is recoverable from the operation copy:
verify the exact unchanged previous pair, remove only the incomplete controller metadata, record
`preparation-aborted.json` and fsync release of the owned pointer, without restarting a service. The controller writes an
immutable `plan.json`, previous overlays, baseline/configuration hashes and `backup.complete`, then
journals `PREPARED` before the first container change. A pre-activation failure attests the exact
unchanged previous pair, writes `ABORTED` and releases the manual lock; it never restarts a service. It pulls and smokes API/Web offline with read-only artifact filesystems. The Web configuration
check receives only bounded, ephemeral tmpfs scratch paths (`/run`: 1 MiB, `/var/cache/nginx`: 8 MiB),
with noexec/nosuid/nodev; nginx needs these for its pid/cache checks. No runtime environment, host
volume or published port enters the smoke container. The controller starts API with
`--no-deps`, waits for exact identity/readiness, then starts Web with `--no-deps`. Read-only
`compose config --format json` enables all profiles with `--profile '*'` to validate all five service
definitions, including Worker and Migrator. `pull` and `up` keep profiles disabled and target only
API/Web. Durable intent
phases bracket both actions. Every boundary attests unchanged non-target containers and runtime
files. No profile activation, dependency restart, migration, ingress or provider write is available.

After startup, the controller observes both private readiness and public HTTPS routes for 900s with
61 samples/service. Any failed probe, container restart/replacement, excluded-state drift, missing
fresh canonical provider readback in V1 or API p95 above 1500ms/Web p95 above 1000ms triggers restoration. This
mode stops on the first failed probe, which is stricter than the existing error/readiness thresholds.
`SUCCESS` is written only after final attestation; the successful receipt then releases the lock.

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-web /opt/phub/timeweb-beta/operator/api-web-upgrade.json
```

On handled failure the controller restores previous Web first, then previous API, proves their
exact image/label/health and unchanged runtime files/non-target services, and records `ROLLED_BACK`.
A failed restore records `ROLLBACK_FAILED`. Both retain the exclusion lock for reconciliation.
Interrupted transactions cannot start a new candidate. The shared lock points to the transaction-owned
operation copy and durable plan, so rotating the live request cannot remove recovery custody. They
permit only explicit convergence to the recorded previous pair:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-web-recover /opt/phub/timeweb-beta/operator/api-web-upgrade.json
```

Recovery consumes locally retained previous images and never republishes or replaces the archive.
A foreign runtime image, altered request/plan/overlays, secret drift or incomplete journal is STOP.
Keep the lock and root-only evidence until the release owner reconciles them; do not delete the
lock to make a retry pass. A successful API/Web receipt does not attest Worker/Realtime promotion,
new identity enrollment, provider login, APK installation on a physical phone or any migration.

Terminal `SUCCESS`/`ROLLED_BACK`/`ABORTED` receipts with a surviving lock use
`--critical-api-web-reconcile` with the same fixed request path. This readback-only mode validates
receipt/plan/overlay hashes, exact healthy terminal pair, runtime-secret lineage and excluded states,
then durably records `RECONCILED` and removes/fsyncs only its own pointer. It runs no `up`, and permits
retrying reconciliation after a crash between terminal journal and lock removal. Unknown or nonterminal
states require recovery and retain their lock.

For V1, the existing provider inputs must be maintained by the release owner's approved readback collector:
read current authenticated monitor results at least every 15s, write a root-only temporary file in
the canonical observability directory, fsync and atomically replace the existing readback. No
monitor/alert configuration or provider mutation is performed by the deployment controller. Without
available approved readback tooling and real current alert proof, stop before activation; never
keep `readAt` fresh by merely changing its timestamp. Final canonical input snapshots and the raw
observation are stored under the transaction and checksum-bound into `SUCCESS`, together with the
installed descriptor.

## One-time callback direct observation

On 2026-10-03 the release owner explicitly approved replacing the unavailable automatic Timeweb
monitor readback and recent Email/Telegram delivery/recovery test for the already-published Android
callback fix. This is an explicit selection, never a fallback when a V1 readback is absent, invalid
or stale. Timeweb monitoring and Email/Telegram configuration stay enabled and the owner watches
them; this context is not a provider PASS and does not prove notification delivery or regional
availability. Every other V1/automatic eligibility and evidence requirement remains unchanged.

After the original window elapsed without activation, the release owner must explicitly renew
the deadline to `2026-10-06T00:00:00.000Z` (6 October 03:00 Moscow) before activation. The expired
operation is not replayed; the renewed request and reviewed controller must agree on this deadline.
Artifact, target, previous pair and all other gates stay fixed.

The same root-only request uses `PHUB_TIMEWEB_API_WEB_OPERATION_V2`, adds `evidencePolicy:
CALLBACK_DIRECT_OBSERVATION_V1` and fixed `expiresAt: 2026-10-06T00:00:00.000Z`, and extends
confirmation with
`_DIRECT_15M_NO_PROVIDER_EVIDENCE`. It is closed to all of these identities:

- candidate `0d6078be7a50ed3f5761d66071527be003bd568f`, tree
  `5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4`, source CI `37034485776`;
- publication `37038298584`, artifact `11241473445`, archive SHA-256
  `64b2cbf7f6613d62f3aa08d6da6c65c6d5ff50ebc88e19c5bcbd2239237913e9`, manifest SHA-256
  `9d631c9adf4ffce0ab68527bcf99828faa72ee1c51f655bf5325c97f435d042e`;
- both previous releases `c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1`, previous API
  digest `sha256:c798c0f881daecca72500d0e3e2d525f77ee4df500c2f662a346b521fa9d1681` and Web digest
  `sha256:887455ea273abc6138bdb176f4af82295c37d56ac9a7a96b83c006e5f4d72b9e`.

Fresh expected container IDs, no restarts, exact target and all canonical custody checks still
apply. Deployment and the complete observation must finish before `2026-10-06T00:00:00.000Z`.
This permission expires naturally after the previous pair changes; no other artifact, candidate,
previous source or target can use it. Expiry never prevents restoration of the recorded previous
pair or verification of historically successful evidence.

The controller durably creates a transaction-owned root-only `release-owner-observation.json`
attestation bound to the operation bytes, exact controller/candidate/tree/publication/previous pair
and explicit override. V2 plan and receipts identify the policy; SUCCESS additionally binds that
attestation, real direct observation and installed descriptor by checksum. They honestly record
`NOT_COLLECTED_EXPLICIT_OVERRIDE`; no provider/alert readback files or fake provider hashes are
created. Legacy V1 SUCCESS continues to require its original provider files/hashes. Mixed receipt
shapes, policy swaps and changed attestation/observation bytes reject. Shared installed-baseline
validation understands both shapes, preserving secret lineage and later standard Web compatibility.
Rollback does not depend on availability or freshness of the owner attestation.

API/Web activation still requires a fresh independently restored database backup, immutable
rollback images, unchanged runtime secrets/excluded services, no migrator, shared lock and durable
intent. After Web startup, require the code-free HTTPS `/android/oauth/yandex` response to be 200,
without Location/redirect and with the expected history-clearing fallback HTML. Then measure at
least 900 real seconds and 61 rounds/service of private readiness and public HTTPS probes, recording
individual timestamps and both latencies. API/Web p95 use the slower of those probes (limits
1500/1000 ms). Any probe, identity/restart, attestation, policy-window or latency failure follows
the existing Web-then-API rollback. No env/request setting can shorten the production window.

### Pin the reviewed controller after unrelated main drift

For this one-time policy, active contact reads from PR #344 are outside the candidate runtime.
Prepare the controller task commit T from exact reviewed `a351052475c00387a1c12eabedef71b1e28ad583`.
Merge normally so T remains an ancestor of main, but enroll detached T, never the containing merge
or newer main. Candidate 0d must be an ancestor of T; its entire no-renames delta must remain within
the existing CONTROLLER_FILES set. Do not widen that set or admit PR #344 through another bridge.

Before enrollment, independently verify first-attempt full automatic PR-head CI for exact T and
first-attempt full main CI for current containing merge M. Verify T is an ancestor of M, T descends
from exact a351, and every controller/test/rehearsal/runbook blob changed by the task is identical
in T and M. Record T, M, both CI runs and these identity checks in a root-only enrollment receipt.
Install a clean root-owned detached checkout at T; config `controllerSha` must equal T, preserving
owner/enabled fields. Drift requires a fresh containing-main check; it never changes the controller
pin or the application candidate. All original candidate/controller and runtime delta validators
continue to run before any pull/up. No image republication, migration, contact-reader activation,
Worker/Realtime promotion, provider write, secret, signing or ingress change is authorized here.

## Closed manual Web compatibility bridge for the profile overflow fix

`--critical-web` is a separate manual mode of the same enrolled controller. Numeric CI-run
invocations retain the existing cumulative automatic policy. This mode never dispatches a
publisher, downloads an archive, uses a GitHub token, starts API/Realtime/Worker/Migrator, changes
secrets, or writes `installed-components.env`. It consumes the already transferred canonical V2
archive and public first-attempt metadata through the existing custody validator.

The reviewed API baseline is `0d6078be7a50ed3f5761d66071527be003bd568f`, tree
`5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4`. The reviewed whole-repository Web runtime anchor is
`8960afe24211372320006fc4c5b18905923672f5`, tree `bf0988012cfce0f14811491a14ae46fa57fe5541`.
The exact raw, no-renames, no-abbreviation, NUL-delimited baseline-to-anchor delta has SHA-256
`c71dcfeb564b648ff78305680af3d3a37477a2d54e1db8101662c2b1d6e11fec`. This is a closed reviewed
compatibility proof, not a directory heuristic or a user-supplied allowlist. The entire candidate
tree must differ from the anchor only in the eight named paths in `WEB_CONTROLLER_FILES`, each an
added/modified regular `100644 blob`. The six controller/test/rehearsal/runbook paths are joined only
by `.github/workflows/publish-timeweb-amd64-images.yaml` and
`scripts/timeweb-amd64-publication-workflow.test.ts` so the complete internal publication artifact
can retain every file referenced by its per-image checksum sidecars. The publisher YAML is excluded
from the Web build context by `.dockerignore`. Its test is not executed or imported by `npm ci`,
`contracts:generate`, `build:packages`, or the Web build, and the final nginx image copies only
`apps/web/dist`. Root dependencies/lockfiles, Dockerfiles, all other package/build inputs,
generated-contract inputs, application files, every other workflow, renames and deletions remain
forbidden in that tail. `COPY . .` therefore keeps all Web build inputs frozen.

Run `38053674241` attempt 1 published the five images and a valid canonical V2 pair for
`4df9a8512a4735af8eb33bd9b4085febfefec2cc`, but its internal artifact omitted 48 referenced BuildKit
readiness/provenance diagnostic files. The original same-run per-image artifacts retain those
bytes; they are incident evidence and cannot repair the immutable internal custody artifact. That
release is ineligible for deployment. The correction must pass source checks and merge before a
separately approved controller enrollment and a new exact-main publication; never rerun or replace
that run's artifacts.

The candidate must equal the executing enrolled controller commit and the exact current `main`
with successful full first-attempt push CI. Use a **merge commit preserving the runtime anchor**;
a squash or rebase that removes it from candidate ancestry is ineligible. Refresh these identities
before every transition. Publication occurs after this source merge, through the existing canonical
publisher at that exact current main. Publication, controller enrollment and Web activation each
retain their own authority and prerequisites. No existing merge/deploy approval enrolls this new
controller automatically. Any later product/build change requires a new compatibility review;
this bridge does not widen future automatic eligibility or support other baseline sources.

| Browser behavior in this anchor                                    | Compatibility with API baseline                                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile grid                                                       | Contains the merged screen-width correction.                                                                                                                                                          |
| Existing home/subscription/game reads                              | Existing API contracts; principal-generation guard prevents stale home responses after a session switch.                                                                                              |
| Advisory subscription quote                                        | Production gateway omits `getGameJoinConditions`; picker and panel stay absent. Synthetic preview gateways may still expose it. Enable later only with a separately reviewed deployed API capability. |
| Existing JOIN                                                      | Same `joinGame(gameId, revision, invitationId)` delegation and SDK wire body; no subscription selection is added to the command.                                                                      |
| Password-login, profile-contact and booked-operation SDK additions | No production Web gateway exposure or call sites. No API, auth owner or schema is activated by this Web rollout.                                                                                      |

The release includes the cumulative reviewed game rendering/navigation changes. Compatibility with
an unchanged API does not prove authenticated production journeys; collect product feedback after
activation. LOCAL fixtures and CI are separate from that evidence.

### Inputs and execution

The fixed root-owned `0600`, single-link request is
`/opt/phub/timeweb-beta/operator/web-upgrade.json`, with root-owned non-writable parents. It is read
once using `O_NOFOLLOW`, checked against its open descriptor, copied durably into the transaction,
and hashed. Unknown/duplicate fields reject. Its exact keys are:

- `schema`: `PHUB_TIMEWEB_CRITICAL_WEB_OPERATION_V1`;
- `target`: `{ "hostname": "lk2.padlhub.su", "serverId": 8886471, "projectId": 262717 }`;
- `component`: `web`;
- `controllerSha`, `candidateSha`: the same enrolled merged main SHA;
- `candidateTree`: its exact tree;
- `controllerSourceCiRunId`, `sourceCiRunId`: the same successful full first-attempt main-push CI ID;
- `publicationRunId`, `artifactId`: decimal strings naming the successful first-attempt canonical publication and archive;
- `artifactDigest`: GitHub archive `sha256:…`; `manifestSha256`: canonical manifest SHA-256;
- `expectedApi`, `expectedWeb`: exact `{ "id": "<container-id>", "image": "<immutable-component-ref>", "releaseId": "<installed-release-id>" }`, both from the pinned API baseline source;
- `expiresAt`: canonical UTC ISO timestamp, 20–60 minutes ahead before deploy/preflight/activation;
- `confirmation`: `UPGRADE_WEB_<CANDIDATE_FIRST_12_UPPERCASE>_FROM_<PREVIOUS_WEB_DIGEST_LAST_12_UPPERCASE>_KEEP_API_0D6078BE7A50`.

Prepare the canonical archive at
`/opt/phub/timeweb-beta/releases/<candidate>-<publication>-1/artifact/canonical-artifact.zip` using
existing custody procedures. Prepare a root-owned `0700` transaction directory
`/opt/phub/timeweb-beta/backups/<candidate>-<publication>-1-web` containing the existing
`database-backup-receipt.json` and `database.pgcustom` contract: independent verified restore,
matching source/restored ledger, exact API baseline, immutable restore image and completion within
one hour. The controller validates these inputs; it does not create a backup, restore a production
database or provision evidence. The canonical provider-monitor and alert readbacks remain mandatory
and must satisfy `api-web-observability.v1.json`; there is no direct-observation waiver.

After exact-source publication, reviewed controller enrollment and separately approved activation:

```sh
/usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js --critical-web /opt/phub/timeweb-beta/operator/web-upgrade.json
```

The shared exclusion pointer binds the durable operation/plan before activation. Every preflight,
observation and recovery checks unchanged API identity/start time/restarts, all other running
containers (including ingress/dependencies/Realtime/Worker), the baseline env, controller Compose,
operation/plan and five secret-file hashes; an active migrator rejects. It validates the prior Web
image locally for rollback. It pulls only Web, verifies its immutable source/platform identity,
runs the existing network-none readonly Web smoke, journals `ACTIVATING`, and executes only
`up -d --no-deps web`. It then observes 61 rounds over at least 900 seconds, with private/public
API/Web readiness and latency, fresh strict monitor readbacks, and unchanged backend/secret state.
The durable receipt binds plan, operation, artifact/manifest, backup proof, final monitor/alert
snapshots and observation digest. Canonical backend image entries remain unused; the backend
release descriptor remains unchanged. Health/latency success still requires profile/product QA.

### Interrupted and failed operations

No failed or uncertain attempt is automatically replayed. An activation/observation failure
journals rollback intent and restores only the exact recorded previous Web digest/release label.
`ROLLED_BACK`, preparation failure or rollback failure retains the pointer for owner reconciliation.
`SUCCESS` releases it only after durable receipt. A lock-release/fsync failure after success never
starts an extra rollback.

```sh
/usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js --critical-web-recover /opt/phub/timeweb-beta/operator/web-upgrade.json
/usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js --critical-web-reconcile /opt/phub/timeweb-beta/operator/web-upgrade.json
```

These are separately authorized recovery actions. Recovery reads the pointer-bound operation copy,
not the mutable request; expired deployment authorization permits only restoring the recorded prior
Web. `PREPARED`/`PREPARATION_FAILED` can be aborted after exact prior-runtime readback without `up`.
`ACTIVATING`/`OBSERVING`/`ROLLBACK_INTENT`/`ROLLBACK_FAILED` permit one previous-Web restoration;
unknown Web images or changed non-target state stop. Reconciliation accepts only success, proven
rollback or proven preparation abort, attests its corresponding runtime, writes a durable reconciled
receipt and releases the owned pointer without service mutation. A fully prepared plan without an
acquired pointer has never activated a service; it remains an orphan for an explicit owner audit,
not a reusable deployment input. Keep all operation/plan/receipt/evidence files for that audit.

## Explicit Android API + Worker bridge and recovery

The enrolled controller has a separate manual `--critical-api-worker` mode for the reviewed
Android release `11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1`. Numeric CI callbacks
and the forced SSH operator entry remain Web-only. Merge, publication, source preparation,
controller enrollment, migrations, credential custody, deployment and provider activation are
separate operations. This source change grants none of those live permissions.

The closed bridge accepts only the API `0d6078be.../37038298584` and Worker `ff42c9e9...`
preimages pinned in `scripts/timeweb-api-worker-contract.js`. The operation also binds their
fresh complete container identities, the actual current secret-set release ID, candidate
secret-file hashes, target server `8886471`, project `262717`, `lk2.padlhub.su`, controller
source CI, canonical publication/artifact/manifest and a 20–60 minute expiry. Changing the
source, target, preimage or environment requires a newly reviewed bridge. There is no general
compatibility override.

Before an approved execution:

1. Enroll the reviewed controller source through the existing enrollment procedure; its delta
   from the published candidate may contain only the named controller, test and runbook files.
   Obtain exact deployment authority for mounting and reading the existing FCM credential,
   enabling global FCM runtime, updating API and Worker, and receipt-bound failure recovery.
2. Separately complete approved migrations `0096` and `0097`. The controller runs no migrator
   and requires the complete 101-row checksum ledger, without unknown or legacy entries.
3. Produce the existing fresh database backup and isolated restore proof **after** those
   migrations, in `<candidate>-api-worker`. Both proof ledger digests must equal the candidate
   ledger; a backup containing 99 migrations cannot pass. Retain the previous API/Worker images
   locally and collect the existing monitoring and alert-test evidence. No database restore is
   automatic in this operation.
4. Through separately authorized secret preparation, use the existing provisioner to produce
   `/etc/phub/timeweb-beta-candidates/<candidate-release-id>/timeweb-beta`. First prepare its
   existing parent `/etc/phub/timeweb-beta-candidates` as a root-owned `0700` directory; the
   provisioner creates only its immediate release parent. The candidate set uses root `0700`
   directories and five regular root-owned `0600` files. Its API/Worker environments must differ
   from the installed set only in `FCM_ENABLED`, `FCM_PROJECT_ID`, `FCM_APP_ID`,
   `FCM_ENVIRONMENT` and `FCM_CREDENTIAL_FILE`. Previous FCM is disabled; candidate FCM is
   enabled for `padlhub`, `ru.padlhub.app`, `SANDBOX`. Realtime/migrator bytes, endpoint
   encryption keys and all other settings remain identical. The preparatory provisioner's
   exported API requires both `targetDir` set to that isolated destination and `backupRoot`
   set to `/etc/phub/timeweb-beta-candidates/<candidate-release-id>/backups` (beneath the same
   private parent). The default `/etc/phub/timeweb-beta-backups` is invalid for this isolated
   target. Pass `expectedCurrentReleaseId: null` for a new candidate staging directory, alongside
   the existing approved input set. Import that export from a separately prepared clean frozen
   candidate checkout at
   `/opt/phub/timeweb-beta/releases/11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1/source`,
   with `expectedSourceSha=11954ffd6d7bf7bd9b198e7e68d2123011f091c1`,
   `expectedSourceTree=f5f5b2b5227018cf237de4fb8d7fe0f8ef53d1d5` and that exact candidate
   `releaseId`. Frozen-source validation binds the importing module's actual Git HEAD/tree.
   `sourceDir` is the approved directory of four secret environment inputs. The enrolled
   controller activates the already prepared candidate set; it does not produce that set or
   rewrite its release identity. The provisioner CLI does not accept a `--target-dir` argument.
5. Provision the FCM file under its existing separate custody policy. The controller checks
   metadata only, never reads, hashes, prints or copies the private key. Worker mounts it
   read-only and parses it when global FCM starts. The API receives no credential mount.
6. Keep Android tenant runtime gates off, active `ru.padlhub.app/SANDBOX` FCM providers absent,
   and live FCM delivery leases at zero. Suspend tenant creation and direct/admin SQL changes
   during the operation. The controller holds the same per-tenant advisory locks used by the
   normal notification-runtime and Android-provider commands, on one READ COMMITTED/READ ONLY
   PostgreSQL session through activation and observation. This fences those canonical commands;
   it does not constrain an administrator bypassing them.

Write the reviewed root-only operation to
`/opt/phub/timeweb-beta/operator/api-worker-upgrade.json`. Its schema is
`PHUB_TIMEWEB_API_WORKER_OPERATION_V1`; copy exact fields from `validateApiWorkerOperation`,
not a historical screenshot. The confirmation is
`UPGRADE_API_WORKER_11954FFD6D7B_FROM_0D6078BE7A50_FF42C9E9A238_GLOBAL_FCM_ON_TENANT_PROVIDER_GATES_OFF_NO_SEND`.
The enrolled Linux host must provide `/usr/bin/flock`; an empty, private executor file stays
in `standard` permanently. The kernel lock is retained by the parent descriptor, survives the
acquisition child's exit and is released on controller exit/crash. No PID-file deletion or
stale-owner takeover is used.

Only after exact live approval, invoke the enrolled runner:

```sh
/usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker /opt/phub/timeweb-beta/operator/api-worker-upgrade.json
```

The controller persists a complete atomic preparation capsule before the shared pointer. An
exact orphan capsule can resume only while the original request, preimages and custody remain
unchanged and no materialized plan, journal, lock or secret-set backup directory exists. Once the pointer exists,
recovery can discover the capsule even if materialized operation/plan/journal files are missing.
There is no automatic retry after mutation intent or ambiguous completion.

The forward sequence is: pull immutable API/Worker images and check packaged entrypoints;
stop Worker; move the old secret directory to its deterministic backup; install the prepared
set; update API; update Worker with `background` and `--no-deps`; observe 61 rounds over at
least 15 minutes; persist the mixed installed-component baseline; release the database fence;
write `SUCCESS`. Each round pins full candidate container identities and the credential mount,
checks private readiness, excluded containers, settings custody, DB gates and monitoring.
Web, Realtime, migrator, dependencies and ingress are never restarted by this mode.

For a nonterminal failure/crash, the approved recovery mode is:

```sh
/usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-recover /opt/phub/timeweb-beta/operator/api-worker-upgrade.json
```

It acquires local exclusive ownership, validates the secure capsule/receipt, and stops a
recognized Worker **before** checking GitHub, PostgreSQL, credential metadata or other runtime
drift. PostgreSQL and GitHub are not required for restoration. If proof has drifted, it leaves
Worker stopped and the shared locks/evidence retained. It never stops a foreign Worker.
`PREPARING`/`PREPARED` can abort by attesting the untouched previous runtime without requiring
candidate staging or credential custody. When no shared pointer exists, the same recovery
command accepts only a byte-identical request/capsule, even after expiry. It proves the original
runtime and settings unchanged and every shared/materialized rollout path absent, durably saves
an `orphan-abort-<capsule-sha256>.json` audit containing the complete capsule, then removes only
that exact `preparation.json`. This is terminal `RECONCILED/ABORTED` with no service action. An
interruption before removal can repeat the same recovery; an expired request never activates a
service. A newly authorized request with fresh expiry can be prepared after this exact cleanup.
The marker records only that this orphan never owned the shared pointer and never mutated
runtime at its attested point. A matching marker permits retrying exact capsule cleanup, including
after unlink completed but the response was lost; it makes no new claim about later runtime.
Keep the orphan audit permanently; foreign rollout state or drift prevents an initial abort,
and malformed or duplicate matching audit records fail closed.

A mutating recovery first contains Worker, then returns the exact old secret inode and bytes,
restores API and Worker from their previous immutable images, verifies readiness, and removes
only its exact candidate installed baseline. Recorded Compose configuration hashes identify
controller-created replacements across interrupted rollback. The previous Worker mounts
`/dev/null` and global FCM returns to disabled. The separately provisioned FCM credential stays
in its private custody location; rollback does not delete it, change provider records, restore
business data or undo a sent push. Repeated recovery after partial restoration is idempotent.
A `SUCCESS`/`RECONCILED` receipt requires a separately reviewed rollback decision; this recovery
command does not roll back a terminal successful deployment.

`SUCCESS`, `ROLLED_BACK` and `ABORTED` retain the shared/provision exclusion until explicit
terminal reconciliation:

```sh
/usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-reconcile /opt/phub/timeweb-beta/operator/api-worker-upgrade.json
```

Reconciliation verifies the terminal runtime/evidence, writes `RECONCILED`, then removes only
the proven provision lock and shared pointer. A crash between those releases can reconcile
again without deleting a foreign lock. A rollback/abort reconciliation needs no DB/provider
fence. Mixed baselines are consumed by the existing shared reader through an exact API_WORKER
receipt dispatch; unchanged Web/Realtime/migrator digests are bound into the receipt plan.

This establishes server rollout/recovery evidence only. Tenant/provider activation, real FCM
calls, token registration, remote push delivery and device acceptance remain separately approved
and verified steps. LOCAL mocked adapter/rename checks and Linux CI lock checks do not establish
STAGING or PRODUCTION execution.

### Frozen CI download recovery for the Android bridge

A transient GitHub HTTP 504 while downloading the pinned Buildx binary fails source CI.
A rerun is not eligible source authority: retain the failed attempt and produce a reviewed
source correction followed by a new full first-attempt main-push run. The correction retries
only the immutable HTTPS GET, with three retries, a 10-second connect deadline, 30-second
per-attempt deadline and 100-second retry budget. Curl truncates output before retries;
an EXIT trap removes the temporary download. The frozen version, URL, SHA-256, installation
readback, BuildKit identity, build/provenance checks and final gate remain mandatory.
Checksum, install and build failures are not retried by this change.

For the existing `11954ffd…/38144582876` Android artifact only, all four controller-delta
checks admit one exact atomic pair of regular `M` Git blobs: the PR CI workflow and its
workflow test. `API_WORKER_CI_DOWNLOAD_PATCH` pins old/new object IDs and `100644` modes;
these paths remain excluded from both generic controller allowlists. Missing peers, extra CI
paths, additions, deletion/rename, executable/symlink modes and changed blobs reject.
The migration BASE closure and independent Python post-migration producer additionally
require the four exact API/Worker reader blobs as part of one atomic six-blob group. These
reader paths remain outside the generic migration allowlist; the wider candidate-to-controller
API/Worker closure already owns them and still applies the exact two-blob CI exception. Runtime image,
manifest, migrator and APK identities are unchanged. This exact-source exception grants no
enrollment, migration, credential, publication or deployment authority and does not accept
PR events, reruns or a mismatched controller SHA. Future CI modifications need a new reviewed
compatibility decision; do not update these pins from live input.

### Migration-only and API/Worker backup preparation

The Android API/Worker bridge requires a post-101 backup, while the current database can still
have exactly the pre-99 ledger. Treat the migration and the post-migration backup as separate
approved operations, before activating the prepared FCM runtime set. The application candidate
remains publication `11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1`; changing the
controller does not require rebuilding or republishing those images.

Enroll the final reviewed controller X with its exact source CI. The previous controller is
`72ca7789b2a4cd93537b442f75c1b8258fce13a0`, tree
`8a79178d7e340c4ce7008bbf2c0b2b411e704572`. Base-to-X lineage permits only unique regular
`100644` A/M entries from the exact controller/test/runbook allowlist. Delete, rename, mode/type
change, symlink, unrelated files and dirty source are rejected. CI binds the actual X/tree,
not an assumed future head. During separately approved enrollment, preserve root-private source
custody and normalize tracked regular source files to 0644 and executable source files to 0755
inside root-owned source directories. Do not apply those modes to secrets: runtime files stay
0600 and runtime directories stay 0700. A source checkout saved with umask 077 can otherwise fail
an explicit `readUpgradeFile(..., 0644)` gate.

The pre-migration backup uses the existing Web producer operation and its original
`backups/<X>-<controller-source-CI>-1-web` directory. Its receipt must pass the complete canonical
validator: root custody, freshness, exact dump path and SHA, baseline identity, immutable restore
image, and matching pre-99 source/restored ledger. The migration does not copy that backup into
another transaction directory or rewrite its receipt.

A migration-only transition must preserve current API/Worker container identities and healthy
state, excluded services, PostgreSQL identity and the complete current secret-set inode/file
hashes. Current secret-set identity is independently observed and need not equal the API release.
The one-shot migrator consumes only current `migrator.env`; no candidate secret swap, API/Worker
restart or FCM credential read/mount belongs to this transition. Verify its actual connection,
restricted role, target cluster/database and the precise DDL/reference/trigger permissions for
0096/0097. Also verify runtime/default ACL compatibility for new tables in `profile` and `identity`;
a generic notification-schema role check is insufficient. Missing role or target proof fails
closed, without granting permissions as part of the migration controller.

Save immutable operation/plan and the complete private preparation capsule before publishing
shared ownership. Persist create/start intent before Docker mutation, identify an ambiguous
create by exact deterministic name/operation label in **all** container states, and separate
start acknowledgement from bounded waiting. Never infer that a container is absent from
`docker ps` alone. A partial ledger (including 100), foreign/multiple container, running migrator,
nonzero/unknown exit or runtime/secret drift preserves locks and evidence for an operator decision.
There is no automatic DDL retry or database rollback. Retain exact terminal containers as evidence;
terminal reconciliation does not authorize replay or deletion. Only an explicit reconciliation
reattests the unchanged boundary and removes proven owned locks, durably and resumably.

After proven exit 0 and the exact 101-row ledger, produce a **new** post-migration backup with
`PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2`. It targets only the fixed published candidate and
`backups/<candidate-release-id>-api-worker`, and binds X/tree/source-CI to the immutable migration
capsule/plan and successful receipt. The expected JSON tuple ledger digest is
`34e0fb1115e0066733c6ede34ab1d9fb8fcc2842f2df192fbaefc03a97ce1c2d`; it differs from the
text migration-manifest digest used by the packaged-ledger validator. Both source/restored
ledger proofs must match. V1 Web backup behavior remains unchanged. Moving a Web dump or editing
its receipt is not compatible backup custody.

The existing V1/V2 tmpfs capacity guard remains mandatory and unchanged. It needs at least
`databaseBytes * 3 + 256 MiB` tmpfs, plus 2 GiB available-memory headroom; disk requires
`databaseBytes * 2 + 5 GiB`. Its failure never selects another storage mode automatically.
Increasing Timeweb RAM is a separately approved infrastructure change and reboots the VM,
invalidating startedAt/restart preimages; refresh and review those inputs rather than silently
rebasing an operation. The manual encrypted-disk alternative below has separate request schemas
and requires its own reviewed storage prerequisites and exact live authority.

### Manual encrypted-disk backup restore for pre-99 and post-101

This controller-source mode preserves the APK and all published API/Worker/migrator image
digests. It is not an app-image release or permission to operate the server. Use it only after a
physical rehearsal on an isolated, disposable Linux amd64 host and a fresh read-only target
preflight. Source/LOCAL mock tests and CI cannot establish production loop/LUKS/kernel behavior.
Missing tools, capacity or namespace proof is STOP; this producer never installs packages,
loads modules, changes swap/propagation, restarts Docker or falls back to plaintext storage.

The root-only fixed request remains `operator/database-backup-restore.json`. It accepts no
operator-authored paths, loop devices, sizes, mount options or container IDs. Copy its exact
fields from `validate_operation`; the two new closed schemas are:

- `PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_V1`: the common Web custody fields plus
  `controllerSourceCiRunId` and the fixed pre-99 JSON ledger SHA
  `025c5ee129bd583131192439d991f0dbbba4fbd19c31c1215bca5adcee9ce17c`.
  `toolCommit == controllerSha` and `releaseId == <controllerSha>-<source-CI>-1` are mandatory.
  Confirmation: `BACKUP_RESTORE_PRE99_DISK_LUKS2_KEEP_API_0D6078BE7A50`.
- `PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_V1`: the existing V2 candidate, controller and
  successful migration capsule/plan/receipt bindings, with the exact post-101 ledger above.
  Confirmation: `BACKUP_RESTORE_API_WORKER_DISK_LUKS2_11954FFD6D7B_KEEP_API_0D6078BE7A50`.

Both require the unchanged pinned API/PostgreSQL baselines, enrolled clean controller source,
standalone helper Git-object proof and installation custody, current full-container boundary
digest, and a fresh 20–60 minute expiry. Do not replace these identities after a reboot to make
an old operation pass. Pre-99 does not invent a successful migration proof; post-101 consumes
the existing owning Node validator. Its hash-only disk exclusion cannot be downgraded to the
legacy caller-ID reference. Node independently compares helper bytes to the clean controller
checkout, then verifies fixed request/plan/storage/kernel fields and rereads actual mountinfo.

Linux prerequisites are fixed root-owned `losetup`, `cryptsetup`, `mke2fs`, `mount`, `umount`,
`findmnt`, `blkid`, `blockdev`, `dmsetup`, `systemctl` and `dockerd` binaries; loaded loop,
device-mapper/dm-crypt, ext4 and registered `xts(aes)` support; and `renameat2(RENAME_NOREPLACE)`.
Require no active swap. The operator disables its core dump and locks its Python pages before
generating the 64-byte random key. The key is passed only through cryptsetup stdin, never a
file, argv, env, journal, digest or report. Python zeroization and cryptsetup/kernel memory
zeroization are not claimed. An active swap or failed memory-lock gate stops before dump.
The canonical custom-format backup itself remains a root-private plaintext backup under the
existing backup policy; LUKS protects only the temporary restored PGDATA.

Before any database writer, prove that this process and the fixed systemd Docker daemon share
the same mount namespace and that the work directory's parent mount is private. Bind the daemon
PID/start ticks/namespace to the operation and recheck before create and start. A daemon in a
different namespace could otherwise see the unmounted underlying directory; refusal must
precede PostgreSQL initialization. No global `mount --make-private` change is permitted.

Capacity uses current read-only `pg_database_size` and available host RAM:

- Restore container memory and swap cap: exactly 2 GiB, with at least another 2 GiB available
  host memory. This is a bounded restore process, not a Timeweb RAM resize.
- Restore data target: `max(512 MiB, databaseBytes * 3 + 256 MiB)`.
- Preallocated LUKS image: that target plus `max(512 MiB, ceil(target / 20))`, rounded up to 4 MiB.
  Verify actual allocated blocks, device size and mounted free capacity; sparse allocation fails.
- Before dump, require `min(64 GiB, databaseBytes * 2 + 256 MiB) + 5 GiB` free disk and bound the
  dump process file size. After the actual dump, require the complete image size plus 5 GiB
  still free. Full allocation and the remaining reserve are rechecked. Neither estimate permits
  an oversized real dump or an unbounded Docker log.

The image is a regular root-owned 0600 file inside
`backups/.disk-restore-<sha256-of-exact-request-bytes>/` (0700). Its unique loop binding must match
backing dev/inode, offset, size and flags. LUKS2/ext4 UUIDs, mapper name, mountpoint and restore
container name derive from those immutable bytes. The private ext4 mount uses
`rw,nosuid,nodev,noexec,noatime`. Docker gets exactly that PGDATA bind with `rprivate`, two
16-MiB tmpfs mounts, no network/ports/devices/socket/env-file, read-only root, user `postgres`,
all capabilities dropped, no-new-privileges, 1 CPU, 128 PIDs, no restart and `--log-driver none`.
Check fixed entrypoint/command, image-default env plus four fixed restore variables, the exact
operation label and complete containment both before start and during lost-ACK cleanup. Actual
host/container mountinfo must prove the same mapper device, filesystem root, private propagation,
namespace inodes, PID and start timestamp; Docker inspect alone is insufficient.

The private work directory holds exact request/plan, hash-only unrelated-container boundary,
chained metadata events and storage proof. It never saves unrelated container labels, database
bytes in metadata, keys or command stderr. Metadata is fsynced to a private temporary inode,
then atomically renamed without replacement; partial `.disk-write-*.tmp` files remain incident
evidence and are not committed journal events. A separate persistent root-private process lock
uses nonblocking `flock` to exclude concurrent execute/reconcile invocations. Read-only
`--attest-disk` deliberately takes no mutation lock because the Node proof calls it recursively.

After pg_restore TOC validation, successful isolated restore and equal source/restored ledger,
prepare the existing nine-field `PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1` receipt. Remove only
the proven owned restore container, unmount, close mapper, detach loop and unlink the image.
Publish the receipt and dump together by atomic no-replace directory rename only after cleanup
readback and a fresh guard. Canonical consumer paths stay:

- pre-99: `backups/<controllerSha>-<source-CI>-1-web`;
- post-101: `backups/11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1-api-worker`.

The receipt's canonical dump path, SHA, baseline, immutable PG image, freshness and ledger
checks are unchanged. No receipt is admitted while cleanup is incomplete. Long reconciliation
can leave a correctly published but expired receipt; never refresh its timestamp or reuse it
by editing the receipt. A renewed backup needs a separately reviewed operation.

Only after exact live authority, invoke the enrolled helper with the frozen request:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root /usr/bin/python3 -I -S -B \
  /opt/phub/timeweb-beta/operator/tools/<controllerSha>/control-timeweb-database-backup.py \
  --execute /opt/phub/timeweb-beta/operator/database-backup-restore.json
```

On an uncertain outcome, never rerun execute. Inspect custody and journal, then obtain exact
reconciliation authority for the same request. Expired requests may reconcile. Substitute
`--reconcile-disk` above; it never dumps/restores/formats/opens a mapper/starts a container.
It cleans only independently proven owned resources and either publishes an already durable
`PUBLISH_READY` pair or marks the operation aborted while retaining the dump privately. Intent
must precede each removal; missing resources/locks without a prior removal/unlock intent fail.
Replay, unrelated cleanup and destructive rollback are not authorized by reconciliation.

Recovery has explicit manual-stop windows: work/capsule or pending lock creation before custody
is durably recorded, image open before inode proof, mountpoint mkdir before inode proof,
corrupt committed journal, foreign entries, changed source/runtime/secrets, reboot or namespace
drift. Tests require STOP and preservation in these windows; automatic recovery is not claimed.
Never infer ownership from a matching path, remove an unproven object, rewrite a journal or
silently reset a baseline. Keep incident evidence for a separately scoped operator decision.

LOCAL checks use synthetic fixtures: both canonical consumer validators, capacity/containment,
namespace refusal, concurrent mutation refusal, partial journal writes, before/after command
ACK loss and durable-phase faults. Physical Linux rehearsal must separately verify real pinned
PG dump/restore, loop/LUKS/ext4 and kernel bind visibility, sparse/capacity refusals, ownership
drift and interrupted cleanup with exact pre/post inventory of its owned devices/mounts. Use a
disposable host, no production datasets, credentials or daemon socket sharing. A macOS mock or
a privileged Docker Desktop guest is not exact target/kernel or immutable-image admission proof.
This source preparation changes no live backup, migration, IAM key or notification state.

The migration request is the root-only file
`/opt/phub/timeweb-beta/operator/api-worker-migration.json`, schema
`PHUB_TIMEWEB_API_WORKER_MIGRATION_OPERATION_V1`. Copy exact fields from the owning validator;
include the fresh API/Worker identities, actual secret-set release ID and five file hashes,
controller X/tree/source-CI, the fixed publication/artifact tuple and a 20–60 minute expiry.
It contains no caller-authored role PASS flag. Its confirmation is
`MIGRATE_0096_0097_11954FFD6D7B_FROM_0D6078BE7A50_NO_API_WORKER_SECRET_OR_FCM_CHANGE`.
Only after exact live authority, invoke:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root /usr/bin/node \
  /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-migration /opt/phub/timeweb-beta/operator/api-worker-migration.json
```

The sealed private plan precedes the shared pointer and provision fence. Two deterministic
read-only role-probe containers use the pinned migrator image with current API/migrator env
files and catalog queries only. They verify cluster/database, wire/session roles and required
capabilities/default ACLs. Missing `pg_control_system()` permission is `ROLE_PROOF_UNKNOWN`,
not a reason to grant it. Probe and one-shot migrator containers are retained and never replayed.
The actual Docker config image ID is read locally and bound into the plan; it is not the OCI
index digest from the published reference. Runtime env values are compared in memory and never
saved in the evidence files. This operation creates no FCM credential mount.

The immutable `migration-success.json` binds the exact container and derived `role-proof.json`;
`migration-receipt.json` remains the strict mutable phase journal. `SUCCESS` retains ownership.
After explicit reconciliation authority, use the same frozen request (expired requests may only
reconcile):

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root /usr/bin/node \
  /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js \
  --critical-api-worker-migration-reconcile /opt/phub/timeweb-beta/operator/api-worker-migration.json
```

Reconciliation proves exact exited-zero/post-101 success or untouched pre-99 with no mutating
start before `RECONCILED`; running/partial/unknown outcomes retain ownership. A capsule orphan
before publication can abort only with unchanged preimages and no started migration. Keep all
terminal evidence and containers; an aborted operation cannot be replayed or silently replaced.
A renewed attempt or cleanup is a separately reviewed decision.

V2 backup pins `controllerSourceCiRunId`, `migrationPlanSha256` and
`migrationSuccessSha256`. The enrolled Python tool reuses the source-controlled Node proof
validator instead of trusting a root-written status boolean or duplicating role schemas. Its
Node reader receives bytes through stdin and a clean environment, without ambient Docker/Compose
or Node overrides. It checks exact proof bytes/custody, actual retained migration/probe containers,
unchanged runtime/secrets and post-101 ledger at each guard. For tmpfs, only the producer's exact owned
restore ID/operation is excluded from that unchanged boundary. The disk mode instead requires
its fixed hash-only reference, source-anchored helper, and independently read kernel proof. A changed proof fingerprint stops
backup; no file relocation or receipt rewriting is available.

The mapper readback accepts cryptsetup's exact 512-bit displays `512 bits` and
`512 [bits]`. Cipher, backing loop, read/write mode, LUKS UUID, device numbers and
kernel mapper UUID remain mandatory. A different size, unit or trailing content
is a custody failure; formatting compatibility never authorizes a new mapper or
replay of an interrupted operation.

### Private mount namespace and temporary Docker runtime (V2)

Shared host mounts make the V1 disk mode ineligible: even a bind followed by `--make-private`
can propagate the initial bind before privatization. V1 keeps its refusal. The new namespace
mode creates a PID1-owned supervisor, unshares only its mount namespace, then runs
`mount --make-rprivate /` inside that namespace before creating storage. It never changes host
propagation or restarts the system Docker daemon. A parent crash leaves the supervisor holding
the namespace for a separately authorized reconciliation; it does not replay the operation.

The fixed request fields remain closed. These distinct schemas and confirmations are required:

- `PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_NAMESPACE_V2`, confirmation
  `BACKUP_RESTORE_PRE99_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_KEEP_API_0D6078BE7A50`;
- `PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_NAMESPACE_V2`, confirmation
  `BACKUP_RESTORE_API_WORKER_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_11954FFD6D7B_KEEP_API_0D6078BE7A50`.

All earlier source, installation, expiry, server, ledger, lock and immutable image gates apply.
The supervisor and both Docker clients are bound to the original system daemon PID/start ticks
and mount namespace recorded before lock publication. A restart is drift, never a new baseline.
The parent may enter only from this frozen source namespace, through a pinned namespace FD,
and must prove its return. Namespace FDs and the mutation flock never pass to daemon children.

Before creating runtime control directories or journaling a start intent, query the exact service
and slice names with non-loading systemd listings of loaded units and unit files; both must be
absent. Query loaded units by exact name. Read a bounded, strictly parsed full unit-file inventory
and compare its first column by exact equality: systemd 259 returns exit code 1 for an empty
filtered unit-file result, and command errors must never count as absence. Reject malformed,
empty, duplicate or unknown inventory rows. Do not use `systemctl show` or `LoadUnit` for this admission: querying an implicit slice
can load an inactive default unit and make the absence probe reject its own lookup. Reject every
already loaded or file-backed name, including inactive units. Keep transient creation in `fail`
mode and attest the exact properties and cgroup limits only after creation. A start ACK loss keeps
the durable intent and requires exact-owner reconciliation; an unowned implicit slice is preserved.

The operation creates one transient root slice named `phubdiskrestore<operation-sha-prefix>.slice`
through fixed typed `StartTransientUnit` D-Bus properties. The name has no parent slice hierarchy.
Its aggregate cap is 4 GiB, 384 tasks, 2 CPUs and no swap. The supervisor service cap is 2 GiB,
256 tasks, 1 CPU; the restore scope cap is 2 GiB, 128 tasks, 1 CPU. Both are inside this slice.
Before mutation, read back systemd properties and kernel cgroup limits. No persistent drop-in,
restart, ambient unit property or caller-selected cgroup parent is accepted.

The temporary root Docker daemon uses only an operation-derived Unix socket, vfs storage,
data/exec roots inside the private LUKS mount, and fixed root-private configuration. It has no
bridge, iptables, IP forwarding, live restore or logs. The generated managed-containerd config
must bind its root/state/socket to these same paths with CRI disabled and no imports or proxy
plugins. Prove dockerd/containerd/shim executable, full argv, owner, start ticks, namespace,
service cgroup and complete member inventory. Unknown generated config or runtime version stops.
Runtime binaries, systemd and Docker parent behavior require physical admission before use.

Linux filesystem Unix-socket addresses have a 107-byte pathname limit. The alias-specific
`SYSTEMD_SUPERVISOR_PRIVATE_ALIAS_V1` strategy uses fixed `/media/.runtime/**` paths for
Docker API, managed containerd, shims, data root and exec root. `/media` must already be a
real empty root-owned 0755 directory without a mount or descendants; the producer never
creates or changes this host directory. It binds only the owned encrypted mount to `/media`
inside the proven private namespace, journals `ALIAS_MOUNT_INTENT` and `ALIAS_MOUNTED`, and
checks the mapper, mountinfo, device/inode, secure options and original source-namespace
baseline before any runtime write or client call. The independent Node consumer repeats
these alias, daemon cwd and host-absence checks before and after reads. Cleanup first removes
the restore container and stops all managed runtime processes, then journals and unmounts
the fixed `/run/containerd` mask first and the exact `/media` alias second before original
storage cleanup. The mask hides host containerd endpoints and keeps shim sockets on the
encrypted filesystem. Its host baseline is a real root-owned 0711 or 0755 directory with no
mount at or below it; live contents are never copied, hashed or changed. The unit also requires
`PrivateNetwork=yes`, with independently proven source and supervisor network namespaces,
so temporary runtime listeners cannot share the host network. Host-address checks run only in
the outer producer entry, where both pinned host addresses must be visible before any mutation.
The isolated supervisor keeps the common hostname/architecture checks and binds to the exact
request, tool, capsule, frozen source daemon, admitted unit/cgroup and source/supervisor network
namespace proofs; it must not query its private network for the host addresses. These checks do
not authorize retry or reconciliation of a unit that stopped before its durable receipt.
The producer and consumer check
managed containerd argv and full CRI plugin URI against Docker 29/containerd 2.3 semantics.
An unverified plugin-namespace JSON override is omitted; each runtime uses its own data/state
and the operation-bound task namespace. An intent with the exact owned alias
can be adopted for cleanup; absent-after-ready without an unmount intent, foreign mounts,
changed baseline or supervisor loss remain manual STOP. Old strategy artifacts fail closed;
old exact-pinned helpers remain available for their own incident recovery.

Docker 29 creates only two admitted descendants below the private alias: its exact data-root
self-bind, with one private-namespace shared peer group, and the single `nsfs` mount for the
restore container after `RESTORE_START_INTENT`. Running proof binds the latter to Docker's
`SandboxKey`, the exact container PID/start ticks and its network-namespace device/inode.
Created and exited containers have no network mount; stop/remove intent windows allow only
the bounded acknowledgement transition. Unknown descendants and unbound namespaces stop
the operation. Cleanup never unmounts these descendants directly and requires them absent
before removing the mask and alias. Python and the independent Node reader compare fresh
mount, process, container and namespace snapshots before and after reads.

Validate the fixed dockerd configuration before starting it. The supervisor drains startup
stderr with a bounded per-iteration budget and retains at most 64 KiB in memory; durable
failure receipts contain only a fixed code, exit status, byte count, truncation indicator and
SHA-256. Raw stderr, keys and database bytes never enter those receipts. A failed or unknown
daemon start keeps the operation fenced for exact-owner reconciliation.

The source client always reads the fixed system Docker socket; the restore client always names
the temporary socket. There is no fallback. Stream only the already admitted pinned PostgreSQL
image between clients, with a byte cap, timeout, bounded relay memory and parent-death signal.
No image tar or credential enters the work directory. Import admission compares config ID,
ordered rootfs layers, platform, size and image environment; retained RepoDigests are not assumed.
Create by config ID with `--pull never`, retaining the existing container containment contract.

Capacity requires 6 GiB available RAM: restore 2 GiB, daemon 2 GiB, host headroom 2 GiB.
The encrypted image additionally reserves `max(512 MiB, image.Size * 3 + 256 MiB)` for vfs.
Retain the full dump/file/allocation/free-space checks and 5 GiB disk reserve; the mount root
is 0700 and only its `pgdata` subdirectory is made accessible to the PostgreSQL user.

Post-101 uses `PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V2` with the exact storage-proof hash.
Despite the historical reference name, namespace V2 excludes no container from the host
boundary. Node independently rereads unit properties, cgroup bounds and members, process
identities, containerd config hash, image/container inspect, socket custody and mountinfo.
Broker/daemon/restore must see the proven mapper with private propagation; the system daemon
must see no mapper mount or device. Older references and caller IDs cannot downgrade this proof.

Cleanup removes the owned container, proves empty restore scope, stops only the pinned daemon,
proves no managed children/socket/pidfile, then cleans mount/mapper/loop/image. Only after durable
storage cleanup may it stop the proven supervisor, prove the slice empty and remove that transient
slice. Publication and shared-lock release remain last. Exact start/stop/exit receipts bind the
request and plan. A fixed-code supervisor terminal receipt reports `MANUAL_STOP`, without stderr.

Reconciliation never starts a daemon or recreates storage. A start intent without a published
start request can prove absence; a clean exit receipt and durable stop intent can finish readback;
a collected unit after a durable release intent can prove terminal absence. Missing namespace
receipt, daemon request published without readiness, slice creation without durable identity,
unexpected supervisor exit, PID reuse, changed source or foreign members are manual-stop windows.
Preserve the lock and all incident evidence rather than guessing ownership or repeating execute.

LOCAL mock and cross-language tests do not establish Linux support. Before any live enrollment
or backup, obtain a separately authorized disposable Linux amd64 rehearsal covering real
systemd/Moby/containerd versions, pinned PG restore, shared-host mount non-propagation, aggregate
cgroup caps, caller crashes, relay parent-death custody, every manual-stop window and cleanup
inventory. A fresh production resource/tool preflight is then required. This source mode grants
no VM order, server preparation, migration, FCM activation or push authority.

Controller source compatibility additionally admits the atomic 20-file native-bookings patch
whose exact old/new object IDs and modes are pinned independently in Node and Python. All 20
must match; missing files, extra paths, mode/status/OID drift fail. Ordinary mobile/ADR paths
are not added to the controller allowlist. The already published app/migrator images remain
frozen; this source exception does not upgrade an installed APK.

### Terminal slice proof on systemd 259

After the owned transient restore slice is stopped, `systemctl show` may synthesize a
`loaded/inactive/dead` implicit slice. The active slice identity and durable journal shape remain
unchanged. Terminal proof accepts only the exact default non-transient form: empty cgroup,
fragment/source/drop-ins/unit-file state/job/invocation, all resource limits `infinity`, no unit-file
inventory entry, no cgroup path and no members. It requires the existing owned release intent and
storage/unit cleanup history. The implicit branch never stops or adopts a unit. A legacy operation
stopped at that proof needs fresh exact-owner continuation custody; never replay its execute or
silently replace its installed helper, request or recovery claim.

The disposable Compose unavailable-Web check requires either Compose exit status 1 or an actual
owned strict HTTP-helper rejection immediately after Compose returns before readiness. A module-local
error brand distinguishes that rejection from generic errors, missing errors or spoofed names/codes.
Both paths require the exact newly recreated owned running `sleep 60` fixture with `starting` or
`unhealthy` health. Unexpected exit/status/identity/command/health fails with bounded diagnostics. A failed first-attempt main CI remains ineligible; rerunning it does not grant delivery.
