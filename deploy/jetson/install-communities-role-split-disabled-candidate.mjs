#!/usr/bin/node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaVersion = 'communities-role-split-installation-candidate-v5';
const sha40 = /^[0-9a-f]{40}$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const installPrefix = '/usr/local/libexec/phub/communities-role-split/candidates';
const completeReceiptName = 'installation-complete.json';
const expectedArtifacts = [
  {
    sourcePath: 'deploy/jetson/install-communities-role-split-disabled-candidate.sh',
    sourceGitMode: '100755',
    artifactPath: 'payload/installer.sh',
    targetRelativePath: 'installer.sh',
    installMode: '0755',
  },
  {
    sourcePath: 'deploy/jetson/communities-role-split-disabled-command.sh',
    sourceGitMode: '100755',
    artifactPath: 'payload/disabled-command.sh',
    targetRelativePath: 'disabled-command.sh',
    installMode: '0755',
  },
  ...[
    ['communities-staging-role-split-canonical-host-adapter.ts', 'canonical-host-adapter.ts'],
    [
      'communities-staging-role-split-canonical-pg-collaborators.ts',
      'canonical-pg-collaborators.ts',
    ],
    ['communities-staging-role-split-file-evidence-sink.ts', null],
    ['communities-staging-role-split-host-authorization-loader.ts', null],
    ['communities-staging-role-split-runner-adapter.ts', null],
    ['communities-staging-role-split-pg-restore-runner.ts', null],
    ['root-owned-evidence.ts', null],
  ].map(([sourceName, artifactName]) => ({
    sourcePath: `apps/migrator/src/${sourceName}`,
    sourceGitMode: '100644',
    artifactPath: `payload/source/${artifactName ?? sourceName}`,
    targetRelativePath: `source/${artifactName ?? sourceName}`,
    installMode: '0444',
  })),
  {
    sourcePath: 'packages/database/src/communities-staging-role-split-inventory-preparation.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/communities-staging-role-split-inventory-preparation-database.ts',
    targetRelativePath: 'source/communities-staging-role-split-inventory-preparation-database.ts',
    installMode: '0444',
  },
  {
    sourcePath: 'apps/migrator/src/communities-staging-role-split-inventory-preparation.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/communities-staging-role-split-inventory-preparation-verifier.ts',
    targetRelativePath: 'source/communities-staging-role-split-inventory-preparation-verifier.ts',
    installMode: '0444',
  },
  {
    sourcePath: 'apps/migrator/src/verify-communities-staging-role-split-inventory-preparation.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/verify-communities-staging-role-split-inventory-preparation.ts',
    targetRelativePath: 'source/verify-communities-staging-role-split-inventory-preparation.ts',
    installMode: '0444',
  },
];
const expectedExecutionBindingCodes = [
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
];

function fail(code) {
  throw new Error(`COMMUNITIES_ROLE_SPLIT_CODE_INSTALLATION_${code}`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function artifactSetSha256(files) {
  return digest(
    files.map((file) => `${file.artifactPath}\0${file.sha256}\0${file.bytes}\n`).join(''),
  );
}

function assertCandidateFile(path, expectedUid, expectedMode = 0o600) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o777) !== expectedMode
  )
    fail('CANDIDATE_CUSTODY_INVALID');
}

function assertDirectory(path, expectedUid, expectedMode) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o777) !== expectedMode
  )
    fail('TARGET_CUSTODY_INVALID');
}

