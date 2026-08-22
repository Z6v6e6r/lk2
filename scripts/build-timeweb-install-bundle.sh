#!/bin/sh
set -eu
PATH=/usr/bin:/bin
IFS=$(printf ' \t\n_')
IFS=${IFS%_}
LANG=C
LC_ALL=C
GIT_NO_REPLACE_OBJECTS=1
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
export PATH IFS LANG LC_ALL GIT_NO_REPLACE_OBJECTS GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL
unset CDPATH ENV BASH_ENV \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR GIT_NAMESPACE GIT_CEILING_DIRECTORIES GIT_ATTR_SOURCE

if [ -x /usr/bin/sha256sum ]; then
  sha256_file() { /usr/bin/sha256sum "$1" | awk '{ print $1 }'; }
elif [ -x /usr/bin/shasum ]; then
  sha256_file() { /usr/bin/shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  echo 'TIMEWEB_BUNDLE_BUILD_FAILED|reason=sha256_tool_absent' >&2
  exit 1
fi

fail() {
  echo "TIMEWEB_BUNDLE_BUILD_FAILED|reason=$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail usage
ops_sha=$1
output_directory=$2
printf '%s' "$ops_sha" | grep -Eq '^[0-9a-f]{40}$' || fail invalid_ops_sha
[ -d "$output_directory" ] && [ ! -L "$output_directory" ] || fail invalid_output_directory
output_directory=$(cd "$output_directory" && pwd -P) || fail output_directory_resolution

repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail repository_absent
git -C "$repository_root" cat-file -e "$ops_sha^{commit}" 2>/dev/null || fail commit_absent

task_tmp_root=${TMPDIR:-/tmp}
work_directory=$(mktemp -d "$task_tmp_root/phub-timeweb-bundle.XXXXXX") || fail temporary_directory
cleanup() {
  case "$work_directory" in
    "$task_tmp_root"/phub-timeweb-bundle.*)
      [ ! -L "$work_directory" ] && [ -d "$work_directory" ] && rm -rf -- "$work_directory"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

script_directory=$(cd "$(dirname "$0")" && pwd -P) || fail builder_path
script_path=$script_directory/$(basename "$0")
[ -f "$script_path" ] && [ ! -L "$script_path" ] || fail builder_path
committed_builder=$work_directory/committed-builder.sh
git -C "$repository_root" show "$ops_sha:scripts/build-timeweb-install-bundle.sh" \
  > "$committed_builder" || fail committed_builder_absent
cmp -s "$script_path" "$committed_builder" || fail dirty_builder

manifest_path=$work_directory/install-manifest.txt
git -C "$repository_root" show "$ops_sha:deploy/timeweb/install-manifest.txt" > "$manifest_path" ||
  fail install_manifest_absent
[ -s "$manifest_path" ] || fail install_manifest_empty

set --
while IFS= read -r entry || [ -n "$entry" ]; do
  printf '%s' "$entry" | grep -Eq '^[A-Za-z0-9._/-]+$' || fail invalid_manifest_entry
  case "$entry" in
    /*|*../*|../*|*/..|..|'') fail invalid_manifest_entry ;;
  esac
  git -C "$repository_root" cat-file -e "$ops_sha:$entry" 2>/dev/null || fail manifest_entry_absent
  set -- "$@" "$entry"
done < "$manifest_path"
[ "$#" -gt 0 ] || fail install_manifest_empty

application_candidate_path=$work_directory/application-candidate.env
git -C "$repository_root" show "$ops_sha:deploy/timeweb/application-candidate.env" \
  > "$application_candidate_path" || fail application_candidate_absent
[ "$(grep -Ec '^PHUB_APPLICATION_SHA=' "$application_candidate_path")" -eq 1 ] ||
  fail application_candidate_shape
[ "$(wc -l < "$application_candidate_path" | tr -d ' ')" = 1 ] ||
  fail application_candidate_shape
application_sha=$(sed -n 's/^PHUB_APPLICATION_SHA=//p' "$application_candidate_path")
printf '%s' "$application_sha" | grep -Eq '^[0-9a-f]{40}$' || fail application_candidate_sha
git -C "$repository_root" cat-file -e "$application_sha^{commit}" 2>/dev/null ||
  fail application_candidate_commit_absent

expanded_paths=$work_directory/expanded-paths.txt
git -C "$repository_root" ls-tree -r --name-only "$ops_sha" -- "$@" | LC_ALL=C sort -u > "$expanded_paths"
[ -s "$expanded_paths" ] || fail expanded_manifest_empty
contracts_paths=$work_directory/contracts-paths.txt
git -C "$repository_root" ls-tree -r --name-only "$application_sha" -- contracts/openapi | \
  LC_ALL=C sort -u > "$contracts_paths"
[ -s "$contracts_paths" ] || fail application_contracts_absent

files_manifest=$work_directory/files.sha256
: > "$files_manifest"
blob_path=$work_directory/blob
while IFS= read -r path || [ -n "$path" ]; do
  printf '%s' "$path" | grep -Eq '^[A-Za-z0-9._/-]+$' || fail invalid_expanded_path
  mode=$(git -C "$repository_root" ls-tree "$ops_sha" -- "$path" | awk 'NR == 1 { print $1 }')
  case "$mode" in 100644|100755) ;; *) fail unsupported_git_mode ;; esac
  git -C "$repository_root" show "$ops_sha:$path" > "$blob_path" || fail blob_read
  checksum=$(sha256_file "$blob_path")
  case "$mode" in
    100644) install_mode=0644 ;;
    100755) install_mode=0755 ;;
  esac
  printf '%s|%s|%s|%s\n' "$install_mode" "$checksum" "$ops_sha" "$path" >> "$files_manifest"
