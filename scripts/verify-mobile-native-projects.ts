import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeProjectFiles = Readonly<Record<string, string>>;

const expectedAppId = 'ru.padlhub.app';
const expectedAppName = 'PadlHub';
const expectedGradleDistributionSha256 =
  'ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c';
const expectedGradleWrapperJarSha256 =
  '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172';
const capacitorPackages = [
  '@capacitor/core',
  '@capacitor/cli',
  '@capacitor/ios',
  '@capacitor/android',
] as const;

const requiredPaths = [
  'apps/mobile/capacitor.config.ts',
  'apps/mobile/package.json',
  'package-lock.json',
  'apps/mobile/ios/App/App.xcodeproj/project.pbxproj',
  'apps/mobile/ios/App/App/Info.plist',
  'apps/mobile/ios/App/App/AppDelegate.swift',
  'apps/mobile/ios/App/CapApp-SPM/Package.swift',
  'apps/mobile/android/app/build.gradle',
  'apps/mobile/android/app/src/main/AndroidManifest.xml',
  'apps/mobile/android/app/src/main/res/values/strings.xml',
  'apps/mobile/android/capacitor.settings.gradle',
  'apps/mobile/android/gradle/wrapper/gradle-wrapper.jar',
  'apps/mobile/android/gradle/wrapper/gradle-wrapper.properties',
  'apps/mobile/android/variables.gradle',
] as const;

function content(files: NativeProjectFiles, path: string, errors: string[]): string {
  const value = files[path];
  if (value === undefined) {
    errors.push(`missing required native source: ${path}`);
    return '';
  }
  return value;
}

function requirePattern(value: string, pattern: RegExp, message: string, errors: string[]): void {
  if (!pattern.test(value)) errors.push(message);
}

function scanRuntimeUrls(files: NativeProjectFiles, errors: string[]): void {
  const runtimeEntries = Object.entries(files).filter(
    ([path]) =>
      path === 'apps/mobile/capacitor.config.ts' ||
      /^apps\/mobile\/ios\/App\/App\//u.test(path) ||
      /^apps\/mobile\/android\/app\/src\/main\//u.test(path),
  );
  const allowedMetadataUrls = new Set([
    'http://schemas.android.com/apk/res/android',
    'http://schemas.android.com/aapt',
    'http://schemas.android.com/apk/res-auto',
    'http://schemas.android.com/tools',
    'http://www.apple.com/DTDs/PropertyList-1.0.dtd',
  ]);
  for (const [path, value] of runtimeEntries) {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gu)) {
      const url = match[0].replace(/[),.;]+$/u, '');
      if (!allowedMetadataUrls.has(url)) {
        errors.push(`hardcoded runtime URL in ${path}: ${url}`);
      }
    }
  }
}

function scanCandidatePaths(files: NativeProjectFiles, errors: string[]): void {
  const forbiddenPath =
    /(?:^|\/)(?:DerivedData|Pods|\.gradle|xcuserdata|captures)(?:\/|$)|(?:^|\/)(?:local\.properties|google-services\.json|GoogleService-Info\.plist)$|\.(?:apk|aab|ipa|xcarchive|keystore|jks|p12|mobileprovision)$/u;
  const buildOutputPath = /(?:^|\/)build\/(?!gradle(?:\.kts)?$)/u;
  for (const path of Object.keys(files)) {
    if (forbiddenPath.test(path) || buildOutputPath.test(path)) {
      errors.push(`machine-local or build output is source-controlled: ${path}`);
    }
  }
}

function scanNativeText(files: NativeProjectFiles, errors: string[]): void {
  const nativeEntries = Object.entries(files).filter(([path]) =>
    /^apps\/mobile\/(?:ios|android)\//u.test(path),
  );
  const combined = nativeEntries.map(([, value]) => value).join('\n');

  if (/(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\)/u.test(combined)) {
    errors.push('machine-local absolute path found in native source');
  }
  if (
    /(?:storePassword|keyPassword|storeFile|signingConfig|PROVISIONING_PROFILE_SPECIFIER|DEVELOPMENT_TEAM\s*=)/u.test(
      combined,
    )
  ) {
    errors.push(
      'signing credential, provisioning profile, keystore, or Development Team configuration found',
    );
  }
  if (
    /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"']+["'])/iu.test(
      combined,
    )
  ) {
    errors.push('secret-like value found in native source');
  }
  if (
    /(?:CFBundleURLTypes|com\.apple\.developer\.associated-domains|applinks:|custom_url_scheme|android\.intent\.action\.VIEW|android\.intent\.category\.BROWSABLE|<data\b[^>]*android:(?:scheme|host))/isu.test(
      combined,
    )
  ) {
    errors.push('deep link, custom URL scheme, Universal Link, or App Link configuration found');
  }
  for (const match of combined.matchAll(/cleartextTrafficPermitted\s*=\s*["']([^"']+)["']/giu)) {
    if (match[1]?.toLowerCase() !== 'false') {
      errors.push(
        'Android network security config allows or indirection-controls cleartext traffic',
      );
    }
  }
  if (
    /(?:NSCameraUsageDescription|NSMicrophoneUsageDescription|NSContactsUsageDescription|NSLocation\w*UsageDescription|NSPhotoLibrary\w*UsageDescription|NSBluetooth\w*UsageDescription|aps-environment)/u.test(
      combined,
    )
  ) {
    errors.push('unexpected iOS device permission or push entitlement found');
  }
}

