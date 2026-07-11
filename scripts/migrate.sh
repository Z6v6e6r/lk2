#!/usr/bin/env sh
set -eu

exec npm run db:migrate
