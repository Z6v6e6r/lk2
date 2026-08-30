import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_PATH = '/usr/bin/git';
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const EXPECTED_UID = process.getuid?.() ?? -1;
const PROTECTED_PATHS = Object.freeze([
  '.github/workflows/pull-request.yaml',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/control-timeweb-operator-node-bootstrap.py',
  'scripts/control-timeweb-yandex-public-beta.js',
  'scripts/control-timeweb-yandex-public-beta.d.ts',
  'scripts/control-timeweb-yandex-public-beta.test.ts',
  'scripts/render-timeweb-beta-release-env.js',
  'scripts/timeweb-release-manifest-contract.js',
  'scripts/verify-timeweb-base-images.js',
  'scripts/strict-json.js',
  'scripts/verify-timeweb-deployment-contract.js',
  'scripts/verify-timeweb-frozen-source.js',
  'deploy/timeweb/base-images.lock.json',
  'deploy/timeweb/operator-node-bootstrap.v1.json',
  'deploy/timeweb/Caddyfile',
  'deploy/timeweb/Caddyfile.yandex-public-beta',
  'deploy/timeweb/compose.beta.yaml',
  'deploy/timeweb/compose.ingress.yaml',
  'deploy/timeweb/github-release-reader.contract.json',
  'deploy/timeweb/release-manifest.schema.json',
  'deploy/timeweb/release-manifest.v1.schema.json',
  'deploy/timeweb/runtime-environment.contract.json',
  'deploy/timeweb/target.json',
  'deploy/timeweb/yandex-public-beta-ingress.json',
  'deploy/timeweb/yandex-public-beta-rollback-floor.json',
  'docs/runbooks/timeweb-lk2-beta.md',
]);
const trustedAuthorities = new WeakSet();

export class TimewebFrozenSourceError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TimewebFrozenSourceError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new TimewebFrozenSourceError(reason);
}

function assertSafeGitArguments(args) {
  const serialized = JSON.stringify(args);
  const fixedRevParse = new Set([
    JSON.stringify(['rev-parse', '--absolute-git-dir']),
    JSON.stringify(['rev-parse', '--git-common-dir']),
    JSON.stringify(['rev-parse', '--show-toplevel']),
    JSON.stringify(['rev-parse', '--verify', 'HEAD']),
    JSON.stringify(['rev-parse', '--verify', 'HEAD^{tree}']),
  ]);
  const verifiedTree =
    args.length === 3 &&
    args[0] === 'rev-parse' &&
    args[1] === '--verify' &&
    SHA_PATTERN.test(args[2]?.replace(/\^\{tree\}$/u, '') ?? '') &&
    args[2].endsWith('^{tree}');
  const protectedTreeEntry =
    args.length === 5 &&
    args[0] === 'ls-tree' &&
    args[1] === '-z' &&
    SHA_PATTERN.test(args[2] ?? '') &&
    args[3] === '--' &&
    PROTECTED_PATHS.includes(args[4]);
  if (!fixedRevParse.has(serialized) && !verifiedTree && !protectedTreeEntry)
    fail('frozen_source_git_command');
}

export function validateTimewebFrozenSourceObservation(observation, expected) {
  if (!SHA_PATTERN.test(expected?.sourceSha ?? '') || !SHA_PATTERN.test(expected?.sourceTree ?? ''))
    fail('frozen_source_expected_identity');
  if (
    observation?.head !== expected.sourceSha ||
    observation?.tree !== expected.sourceTree ||
    observation?.topLevel !== REPOSITORY_ROOT
  )
    fail('frozen_source_identity');
  if (
    observation?.repositoryRoot !== REPOSITORY_ROOT ||
    observation?.repositoryRootSecure !== true ||
    observation?.protectedFilesSecure !== true ||
    observation?.gitMetadataSecure !== true ||
    observation?.protectedFilesMatchTree !== true ||
    observation?.releaseSourcePathSecure !== true
  )
    fail('frozen_source_path_security');
}

export function runTimewebSourceGit(args) {
  assertSafeGitArguments(args);
  return execFileSync(
    GIT_PATH,
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      REPOSITORY_ROOT,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/root',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function secureMetadata(path, kind) {
  const value = lstatSync(path);
  return (
    (kind === 'directory' ? value.isDirectory() : value.isFile()) &&
    !value.isSymbolicLink() &&
    value.uid === EXPECTED_UID &&
    (value.mode & 0o022) === 0 &&
    (kind === 'directory' || value.nlink === 1) &&
    realpathSync(path) === path
  );
}

function optionalSecureMetadata(path, kind) {
  return !existsSync(path) || secureMetadata(path, kind);
}

function exactObjectStorageIsSecure(commonDirectory, objectIds) {
  const objects = resolve(commonDirectory, 'objects');
  if (!secureMetadata(objects, 'directory')) return false;
  if (existsSync(resolve(objects, 'info', 'alternates'))) return false;
  const packDirectory = resolve(objects, 'pack');
  const packFilesSecure =
    !existsSync(packDirectory) ||
    (secureMetadata(packDirectory, 'directory') &&
      readdirSync(packDirectory).every((name) =>
        secureMetadata(resolve(packDirectory, name), 'file'),
      ));
  return (
    packFilesSecure &&
    objectIds.every((objectId) => {
      const loose = resolve(objects, objectId.slice(0, 2), objectId.slice(2));
      return existsSync(loose) ? secureMetadata(loose, 'file') : packFilesSecure;
    })
  );
}

function protectedFilesMatchTree(sourceSha) {
  const objectIds = [];
  for (const relativePath of PROTECTED_PATHS) {
    const entry = runTimewebSourceGit(['ls-tree', '-z', sourceSha, '--', relativePath]);
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0?$/u.exec(entry);
    if (!match || match[3] !== relativePath) return { matches: false, objectIds };
    const bytes = readFileSync(resolve(REPOSITORY_ROOT, relativePath));
    const objectId = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (objectId !== match[2]) return { matches: false, objectIds };
    const executable = (lstatSync(resolve(REPOSITORY_ROOT, relativePath)).mode & 0o111) !== 0;
    if (executable !== (match[1] === '100755')) return { matches: false, objectIds };
    objectIds.push(objectId);
  }
  return { matches: true, objectIds };
}

function releaseSourcePathIsSecure(expectedSourceSha) {
  if (EXPECTED_UID !== 0) return true;
  const escapedSha = expectedSourceSha.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `^/opt/phub/timeweb-beta/releases/${escapedSha}-[1-9][0-9]*-1/source$`,
    'u',
  );
  if (!pattern.test(REPOSITORY_ROOT)) return false;
  for (let path = REPOSITORY_ROOT; path !== '/opt'; path = resolve(path, '..')) {
    if (!secureMetadata(path, 'directory')) return false;
  }
  return secureMetadata('/opt', 'directory');
}

