import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { loadRealtimeConfig } from '../packages/config/src/index.js';
import {
  advancePhase,
  advanceBootstrapPhase,
  completeBootstrapRollback,
  completeRollback,
  finalize,
  finalizeBootstrap,
  prepare,
  prepareBootstrap,
  readBootstrapFinalizedField,
  readBootstrapField,
  readField,
  recoverMarker,
  restoreBootstrapFiles,
  restoreFiles,
  verifyBootstrapPrepared,
  verifyBootstrapFinalized,
  verifyPrepared,
} from '../deploy/jetson/provision-runtime-secret-files.mjs';

const uid = process.getuid?.() ?? 501;
const gid = process.getgid?.() ?? 20;
const snapshot = 'a'.repeat(64);
const imageId = `sha256:${'b'.repeat(64)}`;
const disabledApplicationKeys = [
  'PROFILE_PHOTO_CLIENT_SYNC_ENABLED',
  'COMMUNITY_INVITES_ENABLED',
  'COMMUNITIES_REALTIME_ENABLED',
  'COMMUNITY_MEDIA_ENABLED',
  'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED',
  'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED',
] as const;

function source(overrides = ''): string {
  return `APP_ENV=staging
LOG_LEVEL=info
REALTIME_HOST=0.0.0.0
REALTIME_PORT=3001
DATABASE_URL=postgres://runtime:redacted@postgres/phub
REDIS_URL=redis://redis:6379
RABBITMQ_URL=amqp://runtime:redacted@rabbitmq:5672
JWT_ISSUER=phub
JWT_AUDIENCE=phub-api
JWT_REALTIME_AUDIENCE=phub-realtime
JWT_ACCESS_SECRET=legacy-access-secret-at-least-32-characters
JWT_REFRESH_SECRET=legacy-refresh-secret-at-least-32-characters
VIVA_SYSTEM_KEY=must-not-leak
S3_SECRET_KEY=must-not-leak
REALTIME_DATABASE_POOL_MAX=7
REALTIME_DATABASE_POOL_WARM_CONNECTIONS=2
REALTIME_MAX_CONNECTIONS=200
REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION=40
REALTIME_MAX_SOCKET_BUFFER_BYTES=131072
REALTIME_HEARTBEAT_INTERVAL_MS=15000
${overrides}`;
}

function fixture(value = source()) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-runtime-secret-'));
  chmodSync(directory, 0o750);
  const staging = join(directory, 'staging.env');
  writeFileSync(staging, value, { mode: 0o640 });
  chmodSync(staging, 0o640);
  return { directory, staging, value, inode: lstatSync(staging).ino };
}

function options(failAfter?: string) {
  return {
    directory: { uid, gid, mode: 0o750 },
    staging: { uid, gid, mode: 0o640 },
    deployUid: uid,
    deployGid: gid,
    randomBytes: () => Buffer.alloc(48, 7),
    failAfter,
    attestation: {
      runtimeSnapshot: snapshot,
      activeComposeSha256: 'c'.repeat(64),
      candidateComposeSha256: 'd'.repeat(64),
      activeRelease: 'e'.repeat(40),
      releaseEnvSha256: 'f'.repeat(64),
      infrastructureIdentity: '1:2:3:4',
      infrastructureComposeSha256: '0'.repeat(64),
      oldApiImageId: imageId,
      oldApiImageRef: `ghcr.io/padlhub/phub-api@${imageId}`,
      oldWorkerImageId: imageId,
      oldWorkerImageRef: `ghcr.io/padlhub/phub-worker@${imageId}`,
      oldRealtimeImageId: imageId,
      oldRealtimeImageRef: `ghcr.io/padlhub/phub-realtime@${imageId}`,
      oldWebId: '1'.repeat(64),
      oldNginxId: '2'.repeat(64),
    },
  };
}

