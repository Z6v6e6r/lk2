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
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization-request.js';
import {
  communitiesStagingRoleSplitTrustedInventoryGateSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryGate,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.js';
import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';
import {
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText,
  verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from './communities-staging-role-split-trusted-inventory-authorization-request.js';
import {
  verifyCommunitiesStagingRoleSplitTrustedInventoryGate,
  type CommunitiesStagingRoleSplitTrustedInventoryGatePaths,
} from './communities-staging-role-split-trusted-inventory-gate.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const subjectSha256 = (value: unknown): string =>
  sha256(`${communitiesRoleSplitCanonicalJson(value)}\n`);
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
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryGatePaths;

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

function preparation(): CommunitiesStagingRoleSplitInventoryPreparation {
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

function preparationInput(
  value: CommunitiesStagingRoleSplitInventoryPreparation,
  code:
    | 'INDEPENDENT_SOURCE_PROVENANCE'
    | 'CONNECTION_DESCRIPTOR'
    | 'CREDENTIAL_CUSTODY'
    | 'EXECUTABLE_CUSTODY'
    | 'OUTPUT_CUSTODY',
) {
  return value.inputs.find((entry) => entry.code === code)!;
}

function evidenceSubjects(input: {
  requestIdSha256: string;
  gate: CommunitiesStagingRoleSplitTrustedInventoryGate;
  preparation: CommunitiesStagingRoleSplitInventoryPreparation;
}): Readonly<Record<CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode, string>> {
  const independentSource = preparationInput(input.preparation, 'INDEPENDENT_SOURCE_PROVENANCE');
  const connection = preparationInput(input.preparation, 'CONNECTION_DESCRIPTOR');
  const credentialCustody = preparationInput(input.preparation, 'CREDENTIAL_CUSTODY');
  const executableCustody = preparationInput(input.preparation, 'EXECUTABLE_CUSTODY');
  const outputCustody = preparationInput(input.preparation, 'OUTPUT_CUSTODY');
  const gate = input.gate;
  const gateSha256 = communitiesStagingRoleSplitTrustedInventoryGateSha256(gate);
  const scoped = (
    code: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
    subject: unknown,
  ): string =>
    subjectSha256({
      schemaVersion:
        'communities-staging-role-split-trusted-inventory-authorization-evidence-subject-v1',
      requestIdSha256: input.requestIdSha256,
      candidateCommitSha: gate.candidateCommitSha,
      phase: gate.phase,
      gateSha256,
      code,
      subject,
    });
  return {
    CLEAN_CLONE_PROVENANCE: scoped('CLEAN_CLONE_PROVENANCE', {
      provenanceSha256: independentSource.contentSha256,
      provenancePathSha256: independentSource.pathSha256,
      connectionDescriptorSha256: gate.connectionDescriptorSha256,
      markerRequestPathSha256: gate.markerRequestPathSha256,
      markerEvidencePathSha256: gate.markerEvidencePathSha256,
      roleMappingPathSha256: gate.roleMappingPathSha256,
    }),
    CONNECTION_DESCRIPTOR_CUSTODY: scoped('CONNECTION_DESCRIPTOR_CUSTODY', {
      connectionDescriptorSha256: gate.connectionDescriptorSha256,
      connectionEvidencePathSha256: connection.pathSha256,
    }),
    CREDENTIAL_DESCRIPTOR_CUSTODY: scoped('CREDENTIAL_DESCRIPTOR_CUSTODY', {
      credentialDescriptorPathSha256: gate.credentialDescriptorPathSha256,
      custodySha256: credentialCustody.contentSha256,
      custodyPathSha256: credentialCustody.pathSha256,
    }),
    INSTALLED_CANDIDATE_RECEIPT_CUSTODY: scoped('INSTALLED_CANDIDATE_RECEIPT_CUSTODY', {
      installedCandidateReceiptSha256: gate.installedCandidateReceiptSha256,
    }),
    OUTPUT_DIRECTORY_CUSTODY: scoped('OUTPUT_DIRECTORY_CUSTODY', {
      outputDirectoryPathSha256: gate.outputDirectoryPathSha256,
      outputArtifactPathSha256: gate.outputArtifactPathSha256,
      outputReceiptPathSha256: gate.outputReceiptPathSha256,
      custodySha256: outputCustody.contentSha256,
      custodyPathSha256: outputCustody.pathSha256,
    }),
    OUTPUT_TARGET_ABSENCE: scoped('OUTPUT_TARGET_ABSENCE', {
      outputArtifactPathSha256: gate.outputArtifactPathSha256,
      outputReceiptPathSha256: gate.outputReceiptPathSha256,
    }),
    PREPARATION_VERIFICATION_PROVENANCE: scoped('PREPARATION_VERIFICATION_PROVENANCE', {
      preparationVerificationSha256: gate.preparationVerificationSha256,
    }),
    PRODUCER_DESCRIPTOR_CUSTODY: scoped('PRODUCER_DESCRIPTOR_CUSTODY', {
      producerDescriptorPathSha256: gate.producerDescriptorPathSha256,
      producerExecutableSha256: gate.producerExecutableSha256,
      custodySha256: executableCustody.contentSha256,
      custodyPathSha256: executableCustody.pathSha256,
    }),
    PRODUCER_EXECUTABLE_CUSTODY: scoped('PRODUCER_EXECUTABLE_CUSTODY', {
      producerExecutableSha256: gate.producerExecutableSha256,
    }),
    RUNTIME_BUNDLE_CUSTODY: scoped('RUNTIME_BUNDLE_CUSTODY', {
      runtimeBundleSha256: gate.runtimeBundleSha256,
    }),
  };
}

function fixture() {
  const prepared = preparation();
  const preparationReview = preparationVerification(prepared);
  const gate = {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-gate-v1',
    status: 'PREPARED_FOR_SEPARATE_AUTHORIZATION_REVIEW',
    candidateCommitSha,
    phase: 'BEFORE',
    installedCandidateReceiptSha256: sha256('installed-receipt'),
    runtimeBundleSha256: sha256('runtime-bundle'),
    preparationSha256: communitiesStagingRoleSplitInventoryPreparationSha256(prepared),
    preparationVerificationSha256: sha256(
      `${communitiesRoleSplitCanonicalJson(preparationReview)}\n`,
    ),
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
  const gateInput = {
    gate,
    expectedGateSha256: communitiesStagingRoleSplitTrustedInventoryGateSha256(gate),
    preparation: prepared,
    preparationVerification: preparationReview,
    connectionDescriptor,
    paths,
  };
  const gateVerification = verifyCommunitiesStagingRoleSplitTrustedInventoryGate(gateInput);
  const requestIdSha256 = sha256('authorization-request-id');
  const subjects = evidenceSubjects({ requestIdSha256, gate, preparation: prepared });
  const request = {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-request-v1',
    status: 'AUTHORIZATION_REQUEST_REVIEW_ONLY',
    requestIdSha256,
    candidateCommitSha,
    phase: 'BEFORE',
    gateSha256: gateInput.expectedGateSha256,
    gateVerificationSha256: sha256(`${communitiesRoleSplitCanonicalJson(gateVerification)}\n`),
    evidencePins: COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.map(
      (code, index) => ({
        code,
        status: 'PINNED_FOR_SEPARATE_REVIEW',
        subjectSha256: subjects[code],
        evidenceSha256: sha256(`evidence-${code}`),
        evidencePathSha256: sha256(`/authorization-evidence/${index}-${code}.json\n`),
      }),
    ),
    policy: {
      singleUse: true,
      maximumAttempts: 1,
      authorizationValiditySeconds: 300,
      requiresDurableConsumptionLedger: true,
      requiresRootOwnedEvidence: true,
      requiresIndependentApprover: true,
      requiresFailClosedClock: true,
    },
    requestedAuthorities: {
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
  } as const satisfies CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
  return {
    request,
    expectedRequestSha256:
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(request),
    gateInput,
    gateVerification,
  };
}

describe('trusted INPUT_C separate-authorization request verification', () => {
  it('reverifies V13 and returns only a review result with no granted authority', () => {
    const result = verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(fixture());

    expect(result.status).toBe('AUTHORIZATION_REQUEST_VERIFIED_REVIEW_ONLY');
    expect(result.evidencePinCount).toBe(10);
    expect(Object.values(result.bindings).every(Boolean)).toBe(true);
    expect(Object.values(result.limitations).every(Boolean)).toBe(true);
    expect(result.requestedAuthorities).toMatchObject({
      inventoryConnection: true,
      inventoryRead: true,
      artifactWrite: true,
      trustedInventoryDesignation: false,
      roleSplit: false,
    });
    expect(Object.values(result.authorizes).every((entry) => entry === false)).toBe(true);
    expect(
      JSON.parse(
        communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText(result),
      ),
    ).toEqual(result);
  });

  it('rejects request, V13 verification, evidence subject and evidence path drift', () => {
    const wrongPin = fixture();
    wrongPin.expectedRequestSha256 = sha256('wrong');
    expect(() =>
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(wrongPin),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);

    const verificationDrift = fixture();
    (
      verificationDrift.gateVerification.limitations as unknown as {
        databaseNotConnected: boolean;
      }
    ).databaseNotConnected = false;
    expect(() =>
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(verificationDrift),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);

    const subjectDrift = fixture();
    (subjectDrift.request.evidencePins[0] as unknown as { subjectSha256: string }).subjectSha256 =
      sha256('other-subject');
    subjectDrift.expectedRequestSha256 =
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(subjectDrift.request);
    expect(() =>
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(subjectDrift),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);

    const pathAlias = fixture();
    (
      pathAlias.request.evidencePins[0] as unknown as { evidencePathSha256: string }
    ).evidencePathSha256 = pathAlias.gateInput.gate.outputArtifactPathSha256;
    pathAlias.expectedRequestSha256 =
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(pathAlias.request);
    expect(() =>
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(pathAlias),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);

    const replayedId = fixture();
    (replayedId.request as unknown as { requestIdSha256: string }).requestIdSha256 =
      sha256('replayed-id');
    replayedId.expectedRequestSha256 =
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(replayedId.request);
    expect(() =>
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(replayedId),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);
  });

  it('refuses to serialize a widened or incomplete verification result', () => {
    const verified =
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(fixture());
    const hiddenLimitation = structuredClone(verified);
    (
      hiddenLimitation.limitations as unknown as {
        independentApprovalNotGranted: boolean;
      }
    ).independentApprovalNotGranted = false;
    expect(() =>
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText(
        hiddenLimitation,
      ),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);

    const widened = structuredClone(verified) as unknown as Record<string, unknown>;
    widened.authorizationReceiptSha256 = sha256('forbidden');
    expect(() =>
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText(
        widened as unknown as typeof verified,
      ),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);
  });

  it('adds no CLI, build, filesystem, process or PostgreSQL execution surface', async () => {
    const [source, rootPackage, tsupConfig, databaseIndex] = await Promise.all([
      readFile(
        new URL(
          './communities-staging-role-split-trusted-inventory-authorization-request.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../tsup.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../packages/database/src/index.ts', import.meta.url), 'utf8'),
    ]);
    const basename = 'communities-staging-role-split-trusted-inventory-authorization-request';

    expect(rootPackage).not.toContain(basename);
    expect(tsupConfig).not.toContain(basename);
    expect(databaseIndex).not.toContain(basename);
    expect(source).not.toMatch(/node:fs|node:child_process|\bfrom ['"]pg['"]|process\.argv/u);
    expect(source).not.toMatch(/\b(?:open|readFile|spawn|execFile|connect)\s*\(/u);
  });
});
