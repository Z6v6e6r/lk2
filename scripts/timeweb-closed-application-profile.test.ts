import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CLOSED_APPLICATION_DATABASE_TARGET,
  CLOSED_APPLICATION_OPERATION_SCHEMAS,
  closedApplicationInputDigests,
  closedApplicationCommand,
  closedApplicationSchemas,
  closedApplicationRoleProbeSource,
  closedApplicationStateSql,
  assertClosedApplicationRuntimeOff,
  validateClosedApplicationOperation,
  validateClosedApplicationManifest,
} from './timeweb-closed-application-profile.js';
import { closedApplicationOperationFixture } from './timeweb-closed-application.fixture.js';

describe('closed host migration operation building blocks', () => {
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'pins target/source/input identity and fixed %s command',
    (profile) => {
      const value = closedApplicationOperationFixture(profile);
      expect(
        validateClosedApplicationOperation(value, Date.parse('2026-10-27T07:30:00.000Z')),
      ).toBe(value);
      expect(closedApplicationInputDigests(value).bootstrapSha256).toBe(value.bootstrapSha256);
      const command = closedApplicationCommand(value, 'migration');
      expect(command.slice(0, 3)).toEqual([
        'node',
        'apps/migrator/dist/main.js',
        profile === 'game_start_0103'
          ? '--game-start-migration-0103'
          : '--subject-link-migration-0104',
      ]);
      expect(JSON.parse(Buffer.from(command[3]!, 'base64').toString())).toEqual({
        ...CLOSED_APPLICATION_DATABASE_TARGET,
        catalogVariant: 'SCENARIO_EDITOR_V1',
      });
      expect(closedApplicationSchemas(profile).receipt).toContain(
        profile === 'game_start_0103' ? 'GAME_START_0103' : 'SUBJECT_LINK_0104',
      );
      expect(closedApplicationRoleProbeSource(profile)).toContain(
        "decodeURIComponent(url.username)!=='phub_migrator'",
      );
      expect(closedApplicationStateSql(profile, 'pre')).not.toContain('$1');
    },
  );
  it('rejects widening, swapped identities, stale authority and altered ACL intent', () => {
    const value = closedApplicationOperationFixture('game_start_0103');
    for (const mutation of [
      { ...value, extra: true },
      { ...value, profile: 'production' },
      { ...value, target: { ...value.target, projectId: 1 } },
      {
        ...value,
        expectedDatabaseTarget: { ...value.expectedDatabaseTarget, databaseName: 'another' },
      },
      { ...value, catalogVariant: 'AUTO' },
      { ...value, schema: CLOSED_APPLICATION_OPERATION_SCHEMAS.subject_link_0104 },
      { ...value, publishedMigrator: { ...value.publishedMigrator, sourceSha: 'f'.repeat(40) } },
      { ...value, bootstrapSha256: 'e'.repeat(64) },
      { ...value, expectedPrivilegePreimage: [] },
      {
        ...value,
        expectedSecretSetFiles: { ...value.expectedSecretSetFiles, 'extra.env': 'e'.repeat(64) },
      },
      {
        ...value,
        previousMigrationSuccess: {
          path: 'anything',
          sha256: 'e'.repeat(64),
          operationSha256: 'e'.repeat(64),
        },
      },
    ])
      expect(() => validateClosedApplicationOperation(mutation)).toThrow();
    expect(() => validateClosedApplicationOperation(value, Date.parse(value.expiresAt))).toThrow(
      'AUTHORITY',
    );
    expect(() => closedApplicationCommand(value, 'runtime')).toThrow('COMMAND_KIND');
    const subject = closedApplicationOperationFixture('subject_link_0104');
    expect(() =>
      validateClosedApplicationOperation({ ...subject, previousMigrationSuccess: null }),
    ).toThrow();
  });
  it('binds the published manifest to the same source, image and first publication attempt', () => {
    const value = closedApplicationOperationFixture('game_start_0103'),
      image = value.publishedMigrator;
    const manifest = {
      schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
      gitCommit: image.sourceSha,
      gitTree: image.sourceTree,
      publication: { runId: image.publicationRunId, runAttempt: 1 },
      images: [
        {
          component: 'migrator',
          digest: image.image.split('@')[1],
          runtimeDigest: image.imageId,
          revision: image.sourceSha,
        },
      ],
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const op = {
      ...value,
      publishedMigrator: {
        ...image,
        manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    expect(validateClosedApplicationManifest(op, manifest, bytes)).toBe(manifest);
    expect(() =>
      validateClosedApplicationManifest(op, { ...manifest, gitTree: 'f'.repeat(40) }, bytes),
    ).toThrow('MANIFEST');
    expect(() => validateClosedApplicationManifest(op, manifest, Buffer.from('{}'))).toThrow(
      'MANIFEST',
    );
  });
});

describe('closed runtime no-activation proof', () => {
  it('checks file bytes and container arrays without exposing other environment values', () => {
    const op = closedApplicationOperationFixture('game_start_0103');
    const env = {
      api: Buffer.from('AUTH_PHONE_SUBJECT_LINK_ENABLED=false\nOPAQUE_SECRET=synthetic_hidden\n'),
      worker: ['NOTIFICATION_SCENARIOS_ENABLED=false', 'LEGACY_GAME_REMINDERS_SOURCE_ENABLED=0'],
    };
    expect(assertClosedApplicationRuntimeOff(op, env)).toBe(true);
    for (const key of ['NOTIFICATION_SCENARIOS_ENABLED', 'LEGACY_GAME_REMINDERS_SOURCE_ENABLED'])
      expect(() =>
        assertClosedApplicationRuntimeOff(op, {
          ...env,
          worker: [...env.worker.filter((line) => !line.startsWith(key + '=')), key + '=true'],
        }),
      ).toThrow('RUNTIME_FLAGS');
    expect(() =>
      assertClosedApplicationRuntimeOff(op, {
        ...env,
        api: ['AUTH_PHONE_SUBJECT_LINK_ENABLED=true', 'OPAQUE_SECRET=synthetic_hidden'],
      }),
    ).toThrow('RUNTIME_FLAGS');
    expect(() =>
      assertClosedApplicationRuntimeOff(op, {
        ...env,
        worker: [...env.worker, 'NOTIFICATION_SCENARIOS_ENABLED=false'],
      }),
    ).toThrow('RUNTIME_ENV');
  });
  it('admits a missing new switch only with both pre-capability ancestry and absent source key', () => {
    const op = closedApplicationOperationFixture('game_start_0103'),
      env = { api: ['PATH=/synthetic'], worker: ['NOTIFICATION_SCENARIOS_ENABLED=false'] };
    const calls: string[][] = [];
    expect(
      assertClosedApplicationRuntimeOff(op, env, (args) => {
        calls.push(args);
        return args[0] === 'show' ? '// immutable older config without the feature' : '';
      }),
    ).toBe(true);
    expect(calls.filter((args) => args[0] === 'merge-base')).toHaveLength(2);
    expect(() => assertClosedApplicationRuntimeOff(op, env)).toThrow('RUNTIME_FLAGS');
    expect(() =>
      assertClosedApplicationRuntimeOff(op, env, (args) =>
        args[0] === 'show'
          ? 'LEGACY_GAME_REMINDERS_SOURCE_ENABLED AUTH_PHONE_SUBJECT_LINK_ENABLED'
          : '',
      ),
    ).toThrow('RUNTIME_FLAGS');
    expect(() =>
      assertClosedApplicationRuntimeOff(op, env, () => {
        throw Error('NOT_AN_ANCESTOR');
      }),
    ).toThrow('RUNTIME_FLAGS');
    expect(() =>
      assertClosedApplicationRuntimeOff(op, { api: env.api, worker: [] }, () => ''),
    ).toThrow('RUNTIME_FLAGS');
  });
});
