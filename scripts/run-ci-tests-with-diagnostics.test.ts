import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const diagnosticsRunner = fileURLToPath(
  new URL('./run-ci-tests-with-diagnostics.sh', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const linuxOnly = process.platform === 'linux';
// Declared ceiling for the supervisor's whole finalization sequence. It must match
// CI_TEST_FINALIZATION_BUDGET_SECONDS in scripts/run-ci-tests-with-diagnostics.sh; the guard below
// fails if the two drift apart, so the harness bound cannot be inflated on its own.
const supervisorFinalizationBudgetSeconds = 30;
// Documented headroom over the declared budget: process spawn, node bootstrap of the supervisor
// itself, and scheduler delay on a loaded runner. The supervisor must stay inside its budget, so
// this bound still fails a supervisor that hangs, it is not a substitute for the budget.
const supervisorSpawnHeadroomMilliseconds = 15_000;
const supervisorSpawnTimeoutMilliseconds =
  supervisorFinalizationBudgetSeconds * 1_000 + supervisorSpawnHeadroomMilliseconds;
const supervisorCaseTimeoutMilliseconds = supervisorSpawnTimeoutMilliseconds + 5_000;
const temporaryDirectories: string[] = [];

describe('CI workflow finalization budget', () => {
  it('keeps the supervisor watchdog and cleanup inside the Actions step deadline', async () => {
    const workflow = parseYaml(
      await readFile(join(repositoryRoot, '.github/workflows/pull-request.yaml'), 'utf8'),
    ) as {
      env?: Record<string, string>;
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps: Array<{
            name?: string;
            'timeout-minutes'?: number;
            env?: Record<string, string>;
          }>;
        }
      >;
    };
    const step = workflow.jobs['quality-full']?.steps.find(
      (entry) => entry.name === 'Unit and integration tests',
    );
    expect(step).toBeDefined();
    expect(workflow.env?.CI_TEST_WATCHDOG_SECONDS).toBeUndefined();
    expect(workflow.jobs['quality-full']?.env?.CI_TEST_WATCHDOG_SECONDS).toBeUndefined();
    expect(
      workflow.jobs['quality-full']?.steps.filter(
        (entry) => entry.env?.CI_TEST_WATCHDOG_SECONDS !== undefined,
      ),
    ).toEqual([step]);
    const watchdog = Number(step!.env?.CI_TEST_WATCHDOG_SECONDS);
    const stepDeadline = Number(step!['timeout-minutes']) * 60;
    const runner = await readFile(diagnosticsRunner, 'utf8');
    expect(runner).toContain('CI_TEST_WATCHDOG_SECONDS:-480');
    const terminationGrace = Number(runner.match(/CI_TEST_KILL_AFTER_SECONDS:-([0-9]+)/)?.[1]);
    expect(Number.isSafeInteger(watchdog) && watchdog > 0).toBe(true);
    expect(Number.isSafeInteger(stepDeadline) && stepDeadline > 0).toBe(true);
    expect(Number.isSafeInteger(terminationGrace) && terminationGrace > 0).toBe(true);
    // Final resource snapshots/redaction/helper shutdown must finish before Actions kills the step.
    expect(stepDeadline - watchdog - terminationGrace).toBeGreaterThanOrEqual(60);
    // The supervisor bounds its own finalization; that declared budget has to fit inside the window
    // the workflow leaves between the watchdog deadline and the Actions step timeout, with margin.
    const declaredBudget = Number(
      runner.match(/CI_TEST_FINALIZATION_BUDGET_SECONDS:-([0-9]+)/u)?.[1],
    );
    expect(declaredBudget).toBe(supervisorFinalizationBudgetSeconds);
    expect(stepDeadline - watchdog - terminationGrace - declaredBudget).toBeGreaterThanOrEqual(30);
    // The harness bound is derived from that budget and can never drift away from it: raising the
    // spawn bound alone would break this assertion.
    expect(supervisorSpawnTimeoutMilliseconds).toBeGreaterThanOrEqual(declaredBudget * 1_000);
    expect(supervisorSpawnTimeoutMilliseconds).toBeLessThanOrEqual(declaredBudget * 2 * 1_000);
    expect(supervisorCaseTimeoutMilliseconds).toBeGreaterThan(supervisorSpawnTimeoutMilliseconds);
    // Every bounded stage must take its duration from what is left of the declared budget, and the
    // fixed post-kill sleep must stay gone (it is a poll now, so teardown is never a fixed wait).
    expect(runner).toContain('run_command_in_own_group_bounded');
    expect(runner).toContain(
      '"$(finalization_stage_milliseconds "$redaction_budget_milliseconds")"',
    );
    expect(runner).toContain(
      'snapshot_timeout="$(finalization_stage_timeout "$(milliseconds_from_duration "$final_snapshot_timeout")")"',
    );
    expect(runner).toContain('wait_for_process_group_exit "$process_group_settle_milliseconds"');
    expect(runner).not.toContain('sleep "$external_kill_after_seconds"');
    expect(runner).not.toContain('$((SECONDS + helper_shutdown_seconds))');
  });
});

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

async function waitForFileContents(
  path: string,
  predicate: (contents: string) => boolean,
  timeoutMilliseconds = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastContents: string | undefined;
  while (Date.now() < deadline) {
    try {
      lastContents = await readFile(path, 'utf8');
      if (predicate(lastContents)) return lastContents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for matching contents in ${path}; last observed contents:\n${lastContents ?? '<file absent>'}`,
  );
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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

async function waitForExitWithCleanupBudget(
  child: ReturnType<typeof spawn>,
  childExit: ReturnType<typeof waitForExit>,
  timeoutMilliseconds = 5_000,
): ReturnType<typeof waitForExit> {
  return await new Promise((resolve, reject) => {
    const terminateTimer = setTimeout(() => child.kill('SIGTERM'), timeoutMilliseconds);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds + 2_000);
    const rejectionTimer = setTimeout(
      () => reject(new Error(`Supervisor did not exit within cleanup budget (pid=${child.pid})`)),
      timeoutMilliseconds + 4_000,
    );
    childExit.then(resolve, reject).finally(() => {
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      clearTimeout(rejectionTimer);
    });
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
        timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
          timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
        'reason=finalization_budget_exceeded phase=watchdog_shutdown action=SIGKILL',
      );
      await expectProcessGone(await waitForPositivePid(join(directory, 'watchdog-child.pid')));
    },
    supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
          timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
          timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
            timeout: supervisorSpawnTimeoutMilliseconds,
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
      supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=watchdog_failure_on_stop\n',
      );
    },
    supervisorCaseTimeoutMilliseconds,
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
          // The shutdown deadline uses whole-second SECONDS, so a 1 s budget can expire almost
          // immediately on a loaded runner and turn the watchdog's own SIGKILL into a forced kill.
          CI_TEST_HELPER_SHUTDOWN_SECONDS: '5',
          CI_TEST_WATCHDOG_SIGKILL_ON_STOP: 'true',
        },
        timeout: supervisorSpawnTimeoutMilliseconds,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=watchdog_unexpected_exit\n',
      );
    },
    supervisorCaseTimeoutMilliseconds,
  );

  it.runIf(linuxOnly)(
    'persists resolved child status while slow helper cleanup remains in progress',
    async () => {
      const directory = await createDiagnosticsDirectory();
      const monitorBlockReadyFile = join(directory, 'monitor-block-ready');
      const monitorReleaseFile = join(directory, 'release-monitor');
      const monitorCommand = await createExecutable(
        directory,
        'slow-monitor.sh',
        [
          'release_monitor() {',
          '  while [[ ! -e "$CI_TEST_MONITOR_RELEASE_FILE" ]]; do sleep 0.05; done',
          '  exit 0',
          '}',
          'trap release_monitor TERM INT',
          'printf "ready\\n" >"$CI_TEST_MONITOR_BLOCK_READY_FILE.tmp.$$"',
          'mv "$CI_TEST_MONITOR_BLOCK_READY_FILE.tmp.$$" "$CI_TEST_MONITOR_BLOCK_READY_FILE"',
          'while :; do sleep 30; done',
        ].join('\n'),
      );
      const child = spawn(
        diagnosticsRunner,
        [
          '/bin/sh',
          '-c',
          'while [ ! -e "$CI_TEST_MONITOR_BLOCK_READY_FILE" ]; do sleep 0.05; done; exit 7',
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...testEnvironment(directory),
            CI_TEST_HELPER_SHUTDOWN_SECONDS: '10',
            CI_TEST_MONITOR_BLOCK_READY_FILE: monitorBlockReadyFile,
            CI_TEST_MONITOR_HELPER_COMMAND: monitorCommand,
            CI_TEST_MONITOR_RELEASE_FILE: monitorReleaseFile,
          },
          stdio: 'ignore',
        },
      );
      const childExit = waitForExit(child);
      let supervisorResult:
        { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;

      let preCleanupStatus: string;
      let monitorReady: string;
      let helperPids: readonly number[] = [];
      let testPid: number | undefined;
      try {
        monitorReady = await waitForFile(monitorBlockReadyFile, 3_000);
        helperPids = await waitForHelperPids(join(directory, 'helper-pids.txt'), 3_000);
        testPid = await waitForPositivePid(join(directory, 'test.pid'), 3_000);
        preCleanupStatus = await waitForFileContents(join(directory, 'status.txt'), (contents) =>
          contents.includes(
            'child_exit_status=7\nexit_status=7\ntermination=normal_exit\nfinalization=child_exit_captured\ncleanup_failure_phase=none\n',
          ),
        );

        expect(monitorReady).toBe('ready\n');
        expect(preCleanupStatus).not.toContain('finalization=complete');
        expect(child.exitCode).toBeNull();
        await expect(readFile(monitorReleaseFile, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        try {
          await Promise.all([
            writeFile(monitorBlockReadyFile, 'cleanup-release\n', 'utf8'),
            writeFile(monitorReleaseFile, 'release\n', 'utf8'),
          ]);
        } finally {
          supervisorResult = await waitForExitWithCleanupBudget(child, childExit);
        }
        if (helperPids.length === 0) {
          const helperPidContents = await readFileIfPresent(join(directory, 'helper-pids.txt'));
          if (helperPidContents !== undefined) helperPids = parsePidFile(helperPidContents);
        }
        if (testPid === undefined) {
          const testPidContents = await readFileIfPresent(join(directory, 'test.pid'));
          if (testPidContents !== undefined) {
            const observedTestPid = Number(testPidContents.trim());
            if (Number.isSafeInteger(observedTestPid) && observedTestPid > 0) {
              testPid = observedTestPid;
            }
          }
        }
        await Promise.all(helperPids.map((pid) => expectProcessGone(pid)));
        if (testPid !== undefined) await expectProcessGroupGone(testPid);
      }

      expect(supervisorResult).toEqual({ code: 7, signal: null });
      const finalStatus = await readFile(join(directory, 'status.txt'), 'utf8');
      expect(finalStatus).toContain(
        'child_exit_status=7\nexit_status=7\ntermination=normal_exit\nfinalization=complete\ncleanup_failure_phase=none\n',
      );
      expect(finalStatus).not.toContain('termination=pending_finalization');
    },
    supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(await readFile(join(directory, 'status.txt'), 'utf8')).toContain(
        'child_exit_status=7\nexit_status=126\ntermination=supervisor_cleanup_failure\nfinalization=complete\ncleanup_failure_phase=final_resource_snapshot\n',
      );
    },
    supervisorCaseTimeoutMilliseconds,
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
        timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
          timeout: supervisorSpawnTimeoutMilliseconds,
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
          // The supervisor bounds its own stages (0.5s redaction, 1s group probes, 5s snapshot);
          // the external bound must leave headroom for cleanup on a loaded runner.
          timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
          timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
          timeout: supervisorSpawnTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
    supervisorCaseTimeoutMilliseconds,
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
        const supervisorStatus =
          (await readFileIfPresent(join(directory, 'status.txt'))) ?? '<status.txt absent>';
        const supervisorEvents =
          (await readFileIfPresent(join(directory, 'watchdog-events.log'))) ??
          '<watchdog-events.log absent>';

        expect(
          result,
          `supervisor exited ${JSON.stringify(result)} instead of ${expectedStatus}\n` +
            `status.txt:\n${supervisorStatus}\nwatchdog-events.log:\n${supervisorEvents}`,
        ).toEqual({ code: expectedStatus, signal: null });
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
      supervisorCaseTimeoutMilliseconds,
    );
  }
});

// These primitives are portable bash, so they are proven on every host rather than only on the
// Linux runners: the tests extract the real function bodies from the supervisor and execute them.
const supervisorPrimitiveFunctions = [
  'log_watchdog_event',
  'now_milliseconds',
  'milliseconds_from_duration',
  'finalization_stage_milliseconds',
  'finalization_stage_timeout',
  'finalization_remaining_milliseconds',
  'helper_group_has_live_processes',
  'process_group_alive',
  'wait_for_process_group_exit',
  'run_command_in_own_group_bounded',
  'terminate_test_group',
  'cleanup_compose_fixture',
] as const;

const portableProcessGroupProbeBody = [
  'pgid="$1"',
  `ps -A -o pgid=,stat= 2>/dev/null | awk -v pgid="$pgid" '$1 == pgid && $2 !~ /^Z/ { found = 1 } END { exit(found ? 0 : 1) }'`,
].join('\n');

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function extractSupervisorFunctions(source: string, names: readonly string[]): string {
  const blocks = new Map<string, string>();
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^([a-z][a-z0-9_]*)\(\) \{$/u.exec(lines[index] ?? '');
    if (opener === null) continue;
    const body: string[] = [];
    let cursor = index;
    for (; cursor < lines.length; cursor += 1) {
      body.push(lines[cursor] ?? '');
      if (cursor > index && lines[cursor] === '}') break;
    }
    blocks.set(opener[1] ?? '', body.join('\n'));
    index = cursor;
  }
  return names
    .map((name) => {
      const block = blocks.get(name);
      if (block === undefined) throw new Error(`Supervisor function ${name} is missing`);
      return block;
    })
    .join('\n\n');
}

async function runSupervisorPrimitives(
  directory: string,
  script: string,
  settleMilliseconds = 1_000,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const functions = extractSupervisorFunctions(
    await readFile(diagnosticsRunner, 'utf8'),
    supervisorPrimitiveFunctions,
  );
  const probe = await createExecutable(
    directory,
    'portable-pgid-probe.sh',
    portableProcessGroupProbeBody,
  );
  const preamble = [
    'set -uo pipefail',
    `diagnostics_dir=${shellQuote(directory)}`,
    'export diagnostics_dir',
    'watchdog_log="$diagnostics_dir/watchdog-events.log"',
    ': >"$watchdog_log"',
    "finalization_started_milliseconds=''",
    "finalization_deadline_milliseconds=''",
    'process_group_probe_status=1',
    'process_group_probe_timeout=2s',
    `process_group_probe_command=${shellQuote(probe)}`,
    `finalization_budget_seconds=${supervisorFinalizationBudgetSeconds}`,
    `process_group_settle_milliseconds=${settleMilliseconds}`,
    "cleanup_failure_phase=''",
    "launcher_pid=''",
    'external_kill_after_seconds=0.1',
  ].join('\n');
  const result = spawnSync('bash', ['-c', `${preamble}\n${functions}\n${script}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: supervisorSpawnTimeoutMilliseconds,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readKeyedOutput(stdout: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, 'mu').exec(stdout)?.[1];
}

describe('CI supervisor finalization primitives', () => {
  it.each([0, 2])(
    'refuses fixture cleanup when the owned group probe returns %s',
    async (probeStatus) => {
      const directory = await createDiagnosticsDirectory();
      await writeFile(join(directory, 'compose-fixture-owner.json'), 'retained ownership evidence');
      const result = await runSupervisorPrimitives(
        directory,
        [
          'test_pgid=123',
          `process_group_alive() { return ${probeStatus}; }`,
          'run_command_in_own_group_bounded() { echo entered > "$diagnostics_dir/cleanup-entered"; }',
          'cleanup_compose_fixture',
          'printf "status=%s\\n" "$?"',
          'printf "phase=%s\\n" "$cleanup_failure_phase"',
        ].join('\n'),
      );
      expect(readKeyedOutput(result.stdout, 'status')).toBe('1');
      expect(readKeyedOutput(result.stdout, 'phase')).toBe('compose_fixture_group_unconfirmed');
      await expect(readFile(join(directory, 'cleanup-entered'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(directory, 'compose-fixture-cleanup.log'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(directory, 'compose-fixture-owner.json'), 'utf8')).toBe(
        'retained ownership evidence',
      );
    },
  );

  it('does not enter fixture cleanup while an ignored-stdio descendant survives', async () => {
    const directory = await createDiagnosticsDirectory();
    await writeFile(join(directory, 'compose-fixture-owner.json'), 'retained ownership evidence');
    const result = await runSupervisorPrimitives(
      directory,
      [
        `set -m; bash -c '(trap "" TERM; while :; do sleep 1; done) </dev/null >/dev/null 2>&1 & exit 0' & test_pgid=$!; set +m`,
        `trap 'kill -KILL -- "-$test_pgid" 2>/dev/null || true' EXIT`,
        'sleep 0.2',
        // Establish actual liveness independently; cleanup must refuse even if its bounded
        // production probe is unusable. Do not turn a slow observer into permission to delete.
        '"$process_group_probe_command" "$test_pgid"; printf "before=%s\\n" "$?"',
        'run_command_in_own_group_bounded() { echo entered > "$diagnostics_dir/cleanup-entered"; }',
        'cleanup_compose_fixture',
        'printf "status=%s\\n" "$?"',
      ].join('\n'),
    );
    expect(readKeyedOutput(result.stdout, 'before'), JSON.stringify(result)).toBe('0');
    expect(readKeyedOutput(result.stdout, 'status'), JSON.stringify(result)).toBe('1');
    await expect(readFile(join(directory, 'cleanup-entered'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(directory, 'compose-fixture-owner.json'), 'utf8')).toBe(
      'retained ownership evidence',
    );
  });

  it('kills the whole redaction command group when its budget expires', async () => {
    const directory = await createDiagnosticsDirectory();
    const result = await runSupervisorPrimitives(
      directory,
      [
        "# A stalled redactor whose grandchild would otherwise hold the supervisor's pipes open.",
        `run_command_in_own_group_bounded 300 output_redaction bash -c 'echo $$ > "$diagnostics_dir/redactor.pid"; ( trap "" TERM; while :; do sleep 5; done ) & echo $! > "$diagnostics_dir/grandchild.pid"; wait'`,
        'status=$?',
        'grandchild_pid=$(cat "$diagnostics_dir/grandchild.pid")',
        'if kill -0 "$grandchild_pid" 2>/dev/null; then echo "grandchild=alive"; else echo "grandchild=gone"; fi',
        'printf \'status=%s\n\' "$status"',
      ].join('\n'),
    );

    expect(result.stderr).toBe('');
    expect(readKeyedOutput(result.stdout, 'grandchild')).toBe('gone');
    expect(Number(readKeyedOutput(result.stdout, 'status'))).toBeGreaterThan(0);
    // The budget expiry is reported, so a stalled redactor stays visible in CI evidence.
    expect(await readFile(join(directory, 'watchdog-events.log'), 'utf8')).toContain(
      'reason=finalization_budget_exceeded phase=output_redaction action=SIGKILL',
    );
  });

  it('propagates the redaction status without waiting out its budget', async () => {
    const directory = await createDiagnosticsDirectory();
    const result = await runSupervisorPrimitives(
      directory,
      [
        'started=$(now_milliseconds)',
        "run_command_in_own_group_bounded 20000 output_redaction bash -c 'exit 7'",
        'status=$?',
        'elapsed=$(( $(now_milliseconds) - started ))',
        'printf \'status=%s\n\' "$status"',
        'printf \'elapsed=%s\n\' "$elapsed"',
      ].join('\n'),
    );

    expect(readKeyedOutput(result.stdout, 'status')).toBe('7');
    // Early exit: a finishing command is reaped at once instead of sleeping for its whole budget.
    expect(Number(readKeyedOutput(result.stdout, 'elapsed'))).toBeLessThan(3_000);
  });

  it('waits out a tearing-down process group instead of reporting a residual process', async () => {
    const directory = await createDiagnosticsDirectory();
    const result = await runSupervisorPrimitives(
      directory,
      [
        '# Leader exits immediately, its same-group child keeps running for 0.3s.',
        "set -m; bash -c 'sleep 0.3 & exit 0' & test_pgid=$!; set +m",
        'sleep 0.05',
        'started=$(now_milliseconds)',
        'wait_for_process_group_exit 2000',
        'probe_status=$?',
        'elapsed=$(( $(now_milliseconds) - started ))',
        'kill -KILL -- "-$test_pgid" 2>/dev/null || true',
        'printf \'probe=%s\\n\' "$probe_status"',
        'printf \'elapsed=%s\\n\' "$elapsed"',
      ].join('\n'),
    );

    // 1 = gone. A single instantaneous probe at t=0.05s would have said "alive" and failed the run.
    expect(readKeyedOutput(result.stdout, 'probe'), JSON.stringify(result)).toBe('1');
    expect(Number(readKeyedOutput(result.stdout, 'elapsed'))).toBeLessThan(2_000);
  });

  it('reaps a TERM-ignoring test group without reporting a cleanup failure', async () => {
    const directory = await createDiagnosticsDirectory();
    const result = await runSupervisorPrimitives(
      directory,
      [
        "# The supervisor's own external-signal path: child and descendant both ignore TERM.",
        `set -m; bash -c '( trap "" TERM; while :; do sleep 1; done ) & echo $! > "$diagnostics_dir/descendant.pid"; trap "" TERM; while :; do sleep 1; done' & launcher_pid=$!; test_pgid=$launcher_pid; set +m`,
        'sleep 0.2',
        'started=$(now_milliseconds)',
        'terminate_test_group',
        'terminate_status=$?',
        'elapsed=$(( $(now_milliseconds) - started ))',
        'descendant_pid=$(cat "$diagnostics_dir/descendant.pid")',
        'if kill -0 "$descendant_pid" 2>/dev/null; then echo "descendant=alive"; else echo "descendant=gone"; fi',
        'printf \'status=%s\\n\' "$terminate_status"',
        'printf \'phase=%s\\n\' "${cleanup_failure_phase:-none}"',
        'printf \'elapsed=%s\\n\' "$elapsed"',
      ].join('\n'),
    );

    // 0 = cleaned up. Any other status here is what turned a 143 exit into supervisor failure 126.
    expect(readKeyedOutput(result.stdout, 'status')).toBe('0');
    expect(readKeyedOutput(result.stdout, 'phase')).toBe('none');
    expect(readKeyedOutput(result.stdout, 'descendant')).toBe('gone');
    expect(Number(readKeyedOutput(result.stdout, 'elapsed'))).toBeLessThan(3_000);
  });

  it('clamps every stage timeout to the declared finalization budget', async () => {
    const directory = await createDiagnosticsDirectory();
    const nowBefore = Date.now();
    const result = await runSupervisorPrimitives(
      directory,
      [
        'printf \'stage_full=%s\\n\' "$(finalization_stage_timeout 3000)"',
        'printf \'stage_ceiling=%s\\n\' "$(finalization_stage_timeout 60000)"',
        'finalization_started_milliseconds=$(( $(now_milliseconds) - 60000 ))',
        'finalization_deadline_milliseconds=$(( finalization_started_milliseconds + 30000 ))',
        'printf \'remaining=%s\\n\' "$(finalization_remaining_milliseconds)"',
        'printf \'stage_exhausted=%s\\n\' "$(finalization_stage_timeout 3000)"',
        'printf \'duration_ms=%s\\n\' "$(milliseconds_from_duration 0.5s)"',
        'printf \'whole_seconds_ms=%s\\n\' "$(milliseconds_from_duration 1)"',
        'printf \'now=%s\\n\' "$(now_milliseconds)"',
      ].join('\n'),
    );

    expect(readKeyedOutput(result.stdout, 'stage_full')).toBe('3.000s');
    // A stage may never ask for more than the remaining budget, even if configured to.
    expect(readKeyedOutput(result.stdout, 'stage_ceiling')).toBe(
      `${supervisorFinalizationBudgetSeconds}.000s`,
    );
    expect(readKeyedOutput(result.stdout, 'remaining')).toBe('0');
    expect(readKeyedOutput(result.stdout, 'stage_exhausted')).toBe('0.050s');
    expect(readKeyedOutput(result.stdout, 'duration_ms')).toBe('500');
    expect(readKeyedOutput(result.stdout, 'whole_seconds_ms')).toBe('1000');
    const now = Number(readKeyedOutput(result.stdout, 'now'));
    expect(Number.isSafeInteger(now)).toBe(true);
    expect(Math.abs(now - nowBefore)).toBeLessThan(60_000);
  });
});
