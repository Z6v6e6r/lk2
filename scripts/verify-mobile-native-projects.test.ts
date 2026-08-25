import { describe, expect, it } from 'vitest';

import { verifyMobileNativeProjects } from './verify-mobile-native-projects.js';

const version = '8.4.1';
const gradleDistributionSha256 = 'ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c';
const gradleWrapperJarSha256 = '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172';

function validFixture(): Record<string, string> {
  return {
    'apps/mobile/capacitor.config.ts': `export default {
      appId: 'ru.padlhub.app', appName: 'PadlHub', webDir: 'dist',
      server: { androidScheme: 'https' }, ios: { contentInset: 'automatic' }
    };`,
    'apps/mobile/package.json': JSON.stringify({
      dependencies: { '@capacitor/core': version },
      devDependencies: {
        '@capacitor/cli': version,
        '@capacitor/ios': version,
        '@capacitor/android': version,
      },
    }),
    'package-lock.json': JSON.stringify({
      packages: Object.fromEntries(
        ['core', 'cli', 'ios', 'android'].map((name) => [
          `node_modules/@capacitor/${name}`,
          { version },
        ]),
      ),
    }),
    'apps/mobile/ios/App/App.xcodeproj/project.pbxproj':
      'PRODUCT_BUNDLE_IDENTIFIER = ru.padlhub.app;\nINFOPLIST_FILE = App/Info.plist;\nIPHONEOS_DEPLOYMENT_TARGET = 15.0;',
    'apps/mobile/ios/App/App/Info.plist': '<key>CFBundleDisplayName</key><string>PadlHub</string>',
    'apps/mobile/ios/App/App/AppDelegate.swift': 'import UIKit',
    'apps/mobile/ios/App/CapApp-SPM/Package.swift': `.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "${version}")`,
    'apps/mobile/android/app/build.gradle': `namespace = "ru.padlhub.app"
      applicationId "ru.padlhub.app"
      implementation project(':capacitor-android')`,
    'apps/mobile/android/app/src/main/AndroidManifest.xml':
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:allowBackup="false" android:usesCleartextTraffic="false"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter></activity><provider android:name="fixture.Provider" android:exported="false" /></application><uses-permission android:name="android.permission.INTERNET" /></manifest>',
    'apps/mobile/android/app/src/main/res/values/strings.xml':
      '<resources><string name="app_name">PadlHub</string></resources>',
    'apps/mobile/android/capacitor.settings.gradle':
      "project(':capacitor-android').projectDir = new File('../../../node_modules/@capacitor/android/capacitor')",
    'apps/mobile/android/gradle/wrapper/gradle-wrapper.jar': `binary-sha256:${gradleWrapperJarSha256}`,
    'apps/mobile/android/gradle/wrapper/gradle-wrapper.properties': `distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip\ndistributionSha256Sum=${gradleDistributionSha256}`,
    'apps/mobile/android/variables.gradle':
      'minSdkVersion = 24\ncompileSdkVersion = 36\ntargetSdkVersion = 36',
  };
}

function expectRejected(
  mutate: (fixture: Record<string, string>) => void,
  expectedMessage: string,
): void {
  const fixture = validFixture();
  mutate(fixture);
  expect(verifyMobileNativeProjects(fixture)).toContain(expectedMessage);
}

