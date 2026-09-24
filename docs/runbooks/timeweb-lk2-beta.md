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
- API CORS allow-list `https://lk2.padlhub.su,https://padlhub.su`: the contour's own origin plus the
  separately hosted production CUP origin declared in `cupOrigins`, so an operator can drive this beta
  API from the CUP at `padlhub.su`. The list stays an exact bare-host declaration (no wildcards); the
  provisioner and the deployment-contract verifier both compare `api.CORS_ORIGINS` against it. The
  declaration is a required part of this target contract, so the beta always names its CUP origin;
  `readTimewebCorsOrigins` only falls back to the single self-origin value for a target that omits the
  key;
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

## API/Web observability and deterministic abort gate

`deploy/timeweb/api-web-observability.v1.json` is the machine-readable, source-only API/Web
observability contract. It defines two Timeweb HTTPS monitors: `GET /health/ready` for API and
`GET /` for Web. Each monitor must be enabled in at least two regions with a 60-second interval,
10-second timeout, expected status `200`, and a configured Basic `Authorization` header while the
beta ingress remains protected. The contract and its evidence contain only the boolean fact that
the header is configured; a credential value, secret reference value, or header value is forbidden.
Creating, editing or testing either provider monitor is a separately authorized paid Timeweb
operation and is not performed by source validation.

The initial beta observation window is 900 seconds. Capture at least 60 timestamped API/Web probe
samples no more than 15 seconds apart and at least 60 requests for each service. HTTP status and
latency come from direct API/Web probes, restart counters from read-only Docker inspect output, and
readiness from direct health probes. The verifier derives request/error counts, p95 latency,
consecutive readiness failures and restart deltas from the individual samples; aggregate operator
claims are not accepted. Any one of these boundaries is an immediate abort and rollback signal:

- two consecutive readiness failures;
- any API or Web container restart during the window;
- API or Web HTTP 5xx rate greater than or equal to 100 basis points (1%);
- API p95 latency greater than or equal to 1500 ms;
- Web p95 latency greater than or equal to 1000 ms;
- any active Timeweb monitor incident.

Before preflight can pass, both monitors must show at least three consecutive successful rounds.
Their last checks must be no more than 130 seconds old when evidence is frozen. The complete
observation must end no more than 300 seconds before that explicit observation time. The immutable
API/Web rollback image mapping and the canonical rollback receipt path must also be read back no
more than 300 seconds before the observation time. The supplied observation time must be no more
than 30 seconds behind the verifier's current UTC clock, so an old evidence packet cannot be replayed.

Alert custody is part of the gate, not a follow-up. A bounded provider alert test must prove delivery
to both `email` and `telegram` within 300 seconds, acknowledgement by the `release-owner` role within
600 seconds, and recovery delivery to both channels within 300 seconds. The alert test may be no
more than 24 hours old. Missing delivery, missing acknowledgement, an active incident, stale
evidence, or a threshold breach is `STOP`; do not continue to ingress activation.

Freeze the read-only results in the exact root-owned `0600` regular file
`/opt/phub/timeweb-beta/observability/api-web-evidence.json`. Its parent directories must be
root-owned, canonical and not group/other-writable. The strict evidence shape is exercised by
`scripts/verify-timeweb-api-web-observability.test.ts`; duplicate or unexpected keys fail closed.
The evidence must not contain Basic credentials, environment values, tokens or other secret values.
The canonical producer is `npm run timeweb:beta:observability:collect -- --release-id
'<source-sha>-<successful-run-id>-1'`. It accepts no output-path override and writes only
`/opt/phub/timeweb-beta/observability/api-web-evidence.json`. Run it as root from the exact release
checkout with the Basic `Authorization` header supplied on inherited file descriptor 3 by approved
secret custody; the header value is never accepted through argv or the environment and is never
printed or persisted by the producer. Before the final minute of its observation window, approved
read-only tooling must refresh these root-owned, single-link, non-symlink `0600` inputs:

- `/opt/phub/timeweb-beta/observability/timeweb-monitor-readback.json` with schema
  `PHUB_TIMEWEB_MONITOR_READBACK_V1`, source `timeweb-approved-read-only-readback`, project `262717`,
  and the exact current API/Web monitor IDs and effective configuration;
- `/opt/phub/timeweb-beta/observability/alert-test-readback.json` with schema
  `PHUB_TIMEWEB_ALERT_READBACK_V1`, source `approved-delivery-and-provider-readback`, delivery and
  recovery timestamps, `release-owner-observed-active-incident` acknowledgement semantics, and
  `provider-closed-after-all-regions-healthy` recovery semantics.

