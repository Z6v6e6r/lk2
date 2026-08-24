import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  communitiesRoleSplitCanonicalJson,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  type CommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  communitiesStagingRoleSplitTrustedInventoryGateSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryGate,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.js';
import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';
import {
  communitiesStagingRoleSplitTrustedInventoryGateVerificationText,
  verifyCommunitiesStagingRoleSplitTrustedInventoryGate,
} from './communities-staging-role-split-trusted-inventory-gate.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const candidateCommitSha = 'a'.repeat(40);
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
  return {
    gate,
    expectedGateSha256: communitiesStagingRoleSplitTrustedInventoryGateSha256(gate),
    preparation: prepared,
    preparationVerification: verification,
    connectionDescriptor,
    paths,
  };
}

describe('trusted INPUT_C inventory separate-authorization gate', () => {
  it('cross-binds the complete review subject while retaining every authority false', () => {
    const result = verifyCommunitiesStagingRoleSplitTrustedInventoryGate(fixture());

    expect(result.status).toBe('READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY');
    expect(Object.values(result.bindings).every(Boolean)).toBe(true);
    expect(Object.values(result.limitations).every(Boolean)).toBe(true);
    expect(Object.values(result.authorizes).every((value) => value === false)).toBe(true);
    expect(
      JSON.parse(communitiesStagingRoleSplitTrustedInventoryGateVerificationText(result)),
    ).toEqual(result);
  });

  it('rejects pin, preparation, connection and path drift', () => {
    const wrongPin = fixture();
    wrongPin.expectedGateSha256 = sha256('wrong');
    expect(() => verifyCommunitiesStagingRoleSplitTrustedInventoryGate(wrongPin)).toThrow(
      /TRUSTED_INVENTORY_GATE_INVALID/u,
    );

    const widenedVerification = fixture();
    (widenedVerification.preparationVerification as unknown as Record<string, unknown>).unexpected =
      true;
    expect(() =>
      verifyCommunitiesStagingRoleSplitTrustedInventoryGate(widenedVerification),
    ).toThrow(/TRUSTED_INVENTORY_GATE_INVALID/u);

    const changedConnection = fixture();
    (
      changedConnection.connectionDescriptor as unknown as { markerRequestSha256: string }
    ).markerRequestSha256 = sha256('different');
    expect(() => verifyCommunitiesStagingRoleSplitTrustedInventoryGate(changedConnection)).toThrow(
      /TRUSTED_INVENTORY_GATE_INVALID/u,
    );

    const aliasedPath = fixture();
    (aliasedPath.paths as unknown as { producerDescriptorPath: string }).producerDescriptorPath =
      paths.credentialDescriptorPath;
    expect(() => verifyCommunitiesStagingRoleSplitTrustedInventoryGate(aliasedPath)).toThrow(
      /TRUSTED_INVENTORY_GATE_INVALID/u,
    );

    const evidenceAlias = fixture();
    const sourceProvenance = evidenceAlias.preparation.inputs.find(
      (entry) => entry.code === 'INDEPENDENT_SOURCE_PROVENANCE',
    )!;
    (
      evidenceAlias.gate as unknown as { credentialDescriptorPathSha256: string }
    ).credentialDescriptorPathSha256 = sourceProvenance.pathSha256;
    evidenceAlias.expectedGateSha256 = communitiesStagingRoleSplitTrustedInventoryGateSha256(
      evidenceAlias.gate,
    );
    expect(() => verifyCommunitiesStagingRoleSplitTrustedInventoryGate(evidenceAlias)).toThrow(
      /TRUSTED_INVENTORY_GATE_INVALID/u,
    );
  });

  it('keeps the pure verifier out of CLI, filesystem and child-process execution surfaces', async () => {
    const [source, rootPackage, tsupConfig] = await Promise.all([
      readFile(
        new URL('./communities-staging-role-split-trusted-inventory-gate.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../tsup.config.ts', import.meta.url), 'utf8'),
    ]);
    const basename = 'communities-staging-role-split-trusted-inventory-gate';

    expect(rootPackage).not.toContain(basename);
    expect(tsupConfig).not.toContain(
      "'src/communities-staging-role-split-trusted-inventory-gate.ts'",
    );
    expect(source).not.toMatch(/node:fs|node:child_process|\bfrom ['"]pg['"]|process\.argv/u);
    expect(source).not.toMatch(/\b(?:open|readFile|spawn|execFile|connect)\s*\(/u);
  });
});
