import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  type CommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '@phub/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';

const { runSupervisedProducer } = vi.hoisted(() => ({ runSupervisedProducer: vi.fn() }));
vi.mock('./communities-staging-role-split-trusted-inventory-supervised-producer.js', () => ({
  runCommunitiesStagingRoleSplitTrustedInventoryWithSupervisedProducer: runSupervisedProducer,
}));

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION,
  createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring,
  type CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringInput,
} from './communities-staging-role-split-trusted-inventory-runtime-wiring.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const candidateCommitSha = 'a'.repeat(40);
const outputDirectoryPath = '/evidence/output';
const outputArtifactPath = `${outputDirectoryPath}/input-c.json`;
const outputReceiptPath = `${outputDirectoryPath}/receipt.json`;
const evidencePaths = {
  markerRequestPath: '/evidence/marker-request.json',
  markerEvidencePath: '/evidence/marker-evidence.json',
  roleMappingPath: '/evidence/role-mapping.json',
} as const;

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
  markerRequestSha256: sha256('request'),
  markerEvidenceSha256: sha256('marker-evidence'),
  roleMappingSha256: sha256('role-mapping'),
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;

function preparation(): CommunitiesStagingRoleSplitInventoryPreparation {
  const pathByCode = {
    MARKER_REQUEST: evidencePaths.markerRequestPath,
    MARKER_EVIDENCE: evidencePaths.markerEvidencePath,
    ROLE_MAPPING: evidencePaths.roleMappingPath,
    INDEPENDENT_SOURCE_PROVENANCE: '/evidence/source-provenance.json',
    CONNECTION_DESCRIPTOR: '/evidence/connection.json',
    CREDENTIAL_CUSTODY: '/evidence/credential-custody.json',
    EXECUTABLE_CUSTODY: '/evidence/executable-custody.json',
    OUTPUT_CUSTODY: '/evidence/output-custody.json',
  } as const;
  const contentByCode = {
    MARKER_REQUEST: connectionDescriptor.markerRequestSha256,
    MARKER_EVIDENCE: connectionDescriptor.markerEvidenceSha256,
    ROLE_MAPPING: connectionDescriptor.roleMappingSha256,
    INDEPENDENT_SOURCE_PROVENANCE: sha256('source-provenance'),
    CONNECTION_DESCRIPTOR:
      communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(connectionDescriptor),
    CREDENTIAL_CUSTODY: sha256('credential-custody'),
    EXECUTABLE_CUSTODY: sha256('executable-custody'),
    OUTPUT_CUSTODY: sha256('output-custody'),
  } as const;
  return {
    schemaVersion: 'communities-staging-role-split-inventory-preparation-v1',
    status: 'CODE_ONLY_DISABLED',
    candidateCommitSha,
    phase: 'BEFORE',
    requestSha256: connectionDescriptor.markerRequestSha256,
    creationReceiptSha256: sha256('creation-receipt'),
    cloneDatabaseOid: '123',
    sourceDatabaseOid: '456',
    systemIdentifier: '1234567890123456789',
    inputs: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.map((code) => ({
      code,
      pathSha256: sha256(`${pathByCode[code]}\n`),
      contentSha256: contentByCode[code],
    })),
    outputArtifactPathSha256: sha256(`${outputArtifactPath}\n`),
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
    producerExecutableSha256: sha256('producer'),
    outputDirectoryPathSha256: sha256(`${outputDirectoryPath}\n`),
    outputArtifactPathSha256: sha256(`${outputArtifactPath}\n`),
    outputReceiptPathSha256: sha256(`${outputReceiptPath}\n`),
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

function input() {
  const prepared = preparation();
  const authorized = authorization(prepared);
  return {
    preparation: prepared,
    preparationVerification: preparationVerification(prepared),
    authorization: authorized,
    expectedAuthorizationSha256:
      communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(authorized),
    connectionDescriptor,
    outputDirectoryPath,
    outputArtifactPath,
    outputReceiptPath,
    credentialFile: { fd: 11 } as FileHandle,
    producerFile: { fd: 12 } as FileHandle,
    evidencePaths,
  };
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(process, 'getgid').mockReturnValue(0);
  runSupervisedProducer.mockResolvedValue({ status: 'review-only-receipt' });
});

afterEach(() => {
  vi.restoreAllMocks();
  runSupervisedProducer.mockReset();
});

describe('trusted inventory source-only runtime wiring', () => {
  it('snapshots exact data and dispatches the fixed supervised composition once', async () => {
    const mutable = input();
    const wiring = createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(mutable);
    expect(wiring.version).toBe(
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION,
    );

    (
      mutable.authorization.authorizes as unknown as { inventoryConnection: boolean }
    ).inventoryConnection = false;
    (
      mutable as unknown as {
        evidencePaths: {
          markerRequestPath: string;
          markerEvidencePath: string;
          roleMappingPath: string;
        };
      }
    ).evidencePaths = {
      ...evidencePaths,
      markerRequestPath: '/evidence/substituted.json',
    };
    await expect(wiring.run()).resolves.toEqual({ status: 'review-only-receipt' });

    expect(runSupervisedProducer).toHaveBeenCalledTimes(1);
    const dispatched = runSupervisedProducer.mock
      .calls[0]![0] as unknown as CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringInput;
    expect(dispatched.authorization.authorizes.inventoryConnection).toBe(true);
    expect(dispatched.evidencePaths).toEqual(evidencePaths);
    expect(dispatched.credentialFile.fd).toBe(11);
    expect(dispatched.producerFile.fd).toBe(12);
    expect(Object.isFrozen(dispatched.authorization)).toBe(true);
  });

  it('rejects authorization, evidence-path and descriptor drift before dispatch', () => {
    const wrongPin = input();
    wrongPin.expectedAuthorizationSha256 = sha256('wrong');
    expect(() => createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(wrongPin)).toThrow(
      /CONFIG_INVALID/u,
    );

    const wrongEvidence = input();
    (
      wrongEvidence as unknown as {
        evidencePaths: {
          markerRequestPath: string;
          markerEvidencePath: string;
          roleMappingPath: string;
        };
      }
    ).evidencePaths = {
      ...evidencePaths,
      markerRequestPath: '/evidence/different.json',
    };
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(wrongEvidence),
    ).toThrow(/CONFIG_INVALID/u);

    const wrongOutputDirectory = input();
    wrongOutputDirectory.outputArtifactPath = '/evidence/other/input-c.json';
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(wrongOutputDirectory),
    ).toThrow(/CONFIG_INVALID/u);

    const aliased = input();
    aliased.producerFile = aliased.credentialFile;
    expect(() => createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(aliased)).toThrow(
      /DESCRIPTOR_INVALID/u,
    );
    expect(runSupervisedProducer).not.toHaveBeenCalled();
  });

  it('fails before dispatch outside the exact root Linux runtime', async () => {
    const wiring = createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(input());
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    await expect(wiring.run()).rejects.toThrow(/RUNTIME_INVALID/u);
    await expect(wiring.run()).rejects.toThrow(/STATE_INVALID/u);
    expect(runSupervisedProducer).not.toHaveBeenCalled();
  });

  it('rejects descriptor replacement and consumes the wiring without dispatch', async () => {
    const mutable = input();
    const wiring = createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(mutable);
    (mutable.credentialFile as unknown as { fd: number }).fd = 99;

    await expect(wiring.run()).rejects.toThrow(/DESCRIPTOR_INVALID/u);
    await expect(wiring.run()).rejects.toThrow(/STATE_INVALID/u);
    expect(runSupervisedProducer).not.toHaveBeenCalled();
  });

  it('never dispatches the same runtime wiring twice', async () => {
    const wiring = createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(input());
    await wiring.run();

    await expect(wiring.run()).rejects.toThrow(/STATE_INVALID/u);
    expect(runSupervisedProducer).toHaveBeenCalledTimes(1);
  });

  it('remains absent from every CLI/build entry and owns no descriptor or process access', async () => {
    const [source, packageJson, tsupConfig] = await Promise.all([
      readFile(
        new URL(
          './communities-staging-role-split-trusted-inventory-runtime-wiring.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../tsup.config.ts', import.meta.url), 'utf8'),
    ]);
    const basename = 'communities-staging-role-split-trusted-inventory-runtime-wiring';

    expect(packageJson).not.toContain(basename);
    expect(tsupConfig).not.toContain(basename);
    expect(source).not.toMatch(/node:fs|node:child_process|process\.argv/u);
    expect(source).not.toMatch(/\b(?:open|readFile|spawn|execFile)\s*\(/u);
  });
});
