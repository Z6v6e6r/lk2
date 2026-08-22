import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt,
  communitiesRoleSplitCanonicalJson,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryReceipt,
  type CommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  type CommunitiesStagingRoleSplitTrustedInventoryReceipt,
} from '@phub/database';

import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';
import {
  verifyCommunitiesStagingRoleSplitInventoryArtifact,
  type CommunitiesStagingRoleSplitInventoryArtifactVerification,
} from './communities-staging-role-split-inventory-artifact.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 4 * 1024;
const MAX_PRODUCER_BYTES = 64 * 1024 * 1024;

export class CommunitiesStagingRoleSplitTrustedInventoryHostError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_INVALID'
      | 'AUTHORIZATION_INVALID'
      | 'PREPARATION_INVALID'
      | 'DESCRIPTOR_CUSTODY_INVALID'
      | 'DIRECTORY_UNSAFE'
      | 'OUTPUT_CONFLICT'
      | 'COLLECTION_TIMEOUT'
      | 'COLLECTION_FAILED'
      | 'ARTIFACT_INVALID'
      | 'PUBLICATION_AMBIGUOUS',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_HOST_${code}`);
    this.name = 'CommunitiesStagingRoleSplitTrustedInventoryHostError';
  }
}

function fail(code: CommunitiesStagingRoleSplitTrustedInventoryHostError['code']): never {
  throw new CommunitiesStagingRoleSplitTrustedInventoryHostError(code);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pathSha256(path: string): string {
  return sha256(`${path}\n`);
}

function canonicalPath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function preparationInput(
  preparation: CommunitiesStagingRoleSplitInventoryPreparation,
  code: 'CONNECTION_DESCRIPTOR',
): { readonly contentSha256: string } {
  const input = preparation.inputs.find((entry) => entry.code === code);
  if (!input) fail('PREPARATION_INVALID');
  return input;
}

export type CommunitiesStagingRoleSplitTrustedInventoryCollectorOutcome = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

export interface CommunitiesStagingRoleSplitTrustedInventoryCollector {
  readonly run: (input: {
    readonly signal: AbortSignal;
    readonly credentialFile: FileHandle;
    readonly producerFile: FileHandle;
    readonly connectionDescriptor: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;
  }) => Promise<CommunitiesStagingRoleSplitTrustedInventoryCollectorOutcome>;
  readonly terminate: (signal: 'SIGTERM' | 'SIGKILL') => Promise<void>;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryOutputStore {
  readArtifact(): Promise<Buffer | null>;
  readReceipt(): Promise<Buffer | null>;
  publishArtifact(bytes: Buffer): Promise<void>;
  publishReceipt(bytes: Buffer): Promise<void>;
}

export type CommunitiesStagingRoleSplitTrustedInventoryDescriptorValidator = (input: {
  readonly credentialFile: FileHandle;
  readonly producerFile: FileHandle;
  readonly expectedProducerSha256: string;
}) => Promise<void>;

type DescriptorObservation = {
  readonly fd: number;
  readonly stat: Stats;
  readonly flags: number;
};

async function descriptorObservation(handle: FileHandle): Promise<DescriptorObservation> {
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) fail('DESCRIPTOR_CUSTODY_INVALID');
  try {
    const [stat, fdInfo] = await Promise.all([
      handle.stat(),
      readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8'),
    ]);
    const matches = [...fdInfo.matchAll(/^flags:\s+([0-7]+)$/gmu)];
    const flags = matches.length === 1 ? Number.parseInt(matches[0]![1]!, 8) : Number.NaN;
    if (!Number.isSafeInteger(flags)) fail('DESCRIPTOR_CUSTODY_INVALID');
    return { fd: handle.fd, stat, flags };
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryHostError) throw error;
    fail('DESCRIPTOR_CUSTODY_INVALID');
  }
}

async function sha256Handle(handle: FileHandle, maximumBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) return hash.digest('hex');
      offset += bytesRead;
      if (offset > maximumBytes) fail('DESCRIPTOR_CUSTODY_INVALID');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryHostError) throw error;
    fail('DESCRIPTOR_CUSTODY_INVALID');
  }
}

export async function assertCommunitiesStagingRoleSplitTrustedInventoryDescriptors(input: {
  readonly credentialFile: FileHandle;
  readonly producerFile: FileHandle;
  readonly expectedProducerSha256: string;
}): Promise<void> {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== 0 ||
    !SHA256.test(input.expectedProducerSha256)
  )
    fail('DESCRIPTOR_CUSTODY_INVALID');
  const [credential, producer] = await Promise.all([
    descriptorObservation(input.credentialFile),
    descriptorObservation(input.producerFile),
  ]);
  if (
    (credential.flags & 0o3) !== constants.O_RDONLY ||
    !credential.stat.isFile() ||
    credential.stat.isSymbolicLink() ||
    credential.stat.uid !== 0 ||
    credential.stat.nlink !== 1 ||
    (credential.stat.mode & 0o777) !== 0o400 ||
    credential.stat.size < 1 ||
    credential.stat.size > MAX_CREDENTIAL_BYTES ||
    (producer.flags & 0o3) !== constants.O_RDONLY ||
    !producer.stat.isFile() ||
    producer.stat.isSymbolicLink() ||
    producer.stat.uid !== 0 ||
    producer.stat.nlink !== 1 ||
    (producer.stat.mode & 0o777) !== 0o444 ||
    producer.stat.size < 1 ||
    producer.stat.size > MAX_PRODUCER_BYTES ||
    (await sha256Handle(input.producerFile, MAX_PRODUCER_BYTES)) !== input.expectedProducerSha256
  )
    fail('DESCRIPTOR_CUSTODY_INVALID');
}

function verifyPreparation(input: {
  readonly preparation: CommunitiesStagingRoleSplitInventoryPreparation;
  readonly verification: CommunitiesStagingRoleSplitInventoryPreparationVerification;
  readonly authorization: CommunitiesStagingRoleSplitTrustedInventoryAuthorization;
  readonly connectionDescriptor: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;
}): void {
  const preparationSha256 = communitiesStagingRoleSplitInventoryPreparationSha256(
    input.preparation,
  );
  const connectionSha256 = communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(
    input.connectionDescriptor,
  );
  const expectedVerification: CommunitiesStagingRoleSplitInventoryPreparationVerification = {
    schemaVersion: 'communities-staging-role-split-inventory-preparation-verification-v1',
    status: 'PREPARATION_VERIFIED_REVIEW_ONLY',
    candidateCommitSha: input.preparation.candidateCommitSha,
    phase: input.preparation.phase,
    preparationSha256,
    requestSha256: input.preparation.requestSha256,
    creationReceiptSha256: input.preparation.creationReceiptSha256,
    inputCount: 8,
    outputArtifactPathSha256: input.preparation.outputArtifactPathSha256,
    bindings: {
      callerSuppliedPreparationPinMatched: true,
      canonicalPreparationBytes: true,
      exactInputPathSetMatched: true,
      exactInputContentSetMatched: true,
      markerRequestEvidenceMatched: true,
      roleMappingShapeValidated: true,
      outputArtifactPathMatched: true,
    },
    limitations: {
      organizationalIndependenceNotAttested: true,
      cleanCloneProvenanceSemanticsNotAttested: true,
      connectionDescriptorSemanticsNotAttested: true,
      credentialCustodySemanticsNotAttested: true,
      executableCustodySemanticsNotAttested: true,
      outputCustodySemanticsNotAttested: true,
      parentDirectoryCustodyNotAttested: true,
      outputAbsenceNotAttested: true,
      databaseNotConnected: true,
      artifactNotCreated: true,
    },
    authorizes: {
      inventoryConnection: false,
      inventoryRead: false,
      artifactWrite: false,
      trustedInventoryDesignation: false,
      roleCreation: false,
      roleSplit: false,
      aclMutation: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  };
  if (
    communitiesRoleSplitCanonicalJson(input.verification) !==
      communitiesRoleSplitCanonicalJson(expectedVerification) ||
    input.authorization.candidateCommitSha !== input.preparation.candidateCommitSha ||
    input.authorization.phase !== input.preparation.phase ||
    input.authorization.preparationSha256 !== preparationSha256 ||
    input.authorization.connectionDescriptorSha256 !== connectionSha256 ||
    preparationInput(input.preparation, 'CONNECTION_DESCRIPTOR').contentSha256 !==
      connectionSha256 ||
    input.connectionDescriptor.markerRequestSha256 !== input.preparation.requestSha256 ||
    input.connectionDescriptor.markerEvidenceSha256 !==
      input.preparation.inputs.find((entry) => entry.code === 'MARKER_EVIDENCE')?.contentSha256 ||
    input.connectionDescriptor.roleMappingSha256 !==
      input.preparation.inputs.find((entry) => entry.code === 'ROLE_MAPPING')?.contentSha256
  )
    fail('PREPARATION_INVALID');
}

async function boundedCollection(input: {
  readonly collector: CommunitiesStagingRoleSplitTrustedInventoryCollector;
  readonly authorization: CommunitiesStagingRoleSplitTrustedInventoryAuthorization;
  readonly credentialFile: FileHandle;
  readonly producerFile: FileHandle;
  readonly connectionDescriptor: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;
}): Promise<CommunitiesStagingRoleSplitTrustedInventoryCollectorOutcome> {
  const abortController = new AbortController();
  const run = Promise.resolve().then(() =>
    input.collector.run({
      signal: abortController.signal,
      credentialFile: input.credentialFile,
      producerFile: input.producerFile,
      connectionDescriptor: input.connectionDescriptor,
    }),
  );
  let timeout: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    run.then(
      (outcome) => ({ kind: 'outcome' as const, outcome }),
      () => ({ kind: 'collector-failure' as const }),
    ),
    new Promise<{ readonly kind: 'timeout' }>((resolveTimeout) => {
      timeout = setTimeout(
        () => resolveTimeout({ kind: 'timeout' }),
        input.authorization.collectionTimeoutMillis,
      );
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (first.kind === 'outcome') return first.outcome;

  abortController.abort();
  await input.collector.terminate('SIGTERM').catch(() => undefined);
  let grace: NodeJS.Timeout | undefined;
  const afterTerm = await Promise.race([
    run.then(
      () => 'exited' as const,
      () => 'exited' as const,
    ),
    new Promise<'grace'>((resolveGrace) => {
      grace = setTimeout(() => resolveGrace('grace'), input.authorization.terminationGraceMillis);
    }),
  ]);
  if (grace !== undefined) clearTimeout(grace);
  if (afterTerm === 'grace') {
    await input.collector.terminate('SIGKILL').catch(() => undefined);
    await run.catch(() => undefined);
  }
  fail(first.kind === 'timeout' ? 'COLLECTION_TIMEOUT' : 'COLLECTION_FAILED');
}

function verifyArtifact(bytes: Buffer): CommunitiesStagingRoleSplitInventoryArtifactVerification {
  if (bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) fail('ARTIFACT_INVALID');
  try {
    return verifyCommunitiesStagingRoleSplitInventoryArtifact(bytes, sha256(bytes));
  } catch {
    fail('ARTIFACT_INVALID');
  }
}

function receiptFor(input: {
  readonly authorization: CommunitiesStagingRoleSplitTrustedInventoryAuthorization;
  readonly authorizationSha256: string;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
}): CommunitiesStagingRoleSplitTrustedInventoryReceipt {
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-receipt-v1',
    status: 'COLLECTED_READ_ONLY_REVIEW_EVIDENCE',
    candidateCommitSha: input.authorization.candidateCommitSha,
    phase: input.authorization.phase,
    preparationSha256: input.authorization.preparationSha256,
    authorizationSha256: input.authorizationSha256,
    connectionDescriptorSha256: input.authorization.connectionDescriptorSha256,
    producerExecutableSha256: input.authorization.producerExecutableSha256,
    artifactSha256: input.artifactSha256,
    manifestSha256: input.manifestSha256,
    outputArtifactPathSha256: input.authorization.outputArtifactPathSha256,
    outputReceiptPathSha256: input.authorization.outputReceiptPathSha256,
    bindings: {
      preparationVerified: true,
      independentlySourcedCloneClaimBound: true,
      credentialDescriptorValidatorCompleted: true,
      producerDescriptorValidatorCompleted: true,
      processExitedZero: true,
      processStderrEmpty: true,
      readOnlyProducerBoundaryBound: true,
      artifactCanonicalReadback: true,
      receiptCanonicalReadback: true,
    },
    limitations: {
      hostCollaboratorCompositionNotAttested: true,
      independentArtifactPinNotAttested: true,
      organizationalIndependenceNotAttested: true,
      cleanCloneProvenanceSemanticsNotAttested: true,
      trustedInventoryDesignationNotGranted: true,
    },
    authorizes: {
      trustedInventoryDesignation: false,
      roleCreation: false,
      roleSplit: false,
      aclMutation: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  };
}

function verifyExisting(input: {
  readonly artifact: Buffer;
  readonly receipt: Buffer;
  readonly authorization: CommunitiesStagingRoleSplitTrustedInventoryAuthorization;
  readonly authorizationSha256: string;
}): CommunitiesStagingRoleSplitTrustedInventoryReceipt {
  try {
    const verification = verifyArtifact(input.artifact);
    const text = input.receipt.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(input.receipt)) fail('OUTPUT_CONFLICT');
    const receipt = parseCommunitiesStagingRoleSplitTrustedInventoryReceipt(text);
    const expected = receiptFor({
      authorization: input.authorization,
      authorizationSha256: input.authorizationSha256,
      artifactSha256: verification.artifactSha256,
      manifestSha256: verification.manifestSha256,
    });
    if (
      canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt(receipt) !==
      canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt(expected)
    )
      fail('OUTPUT_CONFLICT');
    return receipt;
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryHostError) throw error;
    fail('OUTPUT_CONFLICT');
  }
}

export async function runCommunitiesStagingRoleSplitTrustedInventory(input: {
  readonly preparation: CommunitiesStagingRoleSplitInventoryPreparation;
  readonly preparationVerification: CommunitiesStagingRoleSplitInventoryPreparationVerification;
  readonly authorization: CommunitiesStagingRoleSplitTrustedInventoryAuthorization;
  readonly expectedAuthorizationSha256: string;
  readonly connectionDescriptor: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;
  readonly outputDirectoryPath: string;
  readonly outputArtifactPath: string;
  readonly outputReceiptPath: string;
  readonly credentialFile: FileHandle;
  readonly producerFile: FileHandle;
  readonly collector: CommunitiesStagingRoleSplitTrustedInventoryCollector;
  readonly outputStore: CommunitiesStagingRoleSplitTrustedInventoryOutputStore;
  readonly validateDescriptors?: CommunitiesStagingRoleSplitTrustedInventoryDescriptorValidator;
}): Promise<CommunitiesStagingRoleSplitTrustedInventoryReceipt> {
  const authorizationSha256 = communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(
    input.authorization,
  );
  if (
    !SHA256.test(input.expectedAuthorizationSha256) ||
    input.expectedAuthorizationSha256 !== authorizationSha256 ||
    !canonicalPath(input.outputDirectoryPath) ||
    !canonicalPath(input.outputArtifactPath) ||
    !canonicalPath(input.outputReceiptPath) ||
    dirname(input.outputArtifactPath) !== input.outputDirectoryPath ||
    dirname(input.outputReceiptPath) !== input.outputDirectoryPath ||
    input.outputArtifactPath === input.outputReceiptPath ||
    pathSha256(input.outputDirectoryPath) !== input.authorization.outputDirectoryPathSha256 ||
    pathSha256(input.outputArtifactPath) !== input.authorization.outputArtifactPathSha256 ||
    pathSha256(input.outputReceiptPath) !== input.authorization.outputReceiptPathSha256
  )
    fail('AUTHORIZATION_INVALID');
  verifyPreparation({
    preparation: input.preparation,
    verification: input.preparationVerification,
    authorization: input.authorization,
    connectionDescriptor: input.connectionDescriptor,
  });
  const validateDescriptors =
    input.validateDescriptors ?? assertCommunitiesStagingRoleSplitTrustedInventoryDescriptors;
  await validateDescriptors({
    credentialFile: input.credentialFile,
    producerFile: input.producerFile,
    expectedProducerSha256: input.authorization.producerExecutableSha256,
  });

  const [existingArtifact, existingReceipt] = await Promise.all([
    input.outputStore.readArtifact(),
    input.outputStore.readReceipt(),
  ]);
  if (existingArtifact !== null || existingReceipt !== null) {
    if (existingArtifact === null || existingReceipt === null) fail('OUTPUT_CONFLICT');
    return verifyExisting({
      artifact: existingArtifact,
      receipt: existingReceipt,
      authorization: input.authorization,
      authorizationSha256,
    });
  }

  const outcome = await boundedCollection({
    collector: input.collector,
    authorization: input.authorization,
    credentialFile: input.credentialFile,
    producerFile: input.producerFile,
    connectionDescriptor: input.connectionDescriptor,
  });
  if (
    outcome.exitCode !== 0 ||
    outcome.signal !== null ||
    outcome.stderr.length !== 0 ||
    outcome.stdout.length < 1 ||
    outcome.stdout.length > MAX_ARTIFACT_BYTES
  )
    fail('COLLECTION_FAILED');
  await validateDescriptors({
    credentialFile: input.credentialFile,
    producerFile: input.producerFile,
    expectedProducerSha256: input.authorization.producerExecutableSha256,
  });
  const verification = verifyArtifact(outcome.stdout);
  const receipt = receiptFor({
    authorization: input.authorization,
    authorizationSha256,
    artifactSha256: verification.artifactSha256,
    manifestSha256: verification.manifestSha256,
  });
  const receiptBytes = Buffer.from(
    canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt(receipt),
    'utf8',
  );
  try {
    await input.outputStore.publishArtifact(outcome.stdout);
    await input.outputStore.publishReceipt(receiptBytes);
    const [artifactReadback, receiptReadback] = await Promise.all([
      input.outputStore.readArtifact(),
      input.outputStore.readReceipt(),
    ]);
    if (
      artifactReadback === null ||
      receiptReadback === null ||
      !artifactReadback.equals(outcome.stdout) ||
      !receiptReadback.equals(receiptBytes)
    )
      fail('PUBLICATION_AMBIGUOUS');
    return verifyExisting({
      artifact: artifactReadback,
      receipt: receiptReadback,
      authorization: input.authorization,
      authorizationSha256,
    });
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryHostError) throw error;
    fail('PUBLICATION_AMBIGUOUS');
  }
}

type DirectoryIdentity = Pick<Stats, 'dev' | 'ino' | 'uid' | 'mode'> & {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export function assertCommunitiesStagingRoleSplitTrustedInventoryOutputDirectory(input: {
  readonly initialPath: DirectoryIdentity;
  readonly initialHandle: DirectoryIdentity;
  readonly finalHandle: DirectoryIdentity;
  readonly finalPath: DirectoryIdentity;
  readonly effectiveUid: number;
}): void {
  const { initialPath, initialHandle, finalHandle, finalPath } = input;
  if (
    input.effectiveUid !== 0 ||
    !initialPath.isDirectory() ||
    initialPath.isSymbolicLink() ||
    !initialHandle.isDirectory() ||
    initialHandle.isSymbolicLink() ||
    initialHandle.uid !== 0 ||
    (initialHandle.mode & 0o777) !== 0o700 ||
    initialPath.dev !== initialHandle.dev ||
    initialPath.ino !== initialHandle.ino ||
    finalHandle.dev !== initialHandle.dev ||
    finalHandle.ino !== initialHandle.ino ||
    finalHandle.uid !== initialHandle.uid ||
    finalHandle.mode !== initialHandle.mode ||
    finalPath.dev !== initialHandle.dev ||
    finalPath.ino !== initialHandle.ino
  )
    fail('DIRECTORY_UNSAFE');
}

export class CommunitiesStagingRoleSplitTrustedInventoryFileOutputStore implements CommunitiesStagingRoleSplitTrustedInventoryOutputStore {
  private readonly artifactName: string;
  private readonly receiptName: string;

  constructor(
    private readonly directory: string,
    artifactPath: string,
    receiptPath: string,
  ) {
    if (
      !canonicalPath(directory) ||
      !canonicalPath(artifactPath) ||
      !canonicalPath(receiptPath) ||
      dirname(artifactPath) !== directory ||
      dirname(receiptPath) !== directory ||
      artifactPath === receiptPath
    )
      fail('CONFIG_INVALID');
    this.artifactName = basename(artifactPath);
    this.receiptName = basename(receiptPath);
  }

  private async withPinnedDirectory<T>(
    operation: (descriptorRoot: string, sync: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let handle: FileHandle | undefined;
    try {
      if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('DIRECTORY_UNSAFE');
      const initialPath = await lstat(this.directory);
      handle = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const initialHandle = await handle.stat();
      assertCommunitiesStagingRoleSplitTrustedInventoryOutputDirectory({
        initialPath,
        initialHandle,
        finalHandle: initialHandle,
        finalPath: initialPath,
        effectiveUid: process.getuid(),
      });
      const result = await operation(`/proc/self/fd/${handle.fd}`, () => handle!.sync());
      assertCommunitiesStagingRoleSplitTrustedInventoryOutputDirectory({
        initialPath,
        initialHandle,
        finalHandle: await handle.stat(),
        finalPath: await lstat(this.directory),
        effectiveUid: process.getuid(),
      });
      return result;
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryHostError) throw error;
      return fail('DIRECTORY_UNSAFE');
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  private async read(name: string, maximumBytes: number): Promise<Buffer | null> {
    return this.withPinnedDirectory(async (root) => {
      const path = join(root, name);
      try {
        await lstat(path);
      } catch (error) {
        if ((error as { readonly code?: string }).code === 'ENOENT') return null;
        fail('OUTPUT_CONFLICT');
      }
      try {
        return await readRootOwnedEvidence(path, maximumBytes);
      } catch {
        fail('OUTPUT_CONFLICT');
      }
    });
  }

  private async publish(name: string, expected: Buffer, maximumBytes: number): Promise<void> {
    if (expected.length < 1 || expected.length > maximumBytes) fail('PUBLICATION_AMBIGUOUS');
    await this.withPinnedDirectory(async (root, syncDirectory) => {
      const target = join(root, name);
      const existing = await this.read(name, maximumBytes);
      if (existing !== null) {
        if (existing.equals(expected)) return;
        fail('OUTPUT_CONFLICT');
      }
      const temporary = join(root, `.${name}.${randomBytes(16).toString('hex')}.tmp`);
      let created = false;
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o400,
        );
        created = true;
        try {
          await file.writeFile(expected);
          await file.sync();
        } finally {
          await file.close();
        }
        await link(temporary, target);
        await unlink(temporary);
        created = false;
        await syncDirectory();
      } catch (error) {
        if ((error as { readonly code?: string }).code === 'EEXIST') {
          const observed = await this.read(name, maximumBytes);
          if (observed?.equals(expected)) return;
          fail('OUTPUT_CONFLICT');
        }
        fail('PUBLICATION_AMBIGUOUS');
      } finally {
        if (created) await unlink(temporary).catch(() => undefined);
      }
      const readback = await this.read(name, maximumBytes);
      if (!readback?.equals(expected)) fail('PUBLICATION_AMBIGUOUS');
    });
  }

  readArtifact(): Promise<Buffer | null> {
    return this.read(this.artifactName, MAX_ARTIFACT_BYTES);
  }

  readReceipt(): Promise<Buffer | null> {
    return this.read(this.receiptName, MAX_RECEIPT_BYTES);
  }

  publishArtifact(bytes: Buffer): Promise<void> {
    return this.publish(this.artifactName, bytes, MAX_ARTIFACT_BYTES);
  }

  publishReceipt(bytes: Buffer): Promise<void> {
    return this.publish(this.receiptName, bytes, MAX_RECEIPT_BYTES);
  }
}

export function communitiesStagingRoleSplitTrustedInventoryReceiptText(
  receipt: CommunitiesStagingRoleSplitTrustedInventoryReceipt,
): string {
  return `${communitiesRoleSplitCanonicalJson(receipt)}\n`;
}
