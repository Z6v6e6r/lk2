# LK2 test stand

A disposable single-host stand that runs the current `main` for manual testing. Every push to `main`
builds the five images (`.github/workflows/test-stand.yaml`) and deploys them here in a few minutes.

This is **not** the production route: one host, synthetic/mock data, broad `phub_runtime` grants,
no backup or custody. Wiping it is always allowed.

## One-time host setup

1. A Linux VM with Docker Engine + Compose plugin, ports 80/443 open, a DNS name pointing at it.
2. On the host:
   ```bash
   mkdir -p ~/phub-test-stand && cd ~/phub-test-stand
   # the workflow copies the files here; for a manual start copy deploy/test-stand/* yourself
   cp stand.env.example stand.env   # set TEST_STAND_DOMAIN, adjust feature flags
   ```
3. In GitHub → Settings → Environments → `test-stand`, add secrets `TEST_STAND_SSH_HOST`,
   `TEST_STAND_SSH_USER`, `TEST_STAND_SSH_KEY` (private key whose public half is in the host's
   `authorized_keys`). Without them the workflow still publishes images and skips the deploy.

## Operations (on the host, in `~/phub-test-stand`)

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `./deploy.sh <sha>`         | migrate forward, grant `phub_runtime`, start, smoke            |
| `./deploy.sh --reset <sha>` | wipe all stand data (keeps the TLS certificate), redeploy fresh |
| `./deploy.sh --rollback`    | redeploy the previous successful tag (migrations stay applied) |
| `./deploy.sh --status`      | containers and recent tags                                     |

From GitHub: Actions → Test stand → Run workflow (optional `sha`, `reset`).

Secrets are generated on the first run into `.secrets/` (mode 0700) and never leave the host.
Images are pulled from `ghcr.io/z6v6e6r/phub-*:<sha>`; the workflow logs the host in to GHCR for
each deploy.

## What runs

PostgreSQL 16, Redis, RabbitMQ, MinIO (built from upstream source, see `minio.Dockerfile`), API, Worker, Realtime, Web and Caddy (automatic HTTPS).
Migrations run as the PostgreSQL superuser, exactly as in local development and CI; the
application connects as `phub_runtime` (non-owner, no `BYPASSRLS`), so row-level security stays on.

`APP_ENV=staging`: `packages/config` refuses games, communities and home in `production`.
`VIVA_MODE=mock` by default: sign in with `+79990000001` / `0000`. Switch to `sandbox` with
Viva sandbox credentials in `stand.env` for provider journeys.

## Verified (LOCAL, 2026-11-05)

- All 119 migrations on an empty PostgreSQL 16 in about 2 s; `grant-runtime.sql` idempotent,
  zero application tables left without DML for `phub_runtime`.
- API with `phub_runtime`: `/health/ready` 200; `npm run smoke:auth` passes (challenge → verify →
  context → refresh → logout); context, home, games, profile, communities, locations answer 200.
- `stand.env.example` passes the API, Worker and Realtime config loaders at `APP_ENV=staging`.

Not verified here: the full compose run and Caddy TLS (container registries were unreachable from
the verification environment). The first real deploy is that check.
