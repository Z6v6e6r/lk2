#!/bin/sh
# Root-owned forced entry for the GitHub-hosted standard-delivery transport.
#
# Enrollment installs this file as `/home/phub-operator/bin/operator-entry` (root:root 0755) and
# pins it in the operator account's `authorized_keys` with
# `command="/home/phub-operator/bin/operator-entry",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`.
#
# stdin is exactly two lines: the short-lived delivery token and the numeric source CI run id. The
# SSH client supplies no command, the account has no usable login shell, and the only privileged
# command it may run is the enrolled launcher, with no arguments, because sudoers cannot express a
# wildcard argument safely. The decimal run id is therefore validated here and passed on through the
# environment; the launcher validates it again.
set -eu
IFS= read -r GH_TOKEN
IFS= read -r RUN_ID
case "$RUN_ID" in ''|*[!0-9]*) printf '%s\n' 'invalid run id' >&2; exit 64 ;; esac
case "$GH_TOKEN" in ''|*[!A-Za-z0-9_]*) printf '%s\n' 'invalid token' >&2; exit 64 ;; esac
export GH_TOKEN
export PHUB_SOURCE_CI_RUN_ID="$RUN_ID"
exec sudo -n --preserve-env=GH_TOKEN,PHUB_SOURCE_CI_RUN_ID /usr/local/sbin/phub-standard-delivery
