import type { TimewebFrozenSourceAuthority } from './verify-timeweb-frozen-source.js';

export class TimewebReleaseEnvironmentError extends Error {
  readonly reason: string;
}

export type TimewebCanonicalManifest = {
  schemaVersion: string;
  gitCommit: string;
  gitTree: string;
  publication: {
    workflow: string;
    workflowSha: string;
    runId: string;
    runAttempt: string;
  };
  images: Array<{
    component: string;
    digest: string;
    runtimeDigest: string;
    publication: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type TimewebCanonicalRunEvidence = {
  schema: string;
  repository: string;
  workflowPath: string;
  workflowSha: string;
  sourceSha: string;
  sourceTree: string;
  runId: string;
  runAttempt: string;
  status: string;
  conclusion: string;
  event: string;
  authenticatedSource: string;
  observedAt: string;
  canonicalArtifact: {
    id: string;
    name: string;
    digest: string;
    expired: boolean;
    files: string[];
  };
  registryInventory: {
    complete: boolean;
    presentImages: number;
    expectedImages: number;
  };
  releaseManifestSha256: string;
};

export type TimewebVerifiedCanonicalRunEvidence = TimewebCanonicalRunEvidence & {
  readonly __verifiedCanonicalGitHubRunAuthority: unique symbol;
};

export type TimewebVerifiedRenderedEnvironment = {
  readonly releaseId: string;
  readonly contents: string;
  readonly __verifiedRenderedEnvironment: unique symbol;
};

export function readCanonicalTimewebReleasePair(
  manifestPath: string,
  expectedChecksum: string,
): { manifest: unknown; checksum: string; manifestBytes: Buffer; checksumBytes: Buffer };

export function readCanonicalTimewebRunEvidence(
  evidencePath: string,
  expectedChecksum: string,
): { evidence: TimewebCanonicalRunEvidence; checksum: string };

export function verifyCanonicalGitHubRunAuthority(options: {
  manifest: TimewebCanonicalManifest;
  manifestBytes: Buffer;
  checksumBytes: Buffer;
  manifestChecksum: string;
  expectedSourceSha: string;
  expectedSourceTree: string;
  expectedWorkflowSha: string;
  expectedRunId: string;
  expectedRunAttempt: string;
  githubTokenFile: string;
  expectedUid?: number;
}): Promise<{ evidence: TimewebVerifiedCanonicalRunEvidence; checksum: string }>;

export function validateTimewebRuntimeSecretPaths(
  runtimeEnvRoot: string,
  releaseId: string,
  expectedUid?: number,
): void;

export function assertNoAmbientComposeOverrides(environment?: NodeJS.ProcessEnv): void;
export function assertNoAmbientDockerOverrides(environment?: NodeJS.ProcessEnv): void;

export type TimewebInitialBetaComposeStage =
  'preflight' | 'pull-api' | 'up-api' | 'pull-web' | 'up-web' | 'pull-realtime' | 'up-realtime';

export function buildTimewebInitialBetaComposeInvocation(
  stage: TimewebInitialBetaComposeStage,
  releaseEnvPath: string,
): { command: '/usr/bin/docker'; args: string[] };

export function runTimewebInitialBetaComposeStage(
  stage: TimewebInitialBetaComposeStage,
  releaseEnvPath: string,
  rendered: TimewebVerifiedRenderedEnvironment,
  expectedUid?: number,
): { stage: TimewebInitialBetaComposeStage; services: string[]; mutated: boolean };

export function renderTimewebBetaReleaseEnvironment(
  manifest: unknown,
  options: {
    expectedSourceSha: string;
    expectedSourceTree: string;
    expectedWorkflowSha: string;
    expectedRunId: string;
    expectedRunAttempt: string;
    canonicalManifestChecksum: string;
    runEvidence: TimewebVerifiedCanonicalRunEvidence;
    runEvidenceChecksum: string;
    runtimeEnvRoot: string;
    sourceAuthority: TimewebFrozenSourceAuthority;
    previousReleaseId?: string;
    baseLockPath?: string | URL;
  },
): TimewebVerifiedRenderedEnvironment;

export function writeTimewebBetaReleaseEnvironment(options: {
  manifest: unknown;
  expectedSourceSha: string;
  expectedSourceTree: string;
  expectedWorkflowSha: string;
  expectedRunId: string;
  expectedRunAttempt: string;
  canonicalManifestChecksum: string;
  runEvidence: TimewebVerifiedCanonicalRunEvidence;
  runEvidenceChecksum: string;
  sourceAuthority: TimewebFrozenSourceAuthority;
  runtimeEnvRoot?: string;
  previousReleaseId?: string;
  releaseRoot?: string;
  releaseDir: string;
  expectedUid?: number;
  expectedGid?: number;
  baseLockPath?: string | URL;
  ambientEnvironment?: NodeJS.ProcessEnv;
  failAfter?: 'rename';
}): { releaseId: string; output: string; mode: '0600' };
