# Timeweb LK2 beta source contract

This runbook records the canonical, source-only deployment contract for the LK2 beta contour. It
does not authorize deployment, publication, activation, provider mutation, secret provisioning,
migration, worker activation, firewall changes, or any live write. All volatile facts must be
re-read before a separately authorized activation.

## Canonical target

`deploy/timeweb/target.json` is the authoritative `PHUB_TIMEWEB_TARGET_V1` contract. Its canonical
identity is:

- hostname `lk2.padlhub.su`;
- IPv4 `103.88.243.171`;
- Linux/AMD64 on an `x86_64` host;
- Timeweb server `Cute Hoopoe`, server ID `8886471`, project ID `262717`;
- management only through `tailscale0` with pinned ED25519 fingerprint
  `SHA256:zjTqV+Aj8BvvdK1/HZ8TmMs6OO3zdoORiB96uODoRUw`;
- external Docker network `phub-timeweb-beta`, subnet `172.30.26.0/24`;
- future release root `/opt/phub/timeweb-beta/releases`.

The JSON contract, not this prose, is the machine-readable source of truth. Compose and the source
verifier must match it exactly.

## Confirmed preflight evidence

### DNS preflight: READY

The confirmed preflight was `lk2.padlhub.su` A `103.88.243.171`, TTL 300, with no AAAA and no
CNAME. Authoritative DNS, Cloudflare, Google, and Quad9 returned the same result. These observations
are preflight facts only; they do not authorize deployment and must be confirmed again immediately
before any future activation.

### VPS ingress preflight: READY

The confirmed target was Timeweb `Cute Hoopoe` (server ID `8886471`, project `262717`), Ubuntu
26.04 LTS, `x86_64`, Docker 29.7.2, and Compose 5.5.0. The read-only inventory observed
approximately 90 GB free disk and 11 GiB RAM, ports 80/443 free, no ingress or application
containers, no application network, and no conflict with `172.30.26.0/24`. Management was through
`tailscale0` only and the pinned ED25519 fingerprint matched.

No SSH or host mutation was performed by this source task. The firewall remains unchanged; ports
remain unopened. Disk, RAM, package versions, listener state, containers, networks, routes, and
host-key identity are volatile and must all be read back before activation.

## Immutable historical evidence

These directories are immutable historical evidence and not an activation input, release
directory, Compose/Caddy working directory, secrets source, mount source, or future rollback input:

- `/opt/phub/timeweb-beta/staging/ac8f0aad-contract5004571-20260826T133721Z`
- `/opt/phub/timeweb-beta/rollback/ac8f0aad-contract5004571-20260826T133721Z`

They must never be deleted, renamed, modified, moved, copied over, mounted, or activated. A future
accepted release must use a new single-segment directory below
`/opt/phub/timeweb-beta/releases/<future-release-id>`.

## Source-only validation

The deterministic verifier checks the target, Caddy routes and headers, ingress/application
Compose, runtime environment contract, profile gates, static addresses, immutable images, and the
historical-evidence exclusion:

```sh
node scripts/verify-timeweb-deployment-contract.js
```

Exact-head CI validates and adapts Caddy with the digest-pinned Caddy 2.11.4 Linux/AMD64 image in a
container with `--network none`. It records the adapted JSON SHA-256 and compares it with the
historical and current hash
`afdc50d2324f94760c2630f78e5da0ade3f72589efbdec7e175cf476d516f21b`. The earlier handoff
value containing 66 hexadecimal characters was not a valid SHA-256; direct adaptation of both the
historical and current Caddyfiles produced the same valid 64-character hash recorded here.
It also renders both Compose models using synthetic non-secret environment files and digest values.
These checks do not start Caddy or an application service, do not bind ports, and do not create a
Docker network, volume, package, or VPS resource.

## Runtime and activation boundary

`deploy/timeweb/runtime-environment.contract.json` names required, allowed, and forbidden keys per
service without containing credential values. API, worker, realtime, and migrator use separate
required env files. Worker receives no API/provider/signing key set; realtime receives no API
access/refresh signing secret or provider credential. Initial write-capable flags remain disabled.