function bootstrapOptions(failAfter?: string) {
  const image = (service: string) => ({
    id: imageId,
    ref: `ghcr.io/padlhub/phub-${service}@${imageId}`,
  });
  const container = (value: string) => ({
    id: value.repeat(64),
    startedAt: '2026-08-16T12:00:00.000000000Z',
  });
  return {
    directory: { uid, gid, mode: 0o750 },
    staging: { uid, gid, mode: 0o640 },
    deployUid: uid,
    deployGid: gid,
    randomBytes: () => Buffer.alloc(48, 9),
    failAfter,
    attestation: {
      expectedActiveRelease: '1'.repeat(40),
      candidateRelease: '2'.repeat(40),
      controlCommit: '3'.repeat(40),
      controlTree: '4'.repeat(40),
      candidateTree: '5'.repeat(40),
      workflowRunId: '123456',
      workflowRunAttempt: '1',
      backupPath: '/opt/phub/backups/releases/b0-123456-1',
      bundlePath: '/opt/phub/b0-candidates/123456-1',
      infrastructureIdentity: '1:2:3:4',
      hashes: {
        runtimeSnapshot: '6'.repeat(64),
        activeCompose: '7'.repeat(64),
        candidateCompose: '8'.repeat(64),
        activeReleaseEnv: '9'.repeat(64),
        candidateReleaseEnv: 'a'.repeat(64),
        infrastructureCompose: 'b'.repeat(64),
        activeMigrationManifest: 'c'.repeat(64),
        candidateMigrationManifest: 'c'.repeat(64),
        applicationBackup: 'd'.repeat(64),
      },
      oldImages: Object.fromEntries(
        ['api', 'worker', 'realtime', 'web'].map((service) => [service, image(service)]),
      ),
      candidateImages: Object.fromEntries(
        ['api', 'worker', 'realtime', 'web', 'migrator'].map((service) => [
          service,
          image(service),
        ]),
      ),
      oldContainers: {
        api: container('1'),
        worker: container('2'),
        realtime: container('3'),
        web: container('4'),
      },
      infrastructureContainers: {
        nginxId: '5'.repeat(64),
        caddyId: '6'.repeat(64),
      },
    },
  };
}

function advanceToVerified(directory: string): void {
  for (const [from, to] of [
    ['prepared', 'compose-committed'],
    ['compose-committed', 'runtime-stopped'],
    ['runtime-stopped', 'realtime-ready'],
    ['realtime-ready', 'api-ready'],
    ['api-ready', 'worker-ready'],
    ['worker-ready', 'verified'],
  ] as const) {
    advancePhase(directory, from, to);
  }
}

