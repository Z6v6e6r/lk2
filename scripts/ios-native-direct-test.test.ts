import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runNativeDirectTests, selectNativeTestTarget } from './ios-native-direct-test.js';

const runtime = {
  identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  version: '26.5',
  isAvailable: true,
};
const device = {
  identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  name: 'iPhone 17',
  productFamily: 'iPhone',
  minRuntimeVersion: 26 * 65536,
  maxRuntimeVersion: 0xffffffff,
};
const nonce = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const syntheticHookCheck = () => undefined;

function fixture(
  options: {
    failTest?: boolean;
    failBoot?: boolean;
    drift?: boolean;
    invalidId?: boolean;
    failShutdown?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const budgets: { args: readonly string[]; timeout: number }[] = [];
  let state = 'Shutdown';
  let tested = false;
  const run = (args: readonly string[], timeout: number) => {
    budgets.push({ args, timeout });
    calls.push([...args]);
    if (args[2] === 'runtimes') return JSON.stringify({ runtimes: [runtime] });
    if (args[2] === 'devicetypes') return JSON.stringify({ devicetypes: [device] });
    if (args[1] === 'create') return options.invalidId ? 'ambiguous' : id;
    if (args[2] === 'devices')
      return JSON.stringify({
        devices: {
          [runtime.identifier]: [
            {
              udid: id,
              name: options.drift && tested ? 'Another task' : `PadlHub-R1-${nonce}`,
              state,
            },
          ],
        },
      });
    if (args[1] === 'boot') state = 'Booted';
    if (args[1] === 'bootstatus' && options.failBoot)
      throw new Error('synthetic first-boot timeout');
    if (args[0] === 'xcodebuild') {
      tested = true;
      if (options.failTest) throw new Error('synthetic test failure');
    }
    if (args[1] === 'shutdown') {
      if (options.failShutdown) throw new Error('synthetic shutdown failure');
      state = 'Shutdown';
    }
    return '';
  };
  return { run, calls, budgets };
}

describe('owned synthetic native simulator execution', () => {
  it('refuses CLI execution outside the explicit CI context before any device operation', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/ios-native-direct-test.ts', '--ci-owned-simulator'],
      {
        env: { ...process.env, GITHUB_ACTIONS: 'false' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('IOS_NATIVE_TEST_REQUIRES_OWNED_MACOS_CI');
  });
  it('rejects unavailable or incompatible runtimes without selecting arbitrary hardware', () => {
    expect(() => selectNativeTestTarget([{ ...runtime, isAvailable: false }], [device])).toThrow();
    expect(() =>
      selectNativeTestTarget([runtime], [{ ...device, minRuntimeVersion: 27 * 65536 }]),
    ).toThrow();
    expect(() => selectNativeTestTarget([{ ...runtime, version: 'invalid' }], [device])).toThrow();
    expect(selectNativeTestTarget([runtime], [device])).toEqual({ runtime, device });
  });
  it('runs the guarded unsigned test target and cleans only its exact new UUID', () => {
    const { run, calls } = fixture();
    const hooks: boolean[] = [];
    runNativeDirectTests(run, nonce, (_bundle, expected) => {
      hooks.push(expected);
    });
    expect(hooks).toEqual([false, false, true]);
    const build = calls.find((args) => args[0] === 'xcodebuild');
    expect(build).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(build).toContain(
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG PADLHUB_B07_TEST_HOST',
    );
    expect(build).toContain(`platform=iOS Simulator,id=${id}`);
    expect(calls.filter((args) => ['shutdown', 'delete'].includes(args[1] ?? ''))).toEqual([
      ['simctl', 'shutdown', id],
      ['simctl', 'delete', id],
    ]);
  });
  it('bounds fresh data migration and cleans only the owned simulator if first boot times out', () => {
    const { run, calls, budgets } = fixture({ failBoot: true });
    expect(() => runNativeDirectTests(run, nonce, syntheticHookCheck)).toThrow(
      'synthetic first-boot timeout',
    );
    expect(budgets.find(({ args }) => args[1] === 'bootstatus')?.timeout).toBe(600_000);
    expect(calls.some((args) => args[0] === 'xcodebuild')).toBe(false);
    expect(calls.filter((args) => ['shutdown', 'delete'].includes(args[1] ?? ''))).toEqual([
      ['simctl', 'shutdown', id],
      ['simctl', 'delete', id],
    ]);
  });
  it('retries only a transient targeted inventory read after first boot', () => {
    const { run, calls } = fixture();
    let booted = false;
    let timeouts = 0;
    runNativeDirectTests(
      (args, timeout) => {
        if (args[1] === 'bootstatus') booted = true;
        if (args[2] === 'devices') {
          expect(args).toEqual(['simctl', 'list', 'devices', id, '--json']);
          expect(timeout).toBe(90_000);
          if (booted && timeouts++ === 0)
            throw Object.assign(new Error('synthetic inventory timeout'), { code: 'ETIMEDOUT' });
        }
        return run(args, timeout);
      },
      nonce,
      syntheticHookCheck,
    );
    expect(calls.filter((args) => args[1] === 'create')).toHaveLength(1);
    expect(calls.filter((args) => args[1] === 'boot')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'xcodebuild')).toHaveLength(1);
    expect(calls.filter((args) => args[1] === 'delete')).toEqual([['simctl', 'delete', id]]);
  });
  it('does not run tests or delete if targeted inventory remains unavailable', () => {
    const { run, calls } = fixture();
    let booted = false;
    let reads = 0;
    expect(() =>
      runNativeDirectTests(
        (args, timeout) => {
          if (args[1] === 'bootstatus') booted = true;
          if (args[2] === 'devices' && booted) {
            reads++;
            throw Object.assign(new Error('synthetic inventory unavailable'), {
              code: 'ETIMEDOUT',
            });
          }
          return run(args, timeout);
        },
        nonce,
        syntheticHookCheck,
      ),
    ).toThrow('IOS_NATIVE_TEST_AND_CLEANUP_FAILED');
    expect(reads).toBe(4); // two bounded attempts at each original/cleanup read
    expect(calls.some((args) => args[0] === 'xcodebuild' || args[1] === 'delete')).toBe(false);
  });
  it('preserves test failure while cleaning its simulator', () => {
    const { run, calls } = fixture({ failTest: true });
    expect(() => runNativeDirectTests(run, nonce, syntheticHookCheck)).toThrow(
      'synthetic test failure',
    );
    expect(calls.at(-1)).toEqual(['simctl', 'delete', id]);
  });
  it('never cleans an ambiguous create receipt or a changed owner', () => {
    for (const options of [{ invalidId: true }, { drift: true }]) {
      const { run, calls } = fixture(options);
      expect(() => runNativeDirectTests(run, nonce, syntheticHookCheck)).toThrow();
      expect(calls.some((args) => args[1] === 'delete')).toBe(false);
    }
  });
  it('does not delete after an unconfirmed shutdown', () => {
    const { run, calls } = fixture({ failShutdown: true });
    expect(() => runNativeDirectTests(run, nonce, syntheticHookCheck)).toThrow(
      'synthetic shutdown failure',
    );
    expect(calls.some((args) => args[1] === 'delete')).toBe(false);
  });
  it('does not create a simulator if an ordinary build exposes the test hook', () => {
    const { run, calls } = fixture();
    expect(() =>
      runNativeDirectTests(run, nonce, () => {
        throw new Error('hook exposed');
      }),
    ).toThrow('hook exposed');
    expect(calls).toEqual([]);
  });
});