function verifyAndroidComponents(manifest: string, errors: string[]): void {
  const components = [
    ...manifest.matchAll(
      /<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gu,
    ),
  ];
  let launcherCount = 0;
  for (const match of components) {
    const kind = match[1] ?? 'component';
    const attributes = match[2] ?? '';
    const body = match[3] ?? '';
    const name = attributes.match(/android:name=["']([^"']+)["']/u)?.[1] ?? '<unnamed>';
    const exported = attributes.match(/android:exported=["']([^"']+)["']/u)?.[1];
    if (kind === 'activity' && name === '.MainActivity') {
      const isLauncher =
        exported === 'true' &&
        /android\.intent\.action\.MAIN/u.test(body) &&
        /android\.intent\.category\.LAUNCHER/u.test(body) &&
        !/(?:android\.intent\.action\.VIEW|android\.intent\.category\.BROWSABLE|<data\b)/u.test(
          body,
        );
      if (!isLauncher) errors.push('Android MainActivity must be the exact exported launcher only');
      else launcherCount += 1;
      continue;
    }
    if (exported !== 'false') {
      errors.push(`Android ${kind} ${name} must be explicitly non-exported`);
    }
  }
  if (launcherCount !== 1)
    errors.push('Android manifest must contain exactly one safe launcher activity');
}

function verifyAndroidApplication(manifest: string, errors: string[]): void {
  const withoutComments = manifest.replace(/<!--[\s\S]*?-->/gu, '');
  const applications = [...withoutComments.matchAll(/<application\b([^>]*)>/gu)];
  if (applications.length !== 1) {
    errors.push('Android manifest must contain exactly one application node');
    return;
  }
  const attributes = applications[0]?.[1] ?? '';
  const attribute = (name: string): string | undefined =>
    attributes.match(new RegExp(`android:${name}=["']([^"']+)["']`, 'u'))?.[1];
  if (attribute('allowBackup') !== 'false') {
    errors.push('Android backup must be explicitly disabled on the application node');
  }
  if (attribute('usesCleartextTraffic') !== 'false') {
    errors.push('Android cleartext traffic must be explicitly disabled on the application node');
  }
  if (attribute('networkSecurityConfig') !== undefined) {
    errors.push('Android custom network security config is not allowed in the native shell');
  }
}

function parseProperties(value: string): {
  duplicates: string[];
  invalidLines: string[];
  values: ReadonlyMap<string, string>;
} {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  const invalidLines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/u);
    if (match === null) {
      invalidLines.push(line);
      continue;
    }
    const key = match[1]!;
    if (values.has(key)) duplicates.add(key);
    values.set(key, match[2]!);
  }
  return { duplicates: [...duplicates], invalidLines, values };
}

function verifyVersions(files: NativeProjectFiles, errors: string[]): void {
  let mobilePackage: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  let packageLock: { packages?: Record<string, { version?: string }> };
  try {
    mobilePackage = JSON.parse(
      content(files, 'apps/mobile/package.json', errors),
    ) as typeof mobilePackage;
    packageLock = JSON.parse(content(files, 'package-lock.json', errors)) as typeof packageLock;
  } catch {
    errors.push('mobile package metadata is not valid JSON');
    return;
  }

  const versions = capacitorPackages.map(
    (name) => mobilePackage.dependencies?.[name] ?? mobilePackage.devDependencies?.[name],
  );
  if (versions.some((version) => version === undefined) || new Set(versions).size !== 1) {
    errors.push('workspace Capacitor package versions are missing or inconsistent');
    return;
  }
  const expectedVersion = versions[0]!;
  for (const name of capacitorPackages) {
    if (packageLock.packages?.[`node_modules/${name}`]?.version !== expectedVersion) {
      errors.push(`package-lock version for ${name} does not match ${expectedVersion}`);
    }
  }

  const swiftPackage = files['apps/mobile/ios/App/CapApp-SPM/Package.swift'] ?? '';
  requirePattern(
    swiftPackage,
    new RegExp(
      `capacitor-swift-pm\\.git["'], exact: ["']${expectedVersion.replaceAll('.', '\\.')}`,
    ),
    `iOS Capacitor dependency does not match ${expectedVersion}`,
    errors,
  );
  const androidSettings = files['apps/mobile/android/capacitor.settings.gradle'] ?? '';
  requirePattern(
    androidSettings,
    /node_modules\/@capacitor\/android\/capacitor/u,
    'Android project does not use the workspace @capacitor/android dependency',
    errors,
  );
}

