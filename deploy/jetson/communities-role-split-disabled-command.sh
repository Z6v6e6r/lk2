#!/bin/sh
set -eu

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED' >&2
  exit 64
fi

printf '%s\n' 'COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED' >&2
exit 78
