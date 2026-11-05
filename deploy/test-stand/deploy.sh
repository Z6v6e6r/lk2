#!/usr/bin/env bash
# Disposable LK2 test stand deploy. Run on the stand host from this directory.
#
#   ./deploy.sh <image-tag>           deploy that tag (a main commit SHA), migrating forward
#   ./deploy.sh --reset <image-tag>   wipe every stand volume first, then deploy on a fresh database
#   ./deploy.sh --rollback            redeploy the previous successful tag (migrations stay applied)
#   ./deploy.sh --status              show containers and the deployed tag history
#
# Not for production: one host, synthetic data, broad runtime grants, no backup.
set -euo pipefail
cd "$(dirname "$0")"

HISTORY=.deploy-history
CURRENT=.deploy-current
compose() { docker compose -f compose.yaml "$@"; }
log() { printf '[test-stand] %s\n' "$*"; }
die() { printf '[test-stand] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f stand.env ]] || die "stand.env is missing: cp stand.env.example stand.env and set TEST_STAND_DOMAIN"
TEST_STAND_DOMAIN=$(grep -E '^TEST_STAND_DOMAIN=' stand.env | tail -1 | cut -d= -f2- || true)
[[ -n "${TEST_STAND_DOMAIN}" ]] || die "set TEST_STAND_DOMAIN=<host name> in stand.env"
export TEST_STAND_DOMAIN

mode=deploy
case "${1:-}" in
  --reset) mode=reset; shift ;;
  --rollback) mode=rollback; shift ;;
  --status) mode=status; shift ;;
esac

if [[ $mode == status ]]; then
  PHUB_TAG=$(cat "$CURRENT" 2>/dev/null || echo none) compose ps
  log "deployed tags (newest last):"; tail -5 "$HISTORY" 2>/dev/null || true
  exit 0
fi

if [[ $mode == rollback ]]; then
  # .deploy-current is the tag the stand was last pointed at, successful or not. After a failed
  # attempt it differs from the newest successful tag, which is then the one to restore; when the
  # current tag is itself the newest success, restore the one before it.
  last_ok=$(tail -1 "$HISTORY" 2>/dev/null || true)
  current=$(cat "$CURRENT" 2>/dev/null || true)
  [[ -n $last_ok ]] || die "no successful tag recorded yet"
  if [[ $current != "$last_ok" ]]; then
    PHUB_TAG=$last_ok
  else
    [[ $(wc -l < "$HISTORY") -ge 2 ]] || die "no earlier successful tag than the current $current"
    PHUB_TAG=$(tail -2 "$HISTORY" | head -1)
  fi
else
  PHUB_TAG=${1:-}
  [[ $PHUB_TAG =~ ^[0-9a-f]{7,40}$|^test-stand$ ]] || die "usage: ./deploy.sh [--reset] <main commit sha>"
fi
export PHUB_TAG

# --- secrets: generated once per host, kept in .secrets/ (0700), never committed -------------
secret() { openssl rand -hex 24; }
if [[ ! -f .secrets/generated ]]; then
  log "generating stand secrets in .secrets/"
  umask 077; mkdir -p .secrets
  pg=$(secret); rt=$(secret); mq=$(secret); s3=$(secret)
  cat > .secrets/postgres.env <<EOF
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$pg
POSTGRES_DB=phub
EOF
  cat > .secrets/rabbitmq.env <<EOF
RABBITMQ_DEFAULT_USER=phub
RABBITMQ_DEFAULT_PASS=$mq
EOF
  cat > .secrets/minio.env <<EOF
MINIO_ROOT_USER=phub
MINIO_ROOT_PASSWORD=$s3
EOF
  cat > .secrets/migrator.env <<EOF
DATABASE_URL=postgresql://postgres:$pg@postgres:5432/phub
CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1
EOF
  cat > .secrets/runtime.env <<EOF
DATABASE_URL=postgresql://phub_runtime:$rt@postgres:5432/phub
REDIS_URL=redis://redis:6379
RABBITMQ_URL=amqp://phub:$mq@rabbitmq:5672
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://$TEST_STAND_DOMAIN
S3_ACCESS_KEY=phub
S3_SECRET_KEY=$s3
JWT_REALTIME_SECRET=$(secret)
GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET=$(secret)
CORS_ORIGINS=https://$TEST_STAND_DOMAIN
EOF
  cat > .secrets/api.env <<EOF
JWT_ACCESS_SECRET=$(secret)
JWT_REFRESH_SECRET=$(secret)
EOF
  printf '%s\n' "$rt" > .secrets/runtime-password
  touch .secrets/generated
fi
RUNTIME_PASSWORD=$(cat .secrets/runtime-password)

# --- reset: drop all stand data ---------------------------------------------------------------
if [[ $mode == reset ]]; then
  log "RESET: removing stand containers and volumes (all test data)"
  compose --profile tools down -v --remove-orphans
  : > "$HISTORY"; rm -f "$CURRENT"
fi

log "deploying tag $PHUB_TAG to https://$TEST_STAND_DOMAIN"
echo "$PHUB_TAG" > "$CURRENT"
compose --profile tools pull --quiet
compose up -d --wait postgres redis rabbitmq minio

log "migrating"
compose --profile tools run --rm migrator

log "granting phub_runtime"
compose exec -T postgres psql -U postgres -d phub -v ON_ERROR_STOP=1 -q \
  -v runtime_password="'$RUNTIME_PASSWORD'" -f - < grant-runtime.sql >/dev/null

log "starting application"
compose up -d --wait --remove-orphans api worker realtime web caddy

log "smoke"
ok=1
for path in /health/ready /realtime/health/ready /; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$TEST_STAND_DOMAIN$path" || true)
  log "  $path -> $code"
  [[ $code == 200 ]] || ok=0
done
if [[ $ok != 1 ]]; then
  log "smoke failed; recent API logs:"; compose logs --tail 40 api || true
  die "deploy of $PHUB_TAG failed smoke; run ./deploy.sh --rollback to return to the previous tag"
fi

# A rollback restores a tag that is already in the history; record only new successes.
[[ $mode == rollback ]] || echo "$PHUB_TAG" >> "$HISTORY"
log "OK: $PHUB_TAG is live at https://$TEST_STAND_DOMAIN"