The default application model contains only web, API, and realtime. Worker is gated by profile
`background`; migrator is gated by profile `migration`; neither is a dependency of a default
service. Only ingress may bind host ports. Publication, deployment, Caddy activation, migration,
worker activation, OAuth/provider changes, and any live write each require a later explicit gate.

For the authorized public Yandex beta, the API runtime must additionally contain
`VIVA_OAUTH_ALLOWED_PROVIDERS=yandex` and
`VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED=true`. The latter remains a required true flag in the
Timeweb runtime contract and cannot be combined with existing-subject bootstrap. The runtime must
also supply non-`pending` `PUBLIC_OFFER_VERSION` and `PERSONAL_DATA_POLICY_VERSION` values that map
to the published documents linked by Web. Keycloak must emit signed broker provenance
`identity_provider=yandex` or `identityProvider=yandex`; do not remove Basic Auth if that claim is
absent or user-editable.

Removing the operator Basic Auth gate is a controlled ingress activation after the new API/Web pair
is ready. Use only `deploy/timeweb/Caddyfile.yandex-public-beta`, whose adapted JSON hash is frozen in
`deploy/timeweb/yandex-public-beta-ingress.json`. The policy allows read-only GET/HEAD routes, the
four required OAuth/session POST routes and logout DELETE, then returns `405` for every other API
method. Do not replace it with the broader canonical Caddyfile and do not edit either artifact on the
host.

The noncanonical current fast-beta rollback floor is frozen in
`deploy/timeweb/yandex-public-beta-rollback-floor.json`. Failed run `33168712014` is provenance only
and authorizes neither publication nor deployment. After publication and secret provisioning,
create a root-only operation-input JSON under `/opt/phub/timeweb-beta/` containing the exact
candidate source SHA/tree, release ID, canonical runtime root `/etc/phub/timeweb-beta`, canonical
rendered `release.env`, active
Caddyfile, Compose, backup, receipt and rollback-env paths. API/Web digests are read only from that
root-owned canonical environment and are not accepted as operator-authored input. Then run from the
exact clean candidate checkout:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node scripts/control-timeweb-yandex-public-beta.js --mode prepare \
  --input /opt/phub/timeweb-beta/operator/yandex-public-operation.json
```

`prepare` refuses a dirty or different source, wrong running or unavailable local images, unsafe
paths/modes, a Caddy preimage without both Basic and `405`, or a mismatched runtime release identity.
It writes the Basic preimage backup first and the complete root-only receipt last. It logs no Caddy
bytes, environment values or credentials.

Start the candidate API behind Basic through the exact rendered `release.env` and canonical
`compose.beta.yaml`, prove readiness, then start Web the same way. Compose stamps both containers
with the non-secret exact `phub.release-id` label. Public ingress is last:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node scripts/control-timeweb-yandex-public-beta.js --mode activate-ingress \
  --receipt /opt/phub/timeweb-beta/backups/yandex-public/receipt.json
```

The controller rechecks the frozen source, canonical root-only `release.env`, receipt, candidate
API/Web container images, exact release labels, runtime release identity and both Caddy hashes. The
active Caddyfile must be exactly the `./Caddyfile` mounted beside the validated ingress Compose; an
operator-supplied alternate path is rejected. It validates the
prospective file offline with the already-local pinned Caddy image, atomically installs it, then
force-recreates only Caddy so the single-file bind mount receives the new inode. The recreated
container must use the exact pinned image, be running and adapt the mounted file to the receipt-bound
hash. Offline validation streams root-read bytes over stdin to a non-root, read-only, networkless
container, so the root-only `0600` Basic backup is never exposed through a file bind mount. A
loopback TLS smoke then proves HTTP redirect, Web `200`, API readiness `200` and a denied
non-allowlisted POST `405`, without credentials or provider mutation. Any
validation/recreate/verification/smoke failure restores Basic through that same sequence and proves
unauthenticated `401` responses for the HTTPS root, OAuth authorize, public API read, user API write
and realtime health paths before returning failure. `caddy reload` is
intentionally forbidden because both artifacts set `admin off`.

