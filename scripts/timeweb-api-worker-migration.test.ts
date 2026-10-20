import { spawnSync } from 'node:child_process';
import { parseStrictJson } from './strict-json.js';
import {
  validateApiWorkerControllerDelta,
  validateApiWorkerLedger,
  parseApiWorkerControllerDiff,
  type ApiWorkerControllerDiffEntry,
} from './timeweb-api-worker-upgrade.js';
import { readFileSync, readdirSync } from 'node:fs';
import { ledger as frozenLedger } from './timeweb-api-worker.fixture.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  API_WORKER_MIGRATION_BRIDGE as b,
  migrationCreateArgs,
  validateMigrationReleaseState,
  validateMigrationContainer,
  validateMigrationControllerClosure,
  validateApiWorkerMigrationLedger,
  encodeApiWorkerMigrationCapsule,
  readApiWorkerMigrationCapsule,
  parseDiskRestoreMountinfo,
  validateDiskRestoreReadback,
  validateDiskRestoreKernelSnapshot,
  validateNamespaceRestoreKernelSnapshot,
  namespaceRestoreClientOptions,
  validateMigrationBackupRestoreReference,
  validateLegacyBackupRestoreMounts,
  validateDiskRestoreToolBytes,
} from './timeweb-api-worker-migration.js';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

