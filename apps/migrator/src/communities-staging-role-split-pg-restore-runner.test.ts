import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
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
  runCommunitiesStagingRoleSplitPgRestore,
  type CommunitiesStagingRoleSplitPgRestoreTarget,
  type CommunitiesStagingRoleSplitPgRestoreRunnerConfig,
} from './communities-staging-role-split-pg-restore-runner.js';

const spawnMock = vi.mocked(spawn);
const target = {
  database: 'phub_restore_123_verify',
  databaseOid: '45678',
  sourceDatabase: 'phub_staging_verify',
  systemIdentifier: '7421000000000000000',
  postgresMajor: '16',
  connectionUser: 'phub_restore_login',
  connectionUserOid: '16384',
  restoreRole: 'phub_restore_owner',
  restoreRoleOid: '16385',
  host: '127.0.0.1',
  port: '5432',
  sslMode: 'disable',
} as const;
const observation = {
  database: target.database,
  databaseOid: target.databaseOid,
  systemIdentifier: target.systemIdentifier,
  postgresMajor: '16',
  sessionUser: target.connectionUser,
  sessionUserOid: target.connectionUserOid,
  currentUser: target.restoreRole,
  currentUserOid: target.restoreRoleOid,
} as const;

function child(stdout = '', code = 0, error = false): EventEmitter {
  const result = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  Object.assign(result, { kill: () => true });
  setTimeout(() => {
    if (error) result.emit('error', new Error('hidden'));
    else {
      if (stdout) result.stdout.emit('data', Buffer.from(stdout));
      result.emit('close', code, null);
    }
  }, 500);
  return result;
}

function manualChild(killResult = true): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kills: string[];
} {
  const result = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kills: string[];
  };
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  result.kills = [];
  Object.assign(result, { kill: (signal: string) => (result.kills.push(signal), killResult) });
  return result;
}

const waitForListeners = () => new Promise((resolve) => setTimeout(resolve, 600));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phub-pg-restore-runner-'));
  const archivePath = join(directory, 'archive.dump');
  const passwordPath = join(directory, 'pgpass');
  await writeFile(archivePath, 'verified archive');
  await writeFile(passwordPath, '127.0.0.1:5432:phub_restore_123_verify:phub_restore_login:x\n');
  await Promise.all([chmod(archivePath, 0o600), chmod(passwordPath, 0o600)]);
  const executablePath = '/usr/bin/true';
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
  return {
    archiveFile,
    passwordFile: await open(passwordPath, 'r'),
    executableFile: await open(executablePath, 'r'),
    expectedPgRestoreSha256: createHash('sha256')
      .update(await readFile(executablePath))
      .digest('hex'),
  };
}

function config(expectedPgRestoreSha256: string): CommunitiesStagingRoleSplitPgRestoreRunnerConfig {
  return {
    target,
    expectedPgRestoreSha256,
    timeoutMs: 1_000,
    preflight: () => Promise.resolve(observation),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  vi.useRealTimers();
});

function unsafeHandle(stat: object) {
  return { fd: 99, stat: () => Promise.resolve(stat) } as never;
}

