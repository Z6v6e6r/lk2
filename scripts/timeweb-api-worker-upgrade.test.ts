import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_WORKER_BRIDGE as bridge,
  apiWorkerComposeArgs,
  apiWorkerSmokeArgs,
  runApiWorkerTransition,
  recoverApiWorkerPhase,
  validateApiWorkerOperation,
  validateApiWorkerLedger,
  validateApiWorkerReceipt,
  validateApiWorkerControllerDelta,
  parseApiWorkerControllerDiff,
  API_WORKER_CI_DOWNLOAD_PATCH,
  API_WORKER_CI_READER_PATCH,
  validateApiWorkerDatabase,
  API_WORKER_GATE_LOCK_SQL,
  API_WORKER_DATABASE_SQL,
  openApiWorkerDatabaseFence,
  overlay,
  validateApiWorkerMount,
  acquireApiWorkerExecutor,
  validateApiWorkerBackupLedger,
  encodeApiWorkerCapsule,
  readApiWorkerCapsule,
  validateInstalledApiWorkerEvidence,
} from './timeweb-api-worker-upgrade.js';

import { hash, id, root, ledger, operation, capsuleFixture } from './timeweb-api-worker.fixture.js';
function transitionFixture(failAt?: string) {
  const calls: string[] = [];
  let failed = false;
  const call = async (name: string) => {
    await Promise.resolve();
    calls.push(name);
    if (name === failAt && !failed) {
      failed = true;
      throw new Error('synthetic');
    }
  };
  const ops = {
    preflight: () => call('preflight'),
    pullAndSmoke: () => call('pull'),
    journal: (phase: string) => call(`journal:${phase}`),
    containWorker: () => call('stopWorker'),
    installSecrets: () => call('installSecrets'),
    activate: (service: string) => call(`activate:${service}`),
    observe: () => call('observe'),
    attestCandidate: () => call('candidate'),
    installBaseline: () => call('baseline'),
    releaseFence: () => call('commit'),
    restoreSecrets: () => call('restoreSecrets'),
    restore: (service: string) => call(`restore:${service}`),
    removeCandidateBaseline: () => call('removeBaseline'),
    attestPrevious: () => call('previous'),
  };
  return { calls, ops };
}
afterEach(() => vi.restoreAllMocks());
describe('API + Worker exact manual bridge', () => {
  it('binds source, immutable publication, zero provider scope and previous null Worker label', () => {
    expect(validateApiWorkerOperation(operation(), Date.parse('2026-10-11T20:00:00.000Z'))).toEqual(
      operation(),
    );
    for (const edit of [
      { fcmEnvironment: 'PRODUCTION' },
      { controllerSourceCiRunId: '0' },
      { manifestSha256: '0'.repeat(64) },
      { expiresAt: '2026-10-11T20:01:00.000Z' },
      { confirmation: 'UPGRADE_ALL' },
    ])
      expect(() =>
        validateApiWorkerOperation(
          { ...operation(), ...edit },
          Date.parse('2026-10-11T20:00:00.000Z'),
        ),
      ).toThrow();
    expect(() =>
      validateApiWorkerOperation({
        ...operation(),
        expectedWorker: { ...operation().expectedWorker, releaseId: id },
      }),
    ).toThrow();
    expect(() =>
      validateApiWorkerOperation({
        ...operation(),
        target: { hostname: 'another', serverId: 8886471, projectId: 262717 },
      }),
    ).toThrow();
  });
  it('requires all 101 exact migrations and a backup restored from that same ledger', () => {
    validateApiWorkerLedger(ledger, ledger);
    for (const applied of [
      ledger.slice(0, -2),
      [...ledger, { filename: '0101_foreign.sql', checksum: '0'.repeat(64) }],
      [...ledger].reverse(),
      ledger.map((v, i) => (i === 0 ? { ...v, checksum: '0'.repeat(64) } : v)),
    ])
      expect(() => validateApiWorkerLedger(applied, ledger)).toThrow('LEDGER');
    const expected = hash(JSON.stringify(ledger.map((v) => [v.filename, v.checksum])) + '\n');
    validateApiWorkerBackupLedger(
      {
        sourceLedgerSha256: expected,
        restoredLedgerSha256: expected,
        restoreImage: bridge.postgresImage,
      },
      ledger,
    );
    expect(() =>
      validateApiWorkerBackupLedger(
        {
          sourceLedgerSha256: hash('99'),
          restoredLedgerSha256: hash('99'),
          restoreImage: bridge.postgresImage,
        },
        ledger,
      ),
    ).toThrow('BACKUP_LEDGER');
  });
  it('allows only controller-owned source delta and only API/Worker no-deps commands', () => {
    validateApiWorkerControllerDelta([
      {
        status: 'A',
        oldMode: '000000',
        newMode: '100644',
        oldOid: '0'.repeat(40),
        newOid: 'a'.repeat(40),
        path: 'scripts/timeweb-api-worker-contract.js',
      },
    ]);
    for (const entry of [
      { status: 'D', path: 'scripts/timeweb-api-worker-upgrade.js' },
      { status: 'M', path: 'deploy/timeweb/compose.beta.yaml' },
      { status: 'M', path: 'apps/api/src/main.ts' },
    ])
      expect(() => validateApiWorkerControllerDelta([entry])).toThrow();
    const args = apiWorkerComposeArgs('/baseline', '/overlay', 'up', 'worker');
    expect(args.slice(-6)).toEqual(['--profile', 'background', 'up', '-d', '--no-deps', 'worker']);
    expect(() => apiWorkerComposeArgs('/baseline', '/overlay', 'up', 'migrator')).toThrow();
    expect(
      apiWorkerSmokeArgs('api', `ghcr.io/z6v6e6r/phub-api@${bridge.candidateApiDigest}`),
    ).toContain('none');
    const f = capsuleFixture();
    expect(overlay(f.plan, 'candidate', 'worker')).toContain(
      'TIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
    );
    expect(overlay(f.plan, 'previous', 'worker')).toContain(
      'TIMEWEB_FCM_CREDENTIAL_SOURCE=/dev/null',
    );
    expect(() =>
      validateApiWorkerMount([
        {
          Destination: '/run/phub/fcm-service-account.json',
          Type: 'bind',
          Source: '/dev/null',
          RW: false,
        },
      ]),
    ).toThrow();
    validateApiWorkerMount(
      [
        {
          Destination: '/run/phub/fcm-service-account.json',
          Type: 'bind',
          Source: '/dev/null',
          RW: false,
        },
      ],
      '/dev/null',
    );
  });
  it('recovers the complete capsule even before materialized operation/plan/journal exist', () => {
    const f = capsuleFixture();
    expect(
      readApiWorkerCapsule(Buffer.from(encodeApiWorkerCapsule(f.operationBytes, f.planBytes))).plan,
    ).toEqual(f.plan);
    expect(() =>
      readApiWorkerCapsule(
        Buffer.from(encodeApiWorkerCapsule(f.operationBytes, Buffer.from('{}'))),
      ),
    ).toThrow();
    expect(() =>
      readApiWorkerCapsule(
        Buffer.from('{"schema":"PHUB_TIMEWEB_API_WORKER_CAPSULE_V1","operation":"%%%","plan":""}'),
      ),
    ).toThrow();
  });
  it('preserves manual gates and runs observation before committing fence and success', async () => {
    const f = transitionFixture();
    await runApiWorkerTransition(f.ops);
    expect(f.calls).toEqual([
      'preflight',
      'pull',
      'journal:PREPARED',
      'journal:WORKER_STOP_INTENT',
      'stopWorker',
      'journal:WORKER_STOPPED',
      'journal:SECRET_SWAP_INTENT',
      'installSecrets',
      'journal:SECRETS_ACTIVE',
      'journal:API_INTENT',
      'activate:api',
      'journal:API_ACTIVE',
      'journal:WORKER_INTENT',
      'activate:worker',
      'journal:WORKER_ACTIVE',
      'journal:OBSERVING',
      'observe',
      'candidate',
      'journal:BASELINE_INTENT',
      'baseline',
      'journal:GATE_RELEASE_INTENT',
      'commit',
      'journal:SUCCESS',
    ]);
  });
  it.each([
    'journal:WORKER_STOP_INTENT',
    'stopWorker',
    'journal:WORKER_STOPPED',
    'journal:SECRET_SWAP_INTENT',
    'installSecrets',
    'journal:SECRETS_ACTIVE',
    'journal:API_INTENT',
    'activate:api',
    'journal:API_ACTIVE',
    'journal:WORKER_INTENT',
    'activate:worker',
    'journal:WORKER_ACTIVE',
    'journal:OBSERVING',
    'observe',
    'candidate',
    'journal:BASELINE_INTENT',
    'baseline',
    'journal:GATE_RELEASE_INTENT',
    'commit',
    'journal:SUCCESS',
  ])('contains Worker before restoring settings after %s failure', async (failure) => {
    const f = transitionFixture(failure);
    await expect(runApiWorkerTransition(f.ops)).rejects.toThrow('synthetic');
    expect(f.calls.slice(f.calls.lastIndexOf('journal:ROLLBACK_INTENT'))).toEqual([
      'journal:ROLLBACK_INTENT',
      'stopWorker',
      'journal:WORKER_CONTAINED',
      'restoreSecrets',
      'journal:PREVIOUS_SECRETS',
      'restore:api',
      'restore:worker',
      'removeBaseline',
      'previous',
      'journal:ROLLED_BACK',
    ]);
  });
  it('does no rollback write if containment fails and retains failure receipt', async () => {
    const f = transitionFixture();
    f.ops.containWorker = () => {
      f.calls.push('stopFailed');
      return Promise.reject(Error('stopped unknown'));
    };
    await expect(recoverApiWorkerPhase('WORKER_ACTIVE', f.ops)).rejects.toThrow('ROLLBACK_FAILED');
    expect(f.calls).toEqual(['journal:ROLLBACK_INTENT', 'stopFailed', 'journal:ROLLBACK_FAILED']);
  });
  it.each(['PREPARING', 'PREPARED'])(
    'aborts %s without service or secret mutations',
    async (phase) => {
      const f = transitionFixture();
      await recoverApiWorkerPhase(phase, f.ops);
      expect(f.calls).toEqual(['previous', 'journal:ABORTED']);
    },
  );
  it.each([
    'WORKER_STOP_INTENT',
    'WORKER_STOPPED',
    'SECRET_SWAP_INTENT',
    'SECRETS_ACTIVE',
    'API_INTENT',
    'API_ACTIVE',
    'WORKER_INTENT',
    'WORKER_ACTIVE',
    'OBSERVING',
    'BASELINE_INTENT',
    'GATE_RELEASE_INTENT',
    'ROLLBACK_INTENT',
    'WORKER_CONTAINED',
    'PREVIOUS_SECRETS',
    'ROLLBACK_FAILED',
  ])('can recover persisted crash phase %s', async (phase) => {
    const f = transitionFixture();
    await recoverApiWorkerPhase(phase, f.ops);
    expect(f.calls[1]).toBe('stopWorker');
    expect(f.calls.at(-1)).toBe('journal:ROLLED_BACK');
  });
  it.each(['SUCCESS', 'RECONCILED', 'ROLLED_BACK', 'unknown'])(
    'requires a separate operator decision for terminal phase %s',
    async (phase) => {
      await expect(recoverApiWorkerPhase(phase, transitionFixture().ops)).rejects.toThrow(
        'RECOVERY_PHASE',
      );
    },
  );
  it('refuses receipt substitution and incomplete success', () => {
    const receipt = {
      schema: 'PHUB_TIMEWEB_API_WORKER_RECEIPT_V1',
      status: 'PREPARING',
      planSha256: 'a'.repeat(64),
      observedAt: '2026-10-11T20:00:00.000Z',
    };
    validateApiWorkerReceipt(receipt, 'a'.repeat(64));
    expect(() => validateApiWorkerReceipt(receipt, 'b'.repeat(64))).toThrow();
    expect(() =>
      validateApiWorkerReceipt({ ...receipt, status: 'SUCCESS' }, 'a'.repeat(64)),
    ).toThrow();
  });
  it('checks all tenants, provider gates, live leases and the same persistent backend', () => {
    expect(API_WORKER_GATE_LOCK_SQL).toContain('notification-runtime:');
    expect(API_WORKER_GATE_LOCK_SQL).toContain('android-push-provider:');
    expect(API_WORKER_GATE_LOCK_SQL).not.toContain('WHERE status');
    expect(API_WORKER_DATABASE_SQL).not.toMatch(/UPDATE|DELETE|INSERT/);
    const value = {
      backendPid: 42,
      transactionStartedAt: '2026-10-11T20:00:00.000Z',
      readOnly: 'on',
      superuser: true,
      bypassRls: true,
      tenantCount: 1,
      tenantFingerprint: 'a'.repeat(32),
      androidEnabledTenants: 0,
      activeProviders: 0,
      liveLeases: 0,
      ledger,
    };
    validateApiWorkerDatabase(value, ledger, value);
    for (const edit of [
      { readOnly: 'off' },
      { superuser: false },
      { bypassRls: false },
      { androidEnabledTenants: 1 },
      { activeProviders: 1 },
      { liveLeases: 1 },
      { backendPid: 43 },
      { tenantFingerprint: 'b'.repeat(32) },
    ])
      expect(() => validateApiWorkerDatabase({ ...value, ...edit }, ledger, value)).toThrow();
  });
  it('validates installed mixed baseline against source, unchanged components and 15m evidence', () => {
    const f = capsuleFixture(),
      values = {
        PHUB_RELEASE_ID: id,
        PHUB_COMPONENT_ROLLOUT_KIND: 'API_WORKER',
        PHUB_COMPONENT_ROLLOUT_RECEIPT: `${root}/backups/${id}-api-worker/rollout-receipt.json`,
        PHUB_RUNTIME_SECRET_SET_RELEASE_ID: id,
        API_IMAGE_DIGEST: bridge.candidateApiDigest,
        WORKER_IMAGE_DIGEST: bridge.candidateWorkerDigest,
        ...f.plan.unchangedImages,
      },
      bytes = Buffer.from(JSON.stringify(values));
    const start = Date.parse('2026-10-11T20:00:00.000Z');
    const evidence = {
      'observation.json': Buffer.from(
        JSON.stringify({
          schema: 'PHUB_TIMEWEB_API_WORKER_OBSERVATION_V1',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date(start + 900000).toISOString(),
          samples: Array.from({ length: 61 }, (_, i) => new Date(start + i * 15000).toISOString()),
          providerActivation: false,
          deviceDelivery: false,
        }),
      ),
      'timeweb-monitor-readback.json': Buffer.from('{}'),
      'alert-test-readback.json': Buffer.from('{}'),
    };
    const receipt = {
      schema: 'PHUB_TIMEWEB_API_WORKER_RECEIPT_V1',
      status: 'SUCCESS',
      planSha256: hash(f.planBytes),
      observedAt: new Date(start + 900000).toISOString(),
      installedBaselineSha256: hash(bytes),
      observationSha256: hash(evidence['observation.json']),
      providerReadbackSha256: hash(evidence['timeweb-monitor-readback.json']),
      alertReadbackSha256: hash(evidence['alert-test-readback.json']),
    };
    const args = {
      releaseId: id,
      values,
      bytes,
      receipt,
      planBytes: f.planBytes,
      operationBytes: f.operationBytes,
      evidence,
    };
    validateInstalledApiWorkerEvidence(args);
    for (const edit of [
      { PHUB_COMPONENT_ROLLOUT_KIND: 'API_WEB' },
      { PHUB_COMPONENT_ROLLOUT_RECEIPT: '/foreign' },
      { PHUB_RELEASE_SOURCE_SHA: bridge.apiSource },
      { WEB_IMAGE_DIGEST: bridge.candidateApiDigest },
      { WORKER_IMAGE_DIGEST: bridge.workerDigest },
    ])
      expect(() =>
        validateInstalledApiWorkerEvidence({ ...args, values: { ...values, ...edit } }),
      ).toThrow();
    expect(() =>
      validateInstalledApiWorkerEvidence({
        ...args,
        evidence: { ...evidence, 'observation.json': Buffer.from('{}') },
      }),
    ).toThrow();
  });
});
function fakePsql() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const writes: string[] = [];
  child.stdin.on('data', (c: Buffer) => writes.push(c.toString()));
  const factory = vi.fn(() => child);
  return { child, writes, factory };
}
describe('persistent read-only database fence protocol', () => {
  it('holds one READ COMMITTED READ ONLY connection and nonce-bound results', async () => {
    const f = fakePsql(),
      fence = openApiWorkerDatabaseFence(bridge.postgresId, f.factory);
    const first = fence.query('SELECT 1');
    const nonce = f.writes[0]!.match(/'nonce','([a-f0-9]+)'/)![1];
    f.child.stdout.write(JSON.stringify({ nonce, result: 1 }) + '\n');
    expect(await first).toBe(1);
    const second = fence.query('SELECT 2');
    const n = f.writes[1]!.match(/'nonce','([a-f0-9]+)'/)![1];
    f.child.stdout.write(JSON.stringify({ nonce: n, result: 2 }) + '\n');
    expect(await second).toBe(2);
    expect(f.writes.join('')).toContain('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(f.writes[1]).not.toContain('BEGIN');
    expect(f.factory).toHaveBeenCalledTimes(1);
    const commit = fence.commit();
    f.child.emit('exit', 0);
    await commit;
    expect(f.writes.join('')).toContain('COMMIT;');
  });
  it.each(['wrong nonce', 'invalid utf8', 'truncated exit', 'stdin error', 'process error'])(
    'fails closed on %s without reconnect',
    async (mode) => {
      const f = fakePsql(),
        fence = openApiWorkerDatabaseFence(bridge.postgresId, f.factory),
        query = fence.query('SELECT 1');
      const assertion = expect(query).rejects.toThrow('FENCE_LOST');
      if (mode === 'wrong nonce') f.child.stdout.write('{"nonce":"foreign","result":1}\n');
      else if (mode === 'invalid utf8') f.child.stdout.write(Buffer.from([0xff, 10]));
      else if (mode === 'stdin error') f.child.stdin.emit('error', Error('EPIPE'));
      else if (mode === 'process error') f.child.emit('error', Error('lost'));
      else {
        f.child.stdout.write('{"nonce":');
        f.child.emit('exit', 1);
      }
      await assertion;
      expect(() => fence.assertAlive()).toThrow();
      expect(f.factory).toHaveBeenCalledTimes(1);
    },
  );
  it('never claims success after ambiguous COMMIT', async () => {
    const f = fakePsql(),
      fence = openApiWorkerDatabaseFence(bridge.postgresId, f.factory),
      commit = fence.commit(),
      assertion = expect(commit).rejects.toThrow('COMMIT_UNKNOWN');
    f.child.emit('exit', 1);
    await assertion;
  });
});
describe('kernel executor ownership', () => {
  it('pins a regular private inode and rejects replacement without deleting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phub-executor-')),
      path = join(dir, 'lock');
    chmodSync(dir, 0o700);
    try {
      const command = vi.fn();
      const lock = acquireApiWorkerExecutor(
        path,
        process.getuid?.() ?? 0,
        process.getgid?.() ?? 0,
        command,
      );
      expect(command.mock.calls[0]?.slice(0, 2)).toEqual(['/usr/bin/flock', ['--nonblock', '3']]);
      renameSync(path, join(dir, 'old'));
      writeFileSync(path, '', { mode: 0o600 });
      expect(() => lock.assertOwned()).toThrow('EXECUTOR_DRIFT');
      lock.close();
      expect(readFileSync(path).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== 'linux' || !process.getuid)(
    'retains the inherited flock across child exit and releases it on owner process death',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'phub-flock-')),
        path = join(dir, 'lock');
      chmodSync(dir, 0o700);
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {acquireApiWorkerExecutor} from './scripts/timeweb-api-worker-upgrade.js';acquireApiWorkerExecutor(process.argv[1],process.getuid(),process.getgid());process.stdout.write('LOCKED\\n');process.stdin.resume();",
          path,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('holder timeout')), 5000);
          child.once('error', reject);
          child.stdout.once('data', (bytes: Buffer) => {
            clearTimeout(timeout);
            if (bytes.toString() === 'LOCKED\n') resolve();
            else reject(Error('holder protocol'));
          });
        });
        expect(() =>
          acquireApiWorkerExecutor(path, process.getuid!(), process.getgid!()),
        ).toThrow();
        child.kill('SIGKILL');
        await exited;
        const next = acquireApiWorkerExecutor(path, process.getuid!(), process.getgid!());
        next.close();
        expect(execFileSync('/usr/bin/flock', ['--version'], { encoding: 'utf8' })).toContain(
          'flock',
        );
      } finally {
        child.kill('SIGKILL');
        await exited;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('frozen CI download patch authority', () => {
  const pair = () => API_WORKER_CI_DOWNLOAD_PATCH.map((v) => ({ ...v }));
  const raw = (rows: ReturnType<typeof pair>) =>
    rows
      .map((v) => `:${v.oldMode} ${v.newMode} ${v.oldOid} ${v.newOid} ${v.status}\0${v.path}\0`)
      .join('');
  it('admits the exact atomic regular pair and preserves both Git blob identities', () => {
    expect(parseApiWorkerControllerDiff(raw(pair()))).toEqual(pair());
    expect(() =>
      validateApiWorkerControllerDelta(parseApiWorkerControllerDiff(raw(pair()))),
    ).not.toThrow();
  });
  it('rejects unpaired, duplicated, changed blobs/modes/statuses and any extra CI file', () => {
    const invalid = [
      pair().slice(0, 1),
      [...pair(), pair()[0]],
      [...pair(), { ...pair()[0], path: '.github/workflows/other.yaml' }],
    ];
    for (const change of [
      { oldOid: 'a'.repeat(40) },
      { newOid: 'b'.repeat(40) },
      { oldMode: '000000' },
      { newMode: '100755' },
      { newMode: '120000' },
      { status: 'A' },
      { status: 'D' },
      { status: 'R100' },
    ])
      invalid.push(pair().map((v, i) => (i === 0 ? { ...v, ...change } : v)));
    for (const rows of invalid) expect(() => validateApiWorkerControllerDelta(rows)).toThrow();
    for (const value of [
      '',
      'M\0scripts/timeweb-api-worker-upgrade.js\0',
      raw(pair()).replace(' M\0', ' R100\0'),
    ])
      expect(() => parseApiWorkerControllerDiff(value)).toThrow();
  });
  it('pins final checked-in workflow and test bytes, rather than only their filenames', () => {
    for (const pin of [...pair(), ...API_WORKER_CI_READER_PATCH]) {
      const bytes = readFileSync(pin.path);
      expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(
        pin.newOid,
      );
    }
  });
});