const diskCandidate = `${b.candidateSha}-${b.publicationRunId}-1`;
function diskMountinfo(target: string, source: string, id = '41') {
  return `${id} 29 253:7 / ${target} rw,nosuid,nodev,noexec,noatime - ext4 ${source} rw\n`;
}
function diskUuid(name: string) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16);
  const sixth = bytes[6],
    eighth = bytes[8];
  if (sixth === undefined || eighth === undefined) throw Error('DISK_UUID_BYTES');
  bytes[6] = (sixth & 15) | 0x50;
  bytes[8] = (eighth & 63) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function diskFixture() {
  const controllerSha = 'e'.repeat(40);
  const candidateSha = b.candidateSha;
  if (candidateSha === undefined) throw Error('DISK_CANDIDATE_SHA');
  const expected = {
    controllerSha,
    controllerTree: 'd'.repeat(40),
    controllerSourceCiRunId: '38217331672',
    candidateReleaseId: diskCandidate,
    migrationPlanSha256: '1'.repeat(64),
    migrationSuccessSha256: '2'.repeat(64),
  };
  const operation = {
    schema: 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_V1',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    toolCommit: controllerSha,
    toolFileSha256: '3'.repeat(64),
    controllerSha,
    toolProofSha256: '4'.repeat(64),
    toolInstallationSha256: '5'.repeat(64),
    controllerTree: expected.controllerTree,
    controllerConfigSha256: '6'.repeat(64),
    expectedBoundarySha256: '7'.repeat(64),
    expectedApi: { id: 'api', image: 'sha256:api' },
    expectedPostgres: { id: b.postgresId, image: b.postgresImage },
    expiresAt: '2026-10-12T12:00:00.000Z',
    confirmation: 'BACKUP_RESTORE_API_WORKER_DISK_LUKS2_8158AC445C9F_KEEP_API_0D6078BE7A50',
    candidateReleaseId: diskCandidate,
    expectedLedgerSha256: b.postLedgerSha256,
    controllerSourceCiRunId: expected.controllerSourceCiRunId,
    migrationPlanSha256: expected.migrationPlanSha256,
    migrationSuccessSha256: expected.migrationSuccessSha256,
  };
  const operationBytes = Buffer.from(`${JSON.stringify(operation)}\n`);
  const operationSha256 = hash(operationBytes);
  const databaseBytes = 3 * 1024 ** 3;
  const restoreDataBytes = Math.max(512 * 1024 ** 2, databaseBytes * 3 + 256 * 1024 ** 2);
  const imageBytes =
    Math.ceil(
      (restoreDataBytes + Math.max(512 * 1024 ** 2, Math.ceil(restoreDataBytes / 20))) /
        (4 * 1024 ** 2),
    ) *
    4 *
    1024 ** 2;
  const work = `/opt/phub/timeweb-beta/backups/.disk-restore-${operationSha256}`;
  const mapperName = `phub-restore-${operationSha256.slice(0, 24)}`;
  const plan = {
    schema: 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V1',
    operationSha256,
    work,
    canonical: `/opt/phub/timeweb-beta/backups/${diskCandidate}-api-worker`,
    pendingLock: `/opt/phub/timeweb-beta/standard/.disk-lock-${operationSha256}`,
    image: `${work}/restore.luks`,
    mount: `${work}/pgdata-mounted`,
    publication: `${work}/publication`,
    mapperName,
    mapperPath: `/dev/mapper/${mapperName}`,
    luksUuid: diskUuid(`phub-luks-${operationSha256}`),
    filesystemUuid: diskUuid(`phub-ext4-${operationSha256}`),
    mountOptions: 'rw,nosuid,nodev,noexec,noatime',
    containerName: `phub-timeweb-restore-${candidateSha.slice(0, 12)}-${b.publicationRunId}-1`,
    restoreImage: b.postgresImage,
    expectedLedgerSha256: b.postLedgerSha256,
    databaseBytes,
    restoreDataBytes,
    imageBytes,
    memoryBytes: 2 * 1024 ** 3,
    dumpLimitBytes: databaseBytes * 2 + 256 * 1024 ** 2,
    diskReserveBytes: 5 * 1024 ** 3,
  };
  const [hostMount] = parseDiskRestoreMountinfo(diskMountinfo(plan.mount, plan.mapperPath));
  const [containerMount] = parseDiskRestoreMountinfo(
    diskMountinfo('/var/lib/postgresql/data', plan.mapperPath, '42'),
  );
  if (hostMount === undefined || containerMount === undefined) throw Error('DISK_MOUNT_FIXTURE');
  const row = {
    Id: 'a'.repeat(64),
    Name: `/${plan.containerName}`,
    Config: {
      Image: b.postgresImage,
      User: 'postgres',
      Env: [
        'PGDATA=/var/lib/postgresql/data/phub-restore',
        'POSTGRES_USER=phub_restore',
        'POSTGRES_DB=phub_restore',
        'POSTGRES_HOST_AUTH_METHOD=trust',
      ],
      Cmd: ['postgres'],
      Entrypoint: ['docker-entrypoint.sh'],
      Volumes: null,
      Labels: { 'phub.backup-operation': operationSha256 },
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Binds: null,
      PortBindings: {},
      Tmpfs: {
        '/var/run/postgresql': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
        '/tmp': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
      },
      Privileged: false,
      AutoRemove: false,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      CapAdd: null,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 128,
      Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3,
      NanoCpus: 1000000000,
      PublishAllPorts: false,
      Links: null,
      Devices: [],
      DeviceRequests: null,
      VolumesFrom: null,
      PidMode: '',
      IpcMode: 'private',
      LogConfig: { Type: 'none', Config: {} },
    },
    Mounts: [
      {
        Type: 'bind',
        Source: plan.mount,
        Destination: '/var/lib/postgresql/data',
        RW: true,
        Propagation: 'rprivate',
      },
      { Type: 'tmpfs', Destination: '/var/run/postgresql', RW: true },
      { Type: 'tmpfs', Destination: '/tmp', RW: true },
    ],
    State: { Status: 'running', Pid: 4242, StartedAt: '2026-10-12T10:00:00.000000000Z' },
  };
  const container = {
    Id: row.Id,
    Config: {
      Image: row.Config.Image,
      User: row.Config.User,
      Env: row.Config.Env,
      Cmd: row.Config.Cmd,
      Entrypoint: row.Config.Entrypoint,
      Volumes: row.Config.Volumes,
      Labels: row.Config.Labels,
    },
    HostConfig: { ...row.HostConfig },
    Mounts: row.Mounts,
    State: { Status: row.State.Status, Pid: row.State.Pid, StartedAt: row.State.StartedAt },
  };
  const value = {
    schema: 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V1',
    operationSha256,
    storageProofSha256: 'b'.repeat(64),
    plan,
    readback: {
      storage: {
        image: { dev: 64775, ino: 7001, uid: 0, gid: 0, mode: 33152, nlink: 1 },
        loop: '/dev/loop7',
        mapper: {
          device: 253,
          minor: 7,
          uuid: `CRYPT-LUKS2-${plan.luksUuid.replaceAll('-', '')}-${plan.mapperName}`,
        },
        mount: { dev: 64775, ino: 7002, uid: 0, gid: 0, mode: 17407 },
      },
      kernel: {
        pid: row.State.Pid,
        startedAt: row.State.StartedAt,
        hostNamespace: 4026531840,
        containerNamespace: 4026533000,
        hostMount,
        containerMount,
      },
      container,
    },
    migration: expected,
  };
  return { expected, operation, operationBytes, plan, row, value, hostMount, containerMount };
}
describe('closed migration custody validators', () => {
  it('accepts the current migration directory for the frozen API/Worker release', () => {
    const currentPackage = readdirSync('packages/database/migrations')
      .filter((filename) => filename.endsWith('.sql'))
      .sort()
      .map((filename) => ({
        filename,
        checksum: hash(readFileSync(`packages/database/migrations/${filename}`)),
      }));
    expect(currentPackage.length).toBe(frozenLedger.length);
    expect(currentPackage.some((row) => row.filename === '0098_support_tickets.sql')).toBe(true);
    expect(() => validateApiWorkerLedger(currentPackage, currentPackage)).not.toThrow();
  });
  it('accepts exact packaged ledgers and rejects partial, reordered, altered and extra rows', () => {
    const rows = frozenLedger;
    expect(validateApiWorkerMigrationLedger(rows.slice(0, 99), b.preLedgerSha256)).toBe(
      b.preLedgerSha256,
    );
    expect(validateApiWorkerMigrationLedger(rows, b.postLedgerSha256)).toBe(b.postLedgerSha256);
    for (const values of [
      rows.slice(0, 100),
      [...rows].reverse(),
      [...rows, rows[0]],
      rows.map((v, i) => (i === 99 ? { ...v, checksum: 'f'.repeat(64) } : v)),
    ])
      expect(() => validateApiWorkerMigrationLedger(values, b.postLedgerSha256)).toThrow();
  });
  it('allows only unique regular A/M files in the narrow new migration slice', () => {
    const good = {
      status: 'A',
      oldOid: '0'.repeat(40),
      newOid: 'a'.repeat(40),
      oldMode: '000000',
      newMode: '100644',
      path: 'scripts/timeweb-api-worker-migration.js',
    };
    expect(() => validateMigrationControllerClosure([good])).not.toThrow();
    for (const values of [
      [good, good],
      [{ ...good, status: 'D' }],
      [{ ...good, status: 'R100' }],
      [{ ...good, newMode: '120000' }],
      [{ ...good, newMode: '100755' }],
      [{ ...good, path: 'scripts/timeweb-api-worker-upgrade.js' }],
      [{ ...good, path: 'apps/api/src/main.ts' }],
    ])
      expect(() => validateMigrationControllerClosure(values)).toThrow();
  });
  it('roundtrips exact byte capsules and rejects noncanonical base64', () => {
    const operation = Buffer.from('{"a":1}\n'),
      plan = Buffer.from('{"b":2}\n');
    expect(
      readApiWorkerMigrationCapsule(encodeApiWorkerMigrationCapsule(operation, plan)),
    ).toMatchObject({ operationBytes: operation, planBytes: plan });
    expect(() =>
      readApiWorkerMigrationCapsule(
        Buffer.from(
          '{"schema":"PHUB_TIMEWEB_API_WORKER_MIGRATION_CAPSULE_V1","operation":"!","plan":"!"}',
        ),
      ),
    ).toThrow();
  });
  it('pins real image defaults, config digest, current env, exact network and complete container isolation', () => {
    const name = 'phub-timeweb-migration-8158ac445c9f-39366813227-1',
      id = 'a'.repeat(64),
      op = 'b'.repeat(64),
      imageId = 'sha256:' + 'c'.repeat(64);
    const spec = {
      kind: 'migration',
      name,
      imageId,
      env: ['NODE_ENV=production', 'DATABASE_URL=postgresql://synthetic@postgres/test'],
    };
    const v = {
      Id: id,
      Name: `/${name}`,
      Image: imageId,
      RestartCount: 0,
      Config: {
        Image: b.migratorImage,
        User: 'appuser',
        WorkingDir: '/app',
        Entrypoint: ['docker-entrypoint.sh'],
        Cmd: ['node', 'apps/migrator/dist/main.js'],
        Env: spec.env,
        Volumes: null,
        Labels: {
          'phub.migration-operation': op,
          'phub.migration-kind': 'migration',
          'com.docker.compose.project': 'phub-timeweb-beta',
          'com.docker.compose.service': 'migrator',
        },
      },
      HostConfig: {
        NetworkMode: 'phub-timeweb-beta',
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        ReadonlyRootfs: true,
        Privileged: false,
        AutoRemove: false,
        PublishAllPorts: false,
        CapDrop: ['ALL'],
        CapAdd: null,
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: 128,
        Memory: 536870912,
        MemorySwap: 536870912,
        NanoCpus: 1000000000,
        IpcMode: 'none',
        PidMode: '',
        UTSMode: '',
        UsernsMode: '',
        CgroupnsMode: 'private',
        Binds: null,
        Devices: [],
        DeviceRequests: null,
        VolumesFrom: null,
        Links: null,
        ExtraHosts: null,
        PortBindings: {},
        Tmpfs: null,
      },
      NetworkSettings: { Networks: { 'phub-timeweb-beta': {} } },
      Mounts: [],
      State: { Status: 'created', ExitCode: 0 },
    };
    expect(() => validateMigrationContainer(v, id, op, 'created', spec)).not.toThrow();
    for (const bad of [
      { ...v, Image: b.migratorImage.split('@')[1] },
      { ...v, Name: '/foreign' },
      { ...v, Config: { ...v.Config, User: 'root' } },
      { ...v, Config: { ...v.Config, Cmd: ['node', 'other.js'] } },
      { ...v, Config: { ...v.Config, Env: [...spec.env, 'SECRET_OVERRIDE=x'] } },
      { ...v, Mounts: [{}] },
      { ...v, HostConfig: { ...v.HostConfig, Privileged: true } },
      { ...v, HostConfig: { ...v.HostConfig, CapAdd: ['SYS_ADMIN'] } },
      { ...v, HostConfig: { ...v.HostConfig, MemorySwap: -1 } },
      { ...v, HostConfig: { ...v.HostConfig, PidMode: 'host' } },
      { ...v, NetworkSettings: { Networks: { 'phub-timeweb-beta': {}, foreign: {} } } },
    ])
      expect(() => validateMigrationContainer(bad, id, op, 'created', spec)).toThrow();
    const args = migrationCreateArgs(name, op, '/etc/phub/timeweb-beta/migrator.env');
    expect(args).toContain('--read-only');
    expect(args).toContain('--memory-swap');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('/run/phub/fcm-service-account.json');
    expect(() => migrationCreateArgs(name, op, '/etc/foreign.env')).toThrow();
  });
});

