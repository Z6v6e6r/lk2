import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  CLOSED_APPLICATION_DATABASE_TARGET,
  CLOSED_APPLICATION_OPERATION_SCHEMAS,
  closedApplicationInputDigests,
  closedApplicationMigrationBackupDirectory,
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
    'admits optional R1-only32hex backup generation for%s without changing legacy path/bytes',
    (kind) => {
      for (const family of ['HISTORICAL108', 'R1_PACKAGE119'] as const) {
        const original = closedApplicationOperationFixture(kind, family);
        const before = JSON.stringify(original);
        expect(validateClosedApplicationOperation(original)).toBe(original);
        expect(JSON.stringify(original)).toBe(before);
        expect(closedApplicationMigrationBackupDirectory(original)).toBe(
          `/opt/phub/timeweb-beta/backups/${original.controllerSha}-${original.controllerSourceCiRunId}-1-${kind === 'game_start_0103' ? 'game-start-pre0103' : 'subject-link-pre0104'}`,
        );
        for (const generation of ['0'.repeat(32), 'a'.repeat(32)]) {
          const next = { ...original, backupGeneration: generation };
          if (family === 'HISTORICAL108')
            expect(() => validateClosedApplicationOperation(next)).toThrow('BACKUP_GENERATION');
          else {
            expect(validateClosedApplicationOperation(next)).toBe(next);
            expect(closedApplicationMigrationBackupDirectory(next)).toBe(
              `${closedApplicationMigrationBackupDirectory(original)}-generation-${generation}`,
            );
          }
        }
      }
      const original = closedApplicationOperationFixture(kind, 'R1_PACKAGE119');
      for (const backupGeneration of [
        undefined,
        null,
        1,
        '',
        'A'.repeat(32),
        'a'.repeat(31),
        'a'.repeat(33),
        'a'.repeat(32) + '\n',
        '../' + 'a'.repeat(29),
      ])
        expect(() => validateClosedApplicationOperation({ ...original, backupGeneration })).toThrow(
          'BACKUP_GENERATION',
        );
    },
  );
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
      publication: { runId: image.publicationRunId, runAttempt: '1' },
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
    for (const runAttempt of [1, 2, '2', '01', '1.0', true, null, ['1']]) {
      const invalid = { ...manifest, publication: { ...manifest.publication, runAttempt } };
      const invalidBytes = Buffer.from(JSON.stringify(invalid));
      const invalidOperation = {
        ...op,
        publishedMigrator: {
          ...image,
          manifestSha256: createHash('sha256').update(invalidBytes).digest('hex'),
        },
      };
      expect(() =>
        validateClosedApplicationManifest(invalidOperation, invalid, invalidBytes),
      ).toThrow('MANIFEST');
    }
    expect(() =>
      validateClosedApplicationManifest(op, { ...manifest, gitTree: 'f'.repeat(40) }, bytes),
    ).toThrow('MANIFEST');
    expect(() => validateClosedApplicationManifest(op, manifest, Buffer.from('{}'))).toThrow(
      'MANIFEST',
    );
  });
});

