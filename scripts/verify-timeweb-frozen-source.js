import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_PATH = '/usr/bin/git';
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const EXPECTED_UID = process.getuid?.() ?? -1;
const PROTECTED_PATHS = Object.freeze([
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/render-timeweb-beta-release-env.js',
  'scripts/timeweb-release-manifest-contract.js',
  'scripts/verify-timeweb-base-images.js',
  'scripts/strict-json.js',
  'scripts/verify-timeweb-deployment-contract.js',
  'scripts/verify-timeweb-frozen-source.js',
  'deploy/timeweb/base-images.lock.json',
  'deploy/timeweb/Caddyfile',
  'deploy/timeweb/compose.beta.yaml',
  'deploy/timeweb/compose.ingress.yaml',
  'deploy/timeweb/release-manifest.schema.json',
  'deploy/timeweb/release-manifest.v1.schema.json',
  'deploy/timeweb/runtime-environment.contract.json',
  'deploy/timeweb/target.json',
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

export function validateTimewebFrozenSourceObservation(observation, expected) {
  if (!SHA_PATTERN.test(expected?.sourceSha ?? '') || !SHA_PATTERN.test(expected?.sourceTree ?? ''))
    fail('frozen_source_expected_identity');
  if (
    observation?.repositoryRoot !== REPOSITORY_ROOT ||
    observation?.repositoryRootSecure !== true ||
    observation?.protectedFilesSecure !== true ||
    observation?.gitDirectorySecure !== true
  )
    fail('frozen_source_path_security');
  if (
    observation.head !== expected.sourceSha ||
    observation.tree !== expected.sourceTree ||
    observation.topLevel !== REPOSITORY_ROOT
  )
    fail('frozen_source_identity');
  if (observation.status !== '') fail('frozen_source_dirty');
}

function readGit(...args) {
  return execFileSync(GIT_PATH, ['-C', REPOSITORY_ROOT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/root',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function pathsAreSecure(gitDirectory) {
  try {
    if (!secureMetadata(REPOSITORY_ROOT, 'directory'))
      return {
        repositoryRootSecure: false,
        protectedFilesSecure: false,
        gitDirectorySecure: false,
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
    return {
      repositoryRootSecure: true,
      protectedFilesSecure: protectedFilesSecure && protectedDirectoriesSecure,
      gitDirectorySecure: secureMetadata(gitDirectory, 'directory'),
    };
  } catch {
    return {
      repositoryRootSecure: false,
      protectedFilesSecure: false,
      gitDirectorySecure: false,
    };
  }
}

export function assertExactTimewebFrozenSource({ expectedSourceSha, expectedSourceTree }) {
  let observation;
  try {
    const gitDirectory = readGit('rev-parse', '--absolute-git-dir');
    observation = {
      repositoryRoot: REPOSITORY_ROOT,
      ...pathsAreSecure(gitDirectory),
      topLevel: readGit('rev-parse', '--show-toplevel'),
      head: readGit('rev-parse', '--verify', 'HEAD'),
      tree: readGit('rev-parse', '--verify', 'HEAD^{tree}'),
      status: readGit('status', '--porcelain=v1', '--untracked-files=all'),
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