function pathsAreSecure(gitDirectory, commonDirectory, sourceSha, sourceTree) {
  try {
    if (!secureMetadata(REPOSITORY_ROOT, 'directory'))
      return {
        repositoryRootSecure: false,
        protectedFilesSecure: false,
        gitMetadataSecure: false,
        protectedFilesMatchTree: false,
        releaseSourcePathSecure: false,
      };
    const protectedDirectories = new Set();
    const protectedFilesSecure = PROTECTED_PATHS.every((relativePath) => {
      const path = resolve(REPOSITORY_ROOT, relativePath);
      for (let directory = resolve(path, '..'); directory !== REPOSITORY_ROOT;) {
        protectedDirectories.add(directory);
        const parent = resolve(directory, '..');
        if (parent === directory) break;
        directory = parent;
      }
      return secureMetadata(path, 'file');
    });
    const protectedDirectoriesSecure = [...protectedDirectories].every((path) =>
      secureMetadata(path, 'directory'),
    );
    const gitMarker = resolve(REPOSITORY_ROOT, '.git');
    const gitMarkerStat = lstatSync(gitMarker);
    const gitMarkerSecure = gitMarkerStat.isDirectory()
      ? secureMetadata(gitMarker, 'directory')
      : secureMetadata(gitMarker, 'file');
    const matched = protectedFilesMatchTree(sourceSha);
    const gitMetadataSecure =
      gitMarkerSecure &&
      secureMetadata(gitDirectory, 'directory') &&
      secureMetadata(commonDirectory, 'directory') &&
      secureMetadata(resolve(commonDirectory, 'config'), 'file') &&
      secureMetadata(resolve(gitDirectory, 'HEAD'), 'file') &&
      optionalSecureMetadata(resolve(gitDirectory, 'commondir'), 'file') &&
      optionalSecureMetadata(resolve(gitDirectory, 'config.worktree'), 'file') &&
      optionalSecureMetadata(resolve(commonDirectory, 'config.worktree'), 'file') &&
      optionalSecureMetadata(resolve(commonDirectory, 'packed-refs'), 'file') &&
      exactObjectStorageIsSecure(commonDirectory, [sourceSha, sourceTree, ...matched.objectIds]);
    return {
      repositoryRootSecure: true,
      protectedFilesSecure: protectedFilesSecure && protectedDirectoriesSecure,
      gitMetadataSecure,
      protectedFilesMatchTree: matched.matches,
      releaseSourcePathSecure: releaseSourcePathIsSecure(sourceSha),
    };
  } catch {
    return {
      repositoryRootSecure: false,
      protectedFilesSecure: false,
      gitMetadataSecure: false,
      protectedFilesMatchTree: false,
      releaseSourcePathSecure: false,
    };
  }
}

export function assertExactTimewebFrozenSource({ expectedSourceSha, expectedSourceTree }) {
  let observation;
  try {
    const gitDirectory = runTimewebSourceGit(['rev-parse', '--absolute-git-dir']);
    const commonDirectory = resolve(
      REPOSITORY_ROOT,
      runTimewebSourceGit(['rev-parse', '--git-common-dir']),
    );
    observation = {
      repositoryRoot: REPOSITORY_ROOT,
      ...pathsAreSecure(gitDirectory, commonDirectory, expectedSourceSha, expectedSourceTree),
      topLevel: runTimewebSourceGit(['rev-parse', '--show-toplevel']),
      head: runTimewebSourceGit(['rev-parse', '--verify', 'HEAD']),
      tree: runTimewebSourceGit(['rev-parse', '--verify', 'HEAD^{tree}']),
    };
  } catch {
    fail('frozen_source_unavailable');
  }
  validateTimewebFrozenSourceObservation(observation, {
    sourceSha: expectedSourceSha,
    sourceTree: expectedSourceTree,
  });
  const authority = Object.freeze({ sourceSha: expectedSourceSha, sourceTree: expectedSourceTree });
  trustedAuthorities.add(authority);
  return authority;
}

export function requireExactTimewebFrozenSourceAuthority(authority, expected) {
  if (
    !authority ||
    !trustedAuthorities.has(authority) ||
    authority.sourceSha !== expected.sourceSha ||
    authority.sourceTree !== expected.sourceTree
  )
    fail('frozen_source_authority');
}