describe('closed runtime no-activation proof', () => {
  const retainedRevision = '702625eb669643c52bf69f55bc65c2e3e74f5ef9';
  const retainedSources = Object.fromEntries(
    ['packages/config/src/index.ts', 'apps/api/src/main.ts', 'apps/worker/src/main.ts'].map(
      (path) => [
        `${retainedRevision}:${path}`,
        execFileSync('/usr/bin/git', ['show', `${retainedRevision}:${path}`], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_PROMISOR_FETCH: '1',
          },
        }),
      ],
    ),
  );
  const retainedGit = (args: string[]) => {
    if (args.length !== 2 || args[0] !== 'show' || !retainedSources[args[1]!])
      throw Error('UNEXPECTED_GIT_READ');
    return retainedSources[args[1]!]!;
  };
  function retainedOperation() {
    const op = closedApplicationOperationFixture('game_start_0103');
    for (const [service, imageId] of [
      ['api', 'sha256:9e21147cd07700db19169e0a41b8d4b60873be90741067d17684bc676cd45838'],
      ['worker', 'sha256:32d5795114c20d900c22802dec27a3b8200c2bef755c94eba4b2a477152c92ec'],
    ] as const) {
      Object.assign(op[service === 'api' ? 'expectedApi' : 'expectedWorker'], {
        revision: retainedRevision,
        imageId,
        image: `ghcr.io/z6v6e6r/phub-${service}@${imageId}`,
      });
    }
    return op;
  }
  it('proves the retained parser defaults the three switches off without IO', () => {
    const exports: Record<string, (env: Record<string, string>) => Record<string, unknown>> = {};
    const require = createRequire(import.meta.url);
    const code = ts.transpileModule(
      retainedSources[`${retainedRevision}:packages/config/src/index.ts`]!,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    runInNewContext(
      code,
      {
        exports,
        require: (name: string) => {
          if (name === 'node:fs')
            return {
              readFileSync: () => {
                throw Error('UNEXPECTED_IO');
              },
            };
          if (!['node:crypto', 'node:net', 'zod'].includes(name)) throw Error('UNEXPECTED_IMPORT');
          return require(name) as unknown;
        },
        process: { env: {} },
      },
      { timeout: 1000 },
    );
    const env = {
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-characters',
    };
    expect(exports.loadConfig!(env).AUTH_PHONE_SUBJECT_LINK_ENABLED).toBe(false);
    expect(exports.loadWorkerConfig!(env)).toMatchObject({
      NOTIFICATION_SCENARIOS_ENABLED: false,
      LEGACY_GAME_REMINDERS_SOURCE_ENABLED: false,
    });
    expect(retainedSources[`${retainedRevision}:apps/api/src/main.ts`]).toContain('loadConfig()');
    expect(retainedSources[`${retainedRevision}:apps/worker/src/main.ts`]).toContain(
      'loadWorkerConfig(process.env)',
    );
  });
  it('admits absence in both env files and actual container arrays only for the retained images', () => {
    for (const env of [
      { api: [], worker: [] },
      { api: Buffer.from('PATH=/synthetic\n'), worker: Buffer.from('PATH=/synthetic\n') },
    ])
      expect(assertClosedApplicationRuntimeOff(retainedOperation(), env, retainedGit)).toBe(true);
  });
  it.each([
    ['api', 'AUTH_PHONE_SUBJECT_LINK_ENABLED'],
    ['worker', 'NOTIFICATION_SCENARIOS_ENABLED'],
    ['worker', 'LEGACY_GAME_REMINDERS_SOURCE_ENABLED'],
  ] as const)('never converts an explicit %s/%s value to default OFF', (service, key) => {
    for (const value of ['true', '1', '', 'TRUE', 'unexpected']) {
      const env = { api: [] as string[], worker: [] as string[] };
      env[service] = [`${key}=${value}`];
      expect(() =>
        assertClosedApplicationRuntimeOff(retainedOperation(), env, retainedGit),
      ).toThrow('RUNTIME_FLAGS');
    }
    const env = { api: [] as string[], worker: [] as string[] };
    env[service] = [`${key}=false`, `${key}=false`];
    expect(() => assertClosedApplicationRuntimeOff(retainedOperation(), env, retainedGit)).toThrow(
      'RUNTIME_ENV',
    );
  });
  it('rejects missing or modified parser/startup blobs and lookup failures', () => {
    for (const path of Object.keys(retainedSources)) {
      expect(() =>
        assertClosedApplicationRuntimeOff(retainedOperation(), { api: [], worker: [] }, (args) =>
          args[1] === path ? retainedGit(args) + '\n// changed' : retainedGit(args),
        ),
      ).toThrow('RUNTIME_FLAGS');
    }
    expect(() =>
      assertClosedApplicationRuntimeOff(retainedOperation(), { api: [], worker: [] }),
    ).toThrow('RUNTIME_FLAGS');
    expect(() =>
      assertClosedApplicationRuntimeOff(retainedOperation(), { api: [], worker: [] }, () => {
        throw Error('MISSING_OBJECT');
      }),
    ).toThrow('RUNTIME_FLAGS');
  });
  it.each(['expectedApi', 'expectedWorker'] as const)(
    'pins %s revision and both image identities',
    (key) => {
      for (const changed of [
        { revision: 'd'.repeat(40) },
        { imageId: 'sha256:' + 'd'.repeat(64) },
        { image: 'ghcr.io/z6v6e6r/phub-other@sha256:' + 'd'.repeat(64) },
      ]) {
        const op = retainedOperation();
        Object.assign(op[key], changed);
        expect(() =>
          assertClosedApplicationRuntimeOff(op, { api: [], worker: [] }, retainedGit),
        ).toThrow('RUNTIME_FLAGS');
      }
    },
  );
  it('does not let a safe file environment hide activation in an actual container', () => {
    const op = retainedOperation();
    expect(assertClosedApplicationRuntimeOff(op, { api: [], worker: [] }, retainedGit)).toBe(true);
    expect(() =>
      assertClosedApplicationRuntimeOff(
        op,
        {
          api: [],
          worker: ['NOTIFICATION_SCENARIOS_ENABLED=true'],
        },
        retainedGit,
      ),
    ).toThrow('RUNTIME_FLAGS');
  });
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
