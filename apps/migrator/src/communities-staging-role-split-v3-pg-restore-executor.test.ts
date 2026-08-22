import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, writeFile } from 'node:fs/promises';
import type { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
} from '@phub/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./communities-staging-role-split-pg-restore-runner.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runCommunitiesStagingRoleSplitPgRestore: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { readFile: typeof readFile }>();
  return {
    ...actual,
    readFile: vi.fn((...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string' && path.startsWith('/proc/self/fdinfo/'))
        return Promise.resolve('pos:\t0\nflags:\t0100000\n');
      return actual.readFile(args[0] as never, args[1] as never);
    }),
  };
});

import {
  CommunitiesStagingRoleSplitV3PgRestoreExecutor,
  type CommunitiesStagingRoleSplitV3PgRestoreExecutorConfig,
} from './communities-staging-role-split-v3-pg-restore-executor.js';
import { COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY } from './communities-staging-role-split-ddl-fence.js';
import { runCommunitiesStagingRoleSplitPgRestore } from './communities-staging-role-split-pg-restore-runner.js';
import {
  createCommunitiesStagingRoleSplitV3Fixture,
  fixtureSha,
} from './communities-staging-role-split-v3-test-fixtures.js';

const runner = vi.mocked(runCommunitiesStagingRoleSplitPgRestore);

async function fixture() {
  const values = createCommunitiesStagingRoleSplitV3Fixture();
  const directory = await mkdtemp(join(tmpdir(), 'phub-v3-executor-'));
  const archivePath = join(directory, 'archive.dump');
  const passwordPath = join(directory, 'pgpass');
  const executablePath = join(directory, 'pg_restore');
  await Promise.all([
    writeFile(archivePath, 'archive'),
    writeFile(passwordPath, 'pgpass'),
    writeFile(executablePath, 'executable'),
  ]);
  await Promise.all([
    chmod(archivePath, 0o600),
    chmod(passwordPath, 0o600),
    chmod(executablePath, 0o600),
  ]);
  const archiveFile = await open(archivePath, 'r');
  const archiveStat = archiveFile.stat.bind(archiveFile);
  vi.spyOn(archiveFile, 'stat').mockImplementation(async () =>
    Object.assign(await archiveStat(), {
      uid: 0,
      gid: process.getgid?.() ?? -1,
      mode: 0o100440,
      nlink: 1,
    }),
  );
  const passwordFile = await open(passwordPath, 'r');
  const executableFile = await open(executablePath, 'r');
  const calls: string[] = [];
  const fence = {
    subjectSha256: values.executionAuthorization.components.ddlFenceSha256,
    assertHeld: () => {
      calls.push('assert');
      return Promise.resolve();
    },
  };
  const target = {
    database: values.request.restoreDatabase,
    databaseOid: values.executionAuthorization.cloneDatabaseOid,
    sourceDatabase: values.request.sourceDatabase,
    systemIdentifier: values.request.systemIdentifier,
    postgresMajor: '16' as const,
    connectionUser: values.hostAuthorization.execution.restoreLogin.name,
    connectionUserOid: values.hostAuthorization.execution.restoreLogin.oid,
    restoreRole: values.hostAuthorization.execution.restoreLogin.name,
    restoreRoleOid: values.hostAuthorization.execution.restoreLogin.oid,
    host: '127.0.0.1',
    port: '5432',
    sslMode: 'disable' as const,
  };
  const config = {
    request: values.request,
    cloneCreationAuthorization: values.cloneCreationAuthorization,
    hostAuthorization: values.hostAuthorization,
    restoreAuthorization: values.restoreAuthorization,
    durableRestoreAuthorization: values.durableRestoreAuthorization,
    executionAuthorization: values.executionAuthorization,
    expectedExecutionAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
      values.executionAuthorization,
    ),
    restorePendingEnvelope: values.restorePendingEnvelope,
    target,
    connectionFactory: {
      subjectSha256: values.executionAuthorization.components.cloneOnlyConnectionFactorySha256,
      preflight: () =>
        Promise.resolve({
          database: target.database,
          databaseOid: target.databaseOid,
          systemIdentifier: target.systemIdentifier,
          postgresMajor: '16',
          sessionUser: target.connectionUser,
          sessionUserOid: target.connectionUserOid,
          currentUser: target.restoreRole,
          currentUserOid: target.restoreRoleOid,
        }),
    },
    fence,
    expectedPgRestoreSha256: values.hostAuthorization.execution.pgRestoreSha256,
    passwordFile,
    executableFile,
    preflightTimeoutMs: 1_000,
    restoreTimeoutMs: 1_000,
    subjectSha256: values.executionAuthorization.components.runnerAdapterSha256,
  } satisfies CommunitiesStagingRoleSplitV3PgRestoreExecutorConfig;
  const input = {
    request: values.request,
    cloneDatabaseOid: values.executionAuthorization.cloneDatabaseOid,
    restorePendingEnvelopeBytes: canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(
      values.restorePendingEnvelope,
    ),
    externalFenceLease: {
      requestSha256: values.requestSha256,
      systemIdentifier: values.request.systemIdentifier,
      backendPid: '4242',
      fencingToken: fixtureSha('fence-token'),
      advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
    },
    archiveFile,
  } as const;
  return {
    values,
    directory,
    archivePath,
    archiveFile,
    passwordFile,
    executableFile,
    calls,
    config,
    input,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  runner.mockReset();
});

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
});

