import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStrictJson } from './strict-json.js';
import {
  buildRollbackSteps,
  buildCaddyContainmentInvocation,
  buildCaddyRecreateInvocation,
  buildIngressContainmentProbeInvocations,
  buildIngressSmokeInvocations,
  buildProspectiveCaddyExecution,
  buildProspectiveCaddyInvocation,
  executeCaddyTransition,
  parseContainerEnvironment,
  recoverFailedIngressTransition,
  validateCandidateContainerAttestation,
  validateCandidateReleaseEnvironment,
  validateOperationInput,
  validateEffectiveApiEnvironment,
  validateRecoveryReceipt,
  validateReceipt,
  validateRollbackFloor,
} from './control-timeweb-yandex-public-beta.js';
import {
  validateRuntimeContract,
  validateTargetContract,
} from './verify-timeweb-deployment-contract.js';

const target = validateTargetContract(
  parseStrictJson(readFileSync('deploy/timeweb/target.json', 'utf8')),
);
const runtimeContract = validateRuntimeContract(
  parseStrictJson(readFileSync('deploy/timeweb/runtime-environment.contract.json', 'utf8')),
);
const floor = parseStrictJson<Record<string, unknown>>(
  readFileSync('deploy/timeweb/yandex-public-beta-rollback-floor.json', 'utf8'),
);
const checksum = 'a'.repeat(64);
const candidateSourceSha = '1'.repeat(40);
const candidateSourceTree = '2'.repeat(40);
const candidateRunId = '12345678901';
const candidateReleaseId = `${candidateSourceSha}-${candidateRunId}-1`;
const candidateRuntimeEnvRoot = runtimeContract.rootOnlyDirectory;
const receipt = {
  schema: 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_RECEIPT_V2',
  status: 'PREPARED',
  hostname: 'lk2.padlhub.su',
  floorSourceSha: 'e6abb48e135f8f28730bab1c07abe408e8c94600',
  floorSourceTree: '04be9a04792b586d867ce6def129ad6bfb22a152',
  candidateSourceSha,
  candidateSourceTree,
  candidateReleaseId,
  candidateRuntimeEnvRoot,
  candidateRuntimeEnvSha256: {
    api: '9'.repeat(64),
    worker: 'a'.repeat(64),
    realtime: 'b'.repeat(64),
    migrator: 'c'.repeat(64),
  },
  candidateReleaseEnv: `/opt/phub/timeweb-beta/releases/${candidateReleaseId}/release.env`,
  candidateReleaseEnvSha256: 'e'.repeat(64),
  priorApiReference:
    'ghcr.io/z6v6e6r/phub-api@sha256:5878ed51206d5a301fb356f7a599ce4a57f870bf3d13e0b7165f079076d8603a',
  priorWebReference:
    'ghcr.io/z6v6e6r/phub-web@sha256:61221f1df778d44ccb1bda6ddf222cb6ec36ee0ef893d632134b9b569480a51a',
  candidateApiReference: `ghcr.io/z6v6e6r/phub-api@sha256:${'3'.repeat(64)}`,
  candidateWebReference: `ghcr.io/z6v6e6r/phub-web@sha256:${'4'.repeat(64)}`,
  activeCaddyfile: '/opt/phub/timeweb-beta/operator/Caddyfile',
  activeCaddySha256: checksum,
  activeCaddyAdaptedSha256: 'f'.repeat(64),
  backupCaddyfile: '/opt/phub/timeweb-beta/backups/yandex-public/Caddyfile.basic',
  backupCaddySha256: checksum,
  publicCaddyfile: '/opt/phub/timeweb-beta/releases/yandex-public/Caddyfile',
  publicCaddySha256: 'b'.repeat(64),
  publicCaddyAdaptedSha256: 'c'.repeat(64),
  applicationCompose: '/opt/phub/timeweb-beta/operator/compose.beta.yaml',
  ingressCompose: '/opt/phub/timeweb-beta/operator/compose.ingress.yaml',
  rollbackEnv: '/opt/phub/timeweb-beta/backups/yandex-public/rollback.env',
  preparedAt: '2026-08-29T08:00:00.000Z',
  complete: true,
} as const;
const v1RecoveryReceipt = {
  ...Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'candidateRuntimeEnvSha256'),
  ),
  schema: 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_RECEIPT_V1',
};