it('permits only forward lock-release crash states', () => {
  for (const [active, provision] of [
    [true, true],
    [true, false],
    [false, false],
  ])
    expect(() => validateMigrationReleaseState(Boolean(active), Boolean(provision))).not.toThrow();
  expect(() => validateMigrationReleaseState(false, true)).toThrow('LOCK_RELEASE_ORDER');
});

describe('disk-backed API/Worker restore attestation', () => {
  it('binds installed disk tooling to the independently expected source bytes', () => {
    const source = Buffer.from('trusted enrolled backup tool\n');
    const expectedSha256 = hash(source);
    expect(() => validateDiskRestoreToolBytes(source, source, expectedSha256)).not.toThrow();
    const replacedPair = Buffer.from('replacement whose local request would self-hash\n');
    expect(() => validateDiskRestoreToolBytes(replacedPair, replacedPair, expectedSha256)).toThrow(
      /DISK_TOOL_SOURCE/,
    );
    expect(() => validateDiskRestoreToolBytes(replacedPair, source, expectedSha256)).toThrow(
      /DISK_TOOL_SOURCE/,
    );
  });

  it('chooses the restore reference kind from the fixed request and rejects downgrade shapes', () => {
    const f = diskFixture();
    const diskReference = {
      schema: 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
      storageProofSha256: f.value.storageProofSha256,
    };
    expect(
      validateMigrationBackupRestoreReference(f.operationBytes, f.expected, diskReference),
    ).toBe('disk');
    expect(() =>
      validateMigrationBackupRestoreReference(f.operationBytes, f.expected, {
        id: f.row.Id,
        operationSha256: hash(f.operationBytes),
      }),
    ).toThrow();

    const legacyOperation = {
      ...f.operation,
      schema: 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2',
      confirmation: 'BACKUP_RESTORE_API_WORKER_8158AC445C9F_KEEP_API_0D6078BE7A50',
    };
    const legacyBytes = Buffer.from(`${JSON.stringify(legacyOperation)}\n`);
    const legacyReference = { id: 'c'.repeat(64), operationSha256: hash(legacyBytes) };
    expect(validateMigrationBackupRestoreReference(legacyBytes, f.expected, legacyReference)).toBe(
      'legacy',
    );
    expect(() =>
      validateMigrationBackupRestoreReference(legacyBytes, f.expected, diskReference),
    ).toThrow();
  });

  it('allows only empty created or all-tmpfs legacy restore mounts', () => {
    expect(() =>
      validateLegacyBackupRestoreMounts({
        State: { Status: 'created' },
        HostConfig: { Binds: null },
        Mounts: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateLegacyBackupRestoreMounts({
        State: { Status: 'running' },
        HostConfig: { Binds: null },
        Mounts: [
          { Type: 'tmpfs', Destination: '/var/lib/postgresql/data', RW: true },
          { Type: 'tmpfs', Destination: '/var/run/postgresql', RW: true },
          { Type: 'tmpfs', Destination: '/tmp', RW: true },
        ],
      }),
    ).not.toThrow();
    for (const mount of [
      { Type: 'bind', Source: '/host/data', Destination: '/var/lib/postgresql/data', RW: true },
      { Type: 'volume', Name: 'foreign', Destination: '/var/lib/postgresql/data', RW: true },
    ])
      expect(() =>
        validateLegacyBackupRestoreMounts({
          State: { Status: 'running' },
          HostConfig: { Binds: null },
          Mounts: [
            mount,
            { Type: 'tmpfs', Destination: '/var/run/postgresql', RW: true },
            { Type: 'tmpfs', Destination: '/tmp', RW: true },
          ],
        }),
      ).toThrow(/BACKUP_RESTORE_MOUNTS/);
  });

  it('parses escaped nested mountinfo fields and rejects malformed mountinfo escapes', () => {
    const [entry] = parseDiskRestoreMountinfo(
      '67 41 253:7 /data\\040root /restore\\040mount rw,nosuid,nodev,noexec shared:17 master:1 - ext4 /dev/mapper/restore\\040disk rw,data\n',
    );
    expect(entry).toMatchObject({
      id: '67',
      parent: '41',
      device: '253:7',
      root: '/data root',
      target: '/restore mount',
      optional: ['shared:17', 'master:1'],
      fstype: 'ext4',
      source: '/dev/mapper/restore disk',
    });
    for (const raw of [
      '67 41 253:7 / /restore rw - ext4 /dev/mapper/restore rw extra\n',
      '67 41 253:7 /bad\\x /restore rw - ext4 /dev/mapper/restore rw\n',
      'not-a-mountinfo-line\n',
    ])
      expect(() => parseDiskRestoreMountinfo(raw)).toThrow(/DISK_MOUNTINFO/);
  });

  it('accepts only the fixed candidate/controller/migration tuple and deterministic disk plan', () => {
    const f = diskFixture();
    const reference = {
      schema: 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
      storageProofSha256: f.value.storageProofSha256,
    };
    expect(
      validateDiskRestoreReadback(f.value, f.expected, reference, f.operationBytes),
    ).toMatchObject({
      requestSha256: hash(f.operationBytes),
      id: f.row.Id,
      migration: f.expected,
    });
    const changedExpected = { ...f.expected, migrationPlanSha256: '9'.repeat(64) };
    const changedCandidate = {
      ...f.value,
      plan: { ...f.plan, canonical: '/opt/phub/timeweb-beta/backups/foreign-api-worker' },
    };
    const changedStorage = { ...reference, storageProofSha256: 'c'.repeat(64) };
    const callerSuppliedContainer = { ...reference, id: f.row.Id };
    const callerSuppliedPath = { ...reference, path: f.plan.image };
    const changedLimits = {
      ...f.value,
      plan: { ...f.plan, imageBytes: f.plan.imageBytes + 4 * 1024 ** 2 },
    };
    const changedContainment = {
      ...f.value,
      readback: {
        ...f.value.readback,
        container: {
          ...f.value.readback.container,
          HostConfig: { ...f.value.readback.container.HostConfig, Privileged: true },
        },
      },
    };
    for (const [value, expected, ref] of [
      [f.value, changedExpected, reference],
      [changedCandidate, f.expected, reference],
      [f.value, f.expected, changedStorage],
      [f.value, f.expected, callerSuppliedContainer],
      [f.value, f.expected, callerSuppliedPath],
      [changedLimits, f.expected, reference],
      [changedContainment, f.expected, reference],
    ] as const)
      expect(() => validateDiskRestoreReadback(value, expected, ref, f.operationBytes)).toThrow();
  });

  it('rejects drift in storage/kernel proof and the restore container command surface', () => {
    const f = diskFixture();
    const reference = {
      schema: 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
      storageProofSha256: f.value.storageProofSha256,
    };
    const changed = (
      storage: object,
      kernel = f.value.readback.kernel,
      container = f.value.readback.container,
    ) => ({
      ...f.value,
      readback: { ...f.value.readback, storage, kernel, container },
    });
    const foreignSource = {
      ...f.value.readback.kernel,
      hostMount: { ...f.value.readback.kernel.hostMount, source: '/dev/mapper/foreign' },
    };
    const foreignDevice = {
      ...f.value.readback.kernel,
      containerMount: { ...f.value.readback.kernel.containerMount, device: '253:8' },
    };
    const defaultLogging = {
      ...f.value.readback.container,
      HostConfig: {
        ...f.value.readback.container.HostConfig,
        LogConfig: { Type: 'json-file', Config: {} },
      },
    };
    const alteredEnv = {
      ...f.value.readback.container,
      Config: { ...f.value.readback.container.Config, Env: ['PGDATA=/foreign'] },
    };
    const alteredCmd = {
      ...f.value.readback.container,
      Config: { ...f.value.readback.container.Config, Cmd: ['sh', '-c', 'id'] },
    };
    const alteredEntrypoint = {
      ...f.value.readback.container,
      Config: { ...f.value.readback.container.Config, Entrypoint: ['sh'] },
    };
    for (const value of [
      changed({
        ...f.value.readback.storage,
        mapper: { ...f.value.readback.storage.mapper, uuid: 'foreign' },
      }),
      changed(f.value.readback.storage, foreignSource),
      changed(f.value.readback.storage, foreignDevice),
      changed({
        ...f.value.readback.storage,
        image: { ...f.value.readback.storage.image, unknown: true },
      }),
      changed(f.value.readback.storage, f.value.readback.kernel, defaultLogging),
      changed(f.value.readback.storage, f.value.readback.kernel, alteredEnv),
      changed(f.value.readback.storage, f.value.readback.kernel, alteredCmd),
      changed(f.value.readback.storage, f.value.readback.kernel, alteredEntrypoint),
    ])
      expect(() =>
        validateDiskRestoreReadback(value, f.expected, reference, f.operationBytes),
      ).toThrow();
  });

  it('requires the running restore container, its namespaces, and both exact mount snapshots to remain stable', () => {
    const f = diskFixture();
    const reference = {
      schema: 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
      storageProofSha256: f.value.storageProofSha256,
    };
    const attestation = validateDiskRestoreReadback(
      f.value,
      f.expected,
      reference,
      f.operationBytes,
    );
    const actual = {
      hostNamespace: f.value.readback.kernel.hostNamespace,
      containerNamespace: f.value.readback.kernel.containerNamespace,
      hostMountinfo: diskMountinfo(f.plan.mount, f.plan.mapperPath),
      containerMountinfo: diskMountinfo('/var/lib/postgresql/data', f.plan.mapperPath, '42'),
      afterHostNamespace: f.value.readback.kernel.hostNamespace,
      afterContainerNamespace: f.value.readback.kernel.containerNamespace,
    };
    expect(() => validateDiskRestoreKernelSnapshot(f.row, attestation, actual)).not.toThrow();
    const changedPid = { ...f.row, State: { ...f.row.State, Pid: 4243 } };
    const nestedMount = `${actual.hostMountinfo}43 41 253:7 / ${f.plan.mount}/nested rw,nosuid,nodev,noexec - ext4 ${f.plan.mapperPath} rw\n`;
    for (const [row, snapshot] of [
      [changedPid, actual],
      [f.row, { ...actual, hostMountinfo: nestedMount }],
      [f.row, { ...actual, afterContainerNamespace: actual.containerNamespace + 1 }],
      [f.row, { ...actual, containerNamespace: actual.containerNamespace + 1 }],
    ] as const)
      expect(() => validateDiskRestoreKernelSnapshot(row, attestation, snapshot)).toThrow();
  });

  it('rejects a readback whose kernel PID or start time does not bind to its inspected container', () => {
    const f = diskFixture();
    const reference = {
      schema: 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
      storageProofSha256: f.value.storageProofSha256,
    };
    for (const readback of [
      { ...f.value.readback, kernel: { ...f.value.readback.kernel, pid: 1 } },
      {
        ...f.value.readback,
        kernel: { ...f.value.readback.kernel, startedAt: '2026-10-12T10:00:01.000000000Z' },
      },
    ])
      expect(() =>
        validateDiskRestoreReadback(
          { ...f.value, readback },
          f.expected,
          reference,
          f.operationBytes,
        ),
      ).toThrow(/DISK_CONTAINER/);
  });
});

describe('migration exact CI pair closure', () => {
  it('uses the same frozen pair and rejects missing peers, wrong blobs and generic widening', async () => {
    const { API_WORKER_CI_DOWNLOAD_PATCH, API_WORKER_CI_READER_PATCH } =
      await import('./timeweb-api-worker-upgrade.js');
    const pair = [...API_WORKER_CI_DOWNLOAD_PATCH, ...API_WORKER_CI_READER_PATCH].map((v) => ({
      ...v,
    }));
    expect(() => validateMigrationControllerClosure(pair)).not.toThrow();
    for (const rows of [
      pair.slice(0, 2),
      pair.slice(2),
      pair.slice(0, -1),
      pair.map((v, i) => (i === 2 ? { ...v, newOid: v.oldOid } : v)),
      pair.slice(0, 1),
      [...pair, pair[0]],
      pair.map((v, i) => (i === 0 ? { ...v, oldOid: 'a'.repeat(40) } : v)),
      pair.map((v, i) => (i === 0 ? { ...v, newOid: 'b'.repeat(40) } : v)),
      pair.map((v, i) => (i === 0 ? { ...v, newMode: '100755' } : v)),
      pair.map((v, i) => (i === 0 ? { ...v, status: 'A', oldMode: '000000' } : v)),
      [...pair, { ...pair[0], path: '.github/workflows/other.yaml' }],
    ])
      expect(() => validateMigrationControllerClosure(rows)).toThrow();
  });
});

interface NamespaceFixture {
  operationBase64: string;
  nativePatch: ApiWorkerControllerDiffEntry[];
  expected: unknown;
  reference: unknown;
  value: unknown;
  actual: unknown;
}
function namespaceFixture(): NamespaceFixture {
  const result = spawnSync(
    'python3',
    ['-I', '-S', '-B', 'scripts/test-timeweb-database-backup.py', '--emit-namespace-fixture'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: 10000,
      maxBuffer: 512 * 1024,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return parseStrictJson<NamespaceFixture>(result.stdout);
}
function namespaceChanged(value: unknown, path: string, replacement: unknown): unknown {
  const copy = structuredClone(value),
    parts = path.split('.');
  let cursor = copy as Record<string, unknown>;
  for (const [index, part] of parts.entries()) {
    const key = parts.slice(index).join('.');
    if (Object.hasOwn(cursor, key)) {
      cursor[key] = replacement;
      return copy;
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  throw Error('TEST_PATH_NOT_FOUND');
}
describe('private namespace restore V2 independent contract', () => {
  it('connects only through the short absolute alias with independent host and namespace custody', () => {
    const f = namespaceFixture(),
      attestation = f.value as {
        plan: unknown;
        readback: { storage: { mount: Record<string, number> } };
      },
      observed = f.actual as {
        selfNamespace: number;
        alias: object;
        mountinfo: { broker: string; source: string };
      },
      actual = {
        ...observed.alias,
        selfNamespace: observed.selfNamespace,
        mountinfo: { self: observed.mountinfo.broker, source: observed.mountinfo.source },
      },
      mount = attestation.readback.storage.mount;
    const connection: { host: 'unix:///media/.runtime/docker.sock'; cwd: '/media' } =
      namespaceRestoreClientOptions(attestation, actual);
    expect(connection).toEqual({
      host: 'unix:///media/.runtime/docker.sock',
      cwd: '/media',
    });
    for (const wrong of [
      { ...actual, selfNamespace: 11 },
      { ...actual, mount: { ...mount, dev: 3 } },
      { ...actual, alias: { ...mount, ino: 3 } },
      { ...actual, alias: { ...mount, uid: 1 } },
      { ...actual, alias: { ...mount, mode: 0o120777 } },
      { ...actual, sourceAliasEmpty: false },
      { ...actual, sourceAlias: { ...mount, mode: 0o40755, nlink: 2 } },
      { ...actual, daemonCwd: '/foreign' },
      { ...actual, daemonCwdIdentity: { ...mount, ino: 3 } },
      { ...actual, host: 'unix:///var/run/docker.sock' },
      { ...actual, mountinfo: { ...actual.mountinfo, self: observed.mountinfo.source } },
      { ...actual, mountinfo: { ...actual.mountinfo, source: observed.mountinfo.broker } },
    ])
      expect(() => namespaceRestoreClientOptions(attestation, wrong)).toThrow();
    expect(() => namespaceRestoreClientOptions({}, actual)).toThrow('NS_CLIENT_CWD');
    expect(() =>
      namespaceRestoreClientOptions(
        namespaceChanged(
          attestation,
          'plan.isolation.strategy',
          'SYSTEMD_SUPERVISOR_PRIVATE_MOUNT_V1',
        ),
        actual,
      ),
    ).toThrow();
  });
  it('accepts Python-derived paths, sizing and process proof and independently checks kernel readback', () => {
    const f = namespaceFixture(),
      raw = Buffer.from(f.operationBase64, 'base64');
    const proof = validateDiskRestoreReadback(f.value, f.expected, f.reference, raw);
    expect(validateMigrationBackupRestoreReference(raw, f.expected, f.reference)).toBe('namespace');
    expect(() => validateNamespaceRestoreKernelSnapshot(proof, f.actual)).not.toThrow();
  });
  it('accepts the classic-store config digest bound to the contained image import', () => {
    const f = namespaceFixture(),
      raw = Buffer.from(f.operationBase64, 'base64'),
      value = structuredClone(f.value) as {
        readback: {
          image: { imported: { Id: string } };
          container: { Image: string; Config: { Image: string } };
        };
      },
      imported = 'sha256:' + 'c'.repeat(64);
    value.readback.image.imported.Id = imported;
    value.readback.container.Image = imported;
    value.readback.container.Config.Image = imported;
    expect(() => validateDiskRestoreReadback(value, f.expected, f.reference, raw)).not.toThrow();
    const drifted = structuredClone(value);
    drifted.readback.container.Image = (f.value as typeof value).readback.image.imported.Id;
    expect(() => validateDiskRestoreReadback(drifted, f.expected, f.reference, raw)).toThrow();
  });
  it('refuses downgrade, a host parent slice, escaped containerd and every unit/cgroup custody drift', () => {
    const f = namespaceFixture(),
      raw = Buffer.from(f.operationBase64, 'base64');
    const negatives: [string, unknown][] = [
      ['schema', 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V1'],
      ['plan.isolation.slice', 'system.slice'],
      ['readback.container.HostConfig.CgroupParent', 'system.slice'],
      ['readback.container.HostConfig.NetworkMode', 'host'],
      ['readback.isolation.managed.config.address', '/run/containerd/containerd.sock'],
      ['readback.isolation.managed.config.root', '/var/lib/containerd'],
      ['readback.isolation.managed.shims.0.cmdline', ['/usr/bin/runc']],
      ['readback.isolation.managed.containerd.mountNamespace', 11],
      ['readback.isolation.admission.supervisor.slice.unit.MemoryMax', 'infinity'],
      ['readback.isolation.admission.supervisor.slice.bounds.pids.max', 'max'],
      ['readback.isolation.socket.mode', 0o140666],
      ['readback.isolation.info.LiveRestoreEnabled', true],
      ['readback.kernel.containerProcess.gid', [0, 0, 0, 0]],
      ['readback.kernel.brokerMount.optional', ['shared:1']],
      ['readback.image.imported.RootFS.Layers', ['sha256:' + 'f'.repeat(64)]],
      ['plan.isolation.strategy', 'SYSTEMD_SUPERVISOR_PRIVATE_MOUNT_V1'],
      ['plan.isolation.socket', '/var/run/docker.sock'],
      ['plan.isolation.execRoot', '/opt/phub/long/runtime'],
      ['readback.alias.baseline.mode', 0o40777],
      ['readback.alias.baseline.nlink', 0],
      ['readback.alias.mount.ino', 999],
      ['readback.alias.brokerMount.source', '/dev/mapper/foreign'],
      ['readback.alias.daemonMount.optional', ['shared:2']],
      ['readback.mask.baseline.mode', 0o40777],
      ['readback.mask.source.dev', 999],
      ['readback.mask.brokerMount.root', '/'],
      ['readback.isolation.admission.network.supervisorNamespace', 21],
      ['readback.runtimeMounts.dataRoot.optional', []],
      ['readback.runtimeMounts.dataRoot.parent', '99'],
      ['readback.runtimeMounts.network.root', 'net:[21]'],
      ['readback.runtimeMounts.network.source', '/foreign'],
      ['readback.runtimeMounts.network.target', '/run/host-netns'],
      ['readback.kernel.networkSandboxKey', '/run/host-netns'],
      ['readback.kernel.containerNetworkNamespace', 22],
    ];
    const unit = (
      f.value as {
        readback: { isolation: { admission: { supervisor: { unit: Record<string, string> } } } };
      }
    ).readback.isolation.admission.supervisor.unit;
    for (const key of Object.keys(unit))
      negatives.push([`readback.isolation.admission.supervisor.unit.${key}`, 'foreign']);
    for (const [path, value] of negatives) {
      const changed = namespaceChanged(f.value, path, value);
      expect(
        () => validateDiskRestoreReadback(changed, f.expected, f.reference, raw),
        path,
      ).toThrow();
    }
    expect(() =>
      validateMigrationBackupRestoreReference(raw, f.expected, {
        schema: 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
        storageProofSha256: 'b'.repeat(64),
      }),
    ).toThrow();
    expect(() => validateMigrationBackupRestoreReference(raw, f.expected, undefined)).toThrow();
  });
  it('rejects independently observed PID reuse, runtime drift and any host mount leakage', () => {
    const f = namespaceFixture(),
      raw = Buffer.from(f.operationBase64, 'base64');
    const proof = validateDiskRestoreReadback(f.value, f.expected, f.reference, raw);
    const source = (f.actual as { mountinfo: { source: string; broker: string } }).mountinfo.source;
    const broker = (f.actual as { mountinfo: { source: string; broker: string } }).mountinfo.broker;
    for (const [path, value] of [
      ['afterProcesses.source.startTicks', '9999'],
      ['processes.containerd.cgroup', '0::/system.slice/containerd.service'],
      ['runtime.members', [45, 46, 47, 48, 99]],
      ['afterRuntime.configSha256', 'f'.repeat(64)],
      ['afterSelfNamespace', 11],
      ['alias.alias.ino', 999],
      ['alias.sourceAliasEmpty', false],
      ['alias.sourceAlias.ino', 999],
      ['alias.daemonCwd', '/foreign'],
      ['afterAlias.daemonCwdIdentity.ino', 999],
      ['alias.mask.ino', 999],
      ['alias.sourceMask.ino', 999],
      ['network.containerd', 11],
      ['afterNetwork.shim', 11],
      ['alias.networkMountIdentity.ino', 999],
      ['alias.containerNetworkIdentity.dev', 999],
      ['networkSandboxKey', '/foreign-netns'],
      ['afterNetworkSandboxKey', '/foreign-netns'],
      ['afterContainer.State.Pid', 999],
      ['afterMountinfo.broker', 'not-mountinfo'],

      ['mountinfo.source', source + broker.split('\n')[1] + '\n'],
      ['mountinfo.broker', broker.replace(' - ext4', ' shared:1 - ext4')],
    ] as [string, unknown][])
      expect(
        () =>
          validateNamespaceRestoreKernelSnapshot(proof, namespaceChanged(f.actual, path, value)),
        path,
      ).toThrow();
  });
  it('admits the one frozen native patch atomically without adding mobile paths to ordinary allowlists', () => {
    const rows = namespaceFixture().nativePatch.map((v) => ({ ...v }));
    expect(rows).toHaveLength(20);
    expect(() => validateMigrationControllerClosure(rows)).not.toThrow();
    expect(() => validateApiWorkerControllerDelta(rows)).not.toThrow();
    const invalid = [
      rows.slice(1),
      [...rows, rows[0]],
      ...rows.map((row, index) =>
        rows.map((v, i) => (i === index ? { ...row, newOid: 'f'.repeat(40) } : v)),
      ),
      [{ ...rows[0], newMode: '100755' }, ...rows.slice(1)],
      [{ ...rows[0], path: 'apps/mobile/src/foreign.ts' }, ...rows.slice(1)],
    ];
    for (const value of invalid) {
      expect(() => validateMigrationControllerClosure(value)).toThrow();
      expect(() => validateApiWorkerControllerDelta(value)).toThrow();
    }
  });
});

describe('exact inert Compose readiness pair', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import * as c from './scripts/timeweb-api-worker-contract.js';process.stdout.write(JSON.stringify({pins:c.API_WORKER_REHEARSAL_READINESS_PATCH,ordinary:[...c.API_WORKER_CONTROLLER_FILES],migration:[...c.API_WORKER_MIGRATION_CONTROLLER_FILES]}));",
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const contract = parseStrictJson<{
    pins: ApiWorkerControllerDiffEntry[];
    ordinary: string[];
    migration: string[];
  }>(result.stdout);
  const pair = () => contract.pins.map((row) => ({ ...row }));
  const validators = [validateApiWorkerControllerDelta, validateMigrationControllerClosure];
  it('admits only the exact pair in both closures without widening generic paths', () => {
    const ordinary = {
      ...pair()[0],
      path: 'scripts/timeweb-api-worker-contract.js',
    };
    for (const validate of validators) {
      expect(() => validate(pair())).not.toThrow();
      expect(() => validate([...pair(), ordinary])).not.toThrow();
      expect(() => validate([ordinary])).not.toThrow();
    }
    for (const row of pair()) {
      expect(contract.ordinary.includes(row.path)).toBe(false);
      expect(contract.migration.includes(row.path)).toBe(false);
      const bytes = readFileSync(row.path);
      expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(
        row.newOid,
      );
    }
  });
  it('rejects either missing peer, duplicates, changed blobs, modes, statuses and extra paths', () => {
    const invalid = [
      pair().slice(0, 1),
      pair().slice(1),
      [...pair(), pair()[0]],
      [...pair(), { ...pair()[0], path: 'scripts/unreviewed-compose.js' }],
    ];
    for (let index = 0; index < pair().length; index++) {
      for (const change of [
        { oldOid: 'a'.repeat(40) },
        { newOid: 'b'.repeat(40) },
        { oldMode: '000000' },
        { oldMode: '100755' },
        { oldMode: '120000' },
        { newMode: '100755' },
        { newMode: '120000' },
        { newMode: '160000' },
        { status: 'A' },
        { status: 'D' },
        { status: 'R100' },
        { path: 'scripts/unreviewed-compose.js' },
        { type: 'blob' },
      ])
        invalid.push(pair().map((row, i) => (i === index ? { ...row, ...change } : row)));
    }
    for (const rows of invalid)
      for (const validate of validators) expect(() => validate(rows)).toThrow();
    for (const mode of ['100755', '120000', '160000']) {
      const rows = pair().map((row, i) => (i === 0 ? { ...row, newMode: mode } : row));
      const raw = rows
        .map(
          (row) =>
            `:${row.oldMode} ${row.newMode} ${row.oldOid} ${row.newOid} ${row.status}\0${row.path}\0`,
        )
        .join('');
      for (const validate of validators)
        expect(() => validate(parseApiWorkerControllerDiff(raw))).toThrow();
    }
  });
});
