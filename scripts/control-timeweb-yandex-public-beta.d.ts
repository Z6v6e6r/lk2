import type { TimewebTargetContract } from './verify-timeweb-deployment-contract.js';

export class TimewebYandexPublicBetaControlError extends Error {
  readonly code: string;
}

export interface TimewebYandexRollbackFloor {
  readonly schema: string;
  readonly hostname: string;
  readonly canonicalPublication: false;
  readonly authorizesPublication: false;
  readonly failedPublicationRunProvenance: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly runtimeEnvRoot: string;
  readonly images: Record<
    string,
    { readonly indexDigest: string; readonly runtimeDigest?: string }
  >;
}

export interface TimewebYandexRollbackReceipt {
  readonly schema: string;
  readonly status: 'PREPARED';
  readonly hostname: string;
  readonly floorSourceSha: string;
  readonly floorSourceTree: string;
  readonly candidateSourceSha: string;
  readonly candidateSourceTree: string;
  readonly candidateReleaseId: string;
  readonly candidateRuntimeEnvRoot: string;
  readonly candidateReleaseEnv: string;
  readonly candidateReleaseEnvSha256: string;
  readonly priorApiReference: string;
  readonly priorWebReference: string;
  readonly candidateApiReference: string;
  readonly candidateWebReference: string;
  readonly activeCaddyfile: string;
  readonly activeCaddySha256: string;
  readonly activeCaddyAdaptedSha256: string;
  readonly backupCaddyfile: string;
  readonly backupCaddySha256: string;
  readonly publicCaddyfile: string;
  readonly publicCaddySha256: string;
  readonly publicCaddyAdaptedSha256: string;
  readonly applicationCompose: string;
  readonly ingressCompose: string;
  readonly rollbackEnv: string;
  readonly preparedAt: string;
  readonly complete: true;
}

export function validateRollbackFloor(
  input: unknown,
  target: TimewebTargetContract,
): TimewebYandexRollbackFloor;
export function validateOperationInput(input: unknown): Record<string, string>;
export function validateCandidateReleaseEnvironment(
  bytes: Buffer,
  operation: {
    readonly candidateSourceSha: string;
    readonly candidateSourceTree: string;
    readonly candidateReleaseId: string;
    readonly candidateRuntimeEnvRoot: string;
  },
): Record<string, string>;
export function validateReceipt(input: unknown): TimewebYandexRollbackReceipt;
export function buildRollbackSteps(receipt: unknown): readonly string[];
export function buildProspectiveCaddyInvocation(command: 'validate' | 'adapt'): {
  readonly command: string;
  readonly args: readonly string[];
};
export function buildProspectiveCaddyExecution(
  source: string,
  command: 'validate' | 'adapt',
): { readonly command: string; readonly args: readonly string[]; readonly input: Buffer };
export function buildCaddyRecreateInvocation(receipt: { readonly ingressCompose: string }): {
  readonly command: string;
  readonly args: readonly string[];
};
export function buildIngressSmokeInvocations(
  mode: 'public' | 'basic',
): readonly (readonly string[])[];
export function validateCandidateContainerAttestation(
  actual: { readonly image: string; readonly health: string; readonly releaseId: string },
  expected: { readonly image: string; readonly releaseId: string },
): { readonly image: string; readonly health: string; readonly releaseId: string };
export function executeCaddyTransition(
  source: string,
  destination: string,
  expectedSourceSha256: string,
  expectedAdaptedSha256: string,
  operations: {
    readonly hash: (path: string) => string;
    readonly validate: (path: string, expectedAdaptedSha256: string) => void;
    readonly install: (source: string, destination: string) => void;
    readonly recreate: (expectedAdaptedSha256: string) => void;
  },
): void;
export function prepare(input: unknown): { status: string; receipt: string };
export function activateIngress(receiptPath: string): { status: string; receipt: string };
export function rollback(receiptPath: string): { status: string; receipt: string };