Rollback is executable and ordered, never prose-only:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node scripts/control-timeweb-yandex-public-beta.js --mode rollback \
  --receipt /opt/phub/timeweb-beta/backups/yandex-public/receipt.json
```

It restores, validates, force-recreates and verifies Basic first; only then does it restore the locally retained prior
API, wait for health, restore Web and wait for health. It never pulls, migrates, deletes identity rows
or touches secrets. Rollback does not depend on the candidate runtime secret directory or its release
marker. Preserve the receipt and backup after success or partial failure. Users first
provisioned through Yandex may be unavailable during rollback, but their identity, legal-acceptance
and delegation rows remain intact.

Realtime is not a read-only process at startup: it asserts RabbitMQ exchanges, queues and bindings
and starts consumers. Starting Realtime therefore requires a separately approved RabbitMQ topology
gate even while Worker is disabled. Worker-disabled operation is safe only for an explicitly bounded
read-only/auth/Games-read beta: API messaging commands can enqueue outbox records that will not be
published while Worker is stopped. General LK2 beta compatibility is a STOP until this boundary and
the live outbox are proven.
The isolated Worker environment also cannot currently satisfy the shared application loader without
the API access/refresh signing secrets that the Timeweb contract correctly forbids. This source
incompatibility is another explicit reason Worker activation remains STOP; do not weaken secret
isolation to make it start.

`REALTIME_EXPECTED_REPLICAS=1` is mandatory for the initial contour. The runtime contract requires
it because staging/production Realtime configuration fails closed when replica monitoring has no
explicit expected count.

## Runtime secret provisioning contract

The provisioner accepts secret values only from four root-controlled regular files. Secret values
are never accepted through argv, included in the plan, logged, or copied into an exception message.
The input directory must be owned by root with mode `0700` and contain exactly:

- `api.env`;
- `worker.env`;
- `realtime.env`;
- `migrator.env`.

Each source must be a single-link regular file owned by root with mode `0600`, strict UTF-8, one
terminal LF, no CR/NUL, and a unique non-empty value for every key. Required, allowed, forbidden and
default-off keys come from `deploy/timeweb/runtime-environment.contract.json`. Symlinks, hardlinks,
devices, FIFOs, sockets, unexpected files/keys, historical `staging`/`rollback` paths and path
traversal fail closed.

All privileged activation-input tools run only from the exact clean Git checkout at
`/opt/phub/timeweb-beta/releases/<source-sha>-<run-id>-1/source`. The checkout, its Git directory,
every path to the protected controller/contract files and those files themselves must be owned by
root, must not be symlinks and must not be group/other-writable. The `.git` pointer, Git/common
directories, config, HEAD and exact commit/tree/blob object storage must have the same custody;
alternates are forbidden. Fixed `/usr/bin/git` runs with system/global config, replace objects, lazy
fetch, hooks and fsmonitor disabled. `HEAD`/`HEAD^{tree}` must match the canonical identity, and every
protected controller/Compose/contract byte is hashed as a Git blob and compared with that exact
tree before provisioning/rendering and before every Docker stage. A later checkout, changed
protected source, unsafe Git metadata, missing `.git`, git-free archive or caller-authored checksum
is a STOP. Git-free bundles remain unsupported until a separately authenticated same-run controller
artifact binds their exact bytes.

Never launch these privileged tools through project `npm`, `.npmrc`, a PATH lookup, a container
wrapper or a preserved caller environment. Runtime secret and activation tools use fixed
`/usr/bin/node` under `env -i`. If that binary is absent, the bounded bootstrap controller below is
the only supported exception: it uses the Ubuntu-owned `/usr/bin/python3` only to install and prove
the contracted Node runtime. It remains a separately authorized host-package operation and never
authorizes secret provisioning, image pull, service restart or ingress activation.

## Operator Node bootstrap

Use only `scripts/control-timeweb-operator-node-bootstrap.py` and the adjacent protected
`deploy/timeweb/operator-node-bootstrap.v1.json`. The contract freezes Ubuntu 26.04, the single
`ubuntu.sources` file and its SHA-256, the Ubuntu archive keyring and fingerprints, Node major 22,
and the exact 20-package new-install closure. Third-party or `Trusted=yes` sources, apt lifecycle
snippets, pre-existing closure packages, upgrades, removals, downgrades, extra packages, global npm,
downloaded installers and container launchers are all a STOP.

The controller reduces the procedure to five commands. Every live command uses an absolute path in
the exact root-owned, unmodified and untracked-file-free release checkout. Python isolated mode,
disabled `site` loading and disabled bytecode writes prevent sibling or site import shadowing before
the controller proves that checkout. Replace only the release path and two identity values:

```sh
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' plan --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'
```

`plan` does not install a package. It verifies the frozen Git blobs, OS, launcher custody, source,
keyring, empty `dpkg --audit` and absent pre-state. It then runs authenticated `apt-get update` into
an isolated root-only lists directory using only the frozen source and keyring, rejects every
unexpected index target, and uses that same snapshot for exact simulation, URI selection and `.deb`
download. Lifecycle-bearing maintainer scripts are rejected. The lists, packages and atomic `0600`
plan are published as one directory rename; the plan binds the plan ID, source/list/simulation
checksums and every payload and control-metadata SHA-256. Stop for separate authority naming that
plan ID before `apply`. A prior rollback receipt, including a dangling symlink at its fixed path,
blocks both planning and the apply recheck; historical evidence must never be overwritten or
discovered only after package mutation.

```sh
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' apply --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'

sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' verify --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'
```

`apply` rechecks the plan, trust inputs, apt-list checksum, simulation and every `.deb`, then installs
only those local payloads with `--no-download`, `--no-remove` and `--no-upgrade`. A temporary exact `policy-rc.d`, disabled apt config
snippets, noninteractive/list-only `needrestart`, and before/after unit/listener/reboot snapshots
fail closed around service lifecycle changes. The controller publishes that guard without replacing
an existing file and recovers either crash point of the pending-to-final hard-link handoff. The
atomic metadata-only receipt is
`/opt/phub/timeweb-beta/operator/node-bootstrap-receipt.json`; it contains no credential or package
payload. `verify` independently reads back the complete dpkg closure, `/usr/bin/node` owner, resolved
file SHA-256, version, executable path, platform and architecture. Apply and rollback completion
timestamps are first persisted in `transaction.json`; recovery accepts an existing receipt only when
it exactly matches that deterministic transaction evidence.

If `transaction.json` remains after an interrupted apply or rollback, do not delete it or the
temporary lifecycle guard. Run only deterministic recovery from the same frozen source and plan.
It completes an interrupted exact install/removal or receipt cleanup, re-simulates partial rollback
and rejects any newly expanded removal set. Resumed apply also re-simulates the observed exact
partial closure and rejects every extra install, configure, upgrade, downgrade or removal before
APT is allowed to continue:

```sh
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' recover --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'
```

If the transaction phase is `postcondition_failed`, `recover` stops without repeating apt. That
state means the exact packages may be present but a Node/service/listener/reboot invariant did not
pass. Preserve the transaction and lifecycle guard. Package removal from this failed-apply state is
a destructive rollback boundary. Only after separate exact authority naming the recorded plan ID
and frozen 20-package rollback closure may the rollback mode be invoked with its explicit recovery
flag:

```sh
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' rollback --recover-failed-apply --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'
```

The controller proves the failed transaction and plan, re-simulates only the exact currently
present closure subset, rejects every expanded removal or configuration action, and changes the
transaction to a resumable failed-apply rollback before fixed-name `dpkg --purge`. It removes the
lifecycle guard only after the entire closure is absent and the protected runtime snapshots still
match. Its metadata-only receipt has status `FAILED_APPLY_ROLLED_BACK`. `recover` resumes this exact
authorized rollback after interruption, accepts only enumerated error-free dpkg removal states, and
records the immutable authorized simulation separately from the latest remaining-subset simulation.
An existing completion receipt must match byte-for-byte before guard cleanup. Without that live
authority, do not run the flag, delete the marker or guard, or execute manual package commands.

Keep Node installed through the application rollback window. Removing it is a separate live
host-package authority. The controller first proves the original receipt and simulates an exact
purge; any reverse dependency or additional removal is a STOP. The actual removal uses fixed
`dpkg --purge` package names so a resolver cannot expand it. Its receipt records the immutable
authorized full-closure simulation separately from the latest remaining-subset retry. It never runs
`autoremove`. A fresh rollback also requires its fixed rollback-receipt path to be absent before the
transaction, lifecycle guard, or purge can begin; an existing file or symlink is a fail-closed STOP:

```sh
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' rollback --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'
```

A controller STOP never permits an alternate launcher, manual package command, marker deletion,
service restart, ingress activation or deployment.

The metadata-only dry-run performs the same source and current-release validation without creating
`/etc/phub` or writing a target:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node '/opt/phub/timeweb-beta/releases/<source-sha>-<successful-run-id>-1/source/scripts/provision-timeweb-beta-runtime-secrets.js' \
  --source-dir /root/lk2-beta-secret-input \
  --host lk2.padlhub.su \
  --tenant-key '<exact-tenant-key>' \
  --release-id '<source-sha>-<successful-run-id>-1' \
  --expected-source-sha '<exact-source-sha>' \
  --expected-source-tree '<exact-source-tree>' \
  --dry-run
```

