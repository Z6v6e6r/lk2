import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  communitiesRoleSplitCanonicalJson,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  parseCommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitInventoryPreparationInputCode,
} from '@phub/database';

import {
  parseCommunitiesStagingRoleSplitMarkerEvidence,
  parseCommunitiesStagingRoleSplitMarkerRequest,
  parseCommunitiesStagingRoleSplitRoleMapping,
} from './communities-staging-role-split-inventory.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type CommunitiesStagingRoleSplitInventoryPreparationEvidence = Readonly<
  Record<
    CommunitiesStagingRoleSplitInventoryPreparationInputCode,
    { readonly path: string; readonly bytes: Buffer }
  >
>;

export type CommunitiesStagingRoleSplitInventoryPreparationVerification = {
  readonly schemaVersion: 'communities-staging-role-split-inventory-preparation-verification-v1';
  readonly status: 'PREPARATION_VERIFIED_REVIEW_ONLY';
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly preparationSha256: string;
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly inputCount: 8;
  readonly outputArtifactPathSha256: string;
  readonly bindings: {
    readonly callerSuppliedPreparationPinMatched: true;
    readonly canonicalPreparationBytes: true;
    readonly exactInputPathSetMatched: true;
    readonly exactInputContentSetMatched: true;
    readonly markerRequestEvidenceMatched: true;
    readonly roleMappingShapeValidated: true;
    readonly outputArtifactPathMatched: true;
  };
  readonly limitations: {
    readonly organizationalIndependenceNotAttested: true;
    readonly cleanCloneProvenanceSemanticsNotAttested: true;
    readonly connectionDescriptorSemanticsNotAttested: true;
    readonly credentialCustodySemanticsNotAttested: true;
    readonly executableCustodySemanticsNotAttested: true;
    readonly outputCustodySemanticsNotAttested: true;
    readonly parentDirectoryCustodyNotAttested: true;
    readonly outputAbsenceNotAttested: true;
    readonly databaseNotConnected: true;
    readonly artifactNotCreated: true;
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
};

function fail(): never {
  throw new Error('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INVALID');
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalAbsolutePath(value: string): boolean {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
}

export function verifyCommunitiesStagingRoleSplitInventoryPreparation(input: {
  readonly preparationPath: string;
  readonly preparationBytes: Buffer;
  readonly expectedPreparationSha256: string;
  readonly evidence: CommunitiesStagingRoleSplitInventoryPreparationEvidence;
  readonly outputArtifactPath: string;
}): CommunitiesStagingRoleSplitInventoryPreparationVerification {
  try {
    if (
      !canonicalAbsolutePath(input.preparationPath) ||
      !canonicalAbsolutePath(input.outputArtifactPath) ||
      !Buffer.isBuffer(input.preparationBytes) ||
      input.preparationBytes.length < 1 ||
      !SHA256_PATTERN.test(input.expectedPreparationSha256) ||
      sha256(input.preparationBytes) !== input.expectedPreparationSha256
    )
      fail();
    const preparationText = input.preparationBytes.toString('utf8');
    if (!Buffer.from(preparationText, 'utf8').equals(input.preparationBytes)) fail();
    const preparation = parseCommunitiesStagingRoleSplitInventoryPreparation(preparationText);
    if (
      communitiesStagingRoleSplitInventoryPreparationSha256(preparation) !==
      input.expectedPreparationSha256
    )
      fail();

    const evidenceKeys = Object.keys(input.evidence);
    if (
      evidenceKeys.length !==
        COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.length ||
      evidenceKeys.some(
        (code) =>
          !COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.includes(
            code as CommunitiesStagingRoleSplitInventoryPreparationInputCode,
          ),
      )
    )
      fail();
    const paths = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.map(
      (code) => input.evidence[code]?.path,
    );
    if (
      paths.some((path) => typeof path !== 'string' || !canonicalAbsolutePath(path)) ||
      new Set([input.preparationPath, input.outputArtifactPath, ...paths]).size !== paths.length + 2
    )
      fail();

    for (const [
      index,
      code,
    ] of COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.entries()) {
      const actual = input.evidence[code];
      const expected = preparation.inputs[index];
      if (
        !actual ||
        !expected ||
        !Buffer.isBuffer(actual.bytes) ||
        actual.bytes.length < 1 ||
        expected.code !== code ||
        sha256(`${actual.path}\n`) !== expected.pathSha256 ||
        sha256(actual.bytes) !== expected.contentSha256
      )
        fail();
    }
    if (sha256(`${input.outputArtifactPath}\n`) !== preparation.outputArtifactPathSha256) fail();

    const requestBytes = input.evidence.MARKER_REQUEST.bytes;
    const evidenceBytes = input.evidence.MARKER_EVIDENCE.bytes;
    const mappingBytes = input.evidence.ROLE_MAPPING.bytes;
    const request = parseCommunitiesStagingRoleSplitMarkerRequest(requestBytes.toString('utf8'));
    const markerEvidence = parseCommunitiesStagingRoleSplitMarkerEvidence(
      evidenceBytes.toString('utf8'),
    );
    parseCommunitiesStagingRoleSplitRoleMapping(mappingBytes.toString('utf8'));
    const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
    if (
      requestSha256 !== preparation.requestSha256 ||
      markerEvidence.requestSha256 !== requestSha256 ||
      markerEvidence.creationReceiptSha256 !== preparation.creationReceiptSha256 ||
      markerEvidence.cloneDatabaseOid !== preparation.cloneDatabaseOid ||
      request.sourceDatabaseOid !== preparation.sourceDatabaseOid ||
      request.systemIdentifier !== preparation.systemIdentifier ||
      markerEvidence.backupSha256 !== request.backupSha256 ||
      markerEvidence.sourceLedgerSha256 !== request.sourceLedgerSha256 ||
      markerEvidence.sourceLedgerCount !== request.sourceLedgerCount ||
      markerEvidence.restoreRunId !== request.restoreRunId ||
      markerEvidence.restoreRunAttempt !== request.restoreRunAttempt ||
      markerEvidence.restoreHelperSha256 !== request.restoreHelperSha256 ||
      markerEvidence.markerWriterSha256 !== request.markerWriterSha256
    )
      fail();

    return {
      schemaVersion: 'communities-staging-role-split-inventory-preparation-verification-v1',
      status: 'PREPARATION_VERIFIED_REVIEW_ONLY',
      candidateCommitSha: preparation.candidateCommitSha,
      phase: preparation.phase,
      preparationSha256: input.expectedPreparationSha256,
      requestSha256,
      creationReceiptSha256: preparation.creationReceiptSha256,
      inputCount: 8,
      outputArtifactPathSha256: preparation.outputArtifactPathSha256,
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
  } catch {
    fail();
  }
}

export function communitiesStagingRoleSplitInventoryPreparationVerificationText(
  input: CommunitiesStagingRoleSplitInventoryPreparationVerification,
): string {
  return `${communitiesRoleSplitCanonicalJson(input)}\n`;
}
