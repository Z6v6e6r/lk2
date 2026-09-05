# LK2 local product loop

Use a dedicated task branch/worktree from recorded fresh `origin/main`, or continue the existing
one. Preserve dirty primary checkouts and inspect active task/PR ownership before changing shared
files. `AGENTS.md` owns risk and approval policy; the three `lk2-*` skills route development,
release preparation and deployment preparation without duplicating Timeweb procedures.

## Setup and commands

Requires Node 22+, npm 10.9+, the committed lockfile and Docker Desktop/Compose with `--wait` support.
Install host tooling using `npm ci`, not `npm install`; no new dependencies are required.

```sh
npm ci
npm run local:config
# Explicitly authorized initialization of a NEW disposable database only:
npm run local:up -- --fresh-db
npm run local:status
npm run local:stop
# Resume the same initialized database, without migration or seed:
npm run local:up
```

`local:config` derives and validates a local Compose model without starting containers. The launcher
selects the current context (or explicit `DOCKER_CONTEXT`) and prints context, endpoint, worktree
and project. Only known local `default` and Docker Desktop Unix socket endpoints are accepted;
remote/custom/unknown contexts and other ambient `DOCKER_*` overrides fail before mutation. It pins
subsequent calls to that endpoint and records the daemon ID. It never changes Docker context,
approvals or sandbox settings. If socket access is blocked, use the existing approval mechanism
for the exact local command; never weaken permissions globally.

The generated `.lk2-local/` files are ignored, private and synthetic. Each worktree receives its
own random local authentication keys and issuer; these are never printed or shared with another preview. Existing `.env` is never read,
printed or overwritten: the container sees a generated mock-only file over `/workspace/.env`.
App-level `apps/api/.env*` and `apps/web/.env*` files cause a stop for configuration review. The
launcher does not inherit shell application/Compose configuration into its generated model.

The model derives PostgreSQL/Redis images, health checks and application dev commands from
`compose.yaml`, and Node from `infra/docker/Dockerfile.dev`. It uses the Node base directly with a
current-worktree source mount, not an old application image. A per-worktree module volume receives
`npm ci` from the exact lockfile and generated contracts before startup. Nested workspace module
volumes isolate Linux modules from host modules. A changed lockfile requires stopping this preview
before reinstall. There is no publication or image build. Development image tags are inherited from the existing
Compose/Dockerfile and remain mutable; lockfile parity does not prove immutable image provenance.
Release digests are governed separately by the Timeweb runbooks.

The default contour is intentionally small: API, Web, PostgreSQL, Redis. API uses an internal
Docker network. Web additionally uses a loopback-published edge network; installation has a separate
egress network. No infrastructure or API port is exposed;
Web's proxy reaches API internally. Browser preview is `http://127.0.0.1:5173`. Startup waits for
PostgreSQL/Redis, applies the existing migrator only on first authorized initialization, and waits
for API readiness and Web HTTP health. Vite reflects edits from this worktree. Use the synthetic
phone/code documented in README for mock authentication. Mock application responses and existing
migration fixtures provide synthetic data; no legacy import or shared seed is run.

Worker, Realtime, RabbitMQ, MinIO, monitoring, provider calls and release processes are not part of
this contour. A task requiring them must explicitly extend/rehearse its dependency closure with
current Compose and domain runbooks; this preview does not prove messaging, media or provider E2E. It uses the disposable bootstrap DB
owner for API and migrator and does not prove RLS/ACL role isolation. Tenant/auth changes still need
the existing physical non-owner role/negative tests required by their CRITICAL boundary.

## Isolation and recovery

Project/network/volume names derive from the canonical worktree path. Stop before switching branches
in a worktree: a running dev process reads live source edits. The retained database is bound to its
task branch, and resume/status reject branch or recorded volume identity drift. The launcher checks Compose
project labels plus its own worktree label before adopting/stopping resources, refuses pre-existing
resources without its receipt and checks explicit name collisions. No fixed `phub-local-data`
network or existing host database is reused. Port 5173 is deliberately exclusive: a second preview
fails with the conflict reason instead of stopping/restarting the first. Another task's infrastructure
on 5432/5672 is unaffected because these ports are never bound.

A first start without `--fresh-db` stops. That flag is refused once the database exists or initialization succeeded; it cannot reset or migrate
an existing database. A failed dependency installation may be retried only while the database
container and volume are still absent. Fresh initialization requires absent owned resource
names and an empty database catalog before the canonical migrator. Later starts check the migration
source fingerprint and never migrate automatically. A changed migration chain or incomplete first
initialization stops; preserve the failed environment and use a new task worktree for another
explicitly approved fresh rehearsal. Do not delete a receipt to bypass custody checks.

`local:stop` stops only inspected owned container IDs and preserves containers, networks and volumes.
It never calls `down -v`, prune, reset or cleanup. Partial startup remains inspectable with
`local:status` and stoppable with `local:stop`. Concurrent commands in one worktree fail on an
operation lock; a timed-out Docker command retains the lock because its container may still run.
After a killed or timed-out launcher, confirm no launcher/child operation remains before manually
removing only that stale lock. Never remove another task's resources or automatically clean data.

Docker command output is withheld on failure to avoid environment disclosure. Diagnose only the
reported local project using targeted health/state reads and redacted logs; do not dump container
configuration, `.env` or all-process environments. Startup failure is not readiness.

## Codex local environment actions

[Official local environment documentation](https://learn.chatgpt.com/docs/environments/local-environment)
describes project-local setup scripts and terminal actions. The checked-in
`.codex/environments/environment.toml` uses the schema verified in the installed desktop app
(version, name, setup script, named actions with icon and command). Select it in Local environments
settings if the app does not pick it automatically.

| Entry           | Command                                | Effect                                                                                       |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Automatic setup | `npm ci && npm run contracts:generate` | Installs locked tooling and generates contracts; no Docker or DB operation                   |
| Start preview   | `npm run local:up`                     | Resumes an initialized owned environment; first use stops with the explicit fresh-DB command |
| Status          | `npm run local:status`                 | Reads local ownership and readiness                                                          |
| Stop preview    | `npm run local:stop`                   | Stops owned containers and preserves data                                                    |

The initial `npm run local:up -- --fresh-db` is a deliberate terminal action after disposable DB
authority, never automatic worktree setup. Skill invocation is not approval for a migration.

## Evidence and routing checks

Run affected checks per `AGENTS.md`. The launcher/runtime boundary itself requires the full
`npm run check`, focused isolation/negative tests and specialist review; this does not raise the
risk of future UI changes. Validate the derived model with `npm run local:config`.

For browser rehearsal: start the fresh contour, open Web, make a reversible visible text edit,
observe Vite update in that same tab, then restore the exact original bytes and confirm restoration.
Stop and resume once to verify persistence. Attempt a second worktree preview and verify the first
container IDs/readiness are unchanged. Never include the temporary UI edit in the final diff.

Instruction analysis is separate evidence from execution:

- “Change the interface” selects `lk2-dev`, local preview and touched-boundary checks, then Draft PR/CI.
- “Prepare a release” validates a source and prepares a plan; no publication dispatch follows.
- “Check deployment readiness” validates inputs and reports missing live evidence; no server write follows.

Report actual LOCAL commands/results, browser evidence, gaps, branch/head and Draft PR exact-head CI.
No local preview, skill validation or CI result proves STAGING, PROVIDER or PRODUCTION readiness.