function assertSafeParentDirectory(path, expectedUid) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o022) !== 0
  )
    fail('TARGET_CUSTODY_INVALID');
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertManifest(manifest, candidateSha, expectedControlSha256) {
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'candidateCommitSha',
      'sourceRepository',
      'status',
      'installable',
      'reasonCode',
      'hostInstaller',
      'artifactFiles',
      'installation',
      'forcedCommandSurface',
      'executionBindings',
      'authorizes',
    ]) ||
    manifest.schemaVersion !== schemaVersion ||
    manifest.candidateCommitSha !== candidateSha ||
    manifest.sourceRepository !== 'https://github.com/Z6v6e6r/lk2.git' ||
    manifest.status !== 'INSTALLABLE_DISABLED' ||
    manifest.installable !== true ||
    manifest.reasonCode !== 'RUNTIME_BINDINGS_REQUIRED' ||
    !exactKeys(manifest.hostInstaller, [
      'runtime',
      'entrypoint',
      'controlFile',
      'controlSha256',
      'nodeRequired',
    ]) ||
    manifest.hostInstaller.runtime !== 'POSIX_SH_GNU_COREUTILS' ||
    manifest.hostInstaller.entrypoint !== 'payload/installer.sh' ||
    manifest.hostInstaller.controlFile !== 'installation-candidate.control' ||
    manifest.hostInstaller.controlSha256 !== expectedControlSha256 ||
    manifest.hostInstaller.nodeRequired !== false ||
    !Array.isArray(manifest.artifactFiles) ||
    manifest.artifactFiles.length !== expectedArtifacts.length ||
    !exactKeys(manifest.installation, [
      'targetRoot',
      'atomicNewVersionOnly',
      'existingTargetPolicy',
      'activationLinkIncluded',
      'runtimeConfigurationIncluded',
    ]) ||
    manifest.installation.targetRoot !== `${installPrefix}/${candidateSha}` ||
    manifest.installation.atomicNewVersionOnly !== true ||
    manifest.installation.existingTargetPolicy !== 'REFUSE' ||
    manifest.installation.activationLinkIncluded !== false ||
    manifest.installation.runtimeConfigurationIncluded !== false ||
    !exactKeys(manifest.forcedCommandSurface, [
      'principal',
      'options',
      'command',
      'commandIncluded',
      'publicKeyIncluded',
      'authorizedKeysMutationIncluded',
      'status',
      'cleanupCommandExposure',
    ]) ||
    manifest.forcedCommandSurface.principal !== 'phub-preflight' ||
    JSON.stringify(manifest.forcedCommandSurface.options) !== JSON.stringify(['restrict']) ||
    manifest.forcedCommandSurface.command !== null ||
    manifest.forcedCommandSurface.commandIncluded !== false ||
    manifest.forcedCommandSurface.publicKeyIncluded !== false ||
    manifest.forcedCommandSurface.authorizedKeysMutationIncluded !== false ||
    manifest.forcedCommandSurface.status !== 'NOT_INSTALLED' ||
    manifest.forcedCommandSurface.cleanupCommandExposure !== 'NOT_EXPOSED' ||
    !Array.isArray(manifest.executionBindings) ||
    manifest.executionBindings.length !== expectedExecutionBindingCodes.length ||
    manifest.executionBindings.some(
      (binding, index) =>
        !exactKeys(binding, ['code', 'status', 'blocksInstallation']) ||
        binding.code !== expectedExecutionBindingCodes[index] ||
        binding.status !== 'REQUIRED_FOR_EXECUTION' ||
        binding.blocksInstallation !== false,
    ) ||
    !exactKeys(manifest.authorizes, [
      'installation',
      'keyProvisioning',
      'workflowWiring',
      'stagingAccess',
      'databaseMutation',
      'ceremony',
      'cleanup',
      'roleSplit',
      'migration',
      'deploy',
      'activation',
    ]) ||
    manifest.authorizes.installation !== true ||
    Object.entries(manifest.authorizes).some(
      ([key, value]) => key !== 'installation' && value !== false,
    )
  )
    fail('MANIFEST_INVALID');

  const targetPaths = new Set();
  for (const [index, file] of manifest.artifactFiles.entries()) {
    const expected = expectedArtifacts[index];
    if (
      !exactKeys(file, [
        'sourcePath',
        'sourceGitMode',
        'artifactPath',
        'targetPath',
        'action',
        'installOwner',
        'installGroup',
        'installMode',
        'purpose',
        'bytes',
        'sha256',
      ]) ||
      file.sourcePath !== expected.sourcePath ||
      file.sourceGitMode !== expected.sourceGitMode ||
      file.artifactPath !== expected.artifactPath ||
      file.artifactPath.includes('..') ||
      file.action !== 'INSTALL_NEW' ||
      file.targetPath !== `${installPrefix}/${candidateSha}/${expected.targetRelativePath}` ||
      file.targetPath.includes('..') ||
      targetPaths.has(file.targetPath) ||
      file.installOwner !== 'root' ||
      file.installGroup !== 'root' ||
      file.installMode !== expected.installMode ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 2 * 1024 * 1024 ||
      !sha256.test(file.sha256)
    )
      fail('MANIFEST_INVALID');
    targetPaths.add(file.targetPath);
  }
}

