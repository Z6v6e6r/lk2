#!/usr/bin/env sh
set -eu

usage() {
  echo "usage: $0 blue|green" >&2
  exit 64
}

if [ "$#" -ne 1 ]; then
  usage
fi

role="$1"
case "$role" in
  blue | green) ;;
  *) usage ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 69
}

echo "PHUB_STAGING_HOST_INVENTORY_V1|role=$role|read_only=true|secrets=false|database_access=false"
echo "HOST"
printf 'role=%s\n' "$role"
printf 'hostname=%s\n' "$(hostname)"
printf 'architecture=%s\n' "$(uname -m)"
sed -n 's/^PRETTY_NAME=/os=/p' /etc/os-release
uptime
df -h /
free -h

echo "DOCKER"
docker version --format 'server={{.Server.Version}}'
docker compose version
docker ps -a --format 'container={{.Names}}|image={{.Image}}|status={{.Status}}|ports={{.Ports}}'

echo "RUNTIME_MAPPING"
for container_id in $(docker ps -aq); do
  docker inspect --format 'container={{.Name}}|config_image={{.Config.Image}}|image_id={{.Image}}|platform={{.Platform}}|restart={{.HostConfig.RestartPolicy.Name}}|health={{with .State.Health}}{{.Status}}{{else}}none{{end}}|networks={{range $name, $_ := .NetworkSettings.Networks}}{{$name}},{{end}}' "$container_id"
done

echo "VOLUMES"
docker volume ls --format 'volume={{.Name}}'
docker system df -v

echo "MOUNTS"
for container_id in $(docker ps -aq); do
  docker inspect --format '{{.Name}}|{{range .Mounts}}type={{.Type}}:name={{.Name}}:source={{.Source}}:destination={{.Destination}}:rw={{.RW}};{{end}}' "$container_id"
done

echo "NETWORKS"
docker network ls --format 'network={{.Name}}|driver={{.Driver}}|scope={{.Scope}}'

echo "PATH_METADATA"
for path in /opt/phub /etc/phub /var/lib/phub-preflight; do
  if [ -e "$path" ]; then
    stat -c 'path=%n|type=%F|uid=%u|gid=%g|mode=%a|size=%s' "$path"
  else
    printf 'path=%s|status=absent\n' "$path"
  fi
done

release_file=/opt/phub/release.env
if [ -f "$release_file" ]; then
  if [ -L "$release_file" ]; then
    echo "release metadata must not be a symlink" >&2
    exit 65
  fi
  echo "RELEASE_METADATA"
  release_metadata="$(sed -n -E '/^(REGISTRY|RELEASE|LATEST_MIGRATION|S3_PUBLIC_ENDPOINT|(WEB|API|WORKER|REALTIME|MIGRATOR)_IMAGE_DIGEST)=/p' "$release_file")"
  for key in REGISTRY RELEASE LATEST_MIGRATION S3_PUBLIC_ENDPOINT WEB_IMAGE_DIGEST API_IMAGE_DIGEST WORKER_IMAGE_DIGEST REALTIME_IMAGE_DIGEST MIGRATOR_IMAGE_DIGEST; do
    count="$(printf '%s\n' "$release_metadata" | grep -c "^$key=")"
    if [ "$count" -ne 1 ]; then
      echo "release metadata must contain exactly one $key" >&2
      exit 65
    fi
  done
  for key in WEB_IMAGE_DIGEST API_IMAGE_DIGEST WORKER_IMAGE_DIGEST REALTIME_IMAGE_DIGEST MIGRATOR_IMAGE_DIGEST; do
    printf '%s\n' "$release_metadata" | grep -E "^$key=sha256:[0-9a-f]{64}$" >/dev/null || {
      echo "release metadata contains malformed $key" >&2
      exit 65
    }
  done
  registry="$(printf '%s\n' "$release_metadata" | sed -n 's/^REGISTRY=//p')"
  printf '%s' "$registry" | grep -E '^[a-z0-9.-]+(/[A-Za-z0-9._-]+)*$' >/dev/null || {
    echo "REGISTRY must not contain credentials, a port, query or fragment" >&2
    exit 65
  }
  s3_public_endpoint="$(printf '%s\n' "$release_metadata" | sed -n 's/^S3_PUBLIC_ENDPOINT=//p')"
  printf '%s' "$s3_public_endpoint" | grep -E '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&()*+,;=:@%/-]*)?$' >/dev/null || {
    echo "S3_PUBLIC_ENDPOINT must be HTTPS without credentials, query or fragment" >&2
    exit 65
  }
  release="$(printf '%s\n' "$release_metadata" | sed -n 's/^RELEASE=//p')"
  printf '%s' "$release" | grep -E '^[0-9a-f]{40}$' >/dev/null || {
    echo "RELEASE must be an exact 40-character SHA" >&2
    exit 65
  }
  latest_migration="$(printf '%s\n' "$release_metadata" | sed -n 's/^LATEST_MIGRATION=//p')"
  printf '%s' "$latest_migration" | grep -E '^[0-9]{4}_[A-Za-z0-9._-]+\.sql$' >/dev/null || {
    echo "LATEST_MIGRATION must be a safe SQL basename" >&2
    exit 65
  }
  printf 'REGISTRY_HOST=%s\n' "${registry%%/*}"
  printf 'S3_PUBLIC_ORIGIN=%s\n' "$(printf '%s' "$s3_public_endpoint" | sed -E 's#^(https://[^/]+).*$#\1#')"
  printf 'RELEASE=%s\n' "$release"
  printf 'LATEST_MIGRATION=%s\n' "$latest_migration"
  printf '%s\n' "$release_metadata" | sed -n -E '/^(WEB|API|WORKER|REALTIME|MIGRATOR)_IMAGE_DIGEST=/p'
else
  echo "RELEASE_METADATA|status=absent"
fi

echo "PHUB_STAGING_HOST_INVENTORY_PASSED|role=$role|read_only=true|secrets=false|database_access=false"
