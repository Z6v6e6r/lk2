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
  ['apps/migrator/src/communities-staging-role-split-ddl-fence.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-file-evidence-sink.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-host-authorization-loader.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-runner-adapter.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-pg-restore-runner.ts', 0o644],
  ['apps/migrator/src/root-owned-evidence.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-inventory-preparation.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-inventory-preparation.ts', 0o644],
  ['apps/migrator/src/verify-communities-staging-role-split-inventory-preparation.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-trusted-inventory.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-trusted-inventory-host.ts', 0o644],
  [
    'apps/migrator/src/communities-staging-role-split-trusted-inventory-supervised-producer.ts',
    0o644,
  ],
  ['apps/migrator/src/communities-staging-role-split-v3-durable-host.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-v3-external-phase-anchor.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-v3-durable-continuation-host.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-v3-pg-restore-executor.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-v3-durable-restore-coordinator.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-v3-executable-composition.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-v3-contract.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-v3-envelope.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-v3-restore-authorization.ts', 0o644],
  [
    'packages/database/src/communities-staging-role-split-v3-durable-restore-authorization.ts',
    0o644,
  ],
  ['packages/database/src/communities-staging-role-split-v3-durable-state-envelope.ts', 0o644],
  [
    'packages/database/src/communities-staging-role-split-v3-durable-continuation-envelope.ts',
    0o644,
  ],
  ['packages/database/src/communities-staging-role-split-v3-execution-authorization.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-v3-attested-evidence.ts', 0o644],
  ['packages/database/src/communities-staging-role-split-trusted-inventory-gate.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-trusted-inventory-gate.ts', 0o644],
  [
    'packages/database/src/communities-staging-role-split-trusted-inventory-authorization-request.ts',
    0o644,
  ],
  [
    'apps/migrator/src/communities-staging-role-split-trusted-inventory-authorization-request.ts',
    0o644,
  ],
  [
    'packages/database/src/communities-staging-role-split-trusted-inventory-authorization.ts',
    0o644,
  ],
  [
    'apps/migrator/src/communities-staging-role-split-trusted-inventory-authorization-loader.ts',
    0o644,
  ],
  ['apps/migrator/src/communities-staging-role-split-trusted-inventory-runtime-wiring.ts', 0o644],
  ['apps/migrator/src/communities-staging-role-split-trusted-inventory-runtime-module.ts', 0o644],
  ['deploy/jetson/generated/communities-staging-role-split-trusted-inventory-runtime.mjs', 0o644],
] as const;

const sourcePaths = sourceDefinitions.map(([path]) => path);
const disabledCommandFixture =
  "#!/bin/sh\nset -eu\nprintf '%s\\n' COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED >&2\nexit 78\n";
