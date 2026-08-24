import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  canonicalCommunitiesStagingRoleSplitInventoryPreparation,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  communitiesRoleSplitCanonicalJson,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  type CommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '@phub/database';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryGate,
  communitiesStagingRoleSplitTrustedInventoryGateSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryGate,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.js';
import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';
import { runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight } from './communities-staging-role-split-trusted-inventory-gate-preflight.js';

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const candidateCommitSha = 'a'.repeat(40);
const filePaths = {
  gate: '/root/gate.json',
  preparation: '/root/preparation.json',
  preparationVerification: '/root/preparation-verification.json',
  connectionDescriptor: '/evidence/connection.json',
} as const;
const paths = {
  credentialDescriptorPath: '/inputs/credential.pgpass',
  producerDescriptorPath: '/inputs/producer.js',
  outputDirectoryPath: '/output/inventory',
  outputArtifactPath: '/output/inventory/before.json',
  outputReceiptPath: '/output/inventory/before.receipt.json',
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
    MARKER_REQUEST: paths.markerRequestPath,
    MARKER_EVIDENCE: paths.markerEvidencePath,
    ROLE_MAPPING: paths.roleMappingPath,
    INDEPENDENT_SOURCE_PROVENANCE: '/evidence/source-provenance.json',
    CONNECTION_DESCRIPTOR: filePaths.connectionDescriptor,
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
    outputArtifactPathSha256: sha256(`${paths.outputArtifactPath}\n`),
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

function fixture() {
  const prepared = preparation();
  const verification = preparationVerification(prepared);
  const gate = {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-gate-v1',
    status: 'PREPARED_FOR_SEPARATE_AUTHORIZATION_REVIEW',
    candidateCommitSha,
    phase: 'BEFORE',
    installedCandidateReceiptSha256: sha256('installed-receipt'),
    runtimeBundleSha256: sha256('runtime-bundle'),
    preparationSha256: communitiesStagingRoleSplitInventoryPreparationSha256(prepared),
    preparationVerificationSha256: sha256(`${communitiesRoleSplitCanonicalJson(verification)}\n`),
    connectionDescriptorSha256:
      communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(connectionDescriptor),
    producerExecutableSha256: sha256('producer-executable'),
    credentialDescriptorPathSha256: sha256(`${paths.credentialDescriptorPath}\n`),
    producerDescriptorPathSha256: sha256(`${paths.producerDescriptorPath}\n`),
    outputDirectoryPathSha256: sha256(`${paths.outputDirectoryPath}\n`),
    outputArtifactPathSha256: sha256(`${paths.outputArtifactPath}\n`),
    outputReceiptPathSha256: sha256(`${paths.outputReceiptPath}\n`),
    markerRequestPathSha256: sha256(`${paths.markerRequestPath}\n`),
    markerEvidencePathSha256: sha256(`${paths.markerEvidencePath}\n`),
    roleMappingPathSha256: sha256(`${paths.roleMappingPath}\n`),
    runtimeWiringVersion: 'communities-staging-role-split-trusted-inventory-runtime-wiring-v1',
    collectionTimeoutMillis: 45_000,
    terminationGraceMillis: 5_000,
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
  } as const satisfies CommunitiesStagingRoleSplitTrustedInventoryGate;
  const gateSha256 = communitiesStagingRoleSplitTrustedInventoryGateSha256(gate);
  const arguments_ = [
    '--gate',
    filePaths.gate,
    '--gate-sha256',
    gateSha256,
    '--preparation',
    filePaths.preparation,
    '--preparation-verification',
    filePaths.preparationVerification,
    '--connection-descriptor',
    filePaths.connectionDescriptor,
    '--credential-descriptor',
    paths.credentialDescriptorPath,
    '--producer-descriptor',
    paths.producerDescriptorPath,
    '--output-directory',
    paths.outputDirectoryPath,
    '--output-artifact',
    paths.outputArtifactPath,
    '--output-receipt',
    paths.outputReceiptPath,
    '--marker-request',
    paths.markerRequestPath,
    '--marker-evidence',
    paths.markerEvidencePath,
    '--role-mapping',
    paths.roleMappingPath,
  ];
  const bytes = new Map<string, Buffer>([
    [filePaths.gate, Buffer.from(canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(gate))],
    [
      filePaths.preparation,
      Buffer.from(canonicalCommunitiesStagingRoleSplitInventoryPreparation(prepared)),
    ],
    [
      filePaths.preparationVerification,
      Buffer.from(`${communitiesRoleSplitCanonicalJson(verification)}\n`),
    ],
    [
      filePaths.connectionDescriptor,
      Buffer.from(
        canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
          connectionDescriptor,
        ),
      ),
    ],
  ]);
  return { arguments_, bytes };
}