describe('runCommunitiesStagingRoleSplitPgRestore', () => {
  it('pins version and restore to the same inherited executable descriptor without an archive pathname', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    spawnMock.mockReturnValueOnce(child() as never);
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(config(handles.expectedPgRestoreSha256), handles),
      ).resolves.toEqual({
        discardedOutputBytes: 0,
      });
      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        '/proc/self/fd/4',
        ['--version'],
        expect.objectContaining({
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore', 'ignore', handles.executableFile.fd],
        }),
      );
      const restore = spawnMock.mock.calls[1];
      expect(restore?.[0]).toBe('/proc/self/fd/4');
      expect(restore?.[1]).toEqual(
        expect.arrayContaining(['--format=custom', '--exit-on-error', '--single-transaction']),
      );
      expect(String(restore?.[1])).not.toContain('archive.dump');
      expect(String(restore?.[1])).not.toMatch(/--(?:no-owner|no-acl|clean|create|jobs)/);
      const restoreOptions = JSON.stringify(restore?.[2]);
      expect(restoreOptions).toContain('"PGPASSFILE":"/proc/self/fd/3"');
      expect(restoreOptions).toContain(`"PGUSER":"${target.connectionUser}"`);
      expect(restoreOptions).not.toContain('password');
      expect(restore?.[2]).toMatchObject({
        shell: false,
        stdio: [
          handles.archiveFile.fd,
          'ignore',
          'pipe',
          handles.passwordFile.fd,
          handles.executableFile.fd,
        ],
      });
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  const invalidTargets = [
    ['zero oid', { ...target, databaseOid: '0' }],
    ['zero connection role oid', { ...target, connectionUserOid: '0' }],
    ['unknown ssl', { ...target, sslMode: 'prefer' as never }],
    ['remote disable', { ...target, host: 'db.example', sslMode: 'disable' }],
    ['localhost disable', { ...target, host: 'localhost', sslMode: 'disable' }],
  ] satisfies readonly [string, CommunitiesStagingRoleSplitPgRestoreTarget][];
  it.each(invalidTargets)('rejects %s before it can spawn', async (_name, invalidTarget) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(
          { ...config(handles.expectedPgRestoreSha256), target: invalidTarget },
          handles,
        ),
      ).rejects.toMatchObject({ code: 'TARGET_CONFIG_INVALID' });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('keeps timed-out version probe pending through kill(false) and post-TERM/KILL errors', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    const version = manualChild(false);
    spawnMock.mockReturnValueOnce(version as never);
    try {
      const promise = runCommunitiesStagingRoleSplitPgRestore(
        config(handles.expectedPgRestoreSha256),
        handles,
      );
      const rejection = expect(promise).rejects.toMatchObject({
        code: 'TERMINATION_UNCONFIRMED',
      });
      await waitForListeners();
      await new Promise((resolve) => setTimeout(resolve, 10_050));
      version.emit('error', new Error('after-term'));
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      version.emit('error', new Error('after-kill'));
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await rejection;
      expect(version.kills).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  }, 18_000);

  it('fails closed for executable hash mismatch before version or restore spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(config('0'.repeat(64)), handles),
      ).rejects.toMatchObject({ code: 'PG_RESTORE_EXECUTABLE_UNSAFE' });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('rejects a root-owned archive descriptor opened with write access before spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    vi.mocked(readFile).mockResolvedValueOnce('pos:\t0\nflags:\t0100002\n');
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(config(handles.expectedPgRestoreSha256), handles),
      ).rejects.toMatchObject({ code: 'ARCHIVE_DESCRIPTOR_INVALID' });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it.each([
    ['malformed', 'not pg_restore\n', 0, false, 'PG_RESTORE_VERSION_INVALID'],
    ['nonzero', '', 1, false, 'PG_RESTORE_VERSION_INVALID'],
    ['error', '', 0, true, 'PG_RESTORE_VERSION_UNAVAILABLE'],
  ])('fails closed for %s version probe', async (_name, stdout, status, error, code) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child(stdout, status, error) as never);
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(config(handles.expectedPgRestoreSha256), handles),
      ).rejects.toMatchObject({ code });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('does not spawn restore after rejected preflight', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(
          {
            ...config(handles.expectedPgRestoreSha256),
            preflight: () => Promise.reject(new Error('hidden')),
          },
          handles,
        ),
      ).rejects.toMatchObject({ code: 'PREFLIGHT_UNAVAILABLE' });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('rejects a preflight role OID mismatch before restore spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(
          {
            ...config(handles.expectedPgRestoreSha256),
            preflight: () => Promise.resolve({ ...observation, currentUserOid: '16386' }),
          },
          handles,
        ),
      ).rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('redacts a synchronous preflight failure before restore spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(
          {
            ...config(handles.expectedPgRestoreSha256),
            preflight: () => {
              throw new Error('hidden-preflight-detail');
            },
          },
          handles,
        ),
      ).rejects.toMatchObject({ code: 'PREFLIGHT_UNAVAILABLE' });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it.each([
    [
      'nonzero',
      (restore: ReturnType<typeof manualChild>) => restore.emit('close', 1, null),
      'NONZERO_EXIT',
    ],
    [
      'error',
      (restore: ReturnType<typeof manualChild>) => restore.emit('error', new Error('hidden')),
      'PROCESS_UNAVAILABLE',
    ],
    [
      'response loss',
      (restore: ReturnType<typeof manualChild>) => restore.emit('close', null, 'SIGKILL'),
      'RESPONSE_LOST',
    ],
  ])('redacts restore %s failures', async (_name, complete, code) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    const restore = manualChild();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    spawnMock.mockReturnValueOnce(restore as never);
    try {
      const promise = runCommunitiesStagingRoleSplitPgRestore(
        config(handles.expectedPgRestoreSha256),
        handles,
      );
      await waitForListeners();
      complete(restore);
      await expect(promise).rejects.toMatchObject({ code });
      await promise.catch((error: unknown) => expect(String(error)).not.toContain('hidden'));
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('maps a synchronous restore spawn throw without leaking detail', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    spawnMock.mockImplementationOnce(() => {
      throw new Error('secret-argument');
    });
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(config(handles.expectedPgRestoreSha256), handles),
      ).rejects.toMatchObject({ code: 'PROCESS_UNAVAILABLE' });
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('rejects bounded preflight timeout before restore spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    try {
      const promise = runCommunitiesStagingRoleSplitPgRestore(
        {
          ...config(handles.expectedPgRestoreSha256),
          preflightTimeoutMs: 1,
          preflight: () => new Promise(() => undefined),
        },
        handles,
      );
      const rejection = expect(promise).rejects.toMatchObject({
        code: 'PREFLIGHT_TERMINATION_UNCONFIRMED',
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await rejection;
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  }, 4_000);

  it('returns PREFLIGHT_TIMEOUT only after cooperative abort cleanup acknowledges', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
    let aborted = false;
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(
          {
            ...config(handles.expectedPgRestoreSha256),
            preflightTimeoutMs: 1,
            preflight: (_target, signal) =>
              new Promise((resolve) =>
                signal.addEventListener('abort', () => {
                  aborted = true;
                  resolve(observation);
                }),
              ),
          },
          handles,
        ),
      ).rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT' });
      expect(aborted).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  }, 2_000);

  it.each([
    [
      'mutable same-UID archive',
      'archiveFile',
      {
        isFile: (): boolean => true,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mode: 0o100600,
        nlink: 1,
        size: 1,
      },
      'ARCHIVE_DESCRIPTOR_INVALID',
    ],
    [
      'password owner',
      'passwordFile',
      { isFile: () => true, uid: 0, mode: 0o100600, size: 1 },
      'PASSWORD_DESCRIPTOR_INVALID',
    ],
    [
      'password empty',
      'passwordFile',
      { isFile: () => true, uid: process.getuid?.() ?? 0, mode: 0o100600, size: 0 },
      'PASSWORD_DESCRIPTOR_INVALID',
    ],
    [
      'executable mode',
      'executableFile',
      { isFile: () => true, uid: 0, mode: 0o100775, size: 1 },
      'PG_RESTORE_EXECUTABLE_UNSAFE',
    ],
  ])('rejects unsafe %s descriptor before spawn', async (_name, field, stat, code) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    try {
      const input = { ...handles, [field]: unsafeHandle(stat) };
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(config(handles.expectedPgRestoreSha256), input),
      ).rejects.toMatchObject({ code });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  });

  it('classifies stderr overflow and timeout close/no-close without waiting in real time', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const handles = await fixture();
    const makeRestore = async (timeoutMs: number, killResult = true) => {
      const restore = manualChild(killResult);
      spawnMock.mockReturnValueOnce(child('pg_restore (PostgreSQL) 16.2\n') as never);
      spawnMock.mockReturnValueOnce(restore as never);
      const promise = runCommunitiesStagingRoleSplitPgRestore(
        { ...config(handles.expectedPgRestoreSha256), timeoutMs },
        handles,
      );
      await waitForListeners();
      return { promise, restore };
    };
    try {
      const overflow = await makeRestore(1_000);
      const overflowRejection = expect(overflow.promise).rejects.toMatchObject({
        code: 'OUTPUT_LIMIT',
      });
      overflow.restore.stderr.emit('data', Buffer.alloc(9 * 1024));
      overflow.restore.emit('close', 0, null);
      await overflowRejection;
      expect(overflow.restore.kills).toEqual(['SIGTERM']);

      const timed = await makeRestore(1);
      const timedRejection = expect(timed.promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      timed.restore.emit('close', 0, null);
      await timedRejection;
      expect(timed.restore.kills).toEqual(['SIGTERM']);

      const noClose = await makeRestore(1, false);
      const noCloseRejection = expect(noClose.promise).rejects.toMatchObject({
        code: 'TERMINATION_UNCONFIRMED',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      noClose.restore.emit('error', new Error('after-term'));
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      noClose.restore.emit('error', new Error('after-kill'));
      await new Promise((resolve) => setTimeout(resolve, 4_100));
      await noCloseRejection;
      expect(noClose.restore.kills).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      await handles.archiveFile.close();
      await handles.passwordFile.close();
      await handles.executableFile.close();
    }
  }, 12_000);
});
