import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./verify-timeweb-runtime-env.sh', import.meta.url));

function fixture(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-env-'));
  mkdirSync(join(directory, 'redis'));
  mkdirSync(join(directory, 'optional'));
  const files = {
    'staging.env':
      'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\nREDIS_URL=redis://phub:redacted@redis/0\nRABBITMQ_URL=amqp://phub:redacted@rabbitmq/phub_staging\nAPP_ENV=staging\nVIVA_MODE=disabled\nVIVA_OAUTH_ENABLED=false\nVIVA_DIRECT_READ_ENABLED=false\nVIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED=false\nWEB_PUSH_ENABLED=false\nBOOKING_REMINDER_SCHEDULER_ENABLED=false\nGIFT_CERTIFICATE_PAYMENT_MODE=disabled\nGIFT_CERTIFICATE_DELIVERY_MODE=disabled\nGAMES_COMMANDS_ENABLED=false\nGAMES_RESULTS_WRITE_MODE=disabled\nLEGACY_GAME_COMMAND_BRIDGE_ENABLED=false\nPARTICIPATION_COMMANDS_ENABLED=false\nCUP_RATING_CONSUMER_ENABLED=false\nHOME_VIVA_SYNC_ENABLED=false\nACTIVITY_HISTORY_SYNC_ENABLED=false\nCUP_PLAYER_LEVEL_PROJECTION_ENABLED=false\n',
    'staging.api-s3.env': 'S3_ACCESS_KEY=api-key\nS3_SECRET_KEY=api-secret\n',
    'staging.worker-s3.env': 'S3_ACCESS_KEY=worker-key\nS3_SECRET_KEY=worker-secret\n',
    'staging.migrator.env': 'DATABASE_URL=postgres://phub_migrator:redacted@postgres/phub\n',
    'realtime.env':
      'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\nREDIS_URL=redis://phub:redacted@redis/0\nRABBITMQ_URL=amqp://phub:redacted@rabbitmq/phub_staging\nCOMMUNITIES_REALTIME_ENABLED=false\nJWT_REALTIME_SECRET=test-fixture-randomized-1234567890\n',
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
    const result = verify(
      fixture({
        'staging.env':
          'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\nREDIS_URL=redis://phub:redacted@redis/0\nRABBITMQ_URL=amqp://phub:redacted@rabbitmq/phub_staging\nAPP_ENV=staging\nVIVA_MODE=disabled\nVIVA_OAUTH_ENABLED=false\nVIVA_DIRECT_READ_ENABLED=false\nVIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED=false\nWEB_PUSH_ENABLED=false\nBOOKING_REMINDER_SCHEDULER_ENABLED=false\nGIFT_CERTIFICATE_PAYMENT_MODE=disabled\nGIFT_CERTIFICATE_DELIVERY_MODE=disabled\nGAMES_COMMANDS_ENABLED=false\nGAMES_RESULTS_WRITE_MODE=disabled\nLEGACY_GAME_COMMAND_BRIDGE_ENABLED=false\nPARTICIPATION_COMMANDS_ENABLED=false\nCUP_RATING_CONSUMER_ENABLED=false\nHOME_VIVA_SYNC_ENABLED=false\nACTIVITY_HISTORY_SYNC_ENABLED=false\nCUP_PLAYER_LEVEL_PROJECTION_ENABLED=false\nS3_ACCESS_KEY=leaked\n',
      }),
    );
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
    expect(result.stderr).toContain('duplicate_assignment');
  });

  it('rejects a second shared runtime database URL', () => {
    const result = verify(
      fixture({
        'staging.env':
          'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\nDATABASE_URL=postgres://prod:leaked@prod.example/phub\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate_assignment');
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

  it('rejects production-facing and file-path override values without printing them', () => {
    const result = verify(
      fixture({
        'staging.env':
          'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\nREDIS_URL=redis://phub:redacted@redis/0\nRABBITMQ_URL=amqp://phub:redacted@rabbitmq/phub_staging\nAPP_ENV=staging\nVIVA_MODE=disabled\nVIVA_OAUTH_ENABLED=false\nVIVA_DIRECT_READ_ENABLED=false\nVIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED=false\nWEB_PUSH_ENABLED=false\nBOOKING_REMINDER_SCHEDULER_ENABLED=false\nGIFT_CERTIFICATE_PAYMENT_MODE=disabled\nGIFT_CERTIFICATE_DELIVERY_MODE=disabled\nGAMES_COMMANDS_ENABLED=false\nGAMES_RESULTS_WRITE_MODE=disabled\nLEGACY_GAME_COMMAND_BRIDGE_ENABLED=false\nPARTICIPATION_COMMANDS_ENABLED=false\nCUP_RATING_CONSUMER_ENABLED=false\nHOME_VIVA_SYNC_ENABLED=false\nACTIVITY_HISTORY_SYNC_ENABLED=false\nCUP_PLAYER_LEVEL_PROJECTION_ENABLED=false\nVIVA_API_KEY=production-secret\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsafe_runtime_override');
    expect(`${result.stdout}${result.stderr}`).not.toContain('production-secret');
  });

  it('rejects a production target in the realtime-only contour without printing it', () => {
    const result = verify(
      fixture({
        'realtime.env':
          'DATABASE_URL=postgres://prod:secret@production.example/phub\nREDIS_URL=redis://phub:redacted@redis/0\nRABBITMQ_URL=amqp://phub:redacted@rabbitmq/phub_staging\nCOMMUNITIES_REALTIME_ENABLED=false\nJWT_REALTIME_SECRET=test-fixture-randomized-1234567890\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('realtime_target_identity');
    expect(`${result.stdout}${result.stderr}`).not.toContain('production.example');
  });

  it('rejects a kill-switch shadow in an optional contour', () => {
    const directory = fixture();
    writeFileSync(
      join(directory, 'optional', 'staging.games.env'),
      'GAMES_COMMANDS_ENABLED=true\n',
    );
    const result = verify(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('optional_contour_shadowing');
  });

  it('rejects every noncanonical assignment form before value checks', () => {
    for (const assignment of [
      ' GAMES_COMMANDS_ENABLED=true\n',
      'GAMES_COMMANDS_ENABLED =true\n',
      'export GAMES_COMMANDS_ENABLED=true\n',
    ]) {
      const directory = fixture();
      const basePath = join(directory, 'staging.env');
      writeFileSync(basePath, `${readFileSync(basePath, 'utf8')}${assignment}`);
      const result = verify(directory);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('noncanonical_assignment');
    }
  });

  it('rejects alternate assignment syntax in every optional contour', () => {
    for (const name of [
      'staging.auth.env',
      'staging.override.env',
      'staging.games.env',
      'staging.communities.env',
      'staging.chat-push-foundation.env',
    ]) {
      const directory = fixture();
      writeFileSync(join(directory, 'optional', name), 'export GAMES_COMMANDS_ENABLED=true\n');
      const result = verify(directory);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('noncanonical_assignment');
    }
  });

  it('rejects duplicate normalized keys in base, realtime, and optional contours', () => {
    const cases = [
      ['staging.env', 'GAMES_COMMANDS_ENABLED=false\n'],
      ['realtime.env', 'DATABASE_URL=postgres://phub_runtime:redacted@postgres/phub\n'],
      ['optional/staging.games.env', 'FEATURE_MODE=safe\nFEATURE_MODE=unsafe\n'],
    ] as const;
    for (const [name, assignment] of cases) {
      const directory = fixture();
      const path = join(directory, name);
      const current = name.startsWith('optional/') ? '' : readFileSync(path, 'utf8');
      writeFileSync(path, `${current}${assignment}`);
      const result = verify(directory);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('duplicate_assignment');
    }
  });
});
