import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  secure: vi.fn(),
  git: vi.fn(),
  docker: vi.fn(),
  baseline: vi.fn(),
  candidate: vi.fn(),
  image: vi.fn(),
  backup: vi.fn(),
  monitoring: vi.fn(),
  github: vi.fn(),
  durable: vi.fn(),
  secret: vi.fn(),
  delta: vi.fn(),
  swap: vi.fn(),
  credential: vi.fn(),
  ambient: vi.fn(),
  ci: vi.fn(),
  controllerGitConfig: vi.fn(),
  controllerSourceAuthority: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  readdir: vi.fn(),
  exists: vi.fn(),
  lstat: vi.fn(),
  open: vi.fn(),
  fstat: vi.fn(),
  close: vi.fn(),
  fsync: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('./timeweb-api-web-upgrade.js', () => ({
  readUpgradeFile: mocks.read,
  secureUpgradePath: mocks.secure,
  upgradeGit: mocks.git,
  upgradeDocker: mocks.docker,
  readInstalledApiBaseline: mocks.baseline,
  validateUpgradeCandidateAuthority: mocks.candidate,
  assertUpgradeImagePresent: mocks.image,
  validateUpgradeBackup: mocks.backup,
  readUpgradeMonitoring: mocks.monitoring,
  githubPublic: mocks.github,
  writeUpgradeAtomic: mocks.durable,
}));
vi.mock('./provision-timeweb-beta-runtime-secrets.js', () => ({
  describeTimewebRuntimeSecretSet: mocks.secret,
  validateTimewebFcmSecretDelta: mocks.delta,
  transitionPreparedTimewebRuntimeSecrets: mocks.swap,
}));
vi.mock('./render-timeweb-beta-release-env.js', () => ({
  timewebFcmCredentialSource: mocks.credential,
  assertNoAmbientComposeOverrides: mocks.ambient,
  assertNoAmbientDockerOverrides: mocks.ambient,
}));
vi.mock('./verify-source-ci.js', () => ({
  verifySourceCi: mocks.ci,
  assertControllerPromotionGitConfig: mocks.controllerGitConfig,
  readControllerSourceAuthority: mocks.controllerSourceAuthority,
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec, spawn: mocks.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  mocks.readdir.mockImplementation(actual.readdirSync);
  return {
    ...actual,
    readdirSync: mocks.readdir,
    existsSync: mocks.exists,
    lstatSync: mocks.lstat,
    openSync: mocks.open,
    fstatSync: mocks.fstat,
    closeSync: mocks.close,
    fsyncSync: mocks.fsync,
    unlinkSync: mocks.unlink,
  };
});
import {
  API_WORKER_BRIDGE as bridge,
  runManualApiWorkerUpgrade,
  encodeApiWorkerCapsule,
  overlay,
} from './timeweb-api-worker-upgrade.js';
import { capsuleFixture, hash, id, root, ledger } from './timeweb-api-worker.fixture.js';

function setup(phase = 'WORKER_ACTIVE') {
  const f = capsuleFixture(),
    tx = `${root}/backups/${id}-api-worker`,
    runtime = '/etc/phub/timeweb-beta',
    prepared = `/etc/phub/timeweb-beta-candidates/${id}/timeweb-beta`,
    backup = `/etc/phub/timeweb-beta-backups/${bridge.apiRelease}--replaced-by--${id}`;
  const files = new Map<string, Buffer>(),
    directories = new Set([
      root,
      `${root}/standard`,
      tx,
      `${root}/releases/${id}`,
      runtime,
      backup,
    ]);
  const baselineValues = {
    WEB_IMAGE_DIGEST: f.plan.unchangedImages.WEB_IMAGE_DIGEST,
    REALTIME_IMAGE_DIGEST: f.plan.unchangedImages.REALTIME_IMAGE_DIGEST,
    MIGRATOR_IMAGE_DIGEST: f.plan.unchangedImages.MIGRATOR_IMAGE_DIGEST,
    PHUB_RUNTIME_SECRET_SET_RELEASE_ID: bridge.apiRelease,
    TIMEWEB_RUNTIME_ENV_ROOT: runtime,
    PHUB_WORKER_ENABLED: 'true',
  };
  const baseline = Buffer.from(
    Object.entries(baselineValues)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
  f.plan.baselineSha256 = hash(baseline);
  files.set(f.plan.baselinePath, baseline);
  const composePath = `${root}/standard/source/deploy/timeweb/compose.beta.yaml`,
    compose = Buffer.from('trusted-compose');
  files.set(composePath, compose);
  f.plan.composeSha256 = hash(compose);
  const dirMeta = {
      device: 1,
      inode: 4,
      uid: 0,
      gid: 0,
      mode: 0o40700,
      links: 2,
      size: 4096,
      mtime: 1,
      ctime: 1,
    },
    fileMeta = {
      device: 1,
      inode: 5,
      uid: 1001,
      gid: 1001,
      mode: 0o100600,
      links: 1,
      size: 100,
      mtime: 1,
      ctime: 1,
    };
  Object.assign(f.plan.credential, {
    '/etc/phub/timeweb-beta-fcm': dirMeta,
    '/etc/phub/timeweb-beta-fcm/fcm-service-account.json': fileMeta,
  });
  for (const side of ['previous', 'candidate'])
    for (const service of ['api', 'worker'])
      files.set(`${tx}/${side}-${service}.env`, Buffer.from(overlay(f.plan, side, service)));
  const planBytes = Buffer.from(JSON.stringify(f.plan) + '\n'),
    journalPath = `${tx}/rollout-receipt.json`,
    pointerPath = `${root}/standard/active`,
    provisionPath = '/etc/phub/.timeweb-beta.provision.lock';
  files.set(
    `${tx}/preparation.json`,
    Buffer.from(encodeApiWorkerCapsule(f.operationBytes, planBytes)),
  );
  files.set(pointerPath, Buffer.from(`${tx}/plan.json\n`));
  files.set(`${tx}/plan.json`, planBytes);
  files.set(`${tx}/operation.json`, f.operationBytes);
  files.set(
    '/etc/phub/timeweb-beta-standard-delivery.json',
    Buffer.from(JSON.stringify({ schema: 1, enabled: true, controllerSha: f.op.controllerSha })),
  );
  files.set(
    journalPath,
    Buffer.from(
      JSON.stringify({
        schema: 'PHUB_TIMEWEB_API_WORKER_RECEIPT_V1',
        status: phase,
        planSha256: hash(planBytes),
        observedAt: '2026-10-11T20:00:00.000Z',
      }) + '\n',
    ),
  );
  files.set(
    provisionPath,
    Buffer.from(
      JSON.stringify({
        schema: 'PHUB_TIMEWEB_RUNTIME_SWAP_LOCK_V1',
        planSha256: hash(planBytes),
        targetDir: runtime,
        candidateDir: prepared,
        backupDir: backup,
        previous: f.plan.previousSecrets,
        candidate: f.plan.candidateSecrets,
      }) + '\n',
    ),
  );
  const states = {
    api: {
      identity: {
        ...f.op.expectedApi,
        image: f.plan.candidate.api.image,
        imageId: bridge.candidateApiDigest,
        revision: bridge.candidateSha,
        releaseId: id,
      },
      status: 'running',
      health: 'healthy',
      configHash: '8'.repeat(64),
      mounts: [],
    },
    worker: {
      identity: {
        ...f.op.expectedWorker,
        image: f.plan.candidate.worker.image,
        imageId: bridge.candidateWorkerDigest,
        revision: bridge.candidateSha,
      },
      status: 'running',
      health: 'healthy',
      configHash: '8'.repeat(64),
      mounts: [
        {
          Destination: '/run/phub/fcm-service-account.json',
          Type: 'bind',
          Source: '/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
          RW: false,
        },
      ],
    },
  };
  let secretState: 'CANDIDATE' | 'PREVIOUS' = 'CANDIDATE';
  for (const service of ['api', 'worker'] as const)
    files.set(
      `${tx}/candidate-${service}.config-hash`,
      Buffer.from(`${states[service].configHash}\n`),
    );
  mocks.readdir.mockImplementation((path: string) =>
    path.endsWith('/migrations')
      ? ledger.map((v) => v.filename)
      : [...files.keys()]
          .filter((v) => v.startsWith(`${path}/`))
          .map((v) => v.slice(path.length + 1))
          .filter((v) => !v.includes('/')),
  );

  mocks.exists.mockImplementation((path: string) => files.has(path) || directories.has(path));
  mocks.read.mockImplementation((path: string) => {
    const bytes = files.get(path);
    if (bytes) return bytes;
    if (path.includes('/packages/database/migrations/'))
      return fs.readFileSync(path.slice(path.indexOf('/packages/') + 1));
    throw Error('missing synthetic file');
  });
  mocks.durable.mockImplementation((path: string, bytes: string | Buffer, exclusive = false) => {
    if (exclusive && files.has(path)) throw Error('exclusive synthetic path exists');
    files.set(path, Buffer.from(bytes));
  });
  mocks.unlink.mockImplementation((path: string) => files.delete(path));
  mocks.open.mockReturnValue(42);
  mocks.close.mockReturnValue(undefined);
  mocks.fsync.mockReturnValue(undefined);
  mocks.secure.mockReturnValue({ isDirectory: () => true });
  mocks.controllerSourceAuthority.mockResolvedValue({ status: 'VERIFIED' });
  const stat = {
    dev: 1,
    ino: 6,
    uid: 0,
    gid: 0,
    nlink: 1,
    mode: 0o100600,
    size: 0,
    isFile: () => true,
  };
  mocks.fstat.mockReturnValue(stat);
  mocks.lstat.mockImplementation((path: string) => {
    if (path.endsWith('api-worker-executor.lock')) return stat;
    if (
      !files.has(path) &&
      !directories.has(path) &&
      !path.startsWith('/etc/phub/timeweb-beta-fcm')
    )
      throw Object.assign(Error('absent synthetic path'), { code: 'ENOENT' });
    const v = path.endsWith('fcm-service-account.json') ? fileMeta : dirMeta;
    return {
      dev: v.device,
      ino: v.inode,
      uid: v.uid,
      gid: v.gid,
      mode: v.mode,
      nlink: v.links,
      size: v.size,
      mtimeMs: v.mtime,
      ctimeMs: v.ctime,
    };
  });
  mocks.credential.mockReturnValue('/etc/phub/timeweb-beta-fcm/fcm-service-account.json');
  mocks.secret.mockImplementation((path: string) => {
    if (path === runtime)
      return secretState === 'CANDIDATE' ? f.plan.candidateSecrets : f.plan.previousSecrets;
    if (path === prepared && directories.has(prepared)) return f.plan.candidateSecrets;
    if (path === backup && directories.has(backup)) return f.plan.previousSecrets;
    throw Error('missing synthetic secret set');
  });
  mocks.swap.mockImplementation(() => {
    secretState = 'PREVIOUS';
    directories.add(prepared);
    directories.delete(backup);
    return { status: 'RESTORED' };
  });
  mocks.git.mockImplementation((args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return f.op.controllerSha;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${root}/standard/source`;
    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir')
      return `${root}/standard/source/.git`;
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute')
      return `${root}/standard/source/.git`;
    if (args[0] === 'rev-parse') return bridge.candidateTree;
    if (args[0] === 'status') return '';
    if (args[0] === 'ls-files') return '';
    if (args[0] === 'diff')
      return `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0scripts/timeweb-api-worker-upgrade.js\0`;
    return '';
  });
  mocks.docker.mockImplementation((args: string[]) => {
    if (args[0] === 'ps' && args[1] === '-q') return '';
    if (args[0] === 'ps')
      return states[args.at(-1)!.endsWith('=worker') ? 'worker' : 'api'].identity.id + '\n';
    if (args[0] === 'image') return JSON.stringify([{ Id: args[2]!.split('@')[1] }]);
    if (args[0] === 'container') {
      const v = Object.values(states).find((v) => v.identity.id === args[2]);
      if (!v) throw Error('unexpected container read');
      return JSON.stringify([
        {
          Id: v.identity.id,
          Image: v.identity.imageId,
          Config: {
            Image: v.identity.image,
            Labels: {
              'phub.release-id': v.identity.releaseId,
              'org.opencontainers.image.revision': v.identity.revision,
              'com.docker.compose.config-hash': v.configHash,
            },
          },
          RestartCount: 0,
          State: {
            StartedAt: v.identity.startedAt,
            Status: v.status,
            Health: { Status: v.health },
          },
          Mounts: v.mounts,
        },
      ]);
    }
    if (args[0] === 'stop') {
      states.worker.status = 'exited';
      return '';
    }
    if (args[0] === 'compose') {
      const service = args.at(-1) === 'worker' ? 'worker' : 'api';
      if (args.includes('--format'))
        return JSON.stringify({
          services: {
            worker: {
              volumes: [
                {
                  target: '/run/phub/fcm-service-account.json',
                  source: '/dev/null',
                  read_only: true,
                  type: 'bind',
                },
              ],
            },
            api: { volumes: [] },
          },
        });
      if (args.includes('--hash')) return `${service} ${'7'.repeat(64)}\n`;
      if (args.includes('up')) {
        const v = states[service];
        Object.assign(v.identity, f.plan.previous[service], {
          id: (service === 'api' ? '1' : '2').repeat(64),
          startedAt: '2026-10-11T20:01:00.000Z',
        });
        v.status = 'running';
        v.configHash = '7'.repeat(64);
        if (service === 'worker')
          v.mounts = [
            {
              Destination: '/run/phub/fcm-service-account.json',
              Type: 'bind',
              Source: '/dev/null',
              RW: false,
            },
          ];
        return '';
      }
    }
    throw Error('unexpected Docker command');
  });
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ status: 200, text: () => Promise.resolve('{"status":"ready"}') }),
    ),
  );
  return {
    f,
    files,
    directories,
    tx,
    states,
    pointerPath,
    provisionPath,
    journalPath,
    prepared,
    backup,
    runtime,
    setCandidate: () => {
      secretState = 'CANDIDATE';
      directories.delete(prepared);
      directories.add(backup);
    },
    setPrevious: () => {
      secretState = 'PREVIOUS';
      directories.add(prepared);
      directories.delete(backup);
      Object.assign(states.api.identity, f.op.expectedApi);
      Object.assign(states.worker.identity, f.op.expectedWorker);
    },
  };
}
function orphan() {
  const f = setup('PREPARING');
  f.setPrevious();
  for (const path of [
    f.pointerPath,
    f.provisionPath,
    f.journalPath,
    `${f.tx}/plan.json`,
    `${f.tx}/operation.json`,
    `${f.tx}/candidate-api.config-hash`,
    `${f.tx}/candidate-worker.config-hash`,
  ])
    f.files.delete(path);
  for (const side of ['previous', 'candidate'])
    for (const service of ['api', 'worker']) f.files.delete(`${f.tx}/${side}-${service}.env`);
  f.files.set(`${root}/operator/api-worker-upgrade.json`, f.f.operationBytes);
  return f;
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('production adapter with all host/network operations intercepted', () => {
  it('restores both components and settings while PostgreSQL/GitHub are unavailable', async () => {
    const f = setup();
    mocks.spawn.mockImplementation(() => {
      throw Error('DB unavailable');
    });
    mocks.github.mockRejectedValue(Error('network unavailable'));
    const result = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(result.status).toBe('ROLLED_BACK');
    expect(f.states.worker.status).toBe('running');
    expect(f.states.worker.mounts[0]?.Source).toBe('/dev/null');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.github).not.toHaveBeenCalled();
    expect(f.files.has(f.pointerPath)).toBe(true);
    expect(f.files.has(f.provisionPath)).toBe(true);
    expect(
      mocks.docker.mock.calls.filter(([args]) =>
        ['stop', 'compose'].includes((args as string[])[0]!),
      )[0]?.[0],
    ).toEqual(['stop', '--time', '60', f.f.op.expectedWorker.id]);
  });
  it('rejects a non-directory controller Git custody before Docker or authority reads', async () => {
    setup();
    mocks.secure.mockImplementation((path: string) => ({
      isDirectory: () => path !== `${root}/standard/source/.git`,
    }));
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('API_WORKER_CONTROLLER_GIT_CUSTODY');
    expect(mocks.docker).not.toHaveBeenCalled();
    expect(mocks.github).not.toHaveBeenCalled();
    expect(mocks.controllerGitConfig).not.toHaveBeenCalled();
    expect(mocks.controllerSourceAuthority).not.toHaveBeenCalled();
  });
  it.each(['credential drift', 'excluded drift', 'provision drift', 'controller drift'])(
    'contains Worker before failing closed on %s',
    async (mode) => {
      const f = setup();
      if (mode === 'credential drift')
        mocks.credential.mockImplementation(() => {
          throw Error('credential unavailable');
        });
      else if (mode === 'excluded drift') {
        const original = mocks.docker.getMockImplementation()! as (args: string[]) => string;
        mocks.docker.mockImplementation((args: string[]) =>
          args[0] === 'ps' && args[1] === '-q' ? 'foreign-id' : original(args),
        );
      } else if (mode === 'provision drift') f.files.set(f.provisionPath, Buffer.from('foreign\n'));
      else {
        const original = mocks.git.getMockImplementation()! as (args: string[]) => string;
        mocks.git.mockImplementation((args: string[]) =>
          args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'wrong' : original(args),
        );
      }
      await expect(
        runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
      ).rejects.toThrow();
      expect(f.states.worker.status).toBe('exited');
      expect(f.files.has(f.pointerPath)).toBe(true);
      expect(mocks.swap).not.toHaveBeenCalled();
      expect(mocks.github).not.toHaveBeenCalled();
    },
  );
  it.each(['PREPARING', 'PREPARED'])(
    'aborts %s with missing staged candidate and without touching services',
    async (phase) => {
      const f = setup(phase);
      f.setPrevious();
      f.directories.delete(f.prepared);
      f.files.delete(f.provisionPath);
      mocks.credential.mockImplementation(() => {
        throw Error('credential missing');
      });
      const result = await runManualApiWorkerUpgrade(
        'recover',
        `${root}/operator/api-worker-upgrade.json`,
      );
      expect(result.status).toBe('ABORTED');
      expect(
        mocks.docker.mock.calls.some(([args]) =>
          ['stop', 'compose'].includes((args as string[])[0]!),
        ),
      ).toBe(false);
      await runManualApiWorkerUpgrade('reconcile', `${root}/operator/api-worker-upgrade.json`);
      expect(f.files.has(f.pointerPath)).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );
  it('uses the immutable capsule after a crash before operation/plan/journal materialization', async () => {
    const f = setup('PREPARING');
    f.setPrevious();
    for (const path of [
      `${f.tx}/operation.json`,
      `${f.tx}/plan.json`,
      f.journalPath,
      f.provisionPath,
    ])
      f.files.delete(path);
    const result = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(result.status).toBe('ABORTED');
    expect(mocks.swap).not.toHaveBeenCalled();
  });
  it('recovers again after a crash between restoring API and restoring Worker', async () => {
    const f = setup(),
      docker = mocks.docker.getMockImplementation()! as (args: string[]) => string;
    let failed = false;
    mocks.docker.mockImplementation((args: string[]) => {
      if (!failed && args[0] === 'compose' && args.includes('up') && args.at(-1) === 'worker') {
        failed = true;
        throw Error('power loss');
      }
      return docker(args);
    });
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('ROLLBACK_FAILED');
    expect(f.states.api.identity.image).toBe(f.f.op.expectedApi.image);
    expect(f.states.worker.status).toBe('exited');
    const result = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(result.status).toBe('ROLLED_BACK');
    expect(f.states.worker.identity.image).toBe(f.f.op.expectedWorker.image);
  });
  it('aborts an expired exact orphan without candidate custody and repeats marker-only completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T21:00:00.000Z'));
    const f = orphan();
    f.directories.delete(f.prepared);
    mocks.credential.mockImplementation(() => {
      throw Error('credential unavailable');
    });
    const result = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(result.status).toBe('RECONCILED');
    expect(f.files.has(`${f.tx}/preparation.json`)).toBe(false);
    const audit = JSON.parse(f.files.get(result.receipt)!.toString()) as {
      preparation: string;
      [key: string]: unknown;
    };
    expect(audit).toMatchObject({
      runtimeMutated: false,
      status: 'RECONCILED',
      reconciledStatus: 'ABORTED',
    });
    // Lost response after unlink: the immutable embedded capsule proves terminal completion.
    f.states.worker.status = 'exited';
    const repeated = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(repeated).toEqual(result);
    expect(mocks.swap).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.github).not.toHaveBeenCalled();
    expect(
      mocks.docker.mock.calls.some(([a]) => ['stop', 'compose'].includes((a as string[])[0]!)),
    ).toBe(false);
  });
  it('keeps a durable abort tombstone after failed cleanup and forbids renewed forward use', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T20:00:00.000Z'));
    const f = orphan(),
      unlink = mocks.unlink.getMockImplementation()!;
    mocks.unlink.mockImplementationOnce(() => {
      throw Error('power loss');
    });
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('power loss');
    expect(f.files.has(`${f.tx}/preparation.json`)).toBe(true);
    expect([...f.files.keys()].some((p) => p.includes('/orphan-abort-'))).toBe(true);
    await expect(
      runManualApiWorkerUpgrade('deploy', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('ORPHAN_ABORTED');
    mocks.unlink.mockImplementation(unlink);
    const result = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(result.status).toBe('RECONCILED');
    expect(f.files.has(`${f.tx}/preparation.json`)).toBe(false);
  });
  it('returns terminal success after unlink succeeds and directory fsync fails', async () => {
    const f = orphan();
    mocks.fsync.mockImplementation(() => {
      if (!f.files.has(`${f.tx}/preparation.json`)) throw Error('directory fsync failed');
    });
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('directory fsync failed');
    expect(f.files.has(`${f.tx}/preparation.json`)).toBe(false);
    mocks.fsync.mockReturnValue(undefined);
    const result = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(result.status).toBe('RECONCILED');
  });
  it.each([
    'provision',
    'plan',
    'overlay',
    'backup',
    'foreign-request',
    'foreign-audit',
    'runtime-drift',
  ])('retains the orphan capsule and creates no abort audit on %s', async (state) => {
    const f = orphan();
    if (state === 'provision') f.files.set(f.provisionPath, Buffer.from('foreign'));
    if (state === 'plan') f.files.set(`${f.tx}/plan.json`, Buffer.from('foreign'));
    if (state === 'overlay') f.files.set(`${f.tx}/candidate-worker.env`, Buffer.from('foreign'));
    if (state === 'backup') f.directories.add(f.backup);
    if (state === 'foreign-request')
      f.files.set(
        `${root}/operator/api-worker-upgrade.json`,
        Buffer.from(JSON.stringify({ ...f.f.op, expiresAt: '2026-10-11T21:30:00.000Z' }) + '\n'),
      );
    if (state === 'foreign-audit')
      f.files.set(`${f.tx}/orphan-abort-invalid.json`, Buffer.from('{}'));
    if (state === 'runtime-drift') f.states.worker.identity.startedAt = '2026-10-11T19:59:59.000Z';
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow();
    expect(f.files.has(`${f.tx}/preparation.json`)).toBe(true);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.durable.mock.calls.some(([p]) => String(p).includes('/orphan-abort-'))).toBe(
      false,
    );
  });
  it('does not persist a terminal marker when the final runtime recheck fails', async () => {
    const f = orphan(),
      read = mocks.read.getMockImplementation()! as (path: string) => Buffer;
    let reads = 0;
    mocks.read.mockImplementation((path: string) => {
      if (path === `${root}/standard/source/deploy/timeweb/compose.beta.yaml` && ++reads === 2)
        throw Error('late drift');
      return read(path);
    });
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('late drift');
    expect(mocks.durable.mock.calls.some(([p]) => String(p).includes('/orphan-abort-'))).toBe(
      false,
    );
    expect(f.files.has(`${f.tx}/preparation.json`)).toBe(true);
  });
  it('rejects an altered historical audit instead of accepting its terminal claim', async () => {
    const f = orphan(),
      result = await runManualApiWorkerUpgrade(
        'recover',
        `${root}/operator/api-worker-upgrade.json`,
      );
    const audit = JSON.parse(f.files.get(result.receipt)!.toString()) as {
      preparation: string;
      [key: string]: unknown;
    };
    f.files.set(
      result.receipt,
      Buffer.from(JSON.stringify({ ...audit, capsuleSha256: '0'.repeat(64) })),
    );
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('ORPHAN_AUDIT');
  });
  it('rejects duplicate terminal markers for the same operation', async () => {
    const f = orphan(),
      result = await runManualApiWorkerUpgrade(
        'recover',
        `${root}/operator/api-worker-upgrade.json`,
      ),
      audit = JSON.parse(f.files.get(result.receipt)!.toString()) as {
        preparation: string;
        [key: string]: unknown;
      },
      original = JSON.parse(Buffer.from(audit.preparation, 'base64').toString()) as {
        plan: string;
      },
      plan = JSON.parse(Buffer.from(original.plan, 'base64').toString()) as { createdAt: string };
    plan.createdAt = '2026-10-11T20:00:01.000Z';
    const planBytes = Buffer.from(JSON.stringify(plan) + '\n'),
      bytes = Buffer.from(encodeApiWorkerCapsule(f.f.operationBytes, planBytes)),
      duplicate = {
        ...audit,
        capsuleSha256: hash(bytes),
        planSha256: hash(planBytes),
        preparation: bytes.toString('base64'),
      };
    f.files.set(`${f.tx}/orphan-abort-${hash(bytes)}.json`, Buffer.from(JSON.stringify(duplicate)));
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('ORPHAN_AUDIT');
  });
  it('renews an expired request only after orphan abort, deploys both Compose stages, and reconciles success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T20:00:00.000Z'));
    const f = setup('PREPARING');
    f.setPrevious();
    for (const path of [
      f.pointerPath,
      f.provisionPath,
      f.journalPath,
      `${f.tx}/plan.json`,
      `${f.tx}/operation.json`,
      `${f.tx}/candidate-api.config-hash`,
      `${f.tx}/candidate-worker.config-hash`,
    ])
      f.files.delete(path);
    for (const side of ['previous', 'candidate'])
      for (const service of ['api', 'worker']) f.files.delete(`${f.tx}/${side}-${service}.env`);
    f.files.set(`${root}/operator/api-worker-upgrade.json`, f.f.operationBytes);
    mocks.baseline.mockReturnValue({
      path: f.f.plan.baselinePath,
      bytes: f.files.get(f.f.plan.baselinePath)!,
      values: Object.fromEntries(
        f.files
          .get(f.f.plan.baselinePath)!
          .toString()
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      ) as Record<string, string>,
      secretSetReleaseId: bridge.apiRelease,
    });
    mocks.candidate.mockResolvedValue({
      images: [
        { component: 'api', digest: bridge.candidateApiDigest },
        { component: 'worker', digest: bridge.candidateWorkerDigest },
      ],
    });
    mocks.github.mockImplementation((path: string) =>
      Promise.resolve(path.includes('jobs') ? { total_count: 0, jobs: [] } : {}),
    );
    mocks.monitoring.mockReturnValue({ provider: Buffer.from('{}'), alerts: Buffer.from('{}') });
    const ledgerHash = hash(JSON.stringify(ledger.map((v) => [v.filename, v.checksum])) + '\n');
    f.files.set(
      `${f.tx}/database-backup-receipt.json`,
      Buffer.from(
        JSON.stringify({
          sourceLedgerSha256: ledgerHash,
          restoredLedgerSha256: ledgerHash,
          restoreImage: bridge.postgresImage,
        }),
      ),
    );
    const restore = mocks.swap.getMockImplementation()! as (options: {
      direction: string;
    }) => unknown;
    mocks.swap.mockImplementation((options: { direction: string }) =>
      options.direction === 'install' ? f.setCandidate() : restore(options),
    );
    const original = mocks.docker.getMockImplementation()! as (args: string[]) => string;
    mocks.docker.mockImplementation((args: string[]) => {
      if (args[0] === 'container' && args[2] === bridge.postgresId)
        return JSON.stringify([
          {
            Config: { Image: bridge.postgresImage },
            State: { Status: 'running', Health: { Status: 'healthy' } },
          },
        ]);
      if (args[0] === 'run') {
        expect(args).toContain('none');
        return '';
      }
      if (args[0] === 'compose' && args.includes('pull')) return '';
      if (args[0] === 'compose' && args.includes('--format')) {
        const source = args.some((v) => v.endsWith('candidate-worker.env'))
          ? '/etc/phub/timeweb-beta-fcm/fcm-service-account.json'
          : '/dev/null';
        return JSON.stringify({
          services: {
            worker: {
              volumes: [
                {
                  target: '/run/phub/fcm-service-account.json',
                  source,
                  read_only: true,
                  type: 'bind',
                },
              ],
            },
            api: { volumes: [] },
          },
        });
      }
      if (
        args[0] === 'compose' &&
        args.includes('up') &&
        args.some((v) => v.includes('/candidate-'))
      ) {
        const service = args.at(-1) === 'worker' ? 'worker' : 'api',
          v = f.states[service];
        Object.assign(v.identity, f.f.plan.candidate[service], {
          imageId: service === 'api' ? bridge.candidateApiDigest : bridge.candidateWorkerDigest,
          id: (service === 'api' ? '4' : '5').repeat(64),
          startedAt: '2026-10-11T20:00:01.000Z',
        });
        v.status = 'running';
        v.configHash = '7'.repeat(64);
        if (service === 'worker')
          v.mounts = [
            {
              Destination: '/run/phub/fcm-service-account.json',
              Type: 'bind',
              Source: '/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
              RW: false,
            },
          ];
        return '';
      }
      return original(args);
    });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      child.stdin.on('data', (bytes: Buffer) => {
        const text = bytes.toString();
        const nonce = text.match(/'nonce','([a-f0-9]+)'/)?.[1];
        if (nonce) {
          const result = text.includes('locksAcquired')
            ? { locksAcquired: true, tenantCount: 1, tenantFingerprint: 'a'.repeat(32) }
            : {
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
          child.stdout.write(JSON.stringify({ nonce, result }) + '\n');
        }
      });
      child.stdin.on('finish', () => child.emit('exit', 0));
      return child;
    });
    vi.setSystemTime(new Date('2026-10-11T20:31:00.000Z'));
    await expect(
      runManualApiWorkerUpgrade('deploy', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('EXPIRY');
    const aborted = await runManualApiWorkerUpgrade(
      'recover',
      `${root}/operator/api-worker-upgrade.json`,
    );
    expect(aborted.status).toBe('RECONCILED');
    f.f.op.expiresAt = '2026-10-11T21:01:00.000Z';
    f.files.set(
      `${root}/operator/api-worker-upgrade.json`,
      Buffer.from(JSON.stringify(f.f.op) + '\n'),
    );
    const operation = runManualApiWorkerUpgrade(
      'deploy',
      `${root}/operator/api-worker-upgrade.json`,
    );
    const settled = operation.then(
      (value) => ({ value }),
      (error) => ({ error: error as Error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if ('error' in outcome) throw outcome.error;
    const result = outcome.value;
    expect(result.status).toBe('SUCCESS');
    expect(f.files.has(f.pointerPath)).toBe(true);
    expect(f.states.worker.mounts[0]?.Source).toBe(
      '/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
    );
    await runManualApiWorkerUpgrade('reconcile', `${root}/operator/api-worker-upgrade.json`);
    expect(f.files.has(f.pointerPath)).toBe(false);
    expect(f.files.has(f.provisionPath)).toBe(false);
    expect(
      mocks.docker.mock.calls
        .filter(([args]) => (args as string[]).includes('up'))
        .map(([args]) => (args as string[]).at(-1)),
    ).toEqual(['api', 'worker']);
  });
  it('does not stop a foreign Worker or delete foreign locks', async () => {
    const f = setup();
    f.states.worker.identity.image = 'ghcr.io/foreign/worker@sha256:' + '9'.repeat(64);
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('FOREIGN_SERVICE');
    expect(f.states.worker.status).toBe('running');
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it('rejects concurrent recovery before service operations', async () => {
    setup();
    mocks.exec.mockImplementation(() => {
      throw Error('flock busy');
    });
    await expect(
      runManualApiWorkerUpgrade('recover', `${root}/operator/api-worker-upgrade.json`),
    ).rejects.toThrow('flock busy');
    expect(mocks.docker).not.toHaveBeenCalled();
  });
});