done < "$expanded_paths"

while IFS= read -r path || [ -n "$path" ]; do
  printf '%s' "$path" | grep -Eq '^contracts/openapi/[A-Za-z0-9._/-]+$' ||
    fail invalid_contract_path
  mode=$(git -C "$repository_root" ls-tree "$application_sha" -- "$path" | awk 'NR == 1 { print $1 }')
  case "$mode" in 100644|100755) ;; *) fail unsupported_contract_git_mode ;; esac
  git -C "$repository_root" show "$application_sha:$path" > "$blob_path" || fail contract_blob_read
  checksum=$(sha256_file "$blob_path")
  case "$mode" in
    100644) install_mode=0644 ;;
    100755) install_mode=0755 ;;
  esac
  printf '%s|%s|%s|%s\n' "$install_mode" "$checksum" "$application_sha" "$path" >> "$files_manifest"
done < "$contracts_paths"

archive_base=timeweb-ops-$ops_sha.tar.gz
contracts_archive_base=timeweb-application-contracts-$ops_sha.tar.gz
files_base=timeweb-ops-$ops_sha.files.sha256
receipt_base=timeweb-ops-$ops_sha.receipt
artifacts_base=timeweb-ops-$ops_sha.artifacts.sha256
for base in "$archive_base" "$contracts_archive_base" "$files_base" "$receipt_base" "$artifacts_base"; do
  [ ! -e "$output_directory/$base" ] && [ ! -L "$output_directory/$base" ] ||
    fail output_already_exists
done

tar_path=$work_directory/bundle.tar
git -C "$repository_root" archive --format=tar --output="$tar_path" "$ops_sha" -- "$@" ||
  fail git_archive
gzip -n -c "$tar_path" > "$work_directory/$archive_base" || fail gzip
contracts_tar_path=$work_directory/application-contracts.tar
git -C "$repository_root" archive --format=tar --output="$contracts_tar_path" \
  "$application_sha" -- contracts/openapi || fail application_contracts_archive
gzip -n -c "$contracts_tar_path" > "$work_directory/$contracts_archive_base" ||
  fail application_contracts_gzip
cp "$files_manifest" "$work_directory/$files_base"

archive_sha=$(sha256_file "$work_directory/$archive_base")
contracts_archive_sha=$(sha256_file "$work_directory/$contracts_archive_base")
files_sha=$(sha256_file "$work_directory/$files_base")
tree_sha=$(git -C "$repository_root" rev-parse "$ops_sha^{tree}")
application_tree_sha=$(git -C "$repository_root" rev-parse "$application_sha^{tree}")
contracts_tree_sha=$(git -C "$repository_root" rev-parse "$application_sha:contracts/openapi")
{
  printf 'PHUB_TIMEWEB_OPS_BUNDLE_V2\n'
  printf 'ops_sha=%s\n' "$ops_sha"
  printf 'tree_sha=%s\n' "$tree_sha"
  printf 'application_sha=%s\n' "$application_sha"
  printf 'application_tree_sha=%s\n' "$application_tree_sha"
  printf 'contracts_tree_sha=%s\n' "$contracts_tree_sha"
  printf 'archive_sha256=%s\n' "$archive_sha"
  printf 'contracts_archive_sha256=%s\n' "$contracts_archive_sha"
  printf 'files_manifest_sha256=%s\n' "$files_sha"
  printf 'installation=false\n'
  printf 'authorizes_deploy=false\n'
  printf 'authorizes_database_mutation=false\n'
} > "$work_directory/$receipt_base"

(
  cd "$work_directory"
  for artifact_file in "$archive_base" "$contracts_archive_base" "$files_base" "$receipt_base"; do
    printf '%s  %s\n' "$(sha256_file "$artifact_file")" "$artifact_file"
  done > "$artifacts_base"
)
artifacts_sha=$(sha256_file "$work_directory/$artifacts_base")

for base in "$archive_base" "$contracts_archive_base" "$files_base" "$receipt_base" "$artifacts_base"; do
  install -m 0444 "$work_directory/$base" "$output_directory/$base"
done
echo "TIMEWEB_BUNDLE_BUILD_PASSED|ops_sha=$ops_sha|application_sha=$application_sha|archive_sha256=$archive_sha|contracts_archive_sha256=$contracts_archive_sha|artifacts_sha256=$artifacts_sha|installation=false"
