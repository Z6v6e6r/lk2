export const ROOT: string;
export const RUNTIME: string;
export const ADOPTION_REQUEST_PATH: string;
export const ADOPTED_MANUAL_FULL_KIND: string;
export const ADOPTION_SOURCE: string;
export const ADOPTION_REQUEST: string;
export const ADOPTION_RECEIPT: string;
export const PRE_ADOPTION_DESCRIPTOR: string;
export const OPERATION_SCHEMA: string;
export const RECEIPT_SCHEMA: string;
export const INSTALLED_SCHEMA: string;
export const MANUAL_BASELINE_KIND: string;
export const SECRET_SET_SCHEMA: string;
export const ROLLOUT_ABSENT_KIND: string;
export const ROLLOUT_ABSENT_NOTE: string;
export const PUBLISHER: string;
export const MAIN_CHECKS: string;
export const TARGET: Readonly<{ hostname: string; serverId: number; projectId: number }>;
export const SECRET_NAMES: readonly string[];
export const CONTAINER_SERVICES: readonly string[];
export const IMAGE_SERVICES: readonly string[];
export const DESCRIPTOR_KEYS: readonly string[];
export const DECLARED_UNVERIFIED_INPUTS: readonly string[];

export interface AdoptionContainerObservation {
  id: string;
  image: string;
  releaseId: string | null;
  revision: string;
  imageId: string;
}

export interface AdoptionContainerInspection extends AdoptionContainerObservation {
  healthy: boolean;
  restarts: number;
}

export interface AdoptionGithubEvidence {
  publicationRun: Record<string, unknown>;
  publicationArtifacts: Record<string, unknown>;
  sourceCiRun: Record<string, unknown>;
}

export interface AdoptionArtifactsInputs {
  requestBytes: Buffer;
  previousDescriptorBytes: Buffer;
  secretFiles: Record<string, Buffer>;
  containers: Record<string, AdoptionContainerObservation>;
  github: AdoptionGithubEvidence;
  controller: { sha: string; tree: string };
  adoptedAt: string;
  root?: string;
}

export interface RunAdoptionOptions {
  root?: string;
  runtime?: string;
  now?: () => Date;
  getuid?: () => number | undefined;
  readFile?: (path: string) => Buffer | undefined;
  writeFileAtomic?: (path: string, bytes: Buffer, exclusive?: boolean) => void;
  dockerInspect?: (service: string) => AdoptionContainerInspection;
  readControllerSource?: () => { sha: string; tree: string; dirty: boolean };
  fetchJson?: (path: string) => Promise<Record<string, unknown>>;
}

export function releaseDirectory(releaseId: string): string;
export function canonicalArtifactName(sha: string, publicationRunId: string): string;
export function validateAdoptionOperation(
  value: unknown,
  now?: Date,
  requireUnexpired?: boolean,
): Record<string, unknown>;
export function validateAdoptionReceipt(value: unknown): Record<string, unknown>;
export function buildAdoptionArtifacts(
  operation: unknown,
  inputs: AdoptionArtifactsInputs,
): { descriptorBytes: Buffer; receiptBytes: Buffer };
export function validateAdoptedBaseline(
  values: Record<string, string>,
  bytes: Buffer,
  directory: string,
  releaseId: string,
  options?: { readFile?: (path: string) => Buffer | undefined },
): Record<string, unknown>;
export function runAdoptManualBaseline(
  requestPath: string,
  options?: RunAdoptionOptions,
): Promise<Record<string, unknown>>;
