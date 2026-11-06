#!/usr/bin/env bash
# LK2 disposable beta lane: promote one green main commit to lk2.padlhub.su.
# Run as root on the lk2 host. See docs/runbooks/lk2-beta-lane.md.
#
#   lk2-beta-lane.sh plan <sha>       pull the five images, record their digests, show pending migrations
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

canonical() { printf '%s-%s-1' "$PROJECT" "$1"; }
# The one running application container of a service on the beta network, whatever its Compose
# project (lk2 may still run the legacy phub-timeweb-beta-apps project). Two is ambiguous: stop.
live_id() {
  local ids
  ids=$(docker ps -q --filter "network=$NETWORK" --filter "label=com.docker.compose.service=$1")
  [[ $(printf '%s' "$ids" | grep -c .) -le 1 ]] || die "more than one running $1 container on $NETWORK"
  printf '%s' "$ids"
}
container_running() { [[ -n $(live_id "$1") ]]; }
container_image() { local id; id=$(live_id "$1"); [[ -n $id ]] && docker inspect -f '{{.Config.Image}}' "$id" || true; }
container_project() { local id; id=$(live_id "$1"); [[ -n $id ]] && docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id" || true; }
digest_of() { # "<registry>/phub-api@sha256:..." -> "sha256:..."
  [[ ${1:-} =~ @(sha256:[0-9a-f]{64})$ ]] && printf '%s' "${BASH_REMATCH[1]}"
}

postgres_container() {
  local id ip
  for id in $(docker ps -q --filter "network=$NETWORK"); do
    ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$id")
    if [[ $ip == "$POSTGRES_IP" ]]; then docker inspect -f '{{.Name}}' "$id" | sed 's#^/##'; return 0; fi
  done
  return 0
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
    # Only relevant while 0069-0073 are pending; on lk2 they are applied, so this is a no-op.
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
      grep -E "^$REGISTRY/phub-$image@sha256:[0-9a-f]{64}$" | head -1 || true)
    [[ -n $ref ]] || die "no registry digest for phub-$image:$sha"
    printf '%s' "$ref" > "$TMP/$image.ref"
  done
}

require_env_root() {
  local svc
  for svc in api realtime worker; do
    [[ -f $ENV_ROOT/$svc.env ]] || die "runtime env root $ENV_ROOT has no $svc.env"
  done
}

fcm_source() {
  local id
  id=$(live_id worker)
  [[ -n $id ]] || { [[ -f $STATE/releases/fcm-source ]] && cat "$STATE/releases/fcm-source"; return 0; }
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/phub/fcm-service-account.json"}}{{.Source}}{{end}}{{end}}' "$id"
}

# Release env for compose.beta.yaml: digests and paths only, no credential values.
write_release_env() { # out release_id api realtime web worker migrator (digests)
  local out=$1 fcm
  fcm=$(cat "$STATE/releases/fcm-source" 2>/dev/null || true)
  {
    printf 'PHUB_RELEASE_ID=%s\n' "$2"
    printf 'TIMEWEB_RUNTIME_ENV_ROOT=%s\n' "$ENV_ROOT"
    printf 'TIMEWEB_FCM_CREDENTIAL_SOURCE=%s\n' "${fcm:-/dev/null}"
    # compose.beta.yaml requires every digest variable to be non-empty (`:?`), even for a service
    # that is not started; `none` keeps interpolation valid and start_services skips it.
    printf 'API_IMAGE_DIGEST=%s\nREALTIME_IMAGE_DIGEST=%s\nWEB_IMAGE_DIGEST=%s\n' "${3:-none}" "${4:-none}" "${5:-none}"
    printf 'WORKER_IMAGE_DIGEST=%s\nMIGRATOR_IMAGE_DIGEST=%s\n' "${6:-none}" "${7:-none}"
  } > "$out"
}

describe_live() {
  local svc
  for svc in "${APP_SERVICES[@]}"; do
    if container_running "$svc"; then
      log "  $svc running project=$(container_project "$svc") $(container_image "$svc")"
    else
      log "  $svc not running"
    fi
  done
}

# Refuses unless api/realtime/web each run exactly once, pinned by digest. A legacy Compose
# project needs an explicit TIMEWEB_RUNTIME_ENV_ROOT, because its env root cannot be read back.
check_live() {
  local svc legacy=false
  for svc in api realtime web; do
    container_running "$svc" || die "no running $svc container on $NETWORK"
    [[ -n $(digest_of "$(container_image "$svc")") ]] || die "running $svc image is not pinned by digest"
    [[ $(container_project "$svc") == "$PROJECT" ]] || legacy=true
  done
  if [[ $legacy == true && ! -f $STATE/releases/baseline.services && -z ${TIMEWEB_RUNTIME_ENV_ROOT:-} ]]; then
    die "lk2 runs a non-canonical Compose project; set TIMEWEB_RUNTIME_ENV_ROOT to the env root those containers use"
  fi
}

