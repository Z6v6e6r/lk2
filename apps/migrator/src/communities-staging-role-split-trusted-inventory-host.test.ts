import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  communitiesRoleSplitInputCArtifactText,
  communitiesRoleSplitInputCManifestSha256,
  communitiesRoleSplitMappingSha256,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitMappingArtifact,
  type CommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '@phub/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';
import {
  assertCommunitiesStagingRoleSplitTrustedInventoryOutputDirectory,
  runCommunitiesStagingRoleSplitTrustedInventory,
  type CommunitiesStagingRoleSplitTrustedInventoryCollector,
  type CommunitiesStagingRoleSplitTrustedInventoryOutputStore,
} from './communities-staging-role-split-trusted-inventory-host.js';

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const candidateCommitSha = 'a'.repeat(40);
const outputDirectoryPath = '/inventory';
const outputArtifactPath = '/inventory/before.json';
const outputReceiptPath = '/inventory/before.receipt.json';
const fakeFile = {} as FileHandle;

function mapping(): CommunitiesRoleSplitMappingArtifact {
  const categories = COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => ({
    category,
    roleNameSha256: sha(`role:${category}`),
    roleOidSha256: sha(`oid:${category}`),
    capabilities: {
      canLogin: false,
      superuser: false,
      bypassRls: false,
      createDatabase: false,
      createRole: false,
      replication: false,
    },
    evidenceSha256: sha(`mapping:${category}`),
  }));
  const identityRelations = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.map(
    ([left, right, requirement]) => ({
      left,
      right,
      requirement,
      relation: 'DISTINCT' as const,
      evidenceSha256: sha(`relation:${left}:${right}`),
    }),
  );
  const draft = {
    schemaVersion: COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION,
    categories,
    identityRelations,
  } satisfies Omit<CommunitiesRoleSplitMappingArtifact, 'mappingDigest'>;
  return { ...draft, mappingDigest: communitiesRoleSplitMappingSha256(draft) };
}

