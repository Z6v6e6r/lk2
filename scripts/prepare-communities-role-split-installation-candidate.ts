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
  'communities-role-split-installation-candidate-v2';
export const INSTALLATION_CANDIDATE_DIGEST_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_V2';

const sha40Pattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitExecutable = '/usr/bin/git';
const maxGitBlobBytes = 2 * 1024 * 1024;
const manifestName = 'installation-candidate.json';
const digestName = 'installation-candidate.sha256';

type ReviewOnlyArtifactDefinition = {
  readonly sourcePath: string;
  readonly artifactPath: string;
  readonly targetPath: null;
  readonly action: 'REVIEW_ONLY';
  readonly installOwner: null;
  readonly installGroup: null;
  readonly installMode: null;
  readonly purpose: string;
};

type ExistingArtifactDefinition = {
  readonly sourcePath: string;
  readonly artifactPath: string;
  readonly targetPath: string;
  readonly action: 'VERIFY_EXISTING';
  readonly installOwner: 'root';
  readonly installGroup: 'root';
  readonly installMode: '0755';
  readonly purpose: string;
};

type CandidateArtifactDefinition = ReviewOnlyArtifactDefinition | ExistingArtifactDefinition;

export type CandidateArtifactFile = CandidateArtifactDefinition & {
  readonly bytes: number;
  readonly sha256: string;
};

