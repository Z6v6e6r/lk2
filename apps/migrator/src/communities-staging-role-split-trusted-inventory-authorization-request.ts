import { createHash } from 'node:crypto';

import { communitiesRoleSplitCanonicalJson } from '@phub/database';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization-request.js';
import {
  communitiesStagingRoleSplitTrustedInventoryGateVerificationText,
  verifyCommunitiesStagingRoleSplitTrustedInventoryGate,
  type CommunitiesStagingRoleSplitTrustedInventoryGateVerification,
} from './communities-staging-role-split-trusted-inventory-gate.js';

const SHA256 = /^[a-f0-9]{64}$/u;
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
const verificationKeys = [
  'schemaVersion',
  'status',
  'requestSha256',
  'requestIdSha256',
  'candidateCommitSha',
  'phase',
  'gateSha256',
  'gateVerificationSha256',
  'evidencePinCount',
  'bindings',
  'limitations',
  'requestedAuthorities',
  'authorizes',
] as const;
const bindingKeys = [
  'canonicalRequest',
  'v13GateReverified',
  'exactGateVerificationMatched',
  'candidateAndPhaseMatched',
  'evidenceSubjectsMatched',
  'evidencePathHashesSeparated',
  'oneShotPolicyRequested',
  'authorityRequestNarrowed',
] as const;
const limitationKeys = [
  'evidenceBytesNotLoaded',
  'evidencePathSemanticsNotAttested',
  'rootCustodyNotAttested',
  'organizationalIndependenceNotAttested',
  'independentApprovalNotGranted',
  'durableConsumptionLedgerNotImplemented',
  'failClosedClockNotEvaluated',
  'authorizationReceiptNotCreated',
  'authorizationRequestNotConsumed',
  'databaseNotConnected',
  'processNotStarted',
  'artifactNotCreated',
  'trustedInventoryDesignationNotGranted',
] as const;

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerification {
  readonly schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-request-verification-v1';
  readonly status: 'AUTHORIZATION_REQUEST_VERIFIED_REVIEW_ONLY';
  readonly requestSha256: string;
  readonly requestIdSha256: string;
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly gateVerificationSha256: string;
  readonly evidencePinCount: 10;
  readonly bindings: {
    readonly canonicalRequest: true;
    readonly v13GateReverified: true;
    readonly exactGateVerificationMatched: true;
    readonly candidateAndPhaseMatched: true;
    readonly evidenceSubjectsMatched: true;
    readonly evidencePathHashesSeparated: true;
    readonly oneShotPolicyRequested: true;
    readonly authorityRequestNarrowed: true;
  };
  readonly limitations: {
    readonly evidenceBytesNotLoaded: true;
    readonly evidencePathSemanticsNotAttested: true;
    readonly rootCustodyNotAttested: true;
    readonly organizationalIndependenceNotAttested: true;
    readonly independentApprovalNotGranted: true;
    readonly durableConsumptionLedgerNotImplemented: true;
    readonly failClosedClockNotEvaluated: true;
    readonly authorizationReceiptNotCreated: true;
    readonly authorizationRequestNotConsumed: true;
    readonly databaseNotConnected: true;
    readonly processNotStarted: true;
    readonly artifactNotCreated: true;
    readonly trustedInventoryDesignationNotGranted: true;
  };
  readonly requestedAuthorities: {
    readonly inventoryConnection: true;
    readonly inventoryRead: true;
    readonly artifactWrite: true;
    readonly trustedInventoryDesignation: false;
    readonly roleCreation: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
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
  throw new Error('COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID');
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

function subjectSha256(value: unknown): string {
  return sha256(`${communitiesRoleSplitCanonicalJson(value)}\n`);
}

function preparationInput(
  gateInput: Parameters<typeof verifyCommunitiesStagingRoleSplitTrustedInventoryGate>[0],
  code:
    | 'INDEPENDENT_SOURCE_PROVENANCE'
    | 'CONNECTION_DESCRIPTOR'
    | 'CREDENTIAL_CUSTODY'
    | 'EXECUTABLE_CUSTODY'
    | 'OUTPUT_CUSTODY',
) {
  const binding = gateInput.preparation.inputs.find((entry) => entry.code === code);
  if (!binding) fail();
  return binding;
}

function scopedEvidenceSubjectSha256(input: {
  readonly requestIdSha256: string;
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly code: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode;
  readonly subject: unknown;
}): string {
  return subjectSha256({
    schemaVersion:
      'communities-staging-role-split-trusted-inventory-authorization-evidence-subject-v1',
    requestIdSha256: input.requestIdSha256,
    candidateCommitSha: input.candidateCommitSha,
    phase: input.phase,
    gateSha256: input.gateSha256,
    code: input.code,
    subject: input.subject,
  });
}

function expectedEvidenceSubjects(input: {
  readonly requestIdSha256: string;
  readonly gateInput: Parameters<typeof verifyCommunitiesStagingRoleSplitTrustedInventoryGate>[0];
}): Readonly<Record<CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode, string>> {
  const gate = input.gateInput.gate;
  const independentSource = preparationInput(input.gateInput, 'INDEPENDENT_SOURCE_PROVENANCE');
  const connection = preparationInput(input.gateInput, 'CONNECTION_DESCRIPTOR');
  const credentialCustody = preparationInput(input.gateInput, 'CREDENTIAL_CUSTODY');
  const executableCustody = preparationInput(input.gateInput, 'EXECUTABLE_CUSTODY');
  const outputCustody = preparationInput(input.gateInput, 'OUTPUT_CUSTODY');
  const scoped = (
    code: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
    subject: unknown,
  ): string =>
    scopedEvidenceSubjectSha256({
      requestIdSha256: input.requestIdSha256,
      candidateCommitSha: gate.candidateCommitSha,
      phase: gate.phase,
      gateSha256: input.gateInput.expectedGateSha256,
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

export function verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(input: {
  readonly request: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
  readonly expectedRequestSha256: string;
  readonly gateInput: Parameters<typeof verifyCommunitiesStagingRoleSplitTrustedInventoryGate>[0];
  readonly gateVerification: CommunitiesStagingRoleSplitTrustedInventoryGateVerification;
}): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerification {
  try {
    if (!SHA256.test(input.expectedRequestSha256)) fail();
    const requestSha256 = communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(
      input.request,
    );
    if (requestSha256 !== input.expectedRequestSha256) fail();

    const gateVerification = verifyCommunitiesStagingRoleSplitTrustedInventoryGate(input.gateInput);
    const canonicalGateVerification =
      communitiesStagingRoleSplitTrustedInventoryGateVerificationText(gateVerification);
    if (
      canonicalGateVerification !==
      communitiesStagingRoleSplitTrustedInventoryGateVerificationText(input.gateVerification)
    )
      fail();
    const gateVerificationSha256 = sha256(canonicalGateVerification);
    const request = input.request;
    if (
      request.candidateCommitSha !== input.gateInput.gate.candidateCommitSha ||
      request.phase !== input.gateInput.gate.phase ||
      request.gateSha256 !== gateVerification.gateSha256 ||
      request.gateVerificationSha256 !== gateVerificationSha256
    )
      fail();

    const subjects = expectedEvidenceSubjects({
      requestIdSha256: request.requestIdSha256,
      gateInput: input.gateInput,
    });
    const protectedPathHashes = new Set([
      ...input.gateInput.preparation.inputs.map((entry) => entry.pathSha256),
      input.gateInput.gate.credentialDescriptorPathSha256,
      input.gateInput.gate.producerDescriptorPathSha256,
      input.gateInput.gate.outputDirectoryPathSha256,
      input.gateInput.gate.outputArtifactPathSha256,
      input.gateInput.gate.outputReceiptPathSha256,
      input.gateInput.gate.markerRequestPathSha256,
      input.gateInput.gate.markerEvidencePathSha256,
      input.gateInput.gate.roleMappingPathSha256,
    ]);
    for (const [
      index,
      code,
    ] of COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.entries()) {
      const pin = request.evidencePins[index];
      if (
        !pin ||
        pin.code !== code ||
        pin.subjectSha256 !== subjects[code] ||
        pin.evidenceSha256 === pin.subjectSha256 ||
        protectedPathHashes.has(pin.evidencePathSha256)
      )
        fail();
    }

    return {
      schemaVersion:
        'communities-staging-role-split-trusted-inventory-authorization-request-verification-v1',
      status: 'AUTHORIZATION_REQUEST_VERIFIED_REVIEW_ONLY',
      requestSha256,
      requestIdSha256: request.requestIdSha256,
      candidateCommitSha: request.candidateCommitSha,
      phase: request.phase,
      gateSha256: request.gateSha256,
      gateVerificationSha256,
      evidencePinCount: 10,
      bindings: {
        canonicalRequest: true,
        v13GateReverified: true,
        exactGateVerificationMatched: true,
        candidateAndPhaseMatched: true,
        evidenceSubjectsMatched: true,
        evidencePathHashesSeparated: true,
        oneShotPolicyRequested: true,
        authorityRequestNarrowed: true,
      },
      limitations: {
        evidenceBytesNotLoaded: true,
        evidencePathSemanticsNotAttested: true,
        rootCustodyNotAttested: true,
        organizationalIndependenceNotAttested: true,
        independentApprovalNotGranted: true,
        durableConsumptionLedgerNotImplemented: true,
        failClosedClockNotEvaluated: true,
        authorizationReceiptNotCreated: true,
        authorizationRequestNotConsumed: true,
        databaseNotConnected: true,
        processNotStarted: true,
        artifactNotCreated: true,
        trustedInventoryDesignationNotGranted: true,
      },
      requestedAuthorities: request.requestedAuthorities,
      authorizes: request.authorizes,
    };
  } catch {
    fail();
  }
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerification,
): string {
  if (
    !exactKeys(value, verificationKeys) ||
    value.schemaVersion !==
      'communities-staging-role-split-trusted-inventory-authorization-request-verification-v1' ||
    value.status !== 'AUTHORIZATION_REQUEST_VERIFIED_REVIEW_ONLY' ||
    !SHA256.test(value.requestSha256) ||
    !SHA256.test(value.requestIdSha256) ||
    !/^[a-f0-9]{40}$/u.test(value.candidateCommitSha) ||
    !(['BEFORE', 'AFTER'] as const).includes(value.phase) ||
    !SHA256.test(value.gateSha256) ||
    !SHA256.test(value.gateVerificationSha256) ||
    value.evidencePinCount !== 10 ||
    !exactKeys(value.bindings, bindingKeys) ||
    bindingKeys.some((key) => value.bindings[key] !== true) ||
    !exactKeys(value.limitations, limitationKeys) ||
    limitationKeys.some((key) => value.limitations[key] !== true) ||
    !exactKeys(value.requestedAuthorities, authorizationKeys) ||
    authorizationKeys.some(
      (key) =>
        value.requestedAuthorities[key] !==
        (key === 'inventoryConnection' || key === 'inventoryRead' || key === 'artifactWrite'),
    ) ||
    !exactKeys(value.authorizes, authorizationKeys) ||
    authorizationKeys.some((key) => value.authorizes[key] !== false)
  )
    fail();
  return `${communitiesRoleSplitCanonicalJson(value)}\n`;
}
