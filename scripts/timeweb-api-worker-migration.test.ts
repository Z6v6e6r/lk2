import { readFileSync, readdirSync } from 'node:fs';
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
} from './timeweb-api-worker-migration.js';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
describe('closed migration custody validators', () => {
  it('accepts exact packaged ledgers and rejects partial, reordered, altered and extra rows', () => {
    const rows = readdirSync('packages/database/migrations')
      .filter((v) => v.endsWith('.sql'))
      .sort()
      .map((filename) => ({
        filename,
        checksum: hash(readFileSync(`packages/database/migrations/${filename}`)),
      }));
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
    const name = 'phub-timeweb-migration-11954ffd6d7b-38144582876-1',
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
        Entrypoint: null,
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
