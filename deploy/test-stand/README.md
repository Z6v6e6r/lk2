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

| Command                     | What it does                                                    |
| --------------------------- | --------------------------------------------------------------- |
| `./deploy.sh <sha>`         | migrate forward, grant `phub_runtime`, start, smoke             |
| `./deploy.sh --reset <sha>` | wipe all stand data (keeps the TLS certificate), redeploy fresh |
| `./deploy.sh --rollback`    | redeploy the previous successful tag (migrations stay applied)  |
| `./deploy.sh --status`      | containers and recent tags                                      |

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

## Game notifications on a fresh stand

`stand-runtime.sql` opens in-app notifications, but game notification rules are a separate audited
ruleset. The `Test stand` workflow re-applies it after every deploy (idempotent, so a `--reset`
recovers on its own) through an SSH tunnel to the stand PostgreSQL, acting as the synthetic operator
`00000000-0000-4000-8000-00000000a001`; `stand-runtime.sql` grants that operator `admin` +
`notifications.manage`. To apply it by hand:

```sh
DATABASE_URL=postgres://postgres:<stand password>@127.0.0.1:<tunnel port>/phub \
  npm run notifications:game:provision -- --tenant-key=local-padel \
  --actor-id=00000000-0000-4000-8000-00000000a001 \
  --idempotency-key=test-stand-game-ruleset-v1 --confirm=APPLY_GAME_NOTIFICATION_RULESET
```

## Multi-player E2E

`npm run stand:e2e` signs in the three synthetic phones (`AUTH_DEV_PHONE_E164` plus
`AUTH_DEV_EXTRA_PHONES_E164`) and checks the last-seat race, game chat and its ACL, leave/rejoin,
cancellation with a participant notification, direct chat, friends and a public community. It only
runs against `test.lk2.padlhub.su` or localhost (`PHUB_API_BASE_URL`). Community creation has a
daily quota, so a second run on the same day reports that step as SKIP.

`npm run stand:e2e:results` checks game result entry: a participant submits the score, the author
cannot confirm it, another participant disputes it, the score is submitted again and confirmed, and
a wrong roster, a non-participant and a second submission after confirmation are refused. A result
opens only after the Worker finishes the game and joining closes 30 minutes before the start, so
`--phase=prepare` creates a 4-player game that starts in about 32 minutes and lasts 5, and
`--phase=verify` runs after it ends (without `--phase` the script waits in between, about 40
minutes). It needs four synthetic phones; a fifth enables the non-participant check. Phones
`+79990000004` and `+79990000005` were added to `stand.env.example`; an existing host `stand.env` is
never overwritten, so add them to `AUTH_DEV_EXTRA_PHONES_E164` there.
