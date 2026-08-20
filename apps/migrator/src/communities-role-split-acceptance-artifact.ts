import { createHash } from 'node:crypto';

import {
  assertCommunitiesRoleSplitAcceptancePass,
  communitiesRoleSplitCanonicalJson,
  communitiesRoleSplitInputCArtifactText,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitExpectedPins,
} from '@phub/database';

import { verifyCommunitiesStagingRoleSplitInventoryArtifact } from './communities-staging-role-split-inventory-artifact.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PINS_KEYS = [
  'schemaVersion',
  'acceptanceEnvelopeSha256',
  'beforeArtifactSha256',
  'afterArtifactSha256',
  'beforeManifestSha256',
  'afterManifestSha256',
  'expectedMappingDigest',
  'markerDigest',
  'markerEvidenceDigest',
  'requestDigest',
  'creationReceiptSha256',
  'objectManifestDigest',
  'ledgerDigest',
] as const;

export const COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_PINS_VERSION =
  'communities-role-split-acceptance-artifact-pins-v1';

export type CommunitiesRoleSplitAcceptanceArtifactPins = CommunitiesRoleSplitExpectedPins & {
  readonly schemaVersion: typeof COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_PINS_VERSION;
  readonly acceptanceEnvelopeSha256: string;
};

export type CommunitiesRoleSplitAcceptanceArtifactVerification = {
  readonly schemaVersion: 'communities-role-split-acceptance-artifact-verification-v1';
  readonly status: 'ACCEPTANCE_PASS_REVIEW_ONLY';
  readonly pinsArtifactSha256: string;
  readonly acceptanceEnvelopeSha256: string;
  readonly beforeArtifactSha256: string;
  readonly afterArtifactSha256: string;
  readonly beforeManifestSha256: string;
  readonly afterManifestSha256: string;
  readonly mappingDigest: string;
  readonly comparison: {
    readonly changedCount: number;
    readonly addedCount: number;
    readonly removedCount: number;
    readonly forbiddenTransitionCount: 0;
  };
  readonly bindings: {
    readonly callerSuppliedPinsArtifactMatched: true;
    readonly canonicalAcceptanceEnvelope: true;
    readonly canonicalBeforeArtifact: true;
    readonly canonicalAfterArtifact: true;
    readonly embeddedSnapshotsMatchedExternalArtifacts: true;
    readonly authoritativeAcceptanceEvaluatorPassed: true;
  };
  readonly limitations: {
    readonly independentPinCustodyNotAttested: true;
    readonly independentlySourcedCleanCloneNotAttested: true;
    readonly dbaRoleMatrixReviewNotAttested: true;
    readonly v3ExecutableCompositionNotPresent: true;
  };
  readonly authorizes: {
    readonly trustedInventoryDesignation: false;
    readonly executionCandidateBuild: false;
    readonly forcedCommandKey: false;
    readonly ceremony: false;
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
  throw new Error('COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_INVALID');
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function decodeCanonicalJson(bytes: Buffer): { readonly text: string; readonly value: unknown } {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail();
  }
  if (`${communitiesRoleSplitCanonicalJson(value)}\n` !== text) fail();
  return { text, value };
}

export function parseCommunitiesRoleSplitAcceptanceArtifactPins(
  pinsBytes: Buffer,
  independentlyPinnedPinsSha256: string,
): CommunitiesRoleSplitAcceptanceArtifactPins {
  if (!SHA256_PATTERN.test(independentlyPinnedPinsSha256)) fail();
  const { value } = decodeCanonicalJson(pinsBytes);
  if (!isRecord(value)) fail();
  if (
    sha256(pinsBytes) !== independentlyPinnedPinsSha256 ||
    !hasExactKeys(value, PINS_KEYS) ||
    value.schemaVersion !== COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_PINS_VERSION ||
    PINS_KEYS.slice(1).some((key) => !SHA256_PATTERN.test(String(value[key])))
  )
    fail();
  return value as CommunitiesRoleSplitAcceptanceArtifactPins;
}

export function communitiesRoleSplitAcceptanceArtifactPinsText(
  pins: CommunitiesRoleSplitAcceptanceArtifactPins,
): string {
  if (
    !hasExactKeys(pins, PINS_KEYS) ||
    pins.schemaVersion !== COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_PINS_VERSION ||
    PINS_KEYS.slice(1).some((key) => !SHA256_PATTERN.test(String(pins[key])))
  )
    fail();
  return `${communitiesRoleSplitCanonicalJson(pins)}\n`;
}

export function verifyCommunitiesRoleSplitAcceptanceArtifact(input: {
  readonly acceptanceEnvelopeBytes: Buffer;
  readonly beforeArtifactBytes: Buffer;
  readonly afterArtifactBytes: Buffer;
  readonly pinsBytes: Buffer;
  readonly independentlyPinnedPinsSha256: string;
}): CommunitiesRoleSplitAcceptanceArtifactVerification {
  try {
    const pins = parseCommunitiesRoleSplitAcceptanceArtifactPins(
      input.pinsBytes,
      input.independentlyPinnedPinsSha256,
    );
    const beforeVerification = verifyCommunitiesStagingRoleSplitInventoryArtifact(
      input.beforeArtifactBytes,
      pins.beforeArtifactSha256,
    );
    const afterVerification = verifyCommunitiesStagingRoleSplitInventoryArtifact(
      input.afterArtifactBytes,
      pins.afterArtifactSha256,
    );
    const beforeText = input.beforeArtifactBytes.toString('utf8');
    const afterText = input.afterArtifactBytes.toString('utf8');
    const { text: envelopeText, value: envelopeValue } = decodeCanonicalJson(
      input.acceptanceEnvelopeBytes,
    );
    const envelope = envelopeValue as CommunitiesRoleSplitAcceptanceEnvelope;
    if (
      sha256(input.acceptanceEnvelopeBytes) !== pins.acceptanceEnvelopeSha256 ||
      communitiesRoleSplitInputCArtifactText(envelope.observedBefore) !== beforeText ||
      communitiesRoleSplitInputCArtifactText(envelope.observedAfter) !== afterText
    )
      fail();
    const expectedPins: CommunitiesRoleSplitExpectedPins = {
      beforeArtifactSha256: pins.beforeArtifactSha256,
      afterArtifactSha256: pins.afterArtifactSha256,
      beforeManifestSha256: pins.beforeManifestSha256,
      afterManifestSha256: pins.afterManifestSha256,
      expectedMappingDigest: pins.expectedMappingDigest,
      markerDigest: pins.markerDigest,
      markerEvidenceDigest: pins.markerEvidenceDigest,
      requestDigest: pins.requestDigest,
      creationReceiptSha256: pins.creationReceiptSha256,
      objectManifestDigest: pins.objectManifestDigest,
      ledgerDigest: pins.ledgerDigest,
    };
    const comparison = assertCommunitiesRoleSplitAcceptancePass(envelope, expectedPins);
    if (
      beforeVerification.manifestSha256 !== pins.beforeManifestSha256 ||
      afterVerification.manifestSha256 !== pins.afterManifestSha256 ||
      envelopeText !== `${communitiesRoleSplitCanonicalJson(envelope)}\n`
    )
      fail();
    return {
      schemaVersion: 'communities-role-split-acceptance-artifact-verification-v1',
      status: 'ACCEPTANCE_PASS_REVIEW_ONLY',
      pinsArtifactSha256: input.independentlyPinnedPinsSha256,
      acceptanceEnvelopeSha256: pins.acceptanceEnvelopeSha256,
      beforeArtifactSha256: pins.beforeArtifactSha256,
      afterArtifactSha256: pins.afterArtifactSha256,
      beforeManifestSha256: pins.beforeManifestSha256,
      afterManifestSha256: pins.afterManifestSha256,
      mappingDigest: pins.expectedMappingDigest,
      comparison: {
        changedCount: comparison.changedCount,
        addedCount: comparison.addedCount,
        removedCount: comparison.removedCount,
        forbiddenTransitionCount: 0,
      },
      bindings: {
        callerSuppliedPinsArtifactMatched: true,
        canonicalAcceptanceEnvelope: true,
        canonicalBeforeArtifact: true,
        canonicalAfterArtifact: true,
        embeddedSnapshotsMatchedExternalArtifacts: true,
        authoritativeAcceptanceEvaluatorPassed: true,
      },
      limitations: {
        independentPinCustodyNotAttested: true,
        independentlySourcedCleanCloneNotAttested: true,
        dbaRoleMatrixReviewNotAttested: true,
        v3ExecutableCompositionNotPresent: true,
      },
      authorizes: {
        trustedInventoryDesignation: false,
        executionCandidateBuild: false,
        forcedCommandKey: false,
        ceremony: false,
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

export function communitiesRoleSplitAcceptanceArtifactVerificationText(
  verification: CommunitiesRoleSplitAcceptanceArtifactVerification,
): string {
  return `${communitiesRoleSplitCanonicalJson(verification)}\n`;
}
