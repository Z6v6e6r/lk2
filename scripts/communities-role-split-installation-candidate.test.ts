import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCommunitiesRoleSplitInstallationCandidate,
  type CommunitiesRoleSplitInstallationCandidate,
  verifyCommunitiesRoleSplitInstallationCandidate,
} from './prepare-communities-role-split-installation-candidate.js';

const sourcePaths = [
  'deploy/jetson/prepare-communities-role-split-inventory-clone.sh',
  'deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh',
  'deploy/jetson/cleanup-communities-role-split-restore-marker-clone.sh',
  'deploy/jetson/verify-postgres-backup-restore.sh',
] as const;

function git(repository: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TMPDIR: tmpdir(),
    },
  }).trim();
}

function candidatePath(parent: string, sha: string): string {
  return join(parent, `communities-role-split-installation-candidate-${sha}`);
}

describe('communities role-split installation candidate', () => {
  let temporaryRoots: string[];
  let repository: string;
  let candidateSha: string;

  beforeEach(() => {
    temporaryRoots = [];
    repository = realpathSync(mkdtempSync(join(tmpdir(), 'phub-role-split-installation-source-')));
    temporaryRoots.push(repository);
    git(repository, ['init', '--quiet']);
    git(repository, ['remote', 'add', 'origin', 'https://github.com/Z6v6e6r/lk2.git']);
    git(repository, ['config', 'user.name', 'Candidate Test']);
    git(repository, ['config', 'user.email', 'candidate-test@example.invalid']);
    for (const [index, sourcePath] of sourcePaths.entries()) {
      const absolutePath = join(repository, sourcePath);
      mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
      writeFileSync(absolutePath, `#!/bin/sh\n# fixture ${index}\nexit 1\n`, { mode: 0o600 });
      chmodSync(absolutePath, 0o755);
    }
    git(repository, ['add', ...sourcePaths]);
    git(repository, ['commit', '--quiet', '-m', 'fixture']);
    candidateSha = git(repository, ['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    for (const root of temporaryRoots.reverse()) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function privateParent(prefix: string): string {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temporaryRoots.push(parent);
    return parent;
  }

  it('builds deterministic exact-commit bytes with every authority false', () => {
    const firstParent = privateParent('phub-role-split-installation-first-');
    const secondParent = privateParent('phub-role-split-installation-second-');
    const first = candidatePath(firstParent, candidateSha);
    const second = candidatePath(secondParent, candidateSha);

    writeFileSync(join(repository, sourcePaths[1]), '#!/bin/sh\n# dirty worktree\nexit 0\n');
    const firstResult = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: first,
    });
    const secondResult = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: second,
    });

    expect(firstResult).toEqual(secondResult);
    expect(readFileSync(join(first, 'installation-candidate.json'))).toEqual(
      readFileSync(join(second, 'installation-candidate.json')),
    );
    const manifest = JSON.parse(
      readFileSync(join(first, 'installation-candidate.json'), 'utf8'),
    ) as CommunitiesRoleSplitInstallationCandidate;
    expect(manifest.status).toBe('REVIEW_ONLY');
    expect(manifest.installable).toBe(false);
    expect(Object.values(manifest.authorizes)).toEqual(Array(11).fill(false));
    expect(manifest.forcedCommandSurface).toEqual({
      principal: 'phub-preflight',
      options: ['restrict'],
      command: '/usr/local/libexec/phub/run-communities-role-split-restore-marker-ceremony.sh',
      publicKeyIncluded: false,
      authorizedKeysMutationIncluded: false,
      status: 'NOT_PROVISIONED',
      cleanupCommandExposure: 'ADMIN_RECONCILIATION_ONLY',
    });
    expect(manifest.unresolvedBindings.map(({ code }) => code)).toEqual([
      'CLONE_ONLY_CONNECTION_FACTORY',
      'CLUSTER_DDL_FENCE',
      'DEDICATED_FORCED_COMMAND_PUBLIC_KEY',
      'INDEPENDENT_EVIDENCE_SINK',
      'OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS',
      'PG_RESTORE_EXECUTABLE_SHA256',
      'RESTORE_LOGIN_ROLE',
      'SOURCE_WRITE_DENIAL_ATTESTATION',
      'STAGING_KNOWN_HOSTS_PIN',
    ]);
    expect(manifest.payloadFiles.map(({ action }) => action)).toEqual([
      'INSTALL_NEW',
      'INSTALL_NEW',
      'INSTALL_NEW',
      'VERIFY_EXISTING',
    ]);
    expect(
      readFileSync(
        join(
          first,
          'payload/usr/local/libexec/phub/run-communities-role-split-restore-marker-ceremony.sh',
        ),
        'utf8',
      ),
    ).toBe('#!/bin/sh\n# fixture 1\nexit 1\n');
    expect(
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: first,
      }),
    ).toEqual(firstResult);
  });

  it('rejects payload tampering and additional files', () => {
    const parent = privateParent('phub-role-split-installation-tamper-');
    const candidate = candidatePath(parent, candidateSha);
    buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const payload = join(
      candidate,
      'payload/usr/local/libexec/phub/run-communities-role-split-restore-marker-ceremony.sh',
    );
    writeFileSync(payload, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_PAYLOAD_INVALID');

    writeFileSync(payload, '#!/bin/sh\n# fixture 1\nexit 1\n', { mode: 0o600 });
    writeFileSync(join(candidate, 'unexpected'), 'unexpected', { mode: 0o600 });
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_FILE_SET_INVALID');

    rmSync(join(candidate, 'unexpected'));
    mkdirSync(join(candidate, 'unexpected-empty-directory'), { mode: 0o700 });
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_FILE_SET_INVALID');
  });

  it('rejects manifest self-authorization even when payload bytes are intact', () => {
    const parent = privateParent('phub-role-split-installation-manifest-');
    const candidate = candidatePath(parent, candidateSha);
    buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const manifestPath = join(candidate, 'installation-candidate.json');
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as CommunitiesRoleSplitInstallationCandidate;
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, installable: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_MANIFEST_INVALID');
  });

  it('requires a private parent and refuses existing or symlink output', () => {
    const publicParent = privateParent('phub-role-split-installation-public-');
    chmodSync(publicParent, 0o755);
    expect(() =>
      buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        outputPath: candidatePath(publicParent, candidateSha),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_PARENT_INVALID');

    const privateRoot = privateParent('phub-role-split-installation-existing-');
    const existing = candidatePath(privateRoot, candidateSha);
    mkdirSync(existing, { mode: 0o700 });
    expect(() =>
      buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        outputPath: existing,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_EXISTS');

    rmSync(existing, { recursive: true });
    symlinkSync(repository, existing);
    expect(() =>
      buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        outputPath: existing,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_EXISTS');
  });

  it('requires an independently supplied exact commit pin', () => {
    const parent = privateParent('phub-role-split-installation-pin-');
    const candidate = candidatePath(parent, candidateSha);
    buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha: '0'.repeat(40),
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_GIT_FAILED');
  });

  it('rejects a non-executable candidate source entry', () => {
    chmodSync(join(repository, sourcePaths[0]), 0o644);
    git(repository, ['add', sourcePaths[0]]);
    git(repository, ['commit', '--quiet', '-m', 'remove executable mode']);
    const nonExecutableSha = git(repository, ['rev-parse', 'HEAD']);
    const parent = privateParent('phub-role-split-installation-mode-');
    expect(() =>
      buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha: nonExecutableSha,
        outputPath: candidatePath(parent, nonExecutableSha),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SOURCE_NOT_BLOB');
  });

  it('rejects a repository that does not retain the exact lk2 origin', () => {
    git(repository, ['remote', 'set-url', 'origin', 'https://example.invalid/not-lk2.git']);
    const parent = privateParent('phub-role-split-installation-origin-');
    expect(() =>
      buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        outputPath: candidatePath(parent, candidateSha),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_REPOSITORY_ORIGIN_INVALID');
  });
});
