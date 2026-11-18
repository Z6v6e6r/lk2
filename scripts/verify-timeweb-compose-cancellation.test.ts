import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { requireCancellationEvidence } from './verify-timeweb-compose-cancellation.js';

const identity = {
  project: 'lk2-standard-fixture-456',
  directory: '/synthetic/lk2-standard-fixture-Abc123',
};
const topology = { worker: 123, rehearsal: 456, supervisor: 789 };
function evidence(mode: string) {
  const worker = mode === 'worker-death';
  return {
    mode,
    exit: worker ? 126 : 143,
    stdout: `FIXTURE_WORKER_TOPOLOGY ${JSON.stringify(topology)}\nFIXTURE_IDENTITY ${JSON.stringify(identity)}\nFIXTURE_STAGE_START delayed-readiness\nFIXTURE_CANCELLATION_TRIGGERED ${mode}\n`,
    status: `test_pid=123\ntest_pgid=123\nchild_exit_status=${worker ? 137 : 143}\nexit_status=${worker ? 126 : 143}\ntermination=${worker ? 'supervisor_cleanup_failure' : 'external_signal_TERM'}\nfinalization=complete\ncleanup_failure_phase=${worker ? 'residual_process_group_after_nonzero_exit' : 'none'}\n`,
    cleanup: 'FIXTURE_CLEANUP_PASS containers=0 networks=0 duration_ms=100\n',
  };
}
function verify(input: ReturnType<typeof evidence>) {
  return requireCancellationEvidence(
    input.mode,
    input.exit,
    input.stdout,
    input.status,
    input.cleanup,
  );
}

describe('standalone Compose cancellation evidence', () => {
  it.each(['worker-death', 'supervisor-cancellation'])('accepts complete %s receipts', (mode) => {
    expect(verify(evidence(mode))).toEqual({ identity, topology });
  });
  it.each([
    'missing-readiness',
    'missing-trigger',
    'duplicate-identity',
    'duplicate-topology',
    'worker-is-rehearsal',
    'foreign-project',
    'relative-directory',
    'wrong-group',
    'duplicate-status',
    'unfinished',
    'cleanup-refused',
    'wrong-exit',
    'unexpected-phase',
  ])('fails closed for %s', (mutation) => {
    const input = evidence('worker-death');
    if (mutation === 'missing-readiness')
      input.stdout = input.stdout.replace('FIXTURE_STAGE_START delayed-readiness\n', '');
    if (mutation === 'missing-trigger')
      input.stdout = input.stdout.replace('FIXTURE_CANCELLATION_TRIGGERED worker-death\n', '');
    if (mutation === 'duplicate-identity')
      input.stdout += `FIXTURE_IDENTITY ${JSON.stringify(identity)}\n`;
    if (mutation === 'duplicate-topology')
      input.stdout += `FIXTURE_WORKER_TOPOLOGY ${JSON.stringify(topology)}\n`;
    if (mutation === 'worker-is-rehearsal')
      input.stdout = input.stdout.replace('"worker":123', '"worker":456');
    if (mutation === 'foreign-project')
      input.stdout = input.stdout.replace('lk2-standard-fixture-456', 'lk2-standard-fixture-999');
    if (mutation === 'relative-directory') input.stdout = input.stdout.replace('/synthetic/', '');
    if (mutation === 'wrong-group')
      input.status = input.status.replace('test_pgid=123', 'test_pgid=999');
    if (mutation === 'duplicate-status') input.status += 'exit_status=126\n';
    if (mutation === 'unfinished')
      input.status = input.status.replace(
        'finalization=complete',
        'finalization=child_exit_captured',
      );
    if (mutation === 'cleanup-refused') input.cleanup = 'Fixture cleanup refused';
    if (mutation === 'wrong-exit') input.exit = 0;
    if (mutation === 'unexpected-phase')
      input.status = input.status.replace(
        'residual_process_group_after_nonzero_exit',
        'compose_fixture_cleanup',
      );
    expect(() => verify(input)).toThrow();
  });

  it('runs real cancellation outside the Unit/integration watchdog, with no nested Docker unit harness', () => {
    const workflow = parse(readFileSync('.github/workflows/pull-request.yaml', 'utf8')) as {
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps: Array<{ name?: string; run?: string; 'timeout-minutes'?: number }>;
        }
      >;
    };
    const steps = workflow.jobs['quality-full']!.steps;
    const physicalIndex = steps.findIndex(
      (step) => step.name === 'Verify supervised Compose worker death and cancellation',
    );
    const unitIndex = steps.findIndex((step) => step.name === 'Unit and integration tests');
    expect(physicalIndex).toBeGreaterThanOrEqual(0);
    expect(physicalIndex).toBeLessThan(unitIndex);
    const step = steps[physicalIndex]!;
    expect(step['timeout-minutes']).toBe(8);
    expect(step.run).toContain('for mode in worker-death supervisor-cancellation');
    expect(step.run).toContain('scripts/run-ci-tests-with-diagnostics.sh');
    expect(step.run).toContain('node scripts/verify-timeweb-compose-cancellation.js "$mode"');
    expect(step.run).toContain('node scripts/verify-timeweb-compose-cancellation.js --verify');
    expect(step.run).toContain('|| result=$?');
    expect(workflow.jobs['quality-full']!.env?.TIMEWEB_STANDARD_DOCKER_VERIFY).toBe('1');
    expect(steps[unitIndex]?.run).toBe('scripts/run-ci-tests-with-diagnostics.sh');
    expect(readFileSync('scripts/run-ci-tests-with-diagnostics.test.ts', 'utf8')).not.toContain(
      'rehearse-timeweb-standard-compose.js',
    );
  });
});
