# PadlHub Platform

API-first platform for PadlHub web bundles, iOS/Android applications and the CUP operations console. The repository starts as a TypeScript modular monolith with separately deployable API, worker and realtime processes.

## Start locally

Requirements: Node.js 22+, npm 10.9+, Docker Desktop with Compose.

Use the [isolated local development loop](docs/runbooks/local-development.md) in your task worktree:

```bash
npm ci
npm run local:config
# Only with authority to initialize this worktree's new disposable local database:
npm run local:up -- --fresh-db
npm run local:status
npm run local:stop
# Later starts preserve the initialized database and do not apply migrations:
npm run local:up
```

Preview: `http://127.0.0.1:5173`. The launcher reuses the development Compose and commands, binds
this worktree's sources, uses mock data, checks local Docker/resource ownership and preserves data
on stop. The default contour is API/Web plus PostgreSQL/Redis; Realtime, Worker, media and monitoring
are not started. See the runbook before extending it for a task that needs those dependencies.
Existing `.env` is never overwritten or used by this launcher.

The raw Compose commands below are for deliberate manually isolated optional contours, not the
safe multi-worktree launcher. Check daemon, names, networks, volumes, ports and configuration first.

To browse the canonical OpenAPI contracts locally, start the documentation profile:

```bash
docker compose --profile docs up -d swagger-ui swagger-editor
```

Both services use the already-pulled, digest-pinned Swagger images and are only
available on the local loopback interface. Swagger UI is view-only: request
execution, authorization persistence and the remote validator are disabled.
Swagger Editor opens the canonical User API by default. Its copy of the
contracts is read-only, so download an edited file and apply it deliberately in
the repository before validating it with `npm run contracts:lint`.

Endpoints:

- API liveness: `http://localhost:3000/health/live`
- API readiness: `http://localhost:3000/health/ready`
- Swagger UI (view-only): `http://127.0.0.1:18080`
- Swagger Editor: `http://127.0.0.1:18082`
- First vertical web app: `http://localhost:5173` (with the `clients` profile or `npm run dev:web`)
- Realtime liveness: `http://localhost:3001/health/live`
- RabbitMQ UI: `http://localhost:15672`
- MinIO UI: `http://localhost:9001` by default (set `MINIO_CONSOLE_PORT` in `.env` to
  use another host port)
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3101`

## First user vertical

The first vertical is Viva-backed authentication followed by the protected home page; schedule is
intentionally out of scope. PadlHub issues its own access and refresh session. The default fallback
is provider-neutral phone authentication; the primary production screen starts Viva OAuth through
VK ID/Mail.ru or Yandex. The detailed, feature-gated exception for short-lived browser Viva access
and server-encrypted Viva refresh delegation is in
[ADR 0005](docs/adr/0005-viva-user-delegation-and-direct-transport.md).

With `VIVA_MODE=mock`, use the synthetic phone `+79990000001` and code `0000`. The mock makes no Viva
network call and is forbidden in production. The full switch, rollback and local verification
procedure is in the [authentication provider runbook](docs/runbooks/auth-provider-switch.md); the
security decisions are recorded in [ADR 0004](docs/adr/0004-provider-neutral-authentication.md) and
[ADR 0005](docs/adr/0005-viva-user-delegation-and-direct-transport.md).

After the local services are ready, `npm run smoke:auth` verifies the full authentication and
session lifecycle without exposing credentials in its output.

The executable boundary, acceptance evidence, feature gates and GO/NO-GO rules for the first web
release are defined in the [web-first MVP release plan](docs/plans/mvp-release-plan.md).

## Repository map

```text
apps/        api, worker, realtime, migrator, web, mobile, cup-admin
packages/    domain, database, contracts, SDK, UI, auth, observability, Viva boundaries
contracts/   immutable import, migration map, future canonical OpenAPI 3.1 contracts
infra/       Docker, monitoring, Terraform boundary and Ansible host baseline
deploy/      digest-only staging/production Compose and load-balancer template
docs/        architecture, ADRs, domain ownership and runbooks
scripts/     migration checks, smoke tests, backup check and rollback guard
```

## Full repository and release gates

```bash
npm run check
# For Compose changes only:
docker compose config
```

Daily development uses the risk-based FAST/SAFE/CRITICAL workflow in [AGENTS.md](AGENTS.md): run
focused affected checks by default and use the full gate only when the changed dependency closure or
CRITICAL boundary requires it. LOCAL, CI, STAGING, PROVIDER and PRODUCTION evidence are distinct.

The original `openapi.yaml` is preserved byte-for-byte under `contracts/imported/`; the root file is the lintable working draft. See [the contract gap](docs/api/imported-contract-gap.md) and [migration map](contracts/migration-map.yaml) before implementing its mutation endpoints.

Architecture source: [system-context.drawio](docs/architecture/system-context.drawio).
