"""Opt-in offline AAB signing build. No key creation, imports, uploads or downloads."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile


class Rejected(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Rejected(code)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def lexical_path(value):
    raw = os.fspath(value)
    require(isinstance(raw, str) and raw.startswith('/')
            and not any(part in {'.', '..'} for part in raw.split('/')), 'LEXICAL_PATH_REJECTED')
    return Path(raw)


def path_input(value, private=False, directory=False):
    p = lexical_path(value)
    require(p.is_absolute(), 'ABSOLUTE_PATH_REQUIRED')
    for component in (p, *p.parents):
        require(not component.is_symlink(), 'SYMLINK_REJECTED')
    s = p.stat()
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode), 'PATH_TYPE')
    if private:
        require(s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == (0o700 if directory else 0o600),
                'PRIVATE_INPUT_REQUIRED')
        parent = p.parent.stat()
        require(parent.st_uid == os.getuid() and not parent.st_mode & 0o077, 'PRIVATE_PARENT_REQUIRED')
    return p


def read_config(path):
    p = path_input(path, private=True)
    require(p.stat().st_size < 16384, 'CONFIG_SIZE')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'DUPLICATE_CONFIG_FIELD')
            result[key] = value
        return result
    c = json.loads(p.read_text(), object_pairs_hook=pairs)
    expected = {'schema', 'sourceSha', 'applicationId', 'versionCode', 'versionName',
                'signerSha256', 'keystore', 'alias', 'storePasswordFile', 'keyPasswordFile',
                'javaHome', 'gradleHome', 'gradleArchive', 'sdkHome', 'gradleUserHome',
                'bundletool', 'bundletoolSha256', 'nodeExecutable', 'npmCli', 'output'}
    require(set(c) == expected and c['schema'] == 'PHUB_ANDROID_OFFLINE_SIGNING_V1', 'CONFIG_SHAPE')
    require(all(isinstance(c[k], str) for k in expected - {'versionCode'}), 'CONFIG_TYPES')
    require(re.fullmatch('[a-f0-9]{40}', c['sourceSha']) is not None, 'SOURCE_SHA')
    require(c['applicationId'] == 'ru.padlhub.app', 'APPLICATION_ID')
    require(type(c['versionCode']) is int and 0 < c['versionCode'] < 2100000000, 'VERSION_CODE')
    require(re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}', c['versionName']) is not None, 'VERSION_NAME')
    for key in ['signerSha256', 'bundletoolSha256']:
        require(re.fullmatch('[a-f0-9]{64}', c[key]) is not None, 'EXPECTED_HASH')
    require(re.fullmatch('[A-Za-z0-9_.-]{1,100}', c['alias']) is not None, 'ALIAS')
    return c, p


def validate_gradle_distribution(home, archive):
    # The pinned ZIP must describe the actual existing executable/libs, not a decoy archive.
    with zipfile.ZipFile(archive) as bundle:
        files = [entry for entry in bundle.infolist() if not entry.is_dir()]
        require(files and len(files) < 10000, 'GRADLE_DISTRIBUTION')
        prefixes = set()
        expected = set()
        for entry in files:
            parts = Path(entry.filename).parts
            require(len(parts) > 1 and '..' not in parts and not entry.filename.startswith('/'),
                    'GRADLE_DISTRIBUTION')
            prefixes.add(parts[0])
            relative = Path(*parts[1:])
            expected.add(str(relative))
            actual = path_input(str(home / relative))
            with bundle.open(entry) as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            require(sha(actual) == digest, 'GRADLE_DISTRIBUTION_DRIFT')
        require(len(prefixes) == 1 and 'bin/gradle' in expected, 'GRADLE_DISTRIBUTION')
        require({str(x.relative_to(home)) for x in home.rglob('*') if x.is_file()} == expected,
                'GRADLE_EXTRA_FILES')


def command(args, cwd, env):
    try:
        result = subprocess.run([str(x) for x in args], cwd=cwd, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=900, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Rejected('TOOL_EXECUTION_FAILED') from None
    # Never disclose tool output: Gradle/keytool may include signing paths or secrets.
    require(result.returncode == 0, 'TOOL_REJECTED')
    require(len(result.stdout) < 8 * 1024 * 1024, 'TOOL_OUTPUT_LIMIT')
    return result.stdout.decode('utf-8', errors='strict')


def certificate(text):
    blocks = re.findall(r'-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----', text)
    require(len(blocks) == 1, 'ONE_CERTIFICATE_REQUIRED')
    try:
        return hashlib.sha256(base64.b64decode(re.sub(r'\s+', '', blocks[0]), validate=True)).hexdigest()
    except ValueError:
        raise Rejected('CERTIFICATE_ENCODING') from None


def validate_manifest(text, c):
    require('<!DOCTYPE' not in text and '<!ENTITY' not in text, 'MANIFEST_XML')
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        raise Rejected('MANIFEST_XML') from None
    ns = '{http://schemas.android.com/apk/res/android}'
    require(root.tag == 'manifest' and root.get('package') == c['applicationId'], 'BUNDLE_IDENTITY')
    require(root.get(ns + 'versionCode') == str(c['versionCode']) and
            root.get(ns + 'versionName') == c['versionName'], 'BUNDLE_VERSION')
    apps = root.findall('application')
    require(len(apps) == 1 and apps[0].get(ns + 'debuggable', 'false') == 'false'
            and apps[0].get(ns + 'testOnly', 'false') == 'false', 'RELEASE_MANIFEST')


def outside_source(path, root):
    # Filesystem identity, not spelling: POSIX // and case-insensitive aliases can
    # name the same checkout while pathlib's lexical parents compare differently.
    for ancestor in (path, *path.parents):
        if ancestor.exists():
            require(not os.path.samefile(root, ancestor), 'OUTSIDE_SOURCE_REQUIRED')


def prepare_output(value, root):
    p = lexical_path(value)
    require(p.is_absolute() and not p.exists() and not p.is_symlink(), 'NEW_OUTPUT_REQUIRED')
    parent = path_input(str(p.parent), private=True, directory=True)
    outside_source(parent, root)
    return p


def run(config_path, root, build=False, execute=command):
    c, config = read_config(config_path)
    root = path_input(str(root), directory=True)
    out = prepare_output(c['output'], root)
    paths = {k: path_input(c[k], private=True) for k in
             ['keystore', 'storePasswordFile', 'keyPasswordFile']}
    for key in ['storePasswordFile', 'keyPasswordFile']:
        require(paths[key].stat().st_size <= 8192, 'PASSWORD_FILE_SIZE')
        password = paths[key].read_text(encoding='utf-8')
        password = password[:-2] if password.endswith('\r\n') else password[:-1] if password.endswith('\n') else password
        require(password and '\n' not in password and '\r' not in password and '\x00' not in password,
                'PASSWORD_FILE_SHAPE')
    for key in ['javaHome', 'gradleHome', 'sdkHome']:
        paths[key] = path_input(c[key], directory=True)
    paths['gradleUserHome'] = path_input(c['gradleUserHome'], private=True, directory=True)
    for private in [config, paths['keystore'], paths['storePasswordFile'], paths['keyPasswordFile'],
                    paths['gradleUserHome']]:
        outside_source(private, root)
    tool = path_input(c['bundletool'])
    require(sha(tool) == c['bundletoolSha256'], 'BUNDLETOOL_HASH')
    # Use an existing local distribution, never the potentially downloading wrapper.
    gradle = path_input(str(paths['gradleHome'] / 'bin/gradle'))
    archive = path_input(c['gradleArchive'])
    props = (root / 'apps/mobile/android/gradle/wrapper/gradle-wrapper.properties').read_text()
    expected = re.search(r'^distributionSha256Sum=([a-f0-9]{64})$', props, re.M)
    require(expected is not None and sha(archive) == expected[1], 'GRADLE_ARCHIVE_HASH')
    validate_gradle_distribution(paths['gradleHome'], archive)
    node = path_input(c['nodeExecutable'])
    npm_cli = path_input(c['npmCli'])
    env = {'PATH': str(node.parent) + ':' + str(paths['javaHome'] / 'bin') + ':/usr/bin:/bin', 'LANG': 'C',
           'JAVA_HOME': str(paths['javaHome']), 'ANDROID_HOME': str(paths['sdkHome']),
           'ANDROID_SDK_ROOT': str(paths['sdkHome']), 'GRADLE_USER_HOME': str(paths['gradleUserHome'])}
    require(re.fullmatch(r'v22\.[0-9]+\.[0-9]+', execute([node, '--version'], root, env).strip()) is not None, 'NODE_VERSION')
    require(execute(['/usr/bin/git', 'rev-parse', 'HEAD'], root, env).strip() == c['sourceSha'], 'SOURCE_DRIFT')
    require(not execute(['/usr/bin/git', 'status', '--porcelain', '--untracked-files=all'], root, env).strip(),
            'SOURCE_NOT_CLEAN')
    keytool = path_input(str(paths['javaHome'] / 'bin/keytool'))
    cert = execute([keytool, '-list', '-rfc', '-keystore', paths['keystore'], '-alias', c['alias'],
                    '-storepass:file', paths['storePasswordFile']], root, env)
    require('Entry type: PrivateKeyEntry' in cert, 'PRIVATE_KEY_ENTRY_REQUIRED')
    require(certificate(cert) == c['signerSha256'], 'KEYSTORE_SIGNER_MISMATCH')
    if not build:
        return {'schema': 'PHUB_ANDROID_SIGNING_PLAN_V1', 'sourceSha': c['sourceSha'],
                'signerSha256': c['signerSha256'], 'status': 'READY_FOR_EXPLICIT_BUILD',
                'signedBuildExecuted': False}
    # Existing repo preparation only; no install, provider or keychain commands.
    execute([node, npm_cli, 'run', 'android:sync', '--workspace', '@phub/mobile'], root, env)
    env['PHUB_ANDROID_SIGNING_INPUTS'] = str(config)
    android = root / 'apps/mobile/android'
    aab = android / 'app/build/outputs/bundle/release/app-release.aab'
    require(not aab.exists(), 'OLD_BUILD_OUTPUT_REJECTED')
    execute([gradle, '--offline', '--no-daemon', '--no-configuration-cache', '--console=plain',
             '-Pandroid.builder.sdkDownload=false', ':app:bundleRelease'], android, env)
    path_input(str(aab))
    built_hash = sha(aab)
    jarsigner = path_input(str(paths['javaHome'] / 'bin/jarsigner'))
    execute([jarsigner, '-verify', '-strict', '-keystore', paths['keystore'],
             '-storepass:file', paths['storePasswordFile'], aab], root, env)
    actual_cert = execute([keytool, '-printcert', '-rfc', '-jarfile', aab], root, env)
    require(certificate(actual_cert) == c['signerSha256'], 'AAB_SIGNER_MISMATCH')
    manifest = execute([paths['javaHome'] / 'bin/java', '-jar', tool, 'dump', 'manifest',
                        '--bundle=' + str(aab), '--module=base'], root, env)
    validate_manifest(manifest, c)
    require(execute(['/usr/bin/git', 'rev-parse', 'HEAD'], root, env).strip() == c['sourceSha']
            and not execute(['/usr/bin/git', 'status', '--porcelain', '--untracked-files=all'], root, env).strip(),
            'SOURCE_CHANGED_DURING_BUILD')
    # Receipt is emitted only after validation; never copy keystores/passwords or raw tool output.
    require(sha(aab) == built_hash, 'ARTIFACT_VERIFY_DRIFT')
    out.mkdir(mode=0o700)
    target = out / 'app-release.aab'
    with open(aab, 'rb') as src, open(target, 'xb') as dest:
        os.chmod(target, 0o600)
        shutil.copyfileobj(src, dest)
    require(sha(target) == built_hash and sha(aab) == built_hash, 'ARTIFACT_COPY_DRIFT')
    receipt = {'schema': 'PHUB_ANDROID_OFFLINE_SIGNED_AAB_V1', 'sourceSha': c['sourceSha'],
               'artifactSha256': sha(target), 'signerSha256': c['signerSha256'],
               'applicationId': c['applicationId'], 'versionCode': c['versionCode'],
               'versionName': c['versionName'], 'storeUploadPerformed': False,
               'deviceAcceptance': 'NOT_RUN'}
    with open(out / 'receipt.json', 'x') as stream:
        os.chmod(out / 'receipt.json', 0o600)
        json.dump(receipt, stream, sort_keys=True)
        stream.write('\n')
    return receipt


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 3 and sys.argv[1] in ['--plan', '--build-offline'], 'ARGUMENTS')
        result = run(sys.argv[2], Path(__file__).resolve().parents[2], sys.argv[1] == '--build-offline')
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        print(json.dumps({'status': 'STOP', 'code': str(error) if isinstance(error, Rejected)
                          else 'SIGNING_INPUT_OR_TOOL_FAILED', 'automaticRetry': False}))
        sys.exit(1)