function ensureParentChain(targetPath, expectedUid, boundaryRoot) {
  const relativePath = targetPath.slice(boundaryRoot === '/' ? 1 : boundaryRoot.length + 1);
  if (targetPath !== boundaryRoot && !targetPath.startsWith(`${boundaryRoot}${sep}`))
    fail('TARGET_ROOT_INVALID');
  const parts = relativePath.split(sep).filter(Boolean);
  let current = boundaryRoot;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o755 });
    assertSafeParentDirectory(current, expectedUid);
  }
}

function resolveInstalledPath(installationRoot, absoluteTarget) {
  if (
    !isAbsolute(installationRoot) ||
    resolve(installationRoot) !== installationRoot ||
    realpathSync(installationRoot) !== installationRoot
  )
    fail('TARGET_ROOT_INVALID');
  return installationRoot === '/'
    ? absoluteTarget
    : join(installationRoot, absoluteTarget.slice(1));
}

function readAndVerifyCandidate(input) {
  if (!sha40.test(input.candidateSha) || !sha256.test(input.expectedManifestSha256))
    fail('PIN_INVALID');
  if (!sha256.test(input.expectedControlSha256)) fail('PIN_INVALID');
  if (!sha256.test(input.expectedArtifactSetSha256)) fail('PIN_INVALID');
  if (!isAbsolute(input.candidatePath) || realpathSync(input.candidatePath) !== input.candidatePath)
    fail('CANDIDATE_PATH_INVALID');
  if (
    basename(input.candidatePath) !==
    `communities-role-split-installation-candidate-${input.candidateSha}`
  )
    fail('CANDIDATE_PATH_INVALID');
  assertDirectory(input.candidatePath, input.expectedUid, 0o700);
  const manifestPath = join(input.candidatePath, 'installation-candidate.json');
  assertCandidateFile(manifestPath, input.expectedUid);
  const manifestBytes = readFileSync(manifestPath);
  if (digest(manifestBytes) !== input.expectedManifestSha256) fail('MANIFEST_DIGEST_MISMATCH');
  const controlPath = join(input.candidatePath, 'installation-candidate.control');
  assertCandidateFile(controlPath, input.expectedUid);
  if (digest(readFileSync(controlPath)) !== input.expectedControlSha256)
    fail('CONTROL_DIGEST_MISMATCH');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('MANIFEST_INVALID');
  }
  assertManifest(manifest, input.candidateSha, input.expectedControlSha256);
  if (artifactSetSha256(manifest.artifactFiles) !== input.expectedArtifactSetSha256)
    fail('ARTIFACT_SET_DIGEST_MISMATCH');
  for (const file of manifest.artifactFiles) {
    const path = join(input.candidatePath, file.artifactPath);
    assertCandidateFile(path, input.expectedUid);
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('PAYLOAD_INVALID');
  }
  return { manifest };
}

