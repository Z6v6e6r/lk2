import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { provisionRuntimeSecrets } from './provision-timeweb-beta-runtime-secrets.js';

const temporaryRoots: string[] = [];
const key = (purpose: string) =>
  createHash('sha256').update(`timeweb-beta-${purpose}`).digest('base64url');
const encode = (values: Record<string, string>) =>
  `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;

function safeEnvironments() {
  const dependencies = {
    DATABASE_URL: 'postgresql://api:secret@db.internal:5432/phub',
    REDIS_URL: 'redis://:secret@redis.internal:6379/0',
    RABBITMQ_URL: 'amqps://api:secret@rabbit.internal/phub',
  };
  const disabled = {
    GAMES_COMMANDS_ENABLED: 'false',
    LEGACY_GAME_COMMAND_BRIDGE_ENABLED: 'false',
    PARTICIPATION_COMMANDS_ENABLED: 'false',
    BOOKING_REMINDER_SCHEDULER_ENABLED: 'false',
    PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED: 'false',
    ACTIVITY_HISTORY_SYNC_ENABLED: 'false',
    ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: 'false',
    PROFILE_PHOTO_MAINTENANCE_ENABLED: 'false',
    GIFT_CERTIFICATE_ISSUANCE_ENABLED: 'false',
  };
  const common = {
    APP_ENV: 'staging',
    ...dependencies,
    JWT_ISSUER: 'https://beta.example.test',
    JWT_AUDIENCE: 'phub-api',
  };
  const writerSafety = {
    GAMES_RESULTS_WRITE_MODE: 'disabled',
    GIFT_CERTIFICATE_PAYMENT_MODE: 'disabled',
    SUBSCRIPTION_RUNTIME_WARN_MODE: 'OFF',
    ...disabled,
  };
  return {
    'api.env': {
      ...common,
      ...writerSafety,
      GAMES_READ_ENABLED: 'true',
      OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-api-1',
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://beta.example.test',
      TRUSTED_PROXY_CIDRS: '172.30.26.10/32',
      CUP_DEV_AUTH_ENABLED: 'false',
      VIVA_MODE: 'production',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://beta.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://beta.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: key('delegation'),
      JWT_ACCESS_SECRET: key('access'),
      JWT_REFRESH_SECRET: key('refresh'),
      JWT_REALTIME_SECRET: key('realtime'),
      JWT_REALTIME_AUDIENCE: 'phub-realtime',
    },
    'worker.env': {
      ...common,
      ...writerSafety,
      DATABASE_URL: 'postgresql://worker:secret@db.internal:5432/phub',
      REDIS_URL: 'redis://worker:secret@redis.internal:6379/0',
      RABBITMQ_URL: 'amqps://worker:secret@rabbit.internal/phub',
      GAMES_READ_ENABLED: 'false',
      OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-worker-1',
      OUTBOX_PUBLISH_MODE: 'leased',
      WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED: 'true',
    },
    'realtime.env': {
      ...common,
      DATABASE_URL: 'postgresql://realtime:secret@db.internal:5432/phub',
      REDIS_URL: 'redis://realtime:secret@redis.internal:6379/0',
      RABBITMQ_URL: 'amqps://realtime:secret@rabbit.internal/phub',
      OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-realtime-1',
      JWT_REALTIME_SECRET: key('realtime'),
      JWT_REALTIME_AUDIENCE: 'phub-realtime',
    },
    'migrator.env': {
      DATABASE_URL: 'postgresql://migrator:secret@db.internal:5432/phub',
      MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phub-timeweb-secrets-'));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'timeweb-beta');
  const backupRoot = join(root, 'backups');
  mkdirSync(sourceDir, { mode: 0o700 });
  mkdirSync(targetDir, { mode: 0o700 });
  writeFileSync(join(targetDir, 'previous.marker'), 'previous\n', { mode: 0o600 });
  for (const [name, values] of Object.entries(safeEnvironments()))
    writeFileSync(join(sourceDir, name), encode(values), { mode: 0o600 });
  return { root, sourceDir, targetDir, backupRoot };
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Timeweb beta secret provisioner', () => {
  it('validates, atomically installs and preserves the prior set without printing values', () => {
    const paths = fixture();
    const releaseId = `${'a'.repeat(40)}-123-1`;
    const result = provisionRuntimeSecrets({
      ...paths,
      host: 'beta.example.test',
      tenantKey: 'local-padel',
      releaseId,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
    });

    expect(result).toEqual({ previousBackedUp: true });
    expect(
      readFileSync(join(paths.backupRoot, releaseId, 'previous', 'previous.marker'), 'utf8'),
    ).toBe('previous\n');
    for (const name of Object.keys(safeEnvironments())) {
      const stat = lstatSync(join(paths.targetDir, name));
      expect(stat.mode).toBe(0o100600);
      expect(stat.nlink).toBe(1);
    }
  });

  it('supports a later rotation while reserving each release id once', () => {
    const paths = fixture();
    const common = {
      ...paths,
      host: 'beta.example.test',
      tenantKey: 'local-padel',
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
    };
    provisionRuntimeSecrets({ ...common, releaseId: `${'c'.repeat(40)}-125-1` });
    provisionRuntimeSecrets({ ...common, releaseId: `${'d'.repeat(40)}-126-1` });
    expect(lstatSync(join(paths.backupRoot, `${'c'.repeat(40)}-125-1`)).isDirectory()).toBe(true);
    expect(
      lstatSync(join(paths.backupRoot, `${'d'.repeat(40)}-126-1`, 'previous')).isDirectory(),
    ).toBe(true);
    expect(() =>
      provisionRuntimeSecrets({ ...common, releaseId: `${'d'.repeat(40)}-126-1` }),
    ).toThrow();
  });

  it('fails closed before replacement when the source contains mock identity mode', () => {
    const paths = fixture();
    const apiPath = join(paths.sourceDir, 'api.env');
    writeFileSync(
      apiPath,
      readFileSync(apiPath, 'utf8').replace('VIVA_MODE=production', 'VIVA_MODE=mock'),
      {
        mode: 0o600,
      },
    );
    expect(() =>
      provisionRuntimeSecrets({
        ...paths,
        host: 'beta.example.test',
        tenantKey: 'local-padel',
        releaseId: `${'b'.repeat(40)}-124-1`,
        expectedUid: process.getuid?.() ?? 0,
        expectedGid: process.getgid?.() ?? 0,
      }),
    ).toThrow('unsafe_VIVA_MODE');
    expect(readFileSync(join(paths.targetDir, 'previous.marker'), 'utf8')).toBe('previous\n');
  });
});
