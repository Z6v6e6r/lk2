import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const diagnosticsRunner = fileURLToPath(
  new URL('./run-ci-tests-with-diagnostics.sh', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const linuxOnly = process.platform === 'linux';
const temporaryDirectories: string[] = [];

async function createDiagnosticsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'phub-ci-test-diagnostics-'));
  temporaryDirectories.push(directory);
  return directory;
}

function testEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI_TEST_DIAGNOSTICS_DIR: directory,
    CI_TEST_EXTERNAL_KILL_AFTER_SECONDS: '0.1',
    CI_TEST_HEARTBEAT_SECONDS: '1',
    CI_TEST_KILL_AFTER_SECONDS: '1',
    CI_TEST_WATCHDOG_SECONDS: '30',
  };
}

async function waitForFile(path: string, timeoutMilliseconds = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function parsePidFile(contents: string): readonly number[] {
  return contents
    .trim()
    .split('\n')
    .map((line) => Number(line.split('=', 2)[1]))
    .filter(Number.isSafeInteger);
}

async function expectProcessGone(pid: number, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} survived supervisor finalization`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe.sequential('CI test diagnostics supervisor', () => {
  it.runIf(linuxOnly)('preserves a successful test command status and final evidence', async () => {
    const directory = await createDiagnosticsDirectory();
    const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 0'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: testEnvironment(directory),
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
      'exit_status=0\ntermination=normal_exit\n',
    );
    expect(await readFile(join(directory, 'resource-samples.log'), 'utf8')).toContain(
      'phase=final',
    );
  });

  it.runIf(linuxOnly)('preserves a non-zero test command status', async () => {
    const directory = await createDiagnosticsDirectory();
    const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: testEnvironment(directory),
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
      'exit_status=7\ntermination=normal_exit\n',
    );
  });

  it.runIf(linuxOnly)(
    'fails a successful command that leaves a stubborn process-group descendant',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const result = spawnSync(
        diagnosticsRunner,
        [
          '/bin/sh',
          '-c',
          '(trap "" TERM; while :; do sleep 1; done) & echo $! > "$CI_TEST_DIAGNOSTICS_DIR/descendant.pid"; exit 0',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: testEnvironment(directory),
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(125);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'exit_status=125\ntermination=residual_process_group_after_success\n',
      );
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=residual_process_group_after_leader_exit',
      );
      const descendantPid = Number(
        (await readFile(join(directory, 'descendant.pid'), 'utf8')).trim(),
      );
      await expectProcessGone(descendantPid);
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'kills the full test process group after the watchdog grace period',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const result = spawnSync(
        diagnosticsRunner,
        [
          '/bin/sh',
          '-c',
          '(trap "" TERM USR1; while :; do sleep 1; done) & echo $! > "$CI_TEST_DIAGNOSTICS_DIR/descendant.pid"; trap "" USR1; while :; do sleep 1; done',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...testEnvironment(directory), CI_TEST_WATCHDOG_SECONDS: '1' },
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(137);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'exit_status=137\ntermination=watchdog_sigkill\n',
      );
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=watchdog_grace_expired signal=KILL',
      );
      const testPid = Number((await readFile(join(directory, 'test.pid'), 'utf8')).trim());
      const descendantPid = Number(
        (await readFile(join(directory, 'descendant.pid'), 'utf8')).trim(),
      );
      await expectProcessGone(testPid);
      await expectProcessGone(descendantPid);
      for (const helperPid of parsePidFile(
        await readFile(join(directory, 'helper-pids.txt'), 'utf8'),
      )) {
        await expectProcessGone(helperPid);
      }
    },
  );

  for (const [signal, expectedStatus] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    it.runIf(linuxOnly)(
      `finalizes diagnostics and reaps child processes after ${signal}`,
      async () => {
        const directory = await createDiagnosticsDirectory();
        const child = spawn(
          diagnosticsRunner,
          [
            '/bin/sh',
            '-c',
            '(trap "" TERM INT; while :; do sleep 1; done) & echo $! > "$CI_TEST_DIAGNOSTICS_DIR/descendant.pid"; trap "" TERM INT; while :; do sleep 1; done',
          ],
          {
            cwd: repositoryRoot,
            env: testEnvironment(directory),
            stdio: 'ignore',
          },
        );

        const testPid = Number((await waitForFile(join(directory, 'test.pid'))).trim());
        const helperPids = parsePidFile(await waitForFile(join(directory, 'helper-pids.txt')));
        const descendantPid = Number((await waitForFile(join(directory, 'descendant.pid'))).trim());
        child.kill(signal);
        const result = await waitForExit(child);

        expect(result).toEqual({ code: expectedStatus, signal: null });
        expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
          `exit_status=${expectedStatus}\ntermination=external_signal_${signal.slice(3)}\n`,
        );
        expect(await readFile(join(directory, 'resource-samples.log'), 'utf8')).toContain(
          'phase=final',
        );
        await expectProcessGone(testPid);
        await expectProcessGone(descendantPid);
        for (const helperPid of helperPids) await expectProcessGone(helperPid);
      },
      15_000,
    );
  }
});
