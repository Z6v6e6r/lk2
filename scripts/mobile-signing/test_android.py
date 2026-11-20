"""Synthetic files/tools only: these tests never invoke Gradle, Java or signing."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('offline_android', Path(__file__).with_name('android.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
CERT = '-----BEGIN CERTIFICATE-----\n' + base64.b64encode(b'synthetic-public-cert').decode() + '\n-----END CERTIFICATE-----'
PIN = hashlib.sha256(b'synthetic-public-cert').hexdigest()
MANIFEST = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ru.padlhub.app" android:versionCode="15" android:versionName="1.14"><application android:debuggable="false" /></manifest>'


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.private = self.base / 'private'
        self.private.mkdir(mode=0o700)
        self.root = self.base / 'source'
        self.root.mkdir()
        self.android = self.root / 'apps/mobile/android'
        (self.android / 'gradle/wrapper').mkdir(parents=True)
        self.gradle = self.base / 'gradle'
        (self.gradle / 'bin').mkdir(parents=True)
        (self.gradle / 'bin/gradle').write_text('synthetic')
        archive = self.base / 'gradle.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('gradle-8.14.3/bin/gradle', 'synthetic')
        (self.android / 'gradle/wrapper/gradle-wrapper.properties').write_text('distributionSha256Sum=' + m.sha(archive))
        java = self.base / 'java/bin'
        java.mkdir(parents=True)
        for name in ['java', 'jarsigner', 'keytool']:
            (java / name).write_text('synthetic')
        (self.base / 'sdk').mkdir()
        self.cache = self.private / 'cache'
        self.cache.mkdir(mode=0o700)
        for name in ['store', 'store-pass', 'key-pass']:
            p = self.private / name
            p.write_text('SECRET_NEVER_LOG')
            p.chmod(0o600)
        tool = self.base / 'bundletool.jar'
        tool.write_text('synthetic')
        (self.base / 'node').write_text('synthetic')
        (self.base / 'npm-cli.js').write_text('synthetic')
        self.config = {'schema': 'PHUB_ANDROID_OFFLINE_SIGNING_V1', 'sourceSha': 'a' * 40,
                       'applicationId': 'ru.padlhub.app', 'versionCode': 15, 'versionName': '1.14',
                       'signerSha256': PIN, 'keystore': str(self.private / 'store'), 'alias': 'upload',
                       'storePasswordFile': str(self.private / 'store-pass'),
                       'keyPasswordFile': str(self.private / 'key-pass'),
                       'javaHome': str(java.parent), 'gradleHome': str(self.gradle),
                       'gradleArchive': str(archive), 'sdkHome': str(self.base / 'sdk'),
                       'gradleUserHome': str(self.cache), 'bundletool': str(tool),
                       'bundletoolSha256': m.sha(tool), 'nodeExecutable': str(self.base / 'node'),
                       'npmCli': str(self.base / 'npm-cli.js'), 'output': str(self.private / 'result')}
        self.path = self.private / 'inputs.json'
        self.calls = []
        self.write_config()

    def tearDown(self):
        self.temp.cleanup()

    def write_config(self):
        self.path.write_text(json.dumps(self.config))
        self.path.chmod(0o600)

    def tool(self, args, cwd, env):
        args = [str(a) for a in args]
        self.calls.append(args)
        self.assertNotIn('SECRET_NEVER_LOG', json.dumps(args) + json.dumps(env))
        if '--version' in args:
            return 'v22.20.0'
        if 'rev-parse' in args:
            return 'a' * 40
        if 'status' in args:
            return ''
        if '-list' in args:
            return 'Entry type: PrivateKeyEntry\n' + CERT
        if '-printcert' in args:
            return CERT
        if ':app:bundleRelease' in args:
            aab = self.android / 'app/build/outputs/bundle/release/app-release.aab'
            aab.parent.mkdir(parents=True)
            aab.write_bytes(b'synthetic-signed-bundle')
        if 'dump' in args:
            return MANIFEST
        return ''

    def test_plan_has_no_build_or_output(self):
        result = m.run(str(self.path), self.root, execute=self.tool)
        self.assertFalse(result['signedBuildExecuted'])
        self.assertFalse(Path(self.config['output']).exists())
        self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_build_verifies_and_emits_only_sanitized_receipt(self):
        result = m.run(str(self.path), self.root, True, self.tool)
        out = Path(self.config['output'])
        self.assertEqual(result['artifactSha256'], m.sha(out / 'app-release.aab'))
        self.assertEqual(result['signerSha256'], PIN)
        self.assertNotIn('SECRET_NEVER_LOG', (out / 'receipt.json').read_text())
        self.assertTrue(any('--offline' in c and '--no-configuration-cache' in c
                            and '-Pandroid.builder.sdkDownload=false' in c for c in self.calls))

    def test_wrong_keystore_identity_stops_before_build(self):
        self.config['signerSha256'] = 'b' * 64
        self.write_config()
        with self.assertRaisesRegex(m.Rejected, 'KEYSTORE_SIGNER'):
            m.run(str(self.path), self.root, True, self.tool)
        self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_wrong_bundle_signer_no_receipt(self):
        def tool(args, cwd, env):
            if '-printcert' in args:
                return CERT.replace(base64.b64encode(b'synthetic-public-cert').decode(), base64.b64encode(b'other-cert').decode())
            return self.tool(args, cwd, env)
        with self.assertRaisesRegex(m.Rejected, 'AAB_SIGNER'):
            m.run(str(self.path), self.root, True, tool)
        self.assertFalse(Path(self.config['output']).exists())

    def test_wrong_bundle_manifest_variants(self):
        for old, new in [('ru.padlhub.app', 'foreign.app'), ('versionCode="15"', 'versionCode="14"'),
                         ('versionName="1.14"', 'versionName="1.13"'), ('debuggable="false"', 'debuggable="true"')]:
            with self.subTest(new=new), self.assertRaises(m.Rejected):
                m.validate_manifest(MANIFEST.replace(old, new), self.config)

    def test_signature_failure_no_receipt(self):
        def tool(args, cwd, env):
            if '-verify' in args:
                raise m.Rejected('TOOL_REJECTED')
            return self.tool(args, cwd, env)
        with self.assertRaises(m.Rejected):
            m.run(str(self.path), self.root, True, tool)
        self.assertFalse(Path(self.config['output']).exists())

    def test_distribution_tamper_rejected(self):
        (self.gradle / 'bin/gradle').write_text('tampered')
        with self.assertRaisesRegex(m.Rejected, 'DISTRIBUTION_DRIFT'):
            m.run(str(self.path), self.root, execute=self.tool)

    def test_output_overwrite_and_symlink_rejected(self):
        output = Path(self.config['output'])
        output.mkdir()
        with self.assertRaisesRegex(m.Rejected, 'NEW_OUTPUT'):
            m.run(str(self.path), self.root, execute=self.tool)
        output.rmdir()
        output.symlink_to(self.root)
        with self.assertRaisesRegex(m.Rejected, 'NEW_OUTPUT'):
            m.run(str(self.path), self.root, execute=self.tool)

    def test_public_password_and_symlink_rejected(self):
        p = self.private / 'key-pass'
        p.chmod(0o644)
        with self.assertRaisesRegex(m.Rejected, 'PRIVATE_INPUT'):
            m.run(str(self.path), self.root, execute=self.tool)
        p.unlink()
        p.symlink_to(self.private / 'store-pass')
        with self.assertRaisesRegex(m.Rejected, 'SYMLINK'):
            m.run(str(self.path), self.root, execute=self.tool)

    def test_source_drift_rejected(self):
        def tool(args, cwd, env):
            return 'b' * 40 if 'rev-parse' in args else self.tool(args, cwd, env)
        with self.assertRaisesRegex(m.Rejected, 'SOURCE_DRIFT'):
            m.run(str(self.path), self.root, execute=tool)

    def test_tool_failure_does_not_disclose_stderr(self):
        with patch.object(m.subprocess, 'run', return_value=m.subprocess.CompletedProcess([], 1, b'', b'SECRET_NEVER_LOG')):
            with self.assertRaisesRegex(m.Rejected, '^TOOL_REJECTED$'):
                m.command(['synthetic'], self.root, {})

    def test_tamper_during_verification_no_receipt(self):
        def tool(args, cwd, env):
            result = self.tool(args, cwd, env)
            if 'dump' in args:
                (self.android / 'app/build/outputs/bundle/release/app-release.aab').write_bytes(b'tampered')
            return result
        with self.assertRaisesRegex(m.Rejected, 'ARTIFACT_VERIFY_DRIFT'):
            m.run(str(self.path), self.root, True, tool)
        self.assertFalse(Path(self.config['output']).exists())

    def test_tool_hash_and_old_build_rejected(self):
        self.config['bundletoolSha256'] = 'c' * 64
        self.write_config()
        with self.assertRaisesRegex(m.Rejected, 'BUNDLETOOL_HASH'):
            m.run(str(self.path), self.root, execute=self.tool)
        self.config['bundletoolSha256'] = m.sha(Path(self.config['bundletool']))
        self.write_config()
        old = self.android / 'app/build/outputs/bundle/release/app-release.aab'
        old.parent.mkdir(parents=True)
        old.write_bytes(b'old')
        with self.assertRaisesRegex(m.Rejected, 'OLD_BUILD_OUTPUT'):
            m.run(str(self.path), self.root, True, self.tool)

    def test_lexical_output_escape_rejected_before_build(self):
        for value in [str(self.private) + '/../source/leaked-artifact',
                      str(self.private) + '/./result']:
            with self.subTest(value=value):
                self.config['output'] = value
                self.write_config()
                with self.assertRaisesRegex(m.Rejected, 'LEXICAL_PATH_REJECTED'):
                    m.run(str(self.path), self.root, True, self.tool)
                self.assertFalse((self.root / 'leaked-artifact').exists())
                self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_lexical_input_escape_rejected(self):
        self.config['keystore'] = str(self.private) + '/./store'
        self.write_config()
        with self.assertRaisesRegex(m.Rejected, 'LEXICAL_PATH_REJECTED'):
            m.run(str(self.path), self.root, execute=self.tool)

    def test_signing_material_inside_source_rejected(self):
        private = self.root / 'signing-private'
        private.mkdir(mode=0o700)
        secret = private / 'store'
        secret.write_text('synthetic')
        secret.chmod(0o600)
        self.config['keystore'] = str(secret)
        self.write_config()
        with self.assertRaisesRegex(m.Rejected, 'OUTSIDE_SOURCE_REQUIRED'):
            m.run(str(self.path), self.root, True, self.tool)
        self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_double_leading_slash_output_inside_source_rejected(self):
        self.root.chmod(0o700)
        parent = self.root / 'private-output'
        parent.mkdir(mode=0o700)
        # Same filesystem directory, different lexical anchor.
        self.config['output'] = '/' + str(parent / 'result')
        self.write_config()
        with self.assertRaisesRegex(m.Rejected, 'OUTSIDE_SOURCE_REQUIRED'):
            m.run(str(self.path), self.root, True, self.tool)
        self.assertFalse((parent / 'result').exists())
        self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_double_leading_slash_input_inside_source_rejected(self):
        parent = self.root / 'private-input'
        parent.mkdir(mode=0o700)
        key = parent / 'store'
        key.write_text('synthetic')
        key.chmod(0o600)
        self.config['keystore'] = '/' + str(key)
        self.write_config()
        with self.assertRaisesRegex(m.Rejected, 'OUTSIDE_SOURCE_REQUIRED'):
            m.run(str(self.path), self.root, True, self.tool)
        self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_certificate_only_alias_rejected_before_build(self):
        def tool(args, cwd, env):
            return CERT if '-list' in args else self.tool(args, cwd, env)
        with self.assertRaisesRegex(m.Rejected, 'PRIVATE_KEY_ENTRY'):
            m.run(str(self.path), self.root, True, tool)
        self.assertFalse(any(':app:bundleRelease' in c for c in self.calls))

    def test_source_change_during_build_no_receipt(self):
        reads = 0
        def tool(args, cwd, env):
            nonlocal reads
            if 'rev-parse' in args:
                reads += 1
                return ('a' if reads == 1 else 'b') * 40
            return self.tool(args, cwd, env)
        with self.assertRaisesRegex(m.Rejected, 'SOURCE_CHANGED'):
            m.run(str(self.path), self.root, True, tool)
        self.assertFalse(Path(self.config['output']).exists())

    def test_multiple_certificates_rejected(self):
        with self.assertRaisesRegex(m.Rejected, 'ONE_CERTIFICATE'):
            m.certificate(CERT + CERT)


if __name__ == '__main__':
    unittest.main()