export type CommunitiesRoleSplitInstallationCandidate = {
  readonly schemaVersion: typeof INSTALLATION_CANDIDATE_SCHEMA_VERSION;
  readonly candidateCommitSha: string;
  readonly sourceRepository: 'https://github.com/Z6v6e6r/lk2.git';
  readonly status: 'REVIEW_ONLY';
  readonly installable: false;
  readonly reasonCode: 'CODE_AND_EXTERNAL_BINDINGS_REQUIRED';
  readonly artifactFiles: readonly CandidateArtifactFile[];
  readonly directories: readonly {
    readonly path: string;
    readonly owner: 'root' | 'phub-preflight';
    readonly group: 'phub-preflight';
    readonly mode: '0700' | '0750';
    readonly purpose: string;
  }[];
  readonly forcedCommandSurface: {
    readonly principal: 'phub-preflight';
    readonly options: readonly ['restrict'];
    readonly command: null;
    readonly commandIncluded: false;
    readonly reviewedSourcePath: 'deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh';
    readonly publicKeyIncluded: false;
    readonly authorizedKeysMutationIncluded: false;
    readonly status: 'BLOCKED_PENDING_CANONICAL_HOST_ADAPTER';
    readonly cleanupCommandExposure: 'NOT_EXPOSED';
  };
  readonly unresolvedBindings: readonly {
    readonly code: string;
    readonly status: 'UNRESOLVED';
  }[];
  readonly knownCustodyConflict: {
    readonly code: 'BACKUP_CUSTODY_HANDOFF_REQUIRED';
    readonly producer: {
      readonly principal: 'phub-preflight';
      readonly directoryOwner: 'phub-preflight';
      readonly directoryMode: '0700';
      readonly archiveOwner: 'phub-preflight';
      readonly archiveMode: '0600';
    };
    readonly ceremony: {
      readonly directoryOwner: 'root';
      readonly directoryGroup: 'phub-preflight';
      readonly directoryMode: '0750';
      readonly archiveOwner: 'root';
      readonly archiveGroup: 'phub-preflight';
      readonly archiveMode: '0440';
    };
    readonly requiredResolution: 'SEPARATE_ROOT_OWNED_ATOMIC_HANDOFF';
    readonly resolutionIncluded: false;
  };
  readonly authorizes: {
    readonly installation: false;
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
    sourcePath: 'deploy/jetson/prepare-communities-role-split-inventory-clone.sh',
    artifactPath: 'review-source/deploy/jetson/prepare-communities-role-split-inventory-clone.sh',
    targetPath: null,
    action: 'REVIEW_ONLY',
    installOwner: null,
    installGroup: null,
    installMode: null,
    purpose: 'source evidence only; no target path or installation authority',
  },
  {
    sourcePath: 'deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh',
    artifactPath:
      'review-source/deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh',
    targetPath: null,
    action: 'REVIEW_ONLY',
    installOwner: null,
    installGroup: null,
    installMode: null,
    purpose: 'rejected legacy host contour; not an installation payload',
  },
  {
    sourcePath: 'deploy/jetson/cleanup-communities-role-split-restore-marker-clone.sh',
    artifactPath:
      'review-source/deploy/jetson/cleanup-communities-role-split-restore-marker-clone.sh',
    targetPath: null,
    action: 'REVIEW_ONLY',
    installOwner: null,
    installGroup: null,
    installMode: null,
    purpose: 'reconciliation source evidence only; no command exposure',
  },
  {
    sourcePath: 'deploy/jetson/verify-postgres-backup-restore.sh',
    artifactPath: 'reference/usr/local/libexec/phub/verify-postgres-backup-restore.sh',
    targetPath: '/usr/local/libexec/phub/verify-postgres-backup-restore.sh',
    action: 'VERIFY_EXISTING',
    installOwner: 'root',
    installGroup: 'root',
    installMode: '0755',
    purpose: 'exact existing restore-helper dependency; no overwrite authority',
  },
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

function gitBlob(repositoryRoot: string, candidateSha: string, sourcePath: string): Buffer {
  const treeEntry = gitText(repositoryRoot, ['ls-tree', candidateSha, '--', sourcePath]);
  if (
    gitText(repositoryRoot, ['cat-file', '-t', `${candidateSha}:${sourcePath}`]) !== 'blob' ||
    !new RegExp(`^100755 blob [0-9a-f]{40}\\t${sourcePath.replaceAll('.', '\\.')}$$`, 'u').test(
      treeEntry,
    )
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

function createManifest(
  repositoryRoot: string,
  candidateSha: string,
): {
  readonly manifest: CommunitiesRoleSplitInstallationCandidate;
  readonly blobs: Map<string, Buffer>;
} {
  const blobs = new Map<string, Buffer>();
  const artifactFiles = fileDefinitions.map((definition) => {
    const bytes = gitBlob(repositoryRoot, candidateSha, definition.sourcePath);
    blobs.set(definition.artifactPath, bytes);
    return { ...definition, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    blobs,
    manifest: {
      schemaVersion: INSTALLATION_CANDIDATE_SCHEMA_VERSION,
      candidateCommitSha: candidateSha,
      sourceRepository: 'https://github.com/Z6v6e6r/lk2.git',
      status: 'REVIEW_ONLY',
      installable: false,
      reasonCode: 'CODE_AND_EXTERNAL_BINDINGS_REQUIRED',
      artifactFiles,
      directories: [
        {
          path: '/var/lib/phub-preflight/role-split-marker-requests',
          owner: 'root',
          group: 'phub-preflight',
          mode: '0750',
          purpose: 'root-staged request, runtime binding and creation receipt files',
        },
        {
          path: '/var/lib/phub-preflight/role-split-marker-cleanup-requests',
          owner: 'root',
          group: 'phub-preflight',
          mode: '0750',
          purpose: 'root-staged cleanup reconciliation requests',
        },
        {
          path: '/var/lib/phub-preflight/role-split-marker-state',
          owner: 'phub-preflight',
          group: 'phub-preflight',
          mode: '0700',
          purpose: 'exclusive lease and durable ceremony state',
        },
      ],
      forcedCommandSurface: {
        principal: 'phub-preflight',
        options: ['restrict'],
        command: null,
        commandIncluded: false,
        reviewedSourcePath: 'deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh',
        publicKeyIncluded: false,
        authorizedKeysMutationIncluded: false,
        status: 'BLOCKED_PENDING_CANONICAL_HOST_ADAPTER',
        cleanupCommandExposure: 'NOT_EXPOSED',
      },
      unresolvedBindings: unresolvedBindingCodes.map((code) => ({ code, status: 'UNRESOLVED' })),
      knownCustodyConflict: {
        code: 'BACKUP_CUSTODY_HANDOFF_REQUIRED',
        producer: {
          principal: 'phub-preflight',
          directoryOwner: 'phub-preflight',
          directoryMode: '0700',
          archiveOwner: 'phub-preflight',
          archiveMode: '0600',
        },
        ceremony: {
          directoryOwner: 'root',
          directoryGroup: 'phub-preflight',
          directoryMode: '0750',
          archiveOwner: 'root',
          archiveGroup: 'phub-preflight',
          archiveMode: '0440',
        },
        requiredResolution: 'SEPARATE_ROOT_OWNED_ATOMIC_HANDOFF',
        resolutionIncluded: false,
      },
      authorizes: {
        installation: false,
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
  artifactFiles: readonly CandidateArtifactFile[],
): Buffer {
  return Buffer.from(
    [
      INSTALLATION_CANDIDATE_DIGEST_VERSION,
      `candidateCommitSha=${candidateSha}`,
      `manifestSha256=${sha256(manifest)}`,
      `artifactSetSha256=${artifactSetSha256(artifactFiles)}`,
      'installable=false',
      'authorizesInstallation=false',
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
  const entries = new Set<string>([digestName, manifestName]);
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
}): { readonly manifestSha256: string; readonly artifactSetSha256: string } {
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
  for (const file of manifest.artifactFiles) {
    ensureArtifactParents(temporaryPath, file.artifactPath);
    writePrivateFile(join(temporaryPath, file.artifactPath), blobs.get(file.artifactPath)!);
  }
  writePrivateFile(join(temporaryPath, manifestName), serializedManifest);
  writePrivateFile(
    join(temporaryPath, digestName),
    digestBytes(input.candidateSha, serializedManifest, manifest.artifactFiles),
  );
  renameSync(temporaryPath, outputPath);
  return {
    manifestSha256: sha256(serializedManifest),
    artifactSetSha256: artifactSetSha256(manifest.artifactFiles),
  };
}

export function verifyCommunitiesRoleSplitInstallationCandidate(input: {
  readonly repositoryRoot: string;
  readonly candidateSha: string;
  readonly candidatePath: string;
}): { readonly manifestSha256: string; readonly artifactSetSha256: string } {
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
  const expectedFiles = [
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
    manifest.artifactFiles,
  );
  if (!readFileSync(join(candidatePath, digestName)).equals(expectedDigest)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_INVALID');
  }
  const manifestDigest = sha256(serializedManifest);
  const artifactDigest = artifactSetSha256(manifest.artifactFiles);
  if (!sha256Pattern.test(manifestDigest) || !sha256Pattern.test(artifactDigest)) {
    fail('COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_DIGEST_INVALID');
  }
  return { manifestSha256: manifestDigest, artifactSetSha256: artifactDigest };
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
    `COMMUNITIES_ROLE_SPLIT_INSTALLATION_CANDIDATE_${input.action.toUpperCase()}_PASSED|candidate=${input.candidateSha}|manifest=${result.manifestSha256}|artifacts=${result.artifactSetSha256}|installable=false|authorizes_installation=false|authorizes_ceremony=false\n`,
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