describe('Timeweb Yandex public-beta controller', () => {
  const candidateEnvironment = {
    PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_RELEASE_ENV_V1',
    REGISTRY: 'ghcr.io/z6v6e6r',
    PHUB_RELEASE_ID: candidateReleaseId,
    PHUB_RELEASE_SOURCE_SHA: candidateSourceSha,
    PHUB_RELEASE_SOURCE_TREE: candidateSourceTree,
    PHUB_PUBLICATION_WORKFLOW_SHA: candidateSourceSha,
    PHUB_PUBLICATION_RUN_ID: candidateRunId,
    PHUB_PUBLICATION_RUN_ATTEMPT: '1',
    PHUB_CANONICAL_MANIFEST_SHA256: '5'.repeat(64),
    PHUB_CANONICAL_RUN_EVIDENCE_SHA256: '6'.repeat(64),
    PHUB_CANONICAL_ARTIFACT_ID: '12345',
    PHUB_CANONICAL_ARTIFACT_NAME: `timeweb-amd64-canonical-release-${candidateSourceSha}-${candidateRunId}-1`,
    PHUB_CANONICAL_ARTIFACT_DIGEST: `sha256:${'7'.repeat(64)}`,
    TIMEWEB_RUNTIME_ENV_ROOT: candidateRuntimeEnvRoot,
    PHUB_API_RUNTIME_ENV_FILE: `${candidateRuntimeEnvRoot}/api.env`,
    PHUB_WORKER_RUNTIME_ENV_FILE: `${candidateRuntimeEnvRoot}/worker.env`,
    PHUB_REALTIME_RUNTIME_ENV_FILE: `${candidateRuntimeEnvRoot}/realtime.env`,
    PHUB_MIGRATOR_RUNTIME_ENV_FILE: `${candidateRuntimeEnvRoot}/migrator.env`,
    PHUB_WORKER_ENABLED: 'false',
    PHUB_MIGRATOR_ENABLED: 'false',
    COMPOSE_PROFILES: '',
    PHUB_ROLLBACK_PREVIOUS_RELEASE_ID: 'NONE',
    PHUB_ROLLBACK_MODE: 'stop-candidate-no-previous-release',
    WEB_IMAGE_DIGEST: `sha256:${'8'.repeat(64)}`,
    WEB_RUNTIME_DIGEST: `sha256:${'9'.repeat(64)}`,
    API_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    API_RUNTIME_DIGEST: `sha256:${'b'.repeat(64)}`,
    WORKER_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
    WORKER_RUNTIME_DIGEST: `sha256:${'d'.repeat(64)}`,
    REALTIME_IMAGE_DIGEST: `sha256:${'e'.repeat(64)}`,
    REALTIME_RUNTIME_DIGEST: `sha256:${'f'.repeat(64)}`,
    MIGRATOR_IMAGE_DIGEST: `sha256:${'1'.repeat(64)}`,
    MIGRATOR_RUNTIME_DIGEST: `sha256:${'2'.repeat(64)}`,
  } as const;
  const candidateOperation = {
    candidateSourceSha,
    candidateSourceTree,
    candidateReleaseId,
    candidateRuntimeEnvRoot,
  } as const;
  const encodeCandidateEnvironment = (overrides: Record<string, string> = {}) =>
    Buffer.from(
      `${Object.entries({ ...candidateEnvironment, ...overrides })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    );

  it('pins the noncanonical rollback floor without authorizing publication', () => {
    expect(validateRollbackFloor(floor, target)).toMatchObject({
      hostname: 'lk2.padlhub.su',
      canonicalPublication: false,
      authorizesPublication: false,
      failedPublicationRunProvenance: '33168712014',
    });
    expect(() => validateRollbackFloor({ ...floor, authorizesPublication: true }, target)).toThrow(
      'rollback_floor_identity',
    );
    expect(() => validateRollbackFloor({ ...floor, hostname: 'lk.padlhub.su' }, target)).toThrow(
      'rollback_floor_identity',
    );
  });

  it('rejects unsafe operation paths and mutable candidate image identities', () => {
    const input = {
      activeCaddyfile: '/opt/phub/timeweb-beta/operator/Caddyfile',
      applicationCompose: '/opt/phub/timeweb-beta/operator/compose.beta.yaml',
      ingressCompose: '/opt/phub/timeweb-beta/operator/compose.ingress.yaml',
      backupCaddyfile: '/opt/phub/timeweb-beta/backups/yandex-public/Caddyfile.basic',
      receipt: '/opt/phub/timeweb-beta/backups/yandex-public/receipt.json',
      rollbackEnv: '/opt/phub/timeweb-beta/backups/yandex-public/rollback.env',
      candidateSourceSha: '1'.repeat(40),
      candidateSourceTree: '2'.repeat(40),
      candidateReleaseId: `${'1'.repeat(40)}-12345678901-1`,
      candidateRuntimeEnvRoot,
      candidateReleaseEnv: `/opt/phub/timeweb-beta/releases/${'1'.repeat(40)}-12345678901-1/release.env`,
    };
    expect(validateOperationInput(input)).toMatchObject(input);
    expect(() => validateOperationInput({ ...input, receipt: '/tmp/receipt.json' })).toThrow(
      'operation_path',
    );
    expect(() =>
      validateOperationInput({
        ...input,
        receipt: '/opt/phub/timeweb-beta/backups/yandex-public/alternate-receipt.json',
      }),
    ).toThrow('receipt_path');
    expect(() =>
      validateOperationInput({
        ...input,
        activeCaddyfile: '/opt/phub/timeweb-beta/operator/not-compose-mounted.Caddyfile',
      }),
    ).toThrow('ingress_caddy_mount_identity');
    expect(() =>
      validateOperationInput({
        ...input,
        candidateReleaseEnv: '/opt/phub/timeweb-beta/releases/other/release.env',
      }),
    ).toThrow('candidate_release_env_identity');
    expect(() =>
      validateOperationInput({
        ...input,
        candidateRuntimeEnvRoot: `${candidateRuntimeEnvRoot}/${candidateReleaseId}`,
      }),
    ).toThrow('runtime_path');
  });

  it('uses one canonical runtime root across provisioner, renderer and controller', () => {
    expect(candidateRuntimeEnvRoot).toBe('/etc/phub/timeweb-beta');
    expect(readFileSync('scripts/provision-timeweb-beta-runtime-secrets.js', 'utf8')).toContain(
      "const TARGET_DIR = '/etc/phub/timeweb-beta';",
    );
    expect(readFileSync('scripts/render-timeweb-beta-release-env.js', 'utf8')).toContain(
      "const RUNTIME_ENV_ROOT = '/etc/phub/timeweb-beta';",
    );
    expect(
      validateOperationInput({
        activeCaddyfile: '/opt/phub/timeweb-beta/operator/Caddyfile',
        applicationCompose: '/opt/phub/timeweb-beta/operator/compose.beta.yaml',
        ingressCompose: '/opt/phub/timeweb-beta/operator/compose.ingress.yaml',
        backupCaddyfile: '/opt/phub/timeweb-beta/backups/yandex-public/Caddyfile.basic',
        receipt: '/opt/phub/timeweb-beta/backups/yandex-public/receipt.json',
        rollbackEnv: '/opt/phub/timeweb-beta/backups/yandex-public/rollback.env',
        candidateSourceSha,
        candidateSourceTree,
        candidateReleaseId,
        candidateRuntimeEnvRoot,
        candidateReleaseEnv: `/opt/phub/timeweb-beta/releases/${candidateReleaseId}/release.env`,
      }),
    ).toMatchObject({ candidateRuntimeEnvRoot });
  });

  it('binds candidate images to the canonical rendered release environment', () => {
    expect(
      validateCandidateReleaseEnvironment(encodeCandidateEnvironment(), candidateOperation),
    ).toMatchObject({
      PHUB_RELEASE_ID: candidateReleaseId,
      API_IMAGE_DIGEST: candidateEnvironment.API_IMAGE_DIGEST,
      WEB_IMAGE_DIGEST: candidateEnvironment.WEB_IMAGE_DIGEST,
    });
    expect(() =>
      validateCandidateReleaseEnvironment(
        encodeCandidateEnvironment({ API_IMAGE_DIGEST: 'latest' }),
        candidateOperation,
      ),
    ).toThrow('release_env_image_identity');
    expect(() =>
      validateCandidateReleaseEnvironment(
        encodeCandidateEnvironment({ PHUB_WORKER_ENABLED: 'true' }),
        candidateOperation,
      ),
    ).toThrow('release_env_identity');
    expect(() =>
      validateCandidateReleaseEnvironment(
        encodeCandidateEnvironment({ PHUB_CANONICAL_ARTIFACT_NAME: 'operator-authored' }),
        candidateOperation,
      ),
    ).toThrow('release_env_identity');
  });

  it('requires healthy candidate containers to attest the exact release id', () => {
    const expected = { image: receipt.candidateApiReference, releaseId: candidateReleaseId };
    expect(
      validateCandidateContainerAttestation({ ...expected, health: 'healthy' }, expected),
    ).toMatchObject(expected);
    expect(() =>
      validateCandidateContainerAttestation(
        { ...expected, health: 'healthy', releaseId: `${candidateReleaseId}-stale` },
        expected,
      ),
    ).toThrow('candidate_container_attestation');
  });

  it('attests the effective API environment without exposing secret values', () => {
    const secret = 'not-for-error-output';
    const expected = {
      AUTH_COOKIE_SECURE: 'true',
      VIVA_OAUTH_ALLOWED_PROVIDERS: 'yandex',
      JWT_ACCESS_SECRET: secret,
      GAMES_COMMANDS_ENABLED: 'false',
    };
    const contract = {
      allowed: Object.keys(expected),
      forbidden: ['AUTH_DEV_OTP_CODE'],
    };
    const entries = [
      ...Object.entries(expected).map(([key, value]) => `${key}=${value}`),
      'NODE_ENV=production',
      'PATH=/usr/local/bin:/usr/bin:/bin',
    ];
    expect(validateEffectiveApiEnvironment(entries, expected, contract)).toEqual({
      status: 'attested',
    });
    expect(() => parseContainerEnvironment([...entries, 'NODE_ENV=duplicate'])).toThrow(
      'container_environment',
    );
    for (const invalid of [
      entries.filter((entry) => !entry.startsWith('AUTH_COOKIE_SECURE=')),
      entries.map((entry) =>
        entry === 'VIVA_OAUTH_ALLOWED_PROVIDERS=yandex'
          ? 'VIVA_OAUTH_ALLOWED_PROVIDERS=all'
          : entry,
      ),
      entries.map((entry) => (entry === 'NODE_ENV=production' ? 'NODE_ENV=development' : entry)),
      [...entries, 'AUTH_DEV_OTP_CODE=123456'],
      [...entries, 'UNREVIEWED_WRITE_ENABLED=true'],
      [...entries, 'VIVA_SYSTEM_KEY=unexpected'],
      [...entries, 'NODE_OPTIONS=--require=/tmp/injected.js'],
    ]) {
      let message = '';
      try {
        validateEffectiveApiEnvironment(invalid, expected, contract);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('api_environment_attestation');
      expect(message).not.toContain(secret);
    }
  });

  it('binds the receipt hashes and restores Basic before either old container', () => {
    expect(validateRecoveryReceipt(receipt)).toMatchObject({ complete: true, status: 'PREPARED' });
    expect(validateRecoveryReceipt(v1RecoveryReceipt)).toMatchObject({
      schema: 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_RECEIPT_V1',
      complete: true,
    });
    expect(() => validateReceipt(v1RecoveryReceipt)).toThrow('receipt_identity');
    expect(validateReceipt(receipt)).toMatchObject({ complete: true, status: 'PREPARED' });
    expect(() => validateReceipt({ ...receipt, backupCaddySha256: 'd'.repeat(64) })).toThrow(
      'receipt_recovery_identity',
    );
    expect(() =>
      validateReceipt({
        ...receipt,
        candidateRuntimeEnvSha256: {
          ...receipt.candidateRuntimeEnvSha256,
          api: 'not-a-hash',
        },
      }),
    ).toThrow('runtime_environment_receipt_mismatch');
    const steps = buildRollbackSteps(receipt);
    expect(steps.slice(0, 3)).toEqual([
      'restore-basic-caddy',
      'validate-basic-caddy-offline',
      'recreate-basic-caddy',
    ]);
    expect(steps.indexOf('restore-api')).toBeLessThan(steps.indexOf('restore-web'));
  });

  it('uses offline pinned-image validation and force-recreates Caddy with no reload path', () => {
    const validation = buildProspectiveCaddyInvocation('validate');
    expect(validation).toMatchObject({ command: '/usr/bin/docker' });
    expect(validation.args).toEqual(
      expect.arrayContaining([
        '--pull',
        'never',
        '-i',
        '--network',
        'none',
        '--read-only',
        '--user',
        '65534:65534',
        '--entrypoint',
        '/usr/bin/caddy',
        'validate',
        '--config',
        '-',
      ]),
    );
    expect(validation.args.join(' ')).not.toContain('type=bind');
    const recreate = buildCaddyRecreateInvocation(receipt);
    expect(recreate.args.slice(-7)).toEqual([
      'up',
      '--pull',
      'never',
      '-d',
      '--no-deps',
      '--force-recreate',
      'caddy',
    ]);
    expect([...validation.args, ...recreate.args]).not.toContain('reload');
    const containment = buildCaddyContainmentInvocation(receipt);
    expect(containment.args.slice(-4)).toEqual(['stop', '--timeout', '10', 'caddy']);
    expect(containment.args).not.toContain('down');
  });

  it('falls back from Basic restoration to verified ingress containment', () => {
    const events: string[] = [];
    expect(
      recoverFailedIngressTransition({
        restoreBasic: () => events.push('restore-basic'),
        containIngress: () => events.push('contain-ingress'),
      }),
    ).toBe('basic_restored');
    expect(events).toEqual(['restore-basic']);

    events.length = 0;
    expect(
      recoverFailedIngressTransition({
        restoreBasic: () => {
          events.push('restore-basic');
          throw new Error('restore failed');
        },
        containIngress: () => events.push('contain-ingress'),
      }),
    ).toBe('ingress_stopped');
    expect(events).toEqual(['restore-basic', 'contain-ingress']);

    expect(() =>
      recoverFailedIngressTransition({
        restoreBasic: () => {
          throw new Error('restore failed');
        },
        containIngress: () => {
          throw new Error('containment failed');
        },
      }),
    ).toThrow('ingress_state_unknown');
    expect(buildIngressContainmentProbeInvocations()).toHaveLength(2);
  });

  it('streams a protected 0600 Basic backup over stdin instead of bind-mounting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-caddy-stdin-'));
    const backup = join(directory, 'Caddyfile.basic');
    try {
      writeFileSync(backup, '{\n\tadmin off\n}\n', { mode: 0o600 });
      chmodSync(backup, 0o600);
      const execution = buildProspectiveCaddyExecution(backup, 'validate');
      expect(execution.input.toString('utf8')).toBe('{\n\tadmin off\n}\n');
      expect(execution.args).toContain('-i');
      expect(execution.args).toEqual(expect.arrayContaining(['--config', '-']));
      expect(execution.args.join(' ')).not.toContain(backup);
      expect(execution.args.join(' ')).not.toContain('type=bind');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('executes validate-install-recreate in order and stops before install on validation failure', () => {
    const events: string[] = [];
    const hashes = new Map([
      ['/source', 'a'.repeat(64)],
      ['/active', 'old'],
    ]);
    executeCaddyTransition('/source', '/active', 'a'.repeat(64), 'b'.repeat(64), {
      hash: (path: string) => hashes.get(path)!,
      validate: () => events.push('validate'),
      install: () => {
        events.push('install');
        hashes.set('/active', 'a'.repeat(64));
      },
      recreate: () => events.push('recreate'),
    });
    expect(events).toEqual(['validate', 'install', 'recreate']);

    events.length = 0;
    expect(() =>
      executeCaddyTransition('/source', '/active', 'a'.repeat(64), 'b'.repeat(64), {
        hash: () => 'a'.repeat(64),
        validate: () => {
          events.push('validate');
          throw new Error('invalid');
        },
        install: () => events.push('install'),
        recreate: () => events.push('recreate'),
      }),
    ).toThrow('invalid');
    expect(events).toEqual(['validate']);
  });

  it('smokes public redirect, Web, readiness and a denied mutation without credentials', () => {
    const publicSmoke = buildIngressSmokeInvocations('public');
    expect(publicSmoke).toHaveLength(4);
    expect(publicSmoke[0]).toEqual(expect.arrayContaining(['--head', 'http://lk2.padlhub.su/']));
    expect(publicSmoke[1]).toContain('https://lk2.padlhub.su/');
    expect(publicSmoke[2]).toContain('https://lk2.padlhub.su/health/ready');
    expect(publicSmoke[3]).toEqual(
      expect.arrayContaining([
        '--request',
        'POST',
        'https://lk2.padlhub.su/user/api/v1/local-padel/profile',
      ]),
    );
    const basicSmoke = buildIngressSmokeInvocations('basic');
    expect(basicSmoke).toHaveLength(5);
    expect(basicSmoke[0]).toContain('https://lk2.padlhub.su/');
    expect(basicSmoke[1]).toContain(
      'https://lk2.padlhub.su/user/api/v1/local-padel/auth/viva/authorize',
    );
    expect(basicSmoke[2]).toContain('https://lk2.padlhub.su/public/api/v1/local-padel/games');
    expect(basicSmoke[3]).toContain('https://lk2.padlhub.su/user/api/v1/local-padel/profile');
    expect(basicSmoke[4]).toContain('https://lk2.padlhub.su/realtime/health/ready');
    expect(JSON.stringify([...publicSmoke, ...basicSmoke])).not.toMatch(/authorization|password/u);
  });

  it('contains no pull, migration, database or destructive cleanup operation', () => {
    const source = readFileSync('scripts/control-timeweb-yandex-public-beta.js', 'utf8');
    expect(source).not.toMatch(/['"]pull['"]|db:migrate|\bpsql\b|\bpg_dump\b|rmSync|unlinkSync/u);
    expect(source).not.toMatch(/['"]reload['"]/u);
    expect(source).toContain("'--no-deps'");
    expect(source).toContain('const apiId = assertHealthyContainer(');
    expect(source).toContain("assertHealthyContainer('web', receipt.candidateWebReference,");
    expect(source).toContain('verifyMountedCaddy(receipt, receipt.activeCaddyAdaptedSha256);');
    expect(source).toContain("verifyIngressSmoke('basic');");
    expect(source).toContain('verifyTimewebObservabilityEvidenceForActivation({');
    expect(source).toContain("fail('observability_gate')");
    expect(source.indexOf('readRecoveryReceipt(receiptPath)')).toBeLessThan(
      source.indexOf('readActivationReceipt(receiptPath)'),
    );
    const rollbackSource = source.slice(
      source.indexOf('export function rollback(receiptPath)'),
      source.indexOf('function parseArguments'),
    );
    expect(rollbackSource.indexOf('readRecoveryReceipt(receiptPath)')).toBeLessThan(
      rollbackSource.indexOf('readReceipt(receiptPath)'),
    );
    expect(rollbackSource.indexOf('recoverIngress(recoveryReceipt)')).toBeLessThan(
      rollbackSource.indexOf('readReceipt(receiptPath)'),
    );
    expect(source).toContain('const recovery = recoverIngress(receipt);');
    expect(source).toContain("fail('ingress_state_unknown')");
  });
});