describe('runtime-secret file transaction', () => {
  it('preserves staging bytes and publishes only the isolated realtime allowlist', () => {
    const input = fixture();
    expect(prepare(input.directory, options())).toEqual({ status: 'prepared' });
    expect(verifyPrepared(input.directory)).toEqual({ status: 'prepared' });

    const staging = readFileSync(input.staging, 'utf8');
    const realtime = readFileSync(join(input.directory, 'realtime.env'), 'utf8');
    expect(staging.startsWith(input.value)).toBe(true);
    for (const key of disabledApplicationKeys) {
      expect(staging.match(new RegExp(`^${key}=false$`, 'gm'))).toHaveLength(1);
    }
    expect(realtime).not.toContain('JWT_ACCESS_SECRET');
    expect(realtime).not.toContain('JWT_REFRESH_SECRET');
    expect(realtime).not.toContain('VIVA_SYSTEM_KEY');
    expect(realtime).not.toContain('S3_SECRET_KEY');
    expect(realtime).toContain('COMMUNITIES_REALTIME_ENABLED=false');
    expect(realtime).toContain('REALTIME_EXPECTED_REPLICAS=1');
    const realtimeEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
      realtime
        .trimEnd()
        .split('\n')
        .map((line) => line.split(/=(.*)/s, 2) as [string, string]),
    );
    expect(() => loadRealtimeConfig(realtimeEnvironment)).not.toThrow();
    expect(lstatSync(input.staging).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(input.directory, 'realtime.env')).mode & 0o777).toBe(0o600);
    const marker = readFileSync(
      join(input.directory, '.runtime-secret-isolation.transition.json'),
      'utf8',
    );
    expect(marker).not.toContain('BwcHBwcH');
    expect(marker).not.toContain('legacy-access-secret');
  });

  it('preserves existing explicit false flags without duplicating them', () => {
    const explicitFlags = disabledApplicationKeys.map((key) => `${key}=false`).join('\n');
    const input = fixture(source(`${explicitFlags}\n`));
    expect(prepare(input.directory, options())).toEqual({ status: 'prepared' });
    const staging = readFileSync(input.staging, 'utf8');
    for (const key of disabledApplicationKeys) {
      expect(staging.match(new RegExp(`^${key}=false$`, 'gm'))).toHaveLength(1);
    }
  });

  it.each(disabledApplicationKeys)(
    'rejects an enabled or malformed application gate before publishing candidates: %s',
    (key) => {
      const input = fixture(source(`${key}=true\n`));
      expect(() => prepare(input.directory, options())).toThrow(
        `staging.env must omit ${key} or set it to false`,
      );
    },
  );

  it('restores the original inode and bytes idempotently after realtime removal response loss', () => {
    const input = fixture();
    prepare(input.directory, options());
    expect(() => restoreFiles(input.directory, { failAfter: 'realtime-removed' })).toThrow(
      'injected failure',
    );
    expect(restoreFiles(input.directory)).toEqual({ status: 'files-restored' });
    expect(readField(input.directory, 'restoreFromPhase')).toBe('prepared');
    expect(restoreFiles(input.directory)).toEqual({ status: 'files-restored' });
    advancePhase(input.directory, 'files-restored', 'runtime-restored');
    expect(restoreFiles(input.directory)).toEqual({ status: 'runtime-restored' });
    expect(completeRollback(input.directory)).toEqual({ status: 'rolled-back' });
    expect(readFileSync(input.staging, 'utf8')).toBe(input.value);
    expect(lstatSync(input.staging).ino).toBe(input.inode);
  });

  it('exposes the non-secret runtime snapshot needed by files-only recovery', () => {
    const input = fixture();
    prepare(input.directory, options());
    expect(readField(input.directory, 'runtimeSnapshot')).toBe(snapshot);
  });

  it('promotes a durable marker.next left before the initial rename', () => {
    const input = fixture();
    expect(() => prepare(input.directory, options('initial-marker-next'))).toThrow(
      'injected failure',
    );
    expect(recoverMarker(input.directory)).toEqual({ status: 'marker-recovered' });
    expect(
      readFileSync(join(input.directory, '.runtime-secret-isolation.transition.json'), 'utf8'),
    ).toContain('runtime-secret-isolation');
    expect(restoreFiles(input.directory)).toEqual({ status: 'files-restored' });
    advancePhase(input.directory, 'files-restored', 'runtime-restored');
    expect(completeRollback(input.directory)).toEqual({ status: 'rolled-back' });
    expect(readFileSync(input.staging, 'utf8')).toBe(input.value);
  });

  it.each(['backup', 'realtime'])('recovers after a crash at %s publication', (failAfter) => {
    const input = fixture();
    expect(() => prepare(input.directory, options(failAfter))).toThrow('injected failure');
    expect(restoreFiles(input.directory)).toEqual({ status: 'files-restored' });
    advancePhase(input.directory, 'files-restored', 'runtime-restored');
    expect(completeRollback(input.directory)).toEqual({ status: 'rolled-back' });
    expect(readFileSync(input.staging, 'utf8')).toBe(input.value);
    expect(lstatSync(input.staging).ino).toBe(input.inode);
  });

  it('recovers a marker.next left by a later phase advance', () => {
    const input = fixture();
    prepare(input.directory, options());
    expect(() =>
      advancePhase(input.directory, 'prepared', 'compose-committed', {
        failAfter: 'marker-next',
      }),
    ).toThrow('injected failure');
    expect(recoverMarker(input.directory)).toEqual({ status: 'marker-recovered' });
    expect(verifyPrepared(input.directory)).toEqual({ status: 'compose-committed' });
  });

  it('retries finalization after the backup was durably removed', () => {
    const input = fixture();
    prepare(input.directory, options());
    advanceToVerified(input.directory);
    expect(() =>
      finalize(input.directory, '9'.repeat(64), { failAfter: 'backup-removed' }),
    ).toThrow('injected failure');
    expect(
      readFileSync(join(input.directory, '.runtime-secret-isolation.transition.json'), 'utf8'),
    ).toContain('"phase":"finalizing"');
    expect(finalize(input.directory, '9'.repeat(64))).toEqual({ status: 'finalized' });
    expect(() =>
      lstatSync(join(input.directory, '.runtime-secret-isolation.transition.json')),
    ).toThrow();
  });

  it('executes the exact stdin CLI used by the constrained helper container', () => {
    const input = fixture();
    prepare(input.directory, options());
    const helper = fileURLToPath(
      new URL('../deploy/jetson/provision-runtime-secret-files.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-',
        'advance-phase',
        input.directory,
        'prepared',
        'compose-committed',
      ],
      { encoding: 'utf8', input: readFileSync(helper, 'utf8') },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      'runtime-secret-transition operation=advance-phase result=compose-committed status=passed',
    );
  });

  it.each([
    ['missing newline', source().slice(0, -1), 'must end with a newline'],
    [
      'wrong environment',
      source().replace('APP_ENV=staging', 'APP_ENV=production'),
      'APP_ENV must be staging',
    ],
    ['duplicate key', source('DATABASE_URL=postgres://duplicate\n'), 'duplicate key DATABASE_URL'],
    [
      'missing key',
      source().replace(/^REDIS_URL=.*\n/m, ''),
      'missing required realtime key REDIS_URL',
    ],
  ])('rejects %s before publishing candidates', (_name, value, message) => {
    const input = fixture(value);
    expect(() => prepare(input.directory, options())).toThrow(message);
  });
});