export function verifyMobileNativeProjects(files: NativeProjectFiles): string[] {
  const errors: string[] = [];
  for (const path of requiredPaths) content(files, path, errors);

  const config = files['apps/mobile/capacitor.config.ts'] ?? '';
  requirePattern(config, /appId:\s*['"]ru\.padlhub\.app['"]/u, 'Capacitor appId mismatch', errors);
  requirePattern(config, /appName:\s*['"]PadlHub['"]/u, 'Capacitor appName mismatch', errors);
  requirePattern(config, /webDir:\s*['"]dist['"]/u, 'Capacitor webDir mismatch', errors);
  requirePattern(config, /androidScheme:\s*['"]https['"]/u, 'Android scheme must be https', errors);
  requirePattern(config, /contentInset:\s*['"]automatic['"]/u, 'iOS contentInset mismatch', errors);
  if (/\bserver\s*:\s*\{[\s\S]*?\burl\s*:/u.test(config)) {
    errors.push('Capacitor production config contains server.url');
  }

  const xcodeProject = files['apps/mobile/ios/App/App.xcodeproj/project.pbxproj'] ?? '';
  const iosBundleIdentifiers = [
    ...xcodeProject.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/gu),
  ].map((match) => match[1]);
  if (
    iosBundleIdentifiers.length === 0 ||
    iosBundleIdentifiers.some((identifier) => identifier !== expectedAppId)
  ) {
    errors.push('iOS bundle identifier mismatch');
  }
  const infoPlistSettings = xcodeProject
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes('INFOPLIST_FILE'));
  if (
    infoPlistSettings.length === 0 ||
    infoPlistSettings.some((line) => line !== 'INFOPLIST_FILE = App/Info.plist;') ||
    /(?:GENERATE_INFOPLIST_FILE = YES|INFOPLIST_KEY_NSAppTransportSecurity)/u.test(xcodeProject)
  ) {
    errors.push('iOS build configuration does not exclusively use the inspected App/Info.plist');
  }
  for (const [path, value] of Object.entries(files)) {
    if (
      path.endsWith('.xcconfig') &&
      /(?:INFOPLIST_FILE|GENERATE_INFOPLIST_FILE|INFOPLIST_KEY_NSAppTransportSecurity)/u.test(value)
    ) {
      errors.push(`iOS xcconfig overrides inspected Info.plist settings: ${path}`);
    }
  }
  const infoPlist = files['apps/mobile/ios/App/App/Info.plist'] ?? '';
  requirePattern(
    infoPlist,
    /<key>CFBundleDisplayName<\/key>\s*<string>PadlHub<\/string>/u,
    'iOS app name mismatch',
    errors,
  );
  if (
    /<key>(?:NSAllowsArbitraryLoads|NSAllowsArbitraryLoadsInWebContent|NSAllowsArbitraryLoadsForMedia|NSAllowsLocalNetworking)<\/key>\s*<true\s*\/>/u.test(
      infoPlist,
    ) ||
    /<key>(?:NSExceptionDomains|NSExceptionAllowsInsecureHTTPLoads|NSThirdPartyExceptionAllowsInsecureHTTPLoads)<\/key>/u.test(
      infoPlist,
    ) ||
    /<key>NSExceptionMinimumTLSVersion<\/key>\s*<string>TLSv1\.[01]<\/string>/u.test(infoPlist)
  ) {
    errors.push('iOS ATS exception or insecure transport relaxation found');
  }

  const androidBuild = files['apps/mobile/android/app/build.gradle'] ?? '';
  requirePattern(
    androidBuild,
    /namespace\s*=\s*["']ru\.padlhub\.app["']/u,
    'Android namespace mismatch',
    errors,
  );
  requirePattern(
    androidBuild,
    /applicationId\s+["']ru\.padlhub\.app["']/u,
    'Android applicationId mismatch',
    errors,
  );
  const androidStrings = files['apps/mobile/android/app/src/main/res/values/strings.xml'] ?? '';
  requirePattern(
    androidStrings,
    /<string name="app_name">PadlHub<\/string>/u,
    'Android app name mismatch',
    errors,
  );
  const manifest = files['apps/mobile/android/app/src/main/AndroidManifest.xml'] ?? '';
  const manifestPaths = Object.keys(files).filter((path) =>
    /^apps\/mobile\/android\/app\/.*Manifest\.xml$/u.test(path),
  );
  if (
    manifestPaths.length !== 1 ||
    manifestPaths[0] !== 'apps/mobile/android/app/src/main/AndroidManifest.xml'
  ) {
    errors.push('Android build-flavor manifests are not allowed in the native shell');
  }
  const gradleSource = Object.entries(files)
    .filter(([path]) => /^apps\/mobile\/android\/.*\.gradle$/u.test(path))
    .map(([, value]) => value)
    .join('\n');
  if (/(?:\bsourceSets\b|manifest\.srcFiles?\b)/u.test(gradleSource)) {
    errors.push('Android manifest source-set overrides are not allowed in the native shell');
  }
  verifyAndroidApplication(manifest, errors);
  const permissions = [
    ...manifest.matchAll(/<uses-permission\b[^>]*android:name=["']([^"']+)["'][^>]*>/gu),
  ].map((match) => match[1]);
  const unexpectedPermissions = permissions.filter(
    (permission) => permission !== 'android.permission.INTERNET',
  );
  if (unexpectedPermissions.length > 0) {
    errors.push(`unexpected Android permissions: ${unexpectedPermissions.join(', ')}`);
  }
  verifyAndroidComponents(manifest, errors);

  const variables = (files['apps/mobile/android/variables.gradle'] ?? '').replace(/\/\/.*$/gmu, '');
  for (const [name, expected] of [
    ['minSdkVersion', '24'],
    ['compileSdkVersion', '36'],
    ['targetSdkVersion', '36'],
  ] as const) {
    const values = [...variables.matchAll(new RegExp(`${name}\\s*=\\s*(\\d+)`, 'gu'))].map(
      (match) => match[1],
    );
    if (values.length !== 1 || values[0] !== expected) {
      errors.push(`Android ${name} must be pinned to ${expected}`);
    }
  }

  const wrapperProperties =
    files['apps/mobile/android/gradle/wrapper/gradle-wrapper.properties'] ?? '';
  const parsedWrapperProperties = parseProperties(wrapperProperties);
  if (parsedWrapperProperties.invalidLines.length > 0) {
    errors.push(
      `Gradle wrapper properties contain non-canonical lines: ${parsedWrapperProperties.invalidLines.join(', ')}`,
    );
  }
  if (parsedWrapperProperties.duplicates.length > 0) {
    errors.push(
      `Gradle wrapper properties contain duplicate keys: ${parsedWrapperProperties.duplicates.join(', ')}`,
    );
  }
  if (
    parsedWrapperProperties.values.get('distributionUrl') !==
    'https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip'
  ) {
    errors.push('Gradle wrapper distribution version mismatch');
  }
  if (
    parsedWrapperProperties.values.get('distributionSha256Sum') !== expectedGradleDistributionSha256
  ) {
    errors.push('Gradle distribution checksum mismatch');
  }
  if (
    files['apps/mobile/android/gradle/wrapper/gradle-wrapper.jar'] !==
    `binary-sha256:${expectedGradleWrapperJarSha256}`
  ) {
    errors.push('Gradle wrapper JAR checksum mismatch');
  }

  scanRuntimeUrls(files, errors);
  scanCandidatePaths(files, errors);
  scanNativeText(files, errors);
  verifyVersions(files, errors);
  return [...new Set(errors)];
}

function loadRepositoryFiles(root: string): NativeProjectFiles {
  const result = spawnSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'apps/mobile/ios',
      'apps/mobile/android',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git source inventory failed: ${result.stderr.trim()}`);
  }
  const paths = new Set([
    ...requiredPaths,
    ...result.stdout.split('\n').filter((path) => path.length > 0),
  ]);
  return Object.fromEntries(
    [...paths]
      .filter((path) => existsSync(resolve(root, path)))
      .map((path) => {
        const buffer = readFileSync(resolve(root, path));
        return [
          path,
          buffer.includes(0)
            ? `binary-sha256:${createHash('sha256').update(buffer).digest('hex')}`
            : buffer.toString('utf8'),
        ];
      }),
  );
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag === -1 ? process.cwd() : resolve(process.argv[rootFlag + 1] ?? '');
  const errors = verifyMobileNativeProjects(loadRepositoryFiles(root));
  if (errors.length > 0) {
    console.error('MOBILE_NATIVE_PROJECTS_FAILED');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `MOBILE_NATIVE_PROJECTS_PASSED appId=${expectedAppId} appName=${expectedAppName} root=${relative(process.cwd(), root) || '.'}`,
    );
  }
}