describe('CommunitiesStagingRoleSplitV3PgRestoreExecutor', () => {
  it('dispatches only after exact pending/fence/archive checks, returns a post-run observation, and closes nothing', async () => {
    const current = await fixture();
    runner.mockResolvedValueOnce({ discardedOutputBytes: 7 });
    const closeArchive = vi.spyOn(current.archiveFile, 'close');
    const closePassword = vi.spyOn(current.passwordFile, 'close');
    const closeExecutable = vi.spyOn(current.executableFile, 'close');
    try {
      const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor(current.config);
      await expect(executor.restore(current.input)).resolves.toMatchObject({
        discardedOutputBytes: 7,
        archiveObservation: {
          bytes: '7',
          preSha256: createHash('sha256').update('archive').digest('hex'),
        },
      });
      expect(runner).toHaveBeenCalledOnce();
      expect(current.calls).toEqual(['assert', 'assert', 'assert']);
      expect(closeArchive).not.toHaveBeenCalled();
      expect(closePassword).not.toHaveBeenCalled();
      expect(closeExecutable).not.toHaveBeenCalled();
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it.each([
    [
      'noncanonical pending',
      (input: Awaited<ReturnType<typeof fixture>>['input']) => ({
        ...input,
        restorePendingEnvelopeBytes: `${input.restorePendingEnvelopeBytes}\n`,
      }),
    ],
    [
      'wrong phase',
      (input: Awaited<ReturnType<typeof fixture>>['input']) => ({
        ...input,
        restorePendingEnvelopeBytes: '{}',
      }),
    ],
    [
      'foreign lease',
      (input: Awaited<ReturnType<typeof fixture>>['input']) => ({
        ...input,
        externalFenceLease: { ...input.externalFenceLease, requestSha256: fixtureSha('foreign') },
      }),
    ],
  ])('rejects %s before runner dispatch', async (_name, makeInput) => {
    const current = await fixture();
    try {
      const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor(current.config);
      await expect(executor.restore(makeInput(current.input))).rejects.toMatchObject({
        code: 'PENDING_INVALID',
      });
      expect(runner).not.toHaveBeenCalled();
      expect(current.calls).toEqual([]);
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it.each([
    ['host', { host: '127.0.0.2' }],
    ['port', { port: '5433' }],
    ['ssl mode', { sslMode: 'require' as const }],
    ['remote verify-full', { host: 'db.example.test', sslMode: 'verify-full' as const }],
  ])(
    'rejects %s transport drift before touching fence, preflight, or runner',
    async (_name, target) => {
      const current = await fixture();
      try {
        expect(
          () =>
            new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
              ...current.config,
              target: { ...current.config.target, ...target },
            }),
        ).toThrow(/BINDING_INVALID/);
        expect(current.calls).toEqual([]);
        expect(runner).not.toHaveBeenCalled();
      } finally {
        await current.archiveFile.close();
        await current.passwordFile.close();
        await current.executableFile.close();
      }
    },
  );

  it('rejects a self-consistent durable authorization digest that drifts from the pending envelope', async () => {
    const current = await fixture();
    try {
      const durableRestoreAuthorization = {
        ...current.config.durableRestoreAuthorization,
        restorePendingEnvelopeSha256: fixtureSha('different pending envelope'),
      };
      const executionAuthorization = {
        ...current.config.executionAuthorization,
        durableRestoreAuthorizationSha256:
          communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(
            durableRestoreAuthorization,
          ),
      };
      expect(
        () =>
          new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
            ...current.config,
            durableRestoreAuthorization,
            executionAuthorization,
            expectedExecutionAuthorizationSha256:
              communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(executionAuthorization),
          }),
      ).toThrow(/BINDING_INVALID/);
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it('rejects executor digest/DAG drift and descriptor aliasing before a runner exists', async () => {
    const current = await fixture();
    try {
      expect(
        () =>
          new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
            ...current.config,
            expectedExecutionAuthorizationSha256: fixtureSha('wrong'),
          }),
      ).toThrow(/BINDING_INVALID/);
      expect(
        () =>
          new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
            ...current.config,
            subjectSha256: fixtureSha('wrong'),
          }),
      ).toThrow(/BINDING_INVALID/);
      const duplicateArchive = await open(current.archivePath, 'r');
      const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
        ...current.config,
        passwordFile: duplicateArchive,
      });
      await expect(executor.restore(current.input)).rejects.toMatchObject({
        code: 'PENDING_INVALID',
      });
      expect(runner).not.toHaveBeenCalled();
      expect(current.calls).toEqual([]);
      await duplicateArchive.close();
      const duplicateExecutable = await open(current.archivePath, 'r');
      const executableAlias = new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
        ...current.config,
        executableFile: duplicateExecutable,
      });
      await expect(executableAlias.restore(current.input)).rejects.toMatchObject({
        code: 'PENDING_INVALID',
      });
      expect(runner).not.toHaveBeenCalled();
      expect(current.calls).toEqual([]);
      await duplicateExecutable.close();
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it('requires a second held-fence assertion after archive validation and before dispatch', async () => {
    const current = await fixture();
    const assertions: string[] = [];
    try {
      const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor({
        ...current.config,
        fence: {
          subjectSha256: current.config.fence.subjectSha256,
          assertHeld: () => {
            assertions.push('assert');
            return assertions.length === 2 ? Promise.reject(new Error('lost')) : Promise.resolve();
          },
        },
      });
      await expect(executor.restore(current.input)).rejects.toMatchObject({ code: 'FENCE_LOST' });
      expect(assertions).toEqual(['assert', 'assert']);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it('rejects a same-UID mutable archive before runner dispatch', async () => {
    const current = await fixture();
    const observedArchiveStat = await current.archiveFile.stat();
    vi.spyOn(current.archiveFile, 'stat').mockResolvedValue(
      Object.assign(observedArchiveStat, {
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? -1,
        mode: 0o100600,
        nlink: 1,
      }),
    );
    try {
      const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor(current.config);
      await expect(executor.restore(current.input)).rejects.toMatchObject({
        code: 'ARCHIVE_CUSTODY_INVALID',
      });
      expect(current.calls).toEqual(['assert']);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it('normalizes all dispatched runner/fence/archive outcomes and cannot be reused or concurrently dispatched', async () => {
    const current = await fixture();
    let resolveRunner: (() => void) | undefined;
    runner.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRunner = () => resolve({ discardedOutputBytes: 0 });
        }),
    );
    try {
      const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor(current.config);
      const first = executor.restore(current.input);
      await expect(executor.restore(current.input)).rejects.toMatchObject({
        code: 'CAPABILITY_ALREADY_USED',
      });
      await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
      resolveRunner?.();
      await expect(first).resolves.toMatchObject({ discardedOutputBytes: 0 });
      await expect(executor.restore(current.input)).rejects.toMatchObject({
        code: 'CAPABILITY_ALREADY_USED',
      });
    } finally {
      await current.archiveFile.close();
      await current.passwordFile.close();
      await current.executableFile.close();
    }
  });

  it('maps runner failure, oversized output, and post-run archive mutation to one ambiguous outcome', async () => {
    for (const mode of ['failure', 'output', 'mutation'] as const) {
      runner.mockReset();
      const current = await fixture();
      if (mode === 'failure')
        runner.mockRejectedValueOnce(new Error('nonzero/timeout/response loss'));
      else if (mode === 'output')
        runner.mockResolvedValueOnce({ discardedOutputBytes: 8 * 1024 + 1 });
      else
        runner.mockImplementationOnce(async () => {
          await writeFile(current.archivePath, 'mutated');
          return { discardedOutputBytes: 0 };
        });
      try {
        const executor = new CommunitiesStagingRoleSplitV3PgRestoreExecutor(current.config);
        await expect(executor.restore(current.input)).rejects.toMatchObject({
          code: 'RESTORE_OUTCOME_AMBIGUOUS',
        });
      } finally {
        await current.archiveFile.close();
        await current.passwordFile.close();
        await current.executableFile.close();
      }
    }
  });
});
