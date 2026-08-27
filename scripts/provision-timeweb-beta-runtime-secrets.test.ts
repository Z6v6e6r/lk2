import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, loadRealtimeConfig } from '../packages/config/src/index.js';
import {
  parseTimewebSecretEnvironment,
  provisionTimewebBetaRuntimeSecrets,
} from './provision-timeweb-beta-runtime-secrets.js';
import {
  createSecretFixture,
  encodeEnvironment,
  host,
  releaseId,
  safeRuntimeEnvironments,
  sourceSha,
  sourceTree,
  tenantKey,
} from './timeweb-beta-activation-inputs.fixture.js';

const roots: string[] = [];
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const options = (fixture: ReturnType<typeof createSecretFixture>, overrides = {}) => ({
  sourceDir: fixture.sourceDir,
  targetDir: fixture.targetDir,
  backupRoot: fixture.backupRoot,
  host,
  tenantKey,
  releaseId,
  expectedSourceSha: sourceSha,
  expectedSourceTree: sourceTree,
  expectedUid: uid,
  expectedGid: gid,
  ...overrides,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const value = createSecretFixture();
  roots.push(value.root);
  return value;
}

function installedReleaseId(targetDir: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(targetDir, '.release-identity.json'), 'utf8'),
  );
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('releaseId' in parsed) ||
    typeof parsed.releaseId !== 'string'
  )
    throw new Error('invalid synthetic release identity');
  return parsed.releaseId;
}