describe('legacy B0 runtime-secret bootstrap file transaction', () => {
  it('publishes a versioned bootstrap marker without secret material', () => {
    const input = fixture();
    expect(prepareBootstrap(input.directory, bootstrapOptions())).toEqual({
      status: 'files-prepared',
    });
    expect(verifyBootstrapPrepared(input.directory)).toEqual({ status: 'files-prepared' });
    expect(readBootstrapField(input.directory, 'candidateRelease')).toBe('2'.repeat(40));
    const marker = readFileSync(
      join(input.directory, '.runtime-secret-isolation.transition.json'),
      'utf8',
    );
    expect(marker).toContain('legacy-runtime-secret-bootstrap');
    expect(marker).not.toContain('CQkJCQkJ');
    expect(marker).not.toContain('legacy-access-secret');
  });

  it.each(['backup', 'realtime'])(
    'restores the original file after a bootstrap crash at %s',
    (failAfter) => {
      const input = fixture();
      expect(() => prepareBootstrap(input.directory, bootstrapOptions(failAfter))).toThrow(
        'injected failure',
      );
      expect(restoreBootstrapFiles(input.directory)).toEqual({ status: 'files-restored' });
      expect(advanceBootstrapPhase(input.directory, 'files-restored', 'runtime-restored')).toEqual({
        status: 'runtime-restored',
      });
      expect(completeBootstrapRollback(input.directory)).toEqual({ status: 'rolled-back' });
      expect(readFileSync(input.staging, 'utf8')).toBe(input.value);
      expect(lstatSync(input.staging).ino).toBe(input.inode);
    },
  );

  it('recovers marker publication and finalization response loss idempotently', () => {
    const input = fixture();
    prepareBootstrap(input.directory, bootstrapOptions());
    expect(() =>
      advanceBootstrapPhase(input.directory, 'files-prepared', 'images-probed', {
        failAfter: 'marker-next',
      }),
    ).toThrow('injected failure');
    expect(recoverMarker(input.directory)).toEqual({ status: 'marker-recovered' });
    for (const [from, to] of [
      ['images-probed', 'runtime-stopped'],
      ['runtime-stopped', 'compose-committed'],
      ['compose-committed', 'release-committed'],
      ['release-committed', 'realtime-ready'],
      ['realtime-ready', 'api-ready'],
      ['api-ready', 'worker-ready'],
      ['worker-ready', 'web-ready'],
      ['web-ready', 'verified'],
    ] as const) {
      advanceBootstrapPhase(input.directory, from, to);
    }
    expect(() =>
      finalizeBootstrap(input.directory, 'e'.repeat(64), { failAfter: 'backup-removed' }),
    ).toThrow('injected failure');
    expect(finalizeBootstrap(input.directory, 'e'.repeat(64))).toEqual({ status: 'finalized' });
    expect(verifyBootstrapFinalized(input.directory)).toEqual({ status: 'finalized' });
    expect(readBootstrapFinalizedField(input.directory, 'candidateRelease')).toBe('2'.repeat(40));
    expect(readBootstrapFinalizedField(input.directory, 'finalSnapshot')).toBe('e'.repeat(64));
    expect(finalizeBootstrap(input.directory, 'e'.repeat(64))).toEqual({
      status: 'already-finalized',
    });
    expect(existsSync(join(input.directory, '.runtime-secret-isolation.transition.json'))).toBe(
      false,
    );
    expect(existsSync(join(input.directory, '.runtime-secret-bootstrap.finalized.json'))).toBe(
      true,
    );
  });

  it.each(['final-marker', 'receipt-renamed'])(
    'converges finalization after response loss at %s',
    (failAfter) => {
      const input = fixture();
      prepareBootstrap(input.directory, bootstrapOptions());
      for (const [from, to] of [
        ['files-prepared', 'images-probed'],
        ['images-probed', 'runtime-stopped'],
        ['runtime-stopped', 'compose-committed'],
        ['compose-committed', 'release-committed'],
        ['release-committed', 'realtime-ready'],
        ['realtime-ready', 'api-ready'],
        ['api-ready', 'worker-ready'],
        ['worker-ready', 'web-ready'],
        ['web-ready', 'verified'],
      ] as const) {
        advanceBootstrapPhase(input.directory, from, to);
      }
      expect(() => finalizeBootstrap(input.directory, 'f'.repeat(64), { failAfter })).toThrow(
        'injected failure',
      );
      expect(finalizeBootstrap(input.directory, 'f'.repeat(64))).toEqual({
        status: failAfter === 'receipt-renamed' ? 'already-finalized' : 'finalized',
      });
      expect(verifyBootstrapFinalized(input.directory)).toEqual({ status: 'finalized' });
    },
  );

  it('rejects a bootstrap whose migration manifests differ', () => {
    const input = fixture();
    const value = bootstrapOptions();
    value.attestation.hashes.candidateMigrationManifest = 'e'.repeat(64);
    expect(() => prepareBootstrap(input.directory, value)).toThrow(
      'bootstrap marker has an unknown schema or phase',
    );
  });
});
