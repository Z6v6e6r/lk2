import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    CI_TEST_FINAL_SNAPSHOT_TIMEOUT: '3s',
    CI_TEST_HELPER_SHUTDOWN_SECONDS: '1',
    // Keep helper sleeps longer than spawnSync timeouts. Fast-command tests
    // therefore prove that finalization interrupts helper children before wait.
    CI_TEST_HEARTBEAT_SECONDS: '30',
    CI_TEST_KILL_AFTER_SECONDS: '1',
    CI_TEST_PROCESS_GROUP_PROBE_TIMEOUT: '0.5s',
    CI_TEST_WATCHDOG_SECONDS: '30',
  };
}

async function createExecutable(directory: string, name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  await chmod(path, 0o700);
  return path;
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
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function waitForHelperPids(
  path: string,
  timeoutMilliseconds = 5_000,
): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const helperPids = parsePidFile(await waitForFile(path));
    if (helperPids.length === 2) return helperPids;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for complete helper PID file ${path}`);
}

async function waitForPositivePid(path: string, timeoutMilliseconds = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const pid = Number((await waitForFile(path)).trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for positive PID in ${path}`);
}

async function readChildPids(pid: number): Promise<readonly number[]> {
  try {
    return (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForChildPids(
  pid: number,
  timeoutMilliseconds = 2_000,
): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const childPids = await readChildPids(pid);
    if (childPids.length > 0) return childPids;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for helper ${pid} to start a child process`);
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

async function expectProcessGroupGone(pgid: number, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process group ${pgid} survived supervisor finalization`);
}

async function readAllDiagnosticFiles(directory: string): Promise<string> {
  const names = await readdir(directory);
  return (
    await Promise.all(
      names.map(async (name) => {
        try {
          return await readFile(join(directory, name), 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EISDIR') return '';
          throw error;
        }
      }),
    )
  ).join('\n');
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
  it.runIf(linuxOnly)(
    'preserves a successful test command status and final evidence',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const startedAt = Date.now();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 0'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: testEnvironment(directory),
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(7_000);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=0\nexit_status=0\ntermination=normal_exit\nfinalization=complete\n',
      );
      expect(await readFile(join(directory, 'resource-samples.log'), 'utf8')).toContain(
        'phase=final',
      );
      const testPgid = await waitForPositivePid(join(directory, 'test.pid'));
      await expectProcessGroupGone(testPgid);
      for (const helperPid of parsePidFile(
        await readFile(join(directory, 'helper-pids.txt'), 'utf8'),
      )) {
        await expectProcessGone(helperPid);
      }
      expect(await readFile(join(directory, 'watchdog-stop-requested'), 'utf8')).toBe('');
      await expect(readFile(join(directory, 'watchdog-failure.txt'), 'utf8')).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'preserves a non-zero test command status',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const startedAt = Date.now();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: testEnvironment(directory),
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(Date.now() - startedAt).toBeLessThan(7_000);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=7\ntermination=normal_exit\nfinalization=complete\n',
      );
      expect(await readFile(join(directory, 'resource-samples.log'), 'utf8')).toContain(
        'phase=final',
      );
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'phase=child_exit_captured child_status=7',
      );
      const testPgid = await waitForPositivePid(join(directory, 'test.pid'));
      await expectProcessGroupGone(testPgid);
      for (const helperPid of parsePidFile(
        await readFile(join(directory, 'helper-pids.txt'), 'utf8'),
      )) {
        await expectProcessGone(helperPid);
      }
      expect(await readFile(join(directory, 'watchdog-stop-requested'), 'utf8')).toBe('');
      await expect(readFile(join(directory, 'watchdog-failure.txt'), 'utf8')).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'reports a supervisor cleanup failure for a non-zero child with a stubborn descendant',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const result = spawnSync(
        diagnosticsRunner,
        [
          '/bin/sh',
          '-c',
          '(trap "" TERM; while :; do sleep 1; done) & echo $! > "$CI_TEST_DIAGNOSTICS_DIR/descendant.pid"; exit 7',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: testEnvironment(directory),
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\n',
      );
      const descendantPid = Number(
        (await readFile(join(directory, 'descendant.pid'), 'utf8')).trim(),
      );
      await expectProcessGone(descendantPid);
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'detaches inherited helper output and bounds monitor shutdown',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const monitorCommand = await createExecutable(
        directory,
        'stubborn-monitor.sh',
        'trap "" TERM\nprintf "helper-stdout-open\\n"\nwhile :; do sleep 30; done',
      );
      const startedAt = Date.now();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_MONITOR_HELPER_COMMAND: monitorCommand,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(await readFile(join(directory, 'resource-samples.log'), 'utf8')).toContain(
        'helper-stdout-open',
      );
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=finalization_budget_exceeded phase=monitor_shutdown action=SIGKILL',
      );
      for (const helperPid of parsePidFile(
        await readFile(join(directory, 'helper-pids.txt'), 'utf8'),
      )) {
        await expectProcessGone(helperPid);
      }
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'bounds watchdog shutdown independently',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const watchdogCommand = await createExecutable(
        directory,
        'stubborn-watchdog.sh',
        'trap "" TERM\nsleep 30 &\necho $! > "$CI_TEST_DIAGNOSTICS_DIR/watchdog-child.pid"\nwait',
      );
      const startedAt = Date.now();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 0'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_WATCHDOG_HELPER_COMMAND: watchdogCommand,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=finalization_budget_exceeded phase=watchdog_shutdown action=SIGKILL',
      );
      await expectProcessGone(await waitForPositivePid(join(directory, 'watchdog-child.pid')));
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'bounds a stalled process-group probe',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const stalledProbe = await createExecutable(directory, 'stalled-probe.sh', 'sleep 30');
      const startedAt = Date.now();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_PROCESS_GROUP_PROBE_COMMAND: stalledProbe,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\n',
      );
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=finalization_budget_exceeded phase=process_group_probe',
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'fails closed when the process-group probe returns an unexpected status',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const failedProbe = await createExecutable(directory, 'failed-probe.sh', 'exit 3');
      const result = spawnSync(
        diagnosticsRunner,
        [
          '/bin/sh',
          '-c',
          '(trap "" TERM; while :; do sleep 1; done) & echo $! > "$CI_TEST_DIAGNOSTICS_DIR/unexpected-probe-descendant.pid"; exit 7',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {
            ...testEnvironment(directory),
            CI_TEST_PROCESS_GROUP_PROBE_COMMAND: failedProbe,
          },
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=supervisor_probe_failure phase=process_group_probe',
      );
      await expectProcessGone(
        await waitForPositivePid(join(directory, 'unexpected-probe-descendant.pid')),
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'fails closed and kills the test group when the watchdog probe stalls',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const stalledProbe = await createExecutable(
        directory,
        'watchdog-stalled-probe.sh',
        'sleep 30',
      );
      const startedAt = Date.now();
      const result = spawnSync(
        diagnosticsRunner,
        ['/bin/sh', '-c', 'trap "" TERM USR1; while :; do sleep 1; done'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {
            ...testEnvironment(directory),
            CI_TEST_PROCESS_GROUP_PROBE_COMMAND: stalledProbe,
            CI_TEST_WATCHDOG_SECONDS: '0.1',
          },
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=supervisor_cleanup_failure phase=watchdog_process_group_probe action=SIGKILL',
      );
      await expectProcessGroupGone(await waitForPositivePid(join(directory, 'test.pid')));
    },
    15_000,
  );

  for (const watchdogExitHook of [
    'CI_TEST_WATCHDOG_EXIT_BEFORE_READY',
    'CI_TEST_WATCHDOG_EXIT_AFTER_READY',
    'CI_TEST_WATCHDOG_SIGKILL_AFTER_READY',
  ] as const) {
    it.runIf(linuxOnly)(
      `fails closed when the watchdog exits via ${watchdogExitHook}`,
      async () => {
        const directory = await createDiagnosticsDirectory();
        const startedAt = Date.now();
        const result = spawnSync(
          diagnosticsRunner,
          ['/bin/sh', '-c', 'trap "" TERM INT; while :; do sleep 1; done'],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: { ...testEnvironment(directory), [watchdogExitHook]: 'true' },
            timeout: 10_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(126);
        expect(Date.now() - startedAt).toBeLessThan(8_000);
        expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
          'phase=watchdog_unexpected_exit action=SIGKILL',
        );
        await expectProcessGroupGone(await waitForPositivePid(join(directory, 'test.pid')));
      },
      15_000,
    );
  }

  it.runIf(linuxOnly)(
    'honors a watchdog failure published while finalization stops the watchdog',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_WATCHDOG_FAILURE_ON_STOP: 'true',
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=watchdog_failure_on_stop\n',
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'detects a watchdog SIGKILL race while finalization stops it',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_WATCHDOG_SIGKILL_ON_STOP: 'true',
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=watchdog_unexpected_exit\n',
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'persists the child status before deliberately slow helper cleanup completes',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const monitorReleaseFile = join(directory, 'release-monitor');
      const monitorCommand = await createExecutable(
        directory,
        'slow-monitor.sh',
        'trap "" TERM\nwhile [[ ! -e "$CI_TEST_MONITOR_RELEASE_FILE" ]]; do sleep 0.05; done',
      );
      const child = spawn(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        env: {
          ...testEnvironment(directory),
          CI_TEST_HELPER_SHUTDOWN_SECONDS: '10',
          CI_TEST_MONITOR_HELPER_COMMAND: monitorCommand,
          CI_TEST_MONITOR_RELEASE_FILE: monitorReleaseFile,
        },
        stdio: 'ignore',
      });
      const childExit = waitForExit(child);

      let earlyStatus = '';
      let childExitCodeBeforeRelease: number | null = null;
      let childResult: Awaited<ReturnType<typeof waitForExit>> | undefined;
      try {
        earlyStatus = await waitForFile(join(directory, 'status.txt'));
        childExitCodeBeforeRelease = child.exitCode;
      } finally {
        await writeFile(monitorReleaseFile, 'release\n', 'utf8');
        childResult = await childExit;
      }
      expect(earlyStatus).toContain(
        'child_exit_status=7\nexit_status=7\ntermination=pending_finalization\nfinalization=child_exit_captured\n',
      );
      expect(childExitCodeBeforeRelease).toBeNull();
      expect(childResult).toEqual({ code: 7, signal: null });
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'reports a bounded final-snapshot supervisor failure',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const stalledSnapshot = await createExecutable(directory, 'stalled-snapshot.sh', 'sleep 30');
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_FINAL_SNAPSHOT_COMMAND: stalledSnapshot,
          CI_TEST_FINAL_SNAPSHOT_TIMEOUT: '0.5s',
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=final_resource_snapshot\n',
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'bounds combined monitor and watchdog finalization below the outer timeout',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const stubbornHelper = await createExecutable(
        directory,
        'stubborn-helper.sh',
        'trap "" TERM\nwhile :; do sleep 30; done',
      );
      const startedAt = Date.now();
      const result = spawnSync(diagnosticsRunner, ['/bin/sh', '-c', 'exit 7'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...testEnvironment(directory),
          CI_TEST_MONITOR_HELPER_COMMAND: stubbornHelper,
          CI_TEST_WATCHDOG_HELPER_COMMAND: stubbornHelper,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      for (const helperPid of parsePidFile(
        await readFile(join(directory, 'helper-pids.txt'), 'utf8'),
      )) {
        await expectProcessGone(helperPid);
      }
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'redacts sensitive environment values from every diagnostic file',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const secretSentinel = 'diagnostics-secret-sentinel-must-not-appear';
      const result = spawnSync(
        diagnosticsRunner,
        [
          '/bin/sh',
          '-c',
          'printf "%s\\n" "$CI_TEST_SECRET_SENTINEL"; printf "%s\\n" "$CI_TEST_SECRET_SENTINEL" >&2; exit 7',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...testEnvironment(directory), CI_TEST_SECRET_SENTINEL: secretSentinel },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(7);
      expect(result.stdout).toContain('[REDACTED]');
      expect(result.stderr).toContain('[REDACTED]');
      expect(result.stdout).not.toContain(secretSentinel);
      expect(result.stderr).not.toContain(secretSentinel);
      expect(await readAllDiagnosticFiles(directory)).not.toContain(secretSentinel);
    },
  );

  it.runIf(linuxOnly)(
    'suppresses raw output and returns supervisor failure when redaction times out',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const secretSentinel = 'redaction-timeout-secret-must-not-appear';
      const stalledRedaction = await createExecutable(
        directory,
        'stalled-redaction.sh',
        'sleep 30',
      );
      const result = spawnSync(
        diagnosticsRunner,
        ['/bin/sh', '-c', 'printf "%s\\n" "$CI_TEST_SECRET_SENTINEL"; exit 7'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {
            ...testEnvironment(directory),
            CI_TEST_OUTPUT_REDACTION_COMMAND: stalledRedaction,
            CI_TEST_OUTPUT_REDACTION_TIMEOUT: '0.5s',
            CI_TEST_SECRET_SENTINEL: secretSentinel,
          },
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(result.stdout).toContain('diagnostic output suppressed because redaction failed');
      expect(result.stdout).not.toContain(secretSentinel);
      expect(await readAllDiagnosticFiles(directory)).not.toContain(secretSentinel);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'exit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=output_redaction\n',
      );
    },
    15_000,
  );

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
    15_000,
  );

  it.runIf(linuxOnly)(
    'reaps the launcher and returns supervisor failure when signal cleanup cannot probe the group',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const stalledProbe = await createExecutable(directory, 'signal-stalled-probe.sh', 'sleep 30');
      const child = spawn(
        diagnosticsRunner,
        ['/bin/sh', '-c', 'trap "" TERM INT; while :; do sleep 1; done'],
        {
          cwd: repositoryRoot,
          env: {
            ...testEnvironment(directory),
            CI_TEST_PROCESS_GROUP_PROBE_COMMAND: stalledProbe,
          },
          stdio: 'ignore',
        },
      );
      const testPid = await waitForPositivePid(join(directory, 'test.pid'));
      await waitForHelperPids(join(directory, 'helper-pids.txt'));
      child.kill('SIGTERM');

      expect(await waitForExit(child)).toEqual({ code: 126, signal: null });
      await expectProcessGone(testPid);
      await expectProcessGroupGone(testPid);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'exit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\n',
      );
    },
    15_000,
  );

  it.runIf(linuxOnly)(
    'returns supervisor failure when SIGTERM observes a durable watchdog failure marker',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const child = spawn(
        diagnosticsRunner,
        ['/bin/sh', '-c', 'trap "" TERM INT; while :; do sleep 1; done'],
        {
          cwd: repositoryRoot,
          env: testEnvironment(directory),
          stdio: 'ignore',
        },
      );
      const testPid = await waitForPositivePid(join(directory, 'test.pid'));
      await waitForHelperPids(join(directory, 'helper-pids.txt'));
      await writeFile(join(directory, 'watchdog-failure.txt'), 'watchdog_process_group_probe\n');
      child.kill('SIGTERM');

      expect(await waitForExit(child)).toEqual({ code: 126, signal: null });
      await expectProcessGone(testPid);
      await expectProcessGroupGone(testPid);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'exit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=watchdog_process_group_probe\n',
      );
    },
    15_000,
  );

  for (const [signal, expectedStatus] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    it.runIf(linuxOnly)(
      `finalizes diagnostics and reaps child processes after ${signal}`,
      async () => {
        const directory = await createDiagnosticsDirectory();
        const secretSentinel = `signal-${signal}-secret-must-not-appear`;
        const credentialUrl = `postgresql://signal-user:signal-password@localhost/${signal}`;
        const child = spawn(
          diagnosticsRunner,
          [
            '/bin/sh',
            '-c',
            'printf "%s\\n" "$CI_TEST_SECRET_SENTINEL"; printf "%s\\n" "$DATABASE_URL" >&2; (trap "" TERM INT; while :; do sleep 1; done) & echo $! > "$CI_TEST_DIAGNOSTICS_DIR/descendant.pid"; trap "" TERM INT; while :; do sleep 1; done',
          ],
          {
            cwd: repositoryRoot,
            env: {
              ...testEnvironment(directory),
              CI_TEST_SECRET_SENTINEL: secretSentinel,
              DATABASE_URL: credentialUrl,
            },
            stdio: 'ignore',
          },
        );

        const testPid = await waitForPositivePid(join(directory, 'test.pid'));
        const helperPids = await waitForHelperPids(join(directory, 'helper-pids.txt'));
        const helperChildPids = (
          await Promise.all(helperPids.map(async (helperPid) => await waitForChildPids(helperPid)))
        ).flat();
        const descendantPid = await waitForPositivePid(join(directory, 'descendant.pid'));
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
        for (const helperChildPid of helperChildPids) {
          await expectProcessGone(helperChildPid);
        }
        const diagnostics = await readAllDiagnosticFiles(directory);
        expect(diagnostics).not.toContain(secretSentinel);
        expect(diagnostics).not.toContain(credentialUrl);
      },
      15_000,
    );
  }
});