# Captures the running application containers once, before the first lane promotion. Lines:
# "<service> <container id> <compose project> <image digest>".
capture_baseline() {
  [[ -f $STATE/releases/baseline.services ]] && return
  local svc id
  fcm_source > "$STATE/releases/fcm-source" || true
  : > "$TMP/baseline.services"
  for svc in "${APP_SERVICES[@]}"; do
    id=$(live_id "$svc"); [[ -n $id ]] || continue
    printf '%s %s %s %s\n' "$svc" "$id" "$(container_project "$svc")" "$(digest_of "$(container_image "$svc")")" >> "$TMP/baseline.services"
  done
  mv "$TMP/baseline.services" "$STATE/releases/baseline.services"
  log "baseline recorded:"; sed 's/^/[lk2-beta]   /' "$STATE/releases/baseline.services"
}

baseline_field() { awk -v s="$1" -v f="$2" '$1 == s {print $f}' "$STATE/releases/baseline.services"; }

# Services to run: api/realtime/web always, worker when it runs now or ran in the baseline.
target_services() {
  local svc
  for svc in "${APP_SERVICES[@]}"; do
    if [[ $svc != worker ]] || container_running worker || [[ -n $(baseline_field worker 1 2>/dev/null) ]]; then
      echo "$svc"
    fi
  done
}

wait_healthy() { # container id
  local health
  for _ in $(seq 1 36); do
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing)
    [[ $health == healthy || $health == running ]] && return 0
    sleep 5
  done
  return 1
}

start_services() { # env_file services...
  local env_file=$1 svc id; shift
  for svc in "$@"; do
    grep -q "^$(echo "$svc" | tr a-z A-Z)_IMAGE_DIGEST=sha256:" "$env_file" || { log "  skip $svc (no image recorded)"; continue; }
    # Hand the service name and address over from a legacy-project container: stop, never remove.
    id=$(live_id "$svc")
    if [[ -n $id && $(container_project "$svc") != "$PROJECT" ]]; then
      log "  stop legacy $svc $id"; docker stop -t 30 "$id" >/dev/null || return 1
    fi
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
    [[ $want == sha256:* ]] || continue
    got=$(digest_of "$(container_image "$svc")")
    [[ $got == "$want" ]] || { log "  $svc runs ${got:-nothing}, expected $want"; return 1; }
  done
}

ledger() {
  local pg=$1
  docker exec "$pg" psql -U "$(cat "$TMP/superuser")" -d "$DATABASE" -tAc \
    "select count(*) || ' applied, last ' || coalesce(max(filename), '-') from public.schema_migrations" || true
}

run_migrator() { # mode-argument
  docker run --rm --network "$NETWORK" --env-file "$TMP/migrator.env" \
    "$(cat "$TMP/migrator.ref")" node apps/migrator/dist/main.js "$1"
}

