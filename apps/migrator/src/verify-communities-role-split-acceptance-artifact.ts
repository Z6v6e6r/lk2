import {
  communitiesRoleSplitAcceptanceArtifactVerificationText,
  verifyCommunitiesRoleSplitAcceptanceArtifact,
} from './communities-role-split-acceptance-artifact.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const MAXIMUM_INPUT_C_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ACCEPTANCE_ENVELOPE_BYTES = 40 * 1024 * 1024;
const MAXIMUM_PINS_BYTES = 64 * 1024;

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length !== 10 ||
    arguments_[0] !== '--envelope' ||
    arguments_[2] !== '--before' ||
    arguments_[4] !== '--after' ||
    arguments_[6] !== '--pins' ||
    arguments_[8] !== '--pins-sha256' ||
    arguments_.some((value, index) => index % 2 === 1 && !value) ||
    new Set([arguments_[1], arguments_[3], arguments_[5], arguments_[7]]).size !== 4
  )
    throw new Error('INPUT_INVALID');
  const [acceptanceEnvelopeBytes, beforeArtifactBytes, afterArtifactBytes, pinsBytes] =
    await Promise.all([
      readRootOwnedEvidence(arguments_[1]!, MAXIMUM_ACCEPTANCE_ENVELOPE_BYTES),
      readRootOwnedEvidence(arguments_[3]!, MAXIMUM_INPUT_C_BYTES),
      readRootOwnedEvidence(arguments_[5]!, MAXIMUM_INPUT_C_BYTES),
      readRootOwnedEvidence(arguments_[7]!, MAXIMUM_PINS_BYTES),
    ]);
  process.stdout.write(
    communitiesRoleSplitAcceptanceArtifactVerificationText(
      verifyCommunitiesRoleSplitAcceptanceArtifact({
        acceptanceEnvelopeBytes,
        beforeArtifactBytes,
        afterArtifactBytes,
        pinsBytes,
        independentlyPinnedPinsSha256: arguments_[9]!,
      }),
    ),
  );
}

try {
  await main();
} catch {
  process.stderr.write('COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_INVALID\n');
  process.exitCode = 1;
}
