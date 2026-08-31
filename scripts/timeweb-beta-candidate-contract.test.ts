import { describe, expect, it } from 'vitest';
import { CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK } from '@phub/database';

import {
  assertCandidateIdentity,
  assertForwardOnlyRollback,
  assertRehearsalProjectName,
  assertRuntimeSnapshot,
  buildSyntheticRuntimeEnvironments,
  classifyWriteAttempt,
  loadTimewebRuntimeContracts,
  serializeEnvironment,
  TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK,
  TIMEWEB_COMPONENTS,
} from './timeweb-beta-candidate-contract.js';
import { validateRuntimeEnvironments } from './verify-timeweb-deployment-contract.js';

const sourceSha = '1'.repeat(40);
const sourceTree = '2'.repeat(40);

function candidateManifest(): Record<string, unknown> {
  return {
    schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
    gitCommit: sourceSha,
    gitTree: sourceTree,
    publication: {
      workflowSha: sourceSha,
      runId: '33357774310',
      runAttempt: 1,
    },
    images: TIMEWEB_COMPONENTS.map((component, index) => ({
      component,
      repository: `ghcr.io/z6v6e6r/phub-${component}`,
      digest: `sha256:${String(index + 1).repeat(64)}`,
      revision: sourceSha,
      sourceMaterialSha: sourceSha,
    })),
  };
}