describe('mobile native source verifier', () => {
  it('accepts a minimal reproducible native project fixture', () => {
    expect(verifyMobileNativeProjects(validFixture())).toEqual([]);
  });

  it('rejects a wrong iOS bundle identifier', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App.xcodeproj/project.pbxproj'] =
        'PRODUCT_BUNDLE_IDENTIFIER = example.fixture;';
    }, 'iOS bundle identifier mismatch');
  });

  it('rejects a wrong Android application identifier', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/build.gradle'] =
        'namespace = "example.fixture"\napplicationId "example.fixture"';
    }, 'Android applicationId mismatch');
  });

  it('rejects a production server URL', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/capacitor.config.ts'] = fixture[
        'apps/mobile/capacitor.config.ts'
      ]!.replace('server: {', "server: { url: 'https://fixture.invalid',");
    }, 'Capacitor production config contains server.url');
  });

  it('rejects Android cleartext traffic', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] =
        '<application android:usesCleartextTraffic="true" />';
    }, 'Android cleartext traffic must be explicitly disabled on the application node');
  });

  it('rejects resource-indirected Android cleartext traffic', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] = fixture[
        'apps/mobile/android/app/src/main/AndroidManifest.xml'
      ]!.replace(
        '<application ',
        '<application android:usesCleartextTraffic="@bool/fixture_cleartext" ',
      );
    }, 'Android cleartext traffic must be explicitly disabled on the application node');
  });

  it('rejects an absent explicit Android cleartext boundary', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] = fixture[
        'apps/mobile/android/app/src/main/AndroidManifest.xml'
      ]!.replace(' android:usesCleartextTraffic="false"', '');
    }, 'Android cleartext traffic must be explicitly disabled on the application node');
  });

  it('rejects a custom Android network security config', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] = fixture[
        'apps/mobile/android/app/src/main/AndroidManifest.xml'
      ]!.replace(
        '<application ',
        '<application android:networkSecurityConfig="@xml/network_security_config" ',
      );
    }, 'Android custom network security config is not allowed in the native shell');
  });

  it('rejects Android backup for the auth-bearing WebView shell', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] = fixture[
        'apps/mobile/android/app/src/main/AndroidManifest.xml'
      ]!.replace('android:allowBackup="false"', 'android:allowBackup="true"');
    }, 'Android backup must be explicitly disabled on the application node');
  });

  it('rejects resource-indirected backup and ignores a safe value in a comment', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] =
        `<!-- android:allowBackup="false" -->${fixture[
          'apps/mobile/android/app/src/main/AndroidManifest.xml'
        ]!.replace('android:allowBackup="false"', 'android:allowBackup="@bool/fixture_backup"')}`;
    }, 'Android backup must be explicitly disabled on the application node');
  });

  it('rejects a permissive Android network security config', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/res/xml/network_security_config.xml'] =
        '<base-config cleartextTrafficPermitted="true" />';
    }, 'Android network security config allows or indirection-controls cleartext traffic');
  });

  it('rejects permissive iOS ATS', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/Info.plist'] += '<key>NSAllowsArbitraryLoads</key><true/>';
    }, 'iOS ATS exception or insecure transport relaxation found');
  });

  it('rejects iOS web-content ATS arbitrary loads', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/Info.plist'] +=
        '<key>NSAllowsArbitraryLoadsInWebContent</key><true/>';
    }, 'iOS ATS exception or insecure transport relaxation found');
  });

  it('rejects iOS ATS exception domains', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/Info.plist'] +=
        '<key>NSExceptionDomains</key><dict><key>fixture.invalid</key><dict /></dict>';
    }, 'iOS ATS exception or insecure transport relaxation found');
  });

  it('rejects an alternate or build-setting-generated iOS Info.plist', () => {
    const fixture = validFixture();
    fixture['apps/mobile/ios/App/App.xcodeproj/project.pbxproj'] = fixture[
      'apps/mobile/ios/App/App.xcodeproj/project.pbxproj'
    ]!.replace('INFOPLIST_FILE = App/Info.plist;', 'INFOPLIST_FILE = App/Fixture.plist;');
    fixture['apps/mobile/ios/App/App/Fixture.plist'] = '<key>NSAllowsArbitraryLoads</key><true/>';
    expect(verifyMobileNativeProjects(fixture)).toContain(
      'iOS build configuration does not exclusively use the inspected App/Info.plist',
    );

    fixture['apps/mobile/ios/App/App.xcodeproj/project.pbxproj'] +=
      ' INFOPLIST_KEY_NSAppTransportSecurity_NSAllowsArbitraryLoads = YES;';
    expect(verifyMobileNativeProjects(fixture)).toContain(
      'iOS build configuration does not exclusively use the inspected App/Info.plist',
    );
  });

  it('rejects a conditional iOS Info.plist build setting', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App.xcodeproj/project.pbxproj'] +=
        ' "INFOPLIST_FILE[sdk=iphoneos*]" = App/Fixture.plist;';
    }, 'iOS build configuration does not exclusively use the inspected App/Info.plist');
  });

  it('rejects signing configuration without embedding a real secret', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/build.gradle'] +=
        '\nsigningConfig fixtureOnly\nstorePassword = "fixture-only"';
    }, 'signing credential, provisioning profile, keystore, or Development Team configuration found');
  });

  it('rejects a secret-like native field with a fixture-only value', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/AppDelegate.swift'] = 'let apiKey = "fixture-only"';
    }, 'secret-like value found in native source');
  });

  it('rejects an unexpected device permission', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] +=
        '<uses-permission android:name="android.permission.CAMERA" />';
    }, 'unexpected Android permissions: android.permission.CAMERA');
  });

  it('rejects an unexpected exported Android service', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] +=
        '<service android:name=".FixtureService" android:exported="true" />';
    }, 'Android service .FixtureService must be explicitly non-exported');
  });

  it('rejects an Android component without an explicit non-exported boundary', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/AndroidManifest.xml'] +=
        '<receiver android:name=".FixtureReceiver" />';
    }, 'Android receiver .FixtureReceiver must be explicitly non-exported');
  });

  it('rejects an unexpected iOS device permission', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/Info.plist'] +=
        '<key>NSCameraUsageDescription</key><string>fixture only</string>';
    }, 'unexpected iOS device permission or push entitlement found');
  });

  it('rejects a custom deep-link scheme', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/Info.plist'] += '<key>CFBundleURLTypes</key>';
    }, 'deep link, custom URL scheme, Universal Link, or App Link configuration found');
  });

  it('rejects a machine-local absolute path', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/AppDelegate.swift'] =
        'let fixturePath = "/Users/fixture/native"';
    }, 'machine-local absolute path found in native source');
  });

  it('rejects a hardcoded runtime host outside platform metadata', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/ios/App/App/AppDelegate.swift'] =
        'let origin = "https://fixture.invalid"';
    }, 'hardcoded runtime URL in apps/mobile/ios/App/App/AppDelegate.swift: https://fixture.invalid');
  });

  it('rejects a hardcoded host in another Android runtime source file', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/main/java/fixture/RuntimeConfig.java'] =
        'final String origin = "https://fixture.invalid";';
    }, 'hardcoded runtime URL in apps/mobile/android/app/src/main/java/fixture/RuntimeConfig.java: https://fixture.invalid');
  });

  it('rejects an Android build-flavor manifest', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/src/debug/AndroidManifest.xml'] =
        '<manifest><application android:usesCleartextTraffic="true" /></manifest>';
    }, 'Android build-flavor manifests are not allowed in the native shell');
  });

  it('rejects a Gradle manifest source-set override', () => {
    const fixture = validFixture();
    fixture['apps/mobile/android/app/build.gradle'] +=
      "\nsourceSets { main.manifest.srcFile 'config/Manifest.xml' }";
    fixture['apps/mobile/android/app/config/Manifest.xml'] =
      '<manifest><application android:allowBackup="true" /></manifest>';
    expect(verifyMobileNativeProjects(fixture)).toEqual(
      expect.arrayContaining([
        'Android build-flavor manifests are not allowed in the native shell',
        'Android manifest source-set overrides are not allowed in the native shell',
      ]),
    );
  });

  it('rejects Google Services configuration in the no-push shell', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/google-services.json'] = '{"project_info":{}}';
    }, 'machine-local or build output is source-controlled: apps/mobile/android/app/google-services.json');
  });

  it('rejects source-controlled native build outputs', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/app/build/outputs/app-debug.apk'] = '';
    }, 'machine-local or build output is source-controlled: apps/mobile/android/app/build/outputs/app-debug.apk');
  });

  it('rejects a platform dependency version drift', () => {
    expectRejected((fixture) => {
      const mobilePackage = JSON.parse(fixture['apps/mobile/package.json']!) as {
        devDependencies: Record<string, string>;
      };
      mobilePackage.devDependencies['@capacitor/ios'] = '8.4.0';
      fixture['apps/mobile/package.json'] = JSON.stringify(mobilePackage);
    }, 'workspace Capacitor package versions are missing or inconsistent');
  });

  it('rejects an Android SDK target downgrade', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/variables.gradle'] =
        'minSdkVersion = 24\ncompileSdkVersion = 36\ntargetSdkVersion = 27';
    }, 'Android targetSdkVersion must be pinned to 36');
  });

  it('rejects a Gradle distribution or wrapper JAR checksum drift', () => {
    const fixture = validFixture();
    fixture['apps/mobile/android/gradle/wrapper/gradle-wrapper.properties'] =
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip\ndistributionSha256Sum=fixture-only';
    fixture['apps/mobile/android/gradle/wrapper/gradle-wrapper.jar'] = 'binary-sha256:fixture-only';
    expect(verifyMobileNativeProjects(fixture)).toEqual(
      expect.arrayContaining([
        'Gradle distribution checksum mismatch',
        'Gradle wrapper JAR checksum mismatch',
      ]),
    );
  });

  it('rejects duplicate Gradle wrapper security properties', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/gradle/wrapper/gradle-wrapper.properties'] +=
        '\ndistributionUrl=https\\://fixture.invalid/gradle.zip';
    }, 'Gradle wrapper properties contain duplicate keys: distributionUrl');
  });

  it('rejects whitespace-delimited or escaped Gradle wrapper properties', () => {
    expectRejected((fixture) => {
      fixture['apps/mobile/android/gradle/wrapper/gradle-wrapper.properties'] +=
        '\ndistributionUrl https\\://fixture.invalid/gradle.zip';
    }, 'Gradle wrapper properties contain non-canonical lines: distributionUrl https\\://fixture.invalid/gradle.zip');
  });
});