These files are approved readbacks, not operator PASS declarations. Unknown keys, credential
material, stale provider capture, monitor/project substitution, missing delivery or recovery, and
late acknowledgement fail closed. Timeweb has no native ACK state: `acknowledgedAt` records when the
release owner observed the active incident, while `recoveredAt` records the provider transition to
closed after all configured regions were healthy. If approved tooling cannot produce a required
provider fact, stop; do not synthesize it. The producer performs 66 direct API/Web GET probes over
at least 900 seconds, reads Docker restart counters without container environment output, rejects
container replacement, reads the canonical rollback receipt, validates the complete evidence with
the existing verifier logic, and atomically replaces the canonical file with a root-owned `0600`
single-link regular file.

Supply descriptor 3 from approved custody without putting the header value in argv, shell variables
or the environment. For file-backed custody, the operator-side shape is:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  sh -c 'exec 3<"$1"; shift; exec /usr/bin/npm run timeweb:beta:observability:collect -- "$@"' sh \
  '<approved-custody-header-file>' \
  --release-id '<source-sha>-<successful-run-id>-1'
```

The custody path is an operator placeholder, not a repository default. Do not put the header value
in the command, either readback, or the canonical evidence.

Validate the source contract without reading live state:

```sh
node scripts/verify-timeweb-api-web-observability.js --contract-only
```

After separately authorized provider monitor setup, delivery testing, and read-only evidence
collection, run the deterministic preflight from the exact frozen release source. Replace only the
four identity/time placeholders with values read independently from the candidate and evidence:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node scripts/verify-timeweb-api-web-observability.js \
  --evidence /opt/phub/timeweb-beta/observability/api-web-evidence.json \
  --expected-source-sha '<source-sha>' \
  --expected-source-tree '<source-tree>' \
  --expected-release-id '<source-sha>-<successful-run-id>-1' \
  --observed-at '<canonical-UTC-timestamp>'
```

The verifier accepts no ambient identity or operator-supplied current clock, performs no network or Docker call,
prints no observed values, and returns a pass only when the exact frozen HEAD/tree, current UTC
clock, source identity, target, monitor freshness, alert delivery/acknowledgement, raw observation
samples and immutable rollback receipt all match. It securely reads and hashes the canonical
receipt, then matches its prior API/Web references to the frozen rollback floor; digest-shaped
operator claims alone are rejected.
A pass is evidence for the observability gate only; it does not authorize deployment, workflow
dispatch, monitor mutation, ingress change, migration or rollback execution.

## Runtime and activation boundary

`deploy/timeweb/runtime-environment.contract.json` names required, allowed, and forbidden keys per
service without containing credential values. API, worker, realtime, and migrator use separate
required env files. Worker receives no API/provider/signing key set; realtime receives no API
access/refresh signing secret or provider credential. Initial write-capable flags remain disabled.

The API and Worker runtime additionally carry the Web Push key set: `WEB_PUSH_ENABLED=true`,
`WEB_PUSH_ENVIRONMENT`, `WEB_PUSH_APP_ID`, `WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_VAPID_PUBLIC_KEY`,
`WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS`,
`NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS` and `NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID`. The VAPID pair and
the endpoint-encryption keyring are required on every release even while push stays closed for a
tenant, because a browser subscription that was already handed to a push service is bound to that
exact pair and keyring; replacing them orphans every stored endpoint and needs an explicit rotation
plan. Generate them exactly as the local provisioner does: the VAPID pair from the `web-push` key
generator and the keyring as 32 random bytes in canonical standard base64. Do not copy the Web Push
block from [the chats and notifications runbook](chats-notifications-moderation.md) wholesale:
`WEB_PUSH_BATCH_SIZE` and `WEB_PUSH_ENDPOINTS_PER_USER_MAX` are not in this target's allowlist and an
env file carrying them fails closed as an unknown key, so the code defaults stay in force.

`WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS` lists the public push services and nothing else. It carries
`https://fcm.googleapis.com` for Chrome/Chromium and `https://web.push.apple.com` for Safari on iOS and
iPadOS; a subscription from any other origin is rejected as `WEB_PUSH_SUBSCRIPTION_INVALID`, and the
Worker repeats the same check before it sends. Firefox endpoints stay rejected until their origin is
added by a separate release, and a new origin must be added to both `api.env` and `worker.env`, because
the API validates the registration and the Worker validates the delivery.

iOS delivers Web Push only to a web app the person added to the Home Screen (iOS 16.4+), so the web
client ships `manifest.webmanifest` with `display: standalone` and an `apple-touch-icon`, and reports
`needs_install` in a Safari tab instead of offering a button that cannot work. iOS ignores the
notification `icon`/`badge` and shows the installed app icon, so a notification on an iPhone carries the
title and body only; verify the install path on a real device, because no Apple endpoint exists in the
contour until one is registered from a Home Screen app.

Push stays closed per tenant through `notifications.tenant_runtime_settings.web_push_enabled` and an
active `WEB_PUSH` provider account, so a release that carries the keys does not by itself deliver
anything.