function artifact(): Buffer {
  const roleMapping = mapping();
  const normalized = Object.fromEntries(
    COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES.map((category) => [category, []]),
  ) as unknown as CommunitiesRoleSplitInputC['normalized'];
  const draft = {
    schemaVersion: COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
    canonicalizationVersion: COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
    sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
    provenance: {
      contractVersion: 'communities-role-split-clone-marker-evidence-v2',
      markerDigest: sha('marker'),
      markerEvidenceDigest: sha('marker-evidence'),
      requestDigest: sha('request'),
      creationReceiptSha256: sha('receipt'),
      cloneNamePatternValid: true,
      cloneOidBound: true,
      sourceOidBound: true,
      systemIdentifierDigest: sha('system'),
      pgMajor: 16,
      objectManifestDigest: sha('object-manifest'),
      ledgerDigest: sha('ledger'),
      ledgerCount: 1,
      mappingDigest: roleMapping.mappingDigest,
    },
    mapping: roleMapping,
    normalized,
    anomalies: [],
    forbiddenCodeContract: COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
    manifestSha256: '0'.repeat(64),
    authorizes: {
      roleCreation: false,
      roleRepair: false,
      roleSplit: false,
      aclMutation: false,
      schemaMutation: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  } satisfies CommunitiesRoleSplitInputC;
  const input = { ...draft, manifestSha256: communitiesRoleSplitInputCManifestSha256(draft) };
  return Buffer.from(communitiesRoleSplitInputCArtifactText(input), 'utf8');
}

const connectionDescriptor = {
  schemaVersion: 'communities-staging-role-split-trusted-inventory-connection-v1',
  sourceKind: 'INDEPENDENTLY_SOURCED_CLEAN_CLONE',
  host: 'postgres',
  port: 5432,
  database: 'phub_restore_123_4',
  user: 'inventory_reader',
  sslMode: 'disable',
  passwordTransport: 'FD_3',
  defaultTransactionReadOnly: true,
  applicationName: 'phub-communities-role-split-input-c-v1',
  connectTimeoutMillis: 10_000,
  statementTimeoutMillis: 30_000,
  lockTimeoutMillis: 5_000,
  markerRequestSha256: sha('request'),
  markerEvidenceSha256: sha('marker-evidence'),
  roleMappingSha256: sha('role-mapping'),
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;

function preparation(): CommunitiesStagingRoleSplitInventoryPreparation {
  const contentByCode = {
    MARKER_REQUEST: connectionDescriptor.markerRequestSha256,
    MARKER_EVIDENCE: connectionDescriptor.markerEvidenceSha256,
    ROLE_MAPPING: connectionDescriptor.roleMappingSha256,
    INDEPENDENT_SOURCE_PROVENANCE: sha('source-provenance'),
    CONNECTION_DESCRIPTOR:
      communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(connectionDescriptor),
    CREDENTIAL_CUSTODY: sha('credential-custody'),
    EXECUTABLE_CUSTODY: sha('executable-custody'),
    OUTPUT_CUSTODY: sha('output-custody'),
  } as const;
  return {
    schemaVersion: 'communities-staging-role-split-inventory-preparation-v1',
    status: 'CODE_ONLY_DISABLED',
    candidateCommitSha,
    phase: 'BEFORE',
    requestSha256: connectionDescriptor.markerRequestSha256,
    creationReceiptSha256: sha('creation-receipt'),
    cloneDatabaseOid: '123',
    sourceDatabaseOid: '456',
    systemIdentifier: '1234567890123456789',
    inputs: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.map((code) => ({
      code,
      pathSha256: sha(`/evidence/${code}\n`),
      contentSha256: contentByCode[code],
    })),
    outputArtifactPathSha256: sha(`${outputArtifactPath}\n`),
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
}

function preparationVerification(
  value: CommunitiesStagingRoleSplitInventoryPreparation,
): CommunitiesStagingRoleSplitInventoryPreparationVerification {
  return {
    schemaVersion: 'communities-staging-role-split-inventory-preparation-verification-v1',
    status: 'PREPARATION_VERIFIED_REVIEW_ONLY',
    candidateCommitSha: value.candidateCommitSha,
    phase: value.phase,
    preparationSha256: communitiesStagingRoleSplitInventoryPreparationSha256(value),
    requestSha256: value.requestSha256,
    creationReceiptSha256: value.creationReceiptSha256,
    inputCount: 8,
    outputArtifactPathSha256: value.outputArtifactPathSha256,
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
}

function authorization(
  value: CommunitiesStagingRoleSplitInventoryPreparation,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-v1',
    status: 'AUTHORIZED_READ_ONLY_CLEAN_CLONE_INVENTORY',
    candidateCommitSha,
    phase: 'BEFORE',
    preparationSha256: communitiesStagingRoleSplitInventoryPreparationSha256(value),
    connectionDescriptorSha256:
      communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(connectionDescriptor),
    producerExecutableSha256: sha('producer'),
    outputDirectoryPathSha256: sha(`${outputDirectoryPath}\n`),
    outputArtifactPathSha256: sha(`${outputArtifactPath}\n`),
    outputReceiptPathSha256: sha(`${outputReceiptPath}\n`),
    collectionTimeoutMillis: 45_000,
    terminationGraceMillis: 5_000,
    authorizes: {
      inventoryConnection: true,
      inventoryRead: true,
      artifactWrite: true,
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

class MemoryStore implements CommunitiesStagingRoleSplitTrustedInventoryOutputStore {
  artifact: Buffer | null = null;
  receipt: Buffer | null = null;
  artifactPublications = 0;
  receiptPublications = 0;

  readArtifact(): Promise<Buffer | null> {
    return Promise.resolve(this.artifact);
  }

  readReceipt(): Promise<Buffer | null> {
    return Promise.resolve(this.receipt);
  }

  publishArtifact(bytes: Buffer): Promise<void> {
    this.artifactPublications += 1;
    if (this.artifact !== null && !this.artifact.equals(bytes)) throw new Error('conflict');
    this.artifact = Buffer.from(bytes);
    return Promise.resolve();
  }

  publishReceipt(bytes: Buffer): Promise<void> {
    this.receiptPublications += 1;
    if (this.receipt !== null && !this.receipt.equals(bytes)) throw new Error('conflict');
    this.receipt = Buffer.from(bytes);
    return Promise.resolve();
  }
}

function successfulCollector(
  bytes = artifact(),
): CommunitiesStagingRoleSplitTrustedInventoryCollector {
  return {
    run: vi.fn(() =>
      Promise.resolve({ exitCode: 0, signal: null, stdout: bytes, stderr: Buffer.alloc(0) }),
    ),
    terminate: vi.fn(() => Promise.resolve()),
  };
}

function runInput(input?: {
  readonly store?: MemoryStore;
  readonly collector?: CommunitiesStagingRoleSplitTrustedInventoryCollector;
  readonly authorization?: CommunitiesStagingRoleSplitTrustedInventoryAuthorization;
}) {
  const prepared = preparation();
  const authorized = input?.authorization ?? authorization(prepared);
  return {
    prepared,
    authorized,
    store: input?.store ?? new MemoryStore(),
    collector: input?.collector ?? successfulCollector(),
  };
}

async function execute(
  input: ReturnType<typeof runInput>,
  verification = preparationVerification(input.prepared),
) {
  return runCommunitiesStagingRoleSplitTrustedInventory({
    preparation: input.prepared,
    preparationVerification: verification,
    authorization: input.authorized,
    expectedAuthorizationSha256: communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(
      input.authorized,
    ),
    connectionDescriptor,
    outputDirectoryPath,
    outputArtifactPath,
    outputReceiptPath,
    credentialFile: fakeFile,
    producerFile: fakeFile,
    collector: input.collector,
    outputStore: input.store,
    validateDescriptors: vi.fn(() => Promise.resolve()),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('trusted role-split inventory host', () => {
  it('publishes canonical artifact and non-authorizing receipt with exact readback', async () => {
    const input = runInput();
    const receipt = await execute(input);

    expect(input.collector.run).toHaveBeenCalledTimes(1);
    expect(input.store.artifactPublications).toBe(1);
    expect(input.store.receiptPublications).toBe(1);
    expect(receipt.status).toBe('COLLECTED_READ_ONLY_REVIEW_EVIDENCE');
    expect(receipt.bindings.readOnlyProducerBoundaryBound).toBe(true);
    expect(receipt.limitations.hostCollaboratorCompositionNotAttested).toBe(true);
    expect(Object.values(receipt.authorizes)).toEqual(Array(8).fill(false));
  });

  it('reconciles exact existing output without recollecting', async () => {
    const first = runInput();
    const receipt = await execute(first);
    const replayCollector = successfulCollector(Buffer.from('must not run'));
    const replay = runInput({ store: first.store, collector: replayCollector });

    await expect(execute(replay)).resolves.toEqual(receipt);
    expect(replayCollector.run).not.toHaveBeenCalled();
    expect(first.store.artifactPublications).toBe(1);
    expect(first.store.receiptPublications).toBe(1);
  });

  it('refuses one-sided output and never retries collection after response loss', async () => {
    const store = new MemoryStore();
    store.artifact = artifact();
    const collector = successfulCollector();
    const input = runInput({ store, collector });

    await expect(execute(input)).rejects.toThrow(/OUTPUT_CONFLICT/u);
    expect(collector.run).not.toHaveBeenCalled();
  });

  it('rejects output authorization drift before collection', async () => {
    const prepared = preparation();
    const drifted = {
      ...authorization(prepared),
      outputArtifactPathSha256: sha('/inventory/different.json\n'),
    };
    const collector = successfulCollector();
    const input = runInput({ authorization: drifted, collector });

    await expect(execute(input)).rejects.toThrow(/AUTHORIZATION_INVALID/u);
    expect(collector.run).not.toHaveBeenCalled();
  });

  it('rejects a widened preparation verification before collection', async () => {
    const input = runInput();
    const verification = preparationVerification(input.prepared);
    const widened = {
      ...verification,
      authorizes: {
        ...verification.authorizes,
        inventoryConnection: true as false,
      },
    };

    await expect(execute(input, widened)).rejects.toThrow(/PREPARATION_INVALID/u);
    expect(input.collector.run).not.toHaveBeenCalled();
  });

  it('rejects noncanonical producer output before publication', async () => {
    const store = new MemoryStore();
    const collector = successfulCollector(Buffer.concat([artifact(), Buffer.from(' ')]));

    await expect(execute(runInput({ store, collector }))).rejects.toThrow(/ARTIFACT_INVALID/u);
    expect(store.artifactPublications).toBe(0);
    expect(store.receiptPublications).toBe(0);
  });

  it('aborts and terminates a rejected collector before returning failure', async () => {
    const collector = {
      run: vi.fn(() => Promise.reject(new Error('collector failed after start'))),
      terminate: vi.fn(() => Promise.resolve()),
    };
    const store = new MemoryStore();

    await expect(execute(runInput({ store, collector }))).rejects.toThrow(/COLLECTION_FAILED/u);
    expect(collector.terminate.mock.calls).toEqual([['SIGTERM']]);
    expect(store.artifactPublications).toBe(0);
    expect(store.receiptPublications).toBe(0);
  });

  it('aborts, terminates and escalates a timed-out collector without publishing', async () => {
    vi.useFakeTimers();
    let resolveRun:
      | ((
          value: Awaited<ReturnType<CommunitiesStagingRoleSplitTrustedInventoryCollector['run']>>,
        ) => void)
      | undefined;
    const run = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<CommunitiesStagingRoleSplitTrustedInventoryCollector['run']>>
        >((resolve) => {
          resolveRun = resolve;
        }),
    );
    const terminate = vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGKILL')
        resolveRun?.({
          exitCode: null,
          signal: 'SIGKILL',
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        });
      return Promise.resolve();
    });
    const collector = { run, terminate };
    const store = new MemoryStore();
    const result = execute(runInput({ store, collector }));
    const rejection = expect(result).rejects.toThrow(/COLLECTION_TIMEOUT/u);

    await vi.advanceTimersByTimeAsync(45_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(terminate.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(store.artifactPublications).toBe(0);
    expect(store.receiptPublications).toBe(0);
  });

  it('rejects path substitution and custody drift for the pinned output directory', () => {
    const directory = (
      overrides: Partial<{ dev: number; ino: number; uid: number; mode: number }> = {},
    ) => ({
      dev: 1,
      ino: 2,
      uid: 0,
      mode: 0o40700,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      ...overrides,
    });

    expect(() =>
      assertCommunitiesStagingRoleSplitTrustedInventoryOutputDirectory({
        initialPath: directory(),
        initialHandle: directory(),
        finalHandle: directory(),
        finalPath: directory({ ino: 3 }),
        effectiveUid: 0,
      }),
    ).toThrow(/DIRECTORY_UNSAFE/u);
    expect(() =>
      assertCommunitiesStagingRoleSplitTrustedInventoryOutputDirectory({
        initialPath: directory(),
        initialHandle: directory({ mode: 0o40755 }),
        finalHandle: directory({ mode: 0o40755 }),
        finalPath: directory(),
        effectiveUid: 0,
      }),
    ).toThrow(/DIRECTORY_UNSAFE/u);
  });
});
