import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK } from '@phub/database';

import {
  assertCandidateIdentity,
  assertDistinctCandidatePair,
  assertForwardOnlyRollback,
  assertRehearsalProjectName,
  assertRuntimeSnapshot,
  buildSyntheticRuntimeEnvironments,
  classifyWriteAttempt,
  loadTimewebRuntimeContracts,
  readCandidateArtifact,
  serializeEnvironment,
  TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK,
  TIMEWEB_COMPONENTS,
} from './timeweb-beta-candidate-contract.js';
import {
  canonicalManifest,
  runId as fixtureRunId,
  sourceSha as fixtureSourceSha,
  sourceTree as fixtureSourceTree,
  writeCanonicalPair,
} from './timeweb-beta-activation-inputs.fixture.js';
import { validateRuntimeEnvironments } from './verify-timeweb-deployment-contract.js';

const sourceSha = '1'.repeat(40);
const sourceTree = '2'.repeat(40);
const publicationRunId = '33357774310';

function candidateManifest(): Record<string, unknown> {
  return {
    schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
    gitCommit: sourceSha,
    gitTree: sourceTree,
    publication: {
      workflowSha: sourceSha,
      runId: publicationRunId,
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
    const identity = assertCandidateIdentity(candidateManifest(), {
      sourceSha,
      sourceTree,
      publicationRunId,
    });
    expect(identity.sourceSha).toBe(sourceSha);
    expect(identity.sourceTree).toBe(sourceTree);
    expect(identity.images.web).toBe(`ghcr.io/z6v6e6r/phub-web@sha256:${'1'.repeat(64)}`);
    expect(Object.keys(identity.images).sort()).toEqual([...TIMEWEB_COMPONENTS].sort());
  });

  it('rejects a previous publication that would exercise the same source or binaries', () => {
    const candidate = {
      ...assertCandidateIdentity(candidateManifest(), { sourceSha, sourceTree, publicationRunId }),
      manifestSha256: 'a'.repeat(64),
    };
    expect(() =>
      assertDistinctCandidatePair(candidate, { ...candidate, runId: '33357774309' }),
    ).toThrow('previous_candidate_source_not_distinct');

    const previous = {
      ...candidate,
      sourceSha: '3'.repeat(40),
      sourceTree: '4'.repeat(40),
      images: { ...candidate.images },
    };
    expect(() => assertDistinctCandidatePair(candidate, previous)).toThrow(
      'previous_candidate_web_image_not_distinct',
    );

    const distinctImages = Object.fromEntries(
      TIMEWEB_COMPONENTS.map((component, index) => [
        component,
        `ghcr.io/z6v6e6r/phub-${component}@sha256:${String((index + 6) % 10).repeat(64)}`,
      ]),
    ) as Record<(typeof TIMEWEB_COMPONENTS)[number], string>;
    expect(() =>
      assertDistinctCandidatePair(candidate, {
        ...previous,
        images: { ...distinctImages, realtime: candidate.images.realtime },
      }),
    ).toThrow('previous_candidate_realtime_image_not_distinct');
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
      'wrong publication run',
      (value: Record<string, unknown>) =>
        ((value.publication as Record<string, unknown>).runId = '33357774311'),
    ],
    [
      'wrong image digest',
      (value: Record<string, unknown>) =>
        (((value.images as Record<string, unknown>[])[0] as Record<string, unknown>).digest =
          'sha256:not-a-digest'),
    ],
    [
      'missing component',
      (value: Record<string, unknown>) => (value.images as Record<string, unknown>[]).pop(),
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
    expect(() =>
      assertCandidateIdentity(value, { sourceSha, sourceTree, publicationRunId }),
    ).toThrow();
  });

  it('rejects a different valid digest against the caller-frozen manifest checksum', () => {
    const root = mkdtempSync(join(tmpdir(), 'timeweb-candidate-contract-'));
    try {
      const frozen = writeCanonicalPair(join(root, 'frozen'));
      const changed = canonicalManifest();
      changed.images[0]!.digest = `sha256:${'f'.repeat(64)}`;
      const changedPair = writeCanonicalPair(join(root, 'changed'), changed);
      expect(() =>
        readCandidateArtifact(changedPair.manifestPath, {
          sourceSha: fixtureSourceSha,
          sourceTree: fixtureSourceTree,
          publicationRunId: fixtureRunId,
          manifestSha256: frozen.checksum,
        }),
      ).toThrow('manifest_expected_checksum_mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const snapshots = (['web', 'api', 'realtime', 'worker'] as const).map((component) => ({
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
