import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  communitiesStagingRoleSplitTrustedInventoryGateSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryGate,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.js';
import { communitiesRoleSplitCanonicalJson } from '../../../packages/database/src/communities-role-split-input-c.js';
import {
  communitiesStagingRoleSplitInventoryPreparationSha256,
  type CommunitiesStagingRoleSplitInventoryPreparation,
} from '../../../packages/database/src/communities-staging-role-split-inventory-preparation.js';
import {
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory.js';
import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const bindingKeys = [
  'callerSuppliedPreparationPinMatched',
  'canonicalPreparationBytes',
  'exactInputPathSetMatched',
  'exactInputContentSetMatched',
  'markerRequestEvidenceMatched',
  'roleMappingShapeValidated',
  'outputArtifactPathMatched',
] as const;
const limitationKeys = [
  'organizationalIndependenceNotAttested',
  'cleanCloneProvenanceSemanticsNotAttested',
  'connectionDescriptorSemanticsNotAttested',
  'credentialCustodySemanticsNotAttested',
  'executableCustodySemanticsNotAttested',
  'outputCustodySemanticsNotAttested',
  'parentDirectoryCustodyNotAttested',
  'outputAbsenceNotAttested',
  'databaseNotConnected',
  'artifactNotCreated',
] as const;
const authorizationKeys = [
  'inventoryConnection',
  'inventoryRead',
  'artifactWrite',
  'trustedInventoryDesignation',
  'roleCreation',
  'roleSplit',
  'aclMutation',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'activation',
] as const;

export interface CommunitiesStagingRoleSplitTrustedInventoryGatePaths {
  readonly credentialDescriptorPath: string;
  readonly producerDescriptorPath: string;
  readonly outputDirectoryPath: string;
  readonly outputArtifactPath: string;
  readonly outputReceiptPath: string;
  readonly markerRequestPath: string;
  readonly markerEvidencePath: string;
  readonly roleMappingPath: string;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryGateVerification {
  readonly schemaVersion: 'communities-staging-role-split-trusted-inventory-gate-verification-v1';
  readonly status: 'READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY';
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly installedCandidateReceiptSha256: string;
  readonly runtimeBundleSha256: string;
  readonly preparationSha256: string;
  readonly preparationVerificationSha256: string;
  readonly connectionDescriptorSha256: string;
  readonly producerExecutableSha256: string;
  readonly bindings: {
    readonly canonicalGate: true;
    readonly preparationVerifiedReviewOnly: true;
    readonly candidateAndPhaseMatched: true;
    readonly connectionDescriptorMatched: true;
    readonly evidenceContentBindingsMatched: true;
    readonly evidencePathBindingsMatched: true;
    readonly descriptorPathBindingsMatched: true;
    readonly outputPathBindingsMatched: true;
    readonly fixedRuntimeAndTimeoutPolicyMatched: true;
  };
  readonly limitations: {
    readonly preparationVerificationProvenanceNotAttested: true;
    readonly installedCandidateReceiptSemanticsNotAttested: true;
    readonly runtimeBundleCustodyNotAttested: true;
    readonly credentialDescriptorCustodyNotAttested: true;
    readonly producerDescriptorCustodyNotAttested: true;
    readonly outputCustodyNotAttested: true;
    readonly independentlySourcedCloneNotAttested: true;
    readonly separateAuthorizationNotGranted: true;
    readonly authorizationReceiptNotCreated: true;
    readonly databaseNotConnected: true;
    readonly processNotStarted: true;
    readonly artifactNotCreated: true;
    readonly trustedInventoryDesignationNotGranted: true;
  };
  readonly authorizes: {
    readonly inventoryConnection: false;
    readonly inventoryRead: false;
    readonly artifactWrite: false;
    readonly trustedInventoryDesignation: false;
    readonly roleCreation: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
}

function fail(): never {
  throw new Error('COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pathSha256(path: string): string {
  return sha256(`${path}\n`);
}

function canonicalPath(path: string): boolean {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) return false;
  return ![...path].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function preparationVerificationSha256(
  value: CommunitiesStagingRoleSplitInventoryPreparationVerification,
): string {
  return sha256(`${communitiesRoleSplitCanonicalJson(value)}\n`);
}

function assertPreparationVerification(
  verification: CommunitiesStagingRoleSplitInventoryPreparationVerification,
  preparation: CommunitiesStagingRoleSplitInventoryPreparation,
  expectedPreparationSha256: string,
): void {
  if (
    !exactKeys(verification, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'phase',
      'preparationSha256',
      'requestSha256',
      'creationReceiptSha256',
      'inputCount',
      'outputArtifactPathSha256',
      'bindings',
      'limitations',
      'authorizes',
    ]) ||
    verification.schemaVersion !==
      'communities-staging-role-split-inventory-preparation-verification-v1' ||
    verification.status !== 'PREPARATION_VERIFIED_REVIEW_ONLY' ||
    verification.candidateCommitSha !== preparation.candidateCommitSha ||
    verification.phase !== preparation.phase ||
    verification.preparationSha256 !== expectedPreparationSha256 ||
    verification.requestSha256 !== preparation.requestSha256 ||
    verification.creationReceiptSha256 !== preparation.creationReceiptSha256 ||
    verification.inputCount !== 8 ||
    verification.outputArtifactPathSha256 !== preparation.outputArtifactPathSha256 ||
    !exactKeys(verification.bindings, bindingKeys) ||
    bindingKeys.some((key) => verification.bindings[key] !== true) ||
    !exactKeys(verification.limitations, limitationKeys) ||
    limitationKeys.some((key) => verification.limitations[key] !== true) ||
    !exactKeys(verification.authorizes, authorizationKeys) ||
    authorizationKeys.some((key) => verification.authorizes[key] !== false)
  )
    fail();
}

function preparationInput(
  preparation: CommunitiesStagingRoleSplitInventoryPreparation,
  code: 'MARKER_REQUEST' | 'MARKER_EVIDENCE' | 'ROLE_MAPPING' | 'CONNECTION_DESCRIPTOR',
) {
  const binding = preparation.inputs.find((entry) => entry.code === code);
  if (!binding) fail();
  return binding;
}

export function verifyCommunitiesStagingRoleSplitTrustedInventoryGate(input: {
  readonly gate: CommunitiesStagingRoleSplitTrustedInventoryGate;
  readonly expectedGateSha256: string;
  readonly preparation: CommunitiesStagingRoleSplitInventoryPreparation;
  readonly preparationVerification: CommunitiesStagingRoleSplitInventoryPreparationVerification;
  readonly connectionDescriptor: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;
  readonly paths: CommunitiesStagingRoleSplitTrustedInventoryGatePaths;
}): CommunitiesStagingRoleSplitTrustedInventoryGateVerification {
  try {
    if (!SHA256.test(input.expectedGateSha256)) fail();
    const gateSha256 = communitiesStagingRoleSplitTrustedInventoryGateSha256(input.gate);
    if (gateSha256 !== input.expectedGateSha256) fail();

    const preparationSha256 = communitiesStagingRoleSplitInventoryPreparationSha256(
      input.preparation,
    );
    const verificationSha256 = preparationVerificationSha256(input.preparationVerification);
    const connectionDescriptorSha256 =
      communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(
        input.connectionDescriptor,
      );
    assertPreparationVerification(
      input.preparationVerification,
      input.preparation,
      preparationSha256,
    );

    const paths: readonly string[] = [
      input.paths.credentialDescriptorPath,
      input.paths.producerDescriptorPath,
      input.paths.outputDirectoryPath,
      input.paths.outputArtifactPath,
      input.paths.outputReceiptPath,
      input.paths.markerRequestPath,
      input.paths.markerEvidencePath,
      input.paths.roleMappingPath,
    ];
    if (
      !exactKeys(input.paths, [
        'credentialDescriptorPath',
        'producerDescriptorPath',
        'outputDirectoryPath',
        'outputArtifactPath',
        'outputReceiptPath',
        'markerRequestPath',
        'markerEvidencePath',
        'roleMappingPath',
      ]) ||
      paths.some((path) => !canonicalPath(path)) ||
      new Set(paths).size !== paths.length ||
      dirname(input.paths.outputArtifactPath) !== input.paths.outputDirectoryPath ||
      dirname(input.paths.outputReceiptPath) !== input.paths.outputDirectoryPath
    )
      fail();

    const markerRequest = preparationInput(input.preparation, 'MARKER_REQUEST');
    const markerEvidence = preparationInput(input.preparation, 'MARKER_EVIDENCE');
    const roleMapping = preparationInput(input.preparation, 'ROLE_MAPPING');
    const connection = preparationInput(input.preparation, 'CONNECTION_DESCRIPTOR');
    const evidencePathHashes = new Set(input.preparation.inputs.map((entry) => entry.pathSha256));
    const operationalPathHashes = [
      input.gate.credentialDescriptorPathSha256,
      input.gate.producerDescriptorPathSha256,
      input.gate.outputDirectoryPathSha256,
      input.gate.outputArtifactPathSha256,
      input.gate.outputReceiptPathSha256,
    ];
    if (
      evidencePathHashes.size !== input.preparation.inputs.length ||
      operationalPathHashes.some((pathHash) => evidencePathHashes.has(pathHash)) ||
      input.gate.candidateCommitSha !== input.preparation.candidateCommitSha ||
      input.gate.phase !== input.preparation.phase ||
      input.gate.preparationSha256 !== preparationSha256 ||
      input.gate.preparationVerificationSha256 !== verificationSha256 ||
      input.gate.connectionDescriptorSha256 !== connectionDescriptorSha256 ||
      connection.contentSha256 !== connectionDescriptorSha256 ||
      markerRequest.contentSha256 !== input.connectionDescriptor.markerRequestSha256 ||
      markerEvidence.contentSha256 !== input.connectionDescriptor.markerEvidenceSha256 ||
      roleMapping.contentSha256 !== input.connectionDescriptor.roleMappingSha256 ||
      input.gate.markerRequestPathSha256 !== pathSha256(input.paths.markerRequestPath) ||
      input.gate.markerEvidencePathSha256 !== pathSha256(input.paths.markerEvidencePath) ||
      input.gate.roleMappingPathSha256 !== pathSha256(input.paths.roleMappingPath) ||
      markerRequest.pathSha256 !== input.gate.markerRequestPathSha256 ||
      markerEvidence.pathSha256 !== input.gate.markerEvidencePathSha256 ||
      roleMapping.pathSha256 !== input.gate.roleMappingPathSha256 ||
      input.gate.credentialDescriptorPathSha256 !==
        pathSha256(input.paths.credentialDescriptorPath) ||
      input.gate.producerDescriptorPathSha256 !== pathSha256(input.paths.producerDescriptorPath) ||
      input.gate.outputDirectoryPathSha256 !== pathSha256(input.paths.outputDirectoryPath) ||
      input.gate.outputArtifactPathSha256 !== pathSha256(input.paths.outputArtifactPath) ||
      input.gate.outputReceiptPathSha256 !== pathSha256(input.paths.outputReceiptPath) ||
      input.preparation.outputArtifactPathSha256 !== input.gate.outputArtifactPathSha256
    )
      fail();

    return {
      schemaVersion: 'communities-staging-role-split-trusted-inventory-gate-verification-v1',
      status: 'READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY',
      candidateCommitSha: input.gate.candidateCommitSha,
      phase: input.gate.phase,
      gateSha256,
      installedCandidateReceiptSha256: input.gate.installedCandidateReceiptSha256,
      runtimeBundleSha256: input.gate.runtimeBundleSha256,
      preparationSha256,
      preparationVerificationSha256: verificationSha256,
      connectionDescriptorSha256,
      producerExecutableSha256: input.gate.producerExecutableSha256,
      bindings: {
        canonicalGate: true,
        preparationVerifiedReviewOnly: true,
        candidateAndPhaseMatched: true,
        connectionDescriptorMatched: true,
        evidenceContentBindingsMatched: true,
        evidencePathBindingsMatched: true,
        descriptorPathBindingsMatched: true,
        outputPathBindingsMatched: true,
        fixedRuntimeAndTimeoutPolicyMatched: true,
      },
      limitations: {
        preparationVerificationProvenanceNotAttested: true,
        installedCandidateReceiptSemanticsNotAttested: true,
        runtimeBundleCustodyNotAttested: true,
        credentialDescriptorCustodyNotAttested: true,
        producerDescriptorCustodyNotAttested: true,
        outputCustodyNotAttested: true,
        independentlySourcedCloneNotAttested: true,
        separateAuthorizationNotGranted: true,
        authorizationReceiptNotCreated: true,
        databaseNotConnected: true,
        processNotStarted: true,
        artifactNotCreated: true,
        trustedInventoryDesignationNotGranted: true,
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
  } catch {
    fail();
  }
}

export function communitiesStagingRoleSplitTrustedInventoryGateVerificationText(
  value: CommunitiesStagingRoleSplitTrustedInventoryGateVerification,
): string {
  return `${communitiesRoleSplitCanonicalJson(value)}\n`;
}
