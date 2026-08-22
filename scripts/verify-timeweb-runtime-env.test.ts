import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./verify-timeweb-runtime-env.sh', import.meta.url));

function fixture(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-env-'));
  mkdirSync(join(directory, 'redis'));
  const files = {
    'staging.env': 'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\n',
    'staging.api-s3.env': 'S3_ACCESS_KEY=api-key\nS3_SECRET_KEY=api-secret\n',
    'staging.worker-s3.env': 'S3_ACCESS_KEY=worker-key\nS3_SECRET_KEY=worker-secret\n',
    'staging.migrator.env': 'DATABASE_URL=postgres://phub_migrator:redacted@postgres/phub\n',
    'redis/users.acl':
      'user default on nopass ~* -@all +ping\nuser phub on >test-fixture-randomized-1234567890 ~* +@read +@write +@connection +@transaction +@pubsub -@admin -@dangerous +eval +evalsha\n',
    ...overrides,
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    writeFileSync(path, contents, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return directory;
}

function verify(directory: string) {
  return spawnSync('sh', [script, 'content-only', directory], { encoding: 'utf8' });
}

describe('Timeweb runtime env isolation verifier', () => {
  it('accepts isolated API, worker and migrator contours without printing values', () => {
    const result = verify(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TIMEWEB_ENV_VERIFY_PASSED');
    expect(result.stdout).not.toContain('api-secret');
    expect(result.stdout).not.toContain('migrator:redacted');
  });

  it('rejects S3 credentials in the shared runtime contour', () => {
    const result = verify(fixture({ 'staging.env': 'S3_ACCESS_KEY=leaked\n' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('s3_credentials_in_shared_runtime');
  });

  it('rejects unrelated secrets in the migrator contour', () => {
    const result = verify(
      fixture({
        'staging.migrator.env':
          'DATABASE_URL=postgres://phub_migrator:redacted@postgres/phub\nJWT_SECRET=leaked\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected_key_set');
  });

  it('rejects a Redis application identity that remains disabled', () => {
    const result = verify(
      fixture({
        'redis/users.acl':
          'user default on nopass ~* -@all +ping\nuser phub off >test-fixture-randomized-1234567890 ~* +@read +@write +@connection +@transaction +@pubsub -@admin -@dangerous +eval +evalsha\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('redis_acl_contract');
  });

  it('rejects reused API and worker S3 identities', () => {
    const shared = 'S3_ACCESS_KEY=shared-key\nS3_SECRET_KEY=shared-secret\n';
    const result = verify(
      fixture({ 'staging.api-s3.env': shared, 'staging.worker-s3.env': shared }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('s3_identity_reuse');
  });

  it('rejects a migrator URL using the runtime database role', () => {
    const result = verify(
      fixture({
        'staging.migrator.env': 'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('migrator_database_identity');
  });

  it('rejects database query parameters that could override the allowlisted host', () => {
    const result = verify(
      fixture({
        'staging.migrator.env':
          'DATABASE_URL=postgres://phub_migrator:redacted@postgres/phub?host=evil.example\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('migrator_database_identity');
  });

  it('rejects duplicate credential keys', () => {
    const result = verify(
      fixture({
        'staging.api-s3.env':
          'S3_ACCESS_KEY=api-key\nS3_ACCESS_KEY=override\nS3_SECRET_KEY=api-secret\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected_key_set');
  });

  it('rejects a second shared runtime database URL', () => {
    const result = verify(
      fixture({
        'staging.env':
          'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\nDATABASE_URL=postgres://prod:leaked@prod.example/phub\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime_database_identity');
  });

  it('rejects the public Redis placeholder even if the account is enabled', () => {
    const result = verify(
      fixture({
        'redis/users.acl':
          'user default on nopass ~* -@all +ping\nuser phub on >replace-with-generated-secret ~* +@read +@write +@connection +@transaction +@pubsub -@admin -@dangerous +eval +evalsha\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('redis_acl_placeholder');
  });
});
