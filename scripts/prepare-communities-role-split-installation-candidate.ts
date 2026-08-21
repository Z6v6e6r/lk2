import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLATION_CANDIDATE_SCHEMA_VERSION =
  'communities-role-split-installation-candidate-v8';
export const INSTALLATION_CANDIDATE_DIGEST_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_V8';
export const INSTALLATION_CANDIDATE_CONTROL_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_HOST_INSTALL_CONTROL_V5';

const sha40Pattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitExecutable = '/usr/bin/git';
const maxGitBlobBytes = 2 * 1024 * 1024;
const manifestName = 'installation-candidate.json';
const digestName = 'installation-candidate.sha256';
const controlName = 'installation-candidate.control';

type CandidateArtifactDefinition = {
  readonly sourcePath: string;
  readonly sourceGitMode: '100644' | '100755';
  readonly artifactPath: string;
  readonly targetRelativePath: string;
  readonly action: 'INSTALL_NEW';
  readonly installOwner: 'root';
  readonly installGroup: 'root';
  readonly installMode: '0444' | '0755';
  readonly purpose: string;
};

export type CandidateArtifactFile = Omit<CandidateArtifactDefinition, 'targetRelativePath'> & {
  readonly targetPath: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type CommunitiesRoleSplitInstallationCandidate = {
  readonly schemaVersion: typeof INSTALLATION_CANDIDATE_SCHEMA_VERSION;
  readonly candidateCommitSha: string;
  readonly sourceRepository: 'https://github.com/Z6v6e6r/lk2.git';
  readonly status: 'INSTALLABLE_DISABLED';
  readonly installable: true;
  readonly reasonCode: 'RUNTIME_BINDINGS_REQUIRED';
  readonly hostInstaller: {
    readonly runtime: 'POSIX_SH_GNU_COREUTILS';
    readonly entrypoint: 'payload/installer.sh';
    readonly controlFile: typeof controlName;
    readonly controlSha256: string;
    readonly nodeRequired: false;
  };
  readonly artifactFiles: readonly CandidateArtifactFile[];
  readonly installation: {
    readonly targetRoot: string;
    readonly atomicNewVersionOnly: true;
    readonly existingTargetPolicy: 'REFUSE';
    readonly activationLinkIncluded: false;
    readonly runtimeConfigurationIncluded: false;
  };
  readonly forcedCommandSurface: {
    readonly principal: 'phub-preflight';
    readonly options: readonly ['restrict'];
    readonly command: null;
    readonly commandIncluded: false;
    readonly publicKeyIncluded: false;
    readonly authorizedKeysMutationIncluded: false;
    readonly status: 'NOT_INSTALLED';
    readonly cleanupCommandExposure: 'NOT_EXPOSED';
  };
  readonly executionBindings: readonly {
    readonly code: string;
    readonly status: 'REQUIRED_FOR_EXECUTION';
    readonly blocksInstallation: false;
  }[];
  readonly authorizes: {
    readonly installation: true;
    readonly keyProvisioning: false;
    readonly workflowWiring: false;
    readonly stagingAccess: false;
    readonly databaseMutation: false;
    readonly ceremony: false;
    readonly cleanup: false;
    readonly roleSplit: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
};

const fileDefinitions: readonly CandidateArtifactDefinition[] = [
  {
    sourcePath: 'deploy/jetson/install-communities-role-split-disabled-candidate.sh',
    sourceGitMode: '100755',
    artifactPath: 'payload/installer.sh',
    targetRelativePath: 'installer.sh',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0755',
    purpose: 'dependency-free verifier and new-version-only installer; no execution authority',
  },
  {
    sourcePath: 'deploy/jetson/communities-role-split-disabled-command.sh',
    sourceGitMode: '100755',
    artifactPath: 'payload/disabled-command.sh',
    targetRelativePath: 'disabled-command.sh',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0755',
    purpose: 'fail-closed command that always rejects ceremony execution',
  },
  {
    sourcePath: 'apps/migrator/src/communities-staging-role-split-canonical-host-adapter.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/canonical-host-adapter.ts',
    targetRelativePath: 'source/canonical-host-adapter.ts',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'canonical host source snapshot; not a runtime entrypoint',
  },
  {
    sourcePath: 'apps/migrator/src/communities-staging-role-split-canonical-pg-collaborators.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/canonical-pg-collaborators.ts',
    targetRelativePath: 'source/canonical-pg-collaborators.ts',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'clone-only connection, DDL fence and marker-writer source snapshot',
  },
  {
    sourcePath: 'apps/migrator/src/communities-staging-role-split-ddl-fence.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/communities-staging-role-split-ddl-fence.ts',
    targetRelativePath: 'source/communities-staging-role-split-ddl-fence.ts',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'canonical runner DDL fence snapshot; non-runnable source artifact',
  },
  ...[
    'communities-staging-role-split-file-evidence-sink.ts',
    'communities-staging-role-split-host-authorization-loader.ts',
    'communities-staging-role-split-runner-adapter.ts',
    'communities-staging-role-split-pg-restore-runner.ts',
    'root-owned-evidence.ts',
  ].map((name): CandidateArtifactDefinition => ({
    sourcePath: `apps/migrator/src/${name}`,
    sourceGitMode: '100644',
    artifactPath: `payload/source/${name}`,
    targetRelativePath: `source/${name}`,
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'reviewed source snapshot; deliberately unwired and non-runnable',
  })),
  {
    sourcePath: 'packages/database/src/communities-staging-role-split-inventory-preparation.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/communities-staging-role-split-inventory-preparation-database.ts',
    targetRelativePath: 'source/communities-staging-role-split-inventory-preparation-database.ts',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'disabled canonical inventory-preparation contract snapshot; not a runtime entrypoint',
  },
  {
    sourcePath: 'apps/migrator/src/communities-staging-role-split-inventory-preparation.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/communities-staging-role-split-inventory-preparation-verifier.ts',
    targetRelativePath: 'source/communities-staging-role-split-inventory-preparation-verifier.ts',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'disabled inventory-preparation verifier snapshot; deliberately unwired',
  },
  {
    sourcePath: 'apps/migrator/src/verify-communities-staging-role-split-inventory-preparation.ts',
    sourceGitMode: '100644',
    artifactPath: 'payload/source/verify-communities-staging-role-split-inventory-preparation.ts',
    targetRelativePath: 'source/verify-communities-staging-role-split-inventory-preparation.ts',
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'disabled preparation CLI source snapshot; Node runtime and execution wiring absent',
  },
  ...[
    'communities-staging-role-split-v3-durable-host.ts',
    'communities-staging-role-split-v3-durable-continuation-host.ts',
    'communities-staging-role-split-v3-pg-restore-executor.ts',
    'communities-staging-role-split-v3-durable-restore-coordinator.ts',
    'communities-staging-role-split-v3-executable-composition.ts',
  ].map((name): CandidateArtifactDefinition => ({
    sourcePath: `apps/migrator/src/${name}`,
    sourceGitMode: '100644',
    artifactPath: `payload/source/${name}`,
    targetRelativePath: `source/${name}`,
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'reviewed V3 code-only source snapshot; deliberately unwired and non-runnable',
  })),
  ...[
    'communities-staging-role-split-v3-contract.ts',
    'communities-staging-role-split-v3-envelope.ts',
    'communities-staging-role-split-v3-restore-authorization.ts',
    'communities-staging-role-split-v3-durable-restore-authorization.ts',
    'communities-staging-role-split-v3-durable-state-envelope.ts',
    'communities-staging-role-split-v3-durable-continuation-envelope.ts',
    'communities-staging-role-split-v3-execution-authorization.ts',
    'communities-staging-role-split-v3-attested-evidence.ts',
  ].map((name): CandidateArtifactDefinition => ({
    sourcePath: `packages/database/src/${name}`,
    sourceGitMode: '100644',
    artifactPath: `payload/source/${name}`,
    targetRelativePath: `source/${name}`,
    action: 'INSTALL_NEW',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0444',
    purpose: 'reviewed V3 authorization source snapshot; deliberately unwired and non-runnable',
  })),
] as const;

const unresolvedBindingCodes = [
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
] as const;

function fail(code: string): never {
  throw new Error(code);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
  };
}

function gitText(repositoryRoot: string, args: readonly string[]): string {
  try {
    return execFileSync(gitExecutable, ['--no-replace-objects', '-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      env: gitEnvironment(),
      maxBuffer: maxGitBlobBytes,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_GIT_FAILED');
  }
}

function gitBlob(
  repositoryRoot: string,
  candidateSha: string,
  sourcePath: string,
  sourceGitMode: CandidateArtifactDefinition['sourceGitMode'],
): Buffer {
  const treeEntry = gitText(repositoryRoot, ['ls-tree', candidateSha, '--', sourcePath]);
  if (
    gitText(repositoryRoot, ['cat-file', '-t', `${candidateSha}:${sourcePath}`]) !== 'blob' ||
    !new RegExp(
      `^${sourceGitMode} blob [0-9a-f]{40}\\t${sourcePath.replaceAll('.', '\\.')}$$`,
      'u',
    ).test(treeEntry)
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SOURCE_NOT_BLOB');
  }
  try {
    const bytes = execFileSync(
      gitExecutable,
      ['--no-replace-objects', '-C', repositoryRoot, 'show', `${candidateSha}:${sourcePath}`],
      {
        encoding: 'buffer',
        env: gitEnvironment(),
        maxBuffer: maxGitBlobBytes,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (bytes.length === 0 || bytes.length > maxGitBlobBytes) {
      fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SOURCE_SIZE_INVALID');
    }
    return bytes;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SOURCE_SIZE_INVALID'
    ) {
      throw error;
    }
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_GIT_FAILED');
  }
}

function assertRepository(repositoryRoot: string, candidateSha: string): string {
  if (!sha40Pattern.test(candidateSha)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SHA_INVALID');
  }
  if (!isAbsolute(repositoryRoot)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_REPOSITORY_INVALID');
  }
  const resolved = resolve(repositoryRoot);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_REPOSITORY_INVALID');
  }
  if (
    canonical !== resolved ||
    gitText(canonical, ['rev-parse', '--show-toplevel']) !== canonical
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_REPOSITORY_INVALID');
  }
  if (
    gitText(canonical, ['config', '--local', '--get', 'remote.origin.url']) !==
    'https://github.com/Z6v6e6r/lk2.git'
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_REPOSITORY_ORIGIN_INVALID');
  }
  if (
    gitText(canonical, ['cat-file', '-t', candidateSha]) !== 'commit' ||
    gitText(canonical, ['rev-parse', `${candidateSha}^{commit}`]) !== candidateSha
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SHA_INVALID');
  }
  if (gitText(canonical, ['for-each-ref', '--format=%(refname)', 'refs/replace']) !== '') {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_GIT_REPLACE_REFS_FORBIDDEN');
  }
  return canonical;
}

function artifactSetSha256(artifactFiles: readonly CandidateArtifactFile[]): string {
  const bytes = artifactFiles
    .map((file) => `${file.artifactPath}\0${file.sha256}\0${file.bytes}\n`)
    .join('');
  return sha256(bytes);
}

function controlBytes(
  candidateSha: string,
  artifactFiles: readonly CandidateArtifactFile[],
): Buffer {
  const targetRoot = `/usr/local/libexec/phub/communities-role-split/candidates/${candidateSha}`;
  return Buffer.from(
    [
      INSTALLATION_CANDIDATE_CONTROL_VERSION,
      `candidateCommitSha=${candidateSha}`,
      `artifactSetSha256=${artifactSetSha256(artifactFiles)}`,
      `artifactCount=${artifactFiles.length}`,
      'installable=true',
      'authorizesInstallation=true',
      'authorizesCeremony=false',
      'authorizesDatabaseMutation=false',
      ...artifactFiles.map((file) => {
        const targetRelativePath = file.targetPath.slice(`${targetRoot}/`.length);
        return `artifact=${file.artifactPath}|${targetRelativePath}|${file.installMode}|${file.bytes}|${file.sha256}`;
      }),
      '',
    ].join('\n'),
    'utf8',
  );
}

function createManifest(
  repositoryRoot: string,
  candidateSha: string,
): {
  readonly manifest: CommunitiesRoleSplitInstallationCandidate;
  readonly blobs: Map<string, Buffer>;
} {
  const blobs = new Map<string, Buffer>();
  const artifactFiles = fileDefinitions.map((definition) => {
    const bytes = gitBlob(
      repositoryRoot,
      candidateSha,
      definition.sourcePath,
      definition.sourceGitMode,
    );
    blobs.set(definition.artifactPath, bytes);
    const { targetRelativePath, ...artifactDefinition } = definition;
    return {
      ...artifactDefinition,
      targetPath: `/usr/local/libexec/phub/communities-role-split/candidates/${candidateSha}/${targetRelativePath}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const serializedControl = controlBytes(candidateSha, artifactFiles);
  return {
    blobs,
    manifest: {
      schemaVersion: INSTALLATION_CANDIDATE_SCHEMA_VERSION,
      candidateCommitSha: candidateSha,
      sourceRepository: 'https://github.com/Z6v6e6r/lk2.git',
      status: 'INSTALLABLE_DISABLED',
      installable: true,
      reasonCode: 'RUNTIME_BINDINGS_REQUIRED',
      hostInstaller: {
        runtime: 'POSIX_SH_GNU_COREUTILS',
        entrypoint: 'payload/installer.sh',
        controlFile: controlName,
        controlSha256: sha256(serializedControl),
        nodeRequired: false,
      },
      artifactFiles,
      installation: {
        targetRoot: `/usr/local/libexec/phub/communities-role-split/candidates/${candidateSha}`,
        atomicNewVersionOnly: true,
        existingTargetPolicy: 'REFUSE',
        activationLinkIncluded: false,
        runtimeConfigurationIncluded: false,
      },
      forcedCommandSurface: {
        principal: 'phub-preflight',
        options: ['restrict'],
        command: null,
        commandIncluded: false,
        publicKeyIncluded: false,
        authorizedKeysMutationIncluded: false,
        status: 'NOT_INSTALLED',
        cleanupCommandExposure: 'NOT_EXPOSED',
      },
      executionBindings: unresolvedBindingCodes.map((code) => ({
        code,
        status: 'REQUIRED_FOR_EXECUTION',
        blocksInstallation: false,
      })),
      authorizes: {
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
      },
    },
  };
}

function manifestBytes(manifest: CommunitiesRoleSplitInstallationCandidate): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function digestBytes(
  candidateSha: string,
  manifest: Buffer,
  control: Buffer,
  artifactFiles: readonly CandidateArtifactFile[],
): Buffer {
  return Buffer.from(
    [
      INSTALLATION_CANDIDATE_DIGEST_VERSION,
      `candidateCommitSha=${candidateSha}`,
      `manifestSha256=${sha256(manifest)}`,
      `controlSha256=${sha256(control)}`,
      `artifactSetSha256=${artifactSetSha256(artifactFiles)}`,
      'installable=true',
      'authorizesInstallation=true',
      'authorizesCeremony=false',
      '',
    ].join('\n'),
    'utf8',
  );
}

function assertPrivateParent(outputPath: string, candidateSha: string): string {
  if (
    !isAbsolute(outputPath) ||
    basename(outputPath) !== `communities-role-split-installation-candidate-${candidateSha}`
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_INVALID');
  }
  const parent = dirname(resolve(outputPath));
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parent);
  } catch {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_PARENT_INVALID');
  }
  if (canonicalParent !== parent) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_PARENT_INVALID');
  }
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o077) !== 0
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_PARENT_INVALID');
  }
  return resolve(outputPath);
}

function writePrivateFile(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const fileStat = lstatSync(path);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.nlink !== 1 ||
    fileStat.uid !== process.getuid?.() ||
    (fileStat.mode & 0o777) !== 0o600
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_CUSTODY_INVALID');
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  const directoryStat = lstatSync(path);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o777) !== 0o700
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_CUSTODY_INVALID');
  }
}

function ensureArtifactParents(candidateRoot: string, artifactPath: string): void {
  const segments = dirname(artifactPath).split('/');
  let current = candidateRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const existing = lstatSync(current);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_CUSTODY_INVALID');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_CUSTODY_INVALID'
      ) {
        throw error;
      }
      ensurePrivateDirectory(current);
    }
  }
}

function walkCandidate(root: string, current = root): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');
    const entryStat = lstatSync(path);
    if (entryStat.isSymbolicLink()) {
      fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_SYMLINK_FORBIDDEN');
    }
    if (entryStat.isDirectory()) {
      if (entryStat.uid !== process.getuid?.() || (entryStat.mode & 0o777) !== 0o700) {
        fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_CUSTODY_INVALID');
      }
      found.push(`${relativePath}/`);
      found.push(...walkCandidate(root, path));
    } else if (entryStat.isFile()) {
      found.push(relativePath);
    } else {
      fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_ENTRY_INVALID');
    }
  }
  return found.sort();
}

function expectedCandidateEntries(
  artifactFiles: readonly CandidateArtifactFile[],
): readonly string[] {
  const entries = new Set<string>([controlName, digestName, manifestName]);
  for (const file of artifactFiles) {
    entries.add(file.artifactPath);
    const segments = dirname(file.artifactPath).split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      entries.add(`${segments.slice(0, index).join('/')}/`);
    }
  }
  return [...entries].sort();
}

export function buildCommunitiesRoleSplitInstallationCandidate(input: {
  readonly repositoryRoot: string;
  readonly candidateSha: string;
  readonly outputPath: string;
}): {
  readonly manifestSha256: string;
  readonly controlSha256: string;
  readonly artifactSetSha256: string;
} {
  const repositoryRoot = assertRepository(input.repositoryRoot, input.candidateSha);
  const outputPath = assertPrivateParent(input.outputPath, input.candidateSha);
  try {
    lstatSync(outputPath);
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_EXISTS');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_EXISTS'
    ) {
      throw error;
    }
  }
  const temporaryPath = `${outputPath}.incomplete`;
  try {
    lstatSync(temporaryPath);
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_EXISTS');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_OUTPUT_EXISTS'
    ) {
      throw error;
    }
  }
  ensurePrivateDirectory(temporaryPath);
  const { manifest, blobs } = createManifest(repositoryRoot, input.candidateSha);
  const serializedManifest = manifestBytes(manifest);
  const serializedControl = controlBytes(input.candidateSha, manifest.artifactFiles);
  for (const file of manifest.artifactFiles) {
    ensureArtifactParents(temporaryPath, file.artifactPath);
    writePrivateFile(join(temporaryPath, file.artifactPath), blobs.get(file.artifactPath)!);
  }
  writePrivateFile(join(temporaryPath, manifestName), serializedManifest);
  writePrivateFile(join(temporaryPath, controlName), serializedControl);
  writePrivateFile(
    join(temporaryPath, digestName),
    digestBytes(input.candidateSha, serializedManifest, serializedControl, manifest.artifactFiles),
  );
  renameSync(temporaryPath, outputPath);
  return {
    manifestSha256: sha256(serializedManifest),
    controlSha256: sha256(serializedControl),
    artifactSetSha256: artifactSetSha256(manifest.artifactFiles),
  };
}

export function verifyCommunitiesRoleSplitInstallationCandidate(input: {
  readonly repositoryRoot: string;
  readonly candidateSha: string;
  readonly candidatePath: string;
}): {
  readonly manifestSha256: string;
  readonly controlSha256: string;
  readonly artifactSetSha256: string;
} {
  const repositoryRoot = assertRepository(input.repositoryRoot, input.candidateSha);
  const candidatePath = resolve(input.candidatePath);
  if (!isAbsolute(input.candidatePath) || realpathSync(candidatePath) !== candidatePath) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_PATH_INVALID');
  }
  const candidateStat = lstatSync(candidatePath);
  if (
    !candidateStat.isDirectory() ||
    candidateStat.isSymbolicLink() ||
    candidateStat.uid !== process.getuid?.() ||
    (candidateStat.mode & 0o777) !== 0o700
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_CUSTODY_INVALID');
  }
  const { manifest, blobs } = createManifest(repositoryRoot, input.candidateSha);
  const serializedManifest = manifestBytes(manifest);
  const serializedControl = controlBytes(input.candidateSha, manifest.artifactFiles);
  const expectedFiles = [
    controlName,
    digestName,
    manifestName,
    ...manifest.artifactFiles.map((file) => file.artifactPath),
  ].sort();
  if (
    JSON.stringify(walkCandidate(candidatePath)) !==
    JSON.stringify(expectedCandidateEntries(manifest.artifactFiles))
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_FILE_SET_INVALID');
  }
  for (const relativePath of expectedFiles) {
    const path = join(candidatePath, relativePath);
    const fileStat = lstatSync(path);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.nlink !== 1 ||
      fileStat.uid !== process.getuid?.() ||
      (fileStat.mode & 0o777) !== 0o600
    ) {
      fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_CUSTODY_INVALID');
    }
  }
  if (!readFileSync(join(candidatePath, manifestName)).equals(serializedManifest)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_MANIFEST_INVALID');
  }
  if (!readFileSync(join(candidatePath, controlName)).equals(serializedControl)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_CONTROL_INVALID');
  }
  for (const file of manifest.artifactFiles) {
    if (
      !readFileSync(join(candidatePath, file.artifactPath)).equals(blobs.get(file.artifactPath)!)
    ) {
      fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_PAYLOAD_INVALID');
    }
  }
  const expectedDigest = digestBytes(
    input.candidateSha,
    serializedManifest,
    serializedControl,
    manifest.artifactFiles,
  );
  if (!readFileSync(join(candidatePath, digestName)).equals(expectedDigest)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_INVALID');
  }
  const manifestDigest = sha256(serializedManifest);
  const controlDigest = sha256(serializedControl);
  const artifactDigest = artifactSetSha256(manifest.artifactFiles);
  if (
    !sha256Pattern.test(manifestDigest) ||
    !sha256Pattern.test(controlDigest) ||
    !sha256Pattern.test(artifactDigest)
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_INVALID');
  }
  return {
    manifestSha256: manifestDigest,
    controlSha256: controlDigest,
    artifactSetSha256: artifactDigest,
  };
}

function parseCliArguments(args: readonly string[]): {
  readonly action: 'build' | 'verify';
  readonly repositoryRoot: string;
  readonly candidateSha: string;
  readonly candidatePath: string;
} {
  const action = args[0];
  if (action !== 'build' && action !== 'verify') {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_USAGE');
  }
  const expectedPathFlag = action === 'build' ? '--output' : '--candidate';
  if (
    args.length !== 7 ||
    args[1] !== '--repository' ||
    args[3] !== '--candidate-sha' ||
    args[5] !== expectedPathFlag
  ) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_USAGE');
  }
  return {
    action,
    repositoryRoot: args[2]!,
    candidateSha: args[4]!,
    candidatePath: args[6]!,
  };
}

function main(): void {
  const input = parseCliArguments(process.argv.slice(2));
  const result =
    input.action === 'build'
      ? buildCommunitiesRoleSplitInstallationCandidate({
          repositoryRoot: input.repositoryRoot,
          candidateSha: input.candidateSha,
          outputPath: input.candidatePath,
        })
      : verifyCommunitiesRoleSplitInstallationCandidate({
          repositoryRoot: input.repositoryRoot,
          candidateSha: input.candidateSha,
          candidatePath: input.candidatePath,
        });
  process.stdout.write(
    `COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_${input.action.toUpperCase()}_PASSED|candidate=${input.candidateSha}|manifest=${result.manifestSha256}|control=${result.controlSha256}|artifacts=${result.artifactSetSha256}|installable=true|authorizes_installation=true|authorizes_ceremony=false\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
