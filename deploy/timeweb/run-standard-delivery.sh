#!/bin/sh
# Enroll this fixed launcher with sudo only for the dedicated operator transport account.
# Never grant sudo node, shell, git or Docker directly to a workflow account.
#
# The source CI run id arrives in the environment rather than as an argument: sudoers cannot express
# a wildcard argument safely, so the account is allowed to run this file with no arguments at all and
# the decimal run id is validated here. GH_TOKEN and the run id are the only values preserved across
# sudo; the controller still receives the run id as its one positional argument.
set -eu
[ "$#" -eq 0 ]
run_id="${PHUB_SOURCE_CI_RUN_ID:?}"
case "$run_id" in ''|*[!0-9]*) exit 64 ;; esac
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  GH_TOKEN="${GH_TOKEN:?}" PHUB_SOURCE_CI_RUN_ID="$run_id" \
  /usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js "$run_id"
