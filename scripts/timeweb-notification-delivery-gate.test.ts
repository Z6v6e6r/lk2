import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  chmodSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type * as NativeFs from 'node:fs';
import type { Logger } from 'pino';
const control = vi.hoisted(() => ({
  directory: '',
  syncs: 0,
  failSync: 0,
  failWrite: false,
  failAction: '',
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NativeFs>();
  const mapped = (p: unknown) =>
    typeof p === 'string' && p.startsWith('/run/phub/fcm-rollout-gate')
      ? control.directory + p.slice('/run/phub/fcm-rollout-gate'.length)
      : p;
  const owned = (st: NativeFs.Stats) => ({
    ...st,
    uid: 0,
    gid: 0,
    isFile: () => st.isFile(),
    isDirectory: () => st.isDirectory(),
    isSymbolicLink: () => st.isSymbolicLink(),
  });
  return {
    ...fs,
    lstatSync: vi.fn((p: string) => owned(fs.lstatSync(mapped(p) as string))),
    fstatSync: vi.fn((fd: number) => owned(fs.fstatSync(fd))),
    openSync: vi.fn((p: string, flags: number, mode?: number) => {
      const fd = fs.openSync(mapped(p) as string, flags, mode);
      if (control.failAction === 'create' && flags & fs.constants.O_CREAT) {
        fs.closeSync(fd);
        throw Error('CREATE_ACK_LOST');
      }
      return fd;
    }),
    fchmodSync: vi.fn((fd: number, mode: number) => {
      fs.fchmodSync(fd, mode);
      if (control.failAction === 'chmod') throw Error('CHMOD_ACK_LOST');
    }),
    linkSync: vi.fn((a: string, b: string) => {
      fs.linkSync(a, b);
      if (control.failAction === 'link') throw Error('LINK_ACK_LOST');
    }),
    unlinkSync: vi.fn((p: string) => {
      fs.unlinkSync(p);
      if (control.failAction === 'unlink') throw Error('UNLINK_ACK_LOST');
    }),
    readdirSync: vi.fn((p: string) => fs.readdirSync(mapped(p) as string)),
    fsyncSync: vi.fn((fd: number) => {
      fs.fsyncSync(fd);
      control.syncs++;
      if (control.syncs === control.failSync) throw Error('FSYNC_ACK_LOST');
    }),
    writeSync: vi.fn((fd: number, bytes: Buffer, offset: number, length: number) => {
      if (control.failWrite) {
        fs.writeSync(fd, bytes, offset, 1);
        throw Error('SHORT_WRITE');
      }
      return fs.writeSync(fd, bytes, offset, length);
    }),
  };
});
import { fcmRolloutClaimAllowed } from '../apps/worker/src/fcm-rollout-gate.js';
import { runFcmDeliveryBatch } from '../apps/worker/src/fcm-delivery.js';
import {
  FCM_GATE_TARGET,
  fcmGateBinding,
  fcmGateEnvironment,
  fcmGateToken,
  fcmGateComposeOverride,
  holdFcmDeliveryGate,
  readFcmDeliveryGate,
  releaseFcmDeliveryGate,
  validateFcmGateRuntime,
} from './timeweb-notification-delivery-gate.js';
import { preservedFixture } from './timeweb-notification-preserved.fixture.js';
const binding = fcmGateBinding(preservedFixture().op, '1'.repeat(64), '2'.repeat(64));
const env = fcmGateEnvironment(binding);
let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fcm-gate-'));
  control.directory = join(root, 'gate');
  control.syncs = 0;
  control.failSync = 0;
  control.failWrite = false;
  control.failAction = '';
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
describe('candidate FCM monotonic directory gate (filesystem owner metadata injected for local uid)', () => {
  it('leaves legacy Worker unchanged and rejects partial candidate environment', () => {
    expect(fcmRolloutClaimAllowed({})).toBe(true);
    for (const key of Object.keys(env))
      expect(fcmRolloutClaimAllowed({ [key]: env[key] })).toBe(false);
  });
  it('requires a valid released token, re-reads after candidate restart, never removes held', () => {
    expect(fcmRolloutClaimAllowed(env)).toBe(false);
    holdFcmDeliveryGate(control.directory, binding);
    expect(readFcmDeliveryGate(control.directory, binding)).toBe('HELD');
    expect(fcmRolloutClaimAllowed(env)).toBe(false);
    const before = readFileSync(join(control.directory, 'held.json'));
    releaseFcmDeliveryGate(control.directory, binding);
    expect(fcmRolloutClaimAllowed(env)).toBe(true);
    expect(readFileSync(join(control.directory, 'held.json'))).toEqual(before);
    expect(fcmRolloutClaimAllowed(env)).toBe(true);
    releaseFcmDeliveryGate(control.directory, binding); // forward-only full-token recovery
    expect(fcmRolloutClaimAllowed({ ...env, FCM_ROLLOUT_OPERATION_SHA256: '0'.repeat(64) })).toBe(
      false,
    );
  });
  it.each([
    'partial',
    'wrong-operation',
    'extra',
    'symlink',
    'hardlink',
    'mode',
    'duplicate-json',
    'oversize',
    'directory-mode',
    'missing-held',
  ])('fails closed for %s without claims/attempts/provider calls', async (kind) => {
    holdFcmDeliveryGate(control.directory, binding);
    releaseFcmDeliveryGate(control.directory, binding);
    const file = join(control.directory, 'released.json');
    if (kind === 'partial') writeFileSync(file, '{');
    if (kind === 'wrong-operation')
      writeFileSync(
        file,
        fcmGateToken({ ...binding, operationSha256: '0'.repeat(64) }, 'RELEASED'),
      );
    if (kind === 'extra') writeFileSync(join(control.directory, 'incoming-token'), 'x');
    if (kind === 'symlink') {
      unlinkSync(file);
      symlinkSync(join(root, 'foreign'), file);
    }
    if (kind === 'hardlink') linkSync(file, join(root, 'twin'));
    if (kind === 'mode') chmodSync(file, 0o666);
    if (kind === 'duplicate-json')
      writeFileSync(file, fcmGateToken(binding, 'RELEASED').replace('{', '{"state":"HELD",'));
    if (kind === 'oversize') writeFileSync(file, 'x'.repeat(4096));
    if (kind === 'directory-mode') chmodSync(control.directory, 0o777);
    if (kind === 'missing-held') unlinkSync(join(control.directory, 'held.json'));
    expect(fcmRolloutClaimAllowed(env)).toBe(false);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const connect = vi.fn(),
      send = vi.fn(),
      decrypt = vi.fn();
    expect(
      await runFcmDeliveryBatch({
        pool: { connect } as unknown as Pool,
        logger: { info: vi.fn() } as unknown as Logger,
        tenantId: 'a1000000-0000-4000-8000-000000000001',
        appId: 'ru.padlhub.app',
        environment: 'SANDBOX',
        cipher: { activeKeyId: 'fixture', encrypt: vi.fn(), decrypt },
        adapter: { platform: 'ANDROID', send },
        maxAttempts: 3,
        retryBaseMs: 1000,
      }),
    ).toEqual({ claimed: 0, sent: 0, retried: 0, dead: 0, stale: 0 });
    expect(connect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4, 5])(
    'hold fsync ACK window %i never permits claims or reuses exclusive paths',
    (point) => {
      control.failSync = point;
      expect(() => holdFcmDeliveryGate(control.directory, binding)).toThrow('FSYNC_ACK_LOST');
      expect(fcmRolloutClaimAllowed(env)).toBe(false);
      control.failSync = 0;
      expect(() => holdFcmDeliveryGate(control.directory, binding)).toThrow();
    },
  );
  it.each([1, 2, 3])(
    'release fsync ACK window %i is forward-only and exact full-token retryable',
    (point) => {
      holdFcmDeliveryGate(control.directory, binding);
      control.syncs = 0;
      control.failSync = point;
      expect(() => releaseFcmDeliveryGate(control.directory, binding)).toThrow('FSYNC_ACK_LOST');
      control.failSync = 0;
      releaseFcmDeliveryGate(control.directory, binding);
      expect(readFcmDeliveryGate(control.directory, binding)).toBe('RELEASED');
    },
  );
  it('recovers an exact unpublished partial released prefix after durable intent without overwriting any final token', () => {
    holdFcmDeliveryGate(control.directory, binding);
    control.failWrite = true;
    expect(() => releaseFcmDeliveryGate(control.directory, binding)).toThrow('SHORT_WRITE');
    expect(fcmRolloutClaimAllowed(env)).toBe(false);
    control.failWrite = false;
    releaseFcmDeliveryGate(control.directory, binding);
    expect(fcmRolloutClaimAllowed(env)).toBe(true);
  });
  it.each(['create', 'chmod', 'link', 'unlink'])(
    'forward-recovers release %s acknowledgment loss on the real filesystem',
    (action) => {
      holdFcmDeliveryGate(control.directory, binding);
      control.failAction = action;
      expect(() => releaseFcmDeliveryGate(control.directory, binding)).toThrow('ACK_LOST');
      control.failAction = '';
      releaseFcmDeliveryGate(control.directory, binding);
      expect(readFcmDeliveryGate(control.directory, binding)).toBe('RELEASED');
    },
  );
  it('rejects foreign unpublished prefix instead of cleaning it', () => {
    holdFcmDeliveryGate(control.directory, binding);
    writeFileSync(join(control.directory, '.released.incoming'), 'foreign', { mode: 0o600 });
    expect(() => releaseFcmDeliveryGate(control.directory, binding)).toThrow('TOKEN_PREFIX');
    expect(fcmRolloutClaimAllowed(env)).toBe(false);
  });
  it('uses candidate-only readonly directory mount and exact separate environment binding', () => {
    const model = JSON.parse(fcmGateComposeOverride(control.directory, binding)) as {
      services: { worker: { volumes: unknown[] } };
    };
    expect(Object.keys(model.services)).toEqual(['worker']);
    const volume = model.services.worker.volumes[0];
    expect(volume).toEqual({
      type: 'bind',
      source: control.directory,
      target: FCM_GATE_TARGET,
      read_only: true,
      bind: { create_host_path: false },
    });
    const actual = {
      mounts: [
        { Destination: FCM_GATE_TARGET, Type: 'bind', Source: control.directory, RW: false },
      ],
      environment: Object.entries(env).map(([k, v]) => k + '=' + v),
    };
    expect(() => validateFcmGateRuntime(actual, control.directory, binding)).not.toThrow();
    for (const mounts of [
      [],
      [{ ...actual.mounts[0], RW: true }],
      [{ ...actual.mounts[0], Source: control.directory + '/released.json' }],
    ])
      expect(() =>
        validateFcmGateRuntime({ ...actual, mounts }, control.directory, binding),
      ).toThrow('MOUNT');
    expect(() =>
      validateFcmGateRuntime(
        { ...actual, environment: actual.environment.slice(1) },
        control.directory,
        binding,
      ),
    ).toThrow('ENVIRONMENT');
    expect(() =>
      validateFcmGateRuntime(
        { ...actual, environment: [...actual.environment, actual.environment[0]] },
        control.directory,
        binding,
      ),
    ).toThrow('ENVIRONMENT');
  });
});
