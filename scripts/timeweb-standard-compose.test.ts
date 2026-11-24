import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

it.skipIf(process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')(
  'rehearses actual isolated Compose Web success and forced same-digest rollback',
  () => {
    const started = performance.now();
    const evidence: Record<string, unknown> = {};
    const evidenceDirectory = '.ci-artifacts/test-and-coverage';
    const persistEvidence = () => {
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(
        join(evidenceDirectory, 'compose-fixture.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
    };
    const directory = mkdtempSync(join(tmpdir(), 'lk2-standard-fixture-'));
    const project = `lk2-standard-fixture-${process.pid}${randomInt(100000, 1000000)}`;
    const script = 'scripts/rehearse-timeweb-standard-compose.js';
    const env = {
      ...process.env,
      TIMEWEB_STANDARD_FIXTURE_DIRECTORY: directory,
      TIMEWEB_STANDARD_FIXTURE_PROJECT: project,
    };
    // Do not detach. Node, Docker and Compose stay in the outer supervisor's test PGID.
    // No cleanup runs here after timeout/worker death: only the surviving supervisor may
    // confirm that whole PGID is stopped, then consume the strict fixture ownership record.
    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: 'utf8',
      timeout: 300000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
    evidence.child = {
      elapsedMs: Math.round(performance.now() - started),
      error: result.error?.message ?? null,
      signal: result.signal,
      status: result.status,
      stdout: result.stdout?.slice(-16000),
      stderr: result.stderr?.slice(-6000),
      cleanupOwner: process.env.CI_TEST_DIAGNOSTICS_DIR ? 'outer-supervisor' : 'rehearsal',
    };
    persistEvidence();
    const diagnostics = JSON.stringify(evidence.child);
    console.log(diagnostics);
    expect(result.error, diagnostics).toBeUndefined();
    expect(result.signal, diagnostics).toBeNull();
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout).toContain('COMPOSE_HTTP_READY_GUARD_PASS');
    expect(result.stdout).toContain('STANDARD_COMPOSE_REHEARSAL_PASS');
    expect(result.stdout).toContain('API_WEB_COMPOSE_REHEARSAL_PASS');
    expect(result.stdout).toContain('FIXTURE_STAGE cleanup');
    expect(result.stdout).toContain(
      process.env.CI_TEST_DIAGNOSTICS_DIR
        ? 'FIXTURE_CLEANUP_DEFERRED_TO_OUTER_SUPERVISOR'
        : 'FIXTURE_CLEANUP_PASS containers=0 networks=0',
    );
  },
  // Local: 270 s body + 20 s cleanup < 300 s child < 340 s test.
  // CI cleanup is additionally bounded by the surviving supervisor's 30 s finalization budget.
  340000,
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
function checkReadinessProof(
  error: unknown,
  row: unknown,
  previousId = previousFixtureId,
  helperError = false,
) {
  const input = JSON.stringify({ error, row, project: readinessProject, previousId, helperError });
  const code = `import { requireUnavailableFixtureRejection as proof, requireFixtureHttpReady as ready } from './scripts/rehearse-timeweb-standard-compose.js';
    const input=${input};let error=input.error;if(input.helperError){try{ready(input.row,'web');}catch(own){error=own;Object.assign(error,input.error);}}
    try {proof(error,input.row,input.project,input.previousId);process.stdout.write('PROVEN');}
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

describe('strict owned HTTP rejection after Compose false success', () => {
  it.each(['starting', 'unhealthy'])('accepts only the actual helper error for %s', (health) => {
    const row = unavailableFixture();
    row.State.Health.Status = health;
    expect(checkReadinessProof({}, row, previousFixtureId, true).status).toBe(0);
  });
  it('does not invent rejection when the helper sees healthy', () => {
    const row = unavailableFixture();
    row.State.Health.Status = 'healthy';
    expect(checkReadinessProof(undefined, row, previousFixtureId, true).status).toBe(1);
  });
  it.each([
    undefined,
    {},
    { name: 'OWNED_FIXTURE_HTTP_NOT_READY' },
    { code: 'OWNED_FIXTURE_HTTP_NOT_READY' },
  ])('rejects unbranded or absent errors: %j', (error) => {
    expect(checkReadinessProof(error, unavailableFixture()).status).toBe(1);
  });
  it.each([{ status: 1 }, { status: 2 }, { status: 0 }, { signal: 'SIGTERM' }])(
    'rejects mutated helper errors: %j',
    (error) => {
      expect(checkReadinessProof(error, unavailableFixture(), previousFixtureId, true).status).toBe(
        1,
      );
    },
  );
  it('keeps final ownership and state checks on helper rejection', () => {
    const row = unavailableFixture();
    row.Config.Labels['fixture.owner'] = 'foreign';
    expect(checkReadinessProof({}, row, previousFixtureId, true).status).toBe(1);
    row.Config.Labels['fixture.owner'] = readinessProject;
    row.Id = previousFixtureId;
    expect(checkReadinessProof({}, row, previousFixtureId, true).status).toBe(1);
    row.Id = 'a'.repeat(64);
    row.State.Running = false;
    row.State.Status = 'exited';
    expect(checkReadinessProof({}, row, previousFixtureId, true).status).toBe(1);
  });
  it.each(['healthy', 'starting', 'unhealthy', null])(
    'the strict HTTP helper admits healthy only: %s',
    (health) => {
      const row = { State: { Health: { Status: health } } };
      const input = JSON.stringify(row);
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {requireFixtureHttpReady as ready} from './scripts/rehearse-timeweb-standard-compose.js';try{ready(${input},'web');process.stdout.write('READY');}catch(error){process.stderr.write(error.name);process.exitCode=1;}`,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(health === 'healthy' ? 0 : 1);
      expect(health === 'healthy' ? result.stdout : result.stderr).toBe(
        health === 'healthy' ? 'READY' : 'OWNED_FIXTURE_HTTP_NOT_READY',
      );
    },
  );
});