function canonicalReceipt(input, manifest) {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 'communities-role-split-code-installation-receipt-v2',
        candidateCommitSha: input.candidateSha,
        manifestSha256: input.expectedManifestSha256,
        controlSha256: input.expectedControlSha256,
        artifactSetSha256: input.expectedArtifactSetSha256,
        status: 'INSTALLED_DISABLED',
        targetRoot: manifest.installation.targetRoot,
        authorizesCeremony: false,
        authorizesDatabaseMutation: false,
        authorizesRoleSplit: false,
        authorizesMigration: false,
        authorizesDeploy: false,
        authorizesActivation: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export function installCommunitiesRoleSplitDisabledCandidate(input) {
  const expectedUid = input.expectedUid ?? process.geteuid?.();
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) fail('UID_INVALID');
  const { manifest } = readAndVerifyCandidate({ ...input, expectedUid });
  const targetPath = resolveInstalledPath(input.installationRoot, manifest.installation.targetRoot);
  const targetParent = dirname(targetPath);
  assertDirectory(
    input.installationRoot,
    expectedUid,
    input.installationRoot === '/' ? 0o755 : 0o700,
  );
  ensureParentChain(targetParent, expectedUid, input.installationRoot);
  const lockPath = join(targetParent, `.install-${input.candidateSha}.lock`);
  let lockFd;
  try {
    lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    fail('INSTALLATION_LOCKED');
  }
  try {
    if (existsSync(targetPath)) fail('TARGET_EXISTS');
    const temporaryPath = join(targetParent, `.${input.candidateSha}.incomplete`);
    if (existsSync(temporaryPath)) fail('INCOMPLETE_EXISTS');
    mkdirSync(temporaryPath, { mode: 0o755 });
    for (const file of manifest.artifactFiles) {
      const relativeTarget = file.targetPath.slice(`${manifest.installation.targetRoot}/`.length);
      const destination = join(temporaryPath, relativeTarget);
      ensureParentChain(dirname(destination), expectedUid, temporaryPath);
      copyFileSync(
        join(input.candidatePath, file.artifactPath),
        destination,
        constants.COPYFILE_EXCL,
      );
      const mode = Number.parseInt(file.installMode, 8);
      // copyFile preserves candidate mode 0600. Validate and set the reviewed final mode through
      // one no-follow descriptor before the version directory is published.
      const writeFd = openSync(destination, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(writeFd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== expectedUid)
          fail('TARGET_CUSTODY_INVALID');
        fchmodSync(writeFd, mode);
        fsyncSync(writeFd);
      } finally {
        closeSync(writeFd);
      }
      const installedBytes = readFileSync(destination);
      if (installedBytes.length !== file.bytes || digest(installedBytes) !== file.sha256)
        fail('TARGET_READBACK_INVALID');
    }
    const receipt = canonicalReceipt(input, manifest);
    const receiptPath = join(temporaryPath, completeReceiptName);
    writeFileSync(receiptPath, receipt, { flag: 'wx', mode: 0o444 });
    const receiptFd = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(receiptFd);
    } finally {
      closeSync(receiptFd);
    }
    fsyncDirectory(temporaryPath);
    renameSync(temporaryPath, targetPath);
    fsyncDirectory(targetParent);
    return { targetPath, receiptSha256: digest(receipt) };
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

export function verifyCommunitiesRoleSplitDisabledInstallation(input) {
  const expectedUid = input.expectedUid ?? process.geteuid?.();
  const { manifest } = readAndVerifyCandidate({ ...input, expectedUid });
  const targetPath = resolveInstalledPath(input.installationRoot, manifest.installation.targetRoot);
  assertDirectory(targetPath, expectedUid, 0o755);
  for (const file of manifest.artifactFiles) {
    const relativeTarget = file.targetPath.slice(`${manifest.installation.targetRoot}/`.length);
    const installed = join(targetPath, relativeTarget);
    assertCandidateFile(installed, expectedUid, Number.parseInt(file.installMode, 8));
    const bytes = readFileSync(installed);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      fail('INSTALLED_PAYLOAD_INVALID');
  }
  const receiptPath = join(targetPath, completeReceiptName);
  assertCandidateFile(receiptPath, expectedUid, 0o444);
  const expectedReceipt = canonicalReceipt(input, manifest);
  if (!readFileSync(receiptPath).equals(expectedReceipt)) fail('RECEIPT_INVALID');
  return { targetPath, receiptSha256: digest(expectedReceipt) };
}

function parseCli(args) {
  if (
    args.length !== 11 ||
    !['install', 'verify'].includes(args[0]) ||
    args[1] !== '--candidate' ||
    args[3] !== '--candidate-sha' ||
    args[5] !== '--manifest-sha256' ||
    args[7] !== '--control-sha256' ||
    args[9] !== '--artifact-set-sha256'
  )
    fail('USAGE');
  return {
    action: args[0],
    candidatePath: args[2],
    candidateSha: args[4],
    expectedManifestSha256: args[6],
    expectedControlSha256: args[8],
    expectedArtifactSetSha256: args[10],
    installationRoot: '/',
    expectedUid: 0,
  };
}

function main() {
  if (process.geteuid?.() !== 0) fail('ROOT_REQUIRED');
  const input = parseCli(process.argv.slice(2));
  const result =
    input.action === 'install'
      ? installCommunitiesRoleSplitDisabledCandidate(input)
      : verifyCommunitiesRoleSplitDisabledInstallation(input);
  process.stdout.write(
    `COMMUNITIES_ROLE_SPLIT_CODE_${input.action.toUpperCase()}_PASSED|candidate=${input.candidateSha}|receipt=${result.receiptSha256}|status=disabled|authorizes_ceremony=false|authorizes_database_mutation=false\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'UNKNOWN'}\n`);
    process.exitCode = 1;
  }
}
