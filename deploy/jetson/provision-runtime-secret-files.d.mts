export const REALTIME_KEYS: readonly string[];

export interface RuntimeSecretAttestation {
  readonly runtimeSnapshot: string;
  readonly activeComposeSha256: string;
  readonly candidateComposeSha256: string;
  readonly activeRelease: string;
  readonly releaseEnvSha256: string;
  readonly infrastructureIdentity: string;
  readonly infrastructureComposeSha256: string;
  readonly oldApiImageId: string;
  readonly oldApiImageRef: string;
  readonly oldWorkerImageId: string;
  readonly oldWorkerImageRef: string;
  readonly oldRealtimeImageId: string;
  readonly oldRealtimeImageRef: string;
  readonly oldWebId: string;
  readonly oldNginxId: string;
}

interface ExpectedPathMetadata {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface RuntimeSecretPrepareOptions {
  readonly directory: ExpectedPathMetadata;
  readonly staging: ExpectedPathMetadata;
  readonly deployUid: number;
  readonly deployGid: number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly failAfter?: string | undefined;
  readonly attestation: RuntimeSecretAttestation;
}

export function prepare(
  directory: string,
  options: RuntimeSecretPrepareOptions,
): { status: 'prepared' };
export function buildRuntimeSecretComposeCandidate(
  activeSource: string,
  reviewedSource: string,
): string;
export function buildRuntimeSecretComposeCandidateFile(
  activePath: string,
  reviewedPath: string,
  outputPath: string,
  uid: number,
  gid: number,
): { status: 'compose-generated' };
export function verifyPrepared(directory: string): { status: string };
export function recoverMarker(directory: string): { status: 'marker-current' | 'marker-recovered' };
export function advancePhase(
  directory: string,
  expected: string,
  next: string,
  options?: { readonly failAfter?: string },
): { status: string };
export function restoreFiles(
  directory: string,
  options?: { readonly failAfter?: string },
): { status: 'files-restored' | 'runtime-restored' };
export function completeRollback(directory: string): { status: 'rolled-back' };
export function finalize(
  directory: string,
  finalSnapshot: string,
  options?: { readonly failAfter?: string },
): { status: 'finalized' };
export function readField(directory: string, field: string): string;

interface BootstrapImageAttestation {
  readonly id: string;
  readonly ref: string;
}

interface BootstrapContainerAttestation {
  readonly id: string;
  readonly startedAt: string;
}

export interface RuntimeSecretBootstrapAttestation {
  readonly expectedActiveRelease: string;
  readonly candidateRelease: string;
  readonly controlCommit: string;
  readonly controlTree: string;
  readonly candidateTree: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: string;
  readonly backupPath: string;
  readonly bundlePath: string;
  readonly infrastructureIdentity: string;
  readonly hashes: {
    readonly runtimeSnapshot: string;
    readonly activeCompose: string;
    readonly candidateCompose: string;
    readonly activeReleaseEnv: string;
    readonly candidateReleaseEnv: string;
    readonly infrastructureCompose: string;
    readonly activeMigrationManifest: string;
    candidateMigrationManifest: string;
    readonly applicationBackup: string;
  };
  readonly oldImages: Record<string, BootstrapImageAttestation>;
  readonly candidateImages: Record<string, BootstrapImageAttestation>;
  readonly oldContainers: Record<string, BootstrapContainerAttestation>;
  readonly infrastructureContainers: {
    readonly nginxId: string;
    readonly caddyId: string;
  };
}

export interface RuntimeSecretBootstrapPrepareOptions {
  readonly directory: ExpectedPathMetadata;
  readonly staging: ExpectedPathMetadata;
  readonly deployUid: number;
  readonly deployGid: number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly failAfter?: string | undefined;
  readonly attestation: RuntimeSecretBootstrapAttestation;
}

export function prepareBootstrap(
  directory: string,
  options: RuntimeSecretBootstrapPrepareOptions,
): { status: 'files-prepared' };
export function verifyBootstrapPrepared(directory: string): { status: string };
export function advanceBootstrapPhase(
  directory: string,
  expected: string,
  next: string,
  options?: { readonly failAfter?: string },
): { status: string };
export function restoreBootstrapFiles(
  directory: string,
  options?: { readonly failAfter?: string },
): { status: 'files-restored' | 'runtime-restored' };
export function completeBootstrapRollback(directory: string): { status: 'rolled-back' };
export function finalizeBootstrap(
  directory: string,
  finalSnapshot: string,
  options?: { readonly failAfter?: string },
): { status: 'finalized' | 'already-finalized' };
export function verifyBootstrapFinalized(directory: string): { status: 'finalized' };
export function readBootstrapField(directory: string, field: string): string;
export function readBootstrapFinalizedField(directory: string, field: string): string;