describe('owned fixture cleanup admission', () => {
  it.each([
    'valid',
    'project',
    'container-id',
    'container-owner',
    'container-project',
    'network-id',
    'network-owner',
    'network-project',
    'network-public',
  ])('refuses any foreign cleanup resource: %s', (mutation) => {
    const row = unavailableFixture();
    const network = {
      Id: 'c'.repeat(64),
      Internal: true,
      Labels: { 'fixture.owner': readinessProject, 'com.docker.compose.project': readinessProject },
    };
    if (mutation === 'container-id') row.Id = 'bad';
    if (mutation === 'container-owner') row.Config.Labels['fixture.owner'] = 'foreign';
    if (mutation === 'container-project')
      row.Config.Labels['com.docker.compose.project'] = 'foreign';
    if (mutation === 'network-id') network.Id = 'bad';
    if (mutation === 'network-owner') network.Labels['fixture.owner'] = 'foreign';
    if (mutation === 'network-project') network.Labels['com.docker.compose.project'] = 'foreign';
    if (mutation === 'network-public') network.Internal = false;
    const project = mutation === 'project' ? 'foreign' : readinessProject;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {requireOwnedFixtureResources as proof} from './scripts/rehearse-timeweb-standard-compose.js';try{proof(${JSON.stringify(project)},[${JSON.stringify(row)}],[${JSON.stringify(network)}]);process.stdout.write('OWNED');}catch(error){process.stderr.write(error.message);process.exitCode=1;}`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(mutation === 'valid' ? 0 : 1);
    expect(mutation === 'valid' ? result.stdout : result.stderr).toBe(
      mutation === 'valid'
        ? 'OWNED'
        : mutation === 'project'
          ? 'Invalid fixture project'
          : mutation.startsWith('network')
            ? 'Fixture network ownership lost'
            : 'Fixture container ownership lost',
    );
  });
});
