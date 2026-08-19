import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const runner = readFileSync(
  new URL('./run-communities-role-split-pg16-verification.sh', import.meta.url),
  'utf8',
);
const operatorTest = readFileSync(
  new URL(
    '../apps/migrator/src/communities-staging-role-split-marker-ceremony-pg-host.pg.test.ts',
    import.meta.url,
  ),
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
    expect(runner).toContain('PHUB_COMMUNITIES_MARKER_PG16_VERIFY_CONTAINER_ID="$CONTAINER_ID"');
    expect(runner).toContain(
      'PHUB_COMMUNITIES_MARKER_PG16_VERIFY_CONTAINER_NAME="$CONTAINER_NAME"',
    );
    expect(runner).toContain(
      'apps/migrator/src/communities-staging-role-split-marker-ceremony-pg-host.pg.test.ts',
    );
    expect(runner).toContain(
      'PG16_VERIFY_PASSED|major=16|fixture=disposable|restore=custom_archive|inventory=local_redacted|container_retained=false|network_retained=false',
    );
  });

  it('uses a custom archive and restores it into template0 without owner or ACL suppression', () => {
    expect(operatorTest).toContain("'--format=custom'");
    expect(operatorTest).toContain("'pg_restore', '--list'");
    expect(operatorTest).toContain('WITH TEMPLATE template0 OWNER');
    expect(operatorTest).toContain("'--exit-on-error'");
    expect(operatorTest).toContain("'--use-set-session-authorization'");
    expect(operatorTest).toContain('stdinFd: archiveFile.fd');
    expect(operatorTest).toContain("expect(restoreArguments).not.toContain('--no-owner')");
    expect(operatorTest).toContain("expect(restoreArguments).not.toContain('--no-acl')");
    expect(operatorTest).not.toMatch(/pg_restore[^\n]*--no-(?:owner|acl)/u);
  });
});
