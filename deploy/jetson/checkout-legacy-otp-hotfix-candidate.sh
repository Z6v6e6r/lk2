#!/bin/sh

set -eu

# The hardened legacy checkout deliberately avoids submodule discovery. The e308 history contains
# an orphan gitlink, so a regular Actions checkout is not an acceptable candidate acquisition path.
exec sh "$(dirname "$0")/checkout-legacy-runtime-secret-bootstrap-candidate.sh" "$@"
