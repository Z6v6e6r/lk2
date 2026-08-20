export interface CommunitiesRoleSplitDisabledCandidateInstallationInput {
  readonly candidatePath: string;
  readonly candidateSha: string;
  readonly expectedManifestSha256: string;
  readonly expectedArtifactSetSha256: string;
  readonly installationRoot: string;
  readonly expectedUid?: number;
}

export interface CommunitiesRoleSplitDisabledCandidateInstallationResult {
  readonly targetPath: string;
  readonly receiptSha256: string;
}

export function installCommunitiesRoleSplitDisabledCandidate(
  input: CommunitiesRoleSplitDisabledCandidateInstallationInput,
): CommunitiesRoleSplitDisabledCandidateInstallationResult;

export function verifyCommunitiesRoleSplitDisabledInstallation(
  input: CommunitiesRoleSplitDisabledCandidateInstallationInput,
): CommunitiesRoleSplitDisabledCandidateInstallationResult;
