import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import {
  installCommunitiesRoleSplitDisabledCandidate,
  verifyCommunitiesRoleSplitDisabledInstallation,
} from '../deploy/jetson/install-communities-role-split-disabled-candidate.mjs';

const sourceDefinitions = [
  ['deploy/jetson/install-communities-role-split-disabled-candidate.sh', 0o755],
  ['deploy/jetson/communities-role-split-disabled-command.sh', 0o755],
  ['apps/migrator/src/communities-staging-role-split-canonical-host-adapter.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-canonical-pg-collaborators.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-file-evidence-sink.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-host-authorization-loader.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-runner-adapter.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-pg-restore-runner.ts', 0o644],
  ['apps/migrator/src/root-owned-evidence.ts', 0o644],
] as const;

const sourcePaths = sourceDefinitions.map(([path]) => path);
const disabledCommandFixture =
  "#!/bin/sh\nset -eu\nprintf '%s\\n' COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED >&2\nexit 78\n";
const shellInstallerFixture = readFileSync(
  new URL('../deploy/jetson/install-communities-role-split-disabled-candidate.sh', import.meta.url),
  'utf8',
);
const canRunLinuxShellInstaller =
  process.platform === 'linux' &&
  [
    '/bin/sync',
    '/usr/bin/awk',
    '/usr/bin/find',
    '/usr/bin/install',
    '/usr/bin/realpath',
    '/usr/bin/sha256sum',
    '/usr/bin/stat',
  ].every((path) => existsSync(path));

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

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('POSIX_UID_REQUIRED');
  return uid;
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
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
    for (const [index, [sourcePath, mode]] of sourceDefinitions.entries()) {
      const absolutePath = join(repository, sourcePath);
      mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
      const fixture =
        index === 0
          ? shellInstallerFixture
          : index === 1
            ? disabledCommandFixture
            : `// fixture ${index}\n`;
      writeFileSync(absolutePath, fixture, { mode: 0o600 });
      chmodSync(absolutePath, mode);
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

  it('builds deterministic installable bytes while retaining every execution authority false', () => {
    const firstParent = privateParent('phub-role-split-installation-first-');
    const secondParent = privateParent('phub-role-split-installation-second-');
    const first = candidatePath(firstParent, candidateSha);
    const second = candidatePath(secondParent, candidateSha);

    writeFileSync(join(repository, sourcePaths[1]!), '# dirty worktree\n');
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
    expect(manifest.status).toBe('INSTALLABLE_DISABLED');
    expect(manifest.installable).toBe(true);
    expect(manifest.reasonCode).toBe('RUNTIME_BINDINGS_REQUIRED');
    expect(manifest.hostInstaller).toEqual({
      runtime: 'POSIX_SH_GNU_COREUTILS',
      entrypoint: 'payload/installer.sh',
      controlFile: 'installation-candidate.control',
      controlSha256: firstResult.controlSha256,
      nodeRequired: false,
    });
    expect(manifest.authorizes).toEqual({
      installation: true,
      keyProvisioning: false,
      workflowWiring: false,
      stagingAccess: false,
      databaseMutation: false,
      ceremony: false,
      cleanup: false,
      roleSplit: false,
      migration: false,
      deploy: false,
      activation: false,
    });
    expect(manifest.forcedCommandSurface).toEqual({
      principal: 'phub-preflight',
      options: ['restrict'],
      command: null,
      commandIncluded: false,
      publicKeyIncluded: false,
      authorizedKeysMutationIncluded: false,
      status: 'NOT_INSTALLED',
      cleanupCommandExposure: 'NOT_EXPOSED',
    });
    expect(manifest.executionBindings.map(({ code }) => code)).toEqual([
      'BACKUP_CUSTODY_HANDOFF',
      'CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER',
      'CLONE_ONLY_CONNECTION_FACTORY',
      'CLUSTER_DDL_FENCE',
      'DEDICATED_FORCED_COMMAND_PUBLIC_KEY',
      'INDEPENDENT_EVIDENCE_SINK',
      'OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS',
      'OWNERSHIP_ACL_ATTESTATION',
      'PG_RESTORE_EXECUTABLE_SHA256',
      'RESTORE_LOGIN_ROLE',
      'SOURCE_WRITE_DENIAL_ATTESTATION',
      'STAGING_KNOWN_HOSTS_PIN',
    ]);
    expect(manifest.executionBindings.every(({ blocksInstallation }) => !blocksInstallation)).toBe(
      true,
    );
    expect(manifest.artifactFiles.every(({ action }) => action === 'INSTALL_NEW')).toBe(true);
    expect(
      manifest.artifactFiles.every(({ artifactPath }) => artifactPath.startsWith('payload/')),
    ).toBe(true);
    expect(manifest.installation).toEqual({
      targetRoot: `/usr/local/libexec/phub/communities-role-split/candidates/${candidateSha}`,
      atomicNewVersionOnly: true,
      existingTargetPolicy: 'REFUSE',
      activationLinkIncluded: false,
      runtimeConfigurationIncluded: false,
    });
    expect(readFileSync(join(first, 'payload/disabled-command.sh'), 'utf8')).toBe(
      disabledCommandFixture,
    );
    const hostInstaller = readFileSync(join(first, 'payload/installer.sh'), 'utf8');
    expect(hostInstaller).toContain('--control-sha256');
    expect(hostInstaller).toContain('/usr/bin/sha256sum');
    expect(hostInstaller).toContain(
      'case "$count" in \'\' | *[!0-9]*) fail FILE_SET_INVALID ;; esac',
    );
    expect(hostInstaller).not.toMatch(/\/usr\/bin\/awk[^\n]*\[\[:(?:space|digit):\]\]/u);
    expect(hostInstaller).not.toMatch(/\/usr\/bin\/node|\b(?:docker|psql|ssh|sudo|jq|eval|rm)\b/u);
    expect(hostInstaller).not.toMatch(/^\s*(?:source|\.)\s/mu);
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
    const payload = join(candidate, 'payload/disabled-command.sh');
    writeFileSync(payload, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_PAYLOAD_INVALID');

    writeFileSync(payload, disabledCommandFixture, { mode: 0o600 });
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

  it('rejects manifest execution self-authorization even when payload bytes are intact', () => {
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
      `${JSON.stringify(
        { ...manifest, authorizes: { ...manifest.authorizes, ceremony: true } },
        null,
        2,
      )}\n`,
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

  it('rejects a changed host control ledger independently of the manifest', () => {
    const parent = privateParent('phub-role-split-installation-control-');
    const candidate = candidatePath(parent, candidateSha);
    buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const controlPath = join(candidate, 'installation-candidate.control');
    writeFileSync(controlPath, 'forged-control\n', { mode: 0o600 });
    expect(() =>
      verifyCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        candidatePath: candidate,
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_CONTROL_INVALID');
  });

  it('installs a new immutable disabled version and verifies exact readback', () => {
    const parent = privateParent('phub-role-split-installation-apply-');
    const candidate = candidatePath(parent, candidateSha);
    const pins = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const installationRoot = privateParent('phub-role-split-installation-root-');
    const input = {
      candidatePath: candidate,
      candidateSha,
      expectedManifestSha256: pins.manifestSha256,
      expectedControlSha256: pins.controlSha256,
      expectedArtifactSetSha256: pins.artifactSetSha256,
      installationRoot,
      expectedUid: currentUid(),
    };

    const installed = installCommunitiesRoleSplitDisabledCandidate(input);
    expect(verifyCommunitiesRoleSplitDisabledInstallation(input)).toEqual(installed);
    expect(
      readFileSync(join(installed.targetPath, 'installation-complete.json'), 'utf8'),
    ).toContain('"status": "INSTALLED_DISABLED"');
    const denied = spawnSync(join(installed.targetPath, 'disabled-command.sh'), [], {
      encoding: 'utf8',
    });
    expect(denied.status).toBe(78);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toBe('COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED\n');
    expect(() => installCommunitiesRoleSplitDisabledCandidate(input)).toThrow(
      'COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_TARGET_EXISTS',
    );

    writeFileSync(join(installed.targetPath, 'disabled-command.sh'), '# tampered\n', {
      mode: 0o755,
    });
    expect(() => verifyCommunitiesRoleSplitDisabledInstallation(input)).toThrow(
      'COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_INSTALLED_PAYLOAD_INVALID',
    );
  }, 15_000);

  it.runIf(canRunLinuxShellInstaller)(
    'runs the dependency-free shell installer and read-only verifier without Node',
    () => {
      const parent = privateParent('phub-role-split-shell-installation-');
      const candidate = candidatePath(parent, candidateSha);
      const pins = buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        outputPath: candidate,
      });
      const installationRoot = privateParent('phub-role-split-shell-root-');
      const installer = join(candidate, 'payload/installer.sh');
      const common = [
        '--candidate',
        candidate,
        '--candidate-sha',
        candidateSha,
        '--manifest-sha256',
        pins.manifestSha256,
        '--control-sha256',
        pins.controlSha256,
        '--artifact-set-sha256',
        pins.artifactSetSha256,
        '--installation-root',
        installationRoot,
      ];
      const staleControl = [...common];
      staleControl[7] = '0'.repeat(64);
      const stale = spawnSync('/bin/sh', [installer, 'install', ...staleControl], {
        encoding: 'utf8',
      });
      expect(stale.status).toBe(1);
      expect(stale.stdout).toBe('');
      expect(stale.stderr).toBe(
        'COMMUNITIES_ROLE_SPLIT_SHELL_INSTALLATION_CONTROL_DIGEST_MISMATCH\n',
      );
      expect(existsSync(join(installationRoot, 'usr'))).toBe(false);

      const installed = spawnSync('/bin/sh', [installer, 'install', ...common], {
        encoding: 'utf8',
      });
      expect(installed.status).toBe(0);
      expect(installed.stderr).toBe('');
      expect(installed.stdout).toMatch(
        /^COMMUNITIES_ROLE_SPLIT_CODE_INSTALL_PASSED\|candidate=[0-9a-f]{40}\|receipt=[0-9a-f]{64}\|status=disabled\|authorizes_ceremony=false\|authorizes_database_mutation=false\n$/u,
      );

      const verified = spawnSync('/bin/sh', [installer, 'verify', ...common], {
        encoding: 'utf8',
      });
      expect(verified.status).toBe(0);
      expect(verified.stderr).toBe('');
      expect(verified.stdout.replace('VERIFY', 'INSTALL')).toBe(installed.stdout);

      const target = join(
        installationRoot,
        'usr/local/libexec/phub/communities-role-split/candidates',
        candidateSha,
      );
      const denied = spawnSync(join(target, 'disabled-command.sh'), [], { encoding: 'utf8' });
      expect(denied.status).toBe(78);
      expect(denied.stderr).toBe('COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED\n');

      const repeated = spawnSync('/bin/sh', [installer, 'install', ...common], {
        encoding: 'utf8',
      });
      expect(repeated.status).toBe(1);
      expect(repeated.stderr).toBe('COMMUNITIES_ROLE_SPLIT_SHELL_INSTALLATION_TARGET_EXISTS\n');

      writeFileSync(join(target, 'disabled-command.sh'), '# tampered\n', { mode: 0o755 });
      const tampered = spawnSync('/bin/sh', [installer, 'verify', ...common], {
        encoding: 'utf8',
      });
      expect(tampered.status).toBe(1);
      expect(tampered.stdout).toBe('');
      expect(tampered.stderr).toBe(
        'COMMUNITIES_ROLE_SPLIT_SHELL_INSTALLATION_INSTALLED_PAYLOAD_INVALID\n',
      );

      const partialRoot = privateParent('phub-role-split-shell-partial-root-');
      const partialParent = join(
        partialRoot,
        'usr/local/libexec/phub/communities-role-split/candidates',
      );
      const incomplete = join(partialParent, `.${candidateSha}.incomplete`);
      mkdirSync(incomplete, { recursive: true, mode: 0o755 });
      const sentinel = join(incomplete, 'sentinel');
      writeFileSync(sentinel, 'retain', { mode: 0o600 });
      const partialCommon = [...common];
      partialCommon[11] = partialRoot;
      const partial = spawnSync('/bin/sh', [installer, 'install', ...partialCommon], {
        encoding: 'utf8',
      });
      expect(partial.status).toBe(1);
      expect(partial.stderr).toBe('COMMUNITIES_ROLE_SPLIT_SHELL_INSTALLATION_INCOMPLETE_EXISTS\n');
      expect(readFileSync(sentinel, 'utf8')).toBe('retain');
    },
    30_000,
  );

  it('refuses an abandoned partial version instead of overwriting or cleaning it', () => {
    const parent = privateParent('phub-role-split-installation-partial-');
    const candidate = candidatePath(parent, candidateSha);
    const pins = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const installationRoot = privateParent('phub-role-split-installation-partial-root-');
    const candidateParent = join(
      installationRoot,
      'usr/local/libexec/phub/communities-role-split/candidates',
    );
    mkdirSync(join(candidateParent, `.${candidateSha}.incomplete`), {
      mode: 0o755,
      recursive: true,
    });
    const sentinel = join(candidateParent, `.${candidateSha}.incomplete`, 'sentinel');
    writeFileSync(sentinel, 'retain', { mode: 0o600 });

    expect(() =>
      installCommunitiesRoleSplitDisabledCandidate({
        candidatePath: candidate,
        candidateSha,
        expectedManifestSha256: pins.manifestSha256,
        expectedControlSha256: pins.controlSha256,
        expectedArtifactSetSha256: pins.artifactSetSha256,
        installationRoot,
        expectedUid: currentUid(),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_INCOMPLETE_EXISTS');
    expect(readFileSync(sentinel, 'utf8')).toBe('retain');
  });

  it('rejects a stale independent manifest pin before creating the installation path', () => {
    const parent = privateParent('phub-role-split-installation-stale-pin-');
    const candidate = candidatePath(parent, candidateSha);
    const pins = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const installationRoot = privateParent('phub-role-split-installation-stale-root-');
    expect(() =>
      installCommunitiesRoleSplitDisabledCandidate({
        candidatePath: candidate,
        candidateSha,
        expectedManifestSha256: '0'.repeat(64),
        expectedControlSha256: pins.controlSha256,
        expectedArtifactSetSha256: pins.artifactSetSha256,
        installationRoot,
        expectedUid: currentUid(),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_MANIFEST_DIGEST_MISMATCH');
    expect(() =>
      realpathSync(
        join(
          installationRoot,
          'usr/local/libexec/phub/communities-role-split/candidates',
          candidateSha,
        ),
      ),
    ).toThrow();
  });

  it('rejects a freshly pinned manifest that changes the fixed install allowlist', () => {
    const parent = privateParent('phub-role-split-installation-forged-');
    const candidate = candidatePath(parent, candidateSha);
    const pins = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const manifestPath = join(candidate, 'installation-candidate.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const forged = `${JSON.stringify(
      {
        ...manifest,
        forcedCommandSurface: {
          ...(manifest.forcedCommandSurface as Record<string, unknown>),
          publicKeyIncluded: true,
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(manifestPath, forged, { mode: 0o600 });
    const installationRoot = privateParent('phub-role-split-installation-forged-root-');

    expect(() =>
      installCommunitiesRoleSplitDisabledCandidate({
        candidatePath: candidate,
        candidateSha,
        expectedManifestSha256: sha256(forged),
        expectedControlSha256: pins.controlSha256,
        expectedArtifactSetSha256: pins.artifactSetSha256,
        installationRoot,
        expectedUid: currentUid(),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_MANIFEST_INVALID');
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
    chmodSync(join(repository, sourcePaths[0]!), 0o644);
    git(repository, ['add', sourcePaths[0]!]);
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

  it('rejects Git replacement refs before reading the pinned commit tree', () => {
    writeFileSync(
      join(repository, sourcePaths[1]!),
      '#!/bin/sh\n# replacement-only bytes\nexit 0\n',
      { mode: 0o755 },
    );
    git(repository, ['add', sourcePaths[1]!]);
    git(repository, ['commit', '--quiet', '-m', 'replacement payload']);
    const replacementSha = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['replace', candidateSha, replacementSha]);
    const parent = privateParent('phub-role-split-installation-replace-');

    expect(() =>
      buildCommunitiesRoleSplitInstallationCandidate({
        repositoryRoot: repository,
        candidateSha,
        outputPath: candidatePath(parent, candidateSha),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_GIT_REPLACE_REFS_FORBIDDEN');
  });
});
