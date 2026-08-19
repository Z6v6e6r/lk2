import {
  communitiesStagingRoleSplitInventoryArtifactVerificationText,
  verifyCommunitiesStagingRoleSplitInventoryArtifact,
} from './communities-staging-role-split-inventory-artifact.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== '--artifact' ||
    arguments_[2] !== '--expected-sha256' ||
    !arguments_[1] ||
    !arguments_[3]
  )
    throw new Error('INPUT_INVALID');
  const artifactBytes = await readRootOwnedEvidence(arguments_[1], MAXIMUM_ARTIFACT_BYTES);
  process.stdout.write(
    communitiesStagingRoleSplitInventoryArtifactVerificationText(
      verifyCommunitiesStagingRoleSplitInventoryArtifact(artifactBytes, arguments_[3]),
    ),
  );
}

try {
  await main();
} catch {
  process.stderr.write('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_INVALID\n');
  process.exitCode = 1;
}