`WEB_PUSH_VAPID_PRIVATE_KEY` is required in `api.env` although only the Worker signs a push request,
because the shared runtime config requires the complete Web Push key set whenever
`WEB_PUSH_ENABLED=true`. That places the push-signing key in the internet-facing API process; the
alternative is a separate delivery-only config requirement, which stays a follow-up.

`NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS` is the only secret whose value is a JSON object, and the
provisioner admits exactly one flat identifier-to-base64 object for that key while it keeps rejecting
`$`, `#`, `'`, backslash and whitespace for every value. The value must start with `{` so Compose
treats it as unquoted and preserves the inner quotes; each entry must decode to exactly 32 bytes and
the provisioner now rejects any other length or a non-canonical encoding. The Compose `env_file`
round trip itself has no automated test: the provisioner unit tests cover the accepted character set
and the keyring shape, and the byte-exact delivery to a container is manual LOCAL evidence only, so
repeat it on the target before the first activation.

The default application model contains only web, API, and realtime. Worker is gated by profile
`background`; migrator is gated by profile `migration`; neither is a dependency of a default
service. Only ingress may bind host ports. Publication, deployment, Caddy activation, migration,
worker activation, OAuth/provider changes, and any live write each require a later explicit gate.

Web Push activation on this target follows the canonical order, because each compose stage refuses to
run until the runtime secret set already names the candidate release: install the candidate checkout,
provision the secret input files with a freshly generated VAPID pair and keyring under the new
`--release-id`, render `release.env`, run `--mode prepare`, then the compose stages
`preflight`, `pull-api`/`up-api`, `pull-web`/`up-web`, `pull-realtime`/`up-realtime` under the
RabbitMQ topology gate and `pull-worker`/`up-worker` under the worker activation gate. Provisioning
after a container start would not reach the running process, because the environment is bound at
container creation. Only then open the tenant: an active `WEB_PUSH` provider account followed by the
`web_push_enabled` gate, both through the operator commands in
[the chats and notifications runbook](chats-notifications-moderation.md), while `in_app_enabled`
stays independent. Verify with one user-granted browser subscription from `/notifications` and one
delivered notification, then read `notifications.deliveries` and `delivery_receipts` for
`SENT`/`PROVIDER_ACCEPTED`.

Rollback order is the tenant gate first, the provider account second, and the release third; keep
`WEB_PUSH_ENABLED=true` while already-created deliveries reach a terminal state. The release
rollback floor restores the API and Web images only, so a rollback that must also stop the newly
activated Worker needs its own explicit transition rather than being assumed from the floor.

For the authorized public Yandex beta, the API runtime must additionally contain
`VIVA_OAUTH_ALLOWED_PROVIDERS=yandex` and
`VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED=true`. The latter remains a required true flag in the
Timeweb runtime contract and cannot be combined with existing-subject bootstrap. The runtime must
also supply non-`pending` `PUBLIC_OFFER_VERSION` and `PERSONAL_DATA_POLICY_VERSION` values that map
to the published documents linked by Web. Keycloak may emit signed broker provenance
`identity_provider=yandex` or `identityProvider=yandex` in the signed ID token or, with a dedicated
protocol mapper, in the access token. When a verified token presents the claim it must match, and two
verified tokens that disagree must fail closed. The public-beta client emits the claim in neither
token and PadlHub has no protocol-mapper access to the vendor realm, so an absent claim is recorded as
`provenance=absent` (or `present_non_string` when the key exists but is unusable) on the `jwt_verify`
metric and is not a STOP condition: tenant, authorized party and subject stay cryptographically bound
by `tenant_key`/`azp` in the signed token and by the PKCE `code_verifier` and the one-time state, while
the upstream broker is asserted only when a signed token presents the claim. The remaining exposure is
that a login brokered by another identity provider in the same realm is accepted; it is bounded only
while that realm offers one usable broker or direct-grant path for this client and does not auto-link
brokers onto the same local user, so record that realm property once before relying on this relaxation.

Removing the operator Basic Auth gate is a controlled ingress activation after the new API/Web pair
is ready. Use only `deploy/timeweb/Caddyfile.yandex-public-beta`, whose adapted JSON hash is frozen in
`deploy/timeweb/yandex-public-beta-ingress.json`. During beta testing the policy proxies every method
of the client and admin API (`/health/*`, `/public/api/*`, `/user/api/*`, `/admin/api/*`) to the API,
so authorization, tenant resolution, idempotency and audit stay with the API. The service-only
`/internal/api` namespace is deliberately not routed and remains reachable only from inside the Docker
network, and the contract still rejects an embedded `Authorization`, `Cookie` or `basic_auth` gate and
any `/internal/api` exposure. Do not edit either artifact on the host.

Allowing the phone challenge routes also makes the first outbound OTP send reachable from the public
internet. The application bounds it per phone number (resend cooldown) and at 5 requests per minute
per tenant, phone digest and client IP, but there is no global or edge limit, so distributed SMS
pumping across many distinct numbers is possible. For this beta the exposure is accepted explicitly:
watch challenge volume through the soak window and stop the contour when the volume cannot be
explained by known testers.