describe('Timeweb beta runtime secret provisioner', () => {
  it('rejects a release not bound to the exact local source before creating a target', () => {
    const value = fixture();
    const wrongSource = 'f'.repeat(40);
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          releaseId: `${wrongSource}-12345678901-1`,
          expectedSourceSha: wrongSource,
        }),
      ),
    ).toThrow('frozen_source_identity');
    expect(existsSync(value.targetParent)).toBe(false);

    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          expectedSourceTree: 'e'.repeat(40),
        }),
      ),
    ).toThrow('frozen_source_identity');
    expect(existsSync(value.targetParent)).toBe(false);
  });

  it('dry-runs without writes or secret values, then atomically provisions 0700/0600 files', () => {
    const value = fixture();
    const plan = provisionTimewebBetaRuntimeSecrets({ ...options(value), dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(existsSync(value.targetParent)).toBe(false);
    const report = JSON.stringify(plan);
    expect(report).toContain('JWT_ACCESS_SECRET');
    expect(report).not.toContain(value.environments.api!.JWT_ACCESS_SECRET);

    const result = provisionTimewebBetaRuntimeSecrets(options(value));
    expect(result.previousBackedUp).toBe(false);
    expect(lstatSync(value.targetParent).mode & 0o777).toBe(0o700);
    expect(lstatSync(value.targetDir).mode & 0o777).toBe(0o700);
    for (const name of [
      'api.env',
      'worker.env',
      'realtime.env',
      'migrator.env',
      '.release-identity.json',
    ]) {
      const stat = lstatSync(join(value.targetDir, name));
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(
      JSON.parse(readFileSync(join(value.targetDir, '.release-identity.json'), 'utf8')),
    ).toEqual({
      schema: 'PHUB_TIMEWEB_SECRET_SET_V1',
      releaseId,
    });
  });

  it('rotates only from the exact expected identity and restores it on handled failure', () => {
    const value = fixture();
    provisionTimewebBetaRuntimeSecrets(options(value));
    const nextRelease = `${sourceSha}-12345678902-1`;
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          releaseId: nextRelease,
          expectedCurrentReleaseId: `${sourceSha}-999-1`,
        }),
      ),
    ).toThrow('current_release_identity_mismatch');
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          releaseId: nextRelease,
          expectedCurrentReleaseId: releaseId,
          failAfter: 'backup',
        }),
      ),
    ).toThrow('injected_failure');
    expect(installedReleaseId(value.targetDir)).toBe(releaseId);
    expect(
      readdirSync(value.targetParent).some((name) => name.startsWith('.timeweb-beta.incoming-')),
    ).toBe(false);
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          releaseId: nextRelease,
          expectedCurrentReleaseId: releaseId,
          failAfter: 'install',
        }),
      ),
    ).toThrow('injected_failure');
    expect(installedReleaseId(value.targetDir)).toBe(releaseId);

    const result = provisionTimewebBetaRuntimeSecrets(
      options(value, { releaseId: nextRelease, expectedCurrentReleaseId: releaseId }),
    );
    expect(result.previousBackedUp).toBe(true);
    expect(installedReleaseId(value.targetDir)).toBe(nextRelease);
  });

  it('preserves durable transaction evidence when rollback cannot complete', () => {
    const value = fixture();
    provisionTimewebBetaRuntimeSecrets(options(value));
    const nextRelease = `${sourceSha}-12345678902-1`;
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          releaseId: nextRelease,
          expectedCurrentReleaseId: releaseId,
          failAfter: 'recovery',
        }),
      ),
    ).toThrow('injected_recovery_failure');
    expect(existsSync(join(value.targetParent, '.timeweb-beta.provision.lock'))).toBe(true);
    expect(existsSync(value.targetDir)).toBe(false);
    expect(
      readdirSync(value.targetParent).some((name) => name.startsWith('.timeweb-beta.incoming-')),
    ).toBe(true);
  });

  it('dry-run stops read-only when any transaction marker is present', () => {
    const value = fixture();
    mkdirSync(value.targetParent, { recursive: true, mode: 0o700 });
    writeFileSync(join(value.targetParent, '.timeweb-beta.provision.lock'), '{}\n', {
      mode: 0o600,
    });
    expect(() => provisionTimewebBetaRuntimeSecrets({ ...options(value), dryRun: true })).toThrow(
      'provision_transaction_present',
    );
  });

  it.each([
    [
      'duplicate key',
      (value: ReturnType<typeof createSecretFixture>) => {
        const path = join(value.sourceDir, 'api.env');
        writeFileSync(path, `${readFileSync(path, 'utf8')}APP_ENV=staging\n`, { mode: 0o600 });
      },
      'duplicate_key',
    ],
    [
      'empty value',
      (value: ReturnType<typeof createSecretFixture>) => {
        writeFileSync(join(value.sourceDir, 'api.env'), 'APP_ENV=\n', { mode: 0o600 });
      },
      'empty_value',
    ],
    [
      'NUL',
      (value: ReturnType<typeof createSecretFixture>) => {
        writeFileSync(join(value.sourceDir, 'api.env'), Buffer.from('APP_ENV=stag\0ing\n'), {
          mode: 0o600,
        });
      },
      'nul_value',
    ],
    [
      'invalid UTF-8',
      (value: ReturnType<typeof createSecretFixture>) => {
        writeFileSync(
          join(value.sourceDir, 'api.env'),
          Buffer.from([0x41, 0x3d, 0xc3, 0x28, 0x0a]),
          { mode: 0o600 },
        );
      },
      'invalid_encoding',
    ],
    [
      'CR newline',
      (value: ReturnType<typeof createSecretFixture>) => {
        writeFileSync(join(value.sourceDir, 'api.env'), 'APP_ENV=staging\r\n', { mode: 0o600 });
      },
      'forbidden_newline',
    ],
    [
      'unknown key',
      (value: ReturnType<typeof createSecretFixture>) => {
        const path = join(value.sourceDir, 'api.env');
        writeFileSync(path, `${readFileSync(path, 'utf8')}UNEXPECTED_KEY=value\n`, { mode: 0o600 });
      },
      'unknown_key',
    ],
    [
      'Compose interpolation metacharacter',
      (value: ReturnType<typeof createSecretFixture>) => {
        const environments = safeRuntimeEnvironments();
        environments.api!.JWT_ACCESS_SECRET = '${CALLER_CONTROLLED_VALUE}';
        writeFileSync(join(value.sourceDir, 'api.env'), encodeEnvironment(environments.api!), {
          mode: 0o600,
        });
      },
      'compose_metacharacter',
    ],
  ])('fails closed on %s', (_name, mutate, reason) => {
    const value = fixture();
    mutate(value);
    expect(() => provisionTimewebBetaRuntimeSecrets(options(value))).toThrow(reason);
    expect(existsSync(value.targetDir)).toBe(false);
  });

  it('rejects missing and unexpected files', () => {
    const missing = fixture();
    rmSync(join(missing.sourceDir, 'worker.env'));
    expect(() => provisionTimewebBetaRuntimeSecrets(options(missing))).toThrow('source_file_set');

    const unknown = fixture();
    writeFileSync(join(unknown.sourceDir, 'extra.env'), 'VALUE=synthetic\n', { mode: 0o600 });
    expect(() => provisionTimewebBetaRuntimeSecrets(options(unknown))).toThrow('source_file_set');
  });

  it('rejects symlinks, hardlinks and group-readable sources', () => {
    const symlink = fixture();
    const apiPath = join(symlink.sourceDir, 'api.env');
    const apiReal = join(symlink.root, 'api-real.env');
    rmSync(apiPath);
    writeFileSync(apiReal, encodeEnvironment(safeRuntimeEnvironments().api!), { mode: 0o600 });
    symlinkSync(apiReal, apiPath);
    expect(() => provisionTimewebBetaRuntimeSecrets(options(symlink))).toThrow(
      'source_file_security',
    );

    const hardlink = fixture();
    linkSync(join(hardlink.sourceDir, 'api.env'), join(hardlink.root, 'api-hardlink.env'));
    expect(() => provisionTimewebBetaRuntimeSecrets(options(hardlink))).toThrow(
      'source_file_security',
    );

    const readable = fixture();
    chmodSync(join(readable.sourceDir, 'api.env'), 0o640);
    expect(() => provisionTimewebBetaRuntimeSecrets(options(readable))).toThrow(
      'source_file_security',
    );
  });

  it('rejects historical staging paths and path traversal before creating a target', () => {
    const value = fixture();
    const staging = join(value.root, 'staging');
    mkdirSync(staging, { mode: 0o700 });
    const stagedSource = join(staging, 'source');
    mkdirSync(stagedSource, { mode: 0o700 });
    for (const name of readdirSync(value.sourceDir)) {
      writeFileSync(join(stagedSource, name), readFileSync(join(value.sourceDir, name)), {
        mode: 0o600,
      });
    }
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(options(value, { sourceDir: stagedSource })),
    ).toThrow('source_path');
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, { targetDir: `${value.targetDir}/../timeweb-beta` }),
      ),
    ).toThrow('target_path');
  });

  it('requires the replica count that staging Realtime config consumes', () => {
    const value = fixture();
    const realtime = { ...value.environments.realtime };
    delete realtime.REALTIME_EXPECTED_REPLICAS;
    writeFileSync(join(value.sourceDir, 'realtime.env'), encodeEnvironment(realtime), {
      mode: 0o600,
    });
    expect(() => provisionTimewebBetaRuntimeSecrets(options(value))).toThrow('missing_key');
  });

  it('matches startup config invariants for the initially startable API and Realtime', () => {
    const environments = safeRuntimeEnvironments();
    expect(() => loadConfig(environments.api)).not.toThrow();
    expect(() => loadRealtimeConfig(environments.realtime)).not.toThrow();
    expect(() => loadConfig(environments.worker)).toThrow('JWT_ACCESS_SECRET');
  });

  it.each([
    [
      'production APP_ENV with staging-only Games reads',
      (environments: ReturnType<typeof safeRuntimeEnvironments>) => {
        environments.api!.APP_ENV = 'production';
      },
      'runtime_identity',
    ],
    [
      'invalid Viva delegation key encoding',
      (environments: ReturnType<typeof safeRuntimeEnvironments>) => {
        environments.api!.VIVA_DELEGATION_ENCRYPTION_KEY = `${environments.api!.VIVA_DELEGATION_ENCRYPTION_KEY}x`;
      },
      'delegation_key_encoding',
    ],
    [
      'unexpected initial Realtime replica count',
      (environments: ReturnType<typeof safeRuntimeEnvironments>) => {
        environments.realtime!.REALTIME_EXPECTED_REPLICAS = '2';
      },
      'realtime_replica_identity',
    ],
    [
      'delegation key reused as a JWT key',
      (environments: ReturnType<typeof safeRuntimeEnvironments>) => {
        const delegationKey = environments.api!.VIVA_DELEGATION_ENCRYPTION_KEY;
        if (delegationKey === undefined) throw new Error('synthetic delegation key missing');
        environments.api!.JWT_ACCESS_SECRET = delegationKey;
      },
      'signing_key_identity',
    ],
  ])('rejects %s before provisioning', (_name, mutate, reason) => {
    const value = fixture();
    const environments = safeRuntimeEnvironments();
    mutate(environments);
    for (const [service, name] of Object.entries({
      api: 'api.env',
      worker: 'worker.env',
      realtime: 'realtime.env',
      migrator: 'migrator.env',
    }))
      writeFileSync(join(value.sourceDir, name), encodeEnvironment(environments[service]!), {
        mode: 0o600,
      });
    expect(() => provisionTimewebBetaRuntimeSecrets(options(value))).toThrow(reason);
  });

  it('rejects rotation when an installed current secret loses root-only mode', () => {
    const value = fixture();
    provisionTimewebBetaRuntimeSecrets(options(value));
    chmodSync(join(value.targetDir, 'api.env'), 0o640);
    expect(() =>
      provisionTimewebBetaRuntimeSecrets(
        options(value, {
          releaseId: `${sourceSha}-12345678902-1`,
          expectedCurrentReleaseId: releaseId,
        }),
      ),
    ).toThrow('current_secret_file_security');
  });

  it('serializes rotations and deterministically recovers a dead transaction after backup', () => {
    const value = fixture();
    provisionTimewebBetaRuntimeSecrets(options(value));
    const nextRelease = `${sourceSha}-12345678902-1`;
    const incomingPath = join(value.targetParent, '.timeweb-beta.incoming-2147483647-recovery');
    const backupDir = join(value.backupRoot, `${releaseId}--replaced-by--${nextRelease}`);
    mkdirSync(incomingPath, { mode: 0o700 });
    renameSync(value.targetDir, backupDir);
    const lockPath = join(value.targetParent, '.timeweb-beta.provision.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema: 'PHUB_TIMEWEB_SECRET_PROVISION_TRANSACTION_V1',
        pid: 2147483647,
        releaseId: nextRelease,
        expectedCurrentReleaseId: releaseId,
        incomingPath,
        backupDir,
      })}\n`,
      { mode: 0o600 },
    );

    const result = provisionTimewebBetaRuntimeSecrets(
      options(value, { releaseId: nextRelease, expectedCurrentReleaseId: releaseId }),
    );
    expect(result.previousBackedUp).toBe(true);
    expect(installedReleaseId(value.targetDir)).toBe(nextRelease);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(incomingPath)).toBe(false);
  });

  it('parses only one terminal-newline environment record set', () => {
    expect(parseTimewebSecretEnvironment('ONE=value\n')).toEqual({ ONE: 'value' });
    expect(() => parseTimewebSecretEnvironment('ONE=value')).toThrow('terminal_newline');
    expect(() => parseTimewebSecretEnvironment('ONE=value\n\n')).toThrow('terminal_newline');
  });
});