The output contains only the release identity, key names, target paths, modes and planned actions.
For the first provision, omit `--expected-current-release-id`. For a later rotation, it is mandatory
and must exactly match `/etc/phub/timeweb-beta/.release-identity.json`; a mismatch never replaces the
current set. The write path uses a private `0700` incoming directory, exclusive `0600` files,
file/directory `fsync`, atomic renames and an identity-bound backup. Handled failure removes only the
recorded incoming object and restores the exact previous set when it had already moved. A durable,
exclusive root-only transaction record serializes rotations; after an uncatchable process exit the
next invocation either restores the exact recorded backup or confirms the exact installed release
before removing only its recorded staging. Raw Compose metacharacters (`$`, `#`, quotes, backslash
and whitespace) are rejected so Compose cannot reinterpret a validated value.
Dry-run never repairs or removes a transaction marker; it stops read-only until recovery is resolved.
If handled rollback cannot complete, the provisioner preserves both the transaction record and its
owned staging for the next deterministic recovery instead of erasing evidence in an ambiguous state.

Real provisioning is a live secret mutation and is STOP without separate authority. Tests inject
only disposable synthetic values and paths.

## Deterministic release.env contract

The renderer accepts only the canonical same-run pair `release-manifest.json` and
`release-manifest.sha256` with schema `PHUB_TIMEWEB_RELEASE_MANIFEST_V2`. It then obtains
`PHUB_TIMEWEB_CANONICAL_RUN_EVIDENCE_V1` itself through the authenticated GitHub Actions and GHCR
APIs after the run is complete. The evidence binds `status=completed`, `conclusion=success`, exact
source/tree/workflow/run/attempt, canonical artifact ID/name/GitHub artifact digest, its exact
two-file inventory and complete live registry inventory `5/5`. The renderer downloads the exact
artifact archive, verifies its GitHub SHA-256, extracts exactly the two canonical files, and compares
their bytes with the supplied pair. A local manifest checksum and the GitHub artifact custody digest
are distinct fields and are both recorded. The renderer rejects legacy/
reconciliation/receipt/inventory shapes, mutable references, incomplete component sets, historical
paths, ambient `COMPOSE_*` overrides and the failed run `33011023879` explicitly.

The GitHub token is read only from an exact root-owned regular `0600` file, never argv, output or an
environment dump. Caller-authored evidence and caller-authored evidence checksums are not accepted.
The token requires read-only Actions/artifact and package metadata access. Token compromise remains
a trust-boundary STOP and does not waive the independent manifest/provenance verification.