The noncanonical current fast-beta rollback floor is frozen in
`deploy/timeweb/yandex-public-beta-rollback-floor.json`. Its required
`applicationComposeProject=phub-timeweb-beta-apps` binds prepare's prior API/Web image checks to the
legacy Compose project. Missing or different project values fail closed; operation input and
environment variables cannot override this source-owned binding. The frozen-source check protects
the floor file before it is read. Candidate checks retain the canonical `phub-timeweb-beta` project.
The V2 receipt schema and candidate/floor source identities remain unchanged.

This binding only identifies the predecessor; it does not stop containers or transfer their network
addresses. Before stopping the legacy pair, complete prepare's local image and backup prerequisites
and separately prove the address handoff and chosen recovery path. Retaining stopped legacy IDs for
recovery needs an explicitly approved transition plan: the existing `rollback` command recreates
floor images in the canonical project and does not restart those preserved legacy containers.

Failed run `33168712014` is provenance only and authorizes neither publication nor deployment.
After publication and secret provisioning,
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
It validates all four canonical runtime env files against the target contract and binds their
SHA-256 hashes into the V2 receipt before writing the Basic preimage backup and complete root-only
receipt. It logs no Caddy bytes, environment values or credentials.
The receipt path is canonical and exact:
`/opt/phub/timeweb-beta/backups/yandex-public/receipt.json`; alternate receipt paths are rejected by
prepare, activation and rollback so observability cannot attest different receipt bytes.

Start the candidate API behind Basic through the exact rendered `release.env` and canonical
`compose.beta.yaml`, prove readiness, then start Web the same way. Compose stamps both containers
with the non-secret exact `phub.release-id` label. Public ingress is last:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node scripts/control-timeweb-yandex-public-beta.js --mode activate-ingress \
  --receipt /opt/phub/timeweb-beta/backups/yandex-public/receipt.json
```

The controller rechecks the frozen source, canonical root-only `release.env`, receipt, all bound
runtime-env hashes, candidate API/Web container images, exact release labels, runtime release
identity and both Caddy hashes. Immediately before public ingress, it also attests the running API
container's complete expected environment in memory, rejects duplicate or missing values, forbidden
dev-auth keys and unknown enabled capabilities, and emits only stable error codes. The
active Caddyfile must be exactly the `./Caddyfile` mounted beside the validated ingress Compose; an
operator-supplied alternate path is rejected. The controller proves that the currently mounted
Caddy configuration still has the receipt-bound Basic policy and passes all five Basic `401` probes
before and after the candidate checks. The activation command itself re-runs the complete root-only
observability evidence verifier against the exact source/tree/release and V2 receipt; stale evidence,
monitor or alert drift returns `observability_gate` before any public transition. It validates the
prospective file offline with the already-local pinned Caddy image, atomically installs it, then
force-recreates only Caddy so the single-file bind mount receives the new inode. The recreated
container must use the exact pinned image, be running and adapt the mounted file to the receipt-bound
hash. Offline validation streams root-read bytes over stdin to a non-root, read-only, networkless
container, so the root-only `0600` Basic backup is never exposed through a file bind mount. A
loopback TLS smoke then proves HTTP redirect, Web `200`, API readiness `200` and a denied
non-allowlisted POST `405`, without credentials or provider mutation. Any
validation/recreate/verification/smoke failure restores Basic through that same sequence and proves
unauthenticated `401` responses for the HTTPS root, OAuth authorize, public API read, user API write
and realtime health paths before returning failure. If Basic restoration cannot be proven, the
controller stops only the Caddy service, verifies that it is not running and that loopback ports 80
and 443 accept no HTTP response, then returns `ingress_stopped`. If containment also cannot be
proven, it returns `ingress_state_unknown`, which is a manual STOP condition; never interpret either
outcome as successful activation. Re-entry after an interrupted public Caddy install routes through
the same recovery path before any candidate source, runtime or observability validation, so drift in
those inputs cannot strand a previously public ingress. `caddy reload` is
intentionally forbidden because both artifacts set `admin off`.
For upgrade recovery only, the minimal reader accepts the predecessor V1 receipt's canonical
Basic-backup, Caddy and Compose recovery fields. V1 can restore Basic or stop ingress, but it cannot
pass full candidate validation, observability or public activation; only V2 authorizes those gates.

Rollback is executable and ordered, never prose-only:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node scripts/control-timeweb-yandex-public-beta.js --mode rollback \
  --receipt /opt/phub/timeweb-beta/backups/yandex-public/receipt.json
```