const shellInstallerFixture = readFileSync(
  new URL('../deploy/jetson/install-communities-role-split-disabled-candidate.sh', import.meta.url),
  'utf8',
);
const runtimeBundleFixture = readFileSync(
  new URL(
    '../deploy/jetson/generated/communities-staging-role-split-trusted-inventory-runtime.mjs',
    import.meta.url,
  ),
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
            : sourcePath.endsWith('.mjs')
              ? runtimeBundleFixture
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
    expect(manifest.schemaVersion).toBe('communities-role-split-installation-candidate-v13');
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
      'EXTERNAL_MONOTONIC_PHASE_ANCHOR',
      'INDEPENDENT_EVIDENCE_SINK',
      'OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS',
      'OWNERSHIP_ACL_ATTESTATION',
      'PG_RESTORE_EXECUTABLE_SHA256',
      'RESTORE_LOGIN_ROLE',
      'SOURCE_WRITE_DENIAL_ATTESTATION',
      'STAGING_KNOWN_HOSTS_PIN',
      'TRUSTED_INVENTORY_CREDENTIAL_FD_READER',
      'TRUSTED_INVENTORY_DURABLE_SINGLE_USE_LEDGER',
      'TRUSTED_INVENTORY_FAIL_CLOSED_CLOCK_ADAPTER',
      'TRUSTED_INVENTORY_INDEPENDENT_ARTIFACT_PIN',
      'TRUSTED_INVENTORY_INDEPENDENT_ATTESTED_EVIDENCE',
      'TRUSTED_INVENTORY_INDEPENDENT_APPROVAL',
      'TRUSTED_INVENTORY_MARKER_EVIDENCE_MAPPING_INPUTS',
      'TRUSTED_INVENTORY_PRIVATE_OUTPUT_CUSTODY',
      'TRUSTED_INVENTORY_SUPERVISED_PRODUCER_RUNTIME_WIRING',
    ]);
    expect(manifest.executionBindings.every(({ blocksInstallation }) => !blocksInstallation)).toBe(
      true,
    );
    expect(manifest.artifactFiles.every(({ action }) => action === 'INSTALL_NEW')).toBe(true);
    expect(
      manifest.artifactFiles.every(({ artifactPath }) => artifactPath.startsWith('payload/')),
    ).toBe(true);
    expect(manifest.artifactFiles).toHaveLength(39);
    const ddlFenceArtifact = manifest.artifactFiles.find(
      ({ sourcePath }) =>
        sourcePath === 'apps/migrator/src/communities-staging-role-split-ddl-fence.ts',
    );
    expect(ddlFenceArtifact).toBeDefined();
    expect(ddlFenceArtifact).toMatchObject({
      sourcePath: 'apps/migrator/src/communities-staging-role-split-ddl-fence.ts',
      artifactPath: 'payload/source/communities-staging-role-split-ddl-fence.ts',
      installMode: '0444',
      sourceGitMode: '100644',
      targetPath: `/usr/local/libexec/phub/communities-role-split/candidates/${candidateSha}/source/communities-staging-role-split-ddl-fence.ts`,
      action: 'INSTALL_NEW',
      installOwner: 'root',
      installGroup: 'root',
      purpose: 'canonical runner DDL fence snapshot; non-runnable source artifact',
    });
    expect(typeof ddlFenceArtifact?.bytes).toBe('number');
    expect(typeof ddlFenceArtifact?.sha256).toBe('string');
    expect(
      manifest.artifactFiles.find(
        ({ sourcePath }) =>
          sourcePath ===
          'apps/migrator/src/communities-staging-role-split-v3-pg-restore-executor.ts',
      ),
    ).toMatchObject({
      artifactPath: 'payload/source/communities-staging-role-split-v3-pg-restore-executor.ts',
      installMode: '0444',
      sourceGitMode: '100644',
      purpose: 'reviewed V3 code-only source snapshot; deliberately unwired and non-runnable',
    });
    expect(
      manifest.artifactFiles.find(
        ({ sourcePath }) =>
          sourcePath ===
          'apps/migrator/src/communities-staging-role-split-v3-external-phase-anchor.ts',
      ),
    ).toMatchObject({
      artifactPath: 'payload/source/communities-staging-role-split-v3-external-phase-anchor.ts',
      installMode: '0444',
      sourceGitMode: '100644',
      purpose:
        'reviewed V3 external monotonic anchor source snapshot; deliberately unwired and non-runnable',
    });
    expect(
      manifest.artifactFiles.slice(10, 13).map(({ sourcePath, artifactPath, installMode }) => ({
        sourcePath,
        artifactPath,
        installMode,
      })),
    ).toEqual([
      {
        sourcePath: 'packages/database/src/communities-staging-role-split-inventory-preparation.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-inventory-preparation-database.ts',
        installMode: '0444',
      },
      {
        sourcePath: 'apps/migrator/src/communities-staging-role-split-inventory-preparation.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-inventory-preparation-verifier.ts',
        installMode: '0444',
      },
      {
        sourcePath:
          'apps/migrator/src/verify-communities-staging-role-split-inventory-preparation.ts',
        artifactPath:
          'payload/source/verify-communities-staging-role-split-inventory-preparation.ts',
        installMode: '0444',
      },
    ]);
    expect(
      manifest.artifactFiles
        .slice(13, 16)
        .map(({ sourcePath, artifactPath, installMode, purpose }) => ({
          sourcePath,
          artifactPath,
          installMode,
          purpose,
        })),
    ).toEqual([
      {
        sourcePath: 'packages/database/src/communities-staging-role-split-trusted-inventory.ts',
        artifactPath: 'payload/source/communities-staging-role-split-trusted-inventory-database.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory canonical contract snapshot; deliberately unwired and non-runnable',
      },
      {
        sourcePath: 'apps/migrator/src/communities-staging-role-split-trusted-inventory-host.ts',
        artifactPath: 'payload/source/communities-staging-role-split-trusted-inventory-host.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory host boundary snapshot; no CLI, producer composition or credential reader',
      },
      {
        sourcePath:
          'apps/migrator/src/communities-staging-role-split-trusted-inventory-supervised-producer.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-supervised-producer.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory supervised producer composition snapshot; source-only, deliberately unwired and non-runnable',
      },
    ]);
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
      'PHUB_COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_V13',
    );
    expect(hostInstaller).toContain('PHUB_COMMUNITIES_ROLE_SPLIT_HOST_INSTALL_CONTROL_V10');
    expect(hostInstaller).toContain(
      'case "$count" in \'\' | *[!0-9]*) fail FILE_SET_INVALID ;; esac',
    );
    expect(hostInstaller).toContain(
      '[ "$(walk_count "$candidate")" = 45 ] || fail FILE_SET_INVALID',
    );
    expect(hostInstaller).toContain('read_exact_line CONTROL_INVALID artifactCount=39');
    expect(hostInstaller).toContain('while [ "$index" -le 39 ]');
    expect(hostInstaller).toContain(
      '[ "$(walk_count "$target")" = 42 ] || fail INSTALLED_FILE_SET_INVALID',
    );
    expect(hostInstaller).toContain('[ "$index" = 39 ] || fail CONTROL_INVALID');
    expect(hostInstaller).toContain('expected_manifest_bytes()');
    expect(hostInstaller).toContain(
      'expected_manifest_sha=$(expected_manifest_bytes 2>/dev/null | /usr/bin/sha256sum | /usr/bin/awk',
    );
    expect(hostInstaller).not.toContain('/bin/grep -Fxc');
    expect(hostInstaller).toMatch(
      /\s*5\) printf '%s\\n' 'payload\/source\/communities-staging-role-split-ddl-fence\.ts\|source\/communities-staging-role-split-ddl-fence\.ts\|0444' ;;/u,
    );
    expect(
      [
        ...hostInstaller.matchAll(
          /^\s+(\d+)\) printf '%s\\n' '([^|]+)\|([^|]+)\|([0-7]{4})' ;;$/gmu,
        ),
      ].map(([, index, artifactPath, targetRelativePath, installMode]) => ({
        index: Number(index),
        artifactPath,
        targetRelativePath,
        installMode,
      })),
    ).toEqual(
      manifest.artifactFiles.map((file, index) => ({
        index: index + 1,
        artifactPath: file.artifactPath,
        targetRelativePath: file.targetPath.slice(
          `/usr/local/libexec/phub/communities-role-split/candidates/${candidateSha}/`.length,
        ),
        installMode: file.installMode,
      })),
    );
    expect(hostInstaller).not.toContain('[ "$(walk_count "$target")" = 11 ]');
    expect(hostInstaller).not.toContain('[ "$index" = 9 ]');
    expect(manifest.artifactFiles.slice(16, 30).map(({ sourcePath }) => sourcePath)).toEqual([
      'apps/migrator/src/communities-staging-role-split-v3-durable-host.ts',
      'apps/migrator/src/communities-staging-role-split-v3-external-phase-anchor.ts',
      'apps/migrator/src/communities-staging-role-split-v3-durable-continuation-host.ts',
      'apps/migrator/src/communities-staging-role-split-v3-pg-restore-executor.ts',
      'apps/migrator/src/communities-staging-role-split-v3-durable-restore-coordinator.ts',
      'apps/migrator/src/communities-staging-role-split-v3-executable-composition.ts',
      'packages/database/src/communities-staging-role-split-v3-contract.ts',
      'packages/database/src/communities-staging-role-split-v3-envelope.ts',
      'packages/database/src/communities-staging-role-split-v3-restore-authorization.ts',
      'packages/database/src/communities-staging-role-split-v3-durable-restore-authorization.ts',
      'packages/database/src/communities-staging-role-split-v3-durable-state-envelope.ts',
      'packages/database/src/communities-staging-role-split-v3-durable-continuation-envelope.ts',
      'packages/database/src/communities-staging-role-split-v3-execution-authorization.ts',
      'packages/database/src/communities-staging-role-split-v3-attested-evidence.ts',
    ]);
    expect(
      manifest.artifactFiles
        .slice(30)
        .map(({ sourcePath, artifactPath, installMode, purpose }) => ({
          sourcePath,
          artifactPath,
          installMode,
          purpose,
        })),
    ).toEqual([
      {
        sourcePath:
          'packages/database/src/communities-staging-role-split-trusted-inventory-gate.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-gate-database.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory review-gate contract snapshot; no custody or execution authority',
      },
      {
        sourcePath: 'apps/migrator/src/communities-staging-role-split-trusted-inventory-gate.ts',
        artifactPath: 'payload/source/communities-staging-role-split-trusted-inventory-gate.ts',
        installMode: '0444',
        purpose: 'trusted-inventory review-gate verifier snapshot; runtime inputs remain untrusted',
      },
      {
        sourcePath:
          'packages/database/src/communities-staging-role-split-trusted-inventory-authorization-request.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-authorization-request-database.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory authorization-request contract snapshot; every granted authority false',
      },
      {
        sourcePath:
          'apps/migrator/src/communities-staging-role-split-trusted-inventory-authorization-request.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-authorization-request.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory authorization-request verifier snapshot; evidence remains external',
      },
      {
        sourcePath:
          'packages/database/src/communities-staging-role-split-trusted-inventory-authorization.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-authorization-database.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory single-use authorization contract snapshot; serialized authority remains false',
      },
      {
        sourcePath:
          'apps/migrator/src/communities-staging-role-split-trusted-inventory-authorization-loader.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-authorization-loader.ts',
        installMode: '0444',
        purpose:
          'trusted-inventory issuer/loader snapshot; concrete clock, ledger, approval and evidence absent',
      },
      {
        sourcePath:
          'apps/migrator/src/communities-staging-role-split-trusted-inventory-runtime-wiring.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-runtime-wiring.ts',
        installMode: '0444',
        purpose:
          'reviewed trusted-inventory runtime wiring source snapshot; execution inputs absent',
      },
      {
        sourcePath:
          'apps/migrator/src/communities-staging-role-split-trusted-inventory-runtime-module.ts',
        artifactPath:
          'payload/source/communities-staging-role-split-trusted-inventory-runtime-module.ts',
        installMode: '0444',
        purpose: 'fail-closed runtime module source snapshot; direct invocation rejects execution',
      },
      {
        sourcePath:
          'deploy/jetson/generated/communities-staging-role-split-trusted-inventory-runtime.mjs',
        artifactPath:
          'payload/runtime/communities-staging-role-split-trusted-inventory-runtime.mjs',
        installMode: '0444',
        purpose:
          'self-contained Node 22 runtime bundle; no configuration, activation link or execution authority',
      },
    ]);
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
  }, 15_000);

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
  }, 20_000);

  it('reconstructs the exact canonical manifest with the POSIX verifier policy', () => {
    const parent = privateParent('phub-role-split-posix-manifest-');
    const candidate = candidatePath(parent, candidateSha);
    const pins = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const mainOffset = shellInstallerFixture.indexOf("\nlock=''\n");
    const toolCheckStart = shellInstallerFixture.indexOf('\nfor tool in \\\n');
    const toolCheckEnd = shellInstallerFixture.indexOf('\n\nsha40=');
    expect(mainOffset).toBeGreaterThan(0);
    expect(toolCheckStart).toBeGreaterThan(0);
    expect(toolCheckEnd).toBeGreaterThan(toolCheckStart);
    const library = `${shellInstallerFixture.slice(0, toolCheckStart)}${shellInstallerFixture.slice(
      toolCheckEnd,
      mainOffset,
    )}`;
    const result = spawnSync('/bin/sh', ['-s'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PHUB_TEST_CANDIDATE: candidate,
        PHUB_TEST_CANDIDATE_SHA: candidateSha,
        PHUB_TEST_CONTROL_SHA: pins.controlSha256,
        PHUB_TEST_ARTIFACT_SET_SHA: pins.artifactSetSha256,
      },
      input: `${library}\ncandidate=$PHUB_TEST_CANDIDATE\ncandidate_sha=$PHUB_TEST_CANDIDATE_SHA\ncontrol_sha=$PHUB_TEST_CONTROL_SHA\nartifact_set_sha=$PHUB_TEST_ARTIFACT_SET_SHA\nexpected_manifest_bytes\n`,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toBe(
      readFileSync(join(candidate, 'installation-candidate.json'), 'utf8'),
    );
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
  }, 15_000);

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

    const extraCandidateFile = join(candidate, 'unexpected-node-verifier-file');
    writeFileSync(extraCandidateFile, 'unexpected', { mode: 0o600 });
    expect(() => installCommunitiesRoleSplitDisabledCandidate(input)).toThrow(
      'COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_CANDIDATE_FILE_SET_INVALID',
    );
    rmSync(extraCandidateFile);
    const extraCandidateDirectory = join(candidate, 'unexpected-node-verifier-directory');
    mkdirSync(extraCandidateDirectory, { mode: 0o700 });
    expect(() => installCommunitiesRoleSplitDisabledCandidate(input)).toThrow(
      'COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_CANDIDATE_FILE_SET_INVALID',
    );
    rmSync(extraCandidateDirectory, { recursive: true });

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

    const extraInstalledFile = join(installed.targetPath, 'unexpected-node-verifier-file');
    writeFileSync(extraInstalledFile, 'unexpected', { mode: 0o444 });
    expect(() => verifyCommunitiesRoleSplitDisabledInstallation(input)).toThrow(
      'COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_INSTALLED_FILE_SET_INVALID',
    );
    rmSync(extraInstalledFile);
    const extraInstalledDirectory = join(
      installed.targetPath,
      'unexpected-node-verifier-directory',
    );
    mkdirSync(extraInstalledDirectory, { mode: 0o755 });
    expect(() => verifyCommunitiesRoleSplitDisabledInstallation(input)).toThrow(
      'COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_INSTALLED_FILE_SET_INVALID',
    );
    rmSync(extraInstalledDirectory, { recursive: true });

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

      const manifestPath = join(candidate, 'installation-candidate.json');
      const exactManifest = readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(exactManifest) as Record<string, unknown>;
      for (const forged of [
        {
          ...manifest,
          authorizes: {
            ...(manifest.authorizes as Record<string, unknown>),
            ceremony: true,
          },
        },
        {
          ...manifest,
          schemaVersion: 'communities-role-split-installation-candidate-v10',
        },
      ]) {
        const forgedBytes = `${JSON.stringify(forged, null, 2)}\n`;
        writeFileSync(manifestPath, forgedBytes, { mode: 0o600 });
        const forgedCommon = [...common];
        forgedCommon[5] = sha256(forgedBytes);
        const rejected = spawnSync('/bin/sh', [installer, 'install', ...forgedCommon], {
          encoding: 'utf8',
        });
        expect(rejected.status).toBe(1);
        expect(rejected.stdout).toBe('');
        expect(rejected.stderr).toBe(
          'COMMUNITIES_ROLE_SPLIT_SHELL_INSTALLATION_MANIFEST_INVALID\n',
        );
        expect(existsSync(join(installationRoot, 'usr'))).toBe(false);
      }
      writeFileSync(manifestPath, exactManifest, { mode: 0o600 });

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

  it('rejects the previous V11 manifest even when its expanded payload is freshly pinned', () => {
    const parent = privateParent('phub-role-split-installation-v11-');
    const candidate = candidatePath(parent, candidateSha);
    const pins = buildCommunitiesRoleSplitInstallationCandidate({
      repositoryRoot: repository,
      candidateSha,
      outputPath: candidate,
    });
    const manifestPath = join(candidate, 'installation-candidate.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const stale = `${JSON.stringify(
      {
        ...manifest,
        schemaVersion: 'communities-role-split-installation-candidate-v11',
      },
      null,
      2,
    )}\n`;
    writeFileSync(manifestPath, stale, { mode: 0o600 });
    const installationRoot = privateParent('phub-role-split-installation-v11-root-');

    expect(() =>
      installCommunitiesRoleSplitDisabledCandidate({
        candidatePath: candidate,
        candidateSha,
        expectedManifestSha256: sha256(stale),
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
