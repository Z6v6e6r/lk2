import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const runner = readFileSync(
  new URL('./run-communities-role-split-pg16-verification.sh', import.meta.url),
  'utf8',
);

describe('communities role-split disposable PG16 runner contract', () => {
  it('creates an isolated PG16 fixture without pulling or exposing a non-loopback port', () => {
    expect(runner).toContain('--pull never');
    expect(runner).toContain('--publish 127.0.0.1::5432');
    expect(runner).toContain('postgres:16-alpine');
    expect(runner).toContain('openssl rand -hex 32');
    expect(runner).toContain('--env "POSTGRES_PASSWORD=$FIXTURE_PASSWORD"');
    expect(runner).toContain('docker network create');
    expect(runner).toContain('--network "$NETWORK_NAME"');
    expect(runner).toContain('phub_role_split_admin_verify');
    expect(runner).toContain('[ -x ./node_modules/.bin/vitest ] || fail dependencies_missing');
    expect(runner).toContain('./node_modules/.bin/vitest run');
    expect(runner).not.toContain('npx vitest');
    expect(runner).not.toContain('POSTGRES_HOST_AUTH_METHOD=trust');
    expect(runner).not.toMatch(/0\.0\.0\.0|--network host|docker compose|docker pull/u);
  });

  it('binds cleanup to exact id, name and label and never performs broad Docker cleanup', () => {
    expect(runner).toContain('observed="$(docker inspect');
    expect(runner).toContain('expected="$CONTAINER_ID|/$CONTAINER_NAME|$CONTAINER_LABEL_VALUE"');
    expect(runner).toContain('docker rm --force --volumes "$CONTAINER_ID"');
    expect(runner).toContain(
      'PG16_VERIFY_CLEANUP_REFUSED|resource=container|reason=identity_mismatch',
    );
    expect(runner).toContain(
      'PG16_VERIFY_CLEANUP_REFUSED|resource=network|reason=identity_mismatch',
    );
    expect(runner).toContain('if [ "$cleanup_failed" -eq 0 ]');
    expect(runner).not.toMatch(/docker (system|container|volume) prune|docker rm[^\n]*\$\(/u);
  });

  it('runs only the dedicated operator test and confirms teardown', () => {
    expect(runner).toContain('PHUB_COMMUNITIES_MARKER_PG16_VERIFY_URL=');
    expect(runner).toContain(
      'apps/migrator/src/communities-staging-role-split-marker-ceremony-pg-host.pg.test.ts',
    );
    expect(runner).toContain(
      'PG16_VERIFY_PASSED|major=16|fixture=disposable|container_retained=false|network_retained=false',
    );
  });
});