describe('Timeweb beta candidate contract', () => {
  it('uses the canonical empty-database-only migration acknowledgement', () => {
    expect(TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK).toBe(CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK);
  });

  it('accepts an exact five-component candidate identity', () => {
    const identity = assertCandidateIdentity(candidateManifest(), { sourceSha, sourceTree });
    expect(identity.sourceSha).toBe(sourceSha);
    expect(identity.sourceTree).toBe(sourceTree);
    expect(identity.images.web).toBe(`ghcr.io/z6v6e6r/phub-web@sha256:${'1'.repeat(64)}`);
    expect(Object.keys(identity.images).sort()).toEqual([...TIMEWEB_COMPONENTS].sort());
  });

  it.each([
    ['wrong source SHA', (value: Record<string, unknown>) => (value.gitCommit = '3'.repeat(40))],
    ['wrong source tree', (value: Record<string, unknown>) => (value.gitTree = '3'.repeat(40))],
    [
      'wrong workflow SHA',
      (value: Record<string, unknown>) =>
        ((value.publication as Record<string, unknown>).workflowSha = '3'.repeat(40)),
    ],
    [
      'wrong image digest',
      (value: Record<string, unknown>) =>
        (((value.images as Record<string, unknown>[])[0] as Record<string, unknown>).digest =
          'sha256:not-a-digest'),
    ],
    [
      'wrong image source',
      (value: Record<string, unknown>) =>
        (((value.images as Record<string, unknown>[])[0] as Record<string, unknown>).revision =
          '3'.repeat(40)),
    ],
    [
      'component mismatch',
      (value: Record<string, unknown>) =>
        (((value.images as Record<string, unknown>[])[0] as Record<string, unknown>).component =
          'api'),
    ],
  ])('fails closed on %s', (_label, mutate) => {
    const value = candidateManifest();
    mutate(value);
    expect(() => assertCandidateIdentity(value, { sourceSha, sourceTree })).toThrow();
  });

  it('builds a complete synthetic environment with every write capability off', () => {
    const contracts = loadTimewebRuntimeContracts();
    const environments = buildSyntheticRuntimeEnvironments(contracts);
    expect(() =>
      validateRuntimeEnvironments(environments, contracts.runtime, contracts.target),
    ).not.toThrow();
    expect(environments.api?.GAMES_COMMANDS_ENABLED).toBe('false');
    expect(environments.api?.PARTICIPATION_COMMANDS_ENABLED).toBe('false');
    expect(environments.api?.GIFT_CERTIFICATE_PAYMENT_MODE).toBe('disabled');
    expect(environments.api?.SUBSCRIPTION_RUNTIME_WARN_MODE).toBe('OFF');
    expect(environments.worker?.GAMES_READ_ENABLED).toBe('false');
  });

  it.each([
    [
      'missing required environment key',
      (value: Record<string, Record<string, string>>) => delete value.api?.DATABASE_URL,
    ],
    [
      'malformed dependency URL',
      (value: Record<string, Record<string, string>>) => {
        if (value.api) value.api.DATABASE_URL = 'not-a-url';
      },
    ],
    [
      'enabled command flag',
      (value: Record<string, Record<string, string>>) => {
        if (value.api) value.api.GAMES_COMMANDS_ENABLED = 'true';
      },
    ],
    [
      'worker secret leak',
      (value: Record<string, Record<string, string>>) => {
        if (value.worker) value.worker.JWT_ACCESS_SECRET = 'not-allowed';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const contracts = loadTimewebRuntimeContracts();
    const environments = buildSyntheticRuntimeEnvironments(contracts);
    mutate(environments);
    expect(() =>
      validateRuntimeEnvironments(environments, contracts.runtime, contracts.target),
    ).toThrow();
  });

  it('rejects malformed env serialization and unsafe Compose project names', () => {
    expect(() => serializeEnvironment({ VALID: 'line\nleak' })).toThrow('env_serialization');
    expect(assertRehearsalProjectName('phub-tw-rehearsal-abc123')).toBe('phub-tw-rehearsal-abc123');
    expect(() => assertRehearsalProjectName('phub')).toThrow('compose_project_name');
    expect(() => assertRehearsalProjectName('../shared')).toThrow('compose_project_name');
  });

  it('binds every running component to exact image, source, tree and release labels', () => {
    const snapshots = (['web', 'api', 'worker'] as const).map((component) => ({
      component,
      configuredImage: `local/${component}:candidate`,
      healthy: true,
      labels: {
        'phub.release-id': 'candidate-release',
        'phub.source-sha': sourceSha,
        'phub.source-tree': sourceTree,
        'phub.rehearsal-only': 'true',
      },
    }));
    const expected = {
      releaseId: 'candidate-release',
      sourceSha,
      sourceTree,
      images: Object.fromEntries(
        snapshots.map(({ component, configuredImage }) => [component, configuredImage]),
      ),
    };
    expect(() => assertRuntimeSnapshot(snapshots, expected)).not.toThrow();
    expect(() =>
      assertRuntimeSnapshot(
        snapshots.map((entry) =>
          entry.component === 'api' ? { ...entry, configuredImage: 'local/api:wrong' } : entry,
        ),
        expected,
      ),
    ).toThrow('runtime_api_image');
  });

  it.each([
    ['POST', '/user/api/v1/padlhub/games', 'CREATE'],
    ['POST', `/user/api/v1/padlhub/games/${sourceSha}/join`, 'JOIN'],
    ['POST', '/public/api/v1/padlhub/gift-certificate-orders', 'PAYMENT'],
    ['POST', '/user/api/v1/padlhub/auth/viva/authorize', 'PROVIDER'],
    ['PUT', '/user/api/v1/padlhub/profile/privacy', 'OTHER'],
    ['GET', '/user/api/v1/padlhub/games', null],
    ['POST', '/user/api/v1/padlhub/auth/session/refresh', null],
  ])('classifies %s %s as %s', (method, path, expected) => {
    expect(classifyWriteAttempt(method, path)).toBe(expected);
  });

  it('permits only forward schema plus application-image rollback', () => {
    expect(() =>
      assertForwardOnlyRollback({
        candidateReleaseId: 'candidate',
        previousReleaseId: 'previous',
        databaseCommands: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertForwardOnlyRollback({
        candidateReleaseId: 'candidate',
        previousReleaseId: 'previous',
        databaseCommands: ['down migration'],
      }),
    ).toThrow('rollback_database_command');
  });
});
