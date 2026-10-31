import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface Runtime {
  identifier: string;
  version: string;
  isAvailable: boolean;
}
interface DeviceType {
  identifier: string;
  name: string;
  productFamily: string;
  minRuntimeVersion: number;
  maxRuntimeVersion: number;
}
interface Device {
  udid: string;
  name: string;
  state: string;
}
export type SimulatorCommand = (
  args: readonly string[],
  timeout: number,
  inherit?: boolean,
) => string;

export function verifyNativeTestHook(bundle: string, expected: boolean): void {
  const binaries = [`${bundle}/App`, `${bundle}/App.debug.dylib`].filter(existsSync);
  if (binaries.length === 0) throw new Error('IOS_NATIVE_TEST_BINARY_MISSING');
  const symbols = binaries
    .map((binary) =>
      execFileSync('xcrun', ['nm', '-a', binary], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
    )
    .join('\n');
  if (symbols.includes('installDirectIntegrationTransport') !== expected)
    throw new Error('IOS_NATIVE_TEST_HOOK_COMPILATION_BOUNDARY');
}

function versionNumber(value: string): number {
  if (!/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value)) return -1;
  const parts = value.split('.').map(Number);
  if (parts.some((part) => part > 255)) return -1;
  return (parts[0] ?? 0) * 65536 + (parts[1] ?? 0) * 256 + (parts[2] ?? 0);
}

export function selectNativeTestTarget(runtimes: Runtime[], types: DeviceType[]) {
  for (const runtime of [...runtimes].sort(
    (a, b) => versionNumber(b.version) - versionNumber(a.version),
  )) {
    if (
      runtime.isAvailable !== true ||
      !/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+(?:-\d+){0,2}$/.test(runtime.identifier) ||
      versionNumber(runtime.version) < 0
    )
      continue;
    const device = types
      .filter(
        (type) =>
          type.productFamily === 'iPhone' &&
          type.name.startsWith('iPhone ') &&
          type.identifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-') &&
          Number.isInteger(type.minRuntimeVersion) &&
          Number.isInteger(type.maxRuntimeVersion) &&
          type.minRuntimeVersion <= versionNumber(runtime.version) &&
          type.maxRuntimeVersion >= versionNumber(runtime.version),
      )
      .sort(
        (a, b) =>
          b.minRuntimeVersion - a.minRuntimeVersion || a.identifier.localeCompare(b.identifier),
      )[0];
    if (device) return { runtime, device };
  }
  throw new Error('IOS_NATIVE_TEST_COMPATIBLE_RUNTIME_UNAVAILABLE');
}

/** CI owns only the newly created, nonce-named simulator; never adopt another device. */
export function runNativeDirectTests(
  run: SimulatorCommand,
  nonce = randomUUID(),
  verifyHook = verifyNativeTestHook,
): void {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nonce))
    throw new Error('IOS_NATIVE_TEST_NONCE_INVALID');
  verifyHook('apps/mobile/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app', false);
  verifyHook(
    'apps/mobile/ios/DerivedData/ReleaseBoundary/Build/Products/Release-iphonesimulator/App.app',
    false,
  );
  const { runtimes } = JSON.parse(run(['simctl', 'list', 'runtimes', '--json'], 30_000)) as {
    runtimes: Runtime[];
  };
  const { devicetypes } = JSON.parse(run(['simctl', 'list', 'devicetypes', '--json'], 30_000)) as {
    devicetypes: DeviceType[];
  };
  const { runtime, device } = selectNativeTestTarget(runtimes, devicetypes);
  const name = `PadlHub-R1-${nonce}`;
  const id = run(['simctl', 'create', name, device.identifier, runtime.identifier], 60_000).trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new Error('IOS_NATIVE_TEST_CREATE_RECEIPT_INVALID');
  const readOwned = () => {
    const { devices } = JSON.parse(run(['simctl', 'list', 'devices', '--json'], 30_000)) as {
      devices: Record<string, Device[]>;
    };
    const matches = (devices[runtime.identifier] ?? []).filter((row) => row.udid === id);
    if (matches.length !== 1 || matches[0]?.name !== name)
      throw new Error('IOS_NATIVE_TEST_DEVICE_OWNERSHIP_CHANGED');
    return matches[0];
  };
  // A failed ownership read never grants authority to boot or delete a guessed UUID.
  if (readOwned().state !== 'Shutdown') throw new Error('IOS_NATIVE_TEST_DEVICE_NOT_NEW');
  let failure: unknown;
  try {
    run(['simctl', 'boot', id], 60_000);
    run(['simctl', 'bootstatus', id, '-b'], 180_000);
    readOwned();
    run(
      [
        'xcodebuild',
        '-project',
        'apps/mobile/ios/App/App.xcodeproj',
        '-scheme',
        'App',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-destination',
        `platform=iOS Simulator,id=${id}`,
        '-derivedDataPath',
        'apps/mobile/ios/DerivedData/DirectTests',
        '-resultBundlePath',
        '.ci-artifacts/ios-native-direct/DirectIntegration.xcresult',
        '-parallel-testing-enabled',
        'NO',
        '-only-testing:AppTests/PadlHubDirectIntegrationTests',
        '-test-timeouts-enabled',
        'YES',
        '-maximum-test-execution-time-allowance',
        '120',
        'CODE_SIGNING_ALLOWED=NO',
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG PADLHUB_B07_TEST_HOST',
        'test',
      ],
      15 * 60_000,
      true,
    );
    verifyHook(
      'apps/mobile/ios/DerivedData/DirectTests/Build/Products/Debug-iphonesimulator/App.app',
      true,
    );
  } catch (error) {
    failure = error;
  }
  try {
    const owned = readOwned();
    if (owned.state === 'Booted') run(['simctl', 'shutdown', id], 60_000);
    if (readOwned().state !== 'Shutdown') throw new Error('IOS_NATIVE_TEST_SHUTDOWN_UNCONFIRMED');
    run(['simctl', 'delete', id], 60_000);
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'IOS_NATIVE_TEST_AND_CLEANUP_FAILED')
      : error;
  }
  if (failure)
    throw failure instanceof Error
      ? failure
      : new Error('IOS_NATIVE_TEST_FAILED', { cause: failure });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (
    process.platform !== 'darwin' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.argv.length !== 3 ||
    process.argv[2] !== '--ci-owned-simulator'
  )
    throw new Error('IOS_NATIVE_TEST_REQUIRES_OWNED_MACOS_CI');
  mkdirSync('.ci-artifacts/ios-native-direct', { recursive: true });
  runNativeDirectTests((args, timeout, inherit = false) => {
    const result = execFileSync('xcrun', [...args], {
      timeout,
      encoding: 'utf8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    return result ?? '';
  });
}
