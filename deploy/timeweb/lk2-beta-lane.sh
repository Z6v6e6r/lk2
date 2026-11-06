#!/usr/bin/env bash
# LK2 disposable beta lane: promote one green main commit to lk2.padlhub.su.
# Run as root on the lk2 host. See docs/runbooks/lk2-beta-lane.md.
#
#   lk2-beta-lane.sh plan <sha>       pull the five images, show pending migrations and current state
#   lk2-beta-lane.sh promote <sha>    backup -> migrate (+ runtime grants) -> api/realtime/web/worker -> smoke
#   lk2-beta-lane.sh rollback         restore the previous recorded application images (schema stays)
#   lk2-beta-lane.sh status           containers, images and recorded history
#
# Valid only while lk2 holds synthetic data (AGENTS.md first-version mode). Each promote needs the
# owner's approval for that SHA. The migrator refuses any cluster other than lk2 phub_beta.
set -euo pipefail
umask 077

REGISTRY=ghcr.io/z6v6e6r
PROJECT=phub-timeweb-beta
NETWORK=phub-timeweb-beta
DATABASE=phub_beta
POSTGRES_IP=172.30.26.20
PUBLIC_ORIGIN=${LK2_BETA_PUBLIC_ORIGIN:-https://lk2.padlhub.su}
ENV_ROOT=${TIMEWEB_RUNTIME_ENV_ROOT:-/etc/phub/timeweb-beta}
STATE=${LK2_BETA_LANE_STATE:-/opt/phub/timeweb-beta/beta-lane}
COMPOSE_FILE=$(cd "$(dirname "$0")" && pwd)/compose.beta.yaml
APP_SERVICES=(api realtime web worker)
IMAGES=(api realtime web worker migrator)
KEEP_BACKUPS=3

log() { printf '[lk2-beta] %s\n' "$*"; }
die() { printf '[lk2-beta] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || die "run as root"
[[ -f $COMPOSE_FILE ]] || die "compose.beta.yaml must sit next to this script"
DOCKER_BIN=$(command -v docker) || die "docker is required"
command -v python3 >/dev/null || die "python3 is required"
mkdir -p "$STATE/releases" "$STATE/backups"
chmod 700 "$STATE"

exec 9>"$STATE/.lock"
flock -n 9 || die "another lk2-beta-lane operation is running"

TMP=$(mktemp -d "$STATE/.tmp.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# Compose with no ambient COMPOSE_* or DOCKER_* overrides; interpolation only from the env file.
compose() {
  local env_file=$1; shift
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    "$DOCKER_BIN" compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$env_file" --profile background "$@"
}

container() { printf '%s-%s-1' "$PROJECT" "$1"; }
container_exists() { docker inspect "$(container "$1")" >/dev/null 2>&1; }
container_running() {
  [[ $(docker inspect -f '{{.State.Running}}' "$(container "$1")" 2>/dev/null || echo false) == true ]]
}
container_image() { docker inspect -f '{{.Config.Image}}' "$(container "$1")" 2>/dev/null || true; }
digest_of() { # "<registry>/phub-api@sha256:..." -> "sha256:..."
  [[ $1 =~ @(sha256:[0-9a-f]{64})$ ]] && printf '%s' "${BASH_REMATCH[1]}"
}

postgres_container() {
  docker ps -q --filter "network=$NETWORK" | while read -r id; do
    ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$id")
    [[ $ip == "$POSTGRES_IP" ]] && { docker inspect -f '{{.Name}}' "$id" | sed 's#^/##'; break; }
  done
}

# Reads the superuser name/password from the operator PostgreSQL container. Never printed.
superuser_env() {
  local pg=$1 user password password_file
  user=$(docker exec "$pg" printenv POSTGRES_USER 2>/dev/null || true)
  password=$(docker exec "$pg" printenv POSTGRES_PASSWORD 2>/dev/null || true)
  if [[ -z $password ]]; then
    password_file=$(docker exec "$pg" printenv POSTGRES_PASSWORD_FILE 2>/dev/null || true)
    [[ -n $password_file ]] && password=$(docker exec "$pg" cat "$password_file")
  fi
  [[ -n $user && -n $password ]] || die "cannot read the PostgreSQL superuser from $pg"
  local encoded
  encoded=$(printf '%s' "$password" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')
  {
    printf 'DATABASE_URL=postgresql://%s:%s@%s:5432/%s\n' "$user" "$encoded" "$POSTGRES_IP" "$DATABASE"
    printf 'MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS=10000\n'
    printf 'CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1\n'
  } > "$TMP/migrator.env"
  printf '%s' "$user" > "$TMP/superuser"
}

require_sha() {
  [[ ${1:-} =~ ^[0-9a-f]{40}$ ]] || die "usage: $0 $2 <full 40-character main commit sha>"
}

pull_images() { # sha -> writes $TMP/<image>.ref with the immutable digest reference
  local sha=$1 image ref
  for image in "${IMAGES[@]}"; do
    docker pull --quiet "$REGISTRY/phub-$image:$sha" >/dev/null ||
      die "cannot pull $REGISTRY/phub-$image:$sha (is it a green main SHA built by 'Test stand'? docker login ghcr.io?)"
    ref=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$REGISTRY/phub-$image:$sha" |
      grep -E "^$REGISTRY/phub-$image@sha256:[0-9a-f]{64}$" | head -1)
    [[ -n $ref ]] || die "no registry digest for phub-$image:$sha"
    printf '%s' "$ref" > "$TMP/$image.ref"
  done
}

fcm_source() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/phub/fcm-service-account.json"}}{{.Source}}{{end}}{{end}}' \
    "$(container worker)" 2>/dev/null || true
}

# Release env for compose.beta.yaml: digests and paths only, no credential values.
write_release_env() { # out release_id api realtime web worker migrator (digests)
  local out=$1 fcm
  fcm=$(fcm_source)
  {
    printf 'PHUB_RELEASE_ID=%s\n' "$2"
    printf 'TIMEWEB_RUNTIME_ENV_ROOT=%s\n' "$ENV_ROOT"
    printf 'TIMEWEB_FCM_CREDENTIAL_SOURCE=%s\n' "${fcm:-/dev/null}"
    printf 'API_IMAGE_DIGEST=%s\nREALTIME_IMAGE_DIGEST=%s\nWEB_IMAGE_DIGEST=%s\n' "$3" "$4" "$5"
    printf 'WORKER_IMAGE_DIGEST=%s\nMIGRATOR_IMAGE_DIGEST=%s\n' "$6" "$7"
  } > "$out"
}

# Captures the running application images once, before the first lane promotion.
capture_baseline() {
  [[ -f $STATE/releases/baseline.env ]] && return
  local svc ref digests=()
  for svc in api realtime web worker; do
    ref=$(container_image "$svc")
    if [[ -z $ref ]]; then digests+=(none); continue; fi
    [[ -n $(digest_of "$ref") ]] || die "running $svc image is not pinned by digest: $ref"
    digests+=("$(digest_of "$ref")")
  done
  write_release_env "$STATE/releases/baseline.env" baseline "${digests[@]}" none
  : > "$STATE/releases/baseline.services"
  for svc in "${APP_SERVICES[@]}"; do container_running "$svc" && echo "$svc" >> "$STATE/releases/baseline.services"; done
  log "baseline recorded: $(tr '\n' ' ' < "$STATE/releases/baseline.services")"
}

# Services to run: everything that runs now, plus api/realtime/web always.
target_services() {
  local svc
  for svc in "${APP_SERVICES[@]}"; do
    if [[ $svc != worker ]] || container_running worker || grep -qx worker "$STATE/releases/baseline.services" 2>/dev/null; then
      echo "$svc"
    fi
  done
}

start_services() { # env_file services...
  local env_file=$1 svc; shift
  for svc in "$@"; do
    grep -q "^$(echo "$svc" | tr a-z A-Z)_IMAGE_DIGEST=sha256:" "$env_file" || { log "  skip $svc (no image recorded)"; continue; }
    log "  up $svc"
    compose "$env_file" up -d --no-deps --pull never --wait --wait-timeout 180 "$svc" || return 1
  done
}

smoke() {
  local attempt path code ok
  for attempt in $(seq 1 12); do
    ok=1
    for path in /health/ready /realtime/health/ready /; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_ORIGIN$path" || true)
      [[ $code == 200 ]] || { ok=0; log "  smoke $attempt: $path -> $code"; }
    done
    [[ $ok == 1 ]] && { log "  smoke ok"; return 0; }
    sleep 5
  done
  return 1
}

verify_running() { # env_file services...
  local env_file=$1 svc want got; shift
  for svc in "$@"; do
    want=$(grep "^$(echo "$svc" | tr a-z A-Z)_IMAGE_DIGEST=" "$env_file" | cut -d= -f2)
    [[ $want == none ]] && continue
    got=$(digest_of "$(container_image "$svc")")
    [[ $got == "$want" ]] || { log "  $svc runs $got, expected $want"; return 1; }
  done
}

ledger() {
  local pg=$1
  docker exec "$pg" psql -U "$(cat "$TMP/superuser")" -d "$DATABASE" -tAc \
    "select count(*) || ' applied, last ' || coalesce(max(filename), '-') from public.schema_migrations"
}

run_migrator() { # mode-argument
  docker run --rm --network "$NETWORK" --env-file "$TMP/migrator.env" \
    "$(cat "$TMP/migrator.ref")" node apps/migrator/dist/main.js "$1"
}

backup() {
  local pg=$1 sha=$2 size free file
  size=$(docker exec "$pg" psql -U "$(cat "$TMP/superuser")" -d "$DATABASE" -tAc "select pg_database_size('$DATABASE')")
  free=$(( $(df -Pk "$STATE/backups" | awk 'NR==2{print $4}') * 1024 ))
  (( free > 2 * size )) || die "backup needs > 2x database size free ($size bytes db, $free bytes free)"
  file="$STATE/backups/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}.dump"
  log "backup -> $file"
  docker exec "$pg" pg_dump -U "$(cat "$TMP/superuser")" -d "$DATABASE" -Fc > "$file.partial"
  docker exec -i "$pg" pg_restore -l < "$file.partial" > /dev/null || die "backup is not a readable archive"
  mv "$file.partial" "$file"
  ls -1t "$STATE"/backups/*.dump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
}

rollback_to() { # env_file
  local env_file=$1 services
  services=(); while read -r svc; do services+=("$svc"); done < <(target_services)
  log "rolling application back to $(grep '^PHUB_RELEASE_ID=' "$env_file" | cut -d= -f2) (migrations stay applied)"
  start_services "$env_file" "${services[@]}" && verify_running "$env_file" "${services[@]}" && smoke
}

cmd=${1:-}
case $cmd in
  status)
    for svc in "${APP_SERVICES[@]}"; do
      printf '%-9s %-8s %s\n' "$svc" "$(container_running "$svc" && echo running || echo stopped)" "$(container_image "$svc")"
    done
    log "current: $(cat "$STATE/current" 2>/dev/null || echo none)"
    log "history (newest last):"; tail -5 "$STATE/history" 2>/dev/null || true
    ;;

  plan)
    require_sha "${2:-}" plan; sha=$2
    pg=$(postgres_container); [[ -n $pg ]] || die "no PostgreSQL container at $POSTGRES_IP on $NETWORK"
    [[ -f $ENV_ROOT/api.env ]] || die "runtime env root $ENV_ROOT has no api.env"
    superuser_env "$pg"
    log "pulling images for $sha"; pull_images "$sha"
    for image in "${IMAGES[@]}"; do log "  $image $(cat "$TMP/$image.ref")"; done
    log "ledger: $(ledger "$pg")"
    run_migrator --lk2-beta-lane-plan
    log "running now:"; for svc in "${APP_SERVICES[@]}"; do log "  $svc $(container_running "$svc" && echo running || echo stopped) $(container_image "$svc")"; done
    log "will run after promote: $(target_services | tr '\n' ' ')"
    log "PLAN ONLY: no database, container or file change was made (images were pulled)"
    ;;

  promote)
    require_sha "${2:-}" promote; sha=$2
    pg=$(postgres_container); [[ -n $pg ]] || die "no PostgreSQL container at $POSTGRES_IP on $NETWORK"
    [[ -f $ENV_ROOT/api.env ]] || die "runtime env root $ENV_ROOT has no api.env"
    superuser_env "$pg"
    log "promoting $sha to $PUBLIC_ORIGIN"
    pull_images "$sha"
    capture_baseline
    previous=$STATE/releases/$(cat "$STATE/current" 2>/dev/null || echo baseline).env
    [[ -f $previous ]] || previous=$STATE/releases/baseline.env
    services=(); while read -r svc; do services+=("$svc"); done < <(target_services)
    release=$STATE/releases/$sha.env
    write_release_env "$release" "lk2-beta-${sha:0:12}" \
      "$(digest_of "$(cat "$TMP/api.ref")")" "$(digest_of "$(cat "$TMP/realtime.ref")")" \
      "$(digest_of "$(cat "$TMP/web.ref")")" "$(digest_of "$(cat "$TMP/worker.ref")")" \
      "$(digest_of "$(cat "$TMP/migrator.ref")")"

    log "ledger before: $(ledger "$pg")"
    backup "$pg" "$sha"
    worker_was_running=false
    if container_running worker; then worker_was_running=true; log "stopping worker for the migration"; docker stop -t 60 "$(container worker)" >/dev/null; fi
    log "migrating"
    if ! run_migrator --lk2-beta-lane; then
      log "migration failed; committed files stay applied, the failed file was rolled back"
      [[ $worker_was_running == true ]] && docker start "$(container worker)" >/dev/null
      log "ledger now: $(ledger "$pg")"
      die "promotion of $sha stopped before any application change; fix forward and rerun promote"
    fi
    log "ledger after: $(ledger "$pg")"

    log "starting application $sha"
    if start_services "$release" "${services[@]}" && verify_running "$release" "${services[@]}" && smoke; then
      echo "$sha" > "$STATE/current"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $sha" >> "$STATE/history"
      log "OK: $sha is live at $PUBLIC_ORIGIN"
    else
      log "promotion failed; recent api logs:"; docker logs --tail 40 "$(container api)" 2>&1 | tail -40 || true
      rollback_to "$previous" || die "ROLLBACK ALSO FAILED: inspect the host now"
      die "promotion of $sha failed; application restored to $(basename "$previous" .env), schema stays at the new ledger"
    fi
    ;;

  rollback)
    # history is a stack of successful promotions; the top is what runs now.
    current=$(cat "$STATE/current" 2>/dev/null || true)
    [[ -n $current && $current != baseline ]] || die "nothing to roll back: no lane release is current"
    [[ $(tail -1 "$STATE/history" 2>/dev/null | awk '{print $2}') == "$current" ]] ||
      die "history top does not match current $current; inspect $STATE"
    target=$(tail -2 "$STATE/history" | sed '$d' | awk '{print $2}')
    target=${target:-baseline}
    env_file=$STATE/releases/$target.env
    [[ -f $env_file ]] || die "no release env for $target"
    if rollback_to "$env_file"; then
      sed -i.bak '$d' "$STATE/history" && rm -f "$STATE/history.bak"
      echo "$target" > "$STATE/current"
      log "OK: rolled back to $target"
    else
      die "rollback failed: inspect the host"
    fi
    ;;

  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
