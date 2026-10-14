import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

it.skipIf(process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')(
  'rehearses actual isolated Compose Web success and forced same-digest rollback',
  () => {
    const result = spawnSync(process.execPath, ['scripts/rehearse-timeweb-standard-compose.js'], {
      encoding: 'utf8',
      timeout: 180000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('COMPOSE_HTTP_READY_GUARD_PASS');
    expect(result.stdout).toContain('STANDARD_COMPOSE_REHEARSAL_PASS');
    expect(result.stdout).toContain('API_WEB_COMPOSE_REHEARSAL_PASS');
  },
  180000,
);

const readinessProject = 'lk2-standard-fixture-123';
const previousFixtureId = 'b'.repeat(64);
const unavailableFixture = () => ({
  Id: 'a'.repeat(64),
  Config: {
    Cmd: ['sleep', '60'],
    Labels: {
      'com.docker.compose.project': readinessProject,
      'com.docker.compose.service': 'web',
      'fixture.owner': readinessProject,
      'phub.release-id': 'previous',
    },
  },
  State: { Running: true, Status: 'running', Health: { Status: 'starting' } },
});
function checkReadinessProof(error: unknown, row: unknown, previousId = previousFixtureId) {
  const input = JSON.stringify({ error, row, project: readinessProject, previousId });
  const code = `import { requireUnavailableFixtureRejection as proof } from './scripts/rehearse-timeweb-standard-compose.js';
    const input=${input};try {proof(input.error,input.row,input.project,input.previousId);process.stdout.write('PROVEN');}
    catch(error){process.stderr.write(String(error));process.exitCode=1;}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 5000,
  });
}
describe('owned unavailable Compose fixture proof', () => {
  it.each(['', 'context deadline exceeded', 'untranslated diagnostic'])(
    'proves rejection without diagnostic wording: %s',
    (stderr) => {
      const result = checkReadinessProof({ status: 1, stderr }, unavailableFixture());
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('PROVEN');
    },
  );
  it('accepts an already unhealthy unavailable fixture', () => {
    const row = unavailableFixture();
    row.State.Health.Status = 'unhealthy';
    expect(checkReadinessProof({ status: 1 }, row).status).toBe(0);
  });
  it.each([0, 2, null, undefined])('rejects an unexpected exit status: %s', (status) => {
    const result = checkReadinessProof({ status }, unavailableFixture());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not proven');
  });
  it.each([
    'id',
    'project',
    'owner',
    'service',
    'release',
    'command',
    'running',
    'state',
    'healthy',
    'same',
  ])('rejects unrelated fixture state: %s', (drift) => {
    const row = unavailableFixture();
    if (drift === 'id') row.Id = 'short';
    if (drift === 'project') row.Config.Labels['com.docker.compose.project'] = 'foreign';
    if (drift === 'owner') row.Config.Labels['fixture.owner'] = 'foreign';
    if (drift === 'service') row.Config.Labels['com.docker.compose.service'] = 'api';
    if (drift === 'release') row.Config.Labels['phub.release-id'] = 'candidate';
    if (drift === 'command') row.Config.Cmd = ['nginx'];
    if (drift === 'running') row.State.Running = false;
    if (drift === 'state') row.State.Status = 'exited';
    if (drift === 'healthy') row.State.Health.Status = 'healthy';
    if (drift === 'same') row.Id = previousFixtureId;
    expect(checkReadinessProof({ status: 1 }, row).status).toBe(1);
  });
  it('rejects signals, missing inspection and missing previous identity', () => {
    expect(checkReadinessProof({ status: 1, signal: 'SIGTERM' }, unavailableFixture()).status).toBe(
      1,
    );
    expect(checkReadinessProof({ status: 1 }, undefined).status).toBe(1);
    expect(checkReadinessProof({ status: 1 }, unavailableFixture(), '').status).toBe(1);
  });
  it('bounds failure diagnostics', () => {
    const result = checkReadinessProof(
      { status: 0, stderr: 'x'.repeat(10000) },
      unavailableFixture(),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeLessThan(1800);
  });
});