It reads only the minimal root-owned recovery receipt, then restores, validates, force-recreates and
verifies Basic (or proves Caddy containment) before candidate source, application Compose or rollback
environment validation. Only then does it restore the locally retained prior API, wait for health,
restore Web and wait for health. It never pulls, migrates, deletes identity rows
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
Worker uses its dedicated config loader, which requires the isolated runtime marker and rejects API
access/refresh signing secrets outside local/CI. Internal non-signing sentinels satisfy the shared
parser shape and are removed from the process-specific Worker config before it is returned. Worker
activation remains a separate STOP until the RabbitMQ topology, leased outbox and forward-progress
gates are explicitly approved and proven; do not add API signing secrets to `worker.env`.

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

The beta API runtime additionally requires a complete tenant media-storage binding
(`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) because
client-assisted avatar sync is a required-true flag: the browser reads the observed provider photo
and the API stores the re-encoded image in that bucket. Delivery stays presigned against
`S3_PUBLIC_ENDPOINT`, so the bucket itself does not need public read and raw provider photo URLs are
never handed to clients.

`CUP_IDENTITY_CLIENT_PHONE_SYNC_ENABLED=true` adds the client-certified provider phone link. The
provider certifies only the browser transport for its end-user profile API — its host answers our
server egress for `/end-user/api` with `403`, so the server cannot read that profile at all. The web
client therefore hands the phone from the profile read it already performs to
`POST /user/api/v1/<tenantKey>/profile/provider-phone`; the API re-normalizes the value and stores it
in `integration.external_entity_map` (`VIVA`/`legacy_viewer_phone`), which is what keys the
viewer-scoped legacy (CUP) community and history reads. The value never becomes a PadlHub login key,
never enters `profile.user_summaries.phone_e164` and is never proof for payment, participation or
activity-history guards; a phone already linked to another active user is skipped as `conflict`.

The same link is the only anchor a client-assisted OAuth account has for its imported legacy player
row, so the API also resolves that account's one-way player keys against the legacy Games of that phone
and delivers the friend requests saved against those imported rows. That resolution is delivery-only:
it never writes `integration.legacy_game_player_bindings`, so the client-asserted phone can route a
saved friend request but can never re-point an imported player, a roster or a participation; the
identity binding stays reserved for the Viva-proven and verified-login-phone proofs. The proof is
best-effort: a `403`, timeout or empty result never fails the link or the login. It is skipped while
the tenant has no saved request waiting, which is a cost guard and not a per-account quota: one
permanently pending row keeps the phone-keyed read in play for every later phone link, so treat a
stuck `PENDING` row as an operator-visible condition rather than only a user complaint. Verify the
operator-side effect after a real cabinet profile read:

```sql
select count(*), max(last_synced_at)
  from integration.external_entity_map
 where entity_type = 'legacy_viewer_phone';

select state, count(*)
  from profile.deferred_friend_requests
 group by state;
```

The log line `legacy viewer association proof completed` carries one outcome per phone link:

| Outcome           | Meaning                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `absent`          | no usable phone in the request; nothing was read                                                                                               |
| `tenant_mismatch` | the caller's tenant is not the configured legacy tenant; nothing was read                                                                      |
| `no_pending`      | no saved request is waiting in the tenant; nothing was read                                                                                    |
| `no_match`        | the mirror has no Game proving that phone, or stores the number unusably                                                                       |
| `not_deliverable` | player keys were proven but no waiting saved request could be settled                                                                          |
| `delivered`       | at least one saved request settled; a real request exists unless the settled reason is `SELF_TARGET`, `ALREADY_FRIEND` or `TARGET_UNAVAILABLE` |
| `unavailable`     | the legacy read or the delivery failed; nothing changed and the next link retries                                                              |

The viewer-phone lookup matches the mirror's own phone columns in memory and accepts the same stored
shapes as the viewer-scoped legacy community reader (`79990000001`, `+7 (999) 000-00-01`,
`89990000001`, a bare national number or a numeric field). Confirm once against the mirror that a
known tester number is actually stored in one of those shapes in
`organizer.phoneNorm`/`participants.phoneNorm` or `organizer.phone`/`participants.phone`, and confirm
the phone filter is index-supported, because a shape or an index the matcher cannot use returns
`no_match` while the saved request simply stays pending.

A viewer whose legacy communities still read `UNAVAILABLE` either has no linked phone yet or owns no
delegation, because the legacy read path needs both.

## Legacy roster quarantine on this contour

The beta worker reads the CUP Mongo mirror (`LEGACY_GAMES_ROSTER_SYNC_SOURCE=mongo`) and mirrors a
roster only when its recorded mirror revision still matches. A game that was imported before this
contour and whose source has since moved on is never taken over silently: the worker records
`LEGACY_GAME_ROSTER_BASELINE_MISMATCH` in `integration.legacy_game_roster_sync_state` and leaves the
game quarantined, as `docs/runbooks/games-legacy-server-migration.md` requires.

Live state on 2026-09-16 after the activity-history release:

| Mode       | Rows | Meaning                                                               |
| ---------- | ---- | --------------------------------------------------------------------- |
| `MIRROR`   | 62   | the worker owns and refreshes the roster                              |
| `CONFLICT` | 139  | quarantined; every one carries `LEGACY_GAME_ROSTER_BASELINE_MISMATCH` |

Classify the quarantined games before proposing any repair:

```sql
with c as (
  select s.tenant_id, s.game_id, s.source_external_version,
         (select m.external_version from integration.external_entity_map m
           where m.tenant_id = s.tenant_id and m.external_system = 'LK_LEGACY_SNAPSHOT'
             and m.entity_type = 'game' and m.internal_id = s.game_id
           order by m.last_synced_at desc nulls last limit 1) as mapping_version
    from integration.legacy_game_roster_sync_state s
   where s.mode <> 'MIRROR'
), p as (
  select c.game_id,
         count(pt.id) as active_participants,
         count(*) filter (where player.internal_id is null) as unmapped_participants
    from c
    join games.participations pt
      on pt.tenant_id = c.tenant_id and pt.game_id = c.game_id and pt.state = 'ACTIVE'
    left join integration.external_entity_map player
      on player.tenant_id = pt.tenant_id and player.external_system = 'LK_LEGACY_SNAPSHOT'
     and player.entity_type = 'game_player' and player.internal_id = pt.user_id
   group by 1
)
select count(*) as conflict_games,
       count(*) filter (where p.unmapped_participants > 0) as with_unmapped_participant,
       count(*) filter (where coalesce(p.unmapped_participants,0) = 0
                          and c.mapping_version = c.source_external_version) as mapped_same_version,
       count(*) filter (where coalesce(p.unmapped_participants,0) = 0
                          and c.mapping_version is distinct from c.source_external_version)
         as mapped_version_drift
  from c left join p on p.game_id = c.game_id;
```

On 2026-09-16 that returned `139 | 0 | 103 | 36`: no game is quarantined because of an unmapped
participant, 103 have a matching import provenance and a genuinely different source roster, and 36
were imported from an older source revision. Both groups are real drift, so taking ownership changes
who is on a roster that local users may already have paid for.

The audited repair exists as a worker one-shot, and it is additive by default:

```sh
docker exec phub-timeweb-beta-worker-1 \
  node /app/apps/worker/dist/repair-legacy-game-rosters.js --tenant-key local-padel --limit 500
```

It reads the same bounded source window as the sync cycle, touches only Games whose sync state is
`CONFLICT`, reuses the mirror application in one transaction, writes the `game.scheduled.v1` outbox
fact and an audit row (`GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT`, reason
`OPERATOR_REPAIR_ADDITIVE`), and prints a `PHUB_TIMEWEB_LEGACY_ROSTER_REPAIR_V1` report. A Game whose
source omits an active local participant is **not** modified: it is reported as `deferred` with the
new `LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL` code and stays quarantined. Moving those
participants to `LEFT` requires `--allow-local-removals`, and that flag is a live roster mutation
that needs its own explicit decision.

First run on 2026-09-16 (release `25bf365bb804…-35143892965-1`): `attempted 294`, `rebaselined 113`,
`deferred 3` (two local participants each), `skipped 178`; the contour then held `MIRROR 175` /
`CONFLICT 37` and 113 `game.scheduled.v1` events, with zero worker errors.

## Operator dependencies

PostgreSQL, Redis, RabbitMQ and ClamAV run as operator-managed containers on the external
`phub-timeweb-beta` network and are **not** part of the immutable release. Their Compose model is
`/opt/phub/timeweb-beta/operator/compose.dependencies.yaml` on the host and every image is pinned by
digest; the release stages never create, pull or replace them.

| Service  | Address        | Purpose                                                      |
| -------- | -------------- | ------------------------------------------------------------ |
| postgres | `172.30.26.20` | canonical database (`phub_beta`)                             |
| redis    | `172.30.26.21` | cache, locks, rate limits, read-job state                    |
| rabbitmq | `172.30.26.22` | outbox and consumer transport                                |
| clamav   | `172.30.26.23` | malware scanning for community media (`clamd` INSTREAM 3310) |

ClamAV is pinned to
`docker.io/clamav/clamav@sha256:f156095071757e3838caa50265d65e36cdf7f934a27aacf851ea6d2fadbe8200`
and keeps its signatures on the `phub-timeweb-beta-clamav-data` volume, so only the first start pays
the signature download and the health check allows a 300-second start period. The worker's scanner
uses the `zINSTREAM` command over TCP, so the container publishes no ports:

```sh
# Verify the scanner the worker actually speaks to (expect FOUND, then OK).
docker exec phub-timeweb-beta-worker-1 node -e '<zINSTREAM probe against 172.30.26.23:3310>'
```

Signature freshness is an operational gap on this contour. The ClamAV CDN
(`database.clamav.net`, fronted by Cloudflare) answers every request from the beta host and from a
normal workstation with a `403` Cloudflare block page, whatever the user agent or TLS stack, so
`freshclam` inside the container fails with `Forbidden; Blocked by CDN` and reports itself as
fatally unable to continue. The scanner therefore runs on the signatures shipped inside the pinned
image (observed `ClamAV 1.4.6/28122/Sun Sep 13 06:26:25 2026` on 2026-09-16) and stays functional for
scanning, but does not gain new signatures. Until a mirror or an allowed egress is provided, the
interim mitigation is to re-pull a newer `clamav/clamav` image and re-create the container, which
refreshes the bundled databases; the durable fix is a signature mirror or a scheduled fetch through
an egress the CDN accepts.

Provisioning ClamAV does not enable community media. `COMMUNITY_MEDIA_ENABLED=true` is rejected by
configuration while `COMMUNITIES_READ_MODE=legacy`, because uploads require PadlHub to own community
writes; enabling media therefore belongs to the same change that switches the contour to
`COMMUNITIES_READ_MODE=local`, and needs `COMMUNITY_MEDIA_SCAN_MODE=clamav` plus
`COMMUNITY_MEDIA_CLAMAV_HOST` in the release environment contract.

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
the controller proves that checkout. The Ubuntu-owned `/usr/bin/python3` entry may be a root-owned
symlink: its non-authoritative symlink mode bits are ignored, while strict resolution and the
root-owned, regular, non-group/other-writable canonical target remain mandatory. Replace only the
release path and two identity values:

```sh
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LC_ALL=C \
  /usr/bin/python3 -I -S -B '<release-source>/scripts/control-timeweb-operator-node-bootstrap.py' plan --expected-source-sha '<source-sha>' --expected-source-tree '<source-tree>'
```

`plan` does not install a package. It verifies the frozen Git blobs, OS, launcher custody, source,
keyring, empty `dpkg --audit` and absent pre-state. Before every `apt-config`, `apt-cache` or
`apt-get` process it injects the root-owned, frozen
`deploy/timeweb/operator-node-bootstrap.apt.conf` through `APT_CONFIG`. APT loads that file before
its normal configuration directories, so the file disables `Dir::Etc::parts` and
`Dir::Etc::main` before host `apt.conf.d` lifecycle hooks can be read; any surviving
`DPkg::` or `APT::` pre/post-invoke hook remains a hard stop. It then runs authenticated
`apt-get update` into
an isolated root-only lists directory using only the frozen source and keyring, rejects every
unexpected index target, and uses that same snapshot for exact simulation, URI selection and `.deb`
download. Lifecycle-bearing maintainer scripts are rejected. The lists, packages and atomic `0600`
plan are published as one directory rename; the plan binds the plan ID, source/list/simulation
checksums and every payload and control-metadata SHA-256. Stop for separate authority naming that
plan ID before `apply`. Any existing or dangling-symlink bundle, transaction, install receipt or
rollback receipt blocks planning before the state root can be created. Apply rechecks the persistent
markers before package work; historical evidence must never be overwritten or discovered only
after package mutation.

Ubuntu 26.04 APT changes the empty isolated-list helper directories after `update`: `partial` is
`_apt:root 0700` and `auxfiles` is `_apt:root 0755` (`_apt` is the frozen platform UID 42). The
controller accepts that exact sandbox-owned state, or the previously supported `root:root` empty
directories, only beneath the already verified root-owned `0700` lists parent. Both directories
must remain real, canonical, non-group/world-writable and empty. Every other non-root owner, mode,
name, type, symlink, populated auxiliary directory or unexpected list target remains a hard stop.
The empty package-archive `partial` directory follows the same custody rule, with the only
sandbox-owned form fixed to `_apt:root 0700`; its root-owned baseline must be `root:root`.

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
two-file inventory and complete live registry inventory `5/5`. GitHub requires an Actions-capable
credential to download the archive, so that download is performed off-host through the authenticated
operator workstation or browser. Transfer the resulting archive without modification to the exact
future-release path `<release-dir>/artifact/canonical-artifact.zip`, owned by `root:root`, mode
`0600`, with one link beneath a root-owned, non-group/other-writable parent chain. The renderer never
accepts an Actions credential: it queries the exact artifact metadata using the narrow
`read:packages` token, requires the local archive SHA-256 to equal GitHub `artifact.digest`, extracts
exactly the two canonical files, and compares their bytes with the supplied pair. A local manifest
checksum and the GitHub artifact custody digest are distinct fields and are both recorded. The
renderer rejects legacy/
reconciliation/receipt/inventory shapes, mutable references, incomplete component sets, historical
paths, ambient `COMPOSE_*` overrides and the failed run `33011023879` explicitly.

The one-shot GitHub release-reader token contract is machine-readable at
`deploy/timeweb/github-release-reader.contract.json`. The renderer accepts only
`/etc/phub/timeweb-beta/github-release-reader.token`: a fresh root-owned/root-group regular `0600`
single-link file beneath a root-owned, non-group/other-writable parent chain. The credential must be
a classic PAT with the `ghp_` prefix and GitHub must report its complete actual scope set as exactly
`read:packages`; missing scope metadata or any additional scope is STOP. The controller can address
only repository `Z6v6e6r/lk2` and the five enumerated `phub-*` packages. The file is valid for at
most one hour, is never accepted through an environment override, and must be revoked by the named
repository owner after the final release lookup. `oneShot` and `revokeAfterUse` are operator gates,
not claims that the read-only renderer can revoke a GitHub credential: the release operation is not
complete until GitHub-side revocation and local token-file removal have both been read back. A
surviving or reused token is STOP. Token bytes never enter argv, output, logs, checksums or an
environment dump. Caller-authored evidence and caller-authored evidence checksums are not accepted.
Token compromise remains a trust-boundary STOP and does not waive the independent
manifest/provenance verification.

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
  --github-token-file '/etc/phub/timeweb-beta/github-release-reader.token' \
  --artifact-archive '<exact-release-dir>/artifact/canonical-artifact.zip' \
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
rollback identity, and records `PHUB_WORKER_ENABLED=true` and `PHUB_MIGRATOR_ENABLED=false`. It sets
`COMPOSE_PROFILES` to the empty value and contains no credential values. The authorized morning
path must also scrub ambient `COMPOSE_*` and must name only the allowed service at each step. Offline
validation asserts that default rendered services are exactly API, Realtime and Web; Worker and
Migrator are promoted deliberately through their own profile-gated stages.

After separate deployment authority, use only the renderer's source-controlled stage controller. It
scrubs ambient `COMPOSE_*`, performs a default-service preflight before every stage, passes no shell,
and exposes `pull-worker`/`up-worker` (profile `background`) and `pull-migrator`/`up-migrator`
(profile `migration`) alongside the api, web and realtime stages. Migrator stays
`PHUB_MIGRATOR_ENABLED=false` and must be run only under its own migration gate:

```sh
sudo -- /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  /usr/bin/node '/opt/phub/timeweb-beta/releases/<source-sha>-<successful-run-id>-1/source/scripts/render-timeweb-beta-release-env.js' \
  --compose-stage preflight \
  --release-env '<exact-release-dir>/release.env' \
  --manifest '<canonical-artifact-dir>/release-manifest.json' \
  --expected-manifest-sha256 '<release-manifest-json-sha256>' \
  --github-token-file '/etc/phub/timeweb-beta/github-release-reader.token' \
  --artifact-archive '<exact-release-dir>/artifact/canonical-artifact.zip' \
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

The disposable candidate-level rehearsal is documented separately in
`docs/runbooks/timeweb-beta-candidate-rehearsal.md`. Its single entrypoint is
`npm run test:timeweb-beta-candidate`; it uses only synthetic local state and cannot replace the
authenticated publication and host-custody checks below.

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
   exact canonical artifact ID/name/digest and registry inventory `5/5`. Download the exact artifact
   only off-host through the authenticated operator workstation or browser and transfer it to the
   fixed root-only archive path. Let the renderer repeat the authenticated metadata lookup, bind the
   local ZIP SHA-256 to GitHub `artifact.digest`, and verify the supplied manifest checksum, exact
   two-file inventory and pair bytes, five component records and immutable index/runtime digests.
   STOP on any drift, failed/partial run, caller-authored evidence or missing pair/archive.
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
   render Compose with no ambient overrides, and verify all five immutable digests. Migrator stays
   disabled.
9. Keep Migrator disabled until a separate migration gate proves pending expand-compatible changes,
   lock budget, old/new coexistence, backup and rollback. Apply nothing during readiness review.
10. Under deployment authority, scrub every ambient `COMPOSE_*` and install/start services in this
    order: API, then Web, then Realtime, then Worker through its `background` profile. Read back
    running digests, health, logs/metrics and dependency identity after every service. Run the
    Migrator only through its `migration` profile under step 9's gate.
11. Under separate ingress/TLS authority, start Caddy and verify DNS/TLS, health, browser/auth/OAuth,
    API read journeys and—only if separately approved—Realtime. Use provider/store read-back; HTTP 200
    alone is insufficient.
12. Hold the beta at its approved bounded scope. Stop/rollback on identity drift, dependency mismatch,
    migration uncertainty, unpublished outbox growth, Rabbit contention/DLQ, auth/OAuth mismatch,
    health regression or missing observability. Worker activation remains a later independent gate.

No step above authorizes publication dispatch/rerun, reconciliation, GHCR mutation, merge, deploy,
migration, provider write, firewall change, TLS issuance, worker/realtime activation or live data
mutation by itself.