The runtime secret set must already exist with `0700`/`0600` ownership and a release marker matching
the manifest release ID. The future release directory must be the exact single segment
`/opt/phub/timeweb-beta/releases/<source-sha>-<run-id>-1`, root-owned and mode `0700`. The renderer
writes `release.env` through a private exclusive staging file, then `fsync` and atomic rename. It
never overwrites an existing output.

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node '/opt/phub/timeweb-beta/releases/<source-sha>-<successful-run-id>-1/source/scripts/render-timeweb-beta-release-env.js' \
  --manifest '<canonical-artifact-dir>/release-manifest.json' \
  --expected-manifest-sha256 '<release-manifest-json-sha256>' \
  --github-token-file '<root-owned-read-only-github-token-file>' \
  --expected-source-sha '<exact-source-sha>' \
  --expected-source-tree '<exact-source-tree>' \
  --expected-workflow-sha '<exact-workflow-sha>' \
  --expected-run-id '<successful-run-id>' \
  --expected-run-attempt 1 \
  --release-dir '/opt/phub/timeweb-beta/releases/<source-sha>-<successful-run-id>-1'
```

The first-beta renderer supports only `PHUB_ROLLBACK_PREVIOUS_RELEASE_ID=NONE` and stop-candidate
rollback. It cannot claim an unverified previous release. The output references
`/etc/phub/timeweb-beta/*.env`, includes immutable image digests, both custody checksums and release/
rollback identity, and records `PHUB_WORKER_ENABLED=false` and `PHUB_MIGRATOR_ENABLED=false`. It sets
`COMPOSE_PROFILES` to the empty value and contains no credential values. The authorized morning
path must also scrub ambient `COMPOSE_*`, must never pass `--profile`, and must name only the allowed
service at each step. Offline validation asserts that default rendered services are exactly API,
Realtime and Web; an explicit Worker or Migrator target remains a separately prohibited live action.

After separate deployment authority, use only the renderer's source-controlled stage controller. It
scrubs ambient `COMPOSE_*`, performs a default-service preflight before every stage, passes no shell
or `--profile`, and has no Worker/Migrator stage:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node '/opt/phub/timeweb-beta/releases/<source-sha>-<successful-run-id>-1/source/scripts/render-timeweb-beta-release-env.js' \
  --compose-stage preflight \
  --release-env '<exact-release-dir>/release.env' \
  --manifest '<canonical-artifact-dir>/release-manifest.json' \
  --expected-manifest-sha256 '<release-manifest-json-sha256>' \
  --github-token-file '<root-owned-read-only-github-token-file>' \
  --expected-source-sha '<exact-source-sha>' \
  --expected-source-tree '<exact-source-tree>' \
  --expected-workflow-sha '<exact-workflow-sha>' \
  --expected-run-id '<successful-run-id>' \
  --expected-run-attempt 1
# Later, one separately authorized transition at a time:
# repeat the full command with pull-api, then up-api
# repeat the full command with pull-web, then up-web
# repeat with pull-realtime, then up-realtime only after the Rabbit gate
```

Every stage repeats exact clean root-owned local source verification, authenticated GitHub
run/artifact/GHCR verification and compares the root-only `release.env` byte-for-byte with the newly
rendered canonical content before invoking Docker.
Any ambient `DOCKER_*` variable is a hard STOP before execution. The controller supplies Docker a
minimal fixed environment only: `/usr/bin:/bin`, `/root`, `/root/.docker`, empty Compose profiles and
the root-owned local Unix socket `/var/run/docker.sock`; remote/context-selected daemons are not a
supported path.

Do not invoke a pull/up stage during readiness review. A root operator can bypass source controls;
that is an authority violation, not a supported activation path.

## Offline activation-input rehearsal

The focused suite provisions and rotates synthetic secrets, rehearses handled rollback, validates
file modes/identity, renders a synthetic canonical V2 release environment, and rejects the required
negative cases:

```sh
npm run timeweb:beta:activation-inputs:test
node scripts/verify-timeweb-deployment-contract.js
npx vitest run \
  scripts/verify-timeweb-deployment-contract.test.ts \
  scripts/verify-timeweb-release-manifest.test.ts
```

Compose must be rendered only with disposable `0600` synthetic env files. Caddy validation/adaptation
uses the digest pinned in `deploy/timeweb/target.json`, `--platform linux/amd64` and `--network none`.
These commands may create only disposable local Docker validation containers; they never run on the
VPS and never create an application network, volume or service.

## Morning readiness and activation sequence

The sequence remains STOP at step 1 until a new successful publication produces the canonical V2
pair. Five tags or inventory from failed run `33011023879` are never release inputs.

1. Fresh-fetch `main`; freeze exact source SHA/tree and publication workflow SHA. Through the
   authenticated GitHub Actions API, verify `status=completed`, `conclusion=success`, attempt `1`,
   exact canonical artifact ID/name/digest and registry inventory `5/5`. Let the renderer repeat this
   authenticated lookup and download the same artifact's canonical V2 pair; verify the manifest
   checksum, exact two-file inventory, five component records and immutable index/runtime digests.
   STOP on any drift, failed/partial run, caller-authored evidence or missing pair.
2. Repeat authoritative, `1.1.1.1`, `8.8.8.8` and `9.9.9.9` A/AAAA/CNAME checks. Through the approved
   Tailscale path, re-read the pinned ED25519 fingerprint, provider/host identity, OS/architecture,
   Docker/Compose, resources, listeners, UFW, routes/networks, active ingress and immutable historical
   evidence. This step is read-only.
3. In the provider UI, compare metadata-only OAuth client/environment, exact tenant key and the
   literal HTTPS callback `https://lk2.padlhub.su/user/api/v1/<tenant-key>/auth/viva/callback`.
   Wildcards, mismatch or unavailable authenticated metadata are STOP; do not click Save.
4. Run approved read-only PostgreSQL, Redis and RabbitMQ inventories. Match the full migration ledger
   and checksums to the frozen source; prove roles/ACL/RLS, connections/locks, zero or explained outbox
   backlog, Redis contour/TLS/eviction/persistence/memory, and Rabbit vhost/permissions/topology/
   consumers/backlog/DLQ. Realtime startup is forbidden during this read-only step.
5. Verify a completed backup and independent restore-test receipt, immutable rollback mapping,
   monitoring/alerts and named abort thresholds. Listing a backup is not restore proof.
6. Obtain separate authority for each required live transition: host/file provisioning, secret copy,
   Docker network/volume creation, firewall/TLS/ingress, database migration, Realtime Rabbit topology,
   Worker activation and public beta activation. Authority for one does not authorize another.
7. Under separately approved host/file authority, create the release directory and install an exact
   clean root-owned Git checkout at `<release-dir>/source`; prove its SHA/tree, exact protected-tree
   bytes, Git metadata ownership and non-writable path custody. Then, under secret-mutation authority, run the
   metadata-only provisioner dry-run, inspect its plan, provision the exact release secret set and
   read back only marker/path/owner/mode metadata.
8. From that same frozen checkout through fixed `/usr/bin/node` under `env -i`, render `release.env`,
   render Compose with no ambient overrides, and verify all five immutable digests. Worker and
   Migrator stay disabled.
9. Keep Migrator disabled until a separate migration gate proves pending expand-compatible changes,
   lock budget, old/new coexistence, backup and rollback. Apply nothing during readiness review.
10. Under deployment authority, scrub every ambient `COMPOSE_*`, pass no `--profile`, and install/start
    the minimal explicitly approved services in this order: API, then Web, then optionally Realtime
    only after its separate Rabbit topology gate. Never target Worker or Migrator. Read back running
    digests, health, logs/metrics and dependency identity after every service.
11. Under separate ingress/TLS authority, start Caddy and verify DNS/TLS, health, browser/auth/OAuth,
    API read journeys and—only if separately approved—Realtime. Use provider/store read-back; HTTP 200
    alone is insufficient.
12. Hold the beta at its approved bounded scope. Stop/rollback on identity drift, dependency mismatch,
    migration uncertainty, unpublished outbox growth, Rabbit contention/DLQ, auth/OAuth mismatch,
    health regression or missing observability. Worker activation remains a later independent gate.

No step above authorizes publication dispatch/rerun, reconciliation, GHCR mutation, merge, deploy,
migration, provider write, firewall change, TLS issuance, worker/realtime activation or live data
mutation by itself.
