#!/bin/sh
# Enroll this fixed launcher with sudo only on the trusted Timeweb operator runner.
# Never grant sudo node, shell, git or Docker directly to a workflow account.
set -eu
[ "$#" -eq 1 ]
case "$1" in ''|*[!0-9]*) exit 64 ;; esac
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root GH_TOKEN="${GH_TOKEN:?}" \
  /usr/bin/node /opt/phub/timeweb-beta/standard/source/scripts/run-timeweb-standard-delivery.js "$1"