backup() {
  local pg=$1 sha=$2 size free file
  size=$(docker exec "$pg" psql -U "$(cat "$TMP/superuser")" -d "$DATABASE" -tAc "select pg_database_size('$DATABASE')")
  [[ $size =~ ^[0-9]+$ ]] || die "cannot read the database size"
  free=$(( $(df -Pk "$STATE/backups" | awk 'NR==2{print $4}') * 1024 ))
  # Capacity is a provisioning property (AGENTS.md), not a per-release gate: warn only. A dump
  # that does not fit fails below and stops the promotion before any migration.
  (( free > 2 * size )) || log "WARNING: less than 2x database size free for backups ($size bytes db, $free bytes free); provision more disk"
  file="$STATE/backups/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}.dump"
  log "backup -> $file"
  if ! docker exec "$pg" pg_dump -U "$(cat "$TMP/superuser")" -d "$DATABASE" -Fc > "$file.partial" ||
     ! docker exec -i "$pg" pg_restore -l < "$file.partial" > /dev/null; then
    rm -f "$file.partial"; die "backup failed"
  fi
  mv "$file.partial" "$file"
  ls -1t "$STATE"/backups/*.dump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
}

rollback_to_baseline() {
  local svc id project digest services env_file=$TMP/baseline.env
  log "rolling application back to the baseline containers (migrations stay applied)"
  services=(); while read -r svc; do services+=("$svc"); done < <(awk '{print $1}' "$STATE/releases/baseline.services")
  write_release_env "$env_file" baseline \
    "$(baseline_field api 4)" "$(baseline_field realtime 4)" "$(baseline_field web 4)" \
    "$(baseline_field worker 4)" none
  for svc in "${APP_SERVICES[@]}"; do
    project=$(baseline_field "$svc" 3)
    if [[ -z $project ]]; then
      # Not running before the lane: stop what the lane started.
      docker stop -t 30 "$(canonical "$svc")" >/dev/null 2>&1 || true
    elif [[ $project == "$PROJECT" ]]; then
      log "  up $svc (baseline image)"
      compose "$env_file" up -d --no-deps --pull never --wait --wait-timeout 180 "$svc" || return 1
    else
      id=$(baseline_field "$svc" 2)
      log "  restore legacy $svc $id"
      docker rm -f "$(canonical "$svc")" >/dev/null 2>&1 || true
      docker start "$id" >/dev/null || return 1
      wait_healthy "$id" || return 1
    fi
  done
  for svc in "${services[@]}"; do
    digest=$(baseline_field "$svc" 4)
    [[ $(digest_of "$(container_image "$svc")") == "$digest" ]] || { log "  $svc does not run its baseline image"; return 1; }
  done
  smoke
}

rollback_to() { # release name (a lane SHA or baseline)
  [[ $1 == baseline ]] && { rollback_to_baseline; return; }
  local env_file=$STATE/releases/$1.env services
  [[ -f $env_file ]] || { log "no release env for $1"; return 1; }
  services=(); while read -r svc; do services+=("$svc"); done < <(target_services)
  log "rolling application back to $1 (migrations stay applied)"
  start_services "$env_file" "${services[@]}" && verify_running "$env_file" "${services[@]}" && smoke
}

cmd=${1:-}
case $cmd in
  status)
    describe_live
    log "current: $(cat "$STATE/current" 2>/dev/null || echo none)"
    log "history (newest last):"; tail -5 "$STATE/history" 2>/dev/null || true
    ;;

  plan)
    require_sha "${2:-}" plan; sha=$2
    pg=$(postgres_container); [[ -n $pg ]] || die "no PostgreSQL container at $POSTGRES_IP on $NETWORK"
    log "running now:"; describe_live
    check_live
    require_env_root
    superuser_env "$pg"
    log "pulling images for $sha"; pull_images "$sha"
    mkdir -p "$STATE/plans"
    for image in "${IMAGES[@]}"; do log "  $image $(cat "$TMP/$image.ref")"; cat "$TMP/$image.ref"; echo; done > "$TMP/plan.out"
    grep '^\[lk2-beta\]' "$TMP/plan.out" || true
    grep -v '^\[lk2-beta\]' "$TMP/plan.out" | grep . > "$STATE/plans/$sha"
    log "ledger: $(ledger "$pg")"
    run_migrator --lk2-beta-lane-plan
    log "env root: $ENV_ROOT; will run after promote: $(target_services | tr '\n' ' ')"
    log "PLAN ONLY: no database or container change was made (images pulled, digests recorded for promote)"
    ;;

  promote)
    require_sha "${2:-}" promote; sha=$2
    [[ -f $STATE/plans/$sha ]] || die "run '$0 plan $sha' first and review it"
    pg=$(postgres_container); [[ -n $pg ]] || die "no PostgreSQL container at $POSTGRES_IP on $NETWORK"
    check_live
    require_env_root
    superuser_env "$pg"
    log "promoting $sha to $PUBLIC_ORIGIN"
    pull_images "$sha"
    for image in "${IMAGES[@]}"; do cat "$TMP/$image.ref"; echo; done | diff -q - "$STATE/plans/$sha" >/dev/null ||
      die "image digests for $sha changed since plan; rerun plan"
    capture_baseline
    previous=$(cat "$STATE/current" 2>/dev/null || echo baseline)
    services=(); while read -r svc; do services+=("$svc"); done < <(target_services)
    release=$STATE/releases/$sha.env
    write_release_env "$release" "lk2-beta-${sha:0:12}" \
      "$(digest_of "$(cat "$TMP/api.ref")")" "$(digest_of "$(cat "$TMP/realtime.ref")")" \
      "$(digest_of "$(cat "$TMP/web.ref")")" "$(digest_of "$(cat "$TMP/worker.ref")")" \
      "$(digest_of "$(cat "$TMP/migrator.ref")")"

    log "ledger before: $(ledger "$pg")"
    backup "$pg" "$sha"
    worker_id=$(live_id worker)
    if [[ -n $worker_id ]]; then log "stopping worker for the migration"; docker stop -t 60 "$worker_id" >/dev/null; fi
    log "migrating"
    if ! run_migrator --lk2-beta-lane; then
      log "migration failed; committed files stay applied, the failed file was rolled back"
      [[ -n $worker_id ]] && docker start "$worker_id" >/dev/null
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
      log "promotion failed; recent api logs:"; docker logs --tail 40 "$(canonical api)" 2>&1 | tail -40 || true
      rollback_to "$previous" || die "ROLLBACK ALSO FAILED: inspect the host now"
      die "promotion of $sha failed; application restored to $previous, schema stays at the new ledger"
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
    if rollback_to "$target"; then
      sed -i.bak '$d' "$STATE/history" && rm -f "$STATE/history.bak"
      echo "$target" > "$STATE/current"
      log "OK: rolled back to $target"
    else
      die "rollback failed: inspect the host"
    fi
    ;;

  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
