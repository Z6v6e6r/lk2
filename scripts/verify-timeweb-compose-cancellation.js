import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readFileSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modes = ['worker-death', 'supervisor-cancellation'];
const fail = () => {
  throw Error('COMPOSE_CANCELLATION_PROOF_INVALID');
};

// Pure receipt validation is unit tested; only the standalone CI step exercises Docker/signals.
export function requireCancellationEvidence(mode, exitStatus, stdout, status, cleanup) {
  if (!modes.includes(mode)) fail();
  const fields = new Map();
  for (const line of status.trim().split('\n')) {
    const equals = line.indexOf('=');
    if (equals <= 0 || fields.has(line.slice(0, equals))) fail();
    fields.set(line.slice(0, equals), line.slice(equals + 1));
  }
  const identityLines = stdout.split('\n').filter((line) => line.startsWith('FIXTURE_IDENTITY '));
  const topologyLines = stdout
    .split('\n')
    .filter((line) => line.startsWith('FIXTURE_WORKER_TOPOLOGY '));
  if (identityLines.length !== 1 || topologyLines.length !== 1) fail();
  const identity = JSON.parse(identityLines[0].slice('FIXTURE_IDENTITY '.length));
  const topology = JSON.parse(topologyLines[0].slice('FIXTURE_WORKER_TOPOLOGY '.length));
  if (
    ![topology.worker, topology.rehearsal, topology.supervisor].every(
      (pid) => Number.isSafeInteger(pid) && pid > 1,
    ) ||
    new Set([topology.worker, topology.rehearsal, topology.supervisor]).size !== 3 ||
    identity.project !== `lk2-standard-fixture-${topology.rehearsal}` ||
    typeof identity.directory !== 'string' ||
    identity.directory !== resolve(identity.directory) ||
    !/^lk2-standard-fixture-[A-Za-z0-9]+$/.test(basename(identity.directory)) ||
    fields.get('test_pid') !== String(topology.worker) ||
    fields.get('test_pgid') !== String(topology.worker) ||
    fields.get('finalization') !== 'complete' ||
    !stdout.includes('FIXTURE_STAGE_START delayed-readiness\n') ||
    !stdout.includes(`FIXTURE_CANCELLATION_TRIGGERED ${mode}\n`) ||
    !cleanup.includes('FIXTURE_CLEANUP_PASS containers=0 networks=0')
  )
    fail();
  if (mode === 'worker-death') {
    // The surviving rehearsal is intentionally a residual group after its ancestor dies.
    if (
      exitStatus !== 126 ||
      fields.get('exit_status') !== '126' ||
      fields.get('child_exit_status') !== '137' ||
      fields.get('termination') !== 'supervisor_cleanup_failure' ||
      fields.get('cleanup_failure_phase') !== 'residual_process_group_after_nonzero_exit'
    )
      fail();
  } else if (
    exitStatus !== 143 ||
    fields.get('exit_status') !== '143' ||
    fields.get('termination') !== 'external_signal_TERM' ||
    fields.get('cleanup_failure_phase') !== 'none'
  )
    fail();
  return { identity, topology };
}

function verify(mode, directory, exitStatus) {
  const { identity, topology } = requireCancellationEvidence(
    mode,
    exitStatus,
    readFileSync(join(directory, 'stdout.log'), 'utf8'),
    readFileSync(join(directory, 'status.txt'), 'utf8'),
    readFileSync(join(directory, 'compose-fixture-cleanup.log'), 'utf8'),
  );
  for (const path of [join(directory, 'compose-fixture-owner.json'), identity.directory]) {
    try {
      lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    fail();
  }
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 5000,
  });
  let sawVerifier = false;
  for (const line of rows.trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    const [pid, pgid, state] = fields;
    if (fields.length !== 3 || !/^[1-9][0-9]*$/.test(pid) || !/^[0-9]+$/.test(pgid) || !state)
      fail();
    if (Number(pid) === process.pid) sawVerifier = true;
    if (
      !state?.startsWith('Z') &&
      (Number(pgid) === topology.worker || Number(pid) === topology.rehearsal)
    )
      fail();
  }
  if (!sawVerifier) fail();
  for (const args of [
    ['ps', '-aq', '--filter', `label=fixture.owner=${identity.project}`],
    ['network', 'ls', '-q', '--filter', `label=fixture.owner=${identity.project}`],
  ]) {
    if (execFileSync('docker', args, { encoding: 'utf8', timeout: 5000 }).trim()) fail();
  }
  console.log(
    `COMPOSE_CANCELLATION_PASS ${mode} processes=0 containers=0 networks=0 directory=absent`,
  );
}

function worker(mode) {
  const directory = process.env.CI_TEST_DIAGNOSTICS_DIR;
  if (
    process.platform !== 'linux' ||
    !modes.includes(mode) ||
    !directory ||
    process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1' ||
    Number(readFileSync(join(directory, 'test.pid'), 'utf8').trim()) !== process.pid ||
    !readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').includes(
      'run-ci-tests-with-diagnostics.sh',
    )
  )
    fail();
  // This is an ordinary child, NOT another supervisor/session. The one surviving CI owner
  // controls this worker, the rehearsal and all Compose descendants through the same PGID.
  const child = spawn(process.execPath, ['scripts/rehearse-timeweb-standard-compose.js'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  writeSync(
    1,
    `FIXTURE_WORKER_TOPOLOGY ${JSON.stringify({ worker: process.pid, rehearsal: child.pid, supervisor: process.ppid })}\n`,
  );
  let tail = '';
  let triggered = false;
  const deadline = setTimeout(() => process.exit(1), 140000);
  child.stdout.on('data', (bytes) => {
    writeSync(1, bytes);
    tail = (tail + bytes.toString()).slice(-8000);
    if (!triggered && tail.includes('FIXTURE_STAGE_START delayed-readiness\n')) {
      const group = (pid) =>
        Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 5000,
          }).trim(),
        );
      if (group(process.pid) !== process.pid || group(child.pid) !== process.pid) fail();
      triggered = true;
      writeSync(1, `FIXTURE_CANCELLATION_TRIGGERED ${mode}\n`);
      process.kill(
        mode === 'worker-death' ? process.pid : process.ppid,
        mode === 'worker-death' ? 'SIGKILL' : 'SIGTERM',
      );
    }
  });
  child.once('error', () => {
    clearTimeout(deadline);
    process.exitCode = 1;
  });
  child.once('close', () => {
    clearTimeout(deadline);
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === '--verify')
    verify(process.argv[3], process.argv[4], Number(process.argv[5]));
  else worker(process.argv[2]);
}
