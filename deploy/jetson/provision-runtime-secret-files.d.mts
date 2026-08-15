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
