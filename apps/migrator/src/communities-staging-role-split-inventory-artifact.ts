import {
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  assertCommunitiesRoleSplitInputC,
  communitiesRoleSplitCanonicalJson,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCArtifactText,
  type CommunitiesRoleSplitInputC,
} from '@phub/database';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type CommunitiesStagingRoleSplitInventoryArtifactVerification = {
  readonly schemaVersion: 'communities-role-split-inventory-artifact-verification-v1';
  readonly artifactSha256: string;
  readonly manifestSha256: string;
  readonly normalizedRecordCounts: Readonly<Record<string, number>>;
  readonly anomalyObservationCount: number;
  readonly binding: {
    readonly callerSuppliedArtifactPinMatched: true;
    readonly canonicalArtifactBytes: true;
  };
  readonly limitations: {
    readonly independentCustodyNotAttested: true;
    readonly cleanCloneProvenanceNotAttested: true;
  };
  readonly authorizes: {
    readonly roleCreation: false;
    readonly roleRepair: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly schemaMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
};

function fail(): never {
  throw new Error('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_INVALID');
}

export function verifyCommunitiesStagingRoleSplitInventoryArtifact(
  artifactBytes: Buffer,
  independentlyPinnedArtifactSha256: string,
): CommunitiesStagingRoleSplitInventoryArtifactVerification {
  if (
    !Buffer.isBuffer(artifactBytes) ||
    artifactBytes.length < 1 ||
    !SHA256_PATTERN.test(independentlyPinnedArtifactSha256)
  )
    fail();

  const artifactText = artifactBytes.toString('utf8');
  if (!Buffer.from(artifactText, 'utf8').equals(artifactBytes)) fail();

  let artifact: unknown;
  try {
    artifact = JSON.parse(artifactText);
    assertCommunitiesRoleSplitInputC(artifact);
  } catch {
    fail();
  }
  const input: CommunitiesRoleSplitInputC = artifact;
  if (
    communitiesRoleSplitInputCArtifactText(input) !== artifactText ||
    communitiesRoleSplitInputCArtifactSha256(input) !== independentlyPinnedArtifactSha256
  )
    fail();

  const normalizedRecordCounts = Object.fromEntries(
    COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES.map((category) => [
      category,
      input.normalized[category].length,
    ]),
  );
  return {
    schemaVersion: 'communities-role-split-inventory-artifact-verification-v1',
    artifactSha256: independentlyPinnedArtifactSha256,
    manifestSha256: input.manifestSha256,
    normalizedRecordCounts,
    anomalyObservationCount: input.anomalies.reduce((total, anomaly) => total + anomaly.count, 0),
    binding: { callerSuppliedArtifactPinMatched: true, canonicalArtifactBytes: true },
    limitations: {
      independentCustodyNotAttested: true,
      cleanCloneProvenanceNotAttested: true,
    },
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
  };
}

export function communitiesStagingRoleSplitInventoryArtifactVerificationText(
  verification: CommunitiesStagingRoleSplitInventoryArtifactVerification,
): string {
  return `${communitiesRoleSplitCanonicalJson(verification)}\n`;
}
