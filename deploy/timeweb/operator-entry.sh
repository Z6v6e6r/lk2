#!/bin/sh
# Root-owned forced entry for the GitHub-hosted standard-delivery transport.
#
# Enrollment installs this file as `/home/phub-operator/bin/operator-entry` (root:root 0755),
# sets that file as the account's login shell with `usermod -s` (sshd starts the login shell even
# for a forced command, so a `nologin` shell would refuse every delivery), and only then pins the
# key in the operator account's `authorized_keys` with
# `command="/home/phub-operator/bin/operator-entry",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`.
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
# A GitHub token is an opaque base64url-ish string, so the accepted class is every printable
# non-space byte rather than an assumed alphabet: rejecting a legitimate `-`, `.`, `=` or `_` is a
# functional bug, while whitespace and control bytes are what could smuggle a second line. Nothing
# downstream interpolates the value into a shell: it is exported, preserved across sudo and passed to
# node as one quoted argv word by the launcher.
case "$GH_TOKEN" in
  ''|*[![:graph:]]*)
    offending=$(printf '%s' "$GH_TOKEN" | LC_ALL=C tr -d '[:graph:]' | LC_ALL=C od -An -tx1 | tr -d ' \n' | cut -c1-40)
    printf '%s\n' "invalid token: unexpected bytes ${offending:-none}" >&2
    exit 64
    ;;
esac
export GH_TOKEN
export PHUB_SOURCE_CI_RUN_ID="$RUN_ID"
exec /usr/bin/sudo -n --preserve-env=GH_TOKEN,PHUB_SOURCE_CI_RUN_ID /usr/local/sbin/phub-standard-delivery