describe('trusted INPUT_C gate offline preflight', () => {
  it('reads only four pinned review documents and retains every authority false', async () => {
    const target = fixture();
    const read = vi.fn((path: string) => {
      const bytes = target.bytes.get(path);
      if (!bytes) throw new Error('unexpected read');
      return Promise.resolve(bytes);
    });

    const result = JSON.parse(
      await runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(target.arguments_, {
        readRootOwnedEvidence: read,
      }),
    ) as {
      readonly status: string;
      readonly limitations: Readonly<Record<string, boolean>>;
      readonly authorizes: Readonly<Record<string, boolean>>;
    };

    expect(result.status).toBe('READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY');
    expect(Object.values(result.limitations).every(Boolean)).toBe(true);
    expect(Object.values(result.authorizes).every((value) => value === false)).toBe(true);
    expect(read.mock.calls).toEqual([
      [filePaths.gate, 128 * 1024],
      [filePaths.preparation, 128 * 1024],
      [filePaths.preparationVerification, 128 * 1024],
      [filePaths.connectionDescriptor, 64 * 1024],
    ]);
  });

  it('rejects malformed arguments before evidence access', async () => {
    const read = vi.fn();
    await expect(
      runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight([], {
        readRootOwnedEvidence: read,
      }),
    ).rejects.toThrow(/GATE_PREFLIGHT_INVALID/u);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a gate pin mismatch before reading dependent documents', async () => {
    const target = fixture();
    target.arguments_[3] = sha256('different');
    const read = vi.fn((path: string) => Promise.resolve(target.bytes.get(path)!));
    await expect(
      runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(target.arguments_, {
        readRootOwnedEvidence: read,
      }),
    ).rejects.toThrow(/GATE_PREFLIGHT_INVALID/u);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects non-canonical verification bytes and connection path drift', async () => {
    const nonCanonical = fixture();
    nonCanonical.bytes.set(
      filePaths.preparationVerification,
      Buffer.from(
        ` ${nonCanonical.bytes.get(filePaths.preparationVerification)!.toString('utf8')}`,
      ),
    );
    await expect(
      runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(nonCanonical.arguments_, {
        readRootOwnedEvidence: (path) => Promise.resolve(nonCanonical.bytes.get(path)!),
      }),
    ).rejects.toThrow(/GATE_PREFLIGHT_INVALID/u);

    const changedPath = fixture();
    changedPath.arguments_[9] = '/evidence/copied-connection.json';
    changedPath.bytes.set(
      '/evidence/copied-connection.json',
      changedPath.bytes.get(filePaths.connectionDescriptor)!,
    );
    await expect(
      runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(changedPath.arguments_, {
        readRootOwnedEvidence: (path) => Promise.resolve(changedPath.bytes.get(path)!),
      }),
    ).rejects.toThrow(/GATE_PREFLIGHT_INVALID/u);
  });

  it('rejects path aliases before reading any review document', async () => {
    const target = fixture();
    target.arguments_[13] = paths.credentialDescriptorPath;
    const read = vi.fn();
    await expect(
      runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(target.arguments_, {
        readRootOwnedEvidence: read,
      }),
    ).rejects.toThrow(/GATE_PREFLIGHT_INVALID/u);
    expect(read).not.toHaveBeenCalled();

    const controlled = fixture();
    controlled.arguments_[1] = '/root/gate.json\n';
    await expect(
      runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(controlled.arguments_, {
        readRootOwnedEvidence: read,
      }),
    ).rejects.toThrow(/GATE_PREFLIGHT_INVALID/u);
    expect(read).not.toHaveBeenCalled();
  });
});
